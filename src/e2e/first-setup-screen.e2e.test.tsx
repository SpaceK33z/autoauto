import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { FirstSetupScreen } from "../screens/FirstSetupScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import type { ProjectConfig } from "../lib/config.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"
import type { AuthResult } from "../lib/agent/types.ts"
import { getUserAuthConfigPath } from "../lib/user-auth.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders()
  fixture = await createTestFixture()
})

const originalConfigHome = process.env.AUTOAUTO_CONFIG_HOME
const originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
const originalApiKey = process.env.ANTHROPIC_API_KEY

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
  if (originalConfigHome === undefined) delete process.env.AUTOAUTO_CONFIG_HOME
  else process.env.AUTOAUTO_CONFIG_HOME = originalConfigHome
  if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  // Restore default mock provider in case a test replaced it
  setProvider("claude", new MockProvider())
})

class EnvClaudeProvider extends MockProvider {
  async checkAuth(): Promise<AuthResult> {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN === "persisted-token"
      ? { authenticated: true, account: { email: "persisted@example.com" } }
      : { authenticated: false, error: "No Claude auth configured" }
  }
}

async function focusContinue(harness: TuiHarness): Promise<void> {
  await Array.from({ length: 6 }).reduce(
    async (prev) => {
      await prev
      await harness.press("j")
    },
    Promise.resolve(),
  )
}

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
    const frame = await harness.flush()
    expect(frame).toContain("Codex")
    expect(frame).toContain("Codex / default")
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
    // Navigate to Continue button at row 6
    await focusContinue(harness)
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
    // Navigate to Continue button at row 6
    await focusContinue(harness)
    await harness.enter()
    const frame = await harness.waitForText("Auth failed", 3000)
    expect(frame).toContain("Invalid API key")
  })

  test("offers permanent Claude token setup and saves it", async () => {
    process.env.AUTOAUTO_CONFIG_HOME = `${fixture.cwd}/.test-auth`
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    setProvider("claude", new EnvClaudeProvider())

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
    await focusContinue(harness)
    await harness.enter()

    const helpFrame = await harness.waitForText("Press t to paste it into AutoAuto", 3000)
    expect(helpFrame).toContain("claude setup-token")

    await harness.press("t")
    await harness.waitForText("Paste CLAUDE_CODE_OAUTH_TOKEN", 3000)
    await harness.type("persisted-token")
    await harness.enter()

    await harness.waitForText("setup", 3000).catch(() => {})
    await harness.flush(300)

    expect(lastNav).toBe("setup")
    expect(savedConfig).not.toBeNull()
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("persisted-token")

    const stored = await Bun.file(getUserAuthConfigPath()).json() as { claudeCodeOAuthToken?: string }
    expect(stored.claudeCodeOAuthToken).toBe("persisted-token")
  })
})
