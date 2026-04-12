# Architecture

Internal architecture reference for contributors. For a user-facing overview of how AutoAuto works, see [Concepts](concepts.md).

## Overview

Bun + TypeScript TUI app using OpenTUI React for rendering and pluggable agent providers (Claude Agent SDK, Codex, OpenCode) for AI interactions. App controls flow, agents provide intelligence.

## Entry points

`src/index.tsx` — dispatcher: if CLI args are present, imports `src/cli.ts` (headless CLI mode); otherwise imports `src/tui.tsx` (interactive TUI).

- **`src/tui.tsx`** — creates an OpenTUI CLI renderer, registers agent providers, and mounts `<App />`.
- **`src/cli.ts`** — headless CLI for full programmatic control: program inspection (`show`), run lifecycle (`start`/`status`/`results`/`logs`/`summary`/`stop`), measurement validation (`validate`), configuration management (`config`), deletion (`delete`), and queue management (`queue`). All commands support `--json` for machine-readable output and `--help` for per-command usage. Supports `--version`/`-v` flag.

## Screen navigation

`App.tsx` manages a `Screen` state and renders the active screen. On mount, checks whether `.autoauto/config.json` exists — if not, shows first-setup; otherwise shows home.

### Screens

- **FirstSetupScreen** — first-time setup: separate model pickers for conversational (setup/update/finalize) and experiment agents, with auth verification
- **HomeScreen** — two-panel layout with optional queue bottom panel: programs list + runs table + queue, Tab cycles panels, j/k navigation, `n` to create
- **SetupScreen** — wraps `Chat` with support model; supports new-program and update mode
- **PreRunScreen** — pre-run configuration: model/provider/effort/max experiments overrides; `a` to add to queue
- **ExecutionScreen** — three-panel experiment dashboard (stats, results table, agent panel)
- **SettingsScreen** — model configuration for execution and support slots
- **AuthErrorScreen** — displayed when authentication fails

## Agent architecture

AutoAuto uses an agent provider abstraction (`src/lib/agent/`) that decouples the app from any specific SDK.

- **`AgentProvider`** interface: `createSession()`, `runOnce()`, `checkAuth()`, `listModels()`
- **`AgentSession`** interface: `AsyncIterable<AgentEvent>` + `pushMessage()` + `endInput()` + `close()`
- **`AgentEvent`** union: `text_delta`, `tool_use`, `assistant_complete`, `error`, `result`

| Role | Model Slot | System Prompt | Session | File |
|------|-----------|---------------|---------|------|
| Setup Agent | Support | `getSetupSystemPrompt()` | Long-lived multi-turn | `system-prompts/setup.ts` |
| Update Agent | Support | `getUpdateSystemPrompt()` | Long-lived multi-turn | `system-prompts/update.ts` |
| Experiment Agent | Execution | `getExperimentSystemPrompt()` | One-shot per iteration | `system-prompts/experiment.ts` |
| Finalize Agent | Support | `getFinalizeSystemPrompt()` | Long-lived multi-turn | `system-prompts/finalize.ts` |

All agents use `permissionMode: "bypassPermissions"` and tools: Read, Write, Edit, Bash, Glob, Grep.

## Data layer

`src/lib/programs.ts` — filesystem operations for `.autoauto/`:

- `getProjectRoot()` — resolves through git worktrees to find the main repo root (cached)
- `ProgramConfig` / `QualityGate` — shared types (import from here, not `validate-measurement.ts`)

`src/lib/config.ts` — project-level config (`ModelSlot`, `ProjectConfig`, `loadProjectConfig()`, `saveProjectConfig()`)

## Experiment loop

`src/lib/experiment-loop.ts` — the core orchestrator:

- Two-root path model: `cwd` (worktree for git/agent ops) vs `programDir` (main root for config/state)
- `LoopCallbacks` — callback interface for display layer
- `LoopOptions` — max experiments, abort signal, `stopRequested` callback
- Simplicity criterion: within-noise experiments with net-negative LOC are auto-kept
- Re-baselines after keeps and after 5 consecutive discards
- Stagnation auto-stop after `max_consecutive_discards`
- Ideas backlog appended per experiment when enabled
- Carry-forward: reads previous run context once at startup via `readPreviousRunContext()`

`src/lib/experiment.ts` — per-iteration agent sessions:

