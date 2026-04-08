/** Normalized event types emitted by all agent providers. */
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; tool: string; input?: Record<string, unknown> }
  | { type: "assistant_complete"; text: string }
  | { type: "error"; error: string; retriable: boolean }
  | { type: "result"; success: boolean; error?: string; cost?: AgentCost }

/** Cost and usage data from a completed agent session. */
export interface AgentCost {
  total_cost_usd: number
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  input_tokens: number
  output_tokens: number
}

export type AgentProviderID = "claude" | "opencode" | "codex"

export interface AgentModelOption {
  provider: AgentProviderID
  model: string
  label: string
  description?: string
  isDefault?: boolean
}

/** Configuration for creating an agent session. */
export interface AgentSessionConfig {
  systemPrompt?: string
  tools?: string[]
  allowedTools?: string[]
  maxTurns?: number
  cwd?: string
  model?: string
  effort?: string
  signal?: AbortSignal
  /** Escape hatch for provider-specific options (e.g. temperature, reasoning_effort). */
  providerOptions?: Record<string, unknown>
  /** Resume a previously persisted session by ID (provider-specific). */
  resumeSessionId?: string
}

/** A running agent session that yields events and accepts user messages. */
export interface AgentSession extends AsyncIterable<AgentEvent> {
  /** Provider-assigned session ID, available when persistence is supported. */
  readonly sessionId?: string
  /** Push a user message into the conversation. */
  pushMessage(content: string): void
  /** Signal that no more input will be sent (one-shot mode). */
  endInput(): void
  /** Close the session and release resources. Idempotent. */
  close(): void
}

/** Result of an authentication check. */
export type AuthResult =
  | { authenticated: true; account: Record<string, unknown> & { email?: string } }
  | { authenticated: false; error: string }

/** Interface that all agent SDK providers must implement. */
export interface AgentProvider {
  readonly name: AgentProviderID | string
  /** Create an interactive multi-turn session. */
  createSession(config: AgentSessionConfig): AgentSession
  /** Convenience: create a one-shot session with a single prompt. */
  runOnce(prompt: string, config: AgentSessionConfig): AgentSession
  /** Verify authentication with the provider. */
  checkAuth(): Promise<AuthResult>
  /** List models available through this provider. */
  listModels?(cwd?: string, forceRefresh?: boolean): Promise<AgentModelOption[]>
  /** Return the provider's configured default model, if available. */
  getDefaultModel?(cwd?: string): Promise<string | null>
  /** Release provider-owned resources. */
  close?(): void | Promise<void>
}
