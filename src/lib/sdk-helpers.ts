import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { formatToolEvent } from "./tool-events.ts"

/** Common SDK user message shape used by all agent invocations. */
export interface SDKUserMessage {
  type: "user"
  message: { role: "user"; content: string }
  parent_tool_use_id: string | null
}

/** Extracts visible text from a completed assistant message. */
export function getAssistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("")
}

/** Extracts incremental text from a stream event, or null if not a text delta. */
export function getTextDelta(message: SDKPartialAssistantMessage): string | null {
  const event = message.event
  if (event.type !== "content_block_delta" || event.delta.type !== "text_delta") {
    return null
  }
  return event.delta.text
}

/** Extracts a formatted tool status from a stream event, or null if not a tool_use start. */
export function getToolStatus(message: SDKPartialAssistantMessage): string | null {
  const event = message.event
  if (event.type !== "content_block_start" || event.content_block.type !== "tool_use") {
    return null
  }

  const input =
    typeof event.content_block.input === "object" &&
    event.content_block.input !== null &&
    !Array.isArray(event.content_block.input)
      ? event.content_block.input as Record<string, unknown>
      : {}

  return formatToolEvent(event.content_block.name, input)
}

/** Extracts an error string from an SDK result message, or null on success. */
export function formatResultError(message: SDKResultMessage): string | null {
  if (message.subtype === "success") return null
  return `Agent error: ${message.errors.join(", ") || "unknown"}`
}

/** Extracts cost data from an SDK result message. */
export function extractCost(message: SDKResultMessage): import("./experiment.ts").ExperimentCost {
  return {
    total_cost_usd: message.total_cost_usd ?? 0,
    duration_ms: message.duration_ms ?? 0,
    duration_api_ms: message.duration_api_ms ?? 0,
    num_turns: message.num_turns ?? 0,
    input_tokens: message.usage?.input_tokens ?? 0,
    output_tokens: message.usage?.output_tokens ?? 0,
  }
}
