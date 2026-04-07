# Phase 2c: Measurement & Decision — Implementation Plan

## Overview

Phase 2c completes the measurement and decision logic for the experiment loop. Most of the core flow was implemented as part of Phase 2b's `runMeasurementAndDecide()` function in `experiment-loop.ts`. Phase 2c focuses on the **one missing piece**: re-baseline logic after keeps and after consecutive discards.

### What's Already Done (from Phase 2b)

All of these are implemented and working in the current codebase:

| 2c Task | Status | Where |
|---------|--------|-------|
| Run `measure.sh` N times, take median | ✅ Done | `measure.ts:runMeasurementSeries()` |
| Compare against baseline + noise threshold | ✅ Done | `measure.ts:compareMetric()` |
| Check all quality gates pass | ✅ Done | `measure.ts:checkQualityGates()` via `runMeasurementSeries()` |
| **Keep**: improvement → update baseline, log to results.tsv | ✅ Partial | `experiment-loop.ts:runMeasurementAndDecide()` lines 147-178 |
| **Discard**: `git revert`, log to results.tsv with reason | ✅ Done | `experiment-loop.ts:runMeasurementAndDecide()` lines 182-211 |
| Re-measure baseline after keeps / consecutive discards | ❌ Missing | — |

### What's Missing

1. **Re-baseline after keeps**: After a keep, the current code uses the candidate's measurement as the new baseline (`current_baseline: series.median_metric` on line 169). IDEA.md specifies a fresh re-measurement to get an independent baseline.

2. **Re-baseline after consecutive discards**: After N consecutive discards, re-measure the baseline to detect environment drift. Currently, `consecutiveDiscards` is tracked in the loop (line 233) but only used for a warning at 10+ (line 245). No re-measurement happens.

### Design Rationale

**Why re-baseline after keeps?** The candidate measurement was done to evaluate whether the change improved things. Using it as the new baseline conflates evaluation with baseline establishment. A fresh measurement provides an independent data point and accounts for any environmental changes that occurred during the agent's runtime.

**Why re-baseline after consecutive discards?** From `docs/orchestration-patterns.md`: "Check for environment drift (thermals, background processes, API rate limits). If the baseline shifted, the last N discards may have been wrong." If the environment changed, subsequent experiments are being compared against a stale baseline.

**Modulaser comparison:** Modulaser calls `run_profile()` (a profiling step, not re-measurement) after keeps and after 5 consecutive discards (`MAX_CONSECUTIVE_DISCARDS=5`). AutoAuto's IDEA.md explicitly calls for re-measurement, which is a stronger correctness guarantee at the cost of additional measurement time.

---

## Files to Modify

### 1. `src/lib/experiment-loop.ts` — Add re-baseline logic

This is the only file with substantive changes. All modifications are within the existing `runMeasurementAndDecide()` function and `runExperimentLoop()` function.

#### 1a. Add a constant for the consecutive discard re-baseline threshold

Add near the top of the file, after the imports:

```typescript
/** Re-measure baseline after this many consecutive discards to check for environment drift. */
const REBASELINE_AFTER_DISCARDS = 5
```

**Why 5?** Matches modulaser's `MAX_CONSECUTIVE_DISCARDS=5`. Also aligns with Langfuse's 5 consecutive non-improving experiments as a meaningful threshold. Low enough to catch drift early, high enough to avoid excessive measurement overhead.

#### 1b. Add `onRebaseline` to `LoopCallbacks`

Add an optional callback to the existing `LoopCallbacks` interface:

```typescript
export interface LoopCallbacks {
  onPhaseChange: (phase: RunState["phase"], detail?: string) => void
  onExperimentStart: (experimentNumber: number) => void
  onExperimentEnd: (result: ExperimentResult) => void
  onStateUpdate: (state: RunState) => void
  onAgentStream: (text: string) => void
  onAgentToolUse: (status: string) => void
  onError: (error: string) => void
  onRebaseline?: (oldBaseline: number, newBaseline: number, reason: string) => void  // NEW
}
```

**Why optional?** Existing callers don't need to provide it. The TUI (phase 2f) will wire it up to display re-baseline events. Making it optional means phase 2c doesn't break any existing code.

