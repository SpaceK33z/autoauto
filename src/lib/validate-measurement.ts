#!/usr/bin/env bun
/* eslint-disable no-console, no-await-in-loop */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { validateProgramConfig, type ProgramConfig } from "./programs.ts"
import {
  runBuild,
  runMeasurement as runMeasurementCore,
  validateMeasurementOutput,
} from "./measure.ts"

interface RunResult {
  run: number
  success: boolean
  output?: Record<string, unknown>
  error?: string
  duration_ms: number
}

interface FieldStats {
  field: string
  values: number[]
  median: number
  mean: number
  min: number
  max: number
  stdev: number
  cv_percent: number
}

type Assessment = "deterministic" | "excellent" | "acceptable" | "noisy" | "unstable"

interface ValidationOutput {
  success: boolean
  total_runs: number
  valid_runs: number
  failed_runs: Array<{ run: number; error: string }>
  validation_errors: Array<{ run: number; errors: string[] }>
  metric: FieldStats | null
  quality_gates: Record<string, FieldStats>
  secondary_metrics: Record<string, FieldStats>
  assessment: Assessment | null
  recommendations: {
    noise_threshold: number
    repeats: number
  } | null
  avg_duration_ms: number
  build: {
    ran: boolean
    success: boolean
    duration_ms: number
    error?: string
  }
}

// --- Input Parsing ---

const [measureShPath, configJsonPath, runsStr] = process.argv.slice(2)

if (!measureShPath || !configJsonPath) {
  console.error("Usage: validate-measurement.ts <measure_sh> <config_json> [runs]")
  process.exit(1)
}

const numRuns = parseInt(runsStr || "5", 10)
// Resolve cwd from measure.sh's location — go up from .autoauto/programs/<slug>/
// to the project root.
const projectRoot = dirname(dirname(dirname(dirname(measureShPath))))

// --- Config Parsing ---

let config: ProgramConfig
try {
  config = validateProgramConfig(JSON.parse(readFileSync(configJsonPath, "utf-8")))
} catch (err) {
  console.log(JSON.stringify({ success: false, error: `Failed to read config.json: ${err}` }))
  process.exit(0)
}

// --- Measurement Execution ---

async function runMeasurement(scriptPath: string, run: number, cwd: string): Promise<RunResult> {
  const result = await runMeasurementCore(scriptPath, cwd)
  if (result.success) {
    return { run, success: true, output: result.output, duration_ms: result.duration_ms }
  }
  return { run, success: false, error: result.error, duration_ms: result.duration_ms }
}

// --- Field Validation ---

function validateOutput(
  output: Record<string, unknown>,
  cfg: ProgramConfig,
): { valid: boolean; errors: string[] } {
  return validateMeasurementOutput(output, cfg)
}

// --- Statistics ---

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(n * factor) / factor
}

function computeStats(field: string, values: number[]): FieldStats {
  const sorted = [...values].toSorted((a, b) => a - b)
  const n = sorted.length
  const median =
    n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)]
  const mean = values.reduce((a, b) => a + b, 0) / n
  const min = sorted[0]
  const max = sorted[n - 1]
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) // sample variance
  const stdev = Math.sqrt(variance)
  const cv_percent = mean !== 0 ? (stdev / Math.abs(mean)) * 100 : Infinity

  return {
    field,
    values,
    median: round(median, 4),
    mean: round(mean, 4),
    min: round(min, 4),
    max: round(max, 4),
    stdev: round(stdev, 4),
    cv_percent: round(cv_percent, 2),
  }
}

// --- Assessment & Recommendations ---

function assess(cv_percent: number): Assessment {
  if (cv_percent < 1) return "deterministic"
  if (cv_percent < 5) return "excellent"
  if (cv_percent < 15) return "acceptable"
  if (cv_percent < 30) return "noisy"
  return "unstable"
}

function recommend(cv_percent: number): { noise_threshold: number; repeats: number } {
  if (cv_percent < 1) {
    return { noise_threshold: 0.01, repeats: 1 }
  }
  if (cv_percent < 5) {
    return { noise_threshold: 0.02, repeats: 3 }
  }
  if (cv_percent < 15) {
    return {
      noise_threshold: round(Math.max((cv_percent * 1.5) / 100, 0.05), 2),
      repeats: 5,
    }
  }
  if (cv_percent < 30) {
    return {
      noise_threshold: round(Math.max((cv_percent * 2) / 100, 0.1), 2),
      repeats: 7,
    }
  }
  // Unstable — don't recommend config, fix the measurement first
  return { noise_threshold: -1, repeats: -1 }
}

