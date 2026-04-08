import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { FirstSetupScreen } from "../screens/FirstSetupScreen.tsx"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import type { ProjectConfig } from "../lib/config.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  setProvider("claude", new MockProvider())
  setProvider("codex", new MockProvider([], { authenticated: true, account: { email: "test@example.com" } }, [
    { provider: "codex", model: "default", label: "Codex Default", isDefault: true },
  ]))
  setProvider("opencode", new MockProvider([], { authenticated: true, account: { email: "test@example.com" } }, [
    { provider: "opencode", model: "default", label: "OpenCode Default", isDefault: true },
  ]))
  fixture = await createTestFixture()
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
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
    // Move to model row
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
    // On provider row, press right to cycle
    await harness.press("l")
    const frame = await harness.frame()
    // Should have cycled away from Claude
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
    // Navigate to Continue row (row 3 with effort visible for Claude)
    await harness.press("j")
    await harness.press("j")
    await harness.press("j")
    await harness.enter()
    // Wait for async auth check to complete
    await harness.waitForText("setup", 3000).catch(() => {})
    // Give it a moment for the callback to fire
    await harness.flush(300)
    expect(lastNav).toBe("setup")
    expect(savedConfig).not.toBeNull()
    expect(savedConfig!.executionModel.provider).toBe("claude")
  })

  test("shows auth error on failure", async () => {
    // Register a failing auth provider
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
    // Navigate to Continue and press Enter
    await harness.press("j")
    await harness.press("j")
    await harness.press("j")
    await harness.enter()
    const frame = await harness.waitForText("Auth failed", 3000)
    expect(frame).toContain("Invalid API key")

    // Restore working provider for other tests
    setProvider("claude", new MockProvider())
  })
})
