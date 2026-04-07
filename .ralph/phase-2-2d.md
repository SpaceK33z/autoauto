# Phase 2d: Results Tracking — Implementation Plan

## Overview

Phase 2d completes the results tracking data layer: ensuring every experiment outcome is durably logged to `results.tsv` and `state.json`, and adding the **read-side** utilities that Phase 2f (TUI dashboard) and Phase 4 (daemon) will consume.

### What's Already Done (from Phases 2a–2c)

The **write side** of results tracking is fully implemented:

| Concern | Status | Where |
|---------|--------|-------|
| Append experiment to `results.tsv` | ✅ Done | `run.ts:appendResult()` called in all paths in `experiment-loop.ts` |
| Write/update `state.json` | ✅ Done | `run.ts:writeState()` called at every phase transition in `experiment-loop.ts` |
| Baseline recorded as experiment #0 | ✅ Done | `run.ts:startRun()` line 213 |
| Keep results | ✅ Done | `experiment-loop.ts:runMeasurementAndDecide()` line 211 |
| Discard results (quality gate, regressed, noise) | ✅ Done | `experiment-loop.ts:runMeasurementAndDecide()` lines 173, 257 |
| Measurement failure results | ✅ Done | `experiment-loop.ts:runMeasurementAndDecide()` line 143 |
| Crash results (no commit, agent error) | ✅ Done | `experiment-loop.ts:runExperimentLoop()` line 355 |
| Lock violation results | ✅ Done | `experiment-loop.ts:runExperimentLoop()` line 388 |
| Re-baseline state updates | ✅ Done | `experiment-loop.ts:maybeRebaseline()` line 95 |

**Every code path** in the experiment loop produces both a results.tsv row and a state.json update. The two `[ ]` items in `phase-2.md` are implemented.

### What's Missing

The write operations are done, but the **read, query, and event logging** infrastructure is incomplete:

1. **Results reading as typed data** — The TUI dashboard (2f) needs to display a results table and sparkline. Currently we only have `formatRecentResults()` (raw text for context packets), `parseLastResult()` (single row), and `parseDiscardedShas()` (just SHAs). Missing: a function to parse ALL results into a typed `ExperimentResult[]`.

2. **Run summary statistics** — The dashboard shows improvement %, keep rate, etc. While `RunState` has `best_metric` and `original_baseline`, there's no utility to compute derived stats (improvement %, keep rate, average metric trend) from results. The TUI shouldn't compute these inline.

3. **Run listing & discovery** — The program-detail screen (2f) needs to list all runs for a program and show their status. No function exists to enumerate runs or read their states.

4. **Events logging (events.ndjson)** — IDEA.md specifies `events.ndjson` as an "append-only live event stream for the TUI." Currently, all TUI updates flow through in-memory `LoopCallbacks`. Adding events.ndjson now provides:
   - Persistent audit trail of the run (useful for debugging)
   - Foundation for Phase 4 daemon IPC (TUI polls this file)
   - Recovery mechanism if TUI reconnects mid-run

5. **Cost tracking per experiment** — The Claude Agent SDK's `SDKResultMessage` includes `total_cost_usd` and `usage` fields. Currently `runExperimentAgent()` discards this data. Capturing it enables "cost so far" display in the dashboard and per-experiment cost in results.

---

## Files to Create

### 1. `src/lib/events.ts` — Event logging (events.ndjson)

A lightweight persistent event log. Each event is a JSON object on a single line, appended to `events.ndjson` in the run directory.

#### Types

```typescript
/** Event types that map to LoopCallbacks */
type LoopEventType =
  | "phase_change"
  | "experiment_start"
  | "experiment_end"
  | "error"
  | "rebaseline"
  | "agent_tool"
  | "run_start"
  | "run_complete"

/** A single event in events.ndjson */
interface LoopEvent {
  type: LoopEventType
  timestamp: string          // ISO timestamp
  experiment_number: number  // current experiment (0 = baseline phase)
  data: Record<string, unknown>
}
```

**Why no `agent_text` event type:** Streaming text is high-volume (thousands of tokens per experiment). Logging every token to events.ndjson would bloat the file and slow appends. For Phase 2d, only structural events are logged. Phase 4 (daemon) can add batched text events if needed for TUI reconstruction.

**Why no `state_update` event type:** State changes happen at every phase transition, which is already captured by `phase_change` events. Logging the full RunState object on every update would be redundant with `state.json` itself.

