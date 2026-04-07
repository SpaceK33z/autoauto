import { getProvider, type AgentProviderID } from "./agent/index.ts"
import type { AuthResult } from "./agent/types.ts"

export type { AuthResult }

/**
 * Check if the user is authenticated with an agent provider.
 */
export async function checkAuth(provider: AgentProviderID = "claude"): Promise<AuthResult> {
  return getProvider(provider).checkAuth()
}
