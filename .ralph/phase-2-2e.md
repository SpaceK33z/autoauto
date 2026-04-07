# Phase 2e: Run Termination — Implementation Plan

## Overview

Phase 2e adds run termination: aborting a running experiment, respecting the max experiment count, and prompting the user to run cleanup or abandon after the loop ends. This is the control layer between the orchestrator (2a–2d) and the TUI dashboard (2f).

### What's Already Done (from Phases 2a–2d)

| Concern | Status | Where |
|---------|--------|-------|
| Max experiment count check | ✅ Done | `experiment-loop.ts:runExperimentLoop()` line 341 |
| AbortSignal checked between iterations | ✅ Done | `experiment-loop.ts:runExperimentLoop()` line 329 |
| AbortSignal passed to experiment agent | ✅ Done | `experiment.ts:runExperimentAgent()` line 196 |
| Agent aborted → returns `agent_error: "aborted"` | ✅ Done | `experiment.ts:runExperimentAgent()` line 274 |
| Evaluator unlocked on loop exit | ✅ Done | `experiment-loop.ts:runExperimentLoop()` line 465 |
| Loop writes final state on exit | ✅ Done | `experiment-loop.ts:runExperimentLoop()` line 467 |
| `isWorkingTreeClean()` helper | ✅ Done | `git.ts:isWorkingTreeClean()` |
| `resetHard()` helper | ✅ Done | `git.ts:resetHard()` |
| `revertCommits()` helper | ✅ Done | `git.ts:revertCommits()` |
| `Screen` type includes `"execution"` | ✅ Done | `programs.ts` line 28 |
| `startRun()` orchestrates branch + baseline | ✅ Done | `run.ts:startRun()` |
| Events logging via `createEventLogger()` | ✅ Done | `events.ts` |

### What's Missing

1. **Abort-aware cleanup after agent returns** — When the abort signal fires mid-experiment, the agent may have left uncommitted changes or even committed before being killed. The current code doesn't clean these up — it logs a crash and continues to the next iteration, where the abort check breaks the loop. We need immediate cleanup: revert commits, reset uncommitted changes, then break.

2. **AbortSignal for measurement** — When abort fires during measurement (after the agent committed, during `runMeasurementAndDecide`), measurement continues to completion before the abort is detected. For "kill immediately" semantics, measurement should be interruptible via the signal.

3. **Execution screen** — No screen exists to launch a run, display its progress, handle abort keyboard events, and show the post-run prompt. The `"execution"` value exists in the `Screen` type but is never rendered.

4. **Post-run prompt** — After the loop ends (abort or max experiments), the user must choose: run cleanup (Phase 3) or abandon. No UI for this exists.

5. **Program selection → execution flow** — HomeScreen lists programs but Enter does nothing. We need navigation from HomeScreen to the execution screen with the selected program slug.

---

## Design Decisions

### Abort is the only manual stop mode for Phase 2

IDEA.md describes two stop modes: `stop-after-current` (graceful) and `abort-current` (immediate). Phase 4 (daemon) adds the graceful stop via `control.json` + `SIGTERM`. For Phase 2, the TUI and loop share a process — the user presses a key and wants the loop to stop. We implement **abort-current only**: kill the experiment immediately, revert any changes, and exit.

**Why not both?** Adding stop-after-current requires either a second signal or a boolean flag, plus UI to choose between the two. It's unnecessary complexity in Phase 2 because the user can see the loop state in real-time and decide when to abort. Phase 4 adds stop-after-current when the daemon runs detached and the user may not be watching.

### Measurement abort kills the process

When the abort signal fires during `runMeasurementSeries()`, we kill the active `bash` child process via Node's `signal` option on `spawn()`. This makes abort feel responsive — the user doesn't wait 30–60 seconds for measurement to finish. The measurement returns a failure result, and the loop handles cleanup.

### Post-run prompt is a full-screen state, not a modal

After the loop completes, the ExecutionScreen switches from "running" to "complete" mode. The complete mode renders a summary + two options (cleanup / abandon). This is simpler than a modal overlay and matches the existing screen-based navigation pattern. Phase 2f will add the full dashboard layout; the post-run prompt sits below it.

### `startRun()` is not abort-aware

Baseline measurement during `startRun()` can take 10–30 seconds (3–5 repeats). For Phase 2, we don't interrupt it — the user waits for baseline to complete before the loop starts. Phase 4 can add signal support to `startRun()` since the daemon needs more granular control.

### Max experiments defaults to unlimited

The `LoopOptions.maxExperiments` field already works. For Phase 2e, we add an optional `max_experiments` field to `ProgramConfig` so the setup agent can recommend a budget. If not set, the loop runs until manually aborted. The ExecutionScreen passes it through.

---

## Files to Modify

### 1. `src/lib/measure.ts` — Add AbortSignal support

Add an optional `signal` parameter to `runMeasurement()` and `runMeasurementSeries()` to enable abort during measurement.

#### 1a. `runMeasurement()` — accept optional AbortSignal

**Current signature:**
```typescript
export async function runMeasurement(
  measureShPath: string,
  projectRoot: string,
  timeoutMs?: number,
): Promise<MeasurementResult>
```

**New signature:**
```typescript
export async function runMeasurement(
  measureShPath: string,
  projectRoot: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<MeasurementResult>
```

**Changes inside the function:**

1. Before spawning, check if already aborted:
   ```typescript
   if (signal?.aborted) {
     return { success: false, error: "aborted", duration_ms: 0 }
   }
   ```

