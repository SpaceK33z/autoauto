# Architecture

## Overview

Bun + TypeScript TUI app using OpenTUI React for rendering and pluggable agent providers (Claude Agent SDK, Codex, OpenCode) for AI interactions. App controls flow, agents provide intelligence.

## Entry Points

`src/index.tsx` — dispatcher: if CLI args are present, imports `src/cli.ts` (headless CLI mode); otherwise imports `src/tui.tsx` (interactive TUI).

- **`src/tui.tsx`** — creates an OpenTUI CLI renderer, registers agent providers, and mounts `<App />`.
- **`src/cli.ts`** — headless CLI for listing programs/runs, spawning/stopping/attaching daemon runs, and managing state without the TUI.

## Screen Navigation

`App.tsx` manages a `Screen` state (`"home" | "setup" | "settings" | "program-detail" | "pre-run" | "execution" | "first-setup"`) and renders the active screen. On mount, checks whether `.autoauto/config.json` exists — if not, shows the first-setup screen; otherwise shows the home screen. Global keyboard handling (Escape to quit from home).

### Screens

- **FirstSetupScreen** — first-time setup: provider/model selection with auth verification, creates initial `config.json`
- **HomeScreen** — two-panel layout: programs list (left) + runs table (right, `RunsTable`), supports j/k navigation, `n` to create new, `s` for settings, Tab to switch panels, Enter to run/attach
- **SetupScreen** — wraps the `Chat` component with configured support model; supports both new-program setup (analyze codebase or direct) and update mode (re-optimize existing program via `programSlug` prop), Escape to go back
- **PreRunScreen** — pre-run configuration: model/provider/effort overrides, max experiments, worktree toggle
- **ExecutionScreen** — three-panel experiment dashboard (see Execution Dashboard section)
- **SettingsScreen** — model configuration for execution and support slots, keyboard-driven value cycling
- **AuthErrorScreen** — displayed when authentication fails, shows setup instructions

## Components