#### 1c. Modify `runMeasurementAndDecide()` — add re-baseline after keeps

The function signature needs `measureShPath` — it already has it. The change is inside the `verdict === "improved"` branch (currently lines 147-178).

**Current code (lines 147-178):**
```typescript
if (verdict === "improved") {
  // KEEP — use the measurement we just took as the new baseline
  callbacks.onPhaseChange("kept", `improved: ${state.current_baseline} → ${series.median_metric}`)

  const isBest = config.direction === "lower"
    ? series.median_metric < state.best_metric
    : series.median_metric > state.best_metric

  const result: ExperimentResult = { ... }
  await appendResult(runDir, result)
  callbacks.onExperimentEnd(result)

  const finalState: RunState = {
    ...currentState,
    total_keeps: currentState.total_keeps + 1,
    current_baseline: series.median_metric,       // ← uses candidate measurement
    best_metric: isBest ? series.median_metric : currentState.best_metric,
    best_experiment: isBest ? state.experiment_number : currentState.best_experiment,
    last_known_good_sha: candidateSha,
    candidate_sha: null,
    phase: "idle",
    updated_at: now(),
  }
  await writeState(runDir, finalState)
  return { state: finalState, kept: true }
}
```

**New code — insert re-baseline between `callbacks.onExperimentEnd(result)` and the state update:**

```typescript
if (verdict === "improved") {
  callbacks.onPhaseChange("kept", `improved: ${state.current_baseline} → ${series.median_metric}`)

  const isBest = config.direction === "lower"
    ? series.median_metric < state.best_metric
    : series.median_metric > state.best_metric

  const result: ExperimentResult = {
    experiment_number: state.experiment_number,
    commit: candidateSha.slice(0, 7),
    metric_value: series.median_metric,
    secondary_values: JSON.stringify(series.median_quality_gates),
    status: "keep",
    description,
  }
  await appendResult(runDir, result)
  callbacks.onExperimentEnd(result)

  // Re-baseline: fresh measurement on the kept code
  callbacks.onPhaseChange("measuring", "re-baselining after keep")
  const rebaseline = await runMeasurementSeries(measureShPath, projectRoot, config)
  const newBaseline = rebaseline.success ? rebaseline.median_metric : series.median_metric

  if (rebaseline.success && newBaseline !== series.median_metric) {
    callbacks.onRebaseline?.(series.median_metric, newBaseline, "keep")
  }

  const finalState: RunState = {
    ...currentState,
    total_keeps: currentState.total_keeps + 1,
    current_baseline: newBaseline,                // ← uses re-baseline if available
    best_metric: isBest ? series.median_metric : currentState.best_metric,
    best_experiment: isBest ? state.experiment_number : currentState.best_experiment,
    last_known_good_sha: candidateSha,
    candidate_sha: null,
    phase: "idle",
    updated_at: now(),
  }
  await writeState(runDir, finalState)
  return { state: finalState, kept: true }
}
```

**Key decisions:**
- If re-baseline fails, fall back to the candidate's measurement (`series.median_metric`). This matches the 2b plan's original design.
- The `best_metric` always uses `series.median_metric` (the candidate evaluation), not the re-baseline value. Best metric tracks the evaluated result, not the baseline shift.
- The `onRebaseline` callback fires only if the re-baseline succeeded and differs from the candidate measurement.

#### 1d. Add re-baseline after consecutive discards in `runExperimentLoop()`

Add a re-baseline check after each non-keep outcome in the main loop. This goes after the `callbacks.onStateUpdate(state)` call at the end of each iteration, right before the `continue` (for non-keep) or the loop top (after measurement).

**Locate the section in `runExperimentLoop()` after the measurement result is handled (currently lines 370-378):**

```typescript
    state = measurementResult.state
    if (measurementResult.kept) {
      consecutiveDiscards = 0
    } else {
      consecutiveDiscards++
    }

    callbacks.onStateUpdate(state)
  }
```

**Replace with:**

