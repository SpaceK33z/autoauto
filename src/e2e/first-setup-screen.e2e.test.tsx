import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { FirstSetupScreen } from "../screens/FirstSetupScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import type { ProjectConfig } from "../lib/config.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders()
  fixture = await createTestFixture()
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
  // Restore default mock provider in case a test replaced it
  setProvider("claude", new MockProvider())
})

afterAll(async () => {
  await fixture.cleanup()
})

describe("FirstSetupScreen E2E", () => {
  test("displays welcome message and provider/model fields", async () => {
    harness = await renderTui(
      <FirstSetupScreen
        cwd={fixture.cwd}
        navigate={() => {}}
        onConfigChange={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("First-Time Setup")
    expect(frame).toContain("Welcome")
    expect(frame).toContain("Provider")
    expect(frame).toContain("Claude")
    expect(frame).toContain("Model")
    expect(frame).toContain("Continue")
  })

  test("navigates fields with j/k", async () => {
    harness = await renderTui(
      <FirstSetupScreen
        cwd={fixture.cwd}
        navigate={() => {}}
        onConfigChange={() => {}}
      />,
    )
    await harness.frame()
    await harness.press("j")
    const frame = await harness.frame()
    expect(frame).toContain("Model")
  })

  test("cycles provider with arrow keys", async () => {
    harness = await renderTui(
      <FirstSetupScreen
        cwd={fixture.cwd}
        navigate={() => {}}
        onConfigChange={() => {}}
      />,
    )
    await harness.frame()
    await harness.press("l")
    const frame = await harness.frame()
    expect(frame).toContain("Codex")
  })

  test("Continue checks auth and navigates to setup on success", async () => {
    let lastNav: Screen | null = null
    let savedConfig: ProjectConfig | null = null
    harness = await renderTui(
      <FirstSetupScreen
        cwd={fixture.cwd}
        navigate={(s) => { lastNav = s }}
        onConfigChange={(c) => { savedConfig = c }}
      />,
    )
    await harness.frame()
    await harness.press("j")
    await harness.press("j")
    await harness.press("j")
    await harness.enter()
    await harness.waitForText("setup", 3000).catch(() => {})
    await harness.flush(300)
    expect(lastNav).toBe("setup")
    expect(savedConfig).not.toBeNull()
    expect(savedConfig!.executionModel.provider).toBe("claude")
  })

  test("shows auth error on failure", async () => {
    setProvider("claude", new MockProvider(
      [],
      { authenticated: false, error: "Invalid API key" },
    ))
    harness = await renderTui(
      <FirstSetupScreen
        cwd={fixture.cwd}
        navigate={() => {}}
        onConfigChange={() => {}}
      />,
    )
    await harness.frame()
    await harness.press("j")
    await harness.press("j")
    await harness.press("j")
    await harness.enter()
    const frame = await harness.waitForText("Auth failed", 3000)
    expect(frame).toContain("Invalid API key")
  })
})