- `buildContextPacket()` / `buildExperimentPrompt()` — assembles one-shot context
- `runExperimentAgent()` — one-shot agent with streaming callbacks
- `checkLockViolation()` — detects modifications to `.autoauto/` files

## Background daemon

`src/daemon.ts` — decouples the experiment loop from the TUI.

### Lifecycle

1. TUI creates worktree, run dir, `run-config.json`, lock file, then spawns detached daemon
2. On macOS, a `caffeinate -i -w <pid>` process is spawned alongside the daemon to prevent idle sleep
3. Daemon writes `daemon.json` with UUID + starts 10s heartbeat
4. Crash recovery from `state.json` if resuming
5. Baseline measurement, then experiment loop via `runExperimentLoop()` with `FileCallbacks`
6. On complete: final state, unlock measurement, release lock, exit

### Queue chaining

When a queued run completes, the daemon automatically starts the next entry from `.autoauto/queue.json`. The chaining logic runs in the `finally` block after lock release:

1. Clean up worktree (prevents accumulation)
2. Pop next queue entry via `startNextFromQueue()` (O_EXCL locked to prevent TUI/daemon races)
3. Skip entries that have failed ≥2 times (`retryCount`)
4. Call `spawnDaemon()` with `source: "queue"` — only queued runs chain
5. On failure: re-insert entry with incremented retry count, send notification

TUI fallback: on home screen mount, if queue has entries, `startNextFromQueue()` is called to resume stalled queues.

### IPC (filesystem-based)

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `daemon.json` | TUI (initial), daemon (heartbeat) | TUI | Liveness detection |
| `run-config.json` | TUI (once) | Daemon (once) | Per-run overrides (model, max experiments, carry_forward, etc.) |
| `state.json` | Daemon (atomic) | TUI | Run state source of truth |
| `results.tsv` | Daemon (append) | TUI | Experiment outcomes |
| `stream-NNN.log` | Daemon (append) | TUI | Agent streaming text |
| `control.json` | TUI | Daemon (on SIGTERM) | Stop/abort commands |
| `queue.json` | TUI + Daemon | TUI + Daemon | Sequential run queue (atomic temp+rename) |
| `queue.lock` | popQueue() | popQueue() | O_EXCL mutex for concurrent pop prevention |

TUI watches via `fs.watch` with delta reads for results and stream logs.

### Locking

Per-program lock at `.autoauto/programs/<slug>/run.lock` with `O_EXCL`. Stale detection via `daemon_id` cross-check + heartbeat age. Multiple programs can run concurrently.

## Execution dashboard

Three-panel layout in `ExecutionScreen.tsx`:

- **StatsHeader** — experiment count, keeps/discards, improvement %, cost, sparkline
- **ResultsTable** — navigable, color-coded table (green=keep, red=discard, yellow=measurement_failure)
- **AgentPanel** — dual-purpose: live streaming or selected experiment detail view

Two modes: spawn (creates worktree + daemon) and attach (connects to existing daemon).

Keyboard shortcuts are phase-appropriate: during a running experiment `q`/`Ctrl+C`/`s`/`i` are available; after completion the shortcuts switch to `f` (finalize), `i` (ideas), and `Escape` (back).

Stop/abort escalation: `q` -> confirmation -> stop-after-current; `Ctrl+C` -> abort; second `Ctrl+C` after 5s -> SIGKILL.

## Measurement

`src/lib/measure.ts`:

- `runMeasurement()` — single execution with JSON parsing and validation
- `runMeasurementSeries()` — N repeated measurements with median aggregation
- `compareMetricWithSignificance()` — relative change comparison against noise threshold with Mann-Whitney U p-value override
- `checkQualityGates()` — threshold enforcement

`src/lib/validate-measurement.ts` — standalone script for setup-time stability validation: runs measure.sh N times, computes CV%, recommends config.

## Finalize

`src/lib/finalize.ts` — post-run review context and report generation:

- `buildFinalizeContext()` — assembles run results, stats, changed files, and diff into a context object
- `buildFinalizeInitialMessage()` — formats context into the initial chat message
- `generateSummaryReport()` — produces markdown summary of the run
- `saveFinalizeReport()` — writes summary.md to run directory

The finalize agent runs as a multi-turn chat session (same as setup/update agents) with full write access. It guides the user through experiment review, risk assessment, exclusions, branch selection, and code packaging.
