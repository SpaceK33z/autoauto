import {
  query,
  type AccountInfo,
  type SDKMessage,
  type SDKUserMessage,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
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
} from "./types.ts"

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

function getToolUse(
  message: SDKPartialAssistantMessage,
): { tool: string; input?: Record<string, unknown> } | null {
  const event = message.event
  if (event.type !== "content_block_start" || event.content_block.type !== "tool_use") {
    return null
  }

  const rawInput = event.content_block.input
  const input =
    typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined

  return { tool: event.content_block.name, input }
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
        persistSession: false,
        includePartialMessages: true,
        abortController: this.abortController,
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
    try {
      for await (const message of this.queryIterable as AsyncIterable<SDKMessage>) {
        if (this.abortController.signal.aborted) break

        if (message.type === "stream_event") {
          const partial = message as unknown as SDKPartialAssistantMessage
          const text = getTextDelta(partial)
          if (text) {
            yield { type: "text_delta", text }
          }

          const toolUse = getToolUse(partial)
          if (toolUse) {
            yield { type: "tool_use", tool: toolUse.tool, input: toolUse.input }
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
        }
        // Skip "user" and "system" message types
      }
    } catch (err: unknown) {
      if (!this.abortController.signal.aborted) {
        yield {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          retriable: false,
        }
      }
    }
  }
}

// --- ClaudeProvider ---

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude"

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
