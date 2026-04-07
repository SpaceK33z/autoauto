import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import type { ProgramConfig } from "./programs.ts"

// --- Types ---

export type MeasurementResult =
  | { success: true; output: Record<string, unknown>; duration_ms: number }
  | { success: false; error: string; duration_ms: number }

export interface MeasurementSeriesResult {
  success: boolean
  median_metric: number
  median_quality_gates: Record<string, number>
  quality_gates_passed: boolean
  gate_violations: string[]
  individual_runs: MeasurementResult[]
  duration_ms: number
  failure_reason?: string
}

// --- Helpers ---

function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b)
  const n = sorted.length
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
}

// --- Measurement Execution ---

/**
 * Runs measure.sh once and returns parsed output.
 * Uses Node spawn with timeout (matching validate-measurement.ts pattern).
 */
export async function runMeasurement(
  measureShPath: string,
  projectRoot: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<MeasurementResult> {
  if (signal?.aborted) {
    return { success: false, error: "aborted", duration_ms: 0 }
  }

  const start = performance.now()
  return new Promise((resolve) => {
    const proc = spawn("bash", [measureShPath], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs ?? 60_000,
    })

    const onAbort = () => {
      if (!proc.killed) proc.kill("SIGTERM")
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    proc.stdout!.setEncoding("utf-8")
    proc.stderr!.setEncoding("utf-8")

    let stdout = ""
    let stderr = ""

    proc.stdout!.on("data", (chunk: string) => {
      stdout += chunk
    })
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk
    })

    proc.on("close", (exitCode) => {
      signal?.removeEventListener("abort", onAbort)
      const duration_ms = Math.round(performance.now() - start)

      if (signal?.aborted) {
        resolve({ success: false, error: "aborted", duration_ms })
        return
      }

      if (exitCode !== 0) {
        resolve({
          success: false,
          error: `exit code ${exitCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
          duration_ms,
        })
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        resolve({
          success: false,
          error: `invalid JSON on stdout: ${stdout.trim().slice(0, 200)}`,
          duration_ms,
        })
        return
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        resolve({
          success: false,
          error: `stdout must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
          duration_ms,
        })
        return
      }

      resolve({ success: true, output: parsed as Record<string, unknown>, duration_ms })
    })

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort)
      const duration_ms = Math.round(performance.now() - start)
      resolve({ success: false, error: err.message, duration_ms })
    })
  })
}

// --- Build Step ---

export interface BuildResult {
  success: boolean
  error?: string
  duration_ms: number
}

/**
 * Runs build.sh once if it exists. Returns success immediately if the file is missing.
 */