- **Chat** (`src/components/Chat.tsx`) — Multi-turn conversational interface. Maintains a long-lived agent session using a push-based `AsyncIterable` prompt. Renders full message history (user + assistant) in an auto-scrolling scrollbox. Streams assistant responses token-by-token.
- **ResultsTable** (`src/components/ResultsTable.tsx`) — Navigable experiment results table, color-coded by status. Tab to focus, j/k/arrows to browse, Enter to inspect.
- **RunsTable** (`src/components/RunsTable.tsx`) — Table of runs across programs, shown in the HomeScreen right panel.
- **StatsHeader** (`src/components/StatsHeader.tsx`) — Run stats + metric sparkline.
- **AgentPanel** (`src/components/AgentPanel.tsx`) — Live agent streaming output OR experiment detail view.
- **RunCompletePrompt** (`src/components/RunCompletePrompt.tsx`) — Post-run prompt (finalize, update program, or abandon).
- **PostUpdatePrompt** (`src/components/PostUpdatePrompt.tsx`) — Post-update prompt after editing a program (start new run or go home).
- **CycleField** (`src/components/CycleField.tsx`) — Reusable keyboard-driven cycle-through field (← → to change value).
- **ModelPicker** (`src/components/ModelPicker.tsx`) — Model selection UI with provider-specific model lists.
- **RunSettingsOverlay** (`src/components/RunSettingsOverlay.tsx`) — Inline overlay for editing max experiments during a run.

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
  index.tsx              # Entry point dispatcher (CLI args → cli.ts, else → tui.tsx)
  tui.tsx                # TUI entry: creates renderer, registers providers, mounts <App />
  cli.ts                 # Headless CLI: list/run/stop/attach without TUI
  App.tsx                # Screen routing, global keys, config check
  daemon.ts              # Background daemon entry point (detached process)
  components/
    Chat.tsx             # Agent streaming chat (multi-turn)
    ResultsTable.tsx     # Navigable experiment results table
    RunsTable.tsx        # Runs table for HomeScreen
    StatsHeader.tsx      # Run stats + metric sparkline
    AgentPanel.tsx       # Live agent streaming output OR experiment detail view
    RunCompletePrompt.tsx # Post-run prompt (finalize, update, or abandon)
    PostUpdatePrompt.tsx # Post-update prompt (start run or go home)
    CycleField.tsx       # Reusable cycle-through field component
    ModelPicker.tsx      # Model selection UI with provider-specific lists
    RunSettingsOverlay.tsx # Inline max-experiments editor overlay
  screens/
    FirstSetupScreen.tsx # First-time setup (provider/model + auth check)
    HomeScreen.tsx       # Two-panel: programs list + runs table
    SetupScreen.tsx      # Setup flow (chat wrapper + agent config)
    PreRunScreen.tsx     # Pre-run config (model/effort/max/worktree overrides)
    ExecutionScreen.tsx  # Three-panel experiment dashboard
    SettingsScreen.tsx   # Model configuration (execution + support slots)
    AuthErrorScreen.tsx  # Auth error display with setup instructions
  lib/
    agent/               # Agent provider abstraction layer
      types.ts           # AgentEvent, AgentSession, AgentProvider interfaces
      index.ts           # Provider registry (setProvider/getProvider)
      claude-provider.ts # Claude Agent SDK provider
      codex-provider.ts  # Codex CLI provider
      opencode-provider.ts # OpenCode provider
      default-providers.ts # Registers all available providers at startup
      mock-provider.ts   # Mock provider for testing
    auth.ts              # Authentication checking via agent provider
    config.ts            # Project config CRUD (.autoauto/config.json)
    git.ts               # Git operations (branch, revert, log, SHA, diff stats)
    measure.ts           # Measurement execution, validation, comparison
    programs.ts          # Filesystem ops, program CRUD, config types
    push-stream.ts       # Push-based async iterable utility
    run.ts               # Run state persistence, types, results I/O
    run-setup.ts         # Run bootstrap: directory init, measurement locking
    system-prompts/      # Agent system prompts
      index.ts           # Re-exports all prompt functions
      setup.ts           # Setup agent system prompt
      update.ts          # Update agent system prompt
      experiment.ts      # Experiment agent system prompt
      finalize.ts        # Finalize agent system prompt
    tool-events.ts       # Tool event display formatting
    validate-measurement.ts  # Standalone measurement validation script
    experiment.ts          # Experiment agent spawning, context packets, lock detection
    experiment-loop.ts     # Main experiment loop orchestrator
    ideas-backlog.ts       # Ideas backlog: append/read per-experiment notes (ideas.md)
    model-options.ts       # Model picker option loading from providers
    format.ts              # Table formatting utilities (padRight, truncate, column allocation)
    syntax-theme.ts        # Tokyo Night syntax highlighting theme for code display
    worktree.ts            # Git worktree create/remove for run isolation
    finalize.ts            # Post-run finalize: agent review, group branches, squash fallback
    run-context.ts         # Build update agent context from previous run data
    daemon-callbacks.ts    # FileCallbacks: LoopCallbacks impl for daemon (per-experiment stream log writes)
    daemon-lifecycle.ts    # Daemon identity, heartbeat, signals, crash recovery, locking
    daemon-client.ts       # TUI-side: spawn daemon, watch files, send control, reconnect
