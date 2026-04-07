import { readdir, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface Program {
  name: string
  configPath: string
}

export type Screen = "home" | "setup" | "settings"

export const AUTOAUTO_DIR = ".autoauto"

let cachedRoot: string | undefined

/** Returns the main git repo root, resolving through worktrees. */
export async function getProjectRoot(cwd: string): Promise<string> {
  if (cachedRoot) return cachedRoot
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-superproject-working-tree"], { cwd })
    const superproject = stdout.trim()
    if (superproject) {
      cachedRoot = superproject
      return superproject
    }
  } catch {
    // not in a worktree, fall through
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })
  cachedRoot = stdout.trim()
  return cachedRoot
}

export async function listPrograms(cwd: string): Promise<Program[]> {
  const root = await getProjectRoot(cwd)
  const programsDir = join(root, AUTOAUTO_DIR, "programs")
  try {
    const entries = await readdir(programsDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        configPath: join(programsDir, e.name, "config.json"),
      }))
  } catch {
    return []
  }
}

/** Returns the absolute path to the programs directory */
export function getProgramsDir(cwd: string): string {
  return join(cwd, AUTOAUTO_DIR, "programs")
}

export async function ensureAutoAutoDir(cwd: string): Promise<void> {
  const root = await getProjectRoot(cwd)
  const dir = join(root, AUTOAUTO_DIR)
  await mkdir(dir, { recursive: true })

  const gitignorePath = join(root, ".gitignore")
  try {
    const existing = await readFile(gitignorePath, "utf-8")
    if (!existing.includes(AUTOAUTO_DIR)) {
      await writeFile(gitignorePath, existing.trimEnd() + `\n${AUTOAUTO_DIR}/\n`)
    }
  } catch {
    // No .gitignore — create one (getProjectRoot already confirmed this is a git repo)
    await writeFile(gitignorePath, `${AUTOAUTO_DIR}/\n`)
  }
}
