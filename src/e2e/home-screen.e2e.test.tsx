import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import type { Screen } from "../lib/programs.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"

type TestSetup = Awaited<ReturnType<typeof testRender>>

const noop = () => {}

/** Flush async effects (useEffect data loading) and render */
async function flush(setup: TestSetup, ms = 200): Promise<string> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
  await act(async () => {
    await setup.renderOnce()
  })
  return setup.captureCharFrame()
}

async function press(setup: TestSetup, key: string): Promise<string> {
  await act(async () => {
    await setup.mockInput.pressKeys([key])
    await setup.renderOnce()
  })
  return setup.captureCharFrame()
}

describe("HomeScreen E2E", () => {
  let fixture: TestFixture

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

  afterAll(async () => {
    await fixture.cleanup()
  })

  test("displays programs loaded from fixture", async () => {
    const setup = await testRender(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120, height: 30, useKittyKeyboard: {} },
    )

    try {
      const frame = await flush(setup)
      expect(frame).toContain("perf-benchmark")
      expect(frame).toContain("accuracy-test")
    } finally {
      await act(async () => { setup.renderer.destroy() })
    }
  })

  test("navigates programs with j/k keys", async () => {
    const setup = await testRender(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120, height: 30, useKittyKeyboard: {} },
    )

    try {
      await flush(setup)

      // Press j to move down, k to move up — should not crash
      const afterJ = await press(setup, "j")
      expect(afterJ).toContain("perf-benchmark")
      expect(afterJ).toContain("accuracy-test")

      const afterK = await press(setup, "k")
      expect(afterK).toContain("perf-benchmark")
    } finally {
      await act(async () => { setup.renderer.destroy() })
    }
  })

  test("Tab switches between panels", async () => {
    const setup = await testRender(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120, height: 30, useKittyKeyboard: {} },
    )

    try {
      await flush(setup)

      // Tab to runs panel
      const frame = await press(setup, "\t")
      expect(frame).toContain("Runs")
    } finally {
      await act(async () => { setup.renderer.destroy() })
    }
  })

  test("opens settings with s key", async () => {
    let lastNav: Screen | null = null

    const setup = await testRender(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={(s) => { lastNav = s }}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120, height: 30, useKittyKeyboard: {} },
    )

    try {
      await flush(setup)
      await press(setup, "s")
      expect(lastNav).toBe("settings")
    } finally {
      await act(async () => { setup.renderer.destroy() })
    }
  })

  test("Enter triggers onSelectProgram", async () => {
    let selectedProgram: string | null = null

    const setup = await testRender(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={(slug) => { selectedProgram = slug }}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120, height: 30, useKittyKeyboard: {} },
    )

    try {
      await flush(setup)
      await press(setup, "\r")
      expect(selectedProgram).not.toBeNull()
    } finally {
      await act(async () => { setup.renderer.destroy() })
    }
  })

  test("shows run info in side panel", async () => {
    const setup = await testRender(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120, height: 30, useKittyKeyboard: {} },
    )

    try {
      const frame = await flush(setup)
      // The runs panel should show the run from perf-benchmark (shows program name, experiment count)
      expect(frame).toContain("perf-benchmark")
      expect(frame).toContain("Runs")
    } finally {
      await act(async () => { setup.renderer.destroy() })
    }
  })
})