#### Functions

##### `appendEvent(runDir: string, event: LoopEvent): Promise<void>`

Appends a single event as a JSON line to `events.ndjson`.

```typescript
import { appendFile } from "node:fs/promises"
import { join } from "node:path"

export async function appendEvent(runDir: string, event: LoopEvent): Promise<void> {
  const line = JSON.stringify(event) + "\n"
  await appendFile(join(runDir, "events.ndjson"), line)
}
```

**Design notes:**
- Single `appendFile` call — same pattern as `appendResult()` for results.tsv
- No temp-file + rename needed — NDJSON tolerates a partial trailing line (IDEA.md: "TUI watches/polls these files and tolerates a partial trailing NDJSON/TSV line")
- JSON serialization is synchronous and fast for small event objects
- No batching or buffering — events are infrequent enough (a few per experiment) that per-event appends are fine

##### `readEvents(runDir: string): Promise<LoopEvent[]>`

Reads and parses all events from `events.ndjson`. Tolerates partial trailing lines.

```typescript
import { readFile } from "node:fs/promises"

export async function readEvents(runDir: string): Promise<LoopEvent[]> {
  let raw: string
  try {
    raw = await readFile(join(runDir, "events.ndjson"), "utf-8")
  } catch {
    return [] // file doesn't exist yet
  }

  const events: LoopEvent[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as LoopEvent)
    } catch {
      // Partial trailing line — ignore (IDEA.md: "tolerates a partial trailing NDJSON/TSV line")
    }
  }
  return events
}
```

##### `createEventLogger(runDir: string, experimentNumber: () => number): EventLogger`

Factory that returns helper functions to emit typed events. Used by the experiment loop to log events alongside callbacks.

```typescript
interface EventLogger {
  logPhaseChange: (phase: string, detail?: string) => Promise<void>
  logExperimentStart: (experimentNumber: number) => Promise<void>
  logExperimentEnd: (result: ExperimentResult) => Promise<void>
  logError: (message: string) => Promise<void>
  logRebaseline: (oldBaseline: number, newBaseline: number, reason: string) => Promise<void>
  logAgentTool: (status: string) => Promise<void>
  logRunStart: (state: RunState) => Promise<void>
  logRunComplete: (state: RunState) => Promise<void>
}

export function createEventLogger(
  runDir: string,
  getExperimentNumber: () => number,
): EventLogger {
  const emit = (type: LoopEventType, data: Record<string, unknown>) =>
    appendEvent(runDir, {
      type,
      timestamp: new Date().toISOString(),
      experiment_number: getExperimentNumber(),
      data,
    })

  return {
    logPhaseChange: (phase, detail) => emit("phase_change", { phase, detail }),
    logExperimentStart: (num) => emit("experiment_start", { experiment_number: num }),
    logExperimentEnd: (result) => emit("experiment_end", {
      experiment_number: result.experiment_number,
      status: result.status,
      metric_value: result.metric_value,
      description: result.description,
    }),
    logError: (message) => emit("error", { message }),
    logRebaseline: (oldBaseline, newBaseline, reason) =>
      emit("rebaseline", { old_baseline: oldBaseline, new_baseline: newBaseline, reason }),
    logAgentTool: (status) => emit("agent_tool", { status }),
    logRunStart: (state) => emit("run_start", {
      run_id: state.run_id,
      program_slug: state.program_slug,
      original_baseline: state.original_baseline,
      branch_name: state.branch_name,
    }),
    logRunComplete: (state) => emit("run_complete", {
      run_id: state.run_id,
      phase: state.phase,
      total_keeps: state.total_keeps,
      total_discards: state.total_discards,
      total_crashes: state.total_crashes,
      best_metric: state.best_metric,
      original_baseline: state.original_baseline,
    }),
  }
}
```

**Why a factory function instead of direct `appendEvent()` calls in the loop:** Encapsulates the event shape construction and `experiment_number` lookup, keeping the loop code clean. The alternative (sprinkling `appendEvent()` calls everywhere) would add 15+ lines of event construction scattered across the loop.

**Fire-and-forget pattern:** Event logging is non-critical. If an append fails (disk full, permissions), it should NOT crash the experiment loop. The logger's emit calls should be awaited (to maintain ordering) but wrapped in a try/catch at the call site. The simplest approach: create a `safeEmit` wrapper inside `createEventLogger` that catches and ignores errors:

