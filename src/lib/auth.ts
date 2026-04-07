import { query, type AccountInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createPushStream } from "./push-stream.ts"

type AuthResult =
  | {
      authenticated: true
      account: AccountInfo
    }
  | {
      authenticated: false
      error: string
    }

/**
 * Check if the user is authenticated with the Anthropic API.
 * Starts a minimal query session (no message sent), verifies auth via accountInfo(), then closes.
 */
export async function checkAuth(): Promise<AuthResult> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), 10_000)

  try {
    const idleStream = createPushStream<SDKUserMessage>()

    const q = query({
      prompt: idleStream,
      options: {
        tools: [],
        persistSession: false,
        abortController,
      },
    })

    const account = await q.accountInfo()
    q.close()
    idleStream.end()
    clearTimeout(timeout)

    return { authenticated: true, account }
  } catch (err) {
    clearTimeout(timeout)
    abortController.abort()
    return {
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
