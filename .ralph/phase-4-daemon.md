# Phase 4: Background Daemon

Decouples the orchestrator from the TUI so runs survive terminal close/quit.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TUI PROCESS (client)                        │
│                                                                     │
│  ExecutionScreen (two modes: spawn new / attach existing)           │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  DaemonClient                                                 │  │
│  │  ┌─────────────────┐  ┌──────────────┐  ┌─────────────────┐  │  │
│  │  │ spawnDaemon()    │  │ watchRunDir()│  │ sendControl()   │  │  │
│  │  │ Bun.spawn(       │  │ fs.watch on  │  │ write           │  │  │
│  │  │   detached,      │  │ run dir +    │  │ control.json    │  │  │
│  │  │   unref)         │  │ heartbeat    │  │ + SIGTERM       │  │  │
│  │  └────────┬────────┘  │ backup timer │  └────────┬────────┘  │  │
│  │           │           └──────┬───────┘           │           │  │
│  └───────────┼──────────────────┼───────────────────┼───────────┘  │
│              │                  │                    │              │
│  ┌───────────┼──────────────────┼────────────────────┼──────────┐  │
│  │  UI       │   reads files    │   keyboard → ctrl  │          │  │
│  │  StatsHeader ← state.json   │                     │          │  │
│  │  ResultsTable ← results.tsv │                     │          │  │
│  │  AgentPanel ← stream.log    │                     │          │  │
│  │  Sparkline ← results.tsv    │                     │          │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────┼─────────────────────────────────┘
                                  │
         ╔════════════════════════╪══════════════════════════╗
         ║     FILESYSTEM IPC     │  (.autoauto/programs/    ║
         ║                        │   <slug>/runs/<id>/)     ║
         ║                        │                          ║
         ║  daemon.json ──────────┤── pid, daemon_id,        ║
         ║                        │   heartbeat_at,          ║
         ║                        │   worktree_path          ║
         ║                        │                          ║
         ║  run-config.json ──────┤── per-run overrides      ║
         ║  (TUI writes once)     │   (model, effort, max)   ║
         ║                        │                          ║
         ║  state.json ───────────┤── phase, baseline,       ║
         ║  (atomic tmp+rename)   │   experiment#, SHAs,     ║
         ║                        │   counters, best_metric  ║
         ║                        │                          ║
         ║  results.tsv ──────────┤── append-only rows       ║
         ║                        │                          ║
         ║  events.ndjson ────────┤── structural events      ║
         ║                        │                          ║
         ║  stream.log ───────────┤── raw agent text         ║
         ║  (append-only,         │   (reset per experiment) ║
         ║   truncate on start)   │                          ║
         ║                        │                          ║
         ║  control.json ─────────┤── {action: "stop"|       ║
         ║  (TUI → daemon)        │    "abort", timestamp}   ║
         ║                        │                          ║
         ╚════════════════════════╪══════════════════════════╝
                                  │
┌─────────────────────────────────┼─────────────────────────────────┐
│                     DAEMON PROCESS (server)                        │
│                     (detached bun process)                         │
│                                                                    │
│  src/daemon.ts (resolved to absolute path at spawn time)           │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  main()                                                      │  │
│  │  1. Parse args (programSlug, runId, mainRoot, worktreePath)  │  │
│  │  2. Write daemon.json (daemon_id + heartbeat), start timer   │  │
│  │  3. Read run-config.json for model/effort/maxExperiments     │  │
│  │  4. Crash recovery: readState() → detect in-flight → clean   │  │
│  │  5. Build FileCallbacks (implements LoopCallbacks)            │  │
│  │  6. Write state.json {phase: "baseline"} before measuring    │  │
│  │  7. Lock measurement, run baseline, start loop               │  │
│  │  8. On complete: write final state, remove lock, exit        │  │
│  │                                                              │  │
│  │  Signal handlers:                                            │  │
│  │  ├─ SIGTERM → read control.json → stop or abort              │  │
│  │  └─ stopRequested flag (checked at loop boundary)            │  │
│  │  └─ abortController (for hard abort only)                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  FileCallbacks implements LoopCallbacks                      │  │
│  │                                                              │  │
│  │  onAgentStream()    → append to stream.log                   │  │
│  │  onAgentToolUse()   → append formatted text to stream.log    │  │
│  │  onExperimentStart()→ truncate stream.log                    │  │
│  │  (all others)       → no-op (loop already writes state.json, │  │
│  │                       results.tsv; createEventLogger wraps   │  │
│  │                       these callbacks for events.ndjson)     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Runs inside git worktree:                                         │
│  .autoauto/worktrees/<runId>/  (isolated copy of repo)             │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Lifecycle Sequence

