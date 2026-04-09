import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import { resetProjectRoot } from "../lib/programs.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  fixture = await createTestFixture()
  await fixture.createProgram("bench-test", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 10,
  })
})

beforeEach(async () => {
  // Recreate queue before each test since some tests modify it
  await fixture.createQueueEntries([
    { programSlug: "bench-test", maxExperiments: 10 },
    { programSlug: "bench-test", maxExperiments: 20 },
  ])
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

afterAll(async () => {
  await fixture.cleanup()
})

function renderHome() {
  return renderTui(
    <HomeScreen
      cwd={fixture.cwd}
      navigate={noop}
      onSelectProgram={noop}
      onSelectRun={noop}
      onUpdateProgram={noop}
      onFinalizeRun={noop}
      onResumeDraft={noop}
    />,
    { width: 120 },
  )
}

describe("HomeScreen — queue panel", () => {
  test("displays queue panel with entry count", async () => {
    harness = await renderHome()
    const frame = await harness.waitForText("Queue (2)")
    expect(frame).toContain("bench-test")
  })

  test("Tab cycles to queue panel", async () => {
    harness = await renderHome()
    await harness.waitForText("Queue (2)")
    // Tab: programs → runs → queue
    await harness.tab()
    await harness.tab()
    // Now on queue panel — press d to verify we're in queue context
    await harness.press("d")
    // Entry should be removed
    await harness.waitForText("Queue (1)")
  })

  test("d on queue entry removes it", async () => {
    harness = await renderHome()
    await harness.waitForText("Queue (2)")
    await harness.tab()
    await harness.tab()
    await harness.press("d")
    await harness.waitForText("Queue (1)")
  })

  test("c on queue panel shows clear confirmation", async () => {
    harness = await renderHome()
    await harness.waitForText("Queue (2)")
    await harness.tab()
    await harness.tab()
    await harness.press("c")
    const frame = await harness.waitForText("Clear all queued runs?")
    expect(frame).toContain("Enter to confirm")
  })

  test("c then Enter clears all queue entries", async () => {
    harness = await renderHome()
    await harness.waitForText("Queue (2)")
    await harness.tab()
    await harness.tab()
    await harness.press("c")
    await harness.waitForText("Clear all queued runs?")
    await harness.enter()
    // Poll until the clear dialog disappears (async operation)
    let frame = ""
    for (let i = 0; i < 50; i++) {
      frame = await harness.flush(100)
      if (!frame.includes("Clear all queued runs?")) break
    }
    expect(frame).not.toContain("Clear all queued runs?")
    expect(frame).not.toContain("Queue (2)")
  })

  test("c then Escape cancels clear", async () => {
    harness = await renderHome()
    await harness.waitForText("Queue (2)")
    await harness.tab()
    await harness.tab()
    await harness.press("c")
    await harness.waitForText("Clear all queued runs?")
    await harness.escape()
    // Queue should still be there
    const frame = await harness.flush()
    expect(frame).toContain("Queue (2)")
  })
})
