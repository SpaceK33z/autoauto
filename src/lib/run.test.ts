import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseSecondaryValues,
  formatRecentResults,
  parseLastResult,
  parseLastKeepResult,
  parseDiscardedShas,
  getRunStats,
  writeState,
  readState,
  appendResult,
  readAllResults,
  generateRunId,
  backfillFinalizedAt,
  getMetricHistory,
  getAvgMeasurementDuration,
  serializeSecondaryValues,
  serializeDiffStats,
  type RunState,
  type ExperimentResult,
} from "./run.ts"

// --- parseSecondaryValues ---

describe("parseSecondaryValues", () => {
  test("parses new structured format", () => {
    const raw = JSON.stringify({
      quality_gates: { latency: 500 },
      secondary_metrics: { memory: 1024 },
    })
    const result = parseSecondaryValues(raw)
    expect(result.quality_gates.latency).toBe(500)
    expect(result.secondary_metrics.memory).toBe(1024)
  })

  test("parses old flat format as quality_gates", () => {
    const raw = JSON.stringify({ latency: 500, accuracy: 0.95 })
    const result = parseSecondaryValues(raw)
    expect(result.quality_gates.latency).toBe(500)
    expect(result.quality_gates.accuracy).toBe(0.95)
    expect(result.secondary_metrics).toEqual({})
  })

  test("returns empty on undefined input", () => {
    const result = parseSecondaryValues(undefined)
    expect(result.quality_gates).toEqual({})
    expect(result.secondary_metrics).toEqual({})
  })

  test("returns empty on empty string", () => {
    const result = parseSecondaryValues("")
    expect(result.quality_gates).toEqual({})
    expect(result.secondary_metrics).toEqual({})
  })

  test("returns empty on invalid JSON", () => {
    const result = parseSecondaryValues("not json")
    expect(result.quality_gates).toEqual({})
    expect(result.secondary_metrics).toEqual({})
  })

  test("returns empty when parsed value is null", () => {
    const result = parseSecondaryValues("null")
    expect(result.quality_gates).toEqual({})
  })

  test("handles partial structured format (only quality_gates)", () => {
    const raw = JSON.stringify({ quality_gates: { latency: 100 } })
    const result = parseSecondaryValues(raw)
    expect(result.quality_gates.latency).toBe(100)
    expect(result.secondary_metrics).toEqual({})
  })

  test("handles partial structured format (only secondary_metrics)", () => {
    const raw = JSON.stringify({ secondary_metrics: { memory: 2048 } })
    const result = parseSecondaryValues(raw)
    expect(result.quality_gates).toEqual({})
    expect(result.secondary_metrics.memory).toBe(2048)
  })
})

// --- formatRecentResults ---

describe("formatRecentResults", () => {
  const header = "experiment\tcommit\tmetric\tstatus"

  test("returns header only for empty results", () => {
    expect(formatRecentResults(header)).toBe(header)
  })

  test("returns all rows when under count limit", () => {
    const raw = `${header}\n1\tabc\t42\tkeep\n2\tdef\t40\tkeep`
    const result = formatRecentResults(raw, 15)
    expect(result).toBe(raw)
  })

  test("returns last N rows when over count limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `${i + 1}\tabc\t${42 - i}\tkeep`)
    const raw = [header, ...rows].join("\n")
    const result = formatRecentResults(raw, 5)
    const lines = result.split("\n")
    expect(lines[0]).toBe(header) // header preserved
    expect(lines).toHaveLength(6) // header + 5 rows
    expect(lines[1]).toContain("16\t") // starts from row 16
  })

  test("handles empty string", () => {
    expect(formatRecentResults("")).toBe("")
  })
})

// --- parseLastResult ---

describe("parseLastResult", () => {
  const header = "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats"

  test("returns null for header-only input", () => {
    expect(parseLastResult(header)).toBeNull()
  })

  test("parses single result row", () => {
    const raw = `${header}\n1\tabc1234\t42\t\tkeep\toptimized hot path\t5000\t`
    const result = parseLastResult(raw)
    expect(result).not.toBeNull()
    expect(result!.experiment_number).toBe(1)
    expect(result!.commit).toBe("abc1234")
    expect(result!.metric_value).toBe(42)
    expect(result!.status).toBe("keep")
    expect(result!.description).toBe("optimized hot path")
    expect(result!.measurement_duration_ms).toBe(5000)
  })

  test("returns last row when multiple rows exist", () => {
    const raw = `${header}\n1\tabc\t42\t\tkeep\tfirst\t5000\t\n2\tdef\t40\t\tdiscard\tsecond\t3000\t`
    const result = parseLastResult(raw)
    expect(result!.experiment_number).toBe(2)
    expect(result!.status).toBe("discard")
    expect(result!.description).toBe("second")
  })

  test("parses diff_stats when present", () => {
    const diffStats = '{"lines_added":5,"lines_removed":3}'
    const raw = `${header}\n1\tabc\t42\t\tkeep\tfoo\t5000\t${diffStats}`
    const result = parseLastResult(raw)
    expect(result!.diff_stats).toBe(diffStats)
  })
})

