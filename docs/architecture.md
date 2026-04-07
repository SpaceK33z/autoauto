# Architecture

## Overview

Bun + TypeScript TUI app using OpenTUI React for rendering and Claude Agent SDK for AI interactions. App controls flow, agents provide intelligence.

## Entry Point

`src/index.tsx` — creates an OpenTUI CLI renderer and mounts the React root with `<App />`.

## Screen Navigation

`App.tsx` manages a `Screen` state (`"home" | "setup" | "settings"`) and renders the active screen. On mount, runs an auth check via SDK `accountInfo()` — shows a loading state, then the normal UI or an auth error screen. Global keyboard handling (Escape to quit from home).

### Screens

- **HomeScreen** — lists existing programs from `.autoauto/programs/`, supports j/k navigation, `n` to create new, `s` for settings
- **SetupScreen** — wraps the `Chat` component with configured support model, Escape to go back
- **SettingsScreen** — model configuration for execution and support slots, keyboard-driven value cycling
- **AuthErrorScreen** — displayed when authentication fails, shows setup instructions

## Components

- **Chat** (`src/components/Chat.tsx`) — Multi-turn conversational interface. Maintains a long-lived `query()` session using a push-based `AsyncIterable<SDKUserMessage>` prompt. Renders full message history (user + assistant) in an auto-scrolling scrollbox. Streams assistant responses token-by-token via `includePartialMessages`.

## Utilities

- **PushStream** (`src/lib/push-stream.ts`) — Generic push-based async iterable. Bridges imperative push (React event handlers) with pull-based async iteration (SDK query loop). Used by Chat to feed user messages into the agent session.

## Data Layer

`src/lib/programs.ts` — filesystem operations and types for `.autoauto/` in the git repo root:

- `getProjectRoot()` — resolves through git worktrees to find the main repo root (cached)
- `listPrograms()` — reads program directories from `.autoauto/programs/`
- `ensureAutoAutoDir()` — creates `.autoauto/` and adds it to `.gitignore`
- `getProgramsDir()` — returns absolute path to `.autoauto/programs/`
- `getProgramDir()` — returns absolute path to a specific program's directory
- `ProgramConfig` — TypeScript interface for `config.json` schema
- `QualityGate` — TypeScript interface for quality gate entries

## File Structure

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Screen routing, global keys, auth check
  components/
    Chat.tsx             # Claude Agent SDK streaming chat
  screens/
    HomeScreen.tsx       # Program list
    SetupScreen.tsx      # Setup flow (chat wrapper + agent config)
    SettingsScreen.tsx   # Model configuration (execution + support slots)
    AuthErrorScreen.tsx  # Auth error display with setup instructions
  lib/
    auth.ts              # Authentication checking via SDK
    config.ts            # Project config CRUD (.autoauto/config.json)
    git.ts               # Git operations (branch, revert, log, SHA)
    measure.ts           # Measurement execution, validation, comparison
    programs.ts          # Filesystem ops, program CRUD, config types
    push-stream.ts       # Push-based async iterable utility
    run.ts               # Run lifecycle (branch, baseline, state, locking)
    system-prompts.ts    # Agent system prompts (setup, ideation)
    tool-events.ts       # Tool event display formatting
    validate-measurement.ts  # Standalone measurement validation script
    events.ts              # Event logging (events.ndjson) for run audit trail
    experiment.ts          # Experiment agent spawning, context packets, lock detection
    experiment-loop.ts     # Main experiment loop orchestrator