```

## Configuration

`src/lib/config.ts` — project-level configuration at `.autoauto/config.json`:

- `ModelSlot` — provider + model alias + effort level
- `ProjectConfig` — two model slots (`executionModel`, `supportModel`) + `ideasBacklogEnabled` flag
- `loadProjectConfig()` — reads config, merges with defaults for forward compatibility
- `saveProjectConfig()` — writes config as formatted JSON

Three providers: Claude (`claude-provider.ts`), Codex (`codex-provider.ts`), OpenCode (`opencode-provider.ts`). Default: Claude / Sonnet + high effort for both slots.

## Authentication

`src/lib/auth.ts` — checks auth via the active agent provider:

- Calls `provider.checkAuth()` to verify authentication works
- Supports all providers (Claude SDK, Codex CLI, OpenCode)
- Returns account info on success, error message on failure
- First-time setup (`FirstSetupScreen`) verifies auth before saving config
- App shows `AuthErrorScreen` on failure with remediation instructions

## Agent Architecture

AutoAuto uses an agent provider abstraction (`src/lib/agent/`) that decouples the app from any specific SDK. Providers implement the `AgentProvider` interface (create sessions, run one-shot, check auth, list models). The host application manages the conversation UI while the provider handles the agent loop, tool execution, and context management.

### Agent Providers (`src/lib/agent/`)

- **`AgentProvider`** interface: `createSession()`, `runOnce()`, `checkAuth()`, `listModels()`
- **`AgentSession`** interface: `AsyncIterable<AgentEvent>` + `pushMessage()` + `endInput()` + `close()`
- **`AgentEvent`** union: `text_delta`, `tool_use`, `assistant_complete`, `error`, `result`
- **`claude-provider.ts`** — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **`codex-provider.ts`** — Codex CLI wrapper
- **`opencode-provider.ts`** — OpenCode provider
- **`default-providers.ts`** — Registers all available providers at startup
- **Provider registry** (`index.ts`): `setProvider(id, provider)` / `getProvider(id)`

### Setup Agent (`src/lib/system-prompts/setup.ts`)

- **Purpose:** Inspect repo, suggest targets, define scope, generate program artifacts
- **Tools:** Read, Write, Edit, Bash, Glob, Grep
- **Permission mode:** `bypassPermissions` (AutoAuto manages UI, not the provider)
- **Working directory:** Target project root (resolved via `getProjectRoot()`)
- **System prompt:** Encodes autoresearch expertise — guides user through repo inspection,
  target identification, scope definition, measurement approach, artifact generation
- **maxTurns:** 40 (conversation turns, including review iterations and measurement validation)
- **Artifacts generated:**
  - `program.md` — Goal, scope, rules, steps for the experiment agent
  - `measure.sh` — Measurement script tailored to the repo (must output JSON to stdout)
  - `config.json` — Metric field, direction, noise threshold, repeats, quality gates, secondary metrics
- **Review flow:** Agent presents artifacts as code blocks for review before writing to disk
- **Measurement validation:** After saving, the agent runs a standalone validation script
  (`src/lib/validate-measurement.ts`) that executes measure.sh 5 times, computes variance
  statistics (CV%), and recommends noise_threshold + repeats. If measurements are unstable,
  the agent helps fix the script and re-validates.

### Update Agent (`src/lib/system-prompts/update.ts`)

- **Purpose:** Re-optimize an existing program — review previous run results, update program.md / measure.sh / config.json
- **Tools:** Read, Write, Edit, Bash, Glob, Grep
- **Permission mode:** `bypassPermissions`
- **Working directory:** Target project root
- **Context:** Previous run data assembled by `buildUpdateRunContext()` (`src/lib/run-context.ts`) — past results, metric history, and program artifacts
- **System prompt:** Informed by the existing program artifacts and previous run analysis
- **maxTurns:** 40

### Measurement Validation (`src/lib/validate-measurement.ts`)

Standalone Bun script that validates measurement script stability:

- **Input:** Paths to measure.sh + config.json, number of runs
- **Execution:** Runs measure.sh N times sequentially, parses JSON output, validates fields
- **Stats:** Computes median, mean, min, max, stdev, CV% for primary metric and quality gates
- **Assessment:** excellent (<5% CV), acceptable (5-15%), noisy (15-30%), unstable (≥30%)
- **Output:** Single JSON object to stdout with stats, assessment, and config recommendations
- **Called by:** Setup agent via Bash tool
- **Used for:** Pre-experiment validation during setup (Phase 1) — ensures measurement is stable before entering the optimization loop

## Run State (`src/lib/run.ts`)

Manages run state persistence, types, and results I/O:

- `RunState` — checkpoint persisted atomically to `state.json` via temp-file + rename; includes `provider`, `model`, `effort`, `in_place` fields for reconnection
- `ExperimentResult` — typed row for the append-only `results.tsv`; includes `measurement_duration_ms` and `diff_stats` columns
- Branch naming: `autoauto-<slug>-<YYYYMMDD-HHMMSS>`

## Run Bootstrap (`src/lib/run-setup.ts`)

Run directory initialization and measurement locking:

- `initRunDir()` — creates run directory + results.tsv header
- `lockMeasurement()` / `unlockMeasurement()` — `chmod 444`/`644` on `measure.sh` + `config.json` + `build.sh` before/after loop

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

- `runExperimentLoop(cwd, programDir, runDir, ...)` — main loop: context → agent → measure → decide → repeat
- Two-root path model: `cwd` is the git/agent working directory (worktree in daemon mode), `programDir` is the program config directory (always in mainRoot's `.autoauto/`)
- `LoopCallbacks` — callback interface for display layer (phase change, streaming, results)
- `LoopOptions` — control knobs: max experiments, abort signal (hard kill), `stopRequested` callback (soft stop at iteration boundary)
- Calls `runMeasurementAndDecide()` for each iteration (includes measurement + keep/discard)
- **Simplicity criterion:** experiments within noise that have net-negative LOC (more lines removed than added) are auto-kept as "simplification"
- Re-baselines after every keep (fresh measurement on kept code, falls back to candidate measurement on failure)
- Drift detection: re-measures baseline every 5 consecutive discards to detect environment changes
- Stagnation detection: auto-stops after `max_consecutive_discards` (default 10) consecutive non-improving experiments; warns at ~2/3 of the limit; counter resets on any keep
- Ideas backlog: when enabled (`ideasBacklogEnabled` in project config), appends per-experiment notes (hypothesis, why it worked/failed, next ideas, things to avoid) to `ideas.md` in the run dir
- Persists `termination_reason` and `total_cost_usd` on RunState at loop completion
- Unlocks evaluator on completion

## Experiment Agent (`src/lib/experiment.ts`)

Manages per-iteration experiment agent sessions:

- `buildContextPacket()` — assembles baseline, results, git log, discarded diffs, ideas backlog, secondary metrics from disk
- `buildExperimentPrompt()` — formats context packet as user message
- `runExperimentAgent()` — one-shot agent session with streaming callbacks (uses `getProvider()`)
- `checkLockViolation()` — detects modifications to `.autoauto/` files via git diff
- Agent is stateless between iterations — all memory comes from the context packet

### Agent Architecture (summary)

| Role | System Prompt | User Message | Session | File |
|------|---------------|--------------|---------|------|
| Setup Agent | `getSetupSystemPrompt()` | Interactive multi-turn | Long-lived | `system-prompts/setup.ts` |
| Update Agent | `getUpdateSystemPrompt()` | Update context + interactive | Long-lived | `system-prompts/update.ts` |
| Experiment Agent | `getExperimentSystemPrompt()` | Context packet (one-shot) | Per-iteration | `system-prompts/experiment.ts` |
| Finalize Agent | `getFinalizeSystemPrompt()` | Accumulated diff + results | One-shot | `system-prompts/finalize.ts` |

## Execution Dashboard (`src/screens/ExecutionScreen.tsx`)

Three-panel dashboard for live experiment monitoring:

- **StatsHeader** — Fixed-height panel: experiment count, keeps/discards/crashes, baseline vs best metric with improvement %, cumulative cost, and a Unicode sparkline of keep-only metric values
- **ResultsTable** — Navigable table of experiment outcomes, color-coded by status (green=keep, red=discard/crash, yellow=measurement_failure). Tab to focus, j/k/arrows to browse, Enter to select. Auto-scrolls to latest when unfocused.
- **AgentPanel** — Dual-purpose panel: shows live streaming agent text and tool status by default; switches to a structured experiment detail view (status, commit, metric, quality gates, description) when a result row is selected. Escape deselects and returns to live view.

State management: ExecutionScreen owns all dashboard state. Two modes:
- **Spawn mode** (default): creates worktree, spawns daemon, watches run dir for updates
- **Attach mode** (`attachRunId` prop): connects to existing daemon, reconstructs state from files

All updates come from file watching (daemon-client.ts `watchRunDir`), not in-process callbacks. Cleanup remains in-process in the TUI.

Stop/abort escalation: `q` → confirmation → stop-after-current; `Ctrl+C` → abort; second `Ctrl+C` after 5s → SIGKILL.

## Results & Cost Tracking (`src/lib/run.ts`)

Results tracking has two layers:

- **Write side** (Phases 2a–2c): `appendResult()` and `writeState()` called at every decision point
- **Read side** (Phase 2d): `readAllResults()`, `getMetricHistory()`, `getRunStats()` for TUI consumption

Run discovery:
- `listRuns()` — enumerates all runs for a program, reads their states
- `getLatestRun()` — returns the most recent run

Cost tracking:
- `ExperimentCost` (aliased from `AgentCost`) captured from agent provider at end of each session
- Accumulated on `RunState.total_cost_usd` and `total_tokens`

## Background Daemon (`src/daemon.ts`)

Decouples the experiment loop from the TUI so runs survive terminal close/quit.

### Two-Root Path Model

- **mainRoot** — user's original checkout, contains `.autoauto/` with all state and config
- **worktreePath** — AutoAuto-owned git worktree (`.autoauto/worktrees/<runId>/`), agent's working directory. `.autoauto/` doesn't exist here (gitignored), preventing the agent from touching state files.

### Daemon Lifecycle

1. TUI creates worktree, run dir, `run-config.json`, lock file, then spawns detached daemon
2. Daemon writes `daemon.json` with UUID `daemon_id` + starts 10s heartbeat
3. Crash recovery from `state.json` if resuming
4. Baseline measurement in worktree
5. Experiment loop via `runExperimentLoop()` with `FileCallbacks`
6. On complete: final state, unlock measurement, release lock, exit

### IPC (Filesystem-Based)

| File | Writer | Reader | Purpose |
|---|---|---|---|
| `daemon.json` | TUI (initial), daemon (heartbeat) | TUI | Liveness detection |
| `run-config.json` | TUI (once) | Daemon (once) | Per-run model/effort/max overrides |
| `state.json` | Daemon (atomic) | TUI | Run state source of truth |
| `results.tsv` | Daemon (append) | TUI | Experiment outcomes |
| `stream-NNN.log` | Daemon (append, one per experiment) | TUI | Agent streaming text |
| `control.json` | TUI | Daemon (on SIGTERM) | Stop/abort commands |

TUI watches the run directory via `fs.watch` (falls back to polling). Delta reads for `results.tsv` and per-experiment `stream-NNN.log` files.

### FileCallbacks (`src/lib/daemon-callbacks.ts`)

Thin `LoopCallbacks` implementation — only writes per-experiment stream logs (`stream-001.log`, etc.). The loop already writes `state.json`/`results.tsv` directly.

### Locking

Per-program lock at `.autoauto/programs/<slug>/run.lock` with `O_EXCL`. Stale detection via `daemon_id` cross-check + heartbeat age. Multiple programs can run concurrently.

### Worktree Lifecycle

Created by TUI before daemon spawn. Kept after cleanup (user merges). Removed on abandon (with confirmation). Stale worktrees left in place.

## Data Model

Three-level hierarchy: **Project** > **Program** > **Run**.

- **Project** — the target codebase (e.g. "my Next.js app")
- **Program** — a reusable optimization target with a metric, measurement script, agent instructions, and scope constraints (e.g. "homepage LCP", "API /users latency")
- **Run** — one execution session of a program in an AutoAuto-owned worktree on a dedicated branch, producing a results.tsv and experiment history

### `.autoauto/` File Structure

All state lives inside the target repo, gitignored (`.autoauto/` is added to `.gitignore` automatically on first run):

```
.autoauto/
  config.json                    # project-level config (default models, etc.)
  worktrees/
    20260407-143022/             # AutoAuto-owned git worktree for an active/completed run
  programs/
    homepage-lcp/
      program.md                 # agent instructions + scope constraints (structured)
      build.sh                   # optional one-time build/compile step before measurement
      measure.sh                 # generated measurement script
      config.json                # metric field, direction, noise threshold, repeats, quality gates
      runs/
        20260407-143022/
          daemon.json            # daemon identity, PID, start time, heartbeat, worktree path
          state.json             # atomic checkpoint: experiment #, phase, baseline, SHAs
          control.json           # TUI stop/abort requests
          results.tsv            # durable experiment outcomes (append-only)
          stream-001.log         # per-experiment agent streaming text (one file per experiment)
          stream-002.log
          ideas.md               # ideas backlog — per-experiment notes (optional)
          daemon.log             # daemon stderr/stdout (not surfaced in TUI)
          summary.md
