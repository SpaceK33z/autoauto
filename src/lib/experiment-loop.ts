import { chmod } from "node:fs/promises"
import { join, relative } from "node:path"
import type { RunState, ExperimentResult, TerminationReason } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import {
  readState,
  writeState,
  appendResult,
  unlockMeasurement,
  serializeSecondaryValues,
  serializeDiffStats,
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
import type { DiffStats } from "./git.ts"
import {
  buildContextPacket,
  buildExperimentPrompt,
  runExperimentAgent,
  checkLockViolation,
  type ExperimentCost,
} from "./experiment.ts"
import { appendIdeasBacklog, type ExperimentNotes } from "./ideas-backlog.ts"
import { readRunConfig } from "./daemon-lifecycle.ts"
import { getExperimentSystemPrompt } from "./system-prompts/index.ts"

/** Re-measure baseline after this many consecutive discards to check for environment drift. */
const REBASELINE_AFTER_DISCARDS = 5

/** Default: stop after this many consecutive non-improving experiments. */
const DEFAULT_MAX_CONSECUTIVE_DISCARDS = 10

// --- Types ---

// TerminationReason is now defined in run.ts and re-exported here for backwards compat
export type { TerminationReason } from "./run.ts"

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
  maxExperiments: number
  /** Hard abort — kills agent mid-execution, reverts, crash row */
  signal?: AbortSignal
  /** Soft stop — checked at iteration boundary, finishes current experiment normally */
  stopRequested?: () => boolean
  /** Durable ideas.md experiment memory. Disable to use results.tsv/git history only. */
  ideasBacklogEnabled?: boolean
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
): Promise<MeasurementFileSnapshot[]> {
  const paths = [join(programDir, "measure.sh"), join(programDir, "config.json"), join(programDir, "build.sh")]
  const results = await Promise.all(paths.map(async (path) => {
    try {
      const file = Bun.file(path)
      if (!await file.exists()) return null // build.sh may not exist
      const content = await file.text()
      return { path, label: relative(programDir, path), content }
    } catch {
      return null
    }
  }))
  return results.filter((r): r is MeasurementFileSnapshot => r !== null)
}