2. Wire the signal to kill the child process. Add an abort listener that calls `proc.kill("SIGTERM")` when the signal fires, and clean up the listener in the `close`/`error` handlers:
   ```typescript
   const onAbort = () => {
     if (!proc.killed) proc.kill("SIGTERM")
   }
   signal?.addEventListener("abort", onAbort, { once: true })

   // In both proc.on("close") and proc.on("error") handlers:
   signal?.removeEventListener("abort", onAbort)
   ```

3. In the `close` handler, check if the process was killed by abort. If `signal?.aborted`, return a failure with `error: "aborted"`:
   ```typescript
   if (signal?.aborted) {
     resolve({ success: false, error: "aborted", duration_ms })
     return
   }
   ```

#### 1b. `runMeasurementSeries()` — accept and forward AbortSignal

**Current signature:**
```typescript
export async function runMeasurementSeries(
  measureShPath: string,
  projectRoot: string,
  config: ProgramConfig,
): Promise<MeasurementSeriesResult>
```

**New signature:**
```typescript
export async function runMeasurementSeries(
  measureShPath: string,
  projectRoot: string,
  config: ProgramConfig,
  signal?: AbortSignal,
): Promise<MeasurementSeriesResult>
```

**Changes inside the function:**

1. In the measurement loop, check abort before each run:
   ```typescript
   for (let i = 0; i < config.repeats; i++) {
     if (signal?.aborted) break  // NEW: stop early on abort
     const result = await runMeasurement(measureShPath, projectRoot, undefined, signal)
     // ...
   }
   ```

2. After the loop, if `signal?.aborted` and we don't have enough valid metrics, return failure:
   ```typescript
   if (signal?.aborted) {
     return {
       success: false,
       median_metric: 0,
       median_quality_gates: {},
       quality_gates_passed: false,
       gate_violations: [],
       individual_runs: runs,
       duration_ms,
     }
   }
   ```

**Why not use Node's built-in `spawn({ signal })` option?** Node 15.4+ supports `signal` on `spawn()`, but it fires `AbortError` on the process, which complicates error handling. Manual kill + listener is more predictable and matches our existing error handling pattern.

### 2. `src/lib/experiment-loop.ts` — Abort-aware cleanup

This is the core change. After the experiment agent returns, we check for abort and clean up before proceeding.

#### 2a. Forward the signal to measurement calls

Pass `options.signal` to all `runMeasurementSeries()` calls throughout the file:

1. In `maybeRebaseline()` — add `signal?: AbortSignal` parameter, forward to `runMeasurementSeries()`:
   ```typescript
   async function maybeRebaseline(
     consecutiveDiscards: number,
     measureShPath: string,
     projectRoot: string,
     config: ProgramConfig,
     state: RunState,
     runDir: string,
     callbacks: LoopCallbacks,
     signal?: AbortSignal,         // NEW
   ): Promise<RunState> {
     // ...
     const driftCheck = await runMeasurementSeries(measureShPath, projectRoot, config, signal)
     // ...
   }
   ```

2. In `runMeasurementAndDecide()` — add `signal?: AbortSignal` parameter, forward to `runMeasurementSeries()`:
   ```typescript
   async function runMeasurementAndDecide(
     projectRoot: string,
     runDir: string,
     measureShPath: string,
     config: ProgramConfig,
     state: RunState,
     startSha: string,
     candidateSha: string,
     description: string,
     callbacks: LoopCallbacks,
     signal?: AbortSignal,         // NEW
   ): Promise<{ state: RunState; kept: boolean }> {
     // Forward to measurement:
     const series = await runMeasurementSeries(measureShPath, projectRoot, config, signal)
     // And to re-baseline after keep:
     const rebaseline = await runMeasurementSeries(measureShPath, projectRoot, config, signal)
     // ...
   }
   ```

3. In `runExperimentLoop()` — pass `options.signal` through all calls:
   ```typescript
   // All maybeRebaseline calls:
   state = await maybeRebaseline(..., wrappedCallbacks, options.signal)

   // The runMeasurementAndDecide call:
   const measurementResult = await runMeasurementAndDecide(
     ..., wrappedCallbacks, options.signal,
   )
   ```

#### 2b. Add abort detection + cleanup after agent returns

After `runExperimentAgent()` returns, check if abort was requested **before** proceeding to measurement or continuation. Insert this block after the agent outcome is received (after line 376 in current code), before any outcome-specific handling:

```typescript
    const outcome = await runExperimentAgent(/* ... */)

    // Log cost data
    if (outcome.cost) {
      void eventLogger.logExperimentCost(outcome.cost)
    }

    // --- NEW: Abort detection + cleanup ---
    if (options.signal?.aborted) {
      wrappedCallbacks.onPhaseChange("stopping", "aborted by user")

      // Clean up any changes the agent made
      const currentSha = await getFullSha(projectRoot)
      if (currentSha !== startSha) {
        // Agent committed — revert to pre-experiment state
        await revertToStart(projectRoot, startSha, currentSha)
      } else if (!(await isWorkingTreeClean(projectRoot))) {
        // Agent left uncommitted changes — reset
        await resetHard(projectRoot, startSha)
      }

      // Log the abort as a crash
      const abortResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: startSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: "aborted by user",
      }
      await appendResult(runDir, abortResult)
      wrappedCallbacks.onExperimentEnd(abortResult)

      state = {
        ...state,
        total_crashes: state.total_crashes + 1,
        candidate_sha: null,
        phase: "stopping",
        updated_at: now(),
      }
      await writeState(runDir, state)
      break
    }

    // --- (existing outcome handling continues here) ---
```

