import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import type { Screen } from "../lib/programs.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"

const noop = () => {}

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  fixture = await createTestFixture()

  await fixture.createProgram("perf-benchmark", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 20,
  })
  await fixture.createRun("perf-benchmark", {
    run_id: "20260401-100000",
    phase: "complete",
    total_keeps: 5,
    total_discards: 2,
    best_metric: 42,
    termination_reason: "max_experiments",
  })

  await fixture.createProgram("accuracy-test", {
    metric_field: "accuracy",
    direction: "higher",
    max_experiments: 10,
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

describe("HomeScreen E2E", () => {
  test("displays programs loaded from fixture", async () => {
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
    )
    const frame = await harness.waitForText("perf-benchmark")
    expect(frame).toContain("accuracy-test")
  })

  test("navigates programs with j/k keys", async () => {
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
    )
    await harness.waitForText("perf-benchmark")

    await harness.press("j")
    let frame = await harness.frame()
    expect(frame).toContain("perf-benchmark")
    expect(frame).toContain("accuracy-test")

    await harness.press("k")
    frame = await harness.frame()
    expect(frame).toContain("perf-benchmark")
  })

  test("Tab switches between panels", async () => {
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
    )
    await harness.waitForText("perf-benchmark")

    await harness.tab()
    const frame = await harness.frame()
    expect(frame).toContain("Runs")
  })

  test("opens settings with s key", async () => {
    let lastNav: Screen | null = null
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={(s) => { lastNav = s }}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
    )
    await harness.waitForText("perf-benchmark")
    await harness.press("s")
    expect(lastNav).toBe("settings")
  })

  test("Enter triggers onSelectProgram", async () => {
    let selectedProgram: string | null = null
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={(slug) => { selectedProgram = slug }}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
    )
    await harness.waitForText("perf-benchmark")
    await harness.enter()
    expect(selectedProgram).not.toBeNull()
  })

  test("shows run info in side panel", async () => {
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
    )
    const frame = await harness.waitForText("perf-benchmark")
    expect(frame).toContain("Runs")
  })
})
