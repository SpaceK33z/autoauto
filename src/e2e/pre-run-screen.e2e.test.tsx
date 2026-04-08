import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { PreRunScreen, type PreRunOverrides } from "../screens/PreRunScreen.tsx"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"

const DEFAULT_MODEL: ModelSlot = { provider: "claude", model: "sonnet", effort: "high" }

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  setProvider("claude", new MockProvider())
  fixture = await createTestFixture()
  await fixture.createProgram("bench-test", {
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

describe("PreRunScreen E2E", () => {
  test("displays program name and config fields", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={() => {}}
        onStart={() => {}}
      />,
    )
    const frame = await harness.waitForText("Max Experiments")
    expect(frame).toContain("bench-test")
    expect(frame).toContain("Provider")
    expect(frame).toContain("Claude")
    expect(frame).toContain("Worktree")
  })

  test("loads max_experiments from program config", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={() => {}}
        onStart={() => {}}
      />,
    )
    // The program has max_experiments: 15, which should pre-fill
    const frame = await harness.waitForText("15")
    expect(frame).toContain("15")
  })

  test("navigates fields with Tab/j", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={() => {}}
        onStart={() => {}}
      />,
    )
    await harness.waitForText("Max Experiments")
    // Tab through fields
    await harness.tab()
    let frame = await harness.frame()
    expect(frame).toContain("Provider")
    await harness.tab()
    frame = await harness.frame()
    expect(frame).toContain("Model")
  })

  test("types max experiments value", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={() => {}}
        onStart={() => {}}
      />,
    )
    await harness.waitForText("Max Experiments")
    // Clear and type new value (backspace removes existing, then type)
    for (let i = 0; i < 3; i++) await harness.backspace()
    await harness.type("25")
    const frame = await harness.frame()
    expect(frame).toContain("25")
  })

  test("Enter triggers onStart with overrides", async () => {
    let startOverrides: PreRunOverrides | null = null
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={() => {}}
        onStart={(o) => { startOverrides = o }}
      />,
    )
    await harness.waitForText("15")
    await harness.enter()
    expect(startOverrides).not.toBeNull()
    expect(startOverrides!.maxExperiments).toBe(15)
    expect(startOverrides!.modelConfig.provider).toBe("claude")
    expect(startOverrides!.useWorktree).toBe(true)
  })

  test("Escape navigates home", async () => {
    let lastNav: Screen | null = null
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={(s) => { lastNav = s }}
        onStart={() => {}}
      />,
    )
    await harness.waitForText("Max Experiments")
    await harness.escape()
    expect(lastNav).toBe("home")
  })

  test("toggles worktree mode", async () => {
    harness = await renderTui(
      <PreRunScreen
        cwd={fixture.cwd}
        programSlug="bench-test"
        defaultModelConfig={DEFAULT_MODEL}
        navigate={() => {}}
        onStart={() => {}}
      />,
    )
    await harness.waitForText("Max Experiments")
    // Navigate to run mode field (row 4)
    for (let i = 0; i < 4; i++) await harness.tab()
    let frame = await harness.frame()
    expect(frame).toContain("Worktree")
    // Toggle to in-place
    await harness.press("l")
    frame = await harness.frame()
    expect(frame).toContain("In-place")
    expect(frame).toContain("DANGER")
  })
})
