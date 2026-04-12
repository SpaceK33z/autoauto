import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compareMetric,
  checkQualityGates,
  validateMeasurementOutput,
  runMeasurement,
  runMeasurementSeries,
} from "./measure.ts"
import type { ProgramConfig } from "./programs.ts"

// --- compareMetric ---

describe("compareMetric", () => {
  describe("direction=lower (lower is better)", () => {
    test("returns keep when metric improved beyond threshold", () => {
      // baseline=100, measured=90 → relativeChange = (100-90)/100 = 0.10 > 0.02
      expect(compareMetric(100, 90, 0.02, "lower")).toBe("keep")
    })

    test("returns regressed when metric worsened beyond threshold", () => {
      // baseline=100, measured=110 → relativeChange = (100-110)/100 = -0.10 < -0.02
      expect(compareMetric(100, 110, 0.02, "lower")).toBe("regressed")
    })

    test("returns noise when change is within threshold", () => {
      // baseline=100, measured=99 → relativeChange = (100-99)/100 = 0.01 < 0.02
      expect(compareMetric(100, 99, 0.02, "lower")).toBe("noise")
    })

    test("returns noise when metric is exactly equal", () => {
      expect(compareMetric(100, 100, 0.02, "lower")).toBe("noise")
    })

    test("returns keep at exact threshold boundary", () => {
      // relativeChange = (100-97)/100 = 0.03 > 0.02
      expect(compareMetric(100, 97, 0.02, "lower")).toBe("keep")
    })

    test("returns noise when improvement equals threshold exactly", () => {
      // relativeChange = (100-98)/100 = 0.02 — NOT strictly greater
      expect(compareMetric(100, 98, 0.02, "lower")).toBe("noise")
    })
  })

  describe("direction=higher (higher is better)", () => {
    test("returns keep when metric improved beyond threshold", () => {
      // baseline=100, measured=110 → relativeChange = (110-100)/100 = 0.10 > 0.02
      expect(compareMetric(100, 110, 0.02, "higher")).toBe("keep")
    })

    test("returns regressed when metric worsened beyond threshold", () => {
      // baseline=100, measured=90 → relativeChange = (90-100)/100 = -0.10 < -0.02
      expect(compareMetric(100, 90, 0.02, "higher")).toBe("regressed")
    })

    test("returns noise when change is within threshold", () => {
      // baseline=100, measured=101 → relativeChange = (101-100)/100 = 0.01 < 0.02
      expect(compareMetric(100, 101, 0.02, "higher")).toBe("noise")
    })
  })

  describe("edge cases", () => {
    test("handles very small baseline values", () => {
      // baseline=0.001, measured=0.0005 → relativeChange = (0.001-0.0005)/0.001 = 0.5
      expect(compareMetric(0.001, 0.0005, 0.02, "lower")).toBe("keep")
    })

    test("handles large noise threshold", () => {
      // With 50% threshold, even a 10% improvement is noise
      expect(compareMetric(100, 90, 0.5, "lower")).toBe("noise")
    })

    test("handles zero threshold (any change counts)", () => {
      expect(compareMetric(100, 99, 0, "lower")).toBe("keep")
      expect(compareMetric(100, 101, 0, "lower")).toBe("regressed")
      // Equal stays noise (0 > 0 is false)
      expect(compareMetric(100, 100, 0, "lower")).toBe("noise")
    })
  })
})

// --- checkQualityGates ---

