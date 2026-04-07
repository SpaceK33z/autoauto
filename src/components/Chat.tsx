import { useState, useEffect, useRef, useCallback } from "react"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createPushStream, type PushStream } from "../lib/push-stream.ts"
import { DEFAULT_SYSTEM_PROMPT } from "../lib/system-prompts.ts"
import { formatToolEvent } from "../lib/tool-events.ts"
import type { EffortLevel } from "../lib/config.ts"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

interface SDKUserMessage {
  type: "user"
  message: { role: "user"; content: string }
  parent_tool_use_id: string | null
}

interface ChatProps {
  /** Working directory for agent tools (target repo path) */
  cwd?: string
  /** System prompt for the agent */
  systemPrompt?: string
  /** Tools to make available to the agent */
  tools?: string[]
  /** Tools to auto-allow without permission prompts */
  allowedTools?: string[]
  /** Max conversation turns (user message + assistant response pairs) */
  maxTurns?: number
  /** Model alias ('sonnet', 'opus') or full model ID */
  model?: string
  /** Reasoning effort level */
  effort?: EffortLevel
}

export function Chat({
  cwd,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  tools,
  allowedTools,
  maxTurns,
  model,
  effort,
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputStreamRef = useRef<PushStream<SDKUserMessage> | null>(null)
  const [inputKey, setInputKey] = useState(0)

  // Capture config in refs — the agent session is long-lived and should not
  // restart when parent re-renders. These are stable for the component lifetime.
  const configRef = useRef({ cwd, systemPrompt, tools, allowedTools, maxTurns, model, effort })

  useEffect(() => {
    const abortController = new AbortController()
    const inputStream = createPushStream<SDKUserMessage>()
    inputStreamRef.current = inputStream
    const config = configRef.current

    ;(async () => {
      try {
        const q = query({
          prompt: inputStream,
          options: {
            systemPrompt: config.systemPrompt,
            tools: config.tools ?? [],
            allowedTools: config.allowedTools,
            maxTurns: config.maxTurns,
            cwd: config.cwd,
            model: config.model,
            effort: config.effort,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            includePartialMessages: true,
            abortController,
            persistSession: false,
          },
        })

        for await (const message of q) {
          if (abortController.signal.aborted) break

          if (message.type === "stream_event") {
            const event = message.event
            if (
              event.type === "content_block_delta" &&
              "delta" in event &&
              event.delta.type === "text_delta" &&
              "text" in event.delta
            ) {
              setStreamingText(
                (prev) => prev + (event.delta as { text: string }).text
              )
              setToolStatus(null)
            }

            if (
              event.type === "content_block_start" &&
              "content_block" in event &&
              (event.content_block as any).type === "tool_use"
            ) {
              const block = event.content_block as any
              setToolStatus(
                formatToolEvent(block.name ?? "", block.input ?? {})
              )
            }
          } else if (message.type === "assistant") {
            const fullText = (message as any).message.content
              .filter((block: any) => block.type === "text")
              .map((block: any) => block.text)
              .join("")

            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: fullText,
              },
            ])
            setStreamingText("")
            setIsStreaming(false)
            setToolStatus(null)
          } else if (message.type === "result") {
            if ((message as any).subtype !== "success") {
              setError(
                `Agent error: ${(message as any).errors?.join(", ") ?? "unknown"}`
              )
            }
            setIsStreaming(false)
          }
        }
      } catch (err: unknown) {
        if (!abortController.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err))
          setIsStreaming(false)
        }
      }
    })()

    return () => {
      abortController.abort()
      inputStream.end()
      inputStreamRef.current = null
    }
  }, [])

  const handleSubmit = useCallback(
    (value: string) => {
      const text = value.trim()
      if (!text || isStreaming || !inputStreamRef.current) return

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: text },
      ])

      inputStreamRef.current.push({
        type: "user" as const,
        message: { role: "user" as const, content: text },
        parent_tool_use_id: null,
      })

      setIsStreaming(true)
      setStreamingText("")
      setError(null)
      setInputKey((k) => k + 1)
    },
    [isStreaming]
  )

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox
        focused={isStreaming}
        flexGrow={1}
        border
        borderStyle="rounded"
        stickyScroll
        stickyStart="bottom"
      >
        {messages.length === 0 && !streamingText ? (
          <text fg="#888888">
            Type a message below and press Enter to start a conversation.
          </text>
        ) : (
          <box flexDirection="column">
            {messages.map((msg) => (
              <box key={msg.id} flexDirection="column">
                <text fg={msg.role === "user" ? "#7aa2f7" : "#9ece6a"}>
                  <strong>{msg.role === "user" ? "You" : "AutoAuto"}</strong>
                </text>
                <text>{msg.content}</text>
                <text>{""}</text>
              </box>
            ))}

            {streamingText && (
              <box flexDirection="column">
                <text fg="#9ece6a">
                  <strong>AutoAuto</strong>
                </text>
                <text>{streamingText}</text>
              </box>
            )}

            {isStreaming && !streamingText && (
              <box flexDirection="column">
                <text fg="#9ece6a">
                  <strong>AutoAuto</strong>
                </text>
                <text fg="#888888">Thinking...</text>
              </box>
            )}

            {toolStatus && isStreaming && (
              <text fg="#888888">⟳ {toolStatus}</text>
            )}

            {error && <text fg="#ff5555">Error: {error}</text>}
          </box>
        )}
      </scrollbox>

      <box border borderStyle="rounded" height={3} title="Message">
        <input
          key={inputKey}
          placeholder={
            isStreaming ? "Waiting for response..." : "Ask something..."
          }
          focused={!isStreaming}
          onSubmit={
            ((value: string) => {
              handleSubmit(value)
            }) as any
          }
        />
      </box>
    </box>
  )
}
