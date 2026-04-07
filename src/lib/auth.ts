import { getProvider } from "./agent/index.ts"
import type { AuthResult } from "./agent/types.ts"

export type { AuthResult }

/**
 * Check if the user is authenticated with the active agent provider.
 */
export async function checkAuth(): Promise<AuthResult> {
  return getProvider().checkAuth()
}
