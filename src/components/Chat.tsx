import { useState, useEffect, useRef, useCallback } from "react"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { TextareaOptions } from "@opentui/core"
import { createPushStream, type PushStream } from "../lib/push-stream.ts"
import { DEFAULT_SYSTEM_PROMPT } from "../lib/system-prompts.ts"
import type { EffortLevel } from "../lib/config.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import {
  type SDKUserMessage,
  getAssistantText,
  getTextDelta,
  getToolStatus,
  formatResultError,
} from "../lib/sdk-helpers.ts"

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

type OpenTUISubmitEvent = Parameters<NonNullable<TextareaOptions["onSubmit"]>>[0]

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
  /** Auto-submit this message on mount as the first user message */
  initialMessage?: string
  /** Hint shown in the empty chat area before any messages */
  emptyStateHint?: string
  /** Placeholder text for the input field */
  inputPlaceholder?: string
}

export function Chat({
  cwd,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  tools,
  allowedTools,
  maxTurns,
  model,
  effort,
  initialMessage,
  emptyStateHint,
  inputPlaceholder,
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
  const configRef = useRef({ cwd, systemPrompt, tools, allowedTools, maxTurns, model, effort, initialMessage })
  const defaultPlaceholder = inputPlaceholder ?? "Ask something..."

  useEffect(() => {
    const abortController = new AbortController()
    const inputStream = createPushStream<SDKUserMessage>()
    inputStreamRef.current = inputStream
    const config = configRef.current

    // Auto-submit initial message if provided
    if (config.initialMessage) {
      const text = config.initialMessage.trim()
      if (text) {
        setMessages([{ id: crypto.randomUUID(), role: "user", content: text }])
        inputStream.push({
          type: "user" as const,
          message: { role: "user" as const, content: text },
          parent_tool_use_id: null,
        })
        setIsStreaming(true)
        setInputKey((k) => k + 1)
      }
    }

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
            const textDelta = getTextDelta(message)
            if (textDelta) {
              setStreamingText((prev) => prev + textDelta)
              setToolStatus(null)
            }

            const nextToolStatus = getToolStatus(message)
            if (nextToolStatus) {
              setToolStatus(nextToolStatus)
            }
          } else if (message.type === "assistant") {
            const fullText = getAssistantText(message)

            // Skip tool-only turns that produced no visible text
            if (fullText.trim()) {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: fullText,
                },
              ])
            }
            setStreamingText("")
            setIsStreaming(false)
            setToolStatus(null)
          } else if (message.type === "result") {
            const resultError = formatResultError(message)
            if (resultError) setError(resultError)
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

  const handleInputSubmit = useCallback(
    (value: unknown) => {
      if (typeof value === "string") handleSubmit(value)
    },
    [handleSubmit],
  ) as
    & ((event: OpenTUISubmitEvent) => void)
    & ((value: string) => void)

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
            {emptyStateHint ?? "Type a message below and press Enter to start a conversation."}
          </text>
        ) : (
          <box flexDirection="column">
            {messages.map((msg) => (
              <box key={msg.id} flexDirection="column">
                <text fg={msg.role === "user" ? "#7aa2f7" : "#9ece6a"}>
                  <strong>{msg.role === "user" ? "You" : "AutoAuto"}</strong>
                </text>
                {msg.role === "assistant" ? (
                  <markdown content={msg.content} syntaxStyle={syntaxStyle} />
                ) : (
                  <text>{msg.content}</text>
                )}
                <text>{""}</text>
              </box>
            ))}

            {streamingText && (
              <box flexDirection="column">
                <text fg="#9ece6a">
                  <strong>AutoAuto</strong>
                </text>
                <markdown content={streamingText} syntaxStyle={syntaxStyle} streaming />
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
            isStreaming ? "Waiting for response..." : defaultPlaceholder
          }
          focused={!isStreaming}
          onSubmit={handleInputSubmit}
        />
      </box>
    </box>
  )
}
