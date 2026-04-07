import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getProjectRoot, AUTOAUTO_DIR } from "./programs.ts"

export type EffortLevel = "low" | "medium" | "high" | "max"

export interface ModelSlot {
  model: string // 'sonnet' | 'opus' or full model ID
  effort: EffortLevel
}

export interface ProjectConfig {
  executionModel: ModelSlot
  supportModel: ModelSlot
}

const CONFIG_FILE = "config.json"

export const DEFAULT_CONFIG: ProjectConfig = {
  executionModel: { model: "sonnet", effort: "high" },
  supportModel: { model: "sonnet", effort: "high" },
}

/** Model choices the user can cycle through in the settings UI */
export const MODEL_CHOICES = ["sonnet", "opus"] as const

/** Effort levels available for each model */
export const EFFORT_CHOICES: Record<string, EffortLevel[]> = {
  sonnet: ["low", "medium", "high"],
  opus: ["low", "medium", "high", "max"],
}

/** Human-readable labels */
export const MODEL_LABELS: Record<string, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
}

/** Cycle through a readonly array by direction (-1 or +1), wrapping around */
export function cycleChoice<T>(choices: readonly T[], current: T, direction: -1 | 1): T {
  const idx = choices.indexOf(current)
  return choices[(idx + direction + choices.length) % choices.length]
}

export const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Fastest, cheapest — minimal thinking",
  medium: "Balanced speed and quality",
  high: "Deep reasoning (default)",
  max: "Maximum effort (Opus only)",
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const root = await getProjectRoot(cwd)
  const configPath = join(root, AUTOAUTO_DIR, CONFIG_FILE)
  try {
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>
    return {
      executionModel: {
        ...DEFAULT_CONFIG.executionModel,
        ...parsed.executionModel,
      },
      supportModel: { ...DEFAULT_CONFIG.supportModel, ...parsed.supportModel },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function saveProjectConfig(
  cwd: string,
  config: ProjectConfig,
): Promise<void> {
  const root = await getProjectRoot(cwd)
  const dir = join(root, AUTOAUTO_DIR)
  await mkdir(dir, { recursive: true })
  const configPath = join(dir, CONFIG_FILE)
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
}
