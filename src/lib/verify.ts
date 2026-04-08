import { join } from "node:path"
import type { ProgramConfig } from "./programs.ts"
import type { RunState, ExperimentStatus } from "./run.ts"
import { appendResult, serializeSecondaryValues } from "./run.ts"
import { resetHard, getFullSha } from "./git.ts"
import { runMeasurementSeries, type MeasurementSeriesResult } from "./measure.ts"

export type VerifyTarget = "baseline" | "current" | "both"

export interface VerificationResult {
  target: "baseline" | "current"
  success: boolean
  median_metric: number
  median_quality_gates: Record<string, number>
  median_secondary_metrics: Record<string, number>
  quality_gates_passed: boolean
  gate_violations: string[]
  duration_ms: number
  failure_reason?: string
  original_metric: number
}

export interface VerifyOptions {
  target: VerifyTarget
  repeats: number
  config: ProgramConfig
  state: RunState
  programDir: string
  cwd: string
  signal?: AbortSignal
  onProgress?: (status: string) => void
}

export async function runVerification(opts: VerifyOptions): Promise<VerificationResult[]> {
  const { target, repeats, config, state, programDir, cwd, signal, onProgress } = opts
  const measureShPath = join(programDir, "measure.sh")
  const buildShPath = join(programDir, "build.sh")
  const verifyConfig = { ...config, repeats }

  const savedHead = await getFullSha(cwd)
  const results: VerificationResult[] = []

  try {
    if (target === "baseline" || target === "both") {
      onProgress?.("Checking out baseline...")
      await resetHard(cwd, state.original_baseline_sha)

      onProgress?.("Measuring baseline...")
      const series = await runMeasurementSeries(measureShPath, cwd, verifyConfig, signal, buildShPath)
      results.push(seriestoResult("baseline", series, state.original_baseline))
    }

    if (target === "current" || target === "both") {
      onProgress?.("Checking out current...")
      await resetHard(cwd, state.last_known_good_sha)

      onProgress?.("Measuring current...")
      const series = await runMeasurementSeries(measureShPath, cwd, verifyConfig, signal, buildShPath)
      results.push(seriestoResult("current", series, state.current_baseline))
    }
  } finally {
    await resetHard(cwd, savedHead)
  }

  return results
}

function seriestoResult(
  target: "baseline" | "current",
  series: MeasurementSeriesResult,
  originalMetric: number,
): VerificationResult {
  return {
    target,
    success: series.success,
    median_metric: series.median_metric,
    median_quality_gates: series.median_quality_gates,
    median_secondary_metrics: series.median_secondary_metrics,
    quality_gates_passed: series.quality_gates_passed,
    gate_violations: series.gate_violations,
    duration_ms: series.duration_ms,
    failure_reason: series.failure_reason,
    original_metric: originalMetric,
  }
}

export async function appendVerificationResults(
  runDir: string,
  verificationResults: VerificationResult[],
  state: RunState,
): Promise<void> {
  for (const r of verificationResults) {
    const status: ExperimentStatus = r.target === "baseline"
      ? "verification_baseline"
      : "verification_current"

    await appendResult(runDir, { // eslint-disable-line no-await-in-loop -- sequential append to preserve TSV order
      experiment_number: 0,
      commit: r.target === "baseline"
        ? state.original_baseline_sha.slice(0, 7)
        : state.last_known_good_sha.slice(0, 7),
      metric_value: r.median_metric,
      secondary_values: serializeSecondaryValues(
        r.median_quality_gates,
        r.median_secondary_metrics,
      ),
      status,
      description: `verification (${r.target})`,
      measurement_duration_ms: r.duration_ms,
    })
  }
}
