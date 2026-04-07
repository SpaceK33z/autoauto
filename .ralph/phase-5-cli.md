# Phase 5: CLI Subcommands

Headless CLI interface for controlling AutoAuto from Claude Code (or any terminal). The CLI is a peer to the TUI — both can spawn daemons, read state, and send control signals.

## Design Decisions

- **Same binary, subcommand routing** — `autoauto` with no args launches TUI. `autoauto <command>` runs headless CLI.
- **TUI code isolated via dynamic import** — Current `src/index.tsx` has top-level static imports of `@opentui/core`, `@opentui/react`, and `App`. Static imports are hoisted, so argv checking in the same file won't prevent them from loading. Solution: move TUI boot to `src/tui.tsx`, make `src/index.tsx` a thin router that dynamic-imports either `./cli.ts` or `./tui.tsx` based on argv.
- **CLI imports from `src/lib/` only** — daemon-client, run, programs, config. Never touches OpenTUI or React.
- **Human-readable output by default, `--json` flag on every command** for structured/machine-parseable output.
- **Run-scoped read commands default to the latest run** for the given program. `--run <id>` overrides. `stop` uses `findActiveRun()` (lock-based) since it targets the live daemon, not historical runs.
- **Setup deferred** — CLI v1 is operational commands only (start, status, results, stop, list, limit). Program setup stays in the TUI.
- **Metric values displayed as raw numbers + field name** — config stores `metric_field` and `direction` but not units. Output uses field name as label (e.g. `latency_ms: 42.5`), not synthetic units.
- **No changes to `src/lib/`** — CLI consumes existing library functions as-is.

## Global Flags