```typescript
    state = measurementResult.state
    if (measurementResult.kept) {
      consecutiveDiscards = 0
    } else {
      consecutiveDiscards++
    }

    callbacks.onStateUpdate(state)

    // Re-baseline after consecutive discards to detect environment drift
    if (!measurementResult.kept && consecutiveDiscards > 0 && consecutiveDiscards % REBASELINE_AFTER_DISCARDS === 0) {
      callbacks.onPhaseChange("measuring", `re-baselining after ${consecutiveDiscards} consecutive discards`)
      const driftCheck = await runMeasurementSeries(measureShPath, projectRoot, config)

      if (driftCheck.success) {
        const driftVerdict = compareMetric(
          state.current_baseline,
          driftCheck.median_metric,
          config.noise_threshold,
          config.direction,
        )

        if (driftVerdict !== "noise") {
          const oldBaseline = state.current_baseline
          state = {
            ...state,
            current_baseline: driftCheck.median_metric,
            updated_at: now(),
          }
          await writeState(runDir, state)
          callbacks.onRebaseline?.(oldBaseline, driftCheck.median_metric, "drift")
          callbacks.onError(
            `Baseline drift detected: ${oldBaseline} → ${driftCheck.median_metric}. ` +
            `Recent discards may have been compared against a stale baseline.`
          )
          callbacks.onStateUpdate(state)
        }
      }
      // If drift check fails, keep the old baseline — don't panic
    }
  }
```

**Key decisions:**

- **Modulo check (`% REBASELINE_AFTER_DISCARDS`):** Re-baselines at 5, 10, 15... consecutive discards. Not just once. Environment drift is ongoing, and the agent might legitimately struggle on a hard problem. Using modulo instead of `>=` prevents re-baselining every single iteration after the threshold.

- **Drift detection uses `compareMetric()`:** If the re-baseline measurement is "noise" (within the noise threshold of the stored baseline), no update needed. Only update if the baseline has actually shifted. This reuses the existing comparison function with the same noise threshold the user configured.

- **Warning via `onError()`:** Drift detection is noteworthy — the user should know that recent discards may have been evaluated against a wrong baseline. `onError()` is already used for warnings (e.g., consecutive discard warning at line 245).

- **Don't re-evaluate recent discards:** Too complex for MVP. We just update the baseline going forward. The next experiments will be compared against the corrected baseline.

- **Failure tolerance:** If the drift-check measurement fails, silently keep the old baseline. A measurement failure during drift detection shouldn't halt the loop.

#### 1e. Also handle consecutive discards from no-commit and agent errors

Currently, the loop increments `consecutiveDiscards` after no-commit (line 301) and agent-error (line 319) outcomes, then `continue`s. The re-baseline check from 1d wouldn't fire for these because it's placed after the measurement block. We need the same drift-detection check after these `continue` branches too.

**Extract the re-baseline logic into a helper function within `runExperimentLoop()`:**

```typescript
async function maybeRebaseline(
  consecutiveDiscards: number,
  measureShPath: string,
  projectRoot: string,
  config: ProgramConfig,
  state: RunState,
  runDir: string,
  callbacks: LoopCallbacks,
): Promise<RunState> {
  if (consecutiveDiscards <= 0 || consecutiveDiscards % REBASELINE_AFTER_DISCARDS !== 0) {
    return state
  }

  callbacks.onPhaseChange("measuring", `re-baselining after ${consecutiveDiscards} consecutive discards`)
  const driftCheck = await runMeasurementSeries(measureShPath, projectRoot, config)

  if (!driftCheck.success) return state

  const driftVerdict = compareMetric(
    state.current_baseline,
    driftCheck.median_metric,
    config.noise_threshold,
    config.direction,
  )

  if (driftVerdict === "noise") return state

  const oldBaseline = state.current_baseline
  const newState: RunState = {
    ...state,
    current_baseline: driftCheck.median_metric,
    updated_at: now(),
  }
  await writeState(runDir, newState)
  callbacks.onRebaseline?.(oldBaseline, driftCheck.median_metric, "drift")
  callbacks.onError(
    `Baseline drift detected: ${oldBaseline} → ${driftCheck.median_metric}. ` +
    `Recent discards may have been compared against a stale baseline.`
  )
  callbacks.onStateUpdate(newState)

  return newState
}
```

**Then call it after each non-keep outcome:**