export async function runBuild(
  buildShPath: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<BuildResult> {
  try {
    await access(buildShPath)
  } catch {
    return { success: true, duration_ms: 0 }
  }

  const start = performance.now()
  return new Promise((resolve) => {
    const proc = spawn("bash", [buildShPath], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    })

    const onAbort = () => {
      if (!proc.killed) proc.kill("SIGTERM")
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    let stderr = ""
    proc.stderr!.setEncoding("utf-8")
    proc.stderr!.on("data", (chunk: string) => {
      stderr += chunk
    })

    proc.on("close", (exitCode) => {
      signal?.removeEventListener("abort", onAbort)
      const duration_ms = Math.round(performance.now() - start)

      if (signal?.aborted) {
        resolve({ success: false, error: "aborted", duration_ms })
        return
      }

      if (exitCode !== 0) {
        resolve({
          success: false,
          error: `build.sh exit code ${exitCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
          duration_ms,
        })
        return
      }

      resolve({ success: true, duration_ms })
    })

    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort)
      const duration_ms = Math.round(performance.now() - start)
      resolve({ success: false, error: err.message, duration_ms })
    })
  })
}

// --- Validation ---

/** Validates a measurement output has all required fields as finite numbers. */
export function validateMeasurementOutput(
  output: Record<string, unknown>,
  config: ProgramConfig,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  const metricValue = output[config.metric_field]
  if (metricValue === undefined) {
    errors.push(`metric_field "${config.metric_field}" missing from output`)
  } else if (typeof metricValue !== "number" || !isFinite(metricValue)) {
    errors.push(`metric_field "${config.metric_field}" is not a finite number: ${metricValue}`)
  }

  for (const field of Object.keys(config.quality_gates)) {
    const value = output[field]
    if (value === undefined) {
      errors.push(`quality gate field "${field}" missing from output`)
    } else if (typeof value !== "number" || !isFinite(value)) {
      errors.push(`quality gate field "${field}" is not a finite number: ${value}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/** Checks quality gate thresholds (separate from field existence validation). */
export function checkQualityGates(
  output: Record<string, number>,
  config: ProgramConfig,
): { passed: boolean; violations: string[] } {
  const violations: string[] = []

  for (const [field, gate] of Object.entries(config.quality_gates)) {
    const value = output[field]
    if (value === undefined) continue
    if (gate.max !== undefined && value > gate.max) {
      violations.push(`${field}=${value} exceeds max ${gate.max}`)
    }
    if (gate.min !== undefined && value < gate.min) {
      violations.push(`${field}=${value} below min ${gate.min}`)
    }
  }

  return { passed: violations.length === 0, violations }
}

// --- Measurement Series ---

/**
 * Runs measure.sh N times (config.repeats), computes median, validates all outputs.
 * Every configured repeat must succeed; partial measurement failures invalidate the series.
 */
export async function runMeasurementSeries(
  measureShPath: string,
  projectRoot: string,
  config: ProgramConfig,
  signal?: AbortSignal,
  buildShPath?: string,
): Promise<MeasurementSeriesResult> {
  const totalStart = performance.now()

  // Run build step once before measuring
  if (buildShPath) {
    const buildResult = await runBuild(buildShPath, projectRoot, signal)
    if (!buildResult.success) {
      return {
        success: false,
        median_metric: 0,
        median_quality_gates: {},
        quality_gates_passed: false,
        gate_violations: [],
        individual_runs: [],
        duration_ms: Math.round(performance.now() - totalStart),
        failure_reason: buildResult.error ?? "build failed",
      }
    }
  }

  const runs: MeasurementResult[] = []
  const validMetrics: number[] = []
  const validGateValues: Record<string, number[]> = {}
  let invalidOutputCount = 0

  for (let i = 0; i < config.repeats; i++) {
    if (signal?.aborted) break
    // eslint-disable-next-line no-await-in-loop -- measurements must run sequentially
    const result = await runMeasurement(measureShPath, projectRoot, undefined, signal)
    runs.push(result)

    if (!result.success) continue

    const validation = validateMeasurementOutput(result.output, config)
    if (!validation.valid) {
      invalidOutputCount++
      continue
    }

    validMetrics.push(result.output[config.metric_field] as number)

    for (const field of Object.keys(config.quality_gates)) {
      const value = result.output[field]
      if (typeof value === "number" && isFinite(value)) {
        if (!validGateValues[field]) validGateValues[field] = []
        validGateValues[field].push(value)
      }
    }
  }

  const duration_ms = Math.round(performance.now() - totalStart)

  if (signal?.aborted) {
    return {
      success: false,
      median_metric: 0,
      median_quality_gates: {},
      quality_gates_passed: false,
      gate_violations: [],
      individual_runs: runs,
      duration_ms,
      failure_reason: "aborted",
    }
  }

  if (runs.length !== config.repeats || validMetrics.length !== config.repeats || invalidOutputCount > 0) {
    const failedRuns = runs
      .filter((run): run is Extract<MeasurementResult, { success: false }> => !run.success)
      .map((run) => run.error)
    const invalidRuns = runs
      .filter((run): run is Extract<MeasurementResult, { success: true }> => run.success)
      .map((run) => validateMeasurementOutput(run.output, config).errors)
      .filter((errors) => errors.length > 0)
      .flat()

    const reasons = [...failedRuns, ...invalidRuns]
    return {
      success: false,
      median_metric: 0,
      median_quality_gates: {},
      quality_gates_passed: false,
      gate_violations: [],
      individual_runs: runs,
      duration_ms,
      failure_reason: reasons.length > 0 ? reasons.join("; ") : "measurement series incomplete",
    }
  }

  const medianMetric = median(validMetrics)
  const medianGates: Record<string, number> = {}
  for (const [field, values] of Object.entries(validGateValues)) {
    medianGates[field] = median(values)
  }

  const gateCheck = checkQualityGates(medianGates, config)

  return {
    success: true,
    median_metric: medianMetric,
    median_quality_gates: medianGates,
    quality_gates_passed: gateCheck.passed,
    gate_violations: gateCheck.violations,
    individual_runs: runs,
    duration_ms,
  }
}

// --- Comparison ---

/**
 * Compares measured metric against baseline using noise threshold.
 * noise_threshold is a decimal fraction (e.g. 0.02 for 2%).
 */
export function compareMetric(
  baseline: number,
  measured: number,
  noiseThreshold: number,
  direction: "lower" | "higher",
): "improved" | "regressed" | "noise" {
  const relativeChange =
    direction === "lower"
      ? (baseline - measured) / baseline // positive = improvement for "lower"
      : (measured - baseline) / baseline // positive = improvement for "higher"

  if (relativeChange > noiseThreshold) return "improved"
  if (relativeChange < -noiseThreshold) return "regressed"
  return "noise"
}
