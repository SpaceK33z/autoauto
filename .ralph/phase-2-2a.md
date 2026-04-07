# Phase 2a: Branch & Baseline — Implementation Plan

## Overview

Phase 2a establishes the foundation for the experiment loop: creating a dedicated branch, measuring the baseline metric, persisting state, and locking the evaluator. This is the "run setup" phase — everything between "user clicks Start Run" and "experiment loop begins."

No TUI changes in this phase. All work is in `src/lib/` as pure functions/utilities that phase 2b-2f will consume.

---

## Files to Create

### 1. `src/lib/run.ts` — Run lifecycle: branch, baseline, state, locking

The core orchestrator utilities. All functions are async, operate on the filesystem, and are independent of the TUI.

#### Types

```typescript
/** Status values for results.tsv rows */
type ExperimentStatus = "keep" | "discard" | "measurement_failure" | "crash"

/** Phases the daemon/orchestrator can be in (from IDEA.md) */
type RunPhase =
  | "idle"
  | "baseline"
  | "agent_running"
  | "measuring"
  | "reverting"
  | "kept"
  | "stopping"
  | "complete"
  | "crashed"

/** Persisted run state — the checkpoint file */
interface RunState {
  run_id: string                    // timestamp-based: "20260407-143022"
  program_slug: string
  phase: RunPhase
  experiment_number: number         // current experiment (0 = baseline)
  original_baseline: number         // metric value at run start (never changes)
  current_baseline: number          // metric value to beat (updates after keeps)
  best_metric: number               // best metric achieved across all experiments
  best_experiment: number           // experiment # that achieved best_metric
  total_keeps: number
  total_discards: number
  total_crashes: number
  branch_name: string               // "autoauto-<slug>-<timestamp>"
  last_known_good_sha: string       // HEAD after last keep or baseline
  candidate_sha: string | null      // HEAD after agent commits (before measurement)
  started_at: string                // ISO timestamp
  updated_at: string                // ISO timestamp
}

/** A single row in results.tsv */
interface ExperimentResult {
  experiment_number: number
  commit: string                    // short SHA (7 chars)
  metric_value: number              // primary metric (0 for crashes)
  secondary_values: string          // JSON string of quality gate values, or ""
  status: ExperimentStatus
  description: string               // from agent commit message or error reason
}

/** Loaded program configuration (from .autoauto/programs/<slug>/config.json) */
interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
}

interface QualityGate {
  min?: number
  max?: number
}
```

**Note:** `ProgramConfig` and `QualityGate` duplicate the interfaces in `validate-measurement.ts`. Extract them to a shared location (see step 5 below).

#### Functions

##### `generateRunId(): string`
Returns a timestamp string like `"20260407-143022"`. Used for run directory names and branch names.
```typescript
// Format: YYYYMMDD-HHMMSS
const now = new Date()
const pad = (n: number) => String(n).padStart(2, "0")
return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
```

##### `createExperimentBranch(projectRoot: string, programSlug: string, runId: string): Promise<string>`
Creates a dedicated git branch from current HEAD for the experiment run.

Implementation:
1. Branch name: `autoauto-${programSlug}-${runId}` (e.g. `autoauto-homepage-lcp-20260407-143022`)
2. Run: `git checkout -b <branch_name>` via `execFileAsync("git", ["checkout", "-b", branchName], { cwd: projectRoot })`
3. Return the branch name

**Important:** For MVP (Phase 2a), we create the branch in the main checkout — no worktree yet. Phase 4 (daemon) adds worktree isolation. The IDEA.md says "one run at a time per project (MVP)" so this is safe.

**Edge case:** If the branch already exists (e.g. interrupted previous run), the `git checkout -b` will fail. Catch the error and throw a descriptive message: "Branch already exists — was a previous run interrupted? Delete it with `git branch -D <name>` to proceed."

##### `loadProgramConfig(programDir: string): Promise<ProgramConfig>`
Reads and validates `config.json` from the program directory.