```

### Measurement Output Contract

`measure.sh` outputs a **single JSON object** to stdout containing multiple fields. The orchestrator extracts what it needs based on `config.json`:

```json
{
  "lcp_ms": 1230,
  "cls": 0.05,
  "tbt_ms": 180,
  "fcp_ms": 890
}
```

Strict contract:

- stdout must contain valid JSON and nothing else
- output must be a JSON object, not an array or scalar
- `metric_field` must exist and be a finite number (`NaN`, `Infinity`, `null`, strings = invalid)
- every configured quality gate field must exist and be a finite number
- nonzero exit code = crash
- timeout = crash
- invalid JSON, invalid metric shape, or missing/non-finite quality gate field = measurement failure
- finite quality gate value outside its configured threshold = discard
- repeated measurements apply to all fields, not just the primary metric; the orchestrator compares median primary metric and median quality gate values

### Program Config

`config.json` declares the primary metric, direction, quality gates, and optional secondary metrics:

```json
{
  "metric_field": "lcp_ms",
  "direction": "lower",
  "noise_threshold": 0.02,
  "repeats": 3,
  "quality_gates": {
    "cls": { "max": 0.1 },
    "tbt_ms": { "max": 300 }
  },
  "secondary_metrics": {
    "fcp_ms": { "direction": "lower" }
  },
  "max_consecutive_discards": 10
}
```

For non-ML use cases where the metric is subjective (prompt quality, copy, templates), the setup agent should prefer binary yes/no eval criteria over sliding scales — see `failure-patterns.md` section 1d for rationale.

### program.md Structure

The setup agent generates a structured `program.md` with required sections:

```markdown
# Program: Homepage LCP

