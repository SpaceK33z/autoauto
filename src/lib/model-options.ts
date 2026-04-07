import { getProvider, type AgentModelOption, type AgentProviderID } from "./agent/index.ts"
import type { ModelSlot } from "./config.ts"

export interface ModelPickerOption extends AgentModelOption {
  value: ModelSlot
}

const DEFAULT_EFFORT = "high"

export async function loadModelPickerOptions(
  providerId: AgentProviderID,
  cwd: string,
  forceRefresh = false,
): Promise<ModelPickerOption[]> {
  const options = await getProvider(providerId).listModels?.(cwd, forceRefresh) ?? []
  return options.map((option) => ({
    ...option,
    value: { provider: option.provider, model: option.model, effort: DEFAULT_EFFORT },
  }))
}

export async function getDefaultModel(providerId: AgentProviderID, cwd: string): Promise<string | null> {
  return await getProvider(providerId).getDefaultModel?.(cwd) ?? null
}