Implementation:
1. `readFile(join(programDir, "config.json"), "utf-8")`
2. `JSON.parse(raw)` and validate required fields exist
3. Validate `metric_field` is a non-empty string
4. Validate `direction` is `"lower"` or `"higher"`
5. Validate `noise_threshold` is a finite positive number
6. Validate `repeats` is an integer >= 1
7. Validate `quality_gates` is an object with valid gate entries
8. Return typed `ProgramConfig`
9. Throw descriptive errors for any validation failure

##### `lockEvaluator(programDir: string): Promise<void>`
Makes `measure.sh` and `config.json` read-only (chmod 444).

Implementation:
```typescript
import { chmod } from "node:fs/promises"
await chmod(join(programDir, "measure.sh"), 0o444)
await chmod(join(programDir, "config.json"), 0o444)
```

This is the **#1 safeguard** against metric gaming (see `docs/failure-patterns.md` P0).

##### `unlockEvaluator(programDir: string): Promise<void>`
Restores write permissions (chmod 644) — called on run completion/cleanup.

Implementation:
```typescript
await chmod(join(programDir, "measure.sh"), 0o644)
await chmod(join(programDir, "config.json"), 0o644)
```

##### `initRunDir(programDir: string, runId: string): Promise<string>`
Creates the run directory structure and initializes files.

Implementation:
1. Create dir: `mkdir(join(programDir, "runs", runId), { recursive: true })`
2. Initialize `results.tsv` with header row:
   ```
   experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\n
   ```
3. Initialize `state.json` with default `RunState` (phase: `"baseline"`, experiment_number: 0)
4. Return the run directory path

##### `writeState(runDir: string, state: RunState): Promise<void>`
Atomically writes `state.json` via temp-file + rename.

Implementation:
```typescript
const tmpPath = join(runDir, "state.json.tmp")
await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n")
await rename(tmpPath, join(runDir, "state.json"))
```

Atomic rename prevents partial reads if the TUI reads state mid-write. This is the pattern from IDEA.md's daemon IPC section: "Daemon atomically rewrites state.json via temp-file + rename."

##### `readState(runDir: string): Promise<RunState>`
Reads and parses `state.json`.

##### `appendResult(runDir: string, result: ExperimentResult): Promise<void>`
Appends a single row to `results.tsv`.

Implementation:
```typescript
const secondaryStr = result.secondary_values || ""
const line = `${result.experiment_number}\t${result.commit}\t${result.metric_value}\t${secondaryStr}\t${result.status}\t${result.description}\n`
await appendFile(join(runDir, "results.tsv"), line)
```

Use `appendFile` (not read+write) — this is the durable append-only log pattern from IDEA.md.

---

### 2. `src/lib/measure.ts` — Measurement execution and parsing

Handles running `measure.sh`, parsing JSON output, validating against config, computing medians, and making keep/discard decisions.

#### Functions

##### `runMeasurement(measureShPath: string, projectRoot: string, timeoutMs?: number): Promise<MeasurementResult>`
Runs measure.sh once and returns parsed output.

[CHANGED] Implementation:
1. Spawn: `Bun.spawn(["bash", measureShPath], { cwd: projectRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env }, timeout: timeoutMs ?? 60_000 })`
2. Collect stdout via `new Response(proc.stdout).text()` and stderr via `new Response(proc.stderr).text()`
3. On non-zero exit → return `{ success: false, error: "exit code N: stderr..." }`
4. Parse JSON from stdout
5. Return `{ success: true, output: parsed, duration_ms }`

**Use `Bun.spawn` (not `execFileAsync`)** for measure.sh execution — this matches the pattern established in `validate-measurement.ts` after the 1d review, which uses `Bun.spawn` with the native `timeout` option for automatic process cleanup. Git commands in `git.ts` use `execFileAsync` because they're short-lived and don't need timeout handling. **Document this split:** `Bun.spawn` for long-running measurement scripts (needs timeout + streaming), `execFileAsync` for quick git commands.

**Reuse the same pattern from `validate-measurement.ts`.** The existing `runMeasurement()` function in that file is almost exactly what we need. However, since `validate-measurement.ts` is a standalone script, we need to extract this into an importable module.

