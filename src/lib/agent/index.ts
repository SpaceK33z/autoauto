export type {
  AgentEvent,
  AgentCost,
  AgentSessionConfig,
  AgentSession,
  AuthResult,
  AgentProvider,
  AgentProviderID,
  AgentModelOption,
} from "./types.ts"

import type { AgentProvider, AgentProviderID } from "./types.ts"

const providers = new Map<AgentProviderID, AgentProvider>()

/** Set the active agent provider. Must be called before app render. */
export function setProvider(id: AgentProviderID, p: AgentProvider): void {
  providers.set(id, p)
}

/** Get the active agent provider. Throws if not yet configured. */
export function getProvider(id: AgentProviderID = "claude"): AgentProvider {
  const provider = providers.get(id)
  if (!provider) {
    throw new Error(`No ${id} agent provider configured — call setProvider() before use`)
  }
  return provider
}

export async function closeProviders(): Promise<void> {
  await Promise.all([...providers.values()].map((provider) => provider.close?.()))
}
