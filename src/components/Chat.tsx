import { useState, useEffect, useRef, useCallback } from "react"
import { useKeyboard } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import { DEFAULT_SYSTEM_PROMPT } from "../lib/system-prompts/index.ts"
import type { EffortLevel } from "../lib/config.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { getProvider, type AgentProviderID, type AgentSession } from "../lib/agent/index.ts"
import { formatToolEvent } from "../lib/tool-events.ts"

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function ToolStatusSpinner({ status }: { status: string }) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(interval)
  }, [])

  const spinner = SPINNER_CHARS[tick % SPINNER_CHARS.length]
  const seconds = Math.floor(tick / 10)
  const timeStr =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
      : `${seconds}s`

  return (
    <text fg="#888888" selectable>
      {spinner} {status} ({timeStr})
    </text>
  )
}

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
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
  provider?: AgentProviderID
  /** Reasoning effort level */
  effort?: EffortLevel
  /** Auto-submit this message on mount as the first user message */
  initialMessage?: string
  /** Hint shown in the empty chat area before any messages */
  emptyStateHint?: string
  /** Placeholder text for the input field */
  inputPlaceholder?: string
  /** Title shown on the scrollbox border */
  title?: string
}

export function Chat({
  cwd,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  tools,
  allowedTools,
  maxTurns,
  model,
  provider = "claude",
  effort,
  initialMessage,
  emptyStateHint,
  inputPlaceholder,
  title,
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<AgentSession | null>(null)
  const textareaRef = useRef<TextareaRenderable | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const [inputBoxHeight, setInputBoxHeight] = useState(3)

  // Capture config in refs — the agent session is long-lived and should not
  // restart when parent re-renders. These are stable for the component lifetime.
  const configRef = useRef({ cwd, systemPrompt, tools, allowedTools, maxTurns, provider, model, effort, initialMessage })
  const defaultPlaceholder = inputPlaceholder ?? "Ask something..."

  useEffect(() => {
    const config = configRef.current
    const session = getProvider(config.provider).createSession({
      systemPrompt: config.systemPrompt,
      tools: config.tools ?? [],
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
    })
    sessionRef.current = session

    // Auto-submit initial message if provided
    if (config.initialMessage) {
      const text = config.initialMessage.trim()
      if (text) {
        setMessages([{ id: crypto.randomUUID(), role: "user", content: text }])
        session.pushMessage(text)
        setIsStreaming(true)
        setInputKey((k) => k + 1)
      }
    }

    ;(async () => {
      try {
        for await (const event of session) {
          switch (event.type) {
            case "text_delta":
              setStreamingText((prev) => prev + event.text)
              setToolStatus(null)
              break
            case "tool_use":
              setToolStatus(formatToolEvent(event.tool, event.input ?? {}))
              break
            case "assistant_complete":
              // Skip tool-only turns that produced no visible text
              if (event.text.trim()) {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: event.text,
                  },
                ])
              }
              setStreamingText("")
              setIsStreaming(false)
              setToolStatus(null)
              break
            case "error":
              setError(event.error)
              setIsStreaming(false)
              break
            case "result":
              if (!event.success && event.error) {
                setError(`Agent error: ${event.error}`)
              }
              setIsStreaming(false)
              break
          }
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err))
        setIsStreaming(false)
      }
    })()

    return () => {
      session.close()
      sessionRef.current = null
    }
  }, [])

  const handleSubmit = useCallback(
    (value: string) => {
      const text = value.trim()
      if (!text || isStreaming || !sessionRef.current) return

      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: text },
      ])

      sessionRef.current.pushMessage(text)

      setIsStreaming(true)
      setStreamingText("")
      setError(null)
      setInputKey((k) => k + 1)
    },
    [isStreaming]
  )

  const handleTextareaSubmit = useCallback(
    () => {
      const textarea = textareaRef.current
      if (!textarea) return
      const value = textarea.plainText
      handleSubmit(value)
      textarea.setText("")
    },
    [handleSubmit],
  )

  // Wire up onSubmit and auto-grow imperatively — React reconciler only maps these for <input>, not <textarea>
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.onSubmit = handleTextareaSubmit
    textarea.onContentChange = () => {
      // +2 for top/bottom border
      const h = Math.min(8, Math.max(3, Math.max(textarea.lineCount, textarea.virtualLineCount) + 2))
      setInputBoxHeight(h)
    }
    // Reset height on remount (after submit clears content)
    setInputBoxHeight(3)
  }, [inputKey, handleTextareaSubmit])

  // Auto-focus textarea when user starts typing while a non-interactable
  // element (e.g. the messages scrollbox) has focus
  useKeyboard((key) => {
    const textarea = textareaRef.current
    if (!textarea || isStreaming) return
    if (textarea.focused) return
    // Only intercept printable single-character keys (no ctrl/meta combos)
    if (key.ctrl || key.meta || key.name.length !== 1) return
    textarea.focus()
    textarea.insertText(key.name)
    key.stopPropagation()
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox
        focused={isStreaming}
        flexGrow={1}
        border
        borderStyle="rounded"
        stickyScroll
        stickyStart="bottom"
        title={title}
      >
        {messages.length === 0 && !streamingText ? (
          <text fg="#888888">
            {emptyStateHint ?? "Type a message below and press Enter to start a conversation."}
          </text>
        ) : (
          <box flexDirection="column">
            {messages.map((msg) => (
              <box key={msg.id} flexDirection="column" backgroundColor={msg.role === "user" ? "#1a1a2e" : undefined}>
                <text fg={msg.role === "user" ? "#ffffff" : "#9ece6a"}>
                  <strong>{msg.role === "user" ? "You" : "AutoAuto"}</strong>
                </text>
                {msg.role === "assistant" ? (
                  <markdown content={msg.content} syntaxStyle={syntaxStyle} />
                ) : (
                  <text selectable>{msg.content}</text>
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
                {toolStatus ? (
                  <ToolStatusSpinner key={toolStatus} status={toolStatus} />
                ) : (
                  <text fg="#888888">Thinking...</text>
                )}
              </box>
            )}

            {toolStatus && isStreaming && streamingText && (
              <ToolStatusSpinner key={toolStatus} status={toolStatus} />
            )}

            {error && <text fg="#ff5555" selectable>Error: {error}</text>}
          </box>
        )}
      </scrollbox>

      <box border borderStyle="rounded" height={inputBoxHeight} maxHeight={8} title="Message (Shift+Enter for newline)">
        <textarea
          key={inputKey}
          ref={textareaRef}
          placeholder={
            isStreaming ? "Waiting for response..." : defaultPlaceholder
          }
          focused={!isStreaming}
          keyBindings={[
            { name: "return", action: "submit" as const },
            { name: "return", shift: true, action: "newline" as const },
          ]}
        />
      </box>
    </box>
  )
}
