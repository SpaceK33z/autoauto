import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getProjectRoot, AUTOAUTO_DIR } from "./programs.ts"
import type { AgentProviderID } from "./agent/index.ts"

export type EffortLevel = "low" | "medium" | "high" | "max"

export interface ModelSlot {
  provider: AgentProviderID
  model: string // 'sonnet' | 'opus' or full model ID
  effort: EffortLevel
}

export type NotificationPreset = "off" | "macos-notification" | "macos-say" | "terminal-bell" | "custom"

export interface NotificationPresetDef {
  id: NotificationPreset
  label: string
  command: string | null
}

export const NOTIFICATION_PRESETS: NotificationPresetDef[] = [
  { id: "off", label: "Off", command: null },
  {
    id: "macos-notification",
    label: "macOS Notification",
    command: `osascript -e 'display notification "{{program}}: {{status}} after {{experiments}} experiments ({{keeps}} kept, {{improvement_pct}} improvement)" with title "AutoAuto"'`,
  },
  {
    id: "macos-say",
    label: "macOS Say (TTS)",
    command: `say "AutoAuto: {{program}} {{status}}, {{keeps}} of {{experiments}} kept"`,
  },
  {
    id: "terminal-bell",
    label: "Terminal Bell",
    command: `printf '\\a'`,
  },
  { id: "custom", label: "Custom", command: null },
]

export const NOTIFICATION_PRESET_IDS = NOTIFICATION_PRESETS.map((p) => p.id)

export interface ProjectConfig {
  executionModel: ModelSlot
  supportModel: ModelSlot
  ideasBacklogEnabled: boolean
  notificationPreset: NotificationPreset
  notificationCommand: string | null // only used when preset is "custom"
}

const CONFIG_FILE = "config.json"

/** Resolve the effective notification command for a config. */
export function getNotificationCommand(config: ProjectConfig): string | null {
  if (config.notificationPreset === "custom") return config.notificationCommand
  const preset = NOTIFICATION_PRESETS.find((p) => p.id === config.notificationPreset)
  return preset?.command ?? null
}

export const DEFAULT_CONFIG: ProjectConfig = {
  executionModel: { provider: "claude", model: "sonnet", effort: "high" },
  supportModel: { provider: "claude", model: "sonnet", effort: "high" },
  ideasBacklogEnabled: true,
  notificationPreset: "off",
  notificationCommand: null,
}

/** Effort levels available for each model */
export const EFFORT_CHOICES: Record<string, EffortLevel[]> = {
  sonnet: ["low", "medium", "high"],
  opus: ["low", "medium", "high", "max"],
}

export const PROVIDER_CHOICES: AgentProviderID[] = ["claude", "codex", "opencode"]

export const PROVIDER_LABELS: Record<AgentProviderID, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
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

function normalizeModelSlot(slot: Partial<ModelSlot> | undefined): ModelSlot {
  return {
    ...DEFAULT_CONFIG.executionModel,
    ...slot,
  }
}

export function isEffortConfigurable(slot: ModelSlot): boolean {
  return slot.provider === "claude" || slot.provider === "codex"
}

export function getEffortChoicesForSlot(slot: ModelSlot): readonly EffortLevel[] {
  if (!isEffortConfigurable(slot)) return []
  return EFFORT_CHOICES[slot.model] ?? EFFORT_CHOICES.sonnet
}

export function formatModelSlot(slot: ModelSlot, compact = false): string {
  if (slot.provider === "opencode") {
    const modelID = slot.model.includes("/") ? slot.model.slice(slot.model.indexOf("/") + 1) : slot.model
    return compact ? `oc/${modelID}` : `OpenCode / ${slot.model}`
  }
  if (slot.provider === "codex") {
    return compact ? `codex/${slot.model}` : `Codex / ${slot.model}`
  }
  const label = MODEL_LABELS[slot.model] ?? slot.model
  return compact ? `claude/${slot.model}` : `Claude / ${label}`
}

export function formatModelLabel(slot: ModelSlot): string {
  const model = formatModelSlot(slot, true)
  return isEffortConfigurable(slot) ? `${model}/${slot.effort}` : model
}

export function formatEffortSlot(slot: ModelSlot): { label: string; description: string } {
  if (!isEffortConfigurable(slot)) {
    return {
      label: "OpenCode default",
      description: "OpenCode variant config applies",
    }
  }
  return {
    label: EFFORT_LABELS[slot.effort],
    description: EFFORT_DESCRIPTIONS[slot.effort],
  }
}

export function mergeSelectedModelSlot(previous: ModelSlot, selected: ModelSlot): ModelSlot {
  const effort = isEffortConfigurable(selected) && getEffortChoicesForSlot(selected).includes(previous.effort)
    ? previous.effort
    : selected.effort
  return { ...selected, effort }
}

export async function configExists(cwd: string): Promise<boolean> {
  const root = await getProjectRoot(cwd)
  return Bun.file(join(root, AUTOAUTO_DIR, CONFIG_FILE)).exists()
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const root = await getProjectRoot(cwd)
  const configPath = join(root, AUTOAUTO_DIR, CONFIG_FILE)
  try {
    const parsed = await Bun.file(configPath).json() as Record<string, unknown>
    const { executionModel, supportModel, ...rest } = parsed as Partial<ProjectConfig>
    return {
      ...DEFAULT_CONFIG,
      ...rest,
      executionModel: normalizeModelSlot(executionModel),
      supportModel: normalizeModelSlot(supportModel),
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
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n")
}
