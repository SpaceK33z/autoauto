export { getSetupSystemPrompt, type SetupPromptResult } from "./setup.ts"
export { getUpdateSystemPrompt, type UpdatePromptResult } from "./update.ts"
export { getExperimentSystemPrompt } from "./experiment.ts"
export { getFinalizeSystemPrompt } from "./finalize.ts"

export const DEFAULT_SYSTEM_PROMPT =
  "You are AutoAuto, an autoresearch assistant. Be concise."