**Key decisions:**
- The abort check happens BEFORE the existing `no_commit`/`agent_error`/`committed` branching. This ensures we always clean up, regardless of what the agent managed to do before being killed.
- If the agent committed, we revert (preserving history). If it left uncommitted changes, we reset hard (safe — this is our experiment branch).
- The abort is logged as status `"crash"` with description `"aborted by user"` to distinguish it from agent errors.
- We break out of the loop immediately. The existing finalization block (unlockEvaluator, final state) runs after the while loop.

#### 2c. Add abort check after measurement returns

The abort signal might fire during measurement. When `runMeasurementAndDecide()` returns after an abort, the measurement result will show failure (because the measurement was killed). The existing measurement-failure handler would try to revert and continue. Instead, we should detect the abort and break.

Add an abort check after `runMeasurementAndDecide()` returns (after the current line 447):

```typescript
    const measurementResult = await runMeasurementAndDecide(
      projectRoot, runDir, measureShPath,
      config, state, startSha, candidateSha, outcome.description,
      wrappedCallbacks, options.signal,
    )

    // NEW: Check if abort fired during measurement
    if (options.signal?.aborted) {
      state = { ...measurementResult.state, phase: "stopping", updated_at: now() }
      await writeState(runDir, state)
      break
    }

    state = measurementResult.state
    // ... (existing keep/discard handling)
```

**Why this works:** If abort fires during measurement, `runMeasurementSeries()` returns `success: false`. The `runMeasurementAndDecide()` function handles this as a measurement failure (reverts the commit, logs the result). After it returns, we check for abort and break instead of continuing the loop. The revert has already happened, so git state is clean.

#### 2d. Add `onLoopComplete` callback to `LoopCallbacks`

The TUI needs to know when the loop finishes and why. Add a callback:

```typescript
export interface LoopCallbacks {
  onPhaseChange: (phase: RunState["phase"], detail?: string) => void
  onExperimentStart: (experimentNumber: number) => void
  onExperimentEnd: (result: ExperimentResult) => void
  onStateUpdate: (state: RunState) => void
  onAgentStream: (text: string) => void
  onAgentToolUse: (status: string) => void
  onError: (error: string) => void
  onRebaseline?: (oldBaseline: number, newBaseline: number, reason: string) => void
  onLoopComplete?: (state: RunState, reason: "aborted" | "max_experiments" | "stopped") => void  // NEW
}
```

Fire it in the finalization block at the end of `runExperimentLoop()`, right before returning:

```typescript
  // --- Finalize ---
  await unlockEvaluator(programDir)

  const finalState: RunState = {
    ...state,
    phase: state.phase === "stopping" ? "complete" as const : state.phase,
    updated_at: now(),
  }
  await writeState(runDir, finalState)
  await eventLogger.logRunComplete(finalState)
  wrappedCallbacks.onStateUpdate(finalState)

  // Determine termination reason
  const reason = options.signal?.aborted
    ? "aborted" as const
    : state.experiment_number >= (options.maxExperiments ?? Infinity)
      ? "max_experiments" as const
      : "stopped" as const
  wrappedCallbacks.onLoopComplete?.(finalState, reason)

  return finalState
```

Also emit a `loop_complete` event via the event logger. Add `logLoopComplete` to `EventLogger`:

```typescript
// In events.ts, add to LoopEventType:
export type LoopEventType =
  | /* existing values */
  | "loop_complete"

// In EventLogger interface:
export interface EventLogger {
  // ... existing methods
  logLoopComplete: (state: RunState, reason: string) => Promise<void>
}

// In createEventLogger():
logLoopComplete: (state, reason) => emit("loop_complete", {
  run_id: state.run_id,
  reason,
  total_keeps: state.total_keeps,
  total_discards: state.total_discards,
  total_crashes: state.total_crashes,
}),
```

### 3. `src/lib/programs.ts` — Add `max_experiments` to ProgramConfig

Add an optional field to `ProgramConfig`:

```typescript
export interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
  max_experiments?: number   // NEW: optional experiment budget (default: unlimited)
}
```

No validation changes needed — `loadProgramConfig()` doesn't validate optional fields. The field is simply passed through.

**Why optional with no default?** Most users will stop runs manually. Power users can set a budget in config.json or have the setup agent recommend one. Unlimited is the safe default — never stop a productive run prematurely.

### 4. `src/lib/git.ts` — Add `cleanWorkingTree()` helper

Add a convenience function that resets uncommitted changes. This wraps the existing `resetHard()` but with an explicit intent (clean up agent mess, not a full revert):

```typescript
/** Discards all uncommitted changes in the working tree. Safe on experiment branches. */
export async function cleanWorkingTree(cwd: string): Promise<void> {
  // git checkout -- . cleans modified tracked files
  await execFileAsync("git", ["checkout", "--", "."], { cwd })
  // git clean -fd removes untracked files and directories
  await execFileAsync("git", ["clean", "-fd"], { cwd })
}
```

**Why not just `resetHard()`?** `resetHard()` needs a SHA. `cleanWorkingTree()` cleans the working directory to match HEAD without moving HEAD. This is correct when the agent left uncommitted changes but didn't commit — HEAD is already at `last_known_good_sha`.

Actually, on reflection, `resetHard(projectRoot, startSha)` achieves the same thing (HEAD is at startSha, no committed changes, just cleans working tree). And it's already used in the codebase. So instead of a new function, use the existing `resetHard()` in the abort handler. See section 2b above — it already uses `resetHard(projectRoot, startSha)` for uncommitted changes.

