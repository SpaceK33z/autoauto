import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  applyStoredAuthToEnv,
  getUserAuthConfigPath,
  loadUserAuthConfig,
  saveClaudeCodeOAuthToken,
} from "./user-auth.ts"

let configHome: string
let originalConfigHome: string | undefined
let originalOauthToken: string | undefined
let originalApiKey: string | undefined

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), "autoauto-auth-"))
  originalConfigHome = process.env.AUTOAUTO_CONFIG_HOME
  originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  originalApiKey = process.env.ANTHROPIC_API_KEY
  process.env.AUTOAUTO_CONFIG_HOME = configHome
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.ANTHROPIC_API_KEY
})

afterEach(async () => {
  if (originalConfigHome === undefined) delete process.env.AUTOAUTO_CONFIG_HOME
  else process.env.AUTOAUTO_CONFIG_HOME = originalConfigHome

  if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken

  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey

  await rm(configHome, { recursive: true, force: true })
})

describe("user auth config", () => {
  test("saves and loads a Claude OAuth token", async () => {
    await saveClaudeCodeOAuthToken("  test-oauth-token  ")

    const loaded = await loadUserAuthConfig()
    expect(loaded.claudeCodeOAuthToken).toBe("test-oauth-token")

    const raw = await Bun.file(getUserAuthConfigPath()).json() as { claudeCodeOAuthToken?: string }
    expect(raw.claudeCodeOAuthToken).toBe("test-oauth-token")
  })

  test("applies a stored token to process.env when no env auth exists", async () => {
    await saveClaudeCodeOAuthToken("persisted-token")
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

    await applyStoredAuthToEnv()

    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("persisted-token")
  })

  test("does not override an existing API key", async () => {
    await saveClaudeCodeOAuthToken("persisted-token")
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = "live-api-key"

    await applyStoredAuthToEnv()

    expect(process.env.ANTHROPIC_API_KEY).toBe("live-api-key")
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})
