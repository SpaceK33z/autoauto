/**
 * Agent configuration discovery — finds config files for Claude Code, Codex,
 * and OpenCode on the host machine so they can be forwarded into sandbox containers.
 *
 * When experiments run inside Docker/Modal containers, the agent CLI (claude,
 * codex, opencode) needs its local config for authentication and settings.
 * This module discovers those config directories and returns them as
 * (localPath, remotePath) pairs for the container providers to mount or upload.
 */

import { homedir } from "node:os"
import { join, relative } from "node:path"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"

/** Where agent config lives inside the container (runs as root). */
const CONTAINER_HOME = "/root"

/** Max file size to upload (skip large caches/sessions). */
const MAX_FILE_SIZE = 1_000_000 // 1 MB

/** Known agent config directories relative to $HOME. */
const AGENT_CONFIG_DIRS = [
  ".claude",
  ".codex",
  ".config/opencode",
]

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
 * Used by the Docker provider for bind mounts.
 */
export function getAgentConfigDirs(): ConfigDirMount[] {
  const home = homedir()
  const mounts: ConfigDirMount[] = []

  for (const dir of AGENT_CONFIG_DIRS) {
    const hostPath = join(home, dir)
    if (existsSync(hostPath)) {
      mounts.push({
        hostPath,
        containerPath: `${CONTAINER_HOME}/${dir}`,
      })
    }
  }

  return mounts
}

/**
 * Discover agent config files for upload to sandbox containers.
 * Scans ~/.claude, ~/.codex, and ~/.config/opencode.
 * Skips files larger than 1 MB to avoid uploading caches.
 */
export async function getAgentConfigFiles(): Promise<ConfigFileEntry[]> {
  const home = homedir()

  const nested = await Promise.all(
    AGENT_CONFIG_DIRS.map(async (configDir) => {
      const hostDir = join(home, configDir)
      const files = await listFilesRecursive(hostDir)

      return files
        .filter((localPath) => Bun.file(localPath).size <= MAX_FILE_SIZE)
        .map((localPath) => ({
          localPath,
          remotePath: `${CONTAINER_HOME}/${configDir}/${relative(hostDir, localPath)}`,
        }))
    }),
  )

  return nested.flat()
}
