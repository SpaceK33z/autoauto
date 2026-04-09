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

export interface SecondaryMetric {
  direction: "lower" | "higher"
}

export interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
  secondary_metrics?: Record<string, SecondaryMetric>
  max_experiments: number
  max_consecutive_discards?: number
  max_turns?: number
  measurement_timeout?: number
  build_timeout?: number
  max_cost_usd?: number
  keep_simplifications?: boolean
}

export type Screen = "home" | "setup" | "settings" | "program-detail" | "pre-run" | "execution" | "first-setup"

export const AUTOAUTO_DIR = ".autoauto"

let cachedRoot: string | undefined

/** Reset the cached project root (for tests). */
export function resetProjectRoot(): void {
  cachedRoot = undefined
}

function assertFiniteNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !isFinite(value)) {
    throw new Error(`config.json: ${path} must be a finite number`)
  }
}

function assertOptionalIntMin(config: Record<string, unknown>, field: string, min: number): void {
  if (
    config[field] !== undefined &&
    (typeof config[field] !== "number" ||
      !Number.isInteger(config[field]) ||
      (config[field] as number) < min)
  ) {
    throw new Error(`config.json: ${field} must be an integer >= ${min}`)
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
    typeof config.max_experiments !== "number" ||
    !Number.isInteger(config.max_experiments) ||
    config.max_experiments < 1
  ) {
    throw new Error("config.json: max_experiments must be an integer >= 1")
  }
  assertOptionalIntMin(config, "max_consecutive_discards", 1)
  assertOptionalIntMin(config, "max_turns", 1)
  assertOptionalIntMin(config, "measurement_timeout", 1000)
  assertOptionalIntMin(config, "build_timeout", 1000)
  if (config.max_cost_usd !== undefined) {
    assertFiniteNumber(config.max_cost_usd, "max_cost_usd")
    if (config.max_cost_usd <= 0) {
      throw new Error("config.json: max_cost_usd must be a positive number")
    }
  }
  if (config.keep_simplifications !== undefined && typeof config.keep_simplifications !== "boolean") {
    throw new Error("config.json: keep_simplifications must be a boolean")
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

  if (config.secondary_metrics !== undefined) {
    if (typeof config.secondary_metrics !== "object" || config.secondary_metrics === null || Array.isArray(config.secondary_metrics)) {
      throw new Error("config.json: secondary_metrics must be an object")
    }

    for (const [field, metric] of Object.entries(config.secondary_metrics as Record<string, unknown>)) {
      if (typeof metric !== "object" || metric === null || Array.isArray(metric)) {
        throw new Error(`config.json: secondary_metrics.${field} must be an object`)
      }
      const metricConfig = metric as Record<string, unknown>
      if (metricConfig.direction !== "lower" && metricConfig.direction !== "higher") {
        throw new Error(`config.json: secondary_metrics.${field}.direction must be "lower" or "higher"`)
      }

      // Prevent overlap with primary metric and quality gates
      if (field === config.metric_field) {
        throw new Error(`config.json: secondary_metrics.${field} overlaps with metric_field`)
      }
      if (field in (config.quality_gates as Record<string, unknown>)) {
        throw new Error(`config.json: secondary_metrics.${field} overlaps with quality_gates`)
      }
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
  let gitignoreChanged = false
  if (await gitignoreFile.exists()) {
    const existing = await gitignoreFile.text()
    if (!existing.includes(AUTOAUTO_DIR)) {
      await Bun.write(gitignorePath, existing.trimEnd() + `\n${AUTOAUTO_DIR}/\n`)
      gitignoreChanged = true
    }
  } else {
    await Bun.write(gitignorePath, `${AUTOAUTO_DIR}/\n`)
    gitignoreChanged = true
  }
  if (gitignoreChanged) {
    await $`git add .gitignore`.cwd(root).quiet()
  }
}