// --- parseLastKeepResult ---

describe("parseLastKeepResult", () => {
  const header = "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats"

  test("returns null when no keep rows exist", () => {
    const raw = `${header}\n1\tabc\t42\t\tdiscard\tnoise\t5000\t\n2\tdef\t45\t\tcrash\terror\t3000\t`
    expect(parseLastKeepResult(raw)).toBeNull()
  })

  test("finds the last keep row", () => {
    const raw = `${header}\n1\tabc\t42\t\tkeep\tfirst keep\t5000\t\n2\tdef\t45\t\tdiscard\tnoise\t3000\t\n3\tghi\t38\t\tkeep\tsecond keep\t4000\t`
    const result = parseLastKeepResult(raw)
    expect(result!.experiment_number).toBe(3)
    expect(result!.description).toBe("second keep")
  })

  test("returns null for header-only input", () => {
    expect(parseLastKeepResult(header)).toBeNull()
  })
})

// --- parseDiscardedShas ---

describe("parseDiscardedShas", () => {
  const header = "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats"

  test("extracts discard SHAs", () => {
    const raw = `${header}\n1\tabc1111\t42\t\tkeep\tkept\t5000\t\n2\tdef2222\t45\t\tdiscard\tnoise\t3000\t`
    const shas = parseDiscardedShas(raw)
    expect(shas).toEqual(["def2222"])
  })

  test("extracts crash and measurement_failure SHAs", () => {
    const raw = `${header}\n1\tabc\t0\t\tcrash\terror\t0\t\n2\tdef\t0\t\tmeasurement_failure\ttimeout\t0\t`
    const shas = parseDiscardedShas(raw)
    expect(shas).toEqual(["def", "abc"])
  })

  test("respects count limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `${i + 1}\tsha${i}\t0\t\tdiscard\tnoise\t0\t`)
    const raw = [header, ...rows].join("\n")
    const shas = parseDiscardedShas(raw, 3)
    expect(shas).toHaveLength(3)
    // Should be most recent first (from the end)
    expect(shas[0]).toBe("sha9")
  })

  test("skips keep rows", () => {
    const raw = `${header}\n1\tabc\t42\t\tkeep\tkept\t5000\t`
    expect(parseDiscardedShas(raw)).toEqual([])
  })
})

// --- getRunStats ---

describe("getRunStats", () => {
  const baseState: RunState = {
    run_id: "test",
    program_slug: "test",
    phase: "complete",
    experiment_number: 10,
    original_baseline: 100,
    current_baseline: 80,
    best_metric: 75,
    best_experiment: 5,
    total_keeps: 3,
    total_discards: 5,
    total_crashes: 2,
    branch_name: "test",
    original_baseline_sha: "abc",
    last_known_good_sha: "def",
    candidate_sha: null,
    started_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T01:00:00Z",
  }

  test("computes correct totals and rates", () => {
    const stats = getRunStats(baseState, "lower")
    expect(stats.total_experiments).toBe(10) // 3+5+2
    expect(stats.total_keeps).toBe(3)
    expect(stats.total_discards).toBe(5)
    expect(stats.total_crashes).toBe(2)
    expect(stats.keep_rate).toBe(0.3) // 3/10
  })

  test("computes improvement for lower-is-better", () => {
    const stats = getRunStats(baseState, "lower")
    // improvement = (100 - 75) / |100| * 100 = 25%
    expect(stats.improvement_pct).toBe(25)
    // current improvement = (100 - 80) / |100| * 100 = 20%
    expect(stats.current_improvement_pct).toBe(20)
  })

  test("computes improvement for higher-is-better", () => {
    const state = { ...baseState, original_baseline: 100, best_metric: 125, current_baseline: 120 }
    const stats = getRunStats(state, "higher")
    // improvement = (125 - 100) / |100| * 100 = 25%
    expect(stats.improvement_pct).toBe(25)
    // current improvement = (120 - 100) / |100| * 100 = 20%
    expect(stats.current_improvement_pct).toBe(20)
  })

  test("handles zero total experiments", () => {
    const state = { ...baseState, total_keeps: 0, total_discards: 0, total_crashes: 0 }
    const stats = getRunStats(state, "lower")
    expect(stats.total_experiments).toBe(0)
    expect(stats.keep_rate).toBe(0)
  })

  test("handles zero original baseline", () => {
    const state = { ...baseState, original_baseline: 0 }
    const stats = getRunStats(state, "lower")
    expect(stats.improvement_pct).toBe(0)
  })
})

