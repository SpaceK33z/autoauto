import { homedir } from "node:os"
import { join } from "node:path"
import type { Usage } from "@openai/codex-sdk"
import type { AgentSessionConfig } from "./types.ts"

const CODEX_DEFAULT_MODEL = "default"
const OPENAI_DEFAULT_PROVIDER = "openai"
const TOKENS_PER_MILLION = 1_000_000

interface ModelPricing {
  inputUsdPerMillion: number
  cachedInputUsdPerMillion: number
  outputUsdPerMillion: number
}

interface CodexAuthFile {
  auth_mode?: string
}

interface CodexCostConfig {
  profile?: string
  model?: string
  model_provider?: string
  profiles?: Record<string, Record<string, unknown>>
}

export interface CodexCostContext {
  authMode: "api" | "chatgpt" | "unknown"
  model: string | null
  modelProvider: string | null
  pricing: ModelPricing | null
}

const STANDARD_OPENAI_MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.4": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.4-mini": { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
  "gpt-5.4-nano": { inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 },
  "gpt-5.4-pro": { inputUsdPerMillion: 30, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 180 },
  "gpt-5.2": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
  "gpt-5.2-pro": { inputUsdPerMillion: 21, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 168 },
  // Inference from official Codex credits table: GPT-5.3-Codex token-credit ratios match GPT-5.2 exactly.
  "gpt-5.3-codex": { inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
}

const MODEL_ALIASES: Record<string, string> = {
  "gpt-5.2-codex": "gpt-5.2",
}

function normalizeConfiguredModel(model: string | undefined): string | undefined {
  if (!model || model === CODEX_DEFAULT_MODEL) return undefined
  return model
}

function getCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(process.env.HOME ?? homedir(), ".codex")
}

function canonicalizeModel(model: string | undefined): string | null {
  if (!model) return null
  const normalized = model.trim().toLowerCase()
  return MODEL_ALIASES[normalized] ?? normalized
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const file = Bun.file(path)
  if (!await file.exists()) return null

  try {
    return await file.json() as T
  } catch {
    return null
  }
}

async function readTomlFile(path: string): Promise<CodexCostConfig | null> {
  const file = Bun.file(path)
  if (!await file.exists()) return null

  try {
    return Bun.TOML.parse(await file.text()) as CodexCostConfig
  } catch {
    return null
  }
}

function applyTopLevelSettings(
  current: { model?: string; modelProvider?: string },
  config: CodexCostConfig | null,
): void {
  if (!config) return
  current.model = getString(config.model) ?? current.model
  current.modelProvider = getString(config.model_provider) ?? current.modelProvider
}

function applyProfileSettings(
  current: { model?: string; modelProvider?: string },
  config: CodexCostConfig | null,
  profile: string | undefined,
): void {
  if (!config || !profile) return

  const profiles = getObject(config.profiles)
  const profileConfig = profiles ? getObject(profiles[profile]) : undefined
  if (!profileConfig) return

  current.model = getString(profileConfig.model) ?? current.model
  current.modelProvider = getString(profileConfig.model_provider) ?? current.modelProvider
}

async function resolveConfiguredCodexSettings(config: AgentSessionConfig): Promise<{
  model: string | null
  modelProvider: string | null
}> {
  const explicitModel = normalizeConfiguredModel(config.model)
  const codexHome = getCodexHomeDir()
  const projectConfigPath = config.cwd ? join(config.cwd, ".codex", "config.toml") : null
  const [homeConfig, projectConfig] = await Promise.all([
    readTomlFile(join(codexHome, "config.toml")),
    projectConfigPath ? readTomlFile(projectConfigPath) : Promise.resolve(null),
  ])

  const activeProfile = getString(projectConfig?.profile) ?? getString(homeConfig?.profile)
  const resolved: { model?: string; modelProvider?: string } = {}

  applyTopLevelSettings(resolved, homeConfig)
  applyProfileSettings(resolved, homeConfig, activeProfile)
  applyTopLevelSettings(resolved, projectConfig)
  applyProfileSettings(resolved, projectConfig, activeProfile)

  return {
    model: canonicalizeModel(explicitModel ?? resolved.model),
    modelProvider: getString(resolved.modelProvider) ?? OPENAI_DEFAULT_PROVIDER,
  }
}

export function estimateCodexUsageCostUsd(usage: Usage, pricing: ModelPricing): number {
  const cachedInputTokens = Math.max(0, Math.min(usage.cached_input_tokens, usage.input_tokens))
  const uncachedInputTokens = Math.max(0, usage.input_tokens - cachedInputTokens)

  return (
    (uncachedInputTokens * pricing.inputUsdPerMillion)
    + (cachedInputTokens * pricing.cachedInputUsdPerMillion)
    + (usage.output_tokens * pricing.outputUsdPerMillion)
  ) / TOKENS_PER_MILLION
}

export async function resolveCodexCostContext(config: AgentSessionConfig): Promise<CodexCostContext> {
  const auth = await readJsonFile<CodexAuthFile>(join(getCodexHomeDir(), "auth.json"))
  const authMode = auth?.auth_mode === "api"
    ? "api"
    : auth?.auth_mode === "chatgpt"
      ? "chatgpt"
      : "unknown"

  const { model, modelProvider } = await resolveConfiguredCodexSettings(config)
  // ChatGPT-backed Codex usage is now progressively migrating to token-based pricing
  // derived from the same model token rates as the API, so use the same estimate when
  // the OpenAI model is known instead of collapsing to a guaranteed zero.
  const pricing = (authMode === "api" || authMode === "chatgpt")
    && modelProvider === OPENAI_DEFAULT_PROVIDER
    && model
    ? STANDARD_OPENAI_MODEL_PRICING[model] ?? null
    : null

  return {
    authMode,
    model,
    modelProvider,
    pricing,
  }
}
