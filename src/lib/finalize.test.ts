import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import {
  buildFinalizeContext,
  buildFinalizeInitialMessage,
  extractFinalizeDone,
  generateSummaryReport,
  saveFinalizeReport,
} from "./finalize.ts"
import type { ProgramConfig } from "./programs.ts"
import type { RunState } from "./run.ts"

const TEST_CONFIG: ProgramConfig = {
  metric_field: "runtime_ms",
  direction: "lower",
  noise_threshold: 0.01,
  repeats: 1,
  quality_gates: {},
  max_experiments: 5,
}

async function createFinalizeFixture(): Promise<{
  cleanup: () => Promise<void>
  projectRoot: string
  runDir: string
  state: RunState
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "autoauto-finalize-project-"))
  const runDir = await mkdtemp(join(tmpdir(), "autoauto-finalize-run-"))

  await $`git init`.cwd(projectRoot).quiet()
  await $`git config user.name "AutoAuto Test"`.cwd(projectRoot).quiet()
  await $`git config user.email "test@example.com"`.cwd(projectRoot).quiet()

  await Bun.write(join(projectRoot, "feature.ts"), "export const value = 1\n")
  await $`git add feature.ts`.cwd(projectRoot).quiet()
  await $`git commit -m baseline`.cwd(projectRoot).quiet()

  const baselineSha = (await $`git rev-parse HEAD`.cwd(projectRoot).text()).trim()
  const branchName = (await $`git rev-parse --abbrev-ref HEAD`.cwd(projectRoot).text()).trim()

  await Bun.write(join(projectRoot, "feature.ts"), "export const value = 2\n")
  await $`git commit -am "improve metric"`.cwd(projectRoot).quiet()

  const headSha = (await $`git rev-parse HEAD`.cwd(projectRoot).text()).trim()
  await Bun.write(
    join(runDir, "results.tsv"),
    [
      "experiment_number\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats",
      `0\t${baselineSha}\t100\t\tkeep\tbaseline\t500\t`,
      `1\t${headSha}\t90\t\tkeep\tImprove metric\t1000\t`,
    ].join("\n") + "\n",
  )

  const now = new Date().toISOString()
  const state: RunState = {
    run_id: "20260408-000000",
    program_slug: "demo",
    phase: "complete",
    experiment_number: 1,
    original_baseline: 100,
    current_baseline: 90,
    best_metric: 90,
    best_experiment: 1,
    total_keeps: 1,
    total_discards: 0,
    total_crashes: 0,
    branch_name: branchName,
    original_baseline_sha: baselineSha,
    last_known_good_sha: headSha,
    candidate_sha: null,
    started_at: now,
    updated_at: now,
    provider: "claude",
    model: "test-model",
    effort: "low",
    termination_reason: "max_experiments",
    original_branch: "main",
    error: null,
    error_phase: null,
  }

  return {
    projectRoot,
    runDir,
    state,
    cleanup: () => Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(runDir, { recursive: true, force: true }),
    ]).then(() => {}),
  }
}

describe("extractFinalizeDone", () => {
  test("extracts branch name from valid marker", () => {
    const text = `All done!\n\n<finalize_done branch="autoauto-demo-20260408" />`
    expect(extractFinalizeDone(text)).toBe("autoauto-demo-20260408")
  })

  test("returns null when no marker present", () => {
    expect(extractFinalizeDone("just some text without a marker")).toBeNull()
  })

  test("returns null for marker in code block far from end", () => {
    const codeBlock = "```\n<finalize_done branch=\"fake\" />\n```"
    const padding = "x".repeat(600)
    expect(extractFinalizeDone(codeBlock + padding)).toBeNull()
  })

  test("extracts marker at end after content", () => {
    const text = "Summary of changes.\n\n<finalize_done branch=\"my-branch\" />"
    expect(extractFinalizeDone(text)).toBe("my-branch")
  })

  test("returns null for malformed marker", () => {
    expect(extractFinalizeDone("<finalize_done />")).toBeNull()
    expect(extractFinalizeDone("<finalize_done branch= />")).toBeNull()
    expect(extractFinalizeDone("finalize_done branch=\"x\"")).toBeNull()
  })

  test("handles branch names with slashes and hyphens", () => {
    const text = `<finalize_done branch="feature/autoauto-prog-20260408-143022" />`
    expect(extractFinalizeDone(text)).toBe("feature/autoauto-prog-20260408-143022")
  })
})

