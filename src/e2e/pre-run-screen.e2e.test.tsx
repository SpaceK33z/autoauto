import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { PreRunScreen, type PreRunOverrides } from "../screens/PreRunScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"

const MODEL = DEFAULT_CONFIG.executionModel

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders()
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

function renderPreRun(opts?: { navigate?: (s: Screen) => void; onStart?: (o: PreRunOverrides) => void }) {
  return renderTui(
    <PreRunScreen
      cwd={fixture.cwd}
      programSlug="bench-test"
      defaultModelConfig={MODEL}
      navigate={opts?.navigate ?? (() => {})}
      onStart={opts?.onStart ?? (() => {})}
    />,
  )
}

describe("PreRunScreen E2E", () => {
  test("displays program name and config fields", async () => {
    harness = await renderPreRun()
    const frame = await harness.waitForText("Max Experiments")
    expect(frame).toContain("bench-test")
    expect(frame).toContain("Provider")
    expect(frame).toContain("Claude")
    expect(frame).toContain("Worktree")
  })

  test("loads max_experiments from program config", async () => {
    harness = await renderPreRun()
    await harness.waitForText("15")
  })

  test("navigates fields with Tab/j", async () => {
    harness = await renderPreRun()
    await harness.waitForText("Max Experiments")
    await harness.tab()
    let frame = await harness.frame()
    expect(frame).toContain("Provider")
    await harness.tab()
    frame = await harness.frame()
    expect(frame).toContain("Model")
  })

  test("types max experiments value", async () => {
    harness = await renderPreRun()
    await harness.waitForText("Max Experiments")
    for (let i = 0; i < 3; i++) await harness.backspace()
    await harness.type("25")
    const frame = await harness.frame()
    expect(frame).toContain("25")
  })

  test("Enter triggers onStart with overrides", async () => {
    let startOverrides: PreRunOverrides | null = null
    harness = await renderPreRun({ onStart: (o) => { startOverrides = o } })
    await harness.waitForText("15")
    await harness.enter()
    expect(startOverrides).not.toBeNull()
    expect(startOverrides!.maxExperiments).toBe(15)
    expect(startOverrides!.modelConfig.provider).toBe("claude")
    expect(startOverrides!.useWorktree).toBe(true)
  })

  test("Escape navigates home", async () => {
    let lastNav: Screen | null = null
    harness = await renderPreRun({ navigate: (s) => { lastNav = s } })
    await harness.waitForText("Max Experiments")
    await harness.escape()
    expect(lastNav).toBe("home")
  })

  test("toggles worktree mode", async () => {
    harness = await renderPreRun()
    await harness.waitForText("Max Experiments")
    for (let i = 0; i < 5; i++) await harness.tab()
    let frame = await harness.frame()
    expect(frame).toContain("Worktree")
    await harness.press("l")
    frame = await harness.frame()
    expect(frame).toContain("In-place")
    expect(frame).toContain("DANGER")
  })
})
