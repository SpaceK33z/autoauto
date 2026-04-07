export type {
  AgentEvent,
  AgentCost,
  AgentSessionConfig,
  AgentSession,
  AuthResult,
  AgentProvider,
} from "./types.ts"

import type { AgentProvider } from "./types.ts"

let provider: AgentProvider | null = null

/** Set the active agent provider. Must be called before app render. */
export function setProvider(p: AgentProvider): void {
  provider = p
}

/** Get the active agent provider. Throws if not yet configured. */
export function getProvider(): AgentProvider {
  if (!provider) {
    throw new Error("No agent provider configured — call setProvider() before app render")
  }
  return provider
}