## Goal
Reduce Largest Contentful Paint on the homepage.

## Scope
- Files: src/app/page.tsx, src/components/Hero/**
- Off-limits: third-party scripts, CDN config, image quality

## Rules
- Do not add lazy loading to above-the-fold content
- Do not reduce image quality below current settings

## Steps
1. ANALYZE: Read profiling data and results.tsv...
2. PLAN: Identify one specific optimization...
3. IMPLEMENT: Make the change...
4. COMMIT: git add -A && git commit -m "perf(scope): description"
```

### Results TSV

Each experiment is logged as a row:

```
experiment#	commit	metric_value	secondary_values	status	description	measurement_duration_ms	diff_stats
```

- `status`: `keep`, `discard`, `measurement_failure`, or `crash`
- `measurement_failure`: command exited successfully but output violated the measurement contract (invalid JSON, missing/non-finite primary metric, missing/non-finite quality gate field)
- `crash`: nonzero exit, timeout, OOM, killed process, or other command-level failure
- `description`: from the agent's commit message

## Current State

All core phases are complete: Setup, Execution (daemon-backed), Finalize, and CLI mode.

Key capabilities:
- **Agent provider abstraction** — pluggable providers (Claude, Codex, OpenCode) behind a common interface
- **Provider-specific model selection** — model picker UI queries each provider for available models
- **First-setup flow** — new users go through provider/model selection + auth check before reaching home
- **Pre-run configuration** — per-run overrides for model, effort, max experiments, and worktree toggle
- **Program update mode** — re-optimize existing programs: Update Agent reviews previous run results (via `run-context.ts`), modifies program artifacts, and offers to start a new run
- **In-place run mode** — optional mode that skips worktree isolation and runs experiments in the main checkout
- **Simplicity criterion** — auto-keeps experiments that are within noise but simplify code (net-negative LOC)
- **Ideas backlog** — optional `ideas.md` that accumulates per-experiment notes (hypothesis, failure reasons, next ideas)
- **Secondary metrics** — tracked alongside quality gates but without hard thresholds; shown in context packets
- **Finalize agent** — reviews accumulated diff and groups changes into independent branches (squash fallback)
- **CLI mode** — headless CLI for listing, running, stopping, and attaching without the TUI
- **Background daemon** — decoupled experiment loop running in a git worktree; TUI watches state files for updates
- **Two-root path model** — `mainRoot` for state, `worktreePath` for experiments
- **Stop/abort separation** — `stopRequested` for graceful stop, `AbortSignal` for hard kill, process group cleanup for orphan subprocesses
