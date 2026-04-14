import { mkdir, rename, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface UserAuthConfig {
  claudeCodeOAuthToken?: string | null
}

function getUserConfigDir(): string {
  if (process.env.AUTOAUTO_CONFIG_HOME) return process.env.AUTOAUTO_CONFIG_HOME
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "autoauto")
  return join(homedir(), ".config", "autoauto")
}

export function getUserAuthConfigPath(): string {
  return join(getUserConfigDir(), "auth.json")
}

export function formatUserAuthConfigPath(): string {
  const path = getUserAuthConfigPath()
  const home = homedir()
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

export function hasClaudeEnvAuth(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)
}

export async function loadUserAuthConfig(): Promise<UserAuthConfig> {
  try {
    const parsed = await Bun.file(getUserAuthConfigPath()).json() as Record<string, unknown>
    return {
      claudeCodeOAuthToken: typeof parsed.claudeCodeOAuthToken === "string"
        ? parsed.claudeCodeOAuthToken
        : null,
    }
  } catch {
    return {}
  }
}

export async function saveClaudeCodeOAuthToken(token: string): Promise<void> {
  const normalized = token.trim()
  if (!normalized) throw new Error("Claude token cannot be empty")

  const dir = getUserConfigDir()
  const path = getUserAuthConfigPath()
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`

  await mkdir(dir, { recursive: true })
  await Bun.write(tmpPath, JSON.stringify({ claudeCodeOAuthToken: normalized }, null, 2) + "\n")
  await rename(tmpPath, path)
  await chmod(path, 0o600).catch(() => {})

  process.env.CLAUDE_CODE_OAUTH_TOKEN = normalized
}

export async function applyStoredAuthToEnv(): Promise<void> {
  if (hasClaudeEnvAuth()) return

  const config = await loadUserAuthConfig()
  const token = config.claudeCodeOAuthToken?.trim()
  if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token
}