Type:
```typescript
type MeasurementResult =
  | { success: true; output: Record<string, unknown>; duration_ms: number }
  | { success: false; error: string; duration_ms: number }
```

##### `validateMeasurementOutput(output: Record<string, unknown>, config: ProgramConfig): { valid: boolean; errors: string[] }`
Validates a measurement output against config.

Implementation: Same logic as `validateOutput()` in `validate-measurement.ts` lines 162-185. Check:
- `metric_field` exists and is a finite number
- Every quality gate field exists and is a finite number

##### `checkQualityGates(output: Record<string, unknown>, config: ProgramConfig): { passed: boolean; violations: string[] }`
Checks quality gate thresholds (separate from field existence validation).

Implementation:
```typescript
for (const [field, gate] of Object.entries(config.quality_gates)) {
  const value = output[field] as number
  if (gate.max !== undefined && value > gate.max) {
    violations.push(`${field}=${value} exceeds max ${gate.max}`)
  }
  if (gate.min !== undefined && value < gate.min) {
    violations.push(`${field}=${value} below min ${gate.min}`)
  }
}
```

##### `runMeasurementSeries(measureShPath: string, projectRoot: string, config: ProgramConfig): Promise<MeasurementSeriesResult>`
Runs measure.sh N times (config.repeats), computes median, validates all outputs.

Implementation:
1. Loop `config.repeats` times, call `runMeasurement()` sequentially
2. For each run:
   - If measurement fails (non-zero exit, timeout) → record as crash
   - If JSON invalid or fields missing/non-finite → record as measurement_failure
   - If valid → collect metric value and quality gate values
[CHANGED] 3. If fewer than `ceil(config.repeats / 2)` valid measurements → return failure (e.g., need 3 of 5 runs to succeed). A single valid run is not enough — the median of one value has no variance information.
4. Compute median of primary metric values
5. Compute median of each quality gate field
6. Check quality gates against median values
7. Return aggregated result

Type:
```typescript
interface MeasurementSeriesResult {
  success: boolean
  median_metric: number
  median_quality_gates: Record<string, number>  // field → median value
  quality_gates_passed: boolean
  gate_violations: string[]
  individual_runs: MeasurementResult[]
  duration_ms: number  // total wall time
}
```

Median calculation: reuse the same logic as `validate-measurement.ts` lines 194-216 (`computeStats`). Extract the median computation into a small helper:
```typescript
function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b)
  const n = sorted.length
  return n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)]
}
```

##### `compareMetric(baseline: number, measured: number, noiseThreshold: number, direction: "lower" | "higher"): "improved" | "regressed" | "noise"`
Compares measured metric against baseline using noise threshold.

Implementation (from modulaser `compare_metric` lines 646-674):
```typescript
// Calculate relative change as a fraction (not percentage)
const relativeChange = direction === "lower"
  ? (baseline - measured) / baseline    // positive = improvement for "lower"
  : (measured - baseline) / baseline    // positive = improvement for "higher"

if (relativeChange > noiseThreshold) return "improved"
if (relativeChange < -noiseThreshold) return "regressed"
return "noise"
```

**Note:** `noiseThreshold` in config is already a decimal fraction (e.g. 0.02 for 2%), matching the relative change calculation. No percentage conversion needed.

---

### 3. `src/lib/git.ts` — Git operations for the orchestrator

Thin wrappers around git commands used by the experiment loop.

#### Functions

##### `getCurrentSha(cwd: string): Promise<string>`
Returns short (7-char) SHA of HEAD.
```typescript
const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })
return stdout.trim()
```

##### `getFullSha(cwd: string): Promise<string>`
Returns full SHA of HEAD (for state.json).
```typescript
const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
return stdout.trim()
```

##### `getRecentLog(cwd: string, count?: number): Promise<string>`
Returns recent git log for context packet.
```typescript
const { stdout } = await execFileAsync("git", [
  "log", "--oneline", "--decorate", `-n`, String(count ?? 10)
], { cwd })
return stdout.trim()
```

