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
- `revertCommits()` uses `git revert --no-edit` (not reset) to preserve history for agent learning
- `resetHard()` is the fallback for revert conflicts only

## Current State

Phase 1 (Setup) is complete. Phase 2a (Branch & Baseline) adds the run lifecycle utilities:
experiment branch creation, baseline measurement, state persistence, evaluator locking, and
the `startRun()` orchestrator that ties it all together. The TUI shell, screen navigation,
program listing, multi-turn Claude Agent SDK chat, setup agent (repo inspection, scope
definition, artifact generation, measurement validation), and model configuration are all
implemented. Authentication is checked on startup with a helpful error screen if not configured.