**Decision: No new git.ts function needed.** The existing `resetHard()` and `isWorkingTreeClean()` are sufficient.

### 5. `src/App.tsx` — Wire execution screen + program selection state

#### 5a. Add state for selected program

```typescript
const [selectedProgram, setSelectedProgram] = useState<string | null>(null)
```

#### 5b. Render ExecutionScreen when screen === "execution"

In the return JSX, add:

```tsx
{screen === "execution" && selectedProgram && (
  <ExecutionScreen
    cwd={projectRoot}
    programSlug={selectedProgram}
    modelConfig={projectConfig.executionModel}
    navigate={setScreen}
  />
)}
```

#### 5c. Pass `onSelectProgram` to HomeScreen

```tsx
{screen === "home" && (
  <HomeScreen
    cwd={cwd}
    navigate={setScreen}
    onSelectProgram={(slug) => {
      setSelectedProgram(slug)
      setScreen("execution")
    }}
  />
)}
```

#### 5d. Update status bar text for execution screen

```tsx
<text fg="#888888">
  {screen === "home"
    ? " n: new program | s: settings | Enter: run | Escape: quit"
    : screen === "execution"
      ? " q: abort run | Escape: back (after completion)"
      : screen === "settings"
        ? " ↑↓: navigate | ←→: change | Escape: back"
        : " Escape: back"}
</text>
```

#### 5e. Guard global keyboard handler

The App-level `useKeyboard` currently quits on Escape from home. Guard it when execution is active:

```typescript
useKeyboard((key) => {
  if (key.name === "escape") {
    if (screen === "home" || authState === "error") {
      renderer.destroy()
    }
    // execution screen handles its own Escape
  }
})
```

### 6. `src/screens/HomeScreen.tsx` — Add Enter key + pass program slug

#### 6a. Accept new callback prop

```typescript
interface HomeScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  onSelectProgram: (slug: string) => void
}
```

#### 6b. Handle Enter key to start a run

In the `useKeyboard` handler, add:

```typescript
} else if (key.name === "return" && programs.length > 0) {
  onSelectProgram(programs[selected].name)
}
```

#### 6c. Update hint text in the program list

The program list items could show a hint that Enter starts a run. This is optional — the status bar already shows the key mapping.

### 7. `src/screens/ExecutionScreen.tsx` — New file

The execution screen orchestrates the run lifecycle and renders the post-run prompt.

#### Props

```typescript
interface ExecutionScreenProps {
  cwd: string
  programSlug: string
  modelConfig: ModelSlot
  navigate: (screen: Screen) => void
}
```

#### State

```typescript
type ExecutionPhase = "starting" | "running" | "complete" | "error"

const [phase, setPhase] = useState<ExecutionPhase>("starting")
const [runState, setRunState] = useState<RunState | null>(null)
const [currentPhaseLabel, setCurrentPhaseLabel] = useState("Initializing...")
const [experimentNumber, setExperimentNumber] = useState(0)
const [lastError, setLastError] = useState<string | null>(null)
const [terminationReason, setTerminationReason] = useState<"aborted" | "max_experiments" | "stopped" | null>(null)
const abortControllerRef = useRef(new AbortController())
```

#### Effect: start the run

```typescript
useEffect(() => {
  const abortController = abortControllerRef.current
  let cancelled = false

  ;(async () => {
    try {
      // 1. Start run (branch, baseline)
      setCurrentPhaseLabel("Establishing baseline...")
      const { runDir, state: initialState } = await startRun(cwd, programSlug)
      if (cancelled) return

      setRunState(initialState)
      setPhase("running")
      setCurrentPhaseLabel("Running experiments...")

      // 2. Load program config for maxExperiments
      const programDir = getProgramDir(cwd, programSlug)
      const config = await loadProgramConfig(programDir)

      // 3. Build callbacks
      const callbacks: LoopCallbacks = {
        onPhaseChange: (p, detail) => {
          setCurrentPhaseLabel(detail ? `${p}: ${detail}` : p)
        },
        onExperimentStart: (num) => {
          setExperimentNumber(num)
        },
        onExperimentEnd: () => {},
        onStateUpdate: (s) => {
          setRunState(s)
        },
        onAgentStream: () => {},
        onAgentToolUse: (status) => {
          setCurrentPhaseLabel(status)
        },
        onError: (msg) => {
          setLastError(msg)
        },
        onLoopComplete: (_state, reason) => {
          setTerminationReason(reason)
        },
      }

      // 4. Run the experiment loop
      const finalState = await runExperimentLoop(
        cwd,
        programSlug,
        runDir,
        config,
        modelConfig,
        callbacks,
        {
          maxExperiments: config.max_experiments,
          signal: abortController.signal,
        },
      )

      if (!cancelled) {
        setRunState(finalState)
        setPhase("complete")
      }
    } catch (err: unknown) {
      if (!cancelled) {
        setLastError(err instanceof Error ? err.message : String(err))
        setPhase("error")
      }
    }
  })()

  return () => {
    cancelled = true
    abortController.abort()
  }
}, [])
```

**Key points:**
- The `useEffect` has an empty dependency array — it runs once on mount.
- The cleanup function aborts on unmount (e.g., if user navigates away).
- `startRun()` errors (dirty working tree, baseline failure) are caught and shown.
- The `cancelled` flag prevents stale state updates if the component unmounts.