##### `revertCommits(cwd: string, fromSha: string, toSha: string): Promise<boolean>`
Reverts all commits between fromSha (exclusive) and toSha (inclusive). Returns true if successful.

Implementation (from modulaser `revert_experiment_commits` lines 497-516):
```typescript
// Collect commits in range
const { stdout } = await execFileAsync("git", ["rev-list", `${fromSha}..${toSha}`], { cwd })
const commits = stdout.trim().split("\n").filter(Boolean)

if (commits.length === 0) return true

try {
  // Revert all commits (creates new revert commits, preserving history)
  await execFileAsync("git", ["revert", "--no-edit", ...commits], { cwd })
  return true
} catch {
  // Conflict during revert — abort and fall back to reset
  try { await execFileAsync("git", ["revert", "--abort"], { cwd }) } catch { /* ignore */ }
  return false
}
```

**Why `git revert` not `git reset`:** Preserves history so the experiment agent can inspect discarded approaches with `git show`. This is a key learning mechanism (see `docs/orchestration-patterns.md` — "Git history as implicit memory").

##### `resetHard(cwd: string, sha: string): Promise<void>`
Fallback if revert fails (conflict). Only used when revert is impossible.
```typescript
await execFileAsync("git", ["reset", "--hard", sha], { cwd })
```

##### `getLatestCommitMessage(cwd: string): Promise<string>`
Gets the subject line of HEAD commit (for results.tsv description).
```typescript
const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd })
return stdout.trim()
```

##### `getCommitDiff(cwd: string, sha: string): Promise<string>`
Gets the diff of a specific commit (for context packet — discarded diffs).
```typescript
const { stdout } = await execFileAsync("git", ["show", "--stat", sha], { cwd })
return stdout.trim()
```

##### `branchExists(cwd: string, branchName: string): Promise<boolean>`
Checks if a branch name already exists.
```typescript
try {
  await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd })
  return true
} catch {
  return false
}
```

---

## Files to Modify

### 4. `src/lib/programs.ts` — Add shared types and program directory helper

#### Add `getProgramDir()` function
Referenced in `docs/architecture.md` but not yet implemented.

```typescript
/** Returns the absolute path to a specific program's directory */
export function getProgramDir(cwd: string, slug: string): string {
  return join(cwd, AUTOAUTO_DIR, "programs", slug)
}
```

#### Add `getRunDir()` helper
```typescript
/** Returns the absolute path to a specific run's directory */
export function getRunDir(cwd: string, slug: string, runId: string): string {
  return join(cwd, AUTOAUTO_DIR, "programs", slug, "runs", runId)
}
```

#### Export shared types
Move `ProgramConfig` and `QualityGate` from `validate-measurement.ts` into `programs.ts` as exported interfaces so they can be shared between the validation script and the new run/measure modules.

```typescript
export interface QualityGate {
  min?: number
  max?: number
}

export interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
}
```

#### Update `Screen` type
Add the execution screen to the union:
```typescript
export type Screen = "home" | "setup" | "settings" | "program-detail" | "execution"
```

Phase 2a only adds the types; the actual screens are built in phase 2f.

---

### 5. `src/lib/validate-measurement.ts` — Refactor to use shared types

Change the local `ProgramConfig` and `QualityGate` interfaces to imports from `programs.ts`:

```typescript
import type { ProgramConfig, QualityGate } from "./programs.ts"
```

Remove the local interface declarations (lines 9-20). The rest of the file stays unchanged — it's still a standalone script, just importing shared types now.

**Verify this doesn't break the standalone execution:** The script uses `#!/usr/bin/env bun` shebang and is run via `bun run`. Bun resolves TypeScript imports natively, so importing from a sibling file works fine.

---

## Integration: How `startRun()` Ties It All Together

Create a high-level `startRun()` function in `src/lib/run.ts` that orchestrates the full Phase 2a sequence. This is what the TUI will call when the user starts a run from the program detail screen.