```typescript
const emit = async (type: LoopEventType, data: Record<string, unknown>) => {
  try {
    await appendEvent(runDir, { type, timestamp: new Date().toISOString(), experiment_number: getExperimentNumber(), data })
  } catch {
    // Event logging is best-effort — never crash the loop
  }
}
```

---

## Files to Modify

### 2. `src/lib/run.ts` — Add results reading and run listing utilities

Add new functions after the existing results parsing section (after `parseDiscardedShas()` at line 166).

#### `readAllResults(runDir: string): Promise<ExperimentResult[]>`

Parses the entire results.tsv into a typed array. The TUI dashboard (2f) calls this to populate the results table and compute sparkline data.

```typescript
export async function readAllResults(runDir: string): Promise<ExperimentResult[]> {
  const raw = await readFile(join(runDir, "results.tsv"), "utf-8")
  const lines = raw.trim().split("\n")
  if (lines.length <= 1) return [] // only header

  const results: ExperimentResult[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t")
    if (parts.length < 6) continue
    results.push({
      experiment_number: parseInt(parts[0], 10),
      commit: parts[1],
      metric_value: parseFloat(parts[2]),
      secondary_values: parts[3],
      status: parts[4] as ExperimentStatus,
      description: parts[5],
    })
  }
  return results
}
```

