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
}

/** Options to control the experiment loop */
export interface LoopOptions {
  maxExperiments?: number
  signal?: AbortSignal
}

// --- Helpers ---

const now = () => new Date().toISOString()

// --- Measurement + Decision (phase 2c stub, fully functional) ---

async function runMeasurementAndDecide(
  projectRoot: string,
  _programDir: string,
  runDir: string,
  measureShPath: string,
  config: ProgramConfig,
  state: RunState,
  startSha: string,
  candidateSha: string,
  description: string,
  callbacks: LoopCallbacks,
): Promise<{ state: RunState; kept: boolean }> {

  // 1. Measure
  callbacks.onPhaseChange("measuring")
  let currentState: RunState = { ...state, phase: "measuring", updated_at: now() }
  await writeState(runDir, currentState)

  const series = await runMeasurementSeries(measureShPath, projectRoot, config)

  // 2. Handle measurement failure
  if (!series.success) {
    callbacks.onPhaseChange("reverting", "measurement failed")
    currentState = { ...currentState, phase: "reverting", updated_at: now() }
    await writeState(runDir, currentState)

    const reverted = await revertCommits(projectRoot, startSha, candidateSha)
    if (!reverted) await resetHard(projectRoot, startSha)

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

    const reverted = await revertCommits(projectRoot, startSha, candidateSha)
    if (!reverted) await resetHard(projectRoot, startSha)

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

    // Re-baseline after keep (code changed — old baseline is no longer valid)
    callbacks.onPhaseChange("measuring", "re-baselining after keep")
    const rebaseline = await runMeasurementSeries(measureShPath, projectRoot, config)
    const newBaseline = rebaseline.success ? rebaseline.median_metric : series.median_metric

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

  const reverted = await revertCommits(projectRoot, startSha, candidateSha)
  if (!reverted) await resetHard(projectRoot, startSha)

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

  // eslint-disable-next-line no-await-in-loop -- experiment iterations must run sequentially
  while (true) {
    // --- Check stop conditions ---
    if (options.signal?.aborted) {
      Object.assign(state, { phase: "stopping", updated_at: now() })
      await writeState(runDir, state)
      callbacks.onPhaseChange("stopping", "manually stopped")
      break
    }

    // Warn on consecutive discards — agent may be stuck
    if (consecutiveDiscards >= 10) {
      callbacks.onError(`Warning: ${consecutiveDiscards} consecutive discards. Agent may be stuck — consider stopping and reviewing results.`)
    }

    if (options.maxExperiments && state.experiment_number >= options.maxExperiments) {
      Object.assign(state, { phase: "complete", updated_at: now() })
      await writeState(runDir, state)
      callbacks.onPhaseChange("complete", `reached max experiments (${options.maxExperiments})`)
      break
    }

    // --- Start new experiment ---
    const experimentNumber = state.experiment_number + 1
    callbacks.onExperimentStart(experimentNumber)

    // Update state: agent_running
    Object.assign(state, { phase: "agent_running", experiment_number: experimentNumber, updated_at: now() })
    await writeState(runDir, state)
    callbacks.onPhaseChange("agent_running")
    callbacks.onStateUpdate(state)

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
      config,
      modelConfig,
      (text) => callbacks.onAgentStream(text),
      (status) => callbacks.onAgentToolUse(status),
      options.signal,
    )

    // --- Handle no-commit or error ---
    if (outcome.type === "no_commit") {
      const noCommitResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: (await getFullSha(projectRoot)).slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: "no commit produced",
      }
      await appendResult(runDir, noCommitResult)
      callbacks.onExperimentEnd(noCommitResult)

      Object.assign(state, { total_crashes: state.total_crashes + 1, phase: "idle", updated_at: now() })
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    if (outcome.type === "agent_error") {
      const errorResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: (await getFullSha(projectRoot)).slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: `agent error: ${outcome.error}`,
      }
      await appendResult(runDir, errorResult)
      callbacks.onExperimentEnd(errorResult)

      Object.assign(state, { total_crashes: state.total_crashes + 1, phase: "idle", updated_at: now() })
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    // --- Agent committed. Record candidate SHA. ---
    const candidateSha = await getFullSha(projectRoot)
    Object.assign(state, { candidate_sha: candidateSha, updated_at: now() })
    await writeState(runDir, state)

    // --- Check lock violation ---
    const lockCheck = checkLockViolation(outcome.files_changed, programSlug)
    if (lockCheck.violated) {
      callbacks.onPhaseChange("reverting", `lock violation: ${lockCheck.files.join(", ")}`)

      Object.assign(state, { phase: "reverting", updated_at: now() })
      await writeState(runDir, state)

      const reverted = await revertCommits(projectRoot, startSha, candidateSha)
      if (!reverted) {
        await resetHard(projectRoot, startSha)
      }

      const lockResult: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: candidateSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "discard",
        description: `lock violation: modified ${lockCheck.files.join(", ")} — ${outcome.description}`,
      }
      await appendResult(runDir, lockResult)
      callbacks.onExperimentEnd(lockResult)

      Object.assign(state, { total_discards: state.total_discards + 1, candidate_sha: null, phase: "idle", updated_at: now() })
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    // --- Check commit count (warn if multiple) ---
    const commitCount = await countCommitsBetween(projectRoot, startSha, candidateSha)
    if (commitCount > 1) {
      callbacks.onError(`Warning: agent made ${commitCount} commits (expected 1). Proceeding with measurement.`)
    }

    // --- Hand off to measurement ---
    const measurementResult = await runMeasurementAndDecide(
      projectRoot, programDir, runDir, measureShPath,
      config, state, startSha, candidateSha, outcome.description,
      callbacks,
    )

    state = measurementResult.state
    if (measurementResult.kept) {
      consecutiveDiscards = 0
    } else {
      consecutiveDiscards++
    }

    callbacks.onStateUpdate(state)
  }

  // --- Finalize ---
  await unlockEvaluator(programDir)

  const finalState: RunState = {
    ...state,
    phase: state.phase === "stopping" ? "complete" as const : state.phase,
    updated_at: new Date().toISOString(),
  }
  await writeState(runDir, finalState)
  callbacks.onStateUpdate(finalState)

  return finalState
}