[CHANGED] ```typescript
export async function startRun(
  projectRoot: string,
  programSlug: string,
): Promise<{ runId: string; runDir: string; state: RunState }> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const measureShPath = join(programDir, "measure.sh")

  // 1. Load and validate program config
  const config = await loadProgramConfig(programDir)

  // [NEW] 2. Check for clean working tree — uncommitted changes would contaminate baseline
  const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], { cwd: projectRoot })
  if (statusOutput.trim()) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them before starting a run.")
  }

  // [NEW] 3. Record original branch so we can restore on failure
  const { stdout: originalBranch } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot })
  const originalBranchName = originalBranch.trim()

  // 4. Generate run ID and create branch
  const runId = generateRunId()
  const branchName = await createExperimentBranch(projectRoot, programSlug, runId)

  // 5. Initialize run directory and files
  const runDir = await initRunDir(programDir, runId)

  // 6. Lock the evaluator (measure.sh + config.json)
  await lockEvaluator(programDir)

  // 7. Establish baseline — run measurement series
  const baseline = await runMeasurementSeries(measureShPath, projectRoot, config)

  if (!baseline.success) {
    // [CHANGED] Baseline failed — unlock evaluator, switch back to original branch, throw
    await unlockEvaluator(programDir)
    await execFileAsync("git", ["checkout", originalBranchName], { cwd: projectRoot }).catch(() => {})
    throw new Error(`Baseline measurement failed: ${baseline.individual_runs.map(r => r.success ? "ok" : r.error).join(", ")}`)
  }

  if (!baseline.quality_gates_passed) {
    await unlockEvaluator(programDir)
    await execFileAsync("git", ["checkout", originalBranchName], { cwd: projectRoot }).catch(() => {})
    throw new Error(`Baseline quality gates failed: ${baseline.gate_violations.join(", ")}`)
  }

  // 6. Record baseline in results.tsv
  const sha = await getCurrentSha(projectRoot)
  const secondaryValues = JSON.stringify(baseline.median_quality_gates)

  await appendResult(runDir, {
    experiment_number: 0,
    commit: sha,
    metric_value: baseline.median_metric,
    secondary_values: secondaryValues,
    status: "keep",
    description: "baseline",
  })

  // 7. Write initial state
  const state: RunState = {
    run_id: runId,
    program_slug: programSlug,
    phase: "idle",  // ready for experiment loop
    experiment_number: 0,
    original_baseline: baseline.median_metric,
    current_baseline: baseline.median_metric,
    best_metric: baseline.median_metric,
    best_experiment: 0,
    total_keeps: 0,
    total_discards: 0,
    total_crashes: 0,
    branch_name: branchName,
    last_known_good_sha: await getFullSha(projectRoot),
    candidate_sha: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  await writeState(runDir, state)

  return { runId, runDir, state }
}
```

[CHANGED] ### Error Handling in `startRun()`

If any step fails after the branch is created:
1. Unlock evaluator (if locked)
2. Switch back to the original branch (`git checkout <original>`) — don't leave the user stranded on a dead experiment branch
3. Do **not** delete the experiment branch (user may want to inspect it)
4. Throw an error with a descriptive message
5. The TUI layer (phase 2f) will display the error

If baseline measurement itself crashes (non-zero exit), unlock, switch back, and throw. The user needs to fix their measure.sh via the setup screen.

**Note:** The run directory (with partial state.json/results.tsv) is left behind intentionally — it serves as a diagnostic artifact. The TUI can display it as a "failed" run.

---

## Implementation Order

Execute these steps in order. Each step should pass `bun lint && bun typecheck` before proceeding.

### Step 1: Extract shared types into `programs.ts`

1. Add `QualityGate` and `ProgramConfig` interfaces to `src/lib/programs.ts` (after the existing `Program` interface)
2. Add `getProgramDir()` and `getRunDir()` functions
3. Update `Screen` type to include `"program-detail" | "execution"`
4. In `src/lib/validate-measurement.ts`: replace local interface declarations with imports from `./programs.ts`
5. Run `bun lint && bun typecheck`

### Step 2: Create `src/lib/git.ts`

1. Create the file with all git utility functions listed above
2. Use `execFile` from `node:child_process` with `promisify` (same pattern as `programs.ts` line 4-5)
3. Run `bun lint && bun typecheck`

