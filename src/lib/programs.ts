import { readdir, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { $ } from "bun"

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

export type Screen = "home" | "setup" | "settings" | "program-detail" | "pre-run" | "execution"

export const AUTOAUTO_DIR = ".autoauto"

let cachedRoot: string | undefined

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !isFinite(value)) {
    throw new Error(`config.json: ${path} must be a finite number`)
  }
}

export function validateProgramConfig(raw: unknown): ProgramConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config.json: must be a JSON object")
  }

  const config = raw as Record<string, unknown>

  if (!config.metric_field || typeof config.metric_field !== "string") {
    throw new Error("config.json: metric_field must be a non-empty string")
  }
  if (config.direction !== "lower" && config.direction !== "higher") {
    throw new Error('config.json: direction must be "lower" or "higher"')
  }
  assertFiniteNumber(config.noise_threshold, "noise_threshold")
  if (config.noise_threshold <= 0) {
    throw new Error("config.json: noise_threshold must be positive")
  }
  if (typeof config.repeats !== "number" || !Number.isInteger(config.repeats) || config.repeats < 1) {
    throw new Error("config.json: repeats must be an integer >= 1")
  }
  if (
    config.max_experiments !== undefined &&
    (typeof config.max_experiments !== "number" ||
      !Number.isInteger(config.max_experiments) ||
      config.max_experiments < 1)
  ) {
    throw new Error("config.json: max_experiments must be an integer >= 1")
  }
  if (typeof config.quality_gates !== "object" || config.quality_gates === null || Array.isArray(config.quality_gates)) {
    throw new Error("config.json: quality_gates must be an object")
  }

  for (const [field, gate] of Object.entries(config.quality_gates as Record<string, unknown>)) {
    if (typeof gate !== "object" || gate === null || Array.isArray(gate)) {
      throw new Error(`config.json: quality_gates.${field} must be an object`)
    }

    const gateConfig = gate as Record<string, unknown>
    const hasMin = gateConfig.min !== undefined
    const hasMax = gateConfig.max !== undefined

    if (!hasMin && !hasMax) {
      throw new Error(`config.json: quality_gates.${field} must define min or max`)
    }
    if (hasMin) assertFiniteNumber(gateConfig.min, `quality_gates.${field}.min`)
    if (hasMax) assertFiniteNumber(gateConfig.max, `quality_gates.${field}.max`)
    if (typeof gateConfig.min === "number" && typeof gateConfig.max === "number" && gateConfig.min > gateConfig.max) {
      throw new Error(`config.json: quality_gates.${field}.min must be <= max`)
    }
  }

  return config as unknown as ProgramConfig
}

/** Returns the main git repo root, resolving through worktrees. */
export async function getProjectRoot(cwd: string): Promise<string> {
  if (cachedRoot) return cachedRoot
  const result = await $`git rev-parse --show-superproject-working-tree`.cwd(cwd).nothrow().quiet()
  const superproject = result.stdout.toString().trim()
  if (superproject) {
    cachedRoot = superproject
    return superproject
  }
  const toplevel = (await $`git rev-parse --show-toplevel`.cwd(cwd).text()).trim()
  cachedRoot = toplevel
  return toplevel
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

/** Enriched program metadata for the home screen. */
export interface ProgramInfo {
  name: string
  totalRuns: number
  lastRunDate: string | null
  hasActiveRun: boolean
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
  const raw = await Bun.file(join(programDir, "config.json")).json()
  return validateProgramConfig(raw)
}

/** Summary of an existing program for duplicate detection during setup. */
export interface ProgramSummary {
  slug: string
  goal: string
}

/** Loads summaries (slug + goal line from program.md) for all existing programs. */
export async function loadProgramSummaries(cwd: string): Promise<ProgramSummary[]> {
  const root = await getProjectRoot(cwd)
  const programsDir = join(root, AUTOAUTO_DIR, "programs")
  let entries: import("node:fs").Dirent[]
  try {
    entries = (await readdir(programsDir, { withFileTypes: true })).filter((e) => e.isDirectory())
  } catch {
    return []
  }
  const summaries = await Promise.all(
    entries.map(async (e) => {
      try {
        const md = await Bun.file(join(programsDir, e.name, "program.md")).text()
        const goalMatch = md.match(/## Goal\n+([\s\S]*?)(?:\n##|\n*$)/)
        const goal = goalMatch ? goalMatch[1].trim() : "(no goal defined)"
        return { slug: e.name, goal }
      } catch {
        return { slug: e.name, goal: "(could not read program.md)" }
      }
    }),
  )
  return summaries
}

export async function ensureAutoAutoDir(cwd: string): Promise<void> {
  const root = await getProjectRoot(cwd)
  const dir = join(root, AUTOAUTO_DIR)
  await mkdir(dir, { recursive: true })

  const gitignorePath = join(root, ".gitignore")
  const gitignoreFile = Bun.file(gitignorePath)
  if (await gitignoreFile.exists()) {
    const existing = await gitignoreFile.text()
    if (!existing.includes(AUTOAUTO_DIR)) {
      await Bun.write(gitignorePath, existing.trimEnd() + `\n${AUTOAUTO_DIR}/\n`)
    }
  } else {
    await Bun.write(gitignorePath, `${AUTOAUTO_DIR}/\n`)
  }
}