describe("checkQualityGates", () => {
  test("passes when all gates satisfied", () => {
    const config = {
      quality_gates: { latency: { max: 1000 }, accuracy: { min: 0.9 } },
    } as ProgramConfig
    const output = { latency: 500, accuracy: 0.95 }
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  test("fails when max gate is exceeded", () => {
    const config = {
      quality_gates: { latency: { max: 1000 } },
    } as ProgramConfig
    const output = { latency: 1500 }
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain("latency=1500")
    expect(result.violations[0]).toContain("max 1000")
  })

  test("fails when min gate is not met", () => {
    const config = {
      quality_gates: { accuracy: { min: 0.9 } },
    } as ProgramConfig
    const output = { accuracy: 0.8 }
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toContain("accuracy=0.8")
    expect(result.violations[0]).toContain("min 0.9")
  })

  test("reports multiple violations", () => {
    const config = {
      quality_gates: { latency: { max: 100 }, accuracy: { min: 0.9 } },
    } as ProgramConfig
    const output = { latency: 200, accuracy: 0.5 }
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(false)
    expect(result.violations).toHaveLength(2)
  })

  test("skips missing fields without failing", () => {
    const config = {
      quality_gates: { latency: { max: 1000 } },
    } as ProgramConfig
    const output = {} as Record<string, number>
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(true)
  })

  test("passes when value equals max exactly", () => {
    const config = {
      quality_gates: { latency: { max: 1000 } },
    } as ProgramConfig
    const output = { latency: 1000 }
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(true)
  })

  test("passes when value equals min exactly", () => {
    const config = {
      quality_gates: { accuracy: { min: 0.9 } },
    } as ProgramConfig
    const output = { accuracy: 0.9 }
    const result = checkQualityGates(output, config)
    expect(result.passed).toBe(true)
  })

  test("handles gate with both min and max", () => {
    const config = {
      quality_gates: { score: { min: 10, max: 100 } },
    } as ProgramConfig
    expect(checkQualityGates({ score: 50 }, config).passed).toBe(true)
    expect(checkQualityGates({ score: 5 }, config).passed).toBe(false)
    expect(checkQualityGates({ score: 150 }, config).passed).toBe(false)
  })
})

// --- validateMeasurementOutput ---

describe("validateMeasurementOutput", () => {
  const baseConfig: ProgramConfig = {
    metric_field: "score",
    direction: "lower",
    noise_threshold: 0.02,
    repeats: 1,
    quality_gates: {},
    max_experiments: 10,
  }

  test("valid when metric field is present and finite", () => {
    const result = validateMeasurementOutput({ score: 42 }, baseConfig)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test("invalid when metric field is missing", () => {
    const result = validateMeasurementOutput({}, baseConfig)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("metric_field")
    expect(result.errors[0]).toContain("missing")
  })

  test("invalid when metric field is not a number", () => {
    const result = validateMeasurementOutput({ score: "hello" }, baseConfig)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("not a finite number")
  })

  test("invalid when metric field is Infinity", () => {
    const result = validateMeasurementOutput({ score: Infinity }, baseConfig)
    expect(result.valid).toBe(false)
  })

  test("invalid when metric field is NaN", () => {
    const result = validateMeasurementOutput({ score: NaN }, baseConfig)
    expect(result.valid).toBe(false)
  })

  test("validates quality gate fields", () => {
    const config = { ...baseConfig, quality_gates: { latency: { max: 1000 } } }
    const result = validateMeasurementOutput({ score: 42 }, config)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("latency")
  })

  test("validates secondary metric fields", () => {
    const config = { ...baseConfig, secondary_metrics: { memory: { direction: "lower" as const } } }
    const result = validateMeasurementOutput({ score: 42 }, config)
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain("memory")
  })

  test("valid with all required fields present", () => {
    const config = {
      ...baseConfig,
      quality_gates: { latency: { max: 1000 } },
      secondary_metrics: { memory: { direction: "lower" as const } },
    }
    const result = validateMeasurementOutput({ score: 42, latency: 500, memory: 1024 }, config)
    expect(result.valid).toBe(true)
  })
})

// --- runMeasurement ---

describe("runMeasurement", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autoauto-measure-test-"))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test("parses valid JSON output from measure.sh", async () => {
    const script = join(tmpDir, "measure-ok.sh")
    await Bun.write(script, '#!/bin/bash\necho \'{"score": 42, "latency": 100}\'')
    await chmod(script, 0o755)

    const result = await runMeasurement(script, tmpDir)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.output.score).toBe(42)
      expect(result.output.latency).toBe(100)
      expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    }
  })

  test("returns error on non-zero exit code", async () => {
    const script = join(tmpDir, "measure-fail.sh")
    await Bun.write(script, '#!/bin/bash\necho "something broke" >&2\nexit 1')
    await chmod(script, 0o755)

    const result = await runMeasurement(script, tmpDir)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain("exit code 1")
      expect(result.error).toContain("something broke")
    }
  })

  test("returns error on invalid JSON", async () => {
    const script = join(tmpDir, "measure-bad-json.sh")
    await Bun.write(script, '#!/bin/bash\necho "not json"')
    await chmod(script, 0o755)

    const result = await runMeasurement(script, tmpDir)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain("invalid JSON")
    }
  })

  test("returns error when stdout is an array", async () => {
    const script = join(tmpDir, "measure-array.sh")
    await Bun.write(script, '#!/bin/bash\necho \'[1, 2, 3]\'')
    await chmod(script, 0o755)

    const result = await runMeasurement(script, tmpDir)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain("must be a JSON object")
    }
  })

  test("returns error on timeout", async () => {
    const script = join(tmpDir, "measure-slow.sh")
    await Bun.write(script, '#!/bin/bash\nsleep 10\necho \'{"score": 1}\'')
    await chmod(script, 0o755)

    const result = await runMeasurement(script, tmpDir, 200) // 200ms timeout
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toContain("timed out")
    }
  })

  test("returns error immediately when signal is already aborted", async () => {
    const script = join(tmpDir, "measure-ok.sh") // doesn't matter, won't run
    const controller = new AbortController()
    controller.abort()

    const result = await runMeasurement(script, tmpDir, undefined, controller.signal)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error).toBe("aborted")
      expect(result.duration_ms).toBe(0)
    }
  })
})

