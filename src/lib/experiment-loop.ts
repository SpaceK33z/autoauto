import { join } from "node:path"
import type { RunState, ExperimentResult } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import { getProgramDir } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import {
  readState,
  writeState,
  appendResult,
  unlockEvaluator,
} from "./run.ts"
import {
  getFullSha,
  revertCommits,
  resetHard,
  isWorkingTreeClean,
  countCommitsBetween,
} from "./git.ts"
import {
  runMeasurementSeries,
  compareMetric,
} from "./measure.ts"
import {
  buildContextPacket,
  buildExperimentPrompt,
  runExperimentAgent,
  checkLockViolation,
} from "./experiment.ts"
import { getExperimentSystemPrompt } from "./system-prompts.ts"
import { createEventLogger } from "./events.ts"

/** Re-measure baseline after this many consecutive discards to check for environment drift. */
const REBASELINE_AFTER_DISCARDS = 5

// --- Types ---

/** Callback for the TUI to receive live updates */
export interface LoopCallbacks {
  onPhaseChange: (phase: RunState["phase"], detail?: string) => void
  onExperimentStart: (experimentNumber: number) => void
  onExperimentEnd: (result: ExperimentResult) => void
  onStateUpdate: (state: RunState) => void
  onAgentStream: (text: string) => void
  onAgentToolUse: (status: string) => void
  onError: (error: string) => void
  onRebaseline?: (oldBaseline: number, newBaseline: number, reason: string) => void
  onLoopComplete?: (state: RunState, reason: "aborted" | "max_experiments" | "stopped") => void
}

/** Options to control the experiment loop */
export interface LoopOptions {
  maxExperiments?: number
  signal?: AbortSignal
}

// --- Helpers ---

const now = () => new Date().toISOString()

async function revertToStart(projectRoot: string, startSha: string, candidateSha: string): Promise<void> {
  const reverted = await revertCommits(projectRoot, startSha, candidateSha)
  if (!reverted) await resetHard(projectRoot, startSha)
}

