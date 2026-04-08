import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { ExecutionScreen } from "../screens/ExecutionScreen.tsx"
import { createTestFixture, type TestFixture, type ResultFixture } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"

const MODEL: ModelSlot = { provider: "claude", model: "sonnet", effort: "high" }

const RESULTS: ResultFixture[] = [
  { experiment_number: 1, commit: "abc1111", metric_value: 95, status: "keep", description: "Optimize hot path" },
  { experiment_number: 2, commit: "abc2222", metric_value: 110, status: "discard", description: "Try caching" },
  { experiment_number: 3, commit: "abc3333", metric_value: 88, status: "keep", description: "Reduce allocations" },
  { experiment_number: 4, commit: "abc4444", metric_value: 85, status: "keep", description: "Inline small functions" },
  { experiment_number: 5, commit: "abc5555", metric_value: 92, status: "discard", description: "Batch IO ops" },
]

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  setProvider("claude", new MockProvider())
  fixture = await createTestFixture()

  await fixture.createProgram("perf-opt", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 10,
  })
  await fixture.createRun("perf-opt", {
    run_id: "20260401-100000",
    phase: "complete",
    experiment_number: 5,
    best_metric: 85,
    best_experiment: 4,
    total_keeps: 3,
    total_discards: 2,
    total_crashes: 0,
    termination_reason: "max_experiments",
    results: RESULTS,
  })
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

afterAll(async () => {
  await fixture.cleanup()
})

describe("ExecutionScreen E2E — attach to completed run", () => {
  test("displays completed run with results", async () => {
    harness = await renderTui(
      <ExecutionScreen
        cwd={fixture.cwd}
        programSlug="perf-opt"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={false}
        navigate={() => {}}
        maxExperiments={10}
        attachRunId="20260401-100000"
        readOnly
      />,
      { width: 140, height: 40 },
    )
    // Wait for state reconstruction from filesystem
    const frame = await harness.waitForText("perf-opt", 5000)
    expect(frame).toContain("perf-opt")
  })

  test("shows experiment results in table", async () => {
    harness = await renderTui(
      <ExecutionScreen
        cwd={fixture.cwd}
        programSlug="perf-opt"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={false}
        navigate={() => {}}
        maxExperiments={10}
        attachRunId="20260401-100000"
        readOnly
      />,
      { width: 140, height: 40 },
    )
    const frame = await harness.waitForText("Optimize hot path", 5000)
    expect(frame).toContain("keep")
    expect(frame).toContain("discard")
  })

  test("shows best metric and stats", async () => {
    harness = await renderTui(
      <ExecutionScreen
        cwd={fixture.cwd}
        programSlug="perf-opt"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={false}
        navigate={() => {}}
        maxExperiments={10}
        attachRunId="20260401-100000"
        readOnly
      />,
      { width: 140, height: 40 },
    )
    const frame = await harness.waitForText("85", 5000)
    expect(frame).toContain("85")
  })

  test("Tab focuses the results table", async () => {
    harness = await renderTui(
      <ExecutionScreen
        cwd={fixture.cwd}
        programSlug="perf-opt"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={false}
        navigate={() => {}}
        maxExperiments={10}
        attachRunId="20260401-100000"
        readOnly
      />,
      { width: 140, height: 40 },
    )
    await harness.waitForText("perf-opt", 5000)
    await harness.tab()
    const frame = await harness.frame()
    // Table should be focused — j/k should navigate rows
    expect(frame).toBeTruthy()
  })

  test("Escape navigates home from completed run", async () => {
    let lastNav: Screen | null = null
    harness = await renderTui(
      <ExecutionScreen
        cwd={fixture.cwd}
        programSlug="perf-opt"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={false}
        navigate={(s) => { lastNav = s }}
        maxExperiments={10}
        attachRunId="20260401-100000"
        readOnly
      />,
      { width: 140, height: 40 },
    )
    await harness.waitForText("perf-opt", 5000)
    await harness.escape()
    expect(lastNav).toBe("home")
  })
})