// --- runMeasurementSeries ---

describe("runMeasurementSeries", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autoauto-series-test-"))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  const baseConfig: ProgramConfig = {
    metric_field: "score",
    direction: "lower",
    noise_threshold: 0.02,
    repeats: 3,
    quality_gates: {},
    max_experiments: 10,
  }

  test("computes median across multiple repeats", async () => {
    // Script that returns increasing values using a counter file
    const counterFile = join(tmpDir, "counter-median.txt")
    await Bun.write(counterFile, "0")
    const script = join(tmpDir, "measure-median.sh")
    await Bun.write(script, `#!/bin/bash
COUNT=$(cat "${counterFile}")
COUNT=$((COUNT + 1))
echo $COUNT > "${counterFile}"
case $COUNT in
  1) echo '{"score": 10}' ;;
  2) echo '{"score": 30}' ;;
  3) echo '{"score": 20}' ;;
esac
`)
    await chmod(script, 0o755)

    const result = await runMeasurementSeries(script, tmpDir, baseConfig)
    expect(result.success).toBe(true)
    expect(result.median_metric).toBe(20) // median of [10, 30, 20] = 20
    expect(result.individual_runs).toHaveLength(3)
  })

  test("fails when any repeat fails", async () => {
    const counterFile = join(tmpDir, "counter-fail.txt")
    await Bun.write(counterFile, "0")
    const script = join(tmpDir, "measure-partial-fail.sh")
    await Bun.write(script, `#!/bin/bash
COUNT=$(cat "${counterFile}")
COUNT=$((COUNT + 1))
echo $COUNT > "${counterFile}"
if [ $COUNT -eq 2 ]; then
  exit 1
fi
echo '{"score": 10}'
`)
    await chmod(script, 0o755)

    const result = await runMeasurementSeries(script, tmpDir, baseConfig)
    expect(result.success).toBe(false)
    expect(result.failure_reason).toBeDefined()
  })

  test("checks quality gates on median values", async () => {
    const script = join(tmpDir, "measure-gate.sh")
    await Bun.write(script, '#!/bin/bash\necho \'{"score": 50, "latency": 1500}\'')
    await chmod(script, 0o755)

    const config: ProgramConfig = {
      ...baseConfig,
      repeats: 1,
      quality_gates: { latency: { max: 1000 } },
    }

    const result = await runMeasurementSeries(script, tmpDir, config)
    expect(result.success).toBe(true)
    expect(result.quality_gates_passed).toBe(false)
    expect(result.gate_violations).toHaveLength(1)
    expect(result.gate_violations[0]).toContain("latency")
  })

  test("collects secondary metrics", async () => {
    const script = join(tmpDir, "measure-secondary.sh")
    await Bun.write(script, '#!/bin/bash\necho \'{"score": 50, "memory": 1024}\'')
    await chmod(script, 0o755)

    const config: ProgramConfig = {
      ...baseConfig,
      repeats: 1,
      secondary_metrics: { memory: { direction: "lower" } },
    }

    const result = await runMeasurementSeries(script, tmpDir, config)
    expect(result.success).toBe(true)
    expect(result.median_secondary_metrics.memory).toBe(1024)
  })

  test("returns aborted when signal fires", async () => {
    const script = join(tmpDir, "measure-abort.sh")
    await Bun.write(script, '#!/bin/bash\nsleep 10\necho \'{"score": 1}\'')
    await chmod(script, 0o755)

    const controller = new AbortController()
    // Abort quickly
    setTimeout(() => controller.abort(), 100)

    const config = { ...baseConfig, repeats: 1 }
    const result = await runMeasurementSeries(script, tmpDir, config, controller.signal)
    expect(result.success).toBe(false)
    expect(result.failure_reason).toContain("aborted")
  })
})