```
  TUI                              Filesystem                     Daemon
   │                                  │                              │
   │  "Start Run" pressed             │                              │
   ├─ check working tree clean        │                              │
   ├─ generate run ID                 │                              │
   ├─ git worktree add ─────────────► │                              │
   ├─ init run dir ─────────────────► │                              │
   ├─ write run-config.json ────────► │  {model, effort,             │
   │                                  │   maxExperiments}            │
   ├─ write run.lock ───────────────► │                              │
   ├─ Bun.spawn(DAEMON_PATH, args)   │                              │
   │  detached, unref ──────────────────────────────────────────────►│
   ├─ write daemon.json ────────────► │  {run_id, pid,               │
   │  (pid from spawn result)         │   started_at,                │
   │                                  │   worktree_path}             │
   │                                  │                         parse args
   │                                  │◄── daemon.json overwrite ───┤
   │  (TUI can exit here safely)      │    (adds daemon_id +        │
   │                                  │     heartbeat_at)            │
   │                                  │                    read run-config
   │                                  │◄── state.json (baseline) ───┤
   │                                  │                    lock measurement
   │                                  │                    run baseline
   │                                  │◄── state.json (baseline ok) ┤
   │                                  │◄── results.tsv (row 0) ────┤
   │  watch ◄─────────────────────────│                              │
   │  render baseline                 │                              │
   │                                  │                    ┌─── loop ───┐
   │                                  │◄─ state.json ──────┤ agent run  │
   │                                  │◄─ stream.log ──────┤ streaming  │
   │  watch ◄─────────────────────────│                    │            │
   │  render agent text               │◄─ state.json ──────┤ measuring  │
   │                                  │◄─ results.tsv ─────┤ keep/disc  │
   │  watch ◄─────────────────────────│                    │            │
   │  render result row               │                    └────────────┘
   │                                  │                              │
   │  User presses 'q'               │                              │
   │  Confirmation: "Stop after       │                              │
   │   current experiment? (y/n)"     │                              │
   │  User presses 'y'               │                              │
   ├─ control.json {stop} ──────────►│                              │
   ├─ kill(pid, SIGTERM) ────────────────────────────────────────── ►│
   │                                  │                    read control.json
   │                                  │                    set stopRequested
   │                                  │                    finish experiment
   │                                  │◄── state.json (stopping) ───┤
   │                                  │◄── state.json (complete) ───┤
   │  watch ◄─────────────────────────│                    exit(0)   │
   │  show "Run Complete"             │                              │
   │  prompt: cleanup or abandon      │                              │
```

## Two-Root Path Model

The daemon operates across two root paths:

- **`mainRoot`**: The user's original checkout. Contains `.autoauto/` with all state, config, programs, and run data. The daemon reads config and program files from here. All persistent state (`state.json`, `results.tsv`, `events.ndjson`, `stream.log`) lives here.
- **`worktreePath`**: The AutoAuto-owned git worktree (`.autoauto/worktrees/<runId>/`). This is the experiment cwd — the agent edits code here, `measure.sh` runs with cwd here, git operations (revert, reset, log) happen here. `.autoauto/` does NOT exist in the worktree (gitignored), so the agent cannot touch state files.

Key paths:
- Program dir: `mainRoot/.autoauto/programs/<slug>/`
- Run dir: `mainRoot/.autoauto/programs/<slug>/runs/<runId>/`
- Measure script: `mainRoot/.autoauto/programs/<slug>/measure.sh` (executed with cwd=worktreePath)
- Worktree: `mainRoot/.autoauto/worktrees/<runId>/`

`runExperimentLoop` needs explicit params: `worktreePath`, `programDir`, `runDir` — no longer derived from a single `projectRoot`.

## Per-Run Config (run-config.json)