async function maybeRebaseline(
  consecutiveDiscards: number,
  measureShPath: string,
  projectRoot: string,
  config: ProgramConfig,
  state: RunState,
  runDir: string,
  callbacks: LoopCallbacks,
  signal?: AbortSignal,
): Promise<RunState> {
  if (consecutiveDiscards <= 0 || consecutiveDiscards % REBASELINE_AFTER_DISCARDS !== 0) {
    return state
  }

  callbacks.onPhaseChange("measuring", `re-baselining after ${consecutiveDiscards} consecutive discards`)
  const driftCheck = await runMeasurementSeries(measureShPath, projectRoot, config, signal)

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

// --- Measurement + Decision ---

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
  signal?: AbortSignal,
): Promise<{ state: RunState; kept: boolean }> {

  // 1. Measure
  callbacks.onPhaseChange("measuring")
  let currentState: RunState = { ...state, phase: "measuring", updated_at: now() }
  await writeState(runDir, currentState)

  const series = await runMeasurementSeries(measureShPath, projectRoot, config, signal)

  // 2. Handle measurement failure
  if (!series.success) {
    callbacks.onPhaseChange("reverting", "measurement failed")
    currentState = { ...currentState, phase: "reverting", updated_at: now() }
    await writeState(runDir, currentState)

    await revertToStart(projectRoot, startSha, candidateSha)

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: 0,
      secondary_values: "",
      status: "measurement_failure",
      description: `measurement failed: ${description}`,
    }
    await appendResult(runDir, result)
    callbacks.onExperimentEnd(result)

    const finalState: RunState = {
      ...currentState,
      total_crashes: currentState.total_crashes + 1,
      candidate_sha: null,
      phase: "idle",
      updated_at: now(),
    }
    await writeState(runDir, finalState)
    return { state: finalState, kept: false }
  }

  // 3. Check quality gates
  if (!series.quality_gates_passed) {
    callbacks.onPhaseChange("reverting", `quality gate: ${series.gate_violations.join(", ")}`)
    currentState = { ...currentState, phase: "reverting", updated_at: now() }
    await writeState(runDir, currentState)

    await revertToStart(projectRoot, startSha, candidateSha)

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: series.median_metric,
      secondary_values: JSON.stringify(series.median_quality_gates),
      status: "discard",
      description: `quality gate failed: ${description}`,
    }
    await appendResult(runDir, result)
    callbacks.onExperimentEnd(result)

    const finalState: RunState = {
      ...currentState,
      total_discards: currentState.total_discards + 1,
      candidate_sha: null,
      phase: "idle",
      updated_at: now(),
    }
    await writeState(runDir, finalState)
    return { state: finalState, kept: false }
  }

  // 4. Compare against baseline
  const verdict = compareMetric(
    state.current_baseline,
    series.median_metric,
    config.noise_threshold,
    config.direction,
  )

  if (verdict === "improved") {
    // KEEP
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
    const rebaseline = await runMeasurementSeries(measureShPath, projectRoot, config, signal)
    const newBaseline = rebaseline.success ? rebaseline.median_metric : series.median_metric

    if (rebaseline.success && newBaseline !== series.median_metric) {
      callbacks.onRebaseline?.(series.median_metric, newBaseline, "keep")
    }

    const finalState: RunState = {
      ...currentState,
      total_keeps: currentState.total_keeps + 1,
      current_baseline: newBaseline,
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

  // DISCARD (regressed or noise)
  const reason = verdict === "regressed" ? "regressed" : "within noise"
  callbacks.onPhaseChange("reverting", `${reason}: ${state.current_baseline} → ${series.median_metric}`)

  currentState = { ...currentState, phase: "reverting", updated_at: now() }
  await writeState(runDir, currentState)

  await revertToStart(projectRoot, startSha, candidateSha)

  const statusDesc = verdict === "regressed" ? description : `noise: ${description}`

  const result: ExperimentResult = {
    experiment_number: state.experiment_number,
    commit: candidateSha.slice(0, 7),
    metric_value: series.median_metric,
    secondary_values: JSON.stringify(series.median_quality_gates),
    status: "discard",
    description: statusDesc,
  }
  await appendResult(runDir, result)
  callbacks.onExperimentEnd(result)

  const finalState: RunState = {
    ...currentState,
    total_discards: currentState.total_discards + 1,
    candidate_sha: null,
    phase: "idle",
    updated_at: now(),
  }
  await writeState(runDir, finalState)
  return { state: finalState, kept: false }
}

// --- Main Experiment Loop ---

/**
 * The main experiment loop. Called after startRun() has established the baseline.
 * Iterates: build context → spawn agent → check locks → measure → decide → repeat.
 */
export async function runExperimentLoop(
  projectRoot: string,
  programSlug: string,
  runDir: string,
  config: ProgramConfig,
  modelConfig: ModelSlot,
  callbacks: LoopCallbacks,
  options: LoopOptions = {},
): Promise<RunState> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const measureShPath = join(programDir, "measure.sh")
  let state = await readState(runDir)
  let consecutiveDiscards = 0

  // Event logger: persists structural events to events.ndjson alongside in-memory callbacks
  const eventLogger = createEventLogger(runDir, () => state.experiment_number)
  void eventLogger.logRunStart(state)

  // Wrap callbacks to emit events alongside TUI updates
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
    onStateUpdate: callbacks.onStateUpdate,
    onAgentStream: callbacks.onAgentStream,
    onLoopComplete: callbacks.onLoopComplete,
  }

  while (true) {
    // --- Check stop conditions ---
    if (options.signal?.aborted) {
      state = { ...state, phase: "stopping", updated_at: now() }
      await writeState(runDir, state)
      wrappedCallbacks.onPhaseChange("stopping", "manually stopped")
      break
    }

    // Warn on consecutive discards — agent may be stuck
    if (consecutiveDiscards >= 10) {
      wrappedCallbacks.onError(`Warning: ${consecutiveDiscards} consecutive discards. Agent may be stuck — consider stopping and reviewing results.`)
    }

    if (options.maxExperiments && state.experiment_number >= options.maxExperiments) {
      state = { ...state, phase: "complete", updated_at: now() }
      await writeState(runDir, state)
      wrappedCallbacks.onPhaseChange("complete", `reached max experiments (${options.maxExperiments})`)
      break
    }

    // --- Start new experiment ---
    const experimentNumber = state.experiment_number + 1
    wrappedCallbacks.onExperimentStart(experimentNumber)

    state = { ...state, phase: "agent_running", experiment_number: experimentNumber, updated_at: now() }
    await writeState(runDir, state)
    wrappedCallbacks.onPhaseChange("agent_running")
    wrappedCallbacks.onStateUpdate(state)

    // --- Build context packet ---
    const packet = await buildContextPacket(
      projectRoot, programDir, runDir, state, config,
    )
    const systemPrompt = getExperimentSystemPrompt(packet.program_md)
    const userPrompt = buildExperimentPrompt(packet)

    // --- Spawn experiment agent ---
    const startSha = await getFullSha(projectRoot)

    const outcome = await runExperimentAgent(
      projectRoot,
      systemPrompt,
      userPrompt,
      modelConfig,
      startSha,
      (text) => wrappedCallbacks.onAgentStream(text),
      (status) => wrappedCallbacks.onAgentToolUse(status),
      options.signal,
    )

    // Log cost data if available
    if (outcome.cost) {
      void eventLogger.logExperimentCost(outcome.cost)
    }

    // --- Abort detection + cleanup ---
    if (options.signal?.aborted) {
      wrappedCallbacks.onPhaseChange("stopping", "aborted by user")

      const currentSha = await getFullSha(projectRoot)
      if (currentSha !== startSha) {
        await revertToStart(projectRoot, startSha, currentSha)
      } else if (!(await isWorkingTreeClean(projectRoot))) {
        await resetHard(projectRoot, startSha)
      }

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

    // --- Handle no-commit or error (no code change — skip drift check) ---
    if (outcome.type === "no_commit" || outcome.type === "agent_error") {
      const crashDesc = outcome.type === "no_commit"
        ? "no commit produced"
        : `agent error: ${outcome.error}`
      const crashResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: startSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: crashDesc,
      }
      await appendResult(runDir, crashResult)
      wrappedCallbacks.onExperimentEnd(crashResult)

      state = { ...state, total_crashes: state.total_crashes + 1, phase: "idle", updated_at: now() }
      await writeState(runDir, state)
      wrappedCallbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    // --- Agent committed. Use SHA from outcome. ---
    const candidateSha = outcome.sha
    state = { ...state, candidate_sha: candidateSha, updated_at: now() }
    await writeState(runDir, state)

    // --- Check lock violation ---
    const lockCheck = checkLockViolation(outcome.files_changed)
    if (lockCheck.violated) {
      wrappedCallbacks.onPhaseChange("reverting", `lock violation: ${lockCheck.files.join(", ")}`)

      state = { ...state, phase: "reverting", updated_at: now() }
      await writeState(runDir, state)

      await revertToStart(projectRoot, startSha, candidateSha)

      const lockResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: candidateSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "discard",
        description: `lock violation: modified ${lockCheck.files.join(", ")} — ${outcome.description}`,
      }
      await appendResult(runDir, lockResult)
      wrappedCallbacks.onExperimentEnd(lockResult)

      state = { ...state, total_discards: state.total_discards + 1, candidate_sha: null, phase: "idle", updated_at: now() }
      await writeState(runDir, state)
      wrappedCallbacks.onStateUpdate(state)
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, projectRoot, config, state, runDir, wrappedCallbacks, options.signal)
      continue
    }

    // --- Check commit count (warn if multiple) ---
    const commitCount = await countCommitsBetween(projectRoot, startSha, candidateSha)
    if (commitCount > 1) {
      wrappedCallbacks.onError(`Warning: agent made ${commitCount} commits (expected 1). Proceeding with measurement.`)
    }

    // --- Hand off to measurement ---
    const measurementResult = await runMeasurementAndDecide(
      projectRoot, runDir, measureShPath,
      config, state, startSha, candidateSha, outcome.description,
      wrappedCallbacks, options.signal,
    )

    // Check if abort fired during measurement
    if (options.signal?.aborted) {
      state = { ...measurementResult.state, phase: "stopping", updated_at: now() }
      await writeState(runDir, state)
      break
    }

    state = measurementResult.state
    if (measurementResult.kept) {
      consecutiveDiscards = 0
    } else {
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, projectRoot, config, state, runDir, wrappedCallbacks, options.signal)
    }

    wrappedCallbacks.onStateUpdate(state)
  }

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
  await eventLogger.logLoopComplete(finalState, reason)
  wrappedCallbacks.onLoopComplete?.(finalState, reason)

  return finalState
}