#### Keyboard handling

```typescript
useKeyboard((key) => {
  if (phase === "complete" || phase === "error") {
    // Post-run keyboard handling is in RunCompletePrompt
    if (key.name === "escape") {
      navigate("home")
    }
    return
  }

  // During execution
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    abortControllerRef.current.abort()
  }
})
```

**Why `q` and not Escape?** Escape is used to go back in every other screen. During execution, accidentally pressing Escape shouldn't kill the run. `q` is deliberate. `Ctrl+C` is the universal "kill" shortcut. We don't call `renderer.destroy()` on Ctrl+C here — we just abort the loop and let the user see the results.

Note: `exitOnCtrlC: false` is already set in `src/index.tsx`, so Ctrl+C doesn't kill the process.

#### Render

```tsx
return (
  <box flexDirection="column" flexGrow={1}>
    {(phase === "starting" || phase === "running") && (
      <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`Running: ${programSlug}`}>
        <box flexDirection="column" padding={1}>
          <text>
            <strong>Experiment #{experimentNumber}</strong>
          </text>
          <text fg="#888888">{currentPhaseLabel}</text>
          {runState && (
            <box flexDirection="column">
              <text>{""}</text>
              <text>Baseline: {runState.original_baseline}</text>
              <text>Current: {runState.current_baseline}</text>
              <text>Keeps: {runState.total_keeps} | Discards: {runState.total_discards} | Crashes: {runState.total_crashes}</text>
            </box>
          )}
          {lastError && <text fg="#ff5555">{lastError}</text>}
        </box>
      </box>
    )}

    {(phase === "complete" || phase === "error") && runState && (
      <RunCompletePrompt
        state={runState}
        terminationReason={terminationReason}
        error={phase === "error" ? lastError : null}
        onCleanup={() => {
          // Phase 3 will implement cleanup. For now, navigate home.
          navigate("home")
        }}
        onAbandon={() => {
          navigate("home")
        }}
      />
    )}

    {phase === "error" && !runState && (
      <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Error">
        <box padding={1}>
          <text fg="#ff5555">{lastError ?? "Unknown error"}</text>
        </box>
      </box>
    )}
  </box>
)
```

**Phase 2f will replace the minimal "running" view** with the full dashboard (sparkline, results table, streaming agent text). The structure here is a placeholder that shows enough to verify the loop is working and that abort/completion triggers the prompt.

### 8. `src/components/RunCompletePrompt.tsx` — New file

The post-run prompt shown after the loop finishes. Two choices: cleanup or abandon.

#### Props

```typescript
import type { RunState } from "../lib/run.ts"

interface RunCompletePromptProps {
  state: RunState
  terminationReason: "aborted" | "max_experiments" | "stopped" | null
  error: string | null
  onCleanup: () => void
  onAbandon: () => void
}
```

#### Component

```tsx
[CHANGED] import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { RunState } from "../lib/run.ts"
// NOTE: Do NOT import getRunStats — it requires a results array which this component
// doesn't have. Stats are computed inline from RunState (see below).

[CHANGED] export function RunCompletePrompt({
  state,
  terminationReason,
  error,
  onCleanup,
  onAbandon,
}: RunCompletePromptProps) {
  const [selected, setSelected] = useState(0)

  // Compute stats directly from RunState — don't use getRunStats() which requires
  // results array. All needed values are already in RunState.
  const totalExperiments = state.total_keeps + state.total_discards + state.total_crashes
  const stats = {
    total_experiments: totalExperiments,
    total_keeps: state.total_keeps,
    total_discards: state.total_discards,
    total_crashes: state.total_crashes,
    keep_rate: totalExperiments > 0 ? state.total_keeps / totalExperiments : 0,
    improvement_pct: state.original_baseline !== 0
      ? ((state.best_metric - state.original_baseline) / Math.abs(state.original_baseline)) * 100
      : 0,
  }

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "k") {
      setSelected(0)
    } else if (key.name === "down" || key.name === "j") {
      setSelected(1)
    } else if (key.name === "return") {
      if (selected === 0) onCleanup()
      else onAbandon()
    } else if (key.name === "c") {
      onCleanup()
    } else if (key.name === "a") {
      onAbandon()
    }
  })

  const reasonLabel =
    terminationReason === "aborted" ? "Aborted by user"
    : terminationReason === "max_experiments" ? `Reached max experiments (${state.experiment_number})`
    : "Run complete"

  const improvementStr = stats.improvement_pct !== 0
    ? ` (${stats.improvement_pct > 0 ? "+" : ""}${stats.improvement_pct.toFixed(1)}%)`
    : ""

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Run Complete">
      <box flexDirection="column" padding={1}>
        {/* Summary */}
        <text fg="#9ece6a"><strong>{reasonLabel}</strong></text>
        <text>{""}</text>
        <text>Program: {state.program_slug}</text>
        <text>Branch: {state.branch_name}</text>
        <text>Experiments: {stats.total_experiments} ({stats.total_keeps} kept, {stats.total_discards} discarded, {stats.total_crashes} crashed)</text>
        <text>Original baseline: {state.original_baseline}</text>
        <text>Best metric: {state.best_metric}{improvementStr}</text>
        {stats.total_keeps > 0 && (
          <text>Keep rate: {(stats.keep_rate * 100).toFixed(0)}%</text>
        )}
        {error && <text fg="#ff5555">Error: {error}</text>}

        {/* Actions */}
        <text>{""}</text>
        <text><strong>What would you like to do?</strong></text>
        <text>{""}</text>
        <text fg={selected === 0 ? "#ffffff" : "#888888"}>
          {selected === 0 ? " ▸ " : "   "}
          Run cleanup (review & package changes)
        </text>
        <text fg={selected === 1 ? "#ffffff" : "#888888"}>
          {selected === 1 ? " ▸ " : "   "}
          Abandon (keep branch as-is)
        </text>
      </box>
    </box>
  )
}
```