The TUI writes `run-config.json` to the run dir before spawning the daemon. This persists per-run overrides that the UI allows (model choice, effort level, max experiments) so they aren't lost when the daemon reads config independently.

```json
{
  "model": "sonnet",
  "effort": "high",
  "max_experiments": 50
}
```

The daemon reads this on startup and uses it instead of (or merged with) the default `.autoauto/config.json` values. This file is written once by the TUI and never modified.

Why not CLI args: model config is structured (model + effort per slot), and more overrides may be added later. A JSON file is cleaner than serializing through argv.

## startRun Split

### TUI side (before spawn)

1. Check working tree is clean (user's checkout)
2. Generate run ID
3. `git worktree add .autoauto/worktrees/<runId> -b autoauto-<slug>-<runId>` (from user's checkout)
4. Init run dir (`mainRoot/.autoauto/programs/<slug>/runs/<runId>/`)
5. Write `run-config.json` to run dir (model, effort, maxExperiments from UI)
6. Write lock file (`mainRoot/.autoauto/programs/<slug>/run.lock`)
7. Resolve absolute daemon entry path: `join(import.meta.dir, "../daemon.ts")` or equivalent — must work regardless of cwd. For installed CLI, resolve relative to the package installation, not the target repo.
8. `const proc = Bun.spawn(["bun", DAEMON_PATH, "--program", slug, "--run-id", runId, "--main-root", mainRoot, "--worktree", worktreePath], { detached: true, stdio: ["ignore", daemonLogFd, daemonLogFd] })`
9. Write `daemon.json` to run dir with `{run_id, pid: proc.pid, started_at, worktree_path}` — no `daemon_id` yet (PID available from spawn result)
10. `proc.unref()`
11. Switch to watch/poll mode

### Daemon side (after spawn)

1. Parse CLI args: `--program`, `--run-id`, `--main-root`, `--worktree`
2. Overwrite `daemon.json` with `daemon_id` (UUID) + `heartbeat_at`, start 10s heartbeat interval
3. Read `run-config.json` from run dir for model/effort/maxExperiments overrides
4. Crash recovery: if `state.json` exists, read it and detect in-flight phase (see Recovery section)
5. Read program config from `programDir/config.json`
6. **Write initial `state.json`** with `phase: "baseline"` and enough fields for recovery (run_id, program_slug, original_branch, worktree_path, started_at) — BEFORE running baseline
7. Lock measurement files (chmod 444 on measure.sh, build.sh, config.json in programDir)
8. Run baseline measurement (`measure.sh` from programDir, cwd = worktreePath)
9. Update `state.json` with baseline values + write baseline to `results.tsv` row 0
10. Build FileCallbacks, enter `runExperimentLoop()`
11. On complete: write final `state.json`, unlock measurement, remove `run.lock`, exit

## FileCallbacks (Daemon's LoopCallbacks Implementation)

Thin implementation — the loop already writes `state.json` (via `writeState()`) and `results.tsv` (via `appendResult()`) directly. The existing `createEventLogger()` wrapping in `experiment-loop.ts` handles `events.ndjson`. No double-logging.

FileCallbacks only handles:
- `onAgentStream(text)` → append to `stream.log`
- `onAgentToolUse(status)` → append formatted text to `stream.log`
- `onExperimentStart(num)` → truncate `stream.log` (reset per experiment)
- All other callbacks → no-op

## Stop vs Abort: Two Separate Mechanisms

The current loop (`experiment-loop.ts:391`) checks `options.signal?.aborted` and treats it as immediate abort. This conflates stop (graceful) and abort (hard kill). Phase 4 needs them separate.

### Loop interface change

```typescript
interface LoopOptions {
  maxExperiments?: number
  signal?: AbortSignal          // hard abort — kill agent, revert, exit
  stopRequested?: () => boolean // soft stop — checked at iteration boundary
}
```

The loop checks `stopRequested()` at the top of each iteration (where it currently checks `signal.aborted`). If true, it finishes the current experiment normally, then exits with `termination_reason: "stopped"`. The `signal` (AbortSignal) remains for hard abort — kill agent mid-execution, revert, crash row.

### Daemon signal handling

```
SIGTERM received
  → read control.json
  → if action === "stop":  set stopRequested flag (loop finishes current experiment)
  → if action === "abort": abortController.abort() (loop kills agent immediately)
  → if no control.json:    treat as stop (graceful default)
```

No fs.watch on control.json. No polling control.json. The daemon reads control.json **only when SIGTERM arrives** — SIGTERM is the notification, control.json is the payload.

### TUI side

- `q` → confirmation → write `control.json: {action: "stop"}` + `kill(pid, SIGTERM)`
- `Ctrl+C` → write `control.json: {action: "abort"}` + `kill(pid, SIGTERM)`
- Second `Ctrl+C` after 5s → `kill(pid, SIGKILL)` → crash recovery on next daemon start

## State Reconstruction (TUI Reconnection)

When the TUI opens a program with an active daemon, it reconstructs the full dashboard from files:

| React state | Source |
|---|---|
| `runState` | `state.json` |
| `results` | `results.tsv` (parse all rows) |
| `metricHistory` | Derived from `results.tsv` (keep-only metric values) |
| `agentStreamText` | `stream.log` (read tail, last ~6KB) |
| `experimentNumber` | `state.json` `.experiment_number` |
| `phase` | Derived from `state.json` `.phase` |
| `totalCostUsd` | `state.json` `.total_cost_usd` |
| `programConfig` | `programDir/config.json` |
| `toolStatus` | Not persisted (blank on reconnect, populates on next tool call) |
| `currentPhaseLabel` | Derived from `state.json` `.phase` (no detail string) |

### New fields on RunState / state.json

Add these to support reconnection and daemon mode:

- **`total_cost_usd: number`** — accumulated dollar cost (currently only `total_tokens` exists)
- **`termination_reason: "aborted" | "max_experiments" | "stopped" | null`** — written by daemon when loop ends
- **`original_branch: string`** — where the user was before the run started (needed for abandon/checkout-back)
- **`worktree_path: string`** — absolute path to the worktree (needed for cleanup and reconnect)
- **`error: string | null`** — error message on crash/failure
- **`error_phase: RunPhase | null`** — which phase the error occurred in (e.g. "baseline" vs "measuring")

### ExecutionScreen: Two Modes

ExecutionScreen needs to support both spawning a new run and attaching to an existing one:

```typescript
interface ExecutionScreenProps {
  cwd: string
  programSlug: string
  modelConfig: ModelSlot
  supportModelConfig: ModelSlot
  navigate: (screen: Screen) => void
  maxExperiments?: number
  // NEW: attach to existing run instead of starting new
  attachRunId?: string  // if set, attach to this run's daemon
}
```

- **Spawn mode** (`attachRunId` absent): TUI creates worktree, writes run-config, spawns daemon, then watches files.
- **Attach mode** (`attachRunId` set): TUI reads `daemon.json` to verify daemon is alive, reconstructs state from files, then watches. Same DaemonClient, just skips the spawn step.

### Home Screen Navigation

The RunsTable TODO at `src/components/RunsTable.tsx:176` ("Enter on a run row → resume monitoring / attach to live output") is resolved by navigating to ExecutionScreen with `attachRunId` set:

```typescript
onSelect={(run) => navigate("execution", { attachRunId: run.run_id, programSlug: run.state.program_slug })}
```

For completed runs, navigate to a read-only results view. For active runs (daemon alive), navigate to attach mode.

## IPC Files

All files live in the run dir (`mainRoot/.autoauto/programs/<slug>/runs/<runId>/`):

| File | Writer | Reader | Contract |
|---|---|---|---|
| `daemon.json` | TUI (initial with pid), daemon (overwrite with daemon_id + heartbeat) | TUI | Liveness detection + startup handshake |
| `run-config.json` | TUI (once, before spawn) | Daemon (once, on startup) | Per-run model/effort/maxExperiments overrides |
| `state.json` | Daemon (atomic tmp+rename) | TUI | Single source of truth for run state |
| `results.tsv` | Daemon (append-only) | TUI | Experiment outcomes, header + rows |
| `events.ndjson` | Daemon (append-only) | TUI (optional) | Structural audit trail |
| `stream.log` | Daemon (append, truncate on experiment start) | TUI | Raw agent streaming text |
| `control.json` | TUI | Daemon (read on SIGTERM only) | Stop/abort commands |
| `daemon.log` | Daemon (stderr/stdout redirect) | Debug only | Not surfaced in TUI for now |

## File Watching Strategy

Use `fs.watch` from `node:fs` on the **run directory** (not individual files) for near-instant change detection. This avoids the inode problem where atomic writes (temp-file + rename on `state.json`) cause per-file watchers to lose track on Linux/inotify. Watching the parent directory catches all writes regardless of rename semantics.

```ts
import { watch } from "fs";

const watcher = watch(runDir, (event, filename) => {
  if (filename === "state.json") readState();
  if (filename === "results.tsv") readResultsDelta();
  if (filename === "stream.log") readStreamDelta();
  if (filename === "daemon.json") checkHeartbeat();
});
```

Fall back to `setInterval` polling if the watcher errors (e.g. too many open watchers, unsupported FS).

**Delta reading:** For `results.tsv` and `stream.log`, track the last-read byte offset and only read new bytes. For `stream.log`, detect truncation: when file size shrinks (new experiment started), reset offset to 0.

**Heartbeat polling:** In addition to directory watcher events, run a 5-10s `setInterval` to check `daemon.json` heartbeat staleness + `kill(pid, 0)` for liveness. The watcher may miss heartbeat writes if the FS coalesces rapid events, so a backup timer ensures we detect daemon death.

## Crash Recovery

On daemon startup, read `state.json`. If phase indicates an in-flight operation:

| Phase found | Recovery |
|---|---|
| `baseline` | Baseline measurement was interrupted. No results to preserve. Clean up worktree to initial state, write `state.json` with `phase: "crashed"`, `error: "baseline interrupted"`, `error_phase: "baseline"`. Remove lock. Exit. |
| `agent_running` | Kill orphan processes (see Child Process Cleanup). Check if `candidate_sha` exists and differs from `last_known_good_sha` (agent committed). If committed: `git revert` in worktree. If not: `git reset --hard last_known_good_sha` in worktree. Log crash row to results.tsv. Resume loop or exit. |
| `measuring` | Kill measurement processes. Revert `candidate_sha` if committed. Log crash row. Resume loop or exit. |
| `reverting` | Revert was incomplete. `git reset --hard last_known_good_sha` in worktree. Log crash row if not already logged. |
| `idle` / `kept` / `stopping` | Clean state. Resume loop or exit based on stop mode. |
| `complete` / `crashed` | Already terminal. No recovery needed. |

**Critical invariant:** `git reset --hard` is ONLY used inside the AutoAuto-owned worktree. Never the user's main checkout. The `worktree_path` field in `state.json` confirms we're operating in the right directory.

`last_known_good_sha` and `candidate_sha` in RunState provide exact recovery targets — no git history inference needed.

## Child Process Cleanup

Current code only kills the direct child process (`proc.kill("SIGTERM")` in `measure.ts:56`, `abortController.abort()` in `claude-provider.ts:121`). This may leave orphan subprocesses (measurement scripts spawning servers, SDK tool subprocesses).

### Required changes

1. **Measurement processes** (`src/lib/measure.ts`): Spawn with `detached: true` to create a new process group. On abort/timeout, kill the process group with `process.kill(-proc.pid, "SIGTERM")` instead of `proc.kill("SIGTERM")`. This kills the measurement script AND any child processes it spawned (servers, browsers, etc.).

2. **Agent SDK sessions** (`src/lib/agent/claude-provider.ts`): The SDK's `abortController.abort()` at line 121 signals the SDK to stop, but tool subprocesses (bash commands, etc.) may not terminate. After calling `abort()`, the daemon should also check for and kill any remaining child processes in the worktree's process group.

3. **Daemon-level cleanup**: On SIGTERM/abort, the daemon:
   - Calls `abortController.abort()` (signals SDK and loop)
   - Waits up to 3s for graceful shutdown
   - Kills process group of any remaining child PIDs
   - Then proceeds with git revert/reset

4. **Process tracking**: The daemon maintains a set of child PIDs (measurement procs, agent session procs). On crash recovery, it reads `daemon.json` for the last known PID set and kills any still-alive processes before git cleanup.

## Locking

Per-program lock: `.autoauto/programs/<slug>/run.lock`

```json
{
  "run_id": "20260407-143022",
  "daemon_id": "a1b2c3d4-...",
  "pid": 12345,
  "worktree_path": ".autoauto/worktrees/20260407-143022",
  "created_at": "2026-04-07T14:30:22Z"
}
```

- Write with `O_EXCL` (exclusive create) or atomic `mkdir`
- One active run per program. Multiple programs can run concurrently (separate locks, separate worktrees)

### Stale lock detection (PID reuse safe)

Simple PID + heartbeat check can wedge on PID reuse: if an unrelated process reuses the PID, `kill(pid, 0)` succeeds even though the daemon is dead, and the lock never clears.

Fix: cross-check `daemon_id` between `run.lock` and `daemon.json`:

```
if lock file exists:
  read lock → get daemon_id, pid
  read daemon.json from lock's run dir → get daemon_id, heartbeat_at
  
  if daemon.json doesn't exist → lock is stale (daemon never started)
  if daemon_id in lock ≠ daemon_id in daemon.json → lock is stale (leftover from different run)
  if heartbeat_at > 30s stale AND kill(pid, 0) fails → lock is stale (daemon dead)
  if heartbeat_at > 30s stale AND kill(pid, 0) succeeds → PID reused by unrelated process → lock is stale
  
  stale → delete lock, proceed
  not stale → refuse, daemon is running
```

The key insight: if `daemon_id` matches AND heartbeat is fresh, the daemon is genuinely alive. If heartbeat is stale, the daemon is dead regardless of what `kill(pid, 0)` says — because a live daemon always writes heartbeats. The PID check is only a fast-path hint, not the authority.

## Worktree Lifecycle

- **Created by TUI** before daemon spawn: `git worktree add .autoauto/worktrees/<runId> -b autoauto-<slug>-<runId>`
- **After cleanup:** Keep worktree. Squashed commit lives on the experiment branch in the worktree. User merges manually.
- **After abandon:** Confirm with user, then `git worktree remove .autoauto/worktrees/<runId>`.
- **Stale/crashed:** Left in place. Future `autoauto prune` can clean up.

## Cleanup

Runs **in-process in the TUI** (not in daemon). The daemon exits after the loop completes.

### Path handling

Current `runCleanup()` (`src/lib/cleanup.ts:254`) takes `projectRoot` and uses it as the git/agent cwd. In daemon mode, cleanup must use the worktree as cwd (the experiment branch is checked out there), while reading state files from mainRoot.

Changes to `runCleanup()`:
- Add `worktreePath` parameter (read from `state.json` `.worktree_path`)
- Use `worktreePath` as cwd for git operations and agent session
- Keep `runDir` pointing to mainRoot for state files (results.tsv, summary.md, events.ndjson)

### Flow

1. Daemon finishes loop, writes `state.json` with `phase: "complete"`, removes `run.lock`, exits
2. TUI polls, sees `phase: "complete"`, shows RunCompletePrompt
3. User chooses cleanup or abandon
4. **Cleanup:** TUI reads `worktree_path` from `state.json`. Spawns cleanup agent in-process with `cwd = worktreePath`. Agent reviews diff, generates summary, squashes commits in worktree. Writes `summary.md` to run dir (in mainRoot).
5. **Abandon:** Confirm with user → `git worktree remove <worktreePath>`

## Heartbeat

- Daemon writes `heartbeat_at` to `daemon.json` every **10 seconds**
- TUI considers daemon dead if heartbeat > **30s** stale (regardless of PID check — see Stale Lock section)
- Both daemon_id match AND fresh heartbeat required to confirm daemon is alive

## Daemon Startup Handshake

1. TUI spawns daemon, gets PID from `Bun.spawn()` result
2. TUI writes `daemon.json`: `{run_id, pid: proc.pid, started_at, worktree_path}` — no `daemon_id`
3. Daemon overwrites with full `daemon.json`: adds `daemon_id` (UUID) + `heartbeat_at`
4. TUI detects daemon state:
   - Has `pid` but no `daemon_id` → "Daemon starting..."
   - Has `daemon_id` + fresh heartbeat → daemon alive and running
   - Has `pid` but no `daemon_id` after ~10s, and `kill(pid, 0)` throws → spawn failed, check daemon.log

## New Files

```
src/
  daemon.ts                # Daemon entry point: parse args, recovery, loop, exit
  lib/
    daemon-callbacks.ts    # FileCallbacks implements LoopCallbacks (stream.log writes)
    daemon-lifecycle.ts    # Heartbeat, signal handlers, crash recovery, lock management
    worktree.ts            # Git worktree create/remove
    daemon-client.ts       # TUI-side: spawn daemon, watch files, send control, reconnect
```

## Changes to Existing Code

### RunState (`src/lib/run.ts`)

Add fields: `total_cost_usd`, `termination_reason`, `original_branch`, `worktree_path`, `error`, `error_phase`.

### `runExperimentLoop` (`src/lib/experiment-loop.ts`)

- Accept explicit `worktreePath`, `programDir`, `runDir` params instead of deriving from single `projectRoot`
- Add `stopRequested?: () => boolean` to `LoopOptions` (soft stop, checked at iteration boundary)
- Keep `signal` for hard abort only
- Propagate `worktreePath` to all helpers that need experiment cwd

### Root split propagation

The two-root split affects more than just `runExperimentLoop`'s signature. All these functions currently take a single `projectRoot` and need the split:

| Function | File | Needs `worktreePath` (git/agent cwd) | Needs `programDir` (config/scripts) | Needs `runDir` (state files) |
|---|---|---|---|---|
| `runExperimentLoop` | experiment-loop.ts | Yes (pass to agent, git ops) | Yes (measurement snapshot) | Yes (state, results) |
| `buildContextPacket` | experiment.ts | Yes (git log, diffs) | Yes (program.md) | Yes (results.tsv) |
| `runExperimentAgent` | experiment.ts | Yes (agent cwd) | No | No |
| `runMeasurementSeries` | measure.ts | Yes (measure.sh cwd) | Yes (measure.sh path) | No |
| `runMeasurement` | measure.ts | Yes (cwd) | Yes (script path) | No |
| `readMeasurementSnapshot` | experiment-loop.ts | No | Yes (file paths) | No |
| `getMeasurementViolations` | experiment-loop.ts | No | Yes (file paths) | No |
| `revertToStart` | experiment-loop.ts | Yes (git ops) | No | No |
| `revertAndVerify` | experiment-loop.ts | Yes (git ops) | No | No |
| `maybeRebaseline` | experiment-loop.ts | Yes (measure cwd) | Yes (measure.sh path) | Yes (state) |
| `getFullSha` | git.ts | Yes (cwd) | No | No |
| `revertCommits` | git.ts | Yes (cwd) | No | No |
| `resetHard` | git.ts | Yes (cwd) | No | No |
| `getRecentLog` | git.ts | Yes (cwd) | No | No |
| `getFilesChangedBetween` | git.ts | Yes (cwd) | No | No |
| `squashCommits` | git.ts | Yes (cwd) | No | No |

### `startRun` (`src/lib/run.ts`)

Split into:
- `prepareRun(mainRoot, programSlug, modelConfig, maxExperiments)` — TUI-side: clean check, worktree, run dir, run-config.json, lock, spawn daemon
- Remove in-process baseline measurement from TUI-side

### `runCleanup` (`src/lib/cleanup.ts`)

Add `worktreePath` parameter. Use it as git/agent cwd instead of `projectRoot`. Keep `runDir` for state file writes (summary.md, events.ndjson).

### ExecutionScreen (`src/screens/ExecutionScreen.tsx`)

- Add `attachRunId` prop for reconnect mode
- Replace in-process loop + callbacks with DaemonClient (spawn/attach + fs.watch)
- Cleanup remains in-process (reads `worktree_path` from state.json)

### Measurement (`src/lib/measure.ts`)

- Accept separate `measureShPath` and `cwd` params (currently derives both from projectRoot)
- Spawn measurement with `detached: true` for process group cleanup
- Kill via `process.kill(-proc.pid, "SIGTERM")` instead of `proc.kill("SIGTERM")`

### HomeScreen / RunsTable

- Make run rows selectable (Enter key)
- Active runs → navigate to ExecutionScreen with `attachRunId`
- Completed runs → navigate to read-only results view