async function getMeasurementViolations(snapshot: MeasurementFileSnapshot[]): Promise<string[]> {
  const checks = await Promise.all(snapshot.map(async (file) => {
    try {
      const bunFile = Bun.file(file.path)
      const current = await bunFile.text()
      // Check content changed or write permission restored (0o222 = write bits)
      // Bun.file doesn't expose mode, so use stat for permission check
      const { mode } = await Bun.file(file.path).stat()
      if (current !== file.content || (mode & 0o222) !== 0) {
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
    await Bun.write(file.path, file.content)
    await chmod(file.path, 0o444)
  }))
}

async function resetAndVerify(cwd: string, startSha: string, errorContext: string): Promise<void> {
  await resetHard(cwd, startSha)
  if (!(await isWorkingTreeClean(cwd))) {
    throw new Error(`Working tree still dirty after ${errorContext}; stopping to avoid contaminating the next experiment.`)
  }
}

async function recordIdeasBacklog(
  enabled: boolean,
  runDir: string,
  result: ExperimentResult,
  notes?: ExperimentNotes,
): Promise<void> {
  if (!enabled) return
  await appendIdeasBacklog(runDir, result, notes).catch(() => {})
}

async function maybeRebaseline(
  consecutiveDiscards: number,
  measureShPath: string,
  buildShPath: string,
  cwd: string,
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
  const driftCheck = await runMeasurementSeries(measureShPath, cwd, config, signal, buildShPath)

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
  cwd: string,
  runDir: string,
  measureShPath: string,
  buildShPath: string,
  config: ProgramConfig,
  state: RunState,
  startSha: string,
  candidateSha: string,
  description: string,
  diffStats: DiffStats | undefined,
  callbacks: LoopCallbacks,
  recordBacklog: (result: ExperimentResult) => Promise<void>,
  signal?: AbortSignal,
): Promise<{ state: RunState; kept: boolean }> {

  const diffStatsStr = serializeDiffStats(diffStats)

  // 1. Measure
  callbacks.onPhaseChange("measuring")
  let currentState: RunState = { ...state, phase: "measuring", updated_at: now() }
  await writeState(runDir, currentState)

  const series = await runMeasurementSeries(measureShPath, cwd, config, signal, buildShPath)

  // 2. Handle measurement failure
  if (!series.success) {
    const failureReason = series.failure_reason ?? "unknown measurement error"
    callbacks.onPhaseChange("reverting", "measurement failed")
    currentState = { ...currentState, phase: "reverting", updated_at: now() }
    await writeState(runDir, currentState)

    await resetAndVerify(cwd, startSha, "measurement failure reset")

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: 0,
      secondary_values: "",
      status: "measurement_failure",
      description: `measurement failed (${failureReason}): ${description}`,
      measurement_duration_ms: series.duration_ms,
      diff_stats: diffStatsStr,
    }
    await appendResult(runDir, result)
    await recordBacklog(result)
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

    await resetAndVerify(cwd, startSha, "quality gate failure reset")

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: series.median_metric,
      secondary_values: serializeSecondaryValues(series.median_quality_gates, series.median_secondary_metrics),
      status: "discard",
      description: `quality gate failed: ${description}`,
      measurement_duration_ms: series.duration_ms,
      diff_stats: diffStatsStr,
    }
    await appendResult(runDir, result)
    await recordBacklog(result)
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

  // 5. Check for simplification auto-keep: net-negative LOC within noise
  const isSimplification = verdict === "noise"
    && diffStats != null
    && diffStats.lines_removed > diffStats.lines_added

  if (verdict === "keep" || isSimplification) {
    // KEEP (metric improvement or simplification)
    const keepReason = isSimplification ? "simplification" : "keep"
    const keepDesc = isSimplification ? `simplification: ${description}` : description
    callbacks.onPhaseChange("kept", `${keepReason}: ${state.current_baseline} → ${series.median_metric}`)

    const isBest = !isSimplification && (config.direction === "lower"
      ? series.median_metric < state.best_metric
      : series.median_metric > state.best_metric)

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: series.median_metric,
      secondary_values: serializeSecondaryValues(series.median_quality_gates, series.median_secondary_metrics),
      status: "keep",
      description: keepDesc,
      measurement_duration_ms: series.duration_ms,
      diff_stats: diffStatsStr,
    }
    await appendResult(runDir, result)
    await recordBacklog(result)
    callbacks.onExperimentEnd(result)

    // Re-baseline: fresh measurement on the kept code
    callbacks.onPhaseChange("measuring", `re-baselining after ${keepReason}`)
    const rebaseline = await runMeasurementSeries(measureShPath, cwd, config, signal, buildShPath)
    const newBaseline = rebaseline.success ? rebaseline.median_metric : series.median_metric

    if (rebaseline.success && newBaseline !== series.median_metric) {
      callbacks.onRebaseline?.(series.median_metric, newBaseline, keepReason)
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

  // DISCARD (regressed or noise without simplification)
  const reason = verdict === "regressed" ? "regressed" : "within noise"
  callbacks.onPhaseChange("reverting", `${reason}: ${state.current_baseline} → ${series.median_metric}`)

  currentState = { ...currentState, phase: "reverting", updated_at: now() }
  await writeState(runDir, currentState)

  await resetAndVerify(cwd, startSha, "discard reset")

  const statusDesc = verdict === "regressed" ? description : `noise: ${description}`

  const result: ExperimentResult = {
    experiment_number: state.experiment_number,
    commit: candidateSha.slice(0, 7),
    metric_value: series.median_metric,
    secondary_values: serializeSecondaryValues(series.median_quality_gates, series.median_secondary_metrics),
    status: "discard",
    description: statusDesc,
    measurement_duration_ms: series.duration_ms,
    diff_stats: diffStatsStr,
  }
  await appendResult(runDir, result)
  await recordBacklog(result)
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
  cwd: string,
  programDir: string,
  runDir: string,
  config: ProgramConfig,
  modelConfig: ModelSlot,
  callbacks: LoopCallbacks,
  options: LoopOptions,
): Promise<RunState> {
  const measureShPath = join(programDir, "measure.sh")
  const buildShPath = join(programDir, "build.sh")
  let state = await readState(runDir)
  let consecutiveDiscards = 0
  const ideasBacklogEnabled = options.ideasBacklogEnabled ?? true
  const maxConsecutiveDiscards = config.max_consecutive_discards ?? DEFAULT_MAX_CONSECUTIVE_DISCARDS

  // Re-read from run-config.json each iteration to support mid-run TUI changes
  let effectiveMaxExperiments = options.maxExperiments

  try {
  while (true) {
    const runConfig = await readRunConfig(runDir)
    if (runConfig) effectiveMaxExperiments = runConfig.max_experiments

    // --- Check stop conditions ---
    if (options.signal?.aborted) {
      state = { ...state, phase: "stopping", updated_at: now() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("stopping", "aborted")
      break
    }

    if (options.stopRequested?.()) {
      state = { ...state, phase: "stopping", updated_at: now() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("stopping", "stop requested — finishing after current experiment")
      break
    }

    // Stagnation detection — stop after too many consecutive non-improving experiments
    if (consecutiveDiscards >= maxConsecutiveDiscards) {
      state = { ...state, phase: "stopping", updated_at: now() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("stopping", `stagnation — ${consecutiveDiscards} consecutive discards with no improvement`)
      break
    }

    // Warn once at ~2/3 of the stagnation limit
    const warningThreshold = Math.floor(maxConsecutiveDiscards * 2 / 3)
    if (warningThreshold > 0 && consecutiveDiscards === warningThreshold) {
      callbacks.onError(`Warning: ${consecutiveDiscards}/${maxConsecutiveDiscards} consecutive discards. Agent may be stuck — consider stopping and reviewing results.`)
    }

    if (effectiveMaxExperiments && state.experiment_number >= effectiveMaxExperiments) {
      state = { ...state, phase: "complete", updated_at: now() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("complete", `reached max experiments (${effectiveMaxExperiments})`)
      break
    }

    // --- Start new experiment ---
    const experimentNumber = state.experiment_number + 1
    callbacks.onExperimentStart(experimentNumber)

    state = { ...state, phase: "agent_running", experiment_number: experimentNumber, updated_at: now() }
    await writeState(runDir, state)
    callbacks.onPhaseChange("agent_running")
    callbacks.onStateUpdate(state)

    // --- Build context packet ---
    const packet = await buildContextPacket(
      cwd, programDir, runDir, state, config, { ideasBacklogEnabled, consecutiveDiscards, maxConsecutiveDiscards },
    )
    const systemPrompt = getExperimentSystemPrompt(packet.program_md, { ideasBacklogEnabled })
    const userPrompt = buildExperimentPrompt(packet)

    // --- Spawn experiment agent ---
    const startSha = await getFullSha(cwd)
    const measurementSnapshot = await readMeasurementSnapshot(programDir)

    const outcome = await runExperimentAgent(
      cwd,
      systemPrompt,
      userPrompt,
      modelConfig,
      startSha,
      (text) => callbacks.onAgentStream(text),
      (status) => callbacks.onAgentToolUse(status),
      options.signal,
    )

    // Log cost data if available + accumulate tokens on run state
    if (outcome.cost) {
      callbacks.onExperimentCost?.(outcome.cost)
      state = {
        ...state,
        total_tokens: (state.total_tokens ?? 0) + outcome.cost.input_tokens + outcome.cost.output_tokens,
        total_cost_usd: (state.total_cost_usd ?? 0) + outcome.cost.total_cost_usd,
      }
      await writeState(runDir, state)
    }

    // --- Abort detection + cleanup ---
    if (options.signal?.aborted) {
      callbacks.onPhaseChange("stopping", "aborted by user")

      await restoreMeasurementSnapshot(measurementSnapshot)
      await resetAndVerify(cwd, startSha, "abort cleanup")

      const abortResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: startSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: "aborted by user",
        measurement_duration_ms: 0,
      }
      await appendResult(runDir, abortResult)
      await recordIdeasBacklog(ideasBacklogEnabled, runDir, abortResult)
      callbacks.onExperimentEnd(abortResult)

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

      await resetAndVerify(cwd, startSha, "failed experiment cleanup")

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
        measurement_duration_ms: 0,
      }
      await appendResult(runDir, crashResult)
      await recordIdeasBacklog(ideasBacklogEnabled, runDir, crashResult, outcome.notes)
      callbacks.onExperimentEnd(crashResult)

      state = {
        ...state,
        total_crashes: isLockViolation ? state.total_crashes : state.total_crashes + 1,
        total_discards: isLockViolation ? state.total_discards + 1 : state.total_discards,
        candidate_sha: null,
        phase: "idle",
        updated_at: now(),
      }
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, buildShPath, cwd, config, state, runDir, callbacks, options.signal)
      continue
    }

    // --- Agent committed. Use SHA from outcome. ---
    const candidateSha = outcome.sha
    state = { ...state, candidate_sha: candidateSha, updated_at: now() }
    await writeState(runDir, state)

    if (!(await isWorkingTreeClean(cwd))) {
      await resetHard(cwd, candidateSha)
      if (!(await isWorkingTreeClean(cwd))) {
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
      callbacks.onPhaseChange("reverting", `lock violation: ${lockViolationFiles.join(", ")}`)

      state = { ...state, phase: "reverting", updated_at: now() }
      await writeState(runDir, state)

      if (measurementViolations.length > 0) {
        await restoreMeasurementSnapshot(measurementSnapshot)
      }
      await resetAndVerify(cwd, startSha, "lock violation reset")

      const lockResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: candidateSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "discard",
        description: `lock violation: modified ${lockViolationFiles.join(", ")} — ${outcome.description}`,
        measurement_duration_ms: 0,
      }
      await appendResult(runDir, lockResult)
      await recordIdeasBacklog(ideasBacklogEnabled, runDir, lockResult, outcome.notes)
      callbacks.onExperimentEnd(lockResult)

      state = { ...state, total_discards: state.total_discards + 1, candidate_sha: null, phase: "idle", updated_at: now() }
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, buildShPath, cwd, config, state, runDir, callbacks, options.signal)
      continue
    }

    // --- Check commit count (warn if multiple) ---
    const commitCount = await countCommitsBetween(cwd, startSha, candidateSha)
    if (commitCount > 1) {
      callbacks.onError(`Warning: agent made ${commitCount} commits (expected 1). Proceeding with measurement.`)
    }

    // --- Hand off to measurement ---
    const measurementResult = await runMeasurementAndDecide(
      cwd, runDir, measureShPath, buildShPath,
      config, state, startSha, candidateSha, outcome.description,
      outcome.diff_stats,
      callbacks,
      (result) => recordIdeasBacklog(ideasBacklogEnabled, runDir, result, outcome.notes),
      options.signal,
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
      state = await maybeRebaseline(consecutiveDiscards, measureShPath, buildShPath, cwd, config, state, runDir, callbacks, options.signal)
    }

    callbacks.onStateUpdate(state)
  }
  } finally {
    await unlockMeasurement(programDir)
  }

  // --- Finalize ---

  // Determine termination reason
  const reason: TerminationReason = options.signal?.aborted
    ? "aborted"
    : consecutiveDiscards >= maxConsecutiveDiscards
      ? "stagnation"
      : state.experiment_number >= effectiveMaxExperiments
        ? "max_experiments"
        : "stopped"

  const finalState: RunState = {
    ...state,
    phase: state.phase === "stopping" ? "complete" as const : state.phase,
    termination_reason: reason,
    updated_at: now(),
  }
  await writeState(runDir, finalState)
  callbacks.onStateUpdate(finalState)
  callbacks.onLoopComplete?.(finalState, reason)

  return finalState
}
