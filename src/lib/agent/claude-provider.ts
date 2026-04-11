import {
  query,
  type AccountInfo,
  type SDKMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKRateLimitInfo,
  type Query,
} from "@anthropic-ai/claude-agent-sdk"
import { createPushStream } from "../push-stream.ts"
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentEvent,
  AgentCost,
  AuthResult,
  AgentModelOption,
  QuotaInfo,
} from "./types.ts"
import { buildAgentErrorEvent } from "./error-classifier.ts"

// --- SDK message helpers (formerly in sdk-helpers.ts) ---

function getAssistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
}

function getTextDelta(message: SDKPartialAssistantMessage): string | null {
  const event = message.event
  if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") {
    return null
  }
  return event.delta.text
}

/** Tracks an in-progress tool_use block while input JSON is being streamed. */
interface PendingToolUse {
  tool: string
  inputJson: string
}

/**
 * Processes stream events for tool_use blocks. Returns the tool call only
 * at content_block_stop, after all input_json_delta chunks have arrived,
 * so formatToolEvent can produce descriptive messages (file paths, commands).
 */
function processToolUseEvent(
  event: unknown,
  pending: PendingToolUse | null,
): { pending: PendingToolUse | null; result: { tool: string; input?: Record<string, unknown> } | null } {
  const ev = event as { type?: string; content_block?: { type?: string; name?: string }; delta?: { type?: string; partial_json?: string } }
  const type = ev.type

  if (type === "content_block_start") {
    const block = ev.content_block
    if (block?.type === "tool_use" && block.name) {
      return { pending: { tool: block.name, inputJson: "" }, result: null }
    }
    return { pending, result: null }
  }

  if (type === "content_block_delta" && pending) {
    const delta = ev.delta
    if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
      return { pending: { ...pending, inputJson: pending.inputJson + delta.partial_json }, result: null }
    }
    return { pending, result: null }
  }

  if (type === "content_block_stop" && pending) {
    let input: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(pending.inputJson)
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        input = parsed as Record<string, unknown>
      }
    } catch {
      // Malformed JSON — emit without input
    }
    return { pending: null, result: { tool: pending.tool, input } }
  }

  return { pending, result: null }
}

function toQuotaInfo(info: SDKRateLimitInfo): QuotaInfo {
  return {
    status: info.status,
    utilization: info.utilization,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
    isUsingOverage: info.isUsingOverage,
    updatedAt: Date.now(),
  }
}

function extractCost(message: SDKResultMessage): AgentCost {
  return {
    total_cost_usd: message.total_cost_usd ?? 0,
    duration_ms: message.duration_ms ?? 0,
    duration_api_ms: message.duration_api_ms ?? 0,
    num_turns: message.num_turns ?? 0,
    input_tokens: message.usage?.input_tokens ?? 0,
    output_tokens: message.usage?.output_tokens ?? 0,
  }
}

// --- ClaudeSession ---

class ClaudeSession implements AgentSession {
  private inputStream = createPushStream<SDKUserMessage>()
  private abortController = new AbortController()
  private queryIterable: Query
  private externalSignal?: AbortSignal
  private signalHandler?: () => void
  sessionId: string | undefined

  constructor(config: AgentSessionConfig) {
    // Link external signal to our abort controller
    if (config.signal) {
      if (config.signal.aborted) {
        this.abortController.abort()
      } else {
        this.externalSignal = config.signal
        this.signalHandler = () => this.abortController.abort()
        config.signal.addEventListener("abort", this.signalHandler, { once: true })
      }
    }

    this.queryIterable = query({
      prompt: this.inputStream,
      options: {
        systemPrompt: config.systemPrompt,
        tools: config.tools ?? [],
        allowedTools: config.allowedTools,
        maxTurns: config.maxTurns,
        cwd: config.cwd,
        model: config.model,
        effort: config.effort as "low" | "medium" | "high" | "max" | undefined,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        includePartialMessages: true,
        abortController: this.abortController,
        ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
      },
    })
  }

  pushMessage(content: string): void {
    this.inputStream.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    })
  }

  endInput(): void {
    this.inputStream.end()
  }

  close(): void {
    if (this.externalSignal && this.signalHandler) {
      this.externalSignal.removeEventListener("abort", this.signalHandler)
    }
    this.abortController.abort()
    this.inputStream.end()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    let pendingTool: PendingToolUse | null = null

    try {
      for await (const message of this.queryIterable as AsyncIterable<SDKMessage>) {
        if (this.abortController.signal.aborted) break

        // Capture session ID from first message that carries one
        if (!this.sessionId) {
          const sid = (message as { session_id?: string }).session_id
          if (sid) this.sessionId = sid
        }

        if (message.type === "stream_event") {
          const partial = message as unknown as SDKPartialAssistantMessage
          const text = getTextDelta(partial)
          if (text) {
            yield { type: "text_delta", text }
          }

          // Accumulate tool input across stream events, emit at content_block_stop
          const { pending, result } = processToolUseEvent(partial.event, pendingTool)
          pendingTool = pending
          if (result) {
            yield { type: "tool_use", tool: result.tool, input: result.input }
          }
        } else if (message.type === "assistant") {
          const text = getAssistantText(message as unknown as SDKAssistantMessage)
          yield { type: "assistant_complete", text }
        } else if (message.type === "result") {
          const resultMsg = message as unknown as SDKResultMessage
          const cost = extractCost(resultMsg)
          const success = resultMsg.subtype === "success"
          const error = success
            ? undefined
            : resultMsg.errors.join(", ") || resultMsg.subtype
          yield { type: "result", success, error, cost }
        } else if (message.type === "rate_limit_event") {
          const rlEvent = message as unknown as { rate_limit_info: SDKRateLimitInfo }
          yield { type: "quota_update", quota: toQuotaInfo(rlEvent.rate_limit_info) }
        }
        // Skip "user" and "system" message types
      }
    } catch (err: unknown) {
      if (!this.abortController.signal.aborted) {
        yield buildAgentErrorEvent(err instanceof Error ? err.message : String(err))
      }
    }
  }
}

// --- ClaudeProvider ---

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude"

  async listModels(): Promise<AgentModelOption[]> {
    return [
      {
        provider: "claude",
        model: "sonnet",
        label: "Claude / Sonnet",
        description: "Claude Sonnet via Claude Agent SDK",
        isDefault: true,
      },
      {
        provider: "claude",
        model: "opus",
        label: "Claude / Opus",
        description: "Claude Opus via Claude Agent SDK",
      },
    ]
  }

  async getDefaultModel(): Promise<string> {
    return "sonnet"
  }

  createSession(config: AgentSessionConfig): AgentSession {
    return new ClaudeSession(config)
  }

  runOnce(prompt: string, config: AgentSessionConfig): AgentSession {
    const session = this.createSession(config)
    session.pushMessage(prompt)
    session.endInput()
    return session
  }

  async checkAuth(): Promise<AuthResult> {
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

      const account: AccountInfo = await q.accountInfo()
      q.close()
      idleStream.end()
      clearTimeout(timeout)

      return {
        authenticated: true,
        account: { ...account } as Record<string, unknown> & { email?: string },
      }
    } catch (err) {
      clearTimeout(timeout)
      abortController.abort()
      return {
        authenticated: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