// --- Main ---

async function main() {
  const buildShPath = join(dirname(measureShPath), "build.sh")
  const hasBuildScript = existsSync(buildShPath)
  const buildResult = hasBuildScript
    ? await runBuild(buildShPath, projectRoot)
    : { success: true, duration_ms: 0 }

  if (hasBuildScript) {
    process.stderr.write("Build...")
    process.stderr.write(` ${buildResult.success ? "OK" : "FAIL"} (${buildResult.duration_ms}ms)\n`)
  }

  if (!buildResult.success) {
    const output: ValidationOutput = {
      success: false,
      total_runs: 0,
      valid_runs: 0,
      failed_runs: [],
      validation_errors: [],
      metric: null,
      quality_gates: {},
      secondary_metrics: {},
      assessment: null,
      recommendations: null,
      avg_duration_ms: 0,
      build: {
        ran: true,
        success: false,
        duration_ms: buildResult.duration_ms,
        error: buildResult.error,
      },
    }
    console.log(JSON.stringify(output, null, 2))
    return
  }

  // 1. Warmup run — excluded from stats
  process.stderr.write("Warmup run...")
  const warmup = await runMeasurement(measureShPath, 0, projectRoot)
  process.stderr.write(` ${warmup.success ? "OK" : "FAIL"} (${warmup.duration_ms}ms)\n`)

  // 2. Run measure.sh N times sequentially
  const results: RunResult[] = []
  for (let i = 0; i < numRuns; i++) {
    process.stderr.write(`Run ${i + 1}/${numRuns}...`)
    const result = await runMeasurement(measureShPath, i + 1, projectRoot)
    process.stderr.write(` ${result.success ? "OK" : "FAIL"} (${result.duration_ms}ms)\n`)
    results.push(result)
  }

  // 3. Separate successful and failed runs
  const successfulRuns = results.filter((r) => r.success && r.output)
  const failedRuns = results
    .filter((r) => !r.success)
    .map((r) => ({ run: r.run, error: r.error! }))

  // 4. Validate outputs against config
  const validationErrors: Array<{ run: number; errors: string[] }> = []
  const validOutputs: Array<{ run: number; output: Record<string, unknown> }> = []
  for (const r of successfulRuns) {
    const validation = validateOutput(r.output!, config)
    if (validation.valid) {
      validOutputs.push({ run: r.run, output: r.output! })
    } else {
      validationErrors.push({ run: r.run, errors: validation.errors })
    }
  }

  // 5. Compute stats if we have enough valid runs (>= 2)
  let metric: FieldStats | null = null
  let assessment: Assessment | null = null
  let recommendations: { noise_threshold: number; repeats: number } | null = null

  function computeFieldStats(fields: string[]): Record<string, FieldStats> {
    const stats: Record<string, FieldStats> = {}
    for (const field of fields) {
      const values = validOutputs
        .map((r) => r.output[field])
        .filter((v): v is number => typeof v === "number" && isFinite(v))
      if (values.length >= 2) {
        stats[field] = computeStats(field, values)
      }
    }
    return stats
  }

  let qualityGateStats: Record<string, FieldStats> = {}
  let secondaryMetricStats: Record<string, FieldStats> = {}

  if (validOutputs.length >= 2) {
    const metricValues = validOutputs.map((r) => r.output[config.metric_field] as number)
    metric = computeStats(config.metric_field, metricValues)
    assessment = assess(metric.cv_percent)
    const rec = recommend(metric.cv_percent)
    recommendations = rec.noise_threshold >= 0 ? rec : null

    qualityGateStats = computeFieldStats(Object.keys(config.quality_gates))
    secondaryMetricStats = computeFieldStats(Object.keys(config.secondary_metrics ?? {}))
  }

  // 6. Output result
  const avgDuration =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.duration_ms, 0) / results.length)
      : 0

  const output: ValidationOutput = {
    success: failedRuns.length === 0 && validationErrors.length === 0 && validOutputs.length >= 2,
    total_runs: numRuns,
    valid_runs: validOutputs.length,
    failed_runs: failedRuns,
    validation_errors: validationErrors,
    metric,
    quality_gates: qualityGateStats,
    secondary_metrics: secondaryMetricStats,
    assessment,
    recommendations,
    avg_duration_ms: avgDuration,
    build: {
      ran: hasBuildScript,
      success: true,
      duration_ms: buildResult.duration_ms,
    },
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: String(err) }))
})