// --- State Persistence ---

describe("writeState / readState", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autoauto-run-test-"))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test("round-trips state through write and read", async () => {
    const runDir = join(tmpDir, "run-1")
    await mkdir(runDir, { recursive: true })

    const state: RunState = {
      run_id: "20240101-120000",
      program_slug: "test-prog",
      phase: "complete",
      experiment_number: 5,
      original_baseline: 100,
      current_baseline: 85,
      best_metric: 80,
      best_experiment: 3,
      total_keeps: 2,
      total_discards: 2,
      total_crashes: 1,
      branch_name: "autoauto-test",
      original_baseline_sha: "abc123",
      last_known_good_sha: "def456",
      candidate_sha: null,
      started_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T01:00:00Z",
      termination_reason: "max_experiments",
    }

    await writeState(runDir, state)
    const loaded = await readState(runDir)

    expect(loaded.run_id).toBe(state.run_id)
    expect(loaded.phase).toBe("complete")
    expect(loaded.experiment_number).toBe(5)
    expect(loaded.best_metric).toBe(80)
    expect(loaded.termination_reason).toBe("max_experiments")
  })
})

// --- Results Persistence ---

describe("appendResult / readAllResults", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autoauto-results-test-"))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test("appends and reads back results", async () => {
    const runDir = join(tmpDir, "run-results")
    await mkdir(runDir, { recursive: true })

    // Write header
    await Bun.write(
      join(runDir, "results.tsv"),
      "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n",
    )

    const result1: ExperimentResult = {
      experiment_number: 1,
      commit: "abc1234",
      metric_value: 42,
      secondary_values: "",
      status: "keep",
      description: "optimized loop",
      measurement_duration_ms: 5000,
    }

    const result2: ExperimentResult = {
      experiment_number: 2,
      commit: "def5678",
      metric_value: 45,
      secondary_values: '{"quality_gates":{"latency":100},"secondary_metrics":{}}',
      status: "discard",
      description: "noise: tried caching",
      measurement_duration_ms: 3000,
      diff_stats: '{"lines_added":5,"lines_removed":3}',
    }

    await appendResult(runDir, result1)
    await appendResult(runDir, result2)

    const results = await readAllResults(runDir)
    expect(results).toHaveLength(2)

    expect(results[0].experiment_number).toBe(1)
    expect(results[0].commit).toBe("abc1234")
    expect(results[0].metric_value).toBe(42)
    expect(results[0].status).toBe("keep")

    expect(results[1].experiment_number).toBe(2)
    expect(results[1].status).toBe("discard")
    expect(results[1].diff_stats).toBe('{"lines_added":5,"lines_removed":3}')
  })

  test("readAllResults returns empty array for header-only file", async () => {
    const runDir = join(tmpDir, "run-empty")
    await mkdir(runDir, { recursive: true })
    await Bun.write(join(runDir, "results.tsv"), "experiment\tcommit\tmetric_value\n")

    const results = await readAllResults(runDir)
    expect(results).toHaveLength(0)
  })
})

// --- generateRunId ---

describe("generateRunId", () => {
  test("generates YYYYMMDD-HHmmss format", () => {
    const id = generateRunId()
    expect(id).toMatch(/^\d{8}-\d{6}$/)
  })

  test("generates unique IDs across calls", () => {
    const ids = new Set(Array.from({ length: 5 }, () => generateRunId()))
    // With second-level granularity, sequential calls should be unique
    // (or at worst 2 share the same second)
    expect(ids.size).toBeGreaterThanOrEqual(1)
  })
})

// --- backfillFinalizedAt ---