**Notes:**
- Keyboard shortcuts `c` and `a` for quick access, plus arrow keys + Enter for menu selection.
- `getRunStats()` from `run.ts` computes derived statistics (keep rate, improvement %).
- "Run cleanup" is a placeholder — both options navigate home for now. Phase 3 will implement the cleanup agent flow.
- The prompt shows a summary of the run: experiments, keeps, discards, improvement. This gives the user context to decide.

### 9. `src/lib/events.ts` — Add `loop_complete` event type

#### 9a. Extend `LoopEventType`

Add `"loop_complete"` to the union:

```typescript
export type LoopEventType =
  | "phase_change"
  | "experiment_start"
  | "experiment_end"
  | "error"
  | "rebaseline"
  | "agent_tool"
  | "run_start"
  | "run_complete"
  | "experiment_cost"
  | "loop_complete"    // NEW
```

#### 9b. Add `logLoopComplete` to `EventLogger`

```typescript
export interface EventLogger {
  // ... existing methods
  logLoopComplete: (state: RunState, reason: string) => Promise<void>
}
```

#### 9c. Implement in `createEventLogger()`

```typescript
logLoopComplete: (state, reason) => emit("loop_complete", {
  run_id: state.run_id,
  reason,
  total_keeps: state.total_keeps,
  total_discards: state.total_discards,
  total_crashes: state.total_crashes,
  best_metric: state.best_metric,
  original_baseline: state.original_baseline,
}),
```

### 10. `src/lib/run.ts` — Add `checkoutOriginalBranch` to `startRun` return

Currently `startRun()` doesn't return a way to get back to the original branch. The execution screen needs to restore the original branch when the user abandons. Add the original branch name to the return value:

**Current return type:**
```typescript
return { runId, runDir, state }
```

**New return type:**
```typescript
return { runId, runDir, state, originalBranch: originalBranchName }
```

The ExecutionScreen can use this to checkout the original branch on abandon:

```typescript
onAbandon={() => {
  checkoutBranch(cwd, originalBranch).catch(() => {})
  navigate("home")
}}
```

Import `checkoutBranch` from `git.ts` in the ExecutionScreen.

---

## Implementation Order

Execute these steps in order. Each step should pass `bun lint && bun typecheck` before proceeding.

### Step 1: Add AbortSignal to measurement

1. Modify `runMeasurement()` in `measure.ts` — add optional `signal` parameter with early-exit check and process kill wiring
2. Modify `runMeasurementSeries()` in `measure.ts` — add optional `signal` parameter, check before each run, forward to `runMeasurement()`
3. Run `bun lint && bun typecheck`

### Step 2: Forward signal through experiment loop

1. Add `signal` parameter to `maybeRebaseline()` in `experiment-loop.ts`, forward to `runMeasurementSeries()`
2. Add `signal` parameter to `runMeasurementAndDecide()` in `experiment-loop.ts`, forward to `runMeasurementSeries()`
3. Update all call sites in `runExperimentLoop()` to pass `options.signal`
4. Run `bun lint && bun typecheck`

### Step 3: Add abort-aware cleanup to experiment loop

1. Add the abort detection block after `runExperimentAgent()` returns (section 2b)
2. Add the abort check after `runMeasurementAndDecide()` returns (section 2c)
3. Run `bun lint && bun typecheck`

### Step 4: Add loop completion callback + event

1. Add `onLoopComplete` to `LoopCallbacks` interface in `experiment-loop.ts`
2. Add `"loop_complete"` to `LoopEventType` and `logLoopComplete` to `EventLogger` in `events.ts`
3. Fire `onLoopComplete` and `logLoopComplete` in the finalization block of `runExperimentLoop()`
4. Wire the wrapped callback in the `wrappedCallbacks` object
5. Run `bun lint && bun typecheck`

### Step 5: Add `max_experiments` to ProgramConfig + return original branch from startRun

1. Add optional `max_experiments` to `ProgramConfig` in `programs.ts`
2. Add `originalBranch` to `startRun()` return value in `run.ts`
3. Run `bun lint && bun typecheck`

### Step 6: Create RunCompletePrompt component

1. Create `src/components/RunCompletePrompt.tsx` with the component from section 8
2. Run `bun lint && bun typecheck`

### Step 7: Create ExecutionScreen

1. Create `src/screens/ExecutionScreen.tsx` with the component from section 7
2. Import and use `RunCompletePrompt`, `startRun`, `runExperimentLoop`, `LoopCallbacks`, etc.
3. Run `bun lint && bun typecheck`

### Step 8: Wire up App.tsx + HomeScreen

1. Add `selectedProgram` state and execution screen rendering to `App.tsx` (section 5)
2. Add `onSelectProgram` prop and Enter key handler to `HomeScreen.tsx` (section 6)
3. Update status bar text for all screens
4. Run `bun lint && bun typecheck`

### Step 9: Final verification

1. Run `bun lint && bun typecheck`
2. Test with tmux:
   ```bash
   tmux new-session -d -s autoauto -x 120 -y 40 'bun dev'
   tmux capture-pane -t autoauto -p  # verify home screen loads
   ```
