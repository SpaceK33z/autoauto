import { describe, test, expect } from "bun:test"
import { checkLockViolation, buildExperimentPrompt, type ContextPacket } from "./experiment.ts"

// --- checkLockViolation ---

describe("checkLockViolation", () => {
  test("detects .autoauto/ files as violations", () => {
    const result = checkLockViolation([".autoauto/programs/test/measure.sh", "src/main.ts"])
    expect(result.violated).toBe(true)
    expect(result.files).toEqual([".autoauto/programs/test/measure.sh"])
  })

  test("no violation when no .autoauto files changed", () => {
    const result = checkLockViolation(["src/main.ts", "README.md"])
    expect(result.violated).toBe(false)
    expect(result.files).toHaveLength(0)
  })

  test("reports multiple violations", () => {
    const result = checkLockViolation([
      ".autoauto/programs/test/measure.sh",
      ".autoauto/programs/test/config.json",
      "src/main.ts",
    ])
    expect(result.violated).toBe(true)
    expect(result.files).toHaveLength(2)
  })

  test("handles empty file list", () => {
    const result = checkLockViolation([])
    expect(result.violated).toBe(false)
    expect(result.files).toHaveLength(0)
  })
})

// --- buildExperimentPrompt ---

describe("buildExperimentPrompt", () => {
  const basePacket: ContextPacket = {
    experiment: 3,
    current_baseline: 85,
    original_baseline: 100,
    best_metric: 80,
    best_experiment: 2,
    total_keeps: 2,
    total_discards: 1,
    metric_field: "score",
    direction: "lower",
    program_md: "# Test\nOptimize score.",
    recent_results: "experiment\tcommit\tscore\n1\tabc\t90\n2\tdef\t80",
    recent_git_log: "abc123 experiment 1\ndef456 experiment 2",
    last_outcome: "kept: improved to 80 (optimized loop)",
    discarded_diffs: "",
    ideas_backlog: "",
    consecutive_discards: 0,
    max_consecutive_discards: 10,
    previous_results: "",
    previous_ideas: "",
  }

  test("includes current state in prompt", () => {
    const prompt = buildExperimentPrompt(basePacket)
    expect(prompt).toContain("experiment 3")
    expect(prompt).toContain("Baseline score: 85")
    expect(prompt).toContain("lower is better")
    expect(prompt).toContain("Original baseline: 100")
    expect(prompt).toContain("Best achieved: 80 (experiment #2)")
    expect(prompt).toContain("2 keeps, 1 discards")
  })

  test("includes recent results", () => {
    const prompt = buildExperimentPrompt(basePacket)
    expect(prompt).toContain("Recent Results")
    expect(prompt).toContain("abc")
    expect(prompt).toContain("def")
  })

  test("includes last outcome", () => {
    const prompt = buildExperimentPrompt(basePacket)
    expect(prompt).toContain("Last Outcome")
    expect(prompt).toContain("kept: improved to 80")
  })

  test("includes secondary metrics section when present", () => {
    const packet = {
      ...basePacket,
      secondary_metrics: {
        memory: { direction: "lower" as const, last_kept_value: 1024 },
        latency: { direction: "lower" as const },
      },
    }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Secondary Metrics")
    expect(prompt).toContain("memory: 1024")
    expect(prompt).toContain("latency: unknown")
  })

  test("omits secondary metrics section when empty", () => {
    const prompt = buildExperimentPrompt(basePacket)
    expect(prompt).not.toContain("Secondary Metrics")
  })

  test("includes previous run section when present", () => {
    const packet = {
      ...basePacket,
      previous_results: "Run 20240101: 5 experiments, 2 kept",
      previous_ideas: "Try algorithmic approach",
    }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Previous Runs")
    expect(prompt).toContain("5 experiments, 2 kept")
    expect(prompt).toContain("Previous Run Ideas")
    expect(prompt).toContain("Try algorithmic approach")
  })

  test("includes stagnation termination note", () => {
    const packet = {
      ...basePacket,
      previous_results: "some data",
      previous_termination: "stagnation",
    }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("stagnation")
    expect(prompt).toContain("orthogonal approach")
  })

  test("includes exploration directive when discards are high", () => {
    const packet = { ...basePacket, consecutive_discards: 8, max_consecutive_discards: 10 }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Exploration Directive")
    expect(prompt).toContain("CRITICAL")
  })

  test("omits exploration directive when no consecutive discards", () => {
    const prompt = buildExperimentPrompt(basePacket)
    expect(prompt).not.toContain("Exploration Directive")
  })

  test("includes measurement diagnostics when present", () => {
    const packet = { ...basePacket, measurement_diagnostics: "Test X failed: expected 5, got 3" }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Measurement Diagnostics")
    expect(prompt).toContain("Test X failed")
  })

  test("includes ideas backlog when present", () => {
    const packet = { ...basePacket, ideas_backlog: "## Next\n- Try vectorization" }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Ideas Backlog")
    expect(prompt).toContain("Try vectorization")
  })

  test("includes turn budget when set", () => {
    const packet = { ...basePacket, max_turns: 25 }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Turn budget: 25")
  })

  test("includes discarded experiments section", () => {
    const packet = { ...basePacket, discarded_diffs: "diff --git a/foo.ts..." }
    const prompt = buildExperimentPrompt(packet)
    expect(prompt).toContain("Recently Discarded Experiments")
    expect(prompt).toContain("diff --git")
  })

  test("shows (none yet) when no discarded experiments", () => {
    const prompt = buildExperimentPrompt(basePacket)
    expect(prompt).toContain("(none yet)")
  })
})
