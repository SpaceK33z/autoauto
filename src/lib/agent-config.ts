/**
 * Shared sandbox container configuration — env vars, auth checks, and
 * agent config discovery for Claude Code, Codex, and OpenCode.
 *
 * Claude subscription auth uses CLAUDE_CODE_OAUTH_TOKEN env var
 * (credentials live in macOS Keychain, not on disk), but we still forward
 * ~/.claude for CLI settings and project state.
 */

import { join, relative } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { lstat, readdir } from "node:fs/promises"

/** Where agent config lives inside the container (runs as root). */
const CONTAINER_HOME = "/root"

/** Max file size to upload (skip large caches/sessions). */
const MAX_FILE_SIZE = 1_000_000 // 1 MB

/**
 * Resolve agent config directories as absolute host paths + container names.
 * Respects CODEX_HOME for custom Codex locations.
 */
function getAgentConfigSourceDirs(): Array<{ hostPath: string; containerName: string }> {
  const home = homedir()
  return [
    { hostPath: join(home, ".claude"), containerName: ".claude" },
    { hostPath: process.env.CODEX_HOME ?? join(home, ".codex"), containerName: ".codex" },
    { hostPath: join(home, ".config/opencode"), containerName: ".config/opencode" },
  ]
}

// ---------------------------------------------------------------------------
// Env vars forwarded into sandbox containers
// ---------------------------------------------------------------------------

/** Env var keys forwarded into sandbox containers. */
const CONTAINER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const

export type AgentAuthMethod = "api_key" | "oauth_token"

/**
 * Check whether agent auth credentials are available for sandbox runs.
 */
export function checkAgentAuth(): { ok: true; authMethod: AgentAuthMethod } | { ok: false; error: string } {
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, authMethod: "api_key" }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { ok: true, authMethod: "oauth_token" }

  return {
    ok: false,
    error: "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN required — the experiment agent runs inside the container. Run `claude setup-token` to generate a subscription token.",
  }
}

/**
 * Collect env vars that should be forwarded into sandbox containers.
 * Only includes keys that are actually set.
 */
export function collectContainerEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of CONTAINER_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return env
}

// ---------------------------------------------------------------------------
// Config directory discovery
// ---------------------------------------------------------------------------

export interface ConfigFileEntry {
  /** Absolute path on the host */
  localPath: string
  /** Absolute path inside the container */
  remotePath: string
}

export interface ConfigDirMount {
  /** Absolute path on the host */
  hostPath: string
  /** Absolute path inside the container */
  containerPath: string
}

/**
 * Recursively list all regular files in a directory.
 * Returns empty array if the directory doesn't exist or isn't readable.
 */
async function listFilesRecursive(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) return listFilesRecursive(fullPath)
      if (entry.isFile()) return [fullPath]
      return []
    }),
  )
  return nested.flat()
}

/**
 * Returns agent config directories that exist on the host.
 * Used by the Docker provider for read-only bind mounts.
 */
export function getAgentConfigDirs(): ConfigDirMount[] {
  return getAgentConfigSourceDirs()
    .filter(({ hostPath }) => existsSync(hostPath))
    .map(({ hostPath, containerName }) => ({
      hostPath,
      containerPath: `${CONTAINER_HOME}/${containerName}`,
    }))
}

async function getRegularFileSize(localPath: string): Promise<number | null> {
  try {
    const stats = await lstat(localPath)
    if (!stats.isFile()) return null
    return stats.size
  } catch {
    return null
  }
}

/**
 * Discover agent config files for upload to sandbox containers.
 * Skips files larger than 1 MB to avoid uploading caches.
 */
export async function getAgentConfigFiles(): Promise<ConfigFileEntry[]> {
  const dirs = getAgentConfigSourceDirs()

  const nested = await Promise.all(
    dirs.map(async ({ hostPath, containerName }) => {
      const files = await listFilesRecursive(hostPath)
      const entries = await Promise.all(
        files.map(async (localPath) => {
          const size = await getRegularFileSize(localPath)
          if (size === null || size > MAX_FILE_SIZE) return null
          return {
            localPath,
            remotePath: `${CONTAINER_HOME}/${containerName}/${relative(hostPath, localPath)}`,
          }
        }),
      )

      return entries.filter((entry): entry is ConfigFileEntry => entry !== null)
    }),
  )

  return nested.flat()
}
