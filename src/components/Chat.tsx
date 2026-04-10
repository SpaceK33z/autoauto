import { useState, useEffect, useRef, useCallback } from "react"
import { useKeyboard } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import { DEFAULT_SYSTEM_PROMPT } from "../lib/system-prompts/index.ts"
import type { EffortLevel } from "../lib/config.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { getProvider, type AgentProviderID, type AgentSession } from "../lib/agent/index.ts"
import { formatToolEvent } from "../lib/tool-events.ts"
import { formatShellError } from "../lib/git.ts"
import { colors } from "../lib/theme.ts"

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
    <text fg={colors.textMuted} selectable>
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
  /** Pre-existing messages to restore (for session resume) */
  resumeMessages?: Array<{ role: "user" | "assistant"; content: string }>
  /** SDK session ID for native resume (Claude provider) */
  resumeSessionId?: string
  /** Called when the provider assigns a session ID */
  onSessionId?: (id: string) => void
  /** Called on every assistant_complete with the full message list (for draft persistence) */
  onMessagesChange?: (messages: Array<{ role: "user" | "assistant"; content: string }>) => void
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
  resumeMessages,
  resumeSessionId,
  onSessionId,
  onMessagesChange,
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    // Pre-populate from resumed messages if provided
    if (resumeMessages?.length) {
      return resumeMessages.map((m) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
      }))
    }
    return []
  })
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<AgentSession | null>(null)
  const textareaRef = useRef<TextareaRenderable | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const [inputBoxHeight, setInputBoxHeight] = useState(3)

  // Track callbacks and latest messages in refs to avoid re-triggering the session effect
  const onSessionIdRef = useRef(onSessionId)
  onSessionIdRef.current = onSessionId
  const onMessagesChangeRef = useRef(onMessagesChange)
  onMessagesChangeRef.current = onMessagesChange

  const emitMessagesChange = useCallback((nextMessages: ChatMessage[]) => {
    onMessagesChangeRef.current?.(nextMessages.map((m) => ({ role: m.role, content: m.content })))
  }, [])

  // Capture config in refs — the agent session is long-lived and should not
  // restart when parent re-renders. These are stable for the component lifetime.
  const configRef = useRef({ cwd, systemPrompt, tools, allowedTools, maxTurns, provider, model, effort, initialMessage, resumeMessages, resumeSessionId })
  const defaultPlaceholder = inputPlaceholder ?? "Ask something..."

  useEffect(() => {
    const config = configRef.current
    const isClaudeResume = config.provider === "claude" && !!config.resumeSessionId
    const hasResumeMessages = (config.resumeMessages?.length ?? 0) > 0

    // For non-Claude resume: build a conversation preamble from prior messages
    let effectiveSystemPrompt = config.systemPrompt
    if (hasResumeMessages && !isClaudeResume) {
      const transcript = config.resumeMessages!
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n")
      effectiveSystemPrompt = `${config.systemPrompt ?? ""}\n\n---\nHere is the conversation so far from a previous session. Continue from where we left off:\n\n${transcript}\n---`
    }

    const session = getProvider(config.provider).createSession({
      systemPrompt: effectiveSystemPrompt,
      tools: config.tools ?? [],
      allowedTools: config.allowedTools,
      maxTurns: config.maxTurns,
      cwd: config.cwd,
      model: config.model,
      effort: config.effort,
      resumeSessionId: isClaudeResume ? config.resumeSessionId : undefined,
    })
    sessionRef.current = session

    // Auto-submit initial message if provided (but not when resuming)
    if (config.initialMessage && !hasResumeMessages) {
      const text = config.initialMessage.trim()
      if (text) {
        const nextMessages = [{ id: crypto.randomUUID(), role: "user" as const, content: text }]
        setMessages(nextMessages)
        emitMessagesChange(nextMessages)
        session.pushMessage(text)
        setIsStreaming(true)
        setInputKey((k) => k + 1)
      }
    }

    let sessionIdEmitted = false

    ;(async () => {
      try {
        for await (const event of session) {
          // Emit session ID once available
          if (!sessionIdEmitted && session.sessionId) {
            sessionIdEmitted = true
            onSessionIdRef.current?.(session.sessionId)
          }

          switch (event.type) {
            case "text_delta":
              setStreamingText((prev) => prev + event.text)
              setToolStatus(null)
              setIsStreaming(true)
              break
            case "tool_use":
              setToolStatus(formatToolEvent(event.tool, event.input ?? {}))
              setIsStreaming(true)
              break
            case "assistant_complete":
              // Skip tool-only turns that produced no visible text
              if (event.text.trim()) {
                setMessages((prev) => {
                  const nextMessages = [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant" as const,
                      content: event.text,
                    },
                  ]
                  emitMessagesChange(nextMessages)
                  return nextMessages
                })
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
        setError(formatShellError(err))
        setIsStreaming(false)
      }
    })()

    return () => {
      session.close()
      sessionRef.current = null
    }
  }, [emitMessagesChange])

  const handleSubmit = useCallback(
    (value: string) => {
      const text = value.trim()
      if (!text || isStreaming || !sessionRef.current) return

      setMessages((prev) => {
        const nextMessages = [
          ...prev,
          { id: crypto.randomUUID(), role: "user" as const, content: text },
        ]
        emitMessagesChange(nextMessages)
        return nextMessages
      })

      sessionRef.current.pushMessage(text)

      setIsStreaming(true)
      setStreamingText("")
      setError(null)
      setInputKey((k) => k + 1)
    },
    [emitMessagesChange, isStreaming]
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
          <text fg={colors.textMuted}>
            {emptyStateHint ?? "Type a message below and press Enter to start a conversation."}
          </text>
        ) : (
          <box flexDirection="column">
            {messages.map((msg) => (
              <box key={msg.id} flexDirection="column" backgroundColor={msg.role === "user" ? colors.surfaceAlt : undefined}>
                <text fg={msg.role === "user" ? colors.text : colors.success}>
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
                <text fg={colors.success}>
                  <strong>AutoAuto</strong>
                </text>
                <markdown content={streamingText} syntaxStyle={syntaxStyle} streaming />
              </box>
            )}

            {isStreaming && !streamingText && (
              <box flexDirection="column">
                <text fg={colors.success}>
                  <strong>AutoAuto</strong>
                </text>
                {toolStatus ? (
                  <ToolStatusSpinner key={toolStatus} status={toolStatus} />
                ) : (
                  <text fg={colors.textMuted}>Thinking...</text>
                )}
              </box>
            )}

            {toolStatus && isStreaming && streamingText && (
              <ToolStatusSpinner key={toolStatus} status={toolStatus} />
            )}

            {error && <text fg={colors.error} selectable>Error: {error}</text>}
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