describe("buildFinalizeContext", () => {
  test("returns correct context shape", async () => {
    const fixture = await createFinalizeFixture()
    try {
      const context = await buildFinalizeContext(
        fixture.projectRoot,
        fixture.runDir,
        fixture.state,
        TEST_CONFIG,
      )

      expect(context.programSlug).toBe("demo")
      expect(context.branchName).toBe(fixture.state.branch_name)
      expect(context.originalBranch).toBe("main")
      expect(context.originalBaselineSha).toBe(fixture.state.original_baseline_sha)
      expect(context.results.length).toBeGreaterThan(0)
      expect(context.stats.total_keeps).toBe(1)
      expect(context.changedFiles).toContain("feature.ts")
      expect(context.riskAssessmentEnabled).toBe(true)
      expect(context.cwd).toBe(fixture.projectRoot)
    } finally {
      await fixture.cleanup()
    }
  })

  test("respects finalize_risk_assessment=false", async () => {
    const fixture = await createFinalizeFixture()
    try {
      const context = await buildFinalizeContext(
        fixture.projectRoot,
        fixture.runDir,
        fixture.state,
        { ...TEST_CONFIG, finalize_risk_assessment: false },
      )
      expect(context.riskAssessmentEnabled).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("buildFinalizeInitialMessage", () => {
  test("includes run stats and results", async () => {
    const fixture = await createFinalizeFixture()
    try {
      const context = await buildFinalizeContext(
        fixture.projectRoot,
        fixture.runDir,
        fixture.state,
        TEST_CONFIG,
      )
      const message = await buildFinalizeInitialMessage(context)

      expect(message).toContain("demo")
      expect(message).toContain("Run Statistics")
      expect(message).toContain("Experiment Results")
      expect(message).toContain("Changed Files")
      expect(message).toContain("feature.ts")
      expect(message).toContain("Git History")
      expect(message).toContain("Full Diff")
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("generateSummaryReport", () => {
  test("generates markdown report", () => {
    const now = new Date().toISOString()
    const state: RunState = {
      run_id: "20260408-000000",
      program_slug: "test-prog",
      phase: "complete",
      experiment_number: 2,
      original_baseline: 100,
      current_baseline: 85,
      best_metric: 85,
      best_experiment: 2,
      total_keeps: 2,
      total_discards: 1,
      total_crashes: 0,
      branch_name: "autoauto-test",
      original_baseline_sha: "abc1234567",
      last_known_good_sha: "def7890123",
      candidate_sha: null,
      started_at: now,
      updated_at: now,
      error: null,
      error_phase: null,
    }

    const results = [
      { experiment_number: 1, commit: "aaa1111111", metric_value: 95, secondary_values: "", status: "keep" as const, description: "First improvement", measurement_duration_ms: 1000 },
      { experiment_number: 2, commit: "bbb2222222", metric_value: 90, secondary_values: "", status: "discard" as const, description: "Failed attempt", measurement_duration_ms: 800 },
      { experiment_number: 3, commit: "ccc3333333", metric_value: 85, secondary_values: "", status: "keep" as const, description: "Second improvement", measurement_duration_ms: 900 },
    ]

    const report = generateSummaryReport(state, results, TEST_CONFIG, "Agent review text here.")

    expect(report).toContain("# Run Summary: test-prog")
    expect(report).toContain("## Overview")
    expect(report).toContain("## Statistics")
    expect(report).toContain("## Metric Timeline")
    expect(report).toContain("## Kept Changes")
    expect(report).toContain("## Agent Review")
    expect(report).toContain("Agent review text here.")
    expect(report).toContain("First improvement")
    expect(report).toContain("Second improvement")
    expect(report).not.toContain("Finalize Groups")
  })
})

describe("saveFinalizeReport", () => {
  test("writes summary.md to run directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-finalize-report-"))
    try {
      await saveFinalizeReport(runDir, "# Test Summary\n\nSome content.")

      const written = await Bun.file(join(runDir, "summary.md")).text()
      expect(written).toBe("# Test Summary\n\nSome content.")
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })
})
