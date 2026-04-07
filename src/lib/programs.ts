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
  computed?: { avg_duration_ms: number }
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
  if (config.computed !== undefined) {
    if (typeof config.computed !== "object" || config.computed === null || Array.isArray(config.computed)) {
      throw new Error("config.json: computed must be an object")
    }
    const computed = config.computed as Record<string, unknown>
    if (computed.avg_duration_ms !== undefined) {
      assertFiniteNumber(computed.avg_duration_ms, "computed.avg_duration_ms")
      if ((computed.avg_duration_ms as number) <= 0) {
        throw new Error("config.json: computed.avg_duration_ms must be positive")
      }
    }
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
  const raw = await readFile(join(programDir, "config.json"), "utf-8")
  return validateProgramConfig(JSON.parse(raw))
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