### Step 3: Create `src/lib/measure.ts`

1. Create the file with measurement types and functions
2. Import `ProgramConfig` and `QualityGate` from `./programs.ts`
3. The `runMeasurement()` function should mirror `validate-measurement.ts` lines 90-158 but be importable (not a standalone script main)
4. Implement `validateMeasurementOutput()`, `checkQualityGates()`, `compareMetric()`
5. Implement `runMeasurementSeries()` that calls `runMeasurement()` in a loop
6. Implement the `median()` helper
7. Run `bun lint && bun typecheck`

### Step 4: Create `src/lib/run.ts`

1. Create the file with run types and functions
2. Import from `./programs.ts`, `./measure.ts`, `./git.ts`
3. Implement `generateRunId()`, `createExperimentBranch()`, `loadProgramConfig()`, `lockEvaluator()`, `unlockEvaluator()`, `initRunDir()`, `writeState()`, `readState()`, `appendResult()`
4. Implement `startRun()` that ties everything together
5. Run `bun lint && bun typecheck`

### Step 5: Final verification

1. Run `bun lint && bun typecheck` one final time
2. Verify `validate-measurement.ts` still works as a standalone script: `bun run src/lib/validate-measurement.ts --help` (should print usage)
3. Review that all new types align with IDEA.md's data model (results.tsv columns, state.json fields, file structure)

---

## Node.js / Bun APIs Used

| API | Purpose | Import |
|-----|---------|--------|
| `readFile` | Read config.json, state.json | `node:fs/promises` |
| `writeFile` | Write results.tsv header, temp files | `node:fs/promises` |
| `appendFile` | Append to results.tsv | `node:fs/promises` |
| `rename` | Atomic state.json writes | `node:fs/promises` |
| `mkdir` | Create run directories | `node:fs/promises` |
| `chmod` | Lock/unlock evaluator files | `node:fs/promises` |
| `spawn` | Run measure.sh | `node:child_process` |
| `execFile` | Run git commands | `node:child_process` |
| `join` | Path construction | `node:path` |

No new dependencies needed. Everything uses Bun builtins and Node.js standard library.

---

## What This Phase Does NOT Include

These are deferred to later phases:

- **Experiment agent spawning** → Phase 2b
- **Context packet building** → Phase 2b
- **Re-baseline after keeps/discards** → Phase 2c (uses `runMeasurementSeries` from this phase)
- **Results display** → Phase 2d/2f
- **Run termination / stop semantics** → Phase 2e
- **TUI screens** (program detail, execution dashboard) → Phase 2f
- **Worktree isolation** → Phase 4 (daemon)
- **Daemon / IPC** → Phase 4

---

## Updates to CLAUDE.md

Add the following after the existing Project Structure section:

### Project Structure Update

```
src/
  lib/
    git.ts                 # Git operations (branch, revert, log, SHA)
    measure.ts             # Measurement execution, validation, comparison
    run.ts                 # Run lifecycle (branch, baseline, state, locking)
```

### Agent Conventions Update

Add these bullets:

- Shared types (`ProgramConfig`, `QualityGate`) live in `src/lib/programs.ts` — import from there, not from `validate-measurement.ts`
- Run state persisted atomically via temp-file + rename (`writeState()` in `src/lib/run.ts`)
- Results.tsv is append-only — use `appendResult()`, never rewrite
- Evaluator locking (`chmod 444`) is the #1 safeguard — always lock before experiment loop, unlock on completion
- Git operations in `src/lib/git.ts` — prefer `git revert` over `git reset` to preserve history
- Measurement series returns median of N runs — use `runMeasurementSeries()` for all metric comparisons
- `compareMetric()` uses relative change as a decimal fraction compared against `noise_threshold`

---

## Updates to `docs/architecture.md`

Add a new section after "Current State":

### Run Lifecycle (`src/lib/run.ts`)

Manages the experiment run setup and state:

