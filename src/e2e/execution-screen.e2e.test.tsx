import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { ExecutionScreen } from "../screens/ExecutionScreen.tsx"
import { createTestFixture, type TestFixture, type ResultFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"

const MODEL = DEFAULT_CONFIG.executionModel

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
  registerMockProviders()
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

function renderExecution(navigateFn: (s: Screen) => void = () => {}) {
  return renderTui(
    <ExecutionScreen
      cwd={fixture.cwd}
      programSlug="perf-opt"
      modelConfig={MODEL}
      supportModelConfig={MODEL}
      ideasBacklogEnabled={false}
      navigate={navigateFn}
      maxExperiments={10}
      attachRunId="20260401-100000"
      readOnly
    />,
    { width: 140, height: 40 },
  )
}

function renderExecutionCompact(navigateFn: (s: Screen) => void = () => {}) {
  return renderTui(
    <ExecutionScreen
      cwd={fixture.cwd}
      programSlug="perf-opt"
      modelConfig={MODEL}
      supportModelConfig={MODEL}
      ideasBacklogEnabled={false}
      navigate={navigateFn}
      maxExperiments={10}
      attachRunId="20260401-100000"
      readOnly
    />,
    { width: 120, height: 12 },
  )
}

describe("ExecutionScreen E2E — attach to completed run", () => {
  test("displays completed run with results", async () => {
    harness = await renderExecution()
    // Wait for state reconstruction — results only appear after async load
    const frame = await harness.waitForText("Optimize hot path", 5000)
    expect(frame).toContain("keep")
    expect(frame).toContain("discard")
  })

  test("shows stats header with experiment counts", async () => {
    harness = await renderExecution()
    const frame = await harness.waitForText("kept 3", 5000)
    expect(frame).toContain("disc 2")
  })

  test("Tab then j navigates results table", async () => {
    harness = await renderExecution()
    await harness.waitForText("Optimize hot path", 5000)
    await harness.tab()
    await harness.press("j")
    const frame = await harness.frame()
    expect(frame).toContain("Optimize hot path")
  })

  test("Escape navigates home from completed run", async () => {
    let lastNav: Screen | null = null
    harness = await renderExecution((s) => { lastNav = s })
    await harness.waitForText("kept 3", 5000)
    await harness.escape()
    expect(lastNav).toBe("home")
  })

  test("shows keyboard shortcuts bar at the bottom", async () => {
    harness = await renderExecution()
    await harness.waitForText("kept 3", 5000)
    const frame = await harness.frame()
    expect(frame).toContain("Esc back")
    expect(frame).toContain("f finalize")
  })

  test("keeps results area stable in short terminals", async () => {
    harness = await renderExecutionCompact()
    // Wait for completed state to load (stats header shows "kept 3" once run data is reconstructed)
    const frame = await harness.waitForText("kept 3", 5000)
    const lines = frame.split("\n")
    const resultsLine = lines.find((line) => line.includes("Results"))
    const headerLine = lines.find((line) => line.includes("commit"))

    expect(resultsLine).toBeDefined()
    expect(headerLine).toBeDefined()
    // Verify no text overlap between adjacent rows
    expect(resultsLine).not.toContain("kept")
    expect(resultsLine).not.toContain("disc")
    expect(headerLine).not.toContain("baseline")
    expect(headerLine).not.toContain("best")
  })
})
