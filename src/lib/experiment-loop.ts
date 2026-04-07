import { chmod, readFile, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { RunState, ExperimentResult } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import { getProgramDir } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import {
  readState,
  writeState,
  appendResult,
  unlockMeasurement,
} from "./run.ts"
import {
  getFullSha,
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
  type ExperimentCost,
} from "./experiment.ts"
import { getExperimentSystemPrompt } from "./system-prompts.ts"
import { createEventLogger } from "./events.ts"

/** Re-measure baseline after this many consecutive discards to check for environment drift. */
const REBASELINE_AFTER_DISCARDS = 5

// --- Types ---

export type TerminationReason = "aborted" | "max_experiments" | "stopped"

/** Callback for the TUI to receive live updates */
export interface LoopCallbacks {
  onPhaseChange: (phase: RunState["phase"], detail?: string) => void
  onExperimentStart: (experimentNumber: number) => void
  onExperimentEnd: (result: ExperimentResult) => void
  onStateUpdate: (state: RunState) => void
  onAgentStream: (text: string) => void
  onAgentToolUse: (status: string) => void
  onError: (error: string) => void
  onExperimentCost?: (cost: ExperimentCost) => void
  onRebaseline?: (oldBaseline: number, newBaseline: number, reason: string) => void
  onLoopComplete?: (state: RunState, reason: TerminationReason) => void
}

/** Options to control the experiment loop */
export interface LoopOptions {
  maxExperiments?: number
  signal?: AbortSignal
}

// --- Helpers ---

const now = () => new Date().toISOString()

interface MeasurementFileSnapshot {
  path: string
  label: string
  content: string
}

async function readMeasurementSnapshot(
  programDir: string,
  projectRoot: string,
): Promise<MeasurementFileSnapshot[]> {
  const paths = [join(programDir, "measure.sh"), join(programDir, "config.json"), join(programDir, "build.sh")]
  const results = await Promise.all(paths.map(async (path) => {
    try {
      const content = await readFile(path, "utf-8")
      return { path, label: relative(projectRoot, path), content }
    } catch {
      return null // build.sh may not exist
    }
  }))
  return results.filter((r): r is MeasurementFileSnapshot => r !== null)
}

async function getMeasurementViolations(snapshot: MeasurementFileSnapshot[]): Promise<string[]> {
  const checks = await Promise.all(snapshot.map(async (file) => {
    try {
      const [current, info] = await Promise.all([readFile(file.path, "utf-8"), stat(file.path)])
      if (current !== file.content || (info.mode & 0o222) !== 0) {
        return file.label
      }
    } catch {
      return file.label
    }
    return null
  }))

  return checks.filter((file): file is string => file !== null)
}

async function restoreMeasurementSnapshot(snapshot: MeasurementFileSnapshot[]): Promise<void> {
  await Promise.all(snapshot.map(async (file) => {
    await chmod(file.path, 0o644).catch(() => {})
    await writeFile(file.path, file.content)
    await chmod(file.path, 0o444)
  }))
}

async function resetAndVerify(projectRoot: string, startSha: string, errorContext: string): Promise<void> {
  await resetHard(projectRoot, startSha)
  if (!(await isWorkingTreeClean(projectRoot))) {
    throw new Error(`Working tree still dirty after ${errorContext}; stopping to avoid contaminating the next experiment.`)
  }
}

async function maybeRebaseline(
  consecutiveDiscards: number,
  measureShPath: string,
  buildShPath: string,
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
  const driftCheck = await runMeasurementSeries(measureShPath, projectRoot, config, signal, buildShPath)

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
  buildShPath: string,
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

  const series = await runMeasurementSeries(measureShPath, projectRoot, config, signal, buildShPath)

  // 2. Handle measurement failure
  if (!series.success) {
    const failureReason = series.failure_reason ?? "unknown measurement error"
    callbacks.onPhaseChange("reverting", "measurement failed")
    currentState = { ...currentState, phase: "reverting", updated_at: now() }
    await writeState(runDir, currentState)

    await resetAndVerify(projectRoot, startSha, "measurement failure reset")

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: 0,
      secondary_values: "",
      status: "measurement_failure",
      description: `measurement failed (${failureReason}): ${description}`,
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

    await resetAndVerify(projectRoot, startSha, "quality gate failure reset")

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

  if (verdict === "keep") {
    // KEEP
    callbacks.onPhaseChange("kept", `keep: ${state.current_baseline} → ${series.median_metric}`)

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
    const rebaseline = await runMeasurementSeries(measureShPath, projectRoot, config, signal, buildShPath)
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

  await resetAndVerify(projectRoot, startSha, "discard reset")

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
  const buildShPath = join(programDir, "build.sh")
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

  try {
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
    const measurementSnapshot = await readMeasurementSnapshot(programDir, projectRoot)

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

    // Log cost data if available + accumulate tokens on run state
    if (outcome.cost) {
      void eventLogger.logExperimentCost(outcome.cost)
      callbacks.onExperimentCost?.(outcome.cost)
      state = {
        ...state,
        total_tokens: (state.total_tokens ?? 0) + outcome.cost.input_tokens + outcome.cost.output_tokens,
      }
      await writeState(runDir, state)
    }

    // --- Abort detection + cleanup ---
    if (options.signal?.aborted) {
      wrappedCallbacks.onPhaseChange("stopping", "aborted by user")

      await restoreMeasurementSnapshot(measurementSnapshot)
      await resetAndVerify(projectRoot, startSha, "abort cleanup")

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

    // --- Handle no-commit or error (no code change) ---
    if (outcome.type === "no_commit" || outcome.type === "agent_error") {
      const measurementViolations = await getMeasurementViolations(measurementSnapshot)
      if (measurementViolations.length > 0) {
        await restoreMeasurementSnapshot(measurementSnapshot)
      }

      await resetAndVerify(projectRoot, startSha, "failed experiment cleanup")

      const isLockViolation = measurementViolations.length > 0
      const crashDesc = isLockViolation
        ? `lock violation: modified ${measurementViolations.join(", ")}`
        : outcome.type === "no_commit"
          ? "no commit produced"
          : `agent error: ${outcome.error}`
      const crashResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: startSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: isLockViolation ? "discard" : "crash",
        description: crashDesc,
      }
      await appendResult(runDir, crashResult)
      wrappedCallbacks.onExperimentEnd(crashResult)

      state = {
        ...state,
        total_crashes: isLockViolation ? state.total_crashes : state.total_crashes + 1,
        total_discards: isLockViolation ? state.total_discards + 1 : state.total_discards,
        candidate_sha: null,
        phase: "idle",
        updated_at: now(),
      }
      await writeState(runDir, state)
      wrappedCallbacks.onStateUpdate(state)
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, buildShPath, projectRoot, config, state, runDir, wrappedCallbacks, options.signal)
      continue
    }

    // --- Agent committed. Use SHA from outcome. ---
    const candidateSha = outcome.sha
    state = { ...state, candidate_sha: candidateSha, updated_at: now() }
    await writeState(runDir, state)

    if (!(await isWorkingTreeClean(projectRoot))) {
      await resetHard(projectRoot, candidateSha)
      if (!(await isWorkingTreeClean(projectRoot))) {
        const measurementViolations = await getMeasurementViolations(measurementSnapshot)
        if (measurementViolations.length > 0) {
          await restoreMeasurementSnapshot(measurementSnapshot)
        }
        throw new Error("Agent left uncommitted files after committing; stopping to avoid measuring a dirty worktree.")
      }
    }

    // --- Check lock violation ---
    const lockCheck = checkLockViolation(outcome.files_changed)
    const measurementViolations = await getMeasurementViolations(measurementSnapshot)
    const lockViolationFiles = [...new Set([...lockCheck.files, ...measurementViolations])]
    if (lockViolationFiles.length > 0) {
      wrappedCallbacks.onPhaseChange("reverting", `lock violation: ${lockViolationFiles.join(", ")}`)

      state = { ...state, phase: "reverting", updated_at: now() }
      await writeState(runDir, state)

      if (measurementViolations.length > 0) {
        await restoreMeasurementSnapshot(measurementSnapshot)
      }
      await resetAndVerify(projectRoot, startSha, "lock violation reset")

      const lockResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: candidateSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "discard",
        description: `lock violation: modified ${lockViolationFiles.join(", ")} — ${outcome.description}`,
      }
      await appendResult(runDir, lockResult)
      wrappedCallbacks.onExperimentEnd(lockResult)

      state = { ...state, total_discards: state.total_discards + 1, candidate_sha: null, phase: "idle", updated_at: now() }
      await writeState(runDir, state)
      wrappedCallbacks.onStateUpdate(state)
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, buildShPath, projectRoot, config, state, runDir, wrappedCallbacks, options.signal)
      continue
    }

    // --- Check commit count (warn if multiple) ---
    const commitCount = await countCommitsBetween(projectRoot, startSha, candidateSha)
    if (commitCount > 1) {
      wrappedCallbacks.onError(`Warning: agent made ${commitCount} commits (expected 1). Proceeding with measurement.`)
    }

    // --- Hand off to measurement ---
    const measurementResult = await runMeasurementAndDecide(
      projectRoot, runDir, measureShPath, buildShPath,
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
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, buildShPath, projectRoot, config, state, runDir, wrappedCallbacks, options.signal)
    }

    wrappedCallbacks.onStateUpdate(state)
  }
  } finally {
    await unlockMeasurement(programDir)
  }

  // --- Finalize ---

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