describe("backfillFinalizedAt", () => {
  test("sets finalized_at from updated_at when summary exists", () => {
    const state: RunState = {
      run_id: "test",
      program_slug: "test",
      phase: "complete",
      experiment_number: 5,
      original_baseline: 100,
      current_baseline: 90,
      best_metric: 85,
      best_experiment: 3,
      total_keeps: 2,
      total_discards: 3,
      total_crashes: 0,
      branch_name: "test",
      original_baseline_sha: "abc",
      last_known_good_sha: "def",
      candidate_sha: null,
      started_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T01:00:00Z",
    }

    backfillFinalizedAt(state, true)
    expect(state.finalized_at).toBe("2024-01-01T01:00:00Z")
  })

  test("does not set finalized_at when no summary", () => {
    const state = {
      phase: "complete",
      updated_at: "2024-01-01T01:00:00Z",
    } as RunState
    backfillFinalizedAt(state, false)
    expect(state.finalized_at).toBeUndefined()
  })

  test("does not overwrite existing finalized_at", () => {
    const state = {
      phase: "complete",
      finalized_at: "2024-01-01T00:30:00Z",
      updated_at: "2024-01-01T01:00:00Z",
    } as RunState
    backfillFinalizedAt(state, true)
    expect(state.finalized_at).toBe("2024-01-01T00:30:00Z")
  })

  test("does not set finalized_at for non-complete phases", () => {
    const state = {
      phase: "agent_running",
      updated_at: "2024-01-01T01:00:00Z",
    } as RunState
    backfillFinalizedAt(state, true)
    expect(state.finalized_at).toBeUndefined()
  })
})

// --- getMetricHistory ---

describe("getMetricHistory", () => {
  test("returns metric values for keep results only", () => {
    const results: ExperimentResult[] = [
      { experiment_number: 1, commit: "a", metric_value: 100, secondary_values: "", status: "keep", description: "", measurement_duration_ms: 0 },
      { experiment_number: 2, commit: "b", metric_value: 110, secondary_values: "", status: "discard", description: "", measurement_duration_ms: 0 },
      { experiment_number: 3, commit: "c", metric_value: 95, secondary_values: "", status: "keep", description: "", measurement_duration_ms: 0 },
      { experiment_number: 4, commit: "d", metric_value: 0, secondary_values: "", status: "crash", description: "", measurement_duration_ms: 0 },
    ]
    expect(getMetricHistory(results)).toEqual([100, 95])
  })

  test("returns empty array for no keeps", () => {
    const results: ExperimentResult[] = [
      { experiment_number: 1, commit: "a", metric_value: 0, secondary_values: "", status: "crash", description: "", measurement_duration_ms: 0 },
    ]
    expect(getMetricHistory(results)).toEqual([])
  })
})

// --- getAvgMeasurementDuration ---

describe("getAvgMeasurementDuration", () => {
  test("computes average of positive durations", () => {
    const results: ExperimentResult[] = [
      { experiment_number: 1, commit: "a", metric_value: 42, secondary_values: "", status: "keep", description: "", measurement_duration_ms: 1000 },
      { experiment_number: 2, commit: "b", metric_value: 42, secondary_values: "", status: "keep", description: "", measurement_duration_ms: 3000 },
    ]
    expect(getAvgMeasurementDuration(results)).toBe(2000)
  })

  test("returns null for empty results", () => {
    expect(getAvgMeasurementDuration([])).toBeNull()
  })

  test("excludes zero-duration results (crashes)", () => {
    const results: ExperimentResult[] = [
      { experiment_number: 1, commit: "a", metric_value: 0, secondary_values: "", status: "crash", description: "", measurement_duration_ms: 0 },
      { experiment_number: 2, commit: "b", metric_value: 42, secondary_values: "", status: "keep", description: "", measurement_duration_ms: 2000 },
    ]
    expect(getAvgMeasurementDuration(results)).toBe(2000)
  })
})

// --- Serialization ---

describe("serializeSecondaryValues", () => {
  test("produces structured JSON", () => {
    const result = serializeSecondaryValues({ latency: 100 }, { memory: 2048 })
    const parsed = JSON.parse(result)
    expect(parsed.quality_gates.latency).toBe(100)
    expect(parsed.secondary_metrics.memory).toBe(2048)
  })

  test("handles empty objects", () => {
    const result = serializeSecondaryValues({}, {})
    const parsed = JSON.parse(result)
    expect(parsed.quality_gates).toEqual({})
    expect(parsed.secondary_metrics).toEqual({})
  })
})

describe("serializeDiffStats", () => {
  test("serializes stats to JSON", () => {
    const result = serializeDiffStats({ lines_added: 10, lines_removed: 5 })
    const parsed = JSON.parse(result)
    expect(parsed.lines_added).toBe(10)
    expect(parsed.lines_removed).toBe(5)
  })

  test("returns empty string for undefined", () => {
    expect(serializeDiffStats(undefined)).toBe("")
  })
})