**Design notes:**
- Same parsing logic as `parseLastResult()` but for all rows
- Tolerates malformed rows (skips them) — defensive against partial writes
- Returns empty array (not error) if file only has header — consistent with empty state
- Does NOT filter out baseline (experiment #0) — caller can filter if needed

#### `getMetricHistory(results: ExperimentResult[]): number[]`

Extracts metric values from keep results for sparkline/chart rendering. Includes baseline as the first point.

```typescript
export function getMetricHistory(results: ExperimentResult[]): number[] {
  return results
    .filter((r) => r.status === "keep")
    .map((r) => r.metric_value)
}
```

**Why only keeps:** The sparkline shows the "progress line" — the metric value at each accepted point. Discarded experiments don't change the codebase, so they shouldn't appear on the improvement curve. The TUI can overlay discarded points as a scatter if desired (2f decision).

#### `getRunStats(results: ExperimentResult[], state: RunState): RunStats`

Computes derived statistics from results + state for the TUI dashboard header.

```typescript
export interface RunStats {
  total_experiments: number       // excludes baseline (experiment #0)
  total_keeps: number
  total_discards: number
  total_crashes: number
  keep_rate: number               // 0-1 decimal (total_keeps / total_experiments)
  improvement_pct: number         // relative improvement from original to best (signed %)
  current_improvement_pct: number // relative improvement from original to current baseline (signed %)
  metric_direction: "lower" | "higher" | null  // null if unknown
}

export function getRunStats(results: ExperimentResult[], state: RunState): RunStats {
  const experiments = results.filter((r) => r.experiment_number > 0)
  const keeps = experiments.filter((r) => r.status === "keep")
  const discards = experiments.filter((r) => r.status === "discard")
  const crashes = experiments.filter((r) => r.status === "crash" || r.status === "measurement_failure")

  const total = experiments.length

  const improvementPct = state.original_baseline !== 0
    ? ((state.best_metric - state.original_baseline) / Math.abs(state.original_baseline)) * 100
    : 0

  const currentImprovementPct = state.original_baseline !== 0
    ? ((state.current_baseline - state.original_baseline) / Math.abs(state.original_baseline)) * 100
    : 0

  return {
    total_experiments: total,
    total_keeps: keeps.length,
    total_discards: discards.length,
    total_crashes: crashes.length,
    keep_rate: total > 0 ? keeps.length / total : 0,
    improvement_pct: improvementPct,
    current_improvement_pct: currentImprovementPct,
    metric_direction: null,  // caller fills this from ProgramConfig if needed
  }
}
```

**Why `improvement_pct` is unsigned direction-agnostic:** The percentage is just `(best - original) / |original| * 100`. For "lower is better", best < original produces a negative number, which the TUI can render as "↓ 15.2%" (improvement). For "higher is better", best > original is positive, rendered as "↑ 15.2%". The TUI applies the direction-aware formatting, not the stats function.

#### `listRuns(programDir: string): Promise<RunInfo[]>`

Lists all runs for a program, sorted by start time (newest first). The program-detail screen uses this.

```typescript
import { readdir, stat } from "node:fs/promises"

export interface RunInfo {
  run_id: string
  run_dir: string
  state: RunState | null      // null if state.json is missing/corrupt
  started_at: string | null   // from state, or directory mtime
}

export async function listRuns(programDir: string): Promise<RunInfo[]> {
  const runsDir = join(programDir, "runs")
  let entries: string[]
  try {
    const dirents = await readdir(runsDir, { withFileTypes: true })
    entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return [] // no runs directory
  }

  const runs: RunInfo[] = []
  for (const runId of entries) {
    const runDir = join(runsDir, runId)
    let state: RunState | null = null
    try {
      state = await readState(runDir)
    } catch {
      // state.json missing or corrupt — include the run with null state
    }
    runs.push({
      run_id: runId,
      run_dir: runDir,
      state,
      started_at: state?.started_at ?? null,
    })
  }

  // Sort newest first by run_id (which is a timestamp: YYYYMMDD-HHMMSS)
  runs.sort((a, b) => b.run_id.localeCompare(a.run_id))

  return runs
}
```

**Design notes:**
- Run IDs are timestamps (`YYYYMMDD-HHMMSS`), so lexicographic sort = chronological sort
- Returns `state: null` for corrupted runs rather than skipping them — the TUI can show them as "corrupted" instead of silently hiding them
- No `readAllResults()` call per run — that would be expensive for a list view. The TUI fetches results only when drilling into a specific run

#### `getLatestRun(programDir: string): Promise<RunInfo | null>`

Convenience: returns the most recent run (useful for "Resume" or "View latest" actions).

```typescript
export async function getLatestRun(programDir: string): Promise<RunInfo | null> {
  const runs = await listRuns(programDir)
  return runs.length > 0 ? runs[0] : null
}
```

---

### 3. `src/lib/experiment-loop.ts` — Wire events logging into the loop

Add events logging alongside existing callbacks. The event logger runs in parallel with callbacks — callbacks update the in-memory TUI, events persist to disk.

#### 3a. Import and create event logger

At the top of `runExperimentLoop()`, after reading initial state:

```typescript
import { createEventLogger } from "./events.ts"

// Inside runExperimentLoop(), after `let state = await readState(runDir)`:
const eventLogger = createEventLogger(runDir, () => state.experiment_number)
await eventLogger.logRunStart(state)
```

#### 3b. Add event emissions at each decision point

The event logger calls go alongside existing `callbacks.*` calls. They are NOT replacements — callbacks remain the primary TUI update mechanism.

**At experiment start** (after `callbacks.onExperimentStart(experimentNumber)` ~line 314):
```typescript
await eventLogger.logExperimentStart(experimentNumber)
```

**At phase changes** (after each `callbacks.onPhaseChange(...)` call):
```typescript
await eventLogger.logPhaseChange(phase, detail)
```

Rather than adding this after every single `callbacks.onPhaseChange()` call (there are 10+), the cleaner approach is to wrap the callbacks:

[CHANGED] ```typescript
// At the top of runExperimentLoop(), create wrapped callbacks:
// NOTE: Event logger calls are fire-and-forget (not awaited). Use `void` to
// explicitly discard the Promise and satisfy linters (oxlint flags unawaited promises).
const wrappedCallbacks: LoopCallbacks = {
  ...callbacks,
  onPhaseChange: (phase, detail) => {
    callbacks.onPhaseChange(phase, detail)
    void eventLogger.logPhaseChange(phase, detail)
  },
  onExperimentStart: (num) => {
    callbacks.onExperimentStart(num)
    void eventLogger.logExperimentStart(num)
  },
  onExperimentEnd: (result) => {
    callbacks.onExperimentEnd(result)
    void eventLogger.logExperimentEnd(result)
  },
  onError: (msg) => {
    callbacks.onError(msg)
    void eventLogger.logError(msg)
  },
  onRebaseline: (oldB, newB, reason) => {
    callbacks.onRebaseline?.(oldB, newB, reason)
    void eventLogger.logRebaseline(oldB, newB, reason)
  },
  onAgentToolUse: (status) => {
    callbacks.onAgentToolUse(status)
    void eventLogger.logAgentTool(status)
  },
  // Pass through unchanged:
  onStateUpdate: callbacks.onStateUpdate,
  onAgentStream: callbacks.onAgentStream,
}
```

**IMPORTANT:** Then replace all `callbacks.*` references in the function body with `wrappedCallbacks.*`. This includes:
- `runMeasurementAndDecide()` receives `wrappedCallbacks` instead of `callbacks`
- `maybeRebaseline()` receives `wrappedCallbacks` instead of `callbacks`
- All direct calls in the loop body

**Wait — `runMeasurementAndDecide()` and `maybeRebaseline()` are separate functions.** They receive `callbacks: LoopCallbacks` as a parameter. The wrapper approach works: just pass `wrappedCallbacks` to those functions, and all their internal `callbacks.onPhaseChange(...)` calls automatically emit events too. No changes needed inside those functions.

#### 3c. Add run completion event

At the finalize section (after the `while` loop ends, around line 424):
```typescript
await eventLogger.logRunComplete(finalState)
```

---

### 4. `src/lib/experiment.ts` — Capture SDK cost data from result messages

The Claude Agent SDK's `SDKResultMessage` includes `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, and `usage` fields. Currently, `runExperimentAgent()` discards all of this. Capturing it enables cost display in the dashboard.

#### 4a. Extend `ExperimentOutcome` with optional cost data

Add a new interface and extend the committed outcome:

```typescript
/** Cost and usage data from the SDK result message */
export interface ExperimentCost {
  total_cost_usd: number
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  input_tokens: number
  output_tokens: number
}

export type ExperimentOutcome =
  | { type: "committed"; sha: string; description: string; files_changed: string[]; cost?: ExperimentCost }
  | { type: "no_commit"; cost?: ExperimentCost }
  | { type: "agent_error"; error: string; cost?: ExperimentCost }
```

**Why optional:** Cost data comes from the `result` message, which may not arrive if the agent is aborted or crashes before completion. Making it optional means callers don't need to handle the missing case.

#### 4b. Capture cost in `runExperimentAgent()`

In the `for await` loop inside `runExperimentAgent()`, when handling the `result` message type (currently lines 240-249):

```typescript
// Before: just checks subtype and breaks
// After: also captures cost data

let cost: ExperimentCost | undefined

// ... in the message handler:
} else if (message.type === "result") {
  const resultMsg = message as SDKResultMessage
  cost = {
    total_cost_usd: resultMsg.total_cost_usd ?? 0,
    duration_ms: resultMsg.duration_ms ?? 0,
    duration_api_ms: resultMsg.duration_api_ms ?? 0,
    num_turns: resultMsg.num_turns ?? 0,
    input_tokens: resultMsg.usage?.input_tokens ?? 0,
    output_tokens: resultMsg.usage?.output_tokens ?? 0,
  }
  if (resultMsg.subtype !== "success") {
    return {
      type: "agent_error",
      error: resultMsg.errors?.join(", ") || resultMsg.subtype,
      cost,
    }
  }
  break
}

// At the return statements, include cost:
return { type: "committed", sha: endSha, description, files_changed: filesChanged, cost }
// and:
return { type: "no_commit", cost }
```

**Note on SDK types:** The current code casts `message as SDKResultMessage` and accesses `resultMsg.errors` which isn't in the formal SDK type definition. This is an existing pattern (works at runtime) — don't change it. Just add the cost fields using the same cast approach with nullish coalescing for safety.

[CHANGED] #### 4c. Log cost in events.ndjson

**Approach: Add `logExperimentCost()` to the EventLogger as a dedicated method.** Cost is logged as a separate `experiment_cost` event, keeping it orthogonal to the callback system (no changes to `LoopCallbacks`).

Add `"experiment_cost"` to the `LoopEventType` union in `events.ts`:

```typescript
type LoopEventType =
  | "phase_change"
  | "experiment_start"
  | "experiment_end"
  | "error"
  | "rebaseline"
  | "agent_tool"
  | "run_start"
  | "run_complete"
  | "experiment_cost"  // NEW
```

Add the method to `EventLogger` interface and factory:

```typescript
// In EventLogger interface:
logExperimentCost: (experimentNumber: number, cost: ExperimentCost) => Promise<void>

// In createEventLogger() return object:
logExperimentCost: (experimentNumber, cost) =>
  emit("experiment_cost", { experiment_number: experimentNumber, ...cost }),
```

In `experiment-loop.ts`, after getting the outcome from `runExperimentAgent()`:

```typescript
if (outcome.cost) {
  void eventLogger.logExperimentCost(experimentNumber, outcome.cost)
}
```

**Why a dedicated method instead of modifying `logExperimentEnd`:** Keeps cost tracking orthogonal — `LoopCallbacks.onExperimentEnd` signature stays unchanged, no coupling between the callback system and cost data.

---

### 5. `src/lib/run.ts` — Initialize events.ndjson in `initRunDir()`

In `initRunDir()` (line 84), add creation of the events file alongside results.tsv:

```typescript
export async function initRunDir(programDir: string, runId: string): Promise<string> {
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  await writeFile(
    join(runDir, "results.tsv"),
    "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\n",
  )

  // Initialize events.ndjson as empty file
  await writeFile(join(runDir, "events.ndjson"), "")

  return runDir
}
```

**Why create an empty file:** Consistency with results.tsv initialization. `readEvents()` handles missing files gracefully, but creating it upfront makes the run directory structure predictable and prevents a race condition if the TUI tries to watch/poll the file before the first event.

---

## Implementation Order

Execute these steps in order. Each step should pass `bun lint && bun typecheck` before proceeding.

### Step 1: Add results reading utilities to `src/lib/run.ts`

1. Add the `readdir` and `stat` imports from `node:fs/promises` (if not already present — `readdir` is not currently imported in `run.ts`, it's in `programs.ts`)
2. Add `RunStats` interface and `RunInfo` interface (export both)
3. Add `readAllResults()` function after `parseDiscardedShas()`
4. Add `getMetricHistory()` function
5. Add `getRunStats()` function
6. Add `listRuns()` function
7. Add `getLatestRun()` function
8. Run `bun lint && bun typecheck`

**Key detail for `listRuns()`:** It imports `readState` which is in the same file — no circular dependency issue. But it needs `readdir` from `node:fs/promises`, which must be added to the existing import statement at line 1 of `run.ts`.

### Step 2: Create `src/lib/events.ts`

1. Create the file with `LoopEventType`, `LoopEvent` types
2. Implement `appendEvent()`, `readEvents()`
3. Implement `createEventLogger()` with fire-and-forget error handling
4. Import `ExperimentResult` from `./run.ts` and `ExperimentCost` from `./experiment.ts`
5. Run `bun lint && bun typecheck`

**Note on imports:** `events.ts` imports types from `run.ts` and `experiment.ts`. This does NOT create a circular dependency:
- `run.ts` → does not import from `events.ts`
- `experiment.ts` → does not import from `events.ts`
- `events.ts` → imports types from both (one-directional)
- `experiment-loop.ts` → imports from all three (leaf consumer)

### Step 3: Initialize events.ndjson in `src/lib/run.ts`

1. In `initRunDir()`, add `await writeFile(join(runDir, "events.ndjson"), "")` after the results.tsv initialization
2. Run `bun lint && bun typecheck`

### Step 4: Extend `ExperimentOutcome` with cost data in `src/lib/experiment.ts`

1. Add `ExperimentCost` interface (exported)
2. Add `cost?: ExperimentCost` to all three variants of `ExperimentOutcome`
3. In `runExperimentAgent()`, declare `let cost: ExperimentCost | undefined` before the try block
4. In the `result` message handler, capture cost fields from the SDK result message
5. Include `cost` in all return statements
6. Run `bun lint && bun typecheck`

**SDK type handling:** The `SDKResultMessage` type is imported from the SDK. Access `total_cost_usd`, `duration_ms`, etc. using the same cast pattern as the existing code (`message as SDKResultMessage`). Use nullish coalescing (`?? 0`) for all numeric fields since the SDK may not always include them.

### Step 5: Wire events logging into `src/lib/experiment-loop.ts`

1. Import `createEventLogger` from `./events.ts` and `ExperimentCost` from `./experiment.ts`
2. At the top of `runExperimentLoop()`, after `let state = await readState(runDir)`:
   - Create the event logger: `const eventLogger = createEventLogger(runDir, () => state.experiment_number)`
   - Create the wrapped callbacks object (see section 3b above)
   - Emit `logRunStart(state)`
3. Replace all `callbacks.*` references in the function body with `wrappedCallbacks.*`:
   - The `runMeasurementAndDecide()` call on line 406 — pass `wrappedCallbacks` instead of `callbacks`
   - The `maybeRebaseline()` calls (lines 395, 417) — pass `wrappedCallbacks` instead of `callbacks`
   - All direct `callbacks.onXxx()` calls in the loop body
[CHANGED] 4. After getting the outcome from `runExperimentAgent()`, emit cost event if available:
   ```typescript
   if (outcome.cost) {
     void eventLogger.logExperimentCost(experimentNumber, outcome.cost)
   }
   ```
   The `logExperimentCost` method and `"experiment_cost"` event type were added to `events.ts` in Step 2 (see section 4c).
5. At the finalize section (after the `while` loop), emit `logRunComplete(finalState)`
6. Run `bun lint && bun typecheck`

**Critical: Verify the callback wrapper is complete.** Every callback field in `LoopCallbacks` must appear in the wrapper. The following are passed through unchanged (no event logging needed):
- `onStateUpdate` — state.json is the source of truth; events don't duplicate it
- `onAgentStream` — high-volume streaming text; not logged to events.ndjson

### Step 6: Final verification

1. Run `bun lint && bun typecheck`
2. Review that all new types are exported where needed:
   - `RunStats`, `RunInfo` from `run.ts`
   - `LoopEvent`, `LoopEventType`, `EventLogger` from `events.ts`
   - `ExperimentCost` from `experiment.ts`
3. Review the event logger wrapper covers all `LoopCallbacks` fields
4. Verify no circular imports:
   - `events.ts` → imports from `run.ts`, `experiment.ts` (types only)
   - `experiment-loop.ts` → imports from `events.ts`, `experiment.ts`, `run.ts`, etc.
   - No cycles
5. Verify `initRunDir()` creates events.ndjson

---

## Edge Cases

### Concurrent writes to events.ndjson
**Not an issue for MVP.** The experiment loop is single-threaded (one event at a time). Phase 4 (daemon) may need to handle concurrent writes if the TUI writes control events, but control goes through `control.json`, not events.ndjson.

### events.ndjson grows large
**Not an issue in practice.** With ~1 event per second and ~100 bytes per event, a 1000-experiment run produces ~100KB. The file is never read during the loop (only written). Phase 4 TUI polling should read from the end of the file, not the beginning.

### results.tsv parsing with tab characters in description
**Existing issue, not introduced by 2d.** If an agent commit message contains a tab character, `readAllResults()` will mis-parse the row. This is unlikely (git commit messages rarely contain tabs) and not worth fixing now. If it becomes an issue, switch to proper TSV escaping.

### `readAllResults()` on a run with 10,000+ experiments
**Not a concern for MVP.** A 10,000-row TSV is ~500KB — trivial to read and parse. If performance becomes an issue, add pagination or streaming reads later.

### Empty events.ndjson file
**Handled:** `readEvents()` returns `[]` for empty files. The TUI should handle empty event lists gracefully.

### `listRuns()` performance with many runs
**Not a concern for MVP.** Each run requires one `readState()` call. With 10-20 runs per program, this is <100ms. For hundreds of runs, consider caching or reading only the state phase without full parse.

### Cost data not available (aborted, old SDK version)
**Handled:** `ExperimentCost` is optional on `ExperimentOutcome`. The event logger checks for its presence before emitting cost events. Dashboard code should display "—" for missing cost data.

---

## What This Phase Does NOT Include

- **TUI dashboard rendering** → Phase 2f (consumes `readAllResults()`, `getRunStats()`, `getMetricHistory()`)
- **TUI file watching/polling** → Phase 4 (daemon TUI reads events.ndjson and state.json via polling)
- **Agent text streaming to events.ndjson** → Phase 4 (too high-volume for per-event appends; needs batching)
- **Persistent `consecutiveDiscards` in state.json** → Phase 4 (daemon crash recovery)
- **Run termination / stop semantics** → Phase 2e
- **Summary generation (summary.md)** → Phase 3 (cleanup)
- **Worktree isolation** → Phase 4

---

## Key Design Decisions

### Why events.ndjson now (not Phase 4)?

IDEA.md lists events.ndjson in the file structure for all phases, not just the daemon. Adding the write side now costs ~50 lines of code and provides immediate debugging value. Phase 4 only needs to add the TUI read/poll side — the event format and append logic are already done.

The alternative — waiting until Phase 4 — means the daemon phase has to implement both the event format AND the write integration simultaneously, which is more complex and harder to test incrementally.

### Why not log agent streaming text to events.ndjson?

Token streaming produces 100-500 events per second. Appending each token as a separate NDJSON line would:
1. Create massive files (~10MB per 100-experiment run)
2. Thrash the filesystem with high-frequency writes
3. Slow down the event loop with synchronous JSON serialization

For Phase 4 daemon IPC, agent text needs a different strategy: either batched writes (every 100ms), a separate `agent-output.txt` file, or a ring buffer. This is Phase 4 scope.

### Why separate `readAllResults()` from `formatRecentResults()`?

`formatRecentResults()` returns raw TSV text (for context packets — the agent reads it as-is). `readAllResults()` returns typed objects (for TUI rendering — React components need structured data). Different consumers, different formats.

### Why `getRunStats()` takes both results AND state?

Stats that come from counting results (keep_rate) need the results array. Stats that come from persisted values (best_metric, original_baseline) come from RunState. Passing both avoids re-deriving state from results (which would be error-prone for edge cases like re-baseline drift adjustments).

### Why `RunInfo.state` is nullable?

A run directory might exist but have a corrupt or missing `state.json` (e.g., the process was killed during `initRunDir()` before `writeState()` completed). Returning `null` lets the TUI show "corrupted" instead of crashing or silently hiding the run.

### Why capture cost but not add it to results.tsv?

Adding a column to results.tsv would break the existing format and all parsing code. Cost data goes to events.ndjson where the schema is flexible (each event has its own shape). The TUI can join results with cost events for display.

If cost tracking becomes important enough to persist in results.tsv, that's a future format migration — add a new column at the end (TSV is order-dependent, so existing parsers would ignore it if they only read 6 fields).

---

## Updates to CLAUDE.md

Add these bullets to the **Agent Conventions** section:

```markdown
- Results reading: `readAllResults()` returns typed `ExperimentResult[]` from results.tsv; `getMetricHistory()` extracts keep-only metric values for charts
- Run listing: `listRuns()` enumerates runs for a program with their states; `getLatestRun()` returns the most recent
- Events logging: `events.ndjson` is an append-only event log in each run directory; structural events only (no streaming text)
- `createEventLogger()` wraps `LoopCallbacks` to emit events alongside in-memory callbacks
- Cost tracking: `ExperimentCost` on `ExperimentOutcome` captures SDK cost/usage data per experiment
```

Add `events.ts` to the **Project Structure** section:

```
    events.ts                # Event logging (events.ndjson) for run audit trail
```

---

## Updates to `docs/architecture.md`

Add a new section after "Experiment Agent":

### Results & Events (`src/lib/run.ts`, `src/lib/events.ts`)

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

Update the "Current State" paragraph to mention Phase 2d:

> Phase 2d (Results Tracking) adds the read-side utilities for results and run state, the events.ndjson persistent event log, run listing/discovery, and per-experiment cost tracking from the SDK.

---

## Updates to README.md

No updates needed. The README describes the high-level workflow, not implementation details at this level.

---

## Diff Summary

**Files created: 1**
- `src/lib/events.ts` — Event types, append/read, event logger factory

**Files modified: 3**
- `src/lib/run.ts` — Add `readAllResults()`, `getMetricHistory()`, `getRunStats()`, `listRuns()`, `getLatestRun()`, `RunStats`, `RunInfo` types; initialize events.ndjson in `initRunDir()`
- `src/lib/experiment.ts` — Add `ExperimentCost` interface; capture cost from SDK result message
- `src/lib/experiment-loop.ts` — Import event logger; create callback wrapper; emit run start/complete events; emit cost events

**Estimated diff size:** ~200 lines added, ~15 lines modified

**No new dependencies.** Everything uses Bun builtins and `node:fs/promises`.

---

## [NEW] Review Notes

This plan was reviewed against the Claude Agent SDK type definitions and the current codebase state. Key corrections:

- **Fixed (YELLOW):** Added `void` prefix to all unawaited event logger calls in the callback wrapper. Without `void`, the returned `Promise<void>` is a floating promise that oxlint flags as unused. The `void` operator explicitly discards the return value, satisfying linters. The internal `safeEmit` catches errors, so the promises never reject.
- **Fixed (YELLOW):** Consolidated cost logging into one clear approach. The original plan presented two alternatives (modify `logExperimentEnd` vs. separate event), recommended the simpler one, then contradicted itself by calling the private `emit()` function. Now uses one approach: `logExperimentCost()` method on EventLogger with `"experiment_cost"` in the `LoopEventType` union, defined upfront in the types section.
- **Verified:** SDK `SDKResultSuccess` has all cost fields (`total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage`). `appendFile` for single-line NDJSON is atomic on APFS. All write-side operations confirmed in codebase. No circular dependency issues in the import graph.