After the no-commit handler (around line 301):
```typescript
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, projectRoot, config, state, runDir, callbacks)
      continue
```

After the agent-error handler (around line 319):
```typescript
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, projectRoot, config, state, runDir, callbacks)
      continue
```

After the lock-violation handler (around line 353):
```typescript
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, projectRoot, config, state, runDir, callbacks)
      continue
```

After the measurement result (replace the inline logic from 1d):
```typescript
    if (measurementResult.kept) {
      consecutiveDiscards = 0
    } else {
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, projectRoot, config, state, runDir, callbacks)
    }
    callbacks.onStateUpdate(state)
```

---

## Implementation Order

Execute these steps in order. Each step should pass `bun lint && bun typecheck` before proceeding.

### Step 1: Add the constant and update `LoopCallbacks`

1. Add `REBASELINE_AFTER_DISCARDS = 5` constant at the top of `experiment-loop.ts` (after imports)
2. Add `onRebaseline?: (oldBaseline: number, newBaseline: number, reason: string) => void` to the `LoopCallbacks` interface
3. Run `bun lint && bun typecheck`

### Step 2: Extract `maybeRebaseline()` helper

1. Create the `maybeRebaseline()` async function within `experiment-loop.ts` (above `runExperimentLoop`, next to the existing `revertToStart` helper)
2. Import `compareMetric` from `./measure.ts` — it's already imported (line 21)
3. Run `bun lint && bun typecheck`

### Step 3: Add re-baseline after keeps in `runMeasurementAndDecide()`

1. In the `verdict === "improved"` branch:
   - After `callbacks.onExperimentEnd(result)`, add the re-baseline measurement call
   - Change `current_baseline` in the final state from `series.median_metric` to `newBaseline`
2. Run `bun lint && bun typecheck`

### Step 4: Add re-baseline after consecutive discards in `runExperimentLoop()`

1. After each non-keep outcome (no-commit, agent-error, lock-violation, measurement discard), call `maybeRebaseline()` after incrementing `consecutiveDiscards`
2. Update state with the return value from `maybeRebaseline()`
3. Run `bun lint && bun typecheck`

### Step 5: Final verification

1. Run `bun lint && bun typecheck`
2. Review that all state transitions are consistent:
   - After keep: `current_baseline` = re-baseline measurement (or candidate fallback)
   - After drift detection: `current_baseline` = drift-check measurement
   - `best_metric` always reflects evaluated results, not re-baseline values
