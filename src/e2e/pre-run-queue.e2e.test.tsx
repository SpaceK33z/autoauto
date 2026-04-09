import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { PreRunScreen, type PreRunOverrides } from "../screens/PreRunScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"

const MODEL = DEFAULT_CONFIG.executionModel

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders()
  fixture = await createTestFixture()
  await fixture.createProgram("queue-prog", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 15,
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

describe("PreRunScreen — add to queue (a key)", () => {
  test("a key calls onAddToQueue when not on max experiments field", async () => {
    let queueOverrides: PreRunOverrides | null = null
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="queue-prog"
        defaultModelConfig={MODEL}
        navigate={() => {}}
        onStart={() => {}}
        onAddToQueue={(o) => { queueOverrides = o }}
      />,
    )
    await harness.waitForText("15")
    // Move off max experiments and budget cap fields (fields 0 and 1)
    await harness.tab()
    await harness.tab()
    await harness.press("a")
    expect(queueOverrides).not.toBeNull()
    expect(queueOverrides!.maxExperiments).toBe(15)
  })

  test("a key does nothing on max experiments field", async () => {
    let queueOverrides: PreRunOverrides | null = null
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="queue-prog"
        defaultModelConfig={MODEL}
        navigate={() => {}}
        onStart={() => {}}
        onAddToQueue={(o) => { queueOverrides = o }}
      />,
    )
    await harness.waitForText("15")
    // Stay on field 0
    await harness.press("a")
    expect(queueOverrides).toBeNull()
  })

  test("shows queue warning when programHasQueueEntries is true", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="queue-prog"
        defaultModelConfig={MODEL}
        navigate={() => {}}
        onStart={() => {}}
        onAddToQueue={() => {}}
        programHasQueueEntries={true}
      />,
    )
    const frame = await harness.waitForText("queued runs")
    expect(frame).toContain("This program has queued runs")
  })

  test("Enter is blocked when programHasQueueEntries is true", async () => {
    let started = false
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="queue-prog"
        defaultModelConfig={MODEL}
        navigate={() => {}}
        onStart={() => { started = true }}
        onAddToQueue={() => {}}
        programHasQueueEntries={true}
      />,
    )
    await harness.waitForText("15")
    await harness.enter()
    expect(started).toBe(false)
  })

  test("a key does nothing when onAddToQueue is not provided", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="queue-prog"
        defaultModelConfig={MODEL}
        navigate={() => {}}
        onStart={() => {}}
      />,
    )
    await harness.waitForText("15")
    await harness.tab()
    // Should not crash when pressing a without onAddToQueue
    await harness.press("a")
    const frame = await harness.frame()
    expect(frame).toContain("queue-prog")
  })
})
