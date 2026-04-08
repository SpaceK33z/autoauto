import { useState } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { SettingsScreen } from "../screens/SettingsScreen.tsx"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { DEFAULT_CONFIG, type ProjectConfig } from "../lib/config.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"

/** Wrapper that manages config state like the real App does. */
function SettingsWrapper({ cwd, onNavigate }: { cwd: string; onNavigate?: (s: string) => void }) {
  const [config, setConfig] = useState<ProjectConfig>({ ...DEFAULT_CONFIG })
  return (
    <SettingsScreen
      cwd={cwd}
      navigate={(s) => onNavigate?.(s)}
      config={config}
      onConfigChange={setConfig}
    />
  )
}

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

describe("SettingsScreen E2E", () => {
  test("displays all setting sections", async () => {
    harness = await renderTui(<SettingsWrapper cwd={fixture.cwd} />)
    const frame = await harness.frame()
    expect(frame).toContain("Settings")
    expect(frame).toContain("Execution Model")
    expect(frame).toContain("Support Model")
    expect(frame).toContain("Provider")
    expect(frame).toContain("Claude")
    expect(frame).toContain("Ideas Backlog")
  })

  test("navigates fields with j/k", async () => {
    harness = await renderTui(<SettingsWrapper cwd={fixture.cwd} />)
    await harness.frame()
    // Move down to Model row, then Effort row
    await harness.press("j")
    await harness.press("j")
    const frame = await harness.frame()
    // Effort row should be highlighted (row 2)
    expect(frame).toContain("Effort")
    expect(frame).toContain("High")
  })

  test("cycles execution provider with arrow keys", async () => {
    harness = await renderTui(<SettingsWrapper cwd={fixture.cwd} />)
    await harness.frame()
    // Row 0 is exec provider, press right to cycle away from Claude
    await harness.press("l")
    const frame = await harness.flush()
    // Execution provider should have cycled to Codex (Support Model still shows Claude)
    expect(frame).toContain("Codex")
  })

  test("toggles ideas backlog", async () => {
    harness = await renderTui(<SettingsWrapper cwd={fixture.cwd} />)
    await harness.frame()
    // Navigate to ideas backlog row (row 6)
    for (let i = 0; i < 6; i++) await harness.press("j")
    let frame = await harness.frame()
    expect(frame).toContain("Ideas Backlog")
    expect(frame).toContain("On")
    // Toggle it off
    await harness.press("l")
    frame = await harness.flush()
    expect(frame).toContain("Off")
  })

  test("Escape navigates home", async () => {
    let lastNav: string | null = null
    harness = await renderTui(
      <SettingsWrapper cwd={fixture.cwd} onNavigate={(s) => { lastNav = s }} />,
    )
    await harness.frame()
    await harness.escape()
    expect(lastNav).toBe("home")
  })

  test("toggles notifications on and shows command field", async () => {
    harness = await renderTui(<SettingsWrapper cwd={fixture.cwd} />)
    await harness.frame()
    // Navigate to notification toggle (row 7)
    for (let i = 0; i < 7; i++) await harness.press("j")
    // Toggle notifications on
    await harness.press("l")
    const frame = await harness.flush()
    expect(frame).toContain("Command")
  })
})