3. Review that `consecutiveDiscards` resets correctly:
   - Reset to 0 after keeps ✅
   - NOT reset after re-baseline (drift doesn't mean the agent is unstuck) ✅
   - Modulo check fires at 5, 10, 15... ✅

---

## Edge Cases

### Re-baseline measurement fails after keep
**Handling:** Fall back to candidate measurement (`series.median_metric`). The state is always consistent.

### Re-baseline measurement fails during drift check
**Handling:** Keep the old baseline. Don't log an error for this — measurement scripts can have transient failures, and the drift check is advisory.

### Drift detected but in the "wrong" direction
**Example:** Baseline was 100ms, drift check shows 80ms. Did the environment get faster, or is this noise?
**Handling:** The `compareMetric()` function already handles this. If the change exceeds the noise threshold in either direction, we update the baseline. The warning tells the user about the drift. We don't try to determine "good" vs "bad" drift — just that the baseline has shifted.

### Re-baseline shows improvement without any code change
**Example:** After 5 consecutive discards, drift check shows the baseline improved by itself.
**Handling:** Update the baseline upward/downward as appropriate. This makes the comparison more accurate for subsequent experiments. The warning informs the user.

### AbortSignal fires during re-baseline
**Handling:** The `signal` check at the top of the loop iteration handles this. If the signal fires during `runMeasurementSeries()` inside `maybeRebaseline()`, the measurement will complete (it doesn't check the signal internally), and then the next loop iteration will see the abort and exit. This is acceptable — re-baseline measurements are quick (same as candidate measurements).

For the re-baseline in `runMeasurementAndDecide()` (after keeps), the same applies. The abort will be caught at the next loop iteration check.

### Consecutive discard counter vs crash counter
**Clarification:** Both `no_commit` and `agent_error` outcomes increment `consecutiveDiscards` AND `total_crashes` in state. `consecutiveDiscards` is in-memory only (not persisted). This is intentional:
- `consecutiveDiscards` is a loop-runtime signal for drift detection
- `total_crashes` is a persisted statistic for the results display
- They serve different purposes and don't need to be synchronized

### What about consecutive measurement_failures?
**Handling:** `measurement_failure` increments `total_crashes` in state (existing behavior, line 100) and `consecutiveDiscards` in the loop (via the non-keep path). So repeated measurement failures will trigger a drift check, which is appropriate — persistent measurement failures could indicate an environment problem.

---

## What This Phase Does NOT Include

- **Results tracking** → Phase 2d (but `appendResult()` and `writeState()` are already called at every decision point)
- **Run termination UI** → Phase 2e
- **TUI execution dashboard** → Phase 2f (will consume `onRebaseline` callback)
- **Worktree isolation** → Phase 4
- **Persisting `consecutiveDiscards`** → Phase 4 (daemon crash recovery needs this in `state.json`)

---

## Key Design Decisions

### Why re-measure after keeps instead of reusing the candidate measurement?

The candidate measurement was taken to evaluate the experiment. While it's on the same code, a fresh measurement provides:
1. **Temporal proximity** — closer in time to the next experiment's measurement, reducing environmental noise
2. **Statistical independence** — two independent measurements give more confidence than one
3. **Drift detection** — if the re-baseline differs significantly from the candidate measurement, it signals environmental instability

The cost is additional measurement time per keep. With a 5-25% keep rate and 3-5 repeats, this adds ~15-25% to total measurement time. Acceptable for correctness.

### Why not reset `consecutiveDiscards` after re-baseline?

The drift check doesn't mean the agent is unstuck. It just means the baseline is now accurate. The agent might still be making poor proposals. The warning at 10+ consecutive discards (existing behavior) still applies, and subsequent drift checks at 10, 15, etc. will continue. Resetting the counter would hide the fact that the agent is struggling.

Modulaser DOES reset after re-profiling (`CONSECUTIVE_DISCARDS=0` on line 1009), but modulaser's re-profiling gives the agent NEW information (fresh flame graphs/analysis), which actually helps it propose different things. Our re-baseline is about measurement accuracy, not agent guidance.

### Why use `compareMetric()` for drift detection?

Reusing the existing comparison function ensures drift detection uses the same noise threshold the user configured for their metric. If they set `noise_threshold: 0.02`, a 1% baseline shift won't trigger a false drift alarm. This is consistent and avoids introducing a separate "drift threshold" configuration.

### Why not add a `rebaseline_after_discards` to ProgramConfig?

KISS for MVP. Hardcoded at 5 is reasonable for all use cases. If users need to tune it, we can add it to config later. The constant is clearly named and easy to find.

---

## Updates to CLAUDE.md

Add these bullets to the **Agent Conventions** section (after the existing `compareMetric()` bullet):

```markdown
- Re-baseline after keeps: `runMeasurementAndDecide()` runs a fresh measurement series after each keep; falls back to candidate measurement if re-baseline fails
- Re-baseline after consecutive discards: `maybeRebaseline()` runs drift detection every `REBASELINE_AFTER_DISCARDS` (5) non-keep outcomes; updates baseline if drift exceeds noise threshold
```

---

## Updates to `docs/architecture.md`

Update the **Experiment Loop** section (currently lines 154-163). Change the line:

```
- Re-baselines after every keep (code changed, old baseline invalid)
```

To:

```
- Re-baselines after every keep (fresh measurement on kept code, falls back to candidate measurement on failure)
- Drift detection: re-measures baseline every 5 consecutive discards to detect environment changes
```

---

## Updates to README.md

No updates needed. The README doesn't describe implementation details at this level.

---

## Diff Summary

**Files modified: 1**
- `src/lib/experiment-loop.ts` — all changes

**Files created: 0**

**Estimated diff size:** ~60 lines added, ~5 lines modified

**No new dependencies.** All functionality uses existing `runMeasurementSeries()` and `compareMetric()` from `measure.ts`.
