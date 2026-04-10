import { chmod } from "node:fs/promises"
import { join, relative } from "node:path"
import type { RunState, ExperimentResult, TerminationReason, PreviousRunContext } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import {
  readState,
  writeState,
  appendResult,
  serializeSecondaryValues,
  serializeDiffStats,
  readPreviousRunContext,
} from "./run.ts"
import { unlockMeasurement, MEASUREMENT_FILES } from "./run-setup.ts"
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
  /** Feed previous run results and ideas into the experiment agent context. */
  carryForward?: boolean
  /** Diagnostics from the baseline measurement, to pass to the first experiment */
  baselineDiagnostics?: string
  /** Maximum cost in USD before stopping the run. Checked at iteration boundary. */
  maxCostUsd?: number
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
  const paths = MEASUREMENT_FILES.map((f) => join(programDir, f))
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
): Promise<{ state: RunState; kept: boolean; isSimplification?: boolean; diagnostics?: string }> {

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
    return { state: finalState, kept: false, diagnostics: series.diagnostics }
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
    return { state: finalState, kept: false, diagnostics: series.diagnostics }
  }

  // 4. Compare against baseline
  const verdict = compareMetric(
    state.current_baseline,
    series.median_metric,
    config.noise_threshold,
    config.direction,
  )

  // 5. Check for simplification auto-keep: net-negative LOC within noise
  const keepSimplifications = config.keep_simplifications !== false
  const isSimplification = keepSimplifications
    && verdict === "noise"
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
    return { state: finalState, kept: true, isSimplification, diagnostics: rebaseline.success ? rebaseline.diagnostics : series.diagnostics }
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
  return { state: finalState, kept: false, diagnostics: series.diagnostics }
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
  let lastDiagnostics: string | undefined = options.baselineDiagnostics
  const ideasBacklogEnabled = options.ideasBacklogEnabled ?? true
  const maxConsecutiveDiscards = config.max_consecutive_discards ?? DEFAULT_MAX_CONSECUTIVE_DISCARDS

  // Read previous run context once at startup (if carry-forward enabled)
  let previousRunContext: PreviousRunContext | undefined
  if (options.carryForward !== false) {
    try {
      previousRunContext = await readPreviousRunContext(programDir, state.run_id)
      if (!previousRunContext.previousResults && !previousRunContext.previousIdeas) {
        previousRunContext = undefined
      }
    } catch {
      previousRunContext = undefined
    }
  }

  let terminalError = false
  const recentErrorTimestamps: number[] = []
  const RAPID_FAILURE_COUNT = 3
  /** If this many experiments all fail within this total window, treat as terminal. */
  const RAPID_FAILURE_WINDOW_MS = 30_000
  const RATE_LIMIT_PAUSE_MS = 60_000

  // Re-read from run-config.json each iteration to support mid-run TUI changes
  let effectiveMaxExperiments = options.maxExperiments
  let effectiveMaxCostUsd = options.maxCostUsd
  let effectiveKeepSimplifications = config.keep_simplifications

  try {
  while (true) {
    const runConfig = await readRunConfig(runDir)
    if (runConfig) {
      effectiveMaxExperiments = runConfig.max_experiments
      if (runConfig.max_cost_usd !== undefined) effectiveMaxCostUsd = runConfig.max_cost_usd
      if (runConfig.keep_simplifications !== undefined) effectiveKeepSimplifications = runConfig.keep_simplifications
    }

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

    // Budget cap — stop when cumulative cost exceeds the limit
    const currentCost = state.total_cost_usd ?? 0
    if (effectiveMaxCostUsd != null && currentCost > 0 && currentCost >= effectiveMaxCostUsd) {
      state = { ...state, phase: "complete", updated_at: now() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("complete", `budget exceeded ($${currentCost.toFixed(2)} / $${effectiveMaxCostUsd.toFixed(2)})`)
      break
    }

    // Warn at ~80% of budget
    if (effectiveMaxCostUsd != null && currentCost > 0) {
      const budgetPct = currentCost / effectiveMaxCostUsd
      // Warn once when crossing ~80% — use a narrow band to avoid repeated warnings
      if (budgetPct >= 0.8 && budgetPct < 0.85) {
        callbacks.onError(`Warning: $${currentCost.toFixed(2)}/$${effectiveMaxCostUsd.toFixed(2)} budget used (${Math.round(budgetPct * 100)}%). Run will stop when budget is exceeded.`)
      }
    }

    // --- Start new experiment ---
    const experimentNumber = state.experiment_number + 1
    callbacks.onExperimentStart(experimentNumber)

    state = { ...state, phase: "agent_running", experiment_number: experimentNumber, updated_at: now() }
    await writeState(runDir, state)
    callbacks.onPhaseChange("agent_running")
    callbacks.onStateUpdate(state)

    // --- Build context packet ---
    const maxTurns = config.max_turns
    const packet = await buildContextPacket(
      cwd, programDir, runDir, state, config, { ideasBacklogEnabled, consecutiveDiscards, maxConsecutiveDiscards, maxTurns, measurementDiagnostics: lastDiagnostics, previousRunContext },
    )
    const systemPrompt = getExperimentSystemPrompt(packet.program_md, { ideasBacklogEnabled, keepSimplifications: effectiveKeepSimplifications })
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
      maxTurns,
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

    // --- Terminal error detection (quota exhausted or auth failure) → immediate stop ---
    if (outcome.type === "agent_error" && (outcome.errorKind === "quota_exhausted" || outcome.errorKind === "auth_error")) {
      const measurementViolations = await getMeasurementViolations(measurementSnapshot)
      if (measurementViolations.length > 0) await restoreMeasurementSnapshot(measurementSnapshot)
      await resetAndVerify(cwd, startSha, `${outcome.errorKind} cleanup`)

      const label = outcome.errorKind === "quota_exhausted" ? "quota exhausted" : "auth error"
      const crashResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: startSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: `${label}: ${outcome.error}`,
        measurement_duration_ms: 0,
      }
      await appendResult(runDir, crashResult)
      await recordIdeasBacklog(ideasBacklogEnabled, runDir, crashResult, outcome.notes)
      callbacks.onExperimentEnd(crashResult)
      callbacks.onError(`Provider ${label}: ${outcome.error}`)

      state = {
        ...state,
        total_crashes: state.total_crashes + 1,
        candidate_sha: null,
        phase: "stopping",
        updated_at: now(),
      }
      await writeState(runDir, state)
      callbacks.onPhaseChange("stopping", `provider ${label}`)
      terminalError = true
      break
    }

    // --- Rate limit → pause before retrying (fall through to normal error handling after) ---
    if (outcome.type === "agent_error" && outcome.errorKind === "rate_limited") {
      const pauseSec = RATE_LIMIT_PAUSE_MS / 1000
      callbacks.onError(`Rate limited by provider — pausing ${pauseSec}s before next experiment. Error: ${outcome.error}`)
      callbacks.onPhaseChange("idle", `rate limited — waiting ${pauseSec}s`)
      for (let i = 0; i < pauseSec; i++) {
        if (options.signal?.aborted) break
        await Bun.sleep(1000)
      }
    }

    // --- Rapid-failure backstop: catch unrecognized terminal errors ---
    if (outcome.type === "agent_error") {
      const ts = Date.now()
      recentErrorTimestamps.push(ts)
      while (recentErrorTimestamps.length > 0 && ts - recentErrorTimestamps[0] > RAPID_FAILURE_WINDOW_MS) {
        recentErrorTimestamps.shift()
      }
      if (recentErrorTimestamps.length >= RAPID_FAILURE_COUNT) {
        callbacks.onError(`${RAPID_FAILURE_COUNT} experiments failed within ${RAPID_FAILURE_WINDOW_MS / 1000}s — possible unrecognized quota or auth error. Stopping run.`)

        const measurementViolations = await getMeasurementViolations(measurementSnapshot)
        if (measurementViolations.length > 0) await restoreMeasurementSnapshot(measurementSnapshot)
        await resetAndVerify(cwd, startSha, "rapid failure cleanup")

        state = {
          ...state,
          candidate_sha: null,
          phase: "stopping",
          updated_at: now(),
        }
        await writeState(runDir, state)
        callbacks.onPhaseChange("stopping", "rapid consecutive failures detected")
        terminalError = true
        break
      }
    } else {
      recentErrorTimestamps.length = 0
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
    const effectiveConfig = effectiveKeepSimplifications !== config.keep_simplifications
      ? { ...config, keep_simplifications: effectiveKeepSimplifications }
      : config
    const measurementResult = await runMeasurementAndDecide(
      cwd, runDir, measureShPath, buildShPath,
      effectiveConfig, state, startSha, candidateSha, outcome.description,
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
    lastDiagnostics = measurementResult.diagnostics
    if (measurementResult.kept && !measurementResult.isSimplification) {
      consecutiveDiscards = 0
    } else if (!measurementResult.kept) {
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
  const finalCost = state.total_cost_usd ?? 0
  const reason: TerminationReason = options.signal?.aborted
    ? "aborted"
    : terminalError
      ? "quota_exhausted"
      : consecutiveDiscards >= maxConsecutiveDiscards
        ? "stagnation"
        : effectiveMaxCostUsd != null && finalCost >= effectiveMaxCostUsd
          ? "budget_exceeded"
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