```

## Configuration

`src/lib/config.ts` — project-level configuration at `.autoauto/config.json`:

- `ModelSlot` — model alias + effort level
- `ProjectConfig` — two slots: `executionModel` and `supportModel`
- `loadProjectConfig()` — reads config, merges with defaults for forward compatibility
- `saveProjectConfig()` — writes config as formatted JSON

Default: Sonnet + high effort for both slots.

## Authentication

`src/lib/auth.ts` — checks auth on startup:

- Uses SDK `accountInfo()` to verify authentication works
- Supports all SDK auth methods (API key, OAuth, cloud providers)
- Returns account info on success, error message on failure
- App shows `AuthErrorScreen` on failure with remediation instructions

## Agent Architecture

AutoAuto uses the Claude Agent SDK's `query()` function with built-in tools. The host
application (AutoAuto TUI) manages the conversation UI while the SDK handles the agent
loop, tool execution, and context management.

### Setup Agent (`src/lib/system-prompts.ts`)

- **Purpose:** Inspect repo, suggest targets, define scope, generate program artifacts
- **Tools:** Read, Write, Edit, Bash, Glob, Grep
- **Permission mode:** `bypassPermissions` (AutoAuto manages UI, not the SDK)
- **Working directory:** Target project root (resolved via `getProjectRoot()`)
- **System prompt:** Encodes autoresearch expertise — guides user through repo inspection,
  target identification, scope definition, measurement approach, artifact generation
- **maxTurns:** 40 (conversation turns, including review iterations and measurement validation)
- **Artifacts generated:**
  - `program.md` — Goal, scope, rules, steps for the experiment agent
  - `measure.sh` — Measurement script tailored to the repo (must output JSON to stdout)
  - `config.json` — Metric field, direction, noise threshold, repeats, quality gates
- **Review flow:** Agent presents artifacts as code blocks for review before writing to disk
- **Measurement validation:** After saving, the agent runs a standalone validation script
  (`src/lib/validate-measurement.ts`) that executes measure.sh 5 times, computes variance
  statistics (CV%), and recommends noise_threshold + repeats. If measurements are unstable,
  the agent helps fix the script and re-validates.

### Measurement Validation (`src/lib/validate-measurement.ts`)

Standalone Bun script that validates measurement script stability:

- **Input:** Paths to measure.sh + config.json, number of runs
- **Execution:** Runs measure.sh N times sequentially, parses JSON output, validates fields
- **Stats:** Computes median, mean, min, max, stdev, CV% for primary metric and quality gates
- **Assessment:** excellent (<5% CV), acceptable (5-15%), noisy (15-30%), unstable (≥30%)
- **Output:** Single JSON object to stdout with stats, assessment, and config recommendations
- **Called by:** Setup agent via Bash tool
- **Used for:** Pre-experiment validation during setup (Phase 1) — ensures measurement is stable before entering the optimization loop

## Run Lifecycle (`src/lib/run.ts`)

Manages the experiment run setup and state:

- `startRun()` — orchestrates branch creation → baseline measurement → state initialization → evaluator locking
- `RunState` — checkpoint persisted atomically to `state.json` via temp-file + rename
- `ExperimentResult` — typed row for the append-only `results.tsv`
- Branch naming: `autoauto-<slug>-<YYYYMMDD-HHMMSS>`
- Evaluator locking: `chmod 444` on `measure.sh` + `config.json` before loop starts

## Measurement (`src/lib/measure.ts`)

Handles measurement execution and decision logic:

- `runMeasurement()` — single measure.sh execution with JSON parsing and validation
- `runMeasurementSeries()` — N repeated measurements with median aggregation
- `compareMetric()` — relative change comparison against noise threshold
- `checkQualityGates()` — threshold enforcement on quality gate fields

## Git Operations (`src/lib/git.ts`)

Thin wrappers around git commands for the orchestrator:

- `createExperimentBranch()` is called from `run.ts`
- `resetHard()` uses `git reset --hard` to discard failed experiments (standard autoresearch ratchet pattern)

## Experiment Loop (`src/lib/experiment-loop.ts`)

The core orchestrator loop that drives the autoresearch pattern:

- `runExperimentLoop()` — main loop: context → agent → measure → decide → repeat
- `LoopCallbacks` — callback interface for TUI integration (phase change, streaming, results)
- `LoopOptions` — control knobs: max experiments, abort signal
- Calls `runMeasurementAndDecide()` for each iteration (includes measurement + keep/discard)
- Re-baselines after every keep (fresh measurement on kept code, falls back to candidate measurement on failure)
- Drift detection: re-measures baseline every 5 consecutive discards to detect environment changes
- Checks stop conditions at the top of each iteration (signal, max experiments)
- Unlocks evaluator on completion

## Experiment Agent (`src/lib/experiment.ts`)

Manages per-iteration experiment agent sessions:

- `buildContextPacket()` — assembles baseline, results, git log, discarded diffs from disk
- `buildExperimentPrompt()` — formats context packet as user message
- `runExperimentAgent()` — one-shot SDK session with streaming callbacks
- `checkLockViolation()` — detects modifications to `.autoauto/` files via git diff
- Agent is stateless between iterations — all memory comes from the context packet

### Agent Architecture (updated)

| Role | System Prompt | User Message | Session | File |
|------|---------------|--------------|---------|------|
| Setup Agent | `getSetupSystemPrompt()` | Interactive multi-turn | Long-lived | `system-prompts.ts` |
| Experiment Agent | `getExperimentSystemPrompt()` | Context packet (one-shot) | Per-iteration | `experiment.ts` |

## Execution Dashboard (`src/screens/ExecutionScreen.tsx`)

Three-panel dashboard for live experiment monitoring:

- **StatsHeader** — Fixed-height panel: experiment count, keeps/discards/crashes, baseline vs best metric with improvement %, cumulative cost, and a Unicode sparkline of keep-only metric values
- **ResultsTable** — Navigable table of experiment outcomes, color-coded by status (green=keep, red=discard/crash, yellow=measurement_failure). Tab to focus, j/k/arrows to browse, Enter to select. Auto-scrolls to latest when unfocused.
- **AgentPanel** — Dual-purpose panel: shows live streaming agent text and tool status by default; switches to a structured experiment detail view (status, commit, metric, quality gates, description) when a result row is selected. Escape deselects and returns to live view.

State management: ExecutionScreen owns all dashboard state (results array, metric history, streaming text, cost accumulator, table focus, selected experiment). Components receive props — no component-local data fetching. LoopCallbacks drive all updates.

## Results & Events (`src/lib/run.ts`, `src/lib/events.ts`)

Results tracking has two layers:

- **Write side** (Phases 2a–2c): `appendResult()` and `writeState()` called at every decision point
- **Read side** (Phase 2d): `readAllResults()`, `getMetricHistory()`, `getRunStats()` for TUI consumption

Run discovery:
- `listRuns()` — enumerates all runs for a program, reads their states
- `getLatestRun()` — returns the most recent run

Event logging:
- `events.ndjson` — append-only structural event log per run
- Events emitted via `createEventLogger()` wrapper around `LoopCallbacks`
- Structural events only (phase changes, experiment outcomes, errors) — no streaming text
- Used for debugging and forward-compatible with Phase 4 daemon IPC

Cost tracking:
- `ExperimentCost` captured from SDK `SDKResultMessage` at end of each agent session
- Logged to events.ndjson as `experiment_cost` events
- Not in results.tsv (avoids format migration)

## Current State

Phase 1 (Setup) is complete. Phase 2a (Branch & Baseline) adds the run lifecycle utilities:
experiment branch creation, baseline measurement, state persistence, evaluator locking, and
the `startRun()` orchestrator that ties it all together. Phase 2b (Experiment Loop) adds the
core orchestrator loop: context packet building, experiment agent spawning with streaming,
lock violation detection, measurement + keep/discard decisions, and the main loop that ties
everything together. Phase 2d (Results Tracking) adds the read-side utilities for results and
run state, the events.ndjson persistent event log, run listing/discovery, and per-experiment
cost tracking from the SDK. Phase 2f (TUI Dashboard) adds the full execution dashboard: stats
header with sparkline, color-coded results table, and live agent output panel. The dashboard
is composed of three rendering components (StatsHeader, ResultsTable, AgentPanel) orchestrated
by ExecutionScreen. The TUI shell, screen navigation, program listing, multi-turn Claude Agent
SDK chat, setup agent (repo inspection, scope definition, artifact generation, measurement
validation), and model configuration are all implemented. Authentication is checked on startup
with a helpful error screen if not configured.