3. Verify:
   - Screen navigation: home → execution (Enter on a program)
   - Abort key (`q`) triggers abort flow
   - Post-run prompt renders after completion/abort
   - Post-run prompt keyboard navigation works
   - Escape from post-run prompt goes back to home

---

## Edge Cases

### Abort fires before agent spawns
**Handling:** The abort check at the top of the while loop catches this. State is set to "stopping" and loop breaks.

### Abort fires during agent execution, agent already committed
**Handling:** The new abort detection block (section 2b) catches this. It calls `revertToStart()` which uses `git revert` (preserving history) or `git reset --hard` (fallback). The commit is reverted, and a crash row is logged.

### Abort fires during measurement (after agent committed)
**Handling:** `runMeasurementSeries()` returns failure because the measurement process was killed. `runMeasurementAndDecide()` handles this as a measurement failure (reverts the commit). After it returns, the new abort check (section 2c) sees the abort and breaks the loop.

### Abort fires during re-baseline
**Handling:** `maybeRebaseline()` calls `runMeasurementSeries()` which returns failure on abort. The function returns the old state unchanged. The loop continues to the next iteration where it catches the abort and breaks.

### Agent leaves uncommitted changes (files created/modified but not committed)
**Handling:** The abort detection block (section 2b) checks `isWorkingTreeClean()`. If dirty, it calls `resetHard(projectRoot, startSha)` which discards all uncommitted changes.

### User presses abort multiple times rapidly
**Handling:** `AbortController.abort()` is idempotent — calling it multiple times is safe. The signal stays aborted.

### `startRun()` fails (dirty working tree, baseline failure)
**Handling:** The ExecutionScreen's useEffect catches the error and sets `phase: "error"`. The error is displayed, and the user can press Escape to go back to home.

### User navigates away from execution screen during run
**Handling:** The useEffect cleanup function calls `abortController.abort()`, which terminates the agent and measurement. The loop cleans up and exits. The screen is already unmounted, so state updates are ignored (guarded by `cancelled` flag).

### No programs exist when user presses Enter on HomeScreen
**Handling:** The Enter key handler checks `programs.length > 0` before calling `onSelectProgram`.

### Run completes normally but error during cleanup (unlock evaluator, write final state)
**Handling:** These operations are best-effort. `unlockEvaluator` restores write permissions — if it fails, the files stay read-only (fixable manually). `writeState` failure means state.json is stale — the run dir still has results.tsv which is the durable record.

---

## What This Phase Does NOT Include

- **Full execution dashboard** → Phase 2f (sparkline, results table, streaming agent text, metric chart)
- **Stop-after-current mode** → Phase 4 (daemon adds graceful stop via control.json)
- **Cleanup agent** → Phase 3 (the "run cleanup" option is a placeholder that navigates home)
- **Run from program detail screen** → Phase 2f adds the program detail screen; for now, Enter on home starts a run directly
- **Configurable max experiments in setup flow** → Future enhancement; setup agent can recommend it
- **Process group killing** → Phase 4 (daemon tracks child process groups for thorough cleanup)
- **Multiple concurrent runs** → Phase 4 (one run at a time for now)
- **Resume after crash** → Phase 4 (daemon reads state.json on restart)

---

## Key Design Decisions

### Why abort-current only, not stop-after-current?

Phase 2 runs the loop in the TUI process. The user is watching and can decide when to stop. "Kill immediately" is the expected behavior — if you press Stop, you want it to stop now. The distinction becomes important in Phase 4 where the daemon runs detached: you might SSH in to a running experiment and want to let it finish gracefully before stopping.

Adding stop-after-current in Phase 2 requires:
- Additional UI to choose between stop modes
- A separate signal mechanism (boolean flag or second AbortController)
- UX questions about what "stop" means in the status bar

None of this is hard, but it's unnecessary complexity. Phase 4 adds it naturally as part of the daemon control mechanism.

### Why kill measurement processes on abort?

Measurement can take 30–60 seconds (multiple repeats × measurement duration). If the user presses abort and nothing happens for 60 seconds, they'll think the TUI is frozen. Killing the measurement process makes abort feel responsive.

The trade-off: killed measurement processes may leave temporary files or dangling subprocesses (e.g., a dev server started by measure.sh). This is acceptable because:
1. We're on an experiment branch — temporary files don't pollute the user's working copy
2. measure.sh should be idempotent (it runs hundreds of times)
3. Phase 4's process group killing will handle this more thoroughly

### Why show a minimal execution view instead of waiting for Phase 2f?

Phase 2e must be testable. The user needs to see that the loop is running, press abort, and see the post-run prompt. A blank screen during execution is unacceptable UX. The minimal view (experiment number, phase label, basic stats) is enough to verify everything works without building the full dashboard.

Phase 2f enhances this view with the sparkline, results table, and streaming agent output. The component structure (ExecutionScreen wrapper + content) supports this — 2f adds more content inside the same wrapper.

### Why `q` for abort and not Escape?

Escape means "go back" in every other screen. During a multi-hour execution run, accidentally pressing Escape and killing the run would be catastrophic. `q` (quit) is deliberate — you don't accidentally press `q`. `Ctrl+C` is also supported as the universal "kill" shortcut.

After the run completes, Escape goes back to home (standard navigation). This keeps the UX consistent.

### Why return `originalBranch` from `startRun()`?

The user started on a branch (e.g., `main`). `startRun()` creates and checks out an experiment branch. When the user abandons, we should restore their original branch. Without this, they'd be stranded on the experiment branch.