- `--json` — Structured JSON output on every command.
- `--cwd <path>` — Override working directory (useful when Claude Code's shell cwd differs from target repo). Defaults to `process.cwd()`.

## Commands

### `autoauto list`

List all programs with their current status.

**Output (human-readable):**
```
Program          Status     Last Run        Best (latency_ms)
homepage-lcp     running    20260407-143022  389 (-13.9%)
api-latency      idle       20260405-091500  42 (-8.2%)
bundle-size      idle       —               —
```

- Enumerates `.autoauto/programs/*/`
- For each program: check for latest run, read `state.json`
- `running` = live daemon (heartbeat check via `daemon.json`). `idle` = no active run.
- Programs with no runs show dashes for last run and metric.
- Metric column header uses `metric_field` from program config.

**JSON output:** Array of objects with `slug`, `status`, `last_run_id`, `best_metric`, `best_metric_change`, `metric_field`, `direction`, `goal` (from program.md).

### `autoauto start <program-slug>`

Spawn a daemon and block until baseline measurement completes.

**Flags:**
- `--no-wait` — Fire and forget. Print run ID and exit immediately.
- `--model <model>` — Override execution model (default from `.autoauto/config.json`)
- `--effort <level>` — Override effort level (default from config)
- `--max-experiments <n>` — Set experiment cap (default from program `config.json` `max_experiments` field, same as TUI pre-run screen)
- `--no-ideas-backlog` / `--ideas-backlog` — Override ideas backlog setting (default from project config `ideasBacklogEnabled`)

**Behavior:**
1. Validate program exists, call `loadProgramConfig(programDir)`
2. Check working tree is clean (same as TUI)
3. Call `spawnDaemon()` from `daemon-client.ts`
4. Unless `--no-wait`: poll/watch `state.json` until phase leaves `baseline`, then print baseline result
5. Print actionable next steps on exit

**Output (human-readable, after baseline):**
```
Started run 20260407-143022 for homepage-lcp
Baseline latency_ms: 452 (3 measurements)

Run is now executing experiments in the background.

Next steps:
  autoauto status homepage-lcp    # Check current progress
  autoauto results homepage-lcp   # View experiment results table
  autoauto stop homepage-lcp      # Stop after current experiment
```

**Output (`--no-wait`):**
```
Started run 20260407-143022 for homepage-lcp
Daemon PID: 12345

The daemon is running baseline measurement in the background.

Next steps:
  autoauto status homepage-lcp    # Check progress (baseline first, then experiments)
  autoauto results homepage-lcp   # View experiment results table
  autoauto stop homepage-lcp      # Stop after current experiment
```

**Error cases:**
- Program not found → exit 1 with message
- Working tree dirty → exit 1 with message
- Program already has active run (lock held) → exit 1 with message
- Baseline measurement fails → exit 2 with error from daemon

**JSON output:** `{ run_id, daemon_pid, baseline_metric?, status }`.

### `autoauto status <program-slug>`

Show current run state.

**Flags:**
- `--run <id>` — Target a specific run instead of latest
- `--all` — List all runs for this program with summary info

**Output (human-readable):**
```
Program: homepage-lcp (latency_ms, lower is better)
Run: 20260407-143022
Status: running (experiment #7)
Baseline: 452 → Current best: 389 (-13.9%)
Keeps: 4 | Discards: 2 | Crashes: 0
Cost: $1.23 | Elapsed: 34m
```

For completed runs:
```
Program: homepage-lcp (latency_ms, lower is better)
Run: 20260407-143022
Status: complete (stopped after 12 experiments)
Baseline: 452 → Final best: 389 (-13.9%)
Keeps: 4 | Discards: 7 | Crashes: 1
Cost: $3.45 | Duration: 1h 12m
```

**Output (`--all`):**
```
Run              Status     Experiments  Best (latency_ms)
20260407-143022  complete   12           389 (-13.9%)
20260405-091500  complete   8            412 (-5.1%)
20260401-200000  complete   3            434 (-0.2%)
```

**Error cases:**
- Program not found → exit 1
- No runs exist → exit 1 with "No runs found for <slug>. Start one with: autoauto start <slug>"

**JSON output:** Full `RunState` object from `state.json` plus computed fields (elapsed, metric change percentage, daemon alive status). With `--all`: array of run summaries.

### `autoauto results <program-slug>`

Show experiment results table.

**Flags:**
- `--run <id>` — Target a specific run
- `--detail <n>` — Dump full agent stream log for experiment N (from `stream-<NNN>.log`). Supports `--detail latest` for the most recent experiment.
- `--limit <n>` — Show only the last N results (useful for long runs)

**Output (human-readable, default):**

Change column is always relative to the original baseline, direction-aware.

```
#   Status   latency_ms   Change   Commit   Description
0   keep     452          —        abc1234  baseline
1   keep     441          -2.4%    def5678  tree-shake unused icons
2   discard  455          +0.7%    ghi9012  lazy-load sidebar
3   keep     429          -5.1%    jkl3456  split vendor chunk
4   discard  430          -4.9%    mno7890  inline critical CSS
5   keep     402          -11.1%   pqr2345  code-split dashboard route
6   keep     389          -13.9%   stu6789  remove unused lodash imports
```

**Output (`--detail <n>`):** Raw contents of `stream-<NNN>.log` dumped to stdout. Claude Code can read and summarize this itself.

**Error cases:**
- No result rows yet (header-only results.tsv) → exit 1 with "No result rows yet. Run may still be in baseline phase."
- `--detail <n>` for nonexistent experiment → exit 1

**JSON output (default):** Array of `ExperimentResult` objects from results.tsv with computed `change_pct` field (vs original baseline). **JSON output (`--detail <n>`):** `{ experiment_number, status, metric_value, change_pct, description, log: "<full stream log contents>" }`.

### `autoauto stop <program-slug>`

Stop the active run. Uses `findActiveRun()` (lock-based) to locate the running daemon, not "latest run" semantics.

**Flags:**
- `--abort` — Immediate kill (don't wait for current experiment to finish)
- `--run <id>` — Target a specific run (overrides lock-based lookup)

**Behavior (soft stop, default):**
1. Call `findActiveRun(programDir)` to locate live daemon
2. Call `sendStop(runDir)` — writes `control.json` with `action: "stop"`, sends SIGTERM
3. Print confirmation and expected behavior

**Output:**
```
Stopping homepage-lcp run 20260407-143022...
The current experiment (#7) will finish, then the run will stop.
Use `autoauto status homepage-lcp` to check when it's done.
```

**Behavior (`--abort`):**
1. Call `findActiveRun(programDir)` to locate live daemon
2. Call `sendAbort(runDir)` — writes `control.json` with `action: "abort"`, sends SIGTERM
3. Wait briefly for daemon to exit. If still alive after timeout, call `forceKillDaemon(runDir)`.

**Output:**
```
Aborting homepage-lcp run 20260407-143022...
Run aborted. Current experiment recorded as crash.
```

Note: aborted experiments are recorded with `status: "crash"` and `description: "aborted by user"` in results.tsv, matching the existing daemon behavior.

**Error cases:**
- No active run → exit 1 with "No active run for <slug>."
- Daemon already dead → exit 1 with "Daemon is not running. Run may have already completed."

**JSON output:** `{ action, run_id, status }`.

### `autoauto limit <program-slug> <n|none>`

Update the max experiments cap on a running daemon. Uses existing `updateMaxExperiments()`.

**Behavior:**
1. Call `findActiveRun(programDir)` to locate live daemon
2. Call `updateMaxExperiments(runDir, n)` (or `undefined` for `none`)
3. Print confirmation

**Output:**
```
Updated homepage-lcp run 20260407-143022: max experiments set to 50.
```
```
Updated homepage-lcp run 20260407-143022: experiment cap removed.
```

**Error cases:**
- No active run → exit 1
- Invalid value → exit 1

**JSON output:** `{ run_id, max_experiments }`.

## Exit Codes

- `0` — success
- `1` — user error (program not found, no active run, dirty tree, invalid args)
- `2` — daemon/runtime error (baseline failed, daemon crashed, etc.)

## Implementation Plan

### 1. Extract TUI to `src/tui.tsx`

Move the current contents of `src/index.tsx` (OpenTUI/React imports, renderer creation, `<App />` render) to `src/tui.tsx`.

### 2. Rewrite `src/index.tsx` as thin router

```typescript
#!/usr/bin/env bun
const subcommand = process.argv[2]

if (subcommand && ["list", "start", "status", "results", "stop", "limit"].includes(subcommand)) {
  const { run } = await import("./cli.ts")
  await run(process.argv.slice(2))
} else {
  await import("./tui.tsx")
}
```

Dynamic imports ensure TUI deps are never loaded for CLI paths and CLI deps are never loaded for TUI paths.

### 3. CLI implementation (`src/cli.ts`)

New file. Parses argv for subcommands and flags. Each command is a standalone async function. Imports only from `src/lib/`:
- `loadProgramConfig()`, `listPrograms()`, `getProgramDir()` from `src/lib/programs.ts`
- `spawnDaemon()`, `getDaemonStatus()`, `sendStop()`, `sendAbort()`, `forceKillDaemon()`, `findActiveRun()`, `updateMaxExperiments()`, `reconstructState()` from `src/lib/daemon-client.ts`
- `getLatestRun()`, `listRuns()`, `readAllResults()`, `readState()` from `src/lib/run.ts`
- `loadProjectConfig()` from `src/lib/config.ts`

### 4. Output formatting

- Human-readable: simple aligned text tables and key-value output via `process.stdout.write()`.
- JSON: `JSON.stringify(data, null, 2)` to stdout.
- All commands check for `--json` flag before formatting.

## Files to Create/Modify

- **Create:** `src/cli.ts` — CLI entrypoint and command implementations
- **Create:** `src/tui.tsx` — Extracted TUI boot (moved from index.tsx)
- **Modify:** `src/index.tsx` — Thin argv router with dynamic imports

No changes to `src/lib/`.

## Future Considerations (not v1)

- `autoauto setup <slug>` — Headless program setup (requires packaging system-prompt knowledge)
- `autoauto cleanup <slug> --run <id>` — Post-run cleanup/squash flow (currently TUI-only via RunCompletePrompt)
- `status --watch` / `results --watch` — Continuous monitoring with live updates
