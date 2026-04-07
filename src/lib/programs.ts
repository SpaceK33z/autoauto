import { readdir, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface Program {
  name: string
  configPath: string
}

export interface QualityGate {
  min?: number
  max?: number
}

export interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
  max_experiments?: number
}

export type Screen = "home" | "setup" | "settings" | "program-detail" | "execution"

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

/** Returns the absolute path to a specific program's directory */
export function getProgramDir(cwd: string, slug: string): string {
  return join(cwd, AUTOAUTO_DIR, "programs", slug)
}

/** Returns the absolute path to a specific run's directory */
export function getRunDir(cwd: string, slug: string, runId: string): string {
  return join(cwd, AUTOAUTO_DIR, "programs", slug, "runs", runId)
}

/** Reads and validates config.json from a program directory. */
export async function loadProgramConfig(programDir: string): Promise<ProgramConfig> {
  const raw = await readFile(join(programDir, "config.json"), "utf-8")
  const config = JSON.parse(raw) as Record<string, unknown>

  if (!config.metric_field || typeof config.metric_field !== "string") {
    throw new Error("config.json: metric_field must be a non-empty string")
  }
  if (config.direction !== "lower" && config.direction !== "higher") {
    throw new Error('config.json: direction must be "lower" or "higher"')
  }
  if (typeof config.noise_threshold !== "number" || !isFinite(config.noise_threshold) || config.noise_threshold <= 0) {
    throw new Error("config.json: noise_threshold must be a finite positive number")
  }
  if (typeof config.repeats !== "number" || !Number.isInteger(config.repeats) || config.repeats < 1) {
    throw new Error("config.json: repeats must be an integer >= 1")
  }
  if (typeof config.quality_gates !== "object" || config.quality_gates === null || Array.isArray(config.quality_gates)) {
    throw new Error("config.json: quality_gates must be an object")
  }

  return config as unknown as ProgramConfig
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
