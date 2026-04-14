/**
 * Shared sandbox container configuration — env vars, auth checks, and
 * agent config directory discovery (Codex, OpenCode).
 *
 * Claude subscription auth uses CLAUDE_CODE_OAUTH_TOKEN env var
 * (credentials live in macOS Keychain, not on disk).
 */

import { join, relative } from "node:path"
import { homedir } from "node:os"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"

/** Where agent config lives inside the container (runs as root). */
const CONTAINER_HOME = "/root"

/** Max file size to upload (skip large caches). */
const MAX_FILE_SIZE = 1_000_000 // 1 MB

/**
 * Resolve agent config directories as absolute host paths + container names.
 * Respects CODEX_HOME for custom Codex locations.
 */
function getAgentConfigSourceDirs(): Array<{ hostPath: string; containerName: string }> {
  const home = homedir()
  return [
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
  localPath: string
  remotePath: string
}

export interface ConfigDirMount {
  hostPath: string
  containerPath: string
}

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

/**
 * Discover agent config files for upload to sandbox containers.
 * Skips files larger than 1 MB to avoid uploading caches.
 */
export async function getAgentConfigFiles(): Promise<ConfigFileEntry[]> {
  const dirs = getAgentConfigSourceDirs()

  const nested = await Promise.all(
    dirs.map(async ({ hostPath, containerName }) => {
      const files = await listFilesRecursive(hostPath)

      return files
        .filter((localPath) => Bun.file(localPath).size <= MAX_FILE_SIZE)
        .map((localPath) => ({
          localPath,
          remotePath: `${CONTAINER_HOME}/${containerName}/${relative(hostPath, localPath)}`,
        }))
    }),
  )

  return nested.flat()
}