The alternative — always checking out `main` — is wrong because the user might have been on a feature branch. Storing the original branch name in the return value is the simplest correct approach.

---

## Updates to CLAUDE.md

Add these bullets to the **Agent Conventions** section:

```markdown
- Abort cleanup: after agent abort, revert committed changes and reset uncommitted changes before exiting the loop
- `runMeasurement()` and `runMeasurementSeries()` accept optional AbortSignal to kill measurement processes on abort
- `LoopCallbacks.onLoopComplete` fires when the loop exits with the termination reason
- `ProgramConfig.max_experiments` is optional — defaults to unlimited if not set
- ExecutionScreen: press `q` or `Ctrl+C` to abort the current experiment; `Escape` goes back only after completion
- RunCompletePrompt: choose "run cleanup" (Phase 3) or "abandon" (keep branch as-is) after loop ends
```

Update the **Project Structure** section to add new files:

```markdown
  screens/
    ExecutionScreen.tsx  # Execution wrapper: starts run, handles abort, shows post-run prompt
  components/
    RunCompletePrompt.tsx  # Post-run dialog: cleanup or abandon
```

Update the **OpenTUI Conventions** section to add:

```markdown
- For modal-like focus, use state guards in `useKeyboard` — check a boolean before processing keys
```

---

## Updates to `docs/architecture.md`

### Screen Navigation section

Add `ExecutionScreen` to the screen descriptions:

```markdown
- **ExecutionScreen** — runs the experiment loop: starts run, displays minimal progress, handles abort via `q`/`Ctrl+C`, shows post-run prompt (cleanup or abandon) on completion
```

Update the screen navigation description:

```markdown
`App.tsx` manages a `Screen` state (`"home" | "setup" | "settings" | "execution"`) and renders the active screen. `selectedProgram` state tracks which program is being executed. HomeScreen Enter key starts execution; ExecutionScreen runs the loop and shows the post-run prompt.
```

### Components section

Add:

```markdown
- **RunCompletePrompt** (`src/components/RunCompletePrompt.tsx`) — Post-run dialog with run summary and two choices: "Run cleanup" (Phase 3 placeholder) or "Abandon" (keep branch, return to home). Uses `getRunStats()` for derived statistics.
```

### Experiment Loop section

Update the abort handling description:

```markdown
- Abort-aware: when signal fires mid-experiment, reverts any committed/uncommitted changes, logs crash with "aborted by user", and breaks
- AbortSignal forwarded to `runMeasurementSeries()` to kill measurement processes on abort
- `onLoopComplete` callback fires with termination reason: "aborted", "max_experiments", or "stopped"
```

### Current State section

Add:

```markdown
Phase 2e (Run Termination) adds abort handling for mid-experiment interruption (with git cleanup), AbortSignal support in measurement, the ExecutionScreen (minimal run view with abort key handling), and the RunCompletePrompt (post-run cleanup/abandon dialog).
```

---

## Updates to README.md

No updates needed. The README doesn't describe implementation details at this level. Phase 2f (TUI dashboard) or Phase 3 (cleanup) are better points to update the README with user-facing features.

---

## Diff Summary

**Files modified: 6**
- `src/lib/measure.ts` — AbortSignal support (~15 lines added)
- `src/lib/experiment-loop.ts` — abort cleanup, signal forwarding, onLoopComplete (~50 lines added, ~10 lines modified)
- `src/lib/events.ts` — loop_complete event type (~10 lines added)
- `src/lib/programs.ts` — max_experiments field (~1 line added)
- `src/lib/run.ts` — originalBranch return (~2 lines modified)
- `src/App.tsx` — execution screen routing, selectedProgram state (~20 lines added, ~5 lines modified)
- `src/screens/HomeScreen.tsx` — Enter key + onSelectProgram prop (~5 lines added, ~3 lines modified)

**Files created: 2**
- `src/screens/ExecutionScreen.tsx` (~120 lines)
- `src/components/RunCompletePrompt.tsx` (~80 lines)

**Estimated total diff size:** ~310 lines added, ~20 lines modified

**No new dependencies.** All functionality uses existing libraries (React, OpenTUI, Claude Agent SDK) and internal modules.

---

## [NEW] Review Notes

This plan was reviewed against the current codebase state and API patterns. Key correction:

- **Fixed (RED):** `RunCompletePrompt` called `getRunStats(state)` but the function signature from phase 2d is `getRunStats(results: ExperimentResult[], state: RunState)` — requires a results array the component doesn't have. Fixed by computing stats inline from `RunState` directly. All needed values (total_keeps, total_discards, total_crashes, keep_rate, improvement_pct) are derivable from `RunState` without reading results.tsv.
- **Verified:** measure.ts uses Node's `child_process.spawn` (not Bun.spawn) — the plan's abort signal wiring (`proc.kill("SIGTERM")`, `proc.on("close")`, `proc.on("error")`) is compatible with this API.
- **Verified:** `revertToStart()` exists in experiment-loop.ts as a private helper (lines 58-61). `exitOnCtrlC: false` is set in index.tsx. `startRun()` captures `originalBranchName` internally but doesn't return it — plan correctly adds it to the return value.
- **Verified:** All files to be created (ExecutionScreen, RunCompletePrompt) don't exist yet. All files to be modified (measure.ts, experiment-loop.ts, events.ts, programs.ts, run.ts, App.tsx, HomeScreen.tsx) exist with the expected structure.