- `startRun()` — orchestrates branch creation → baseline measurement → state initialization → evaluator locking
- `RunState` — checkpoint persisted atomically to `state.json` via temp-file + rename
- `ExperimentResult` — typed row for the append-only `results.tsv`
- Branch naming: `autoauto-<slug>-<YYYYMMDD-HHMMSS>`
- Evaluator locking: `chmod 444` on `measure.sh` + `config.json` before loop starts

### Measurement (`src/lib/measure.ts`)

Handles measurement execution and decision logic:

- `runMeasurement()` — single measure.sh execution with JSON parsing and validation
- `runMeasurementSeries()` — N repeated measurements with median aggregation
- `compareMetric()` — relative change comparison against noise threshold
- `checkQualityGates()` — threshold enforcement on quality gate fields

### Git Operations (`src/lib/git.ts`)

Thin wrappers around git commands for the orchestrator:

- `createExperimentBranch()` is called from `run.ts`
- `revertCommits()` uses `git revert --no-edit` (not reset) to preserve history for agent learning
- `resetHard()` is the fallback for revert conflicts only

---

[CHANGED] ## Updates to README.md

**README.md already exists at the project root with comprehensive content.** Do NOT create a new one. If updates are needed for Phase 2, append a "Run Lifecycle" section to the existing README rather than replacing it.

---

## Key Design Decisions

### Why no worktree in Phase 2a?
IDEA.md specifies worktrees in Phase 4 (daemon). MVP runs in the user's checkout with one run at a time. Adding worktree complexity now would block Phase 2 progress for no immediate benefit.

### Why `git revert` not `git reset`?
From `docs/orchestration-patterns.md`: "Git history as implicit memory — every commit (including reverted ones) is searchable via `git show`." The experiment agent uses `git show` on reverted commits to learn from failed approaches. `git reset` destroys this history.

### Why atomic state writes?
IDEA.md's daemon section specifies temp-file + rename for `state.json`. Even though Phase 2a doesn't have a daemon yet, using atomic writes now means the TUI can safely read state without corruption. Forward-compatible with Phase 4.

### Why extract types from validate-measurement.ts?
`ProgramConfig` and `QualityGate` are used by both the validation script (Phase 1) and the measurement module (Phase 2). Duplicating them creates drift risk. The standalone script can import from `programs.ts` because Bun resolves TS imports natively.

### Why lock before baseline, not after?
The lock happens in `startRun()` before the baseline measurement. This ensures that even during baseline measurement, the evaluator cannot be modified by any concurrent process. The modulaser reference does the same: lock before the loop starts.

### Why record baseline as experiment #0?
Aligns with the Karpathy reference ("The first run should always be to establish the baseline") and modulaser (logs baseline as first `keep` row). Experiment numbering starts at 1 for actual experiments.

---

## [NEW] Review Notes

This plan was reviewed against the current codebase state, Bun/Node.js APIs, and git best practices. Key corrections:

- **Fixed (RED):** README.md already exists at the project root with comprehensive content. Removed the "create README" section to prevent overwriting.
- **Fixed (YELLOW):** `startRun()` now records the original branch before creating the experiment branch, and switches back on baseline failure. Previously left the user stranded on a dead experiment branch with no way to get back without manual git commands.
- **Fixed (YELLOW):** Added dirty working tree check before `startRun()`. Uncommitted changes would be carried to the experiment branch, contaminating the baseline measurement. Now throws if `git status --porcelain` is non-empty.
- **Fixed (YELLOW):** `runMeasurementSeries` minimum valid runs increased from 1 to `ceil(repeats / 2)`. A single valid measurement has no variance information — the "median" of one value is meaningless for baseline establishment.
- **Fixed (YELLOW):** Explicitly specified `Bun.spawn` (not `execFileAsync`) for measure.ts, matching the validate-measurement.ts pattern. Documented the API split: `Bun.spawn` for long-running measurement scripts (timeout + streaming), `execFileAsync` for quick git commands.
- **Verified:** `chmod 444` is adequate for agent deterrent (SDK Write tool respects permissions). `rename()` is atomic on APFS. `appendFile` is fine for single-writer scenario. `git revert` with fallback to `resetHard` is the correct pattern.
