import { getProvider, type AgentModelOption, type AgentProviderID } from "./agent/index.ts"
import {
  DEFAULT_CONFIG,
  getEffortChoicesForSlot,
  isEffortConfigurable,
  type ModelSlot,
} from "./config.ts"

export interface ModelPickerOption extends AgentModelOption {
  value: ModelSlot
}

const DEFAULT_EFFORT = "high"

interface ProviderModelCatalog {
  options: AgentModelOption[]
  defaultModel: string | null
}

export interface ModelCompatibilityResult {
  compatible: boolean
  defaultModel: string | null
  availableModels: string[]
}

function isKnownCodexModelMismatch(model: string): boolean {
  return model === "sonnet" || model === "opus" || model.includes("/")
}

async function loadProviderModelCatalog(
  providerId: AgentProviderID,
  cwd: string,
  forceRefresh = false,
): Promise<ProviderModelCatalog> {
  const provider = getProvider(providerId)
  const [options, providerDefault] = await Promise.all([
    provider.listModels?.(cwd, forceRefresh) ?? Promise.resolve([]),
    provider.getDefaultModel?.(cwd) ?? Promise.resolve(null),
  ])
  return {
    options,
    defaultModel: providerDefault ?? options.find((option) => option.isDefault)?.model ?? options[0]?.model ?? null,
  }
}

function normalizeEffort(slot: ModelSlot): ModelSlot {
  if (!isEffortConfigurable(slot)) return slot
  const validEfforts = getEffortChoicesForSlot(slot)
  if (validEfforts.includes(slot.effort)) return slot
  return { ...slot, effort: DEFAULT_CONFIG.executionModel.effort }
}

function buildCompatibilityError(slot: ModelSlot, result: ModelCompatibilityResult): Error {
  const available = result.availableModels.length > 0 ? result.availableModels.join(", ") : "none"
  const fallback = result.defaultModel ? ` Default: "${result.defaultModel}".` : ""
  const formatHint = slot.provider === "opencode" && !slot.model.includes("/")
    ? ` OpenCode models must be in provider/model format (e.g. "anthropic/claude-sonnet-4-5").`
    : ""
  return new Error(`Model "${slot.model}" is not available for provider "${slot.provider}".${formatHint} Available: ${available}.${fallback}`)
}

export async function loadModelPickerOptions(
  providerId: AgentProviderID,
  cwd: string,
  forceRefresh = false,
): Promise<ModelPickerOption[]> {
  const { options } = await loadProviderModelCatalog(providerId, cwd, forceRefresh)
  return options.map((option) => ({
    provider: option.provider,
    model: option.model,
    label: option.label,
    description: option.description,
    isDefault: option.isDefault,
    value: { provider: option.provider, model: option.model, effort: DEFAULT_EFFORT },
  }))
}

export async function getDefaultModel(providerId: AgentProviderID, cwd: string): Promise<string | null> {
  return (await loadProviderModelCatalog(providerId, cwd)).defaultModel
}

export async function checkModelCompatibility(slot: ModelSlot, cwd: string): Promise<ModelCompatibilityResult> {
  const { options, defaultModel } = await loadProviderModelCatalog(slot.provider, cwd).catch(() => ({
    options: [] as AgentModelOption[],
    defaultModel: null as string | null,
  }))
  const availableModels = options.map((option) => option.model)

  // OpenCode requires provider/model format
  if (slot.provider === "opencode" && !slot.model.includes("/")) {
    return { compatible: false, defaultModel, availableModels }
  }

  const compatible = slot.provider === "codex"
    ? !isKnownCodexModelMismatch(slot.model)
    : availableModels.includes(slot.model)
  return {
    compatible,
    defaultModel,
    availableModels,
  }
}

export async function resolveCompatibleModelSlot(slot: ModelSlot, cwd: string): Promise<ModelSlot> {
  const result = await checkModelCompatibility(slot, cwd)
  if (result.compatible) return normalizeEffort(slot)
  if (!result.defaultModel) throw buildCompatibilityError(slot, result)
  return normalizeEffort({ ...slot, model: result.defaultModel })
}

export async function assertCompatibleModelSlot(slot: ModelSlot, cwd: string): Promise<void> {
  const result = await checkModelCompatibility(slot, cwd)
  if (result.compatible) return
  throw buildCompatibilityError(slot, result)
}
