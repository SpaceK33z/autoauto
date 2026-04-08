import { useState, useEffect, useRef, useCallback } from "react"
import { useKeyboard } from "@opentui/react"
import type { TextareaRenderable } from "@opentui/core"
import type { ProposedGroup } from "../lib/finalize.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"

const RISK_COLORS: Record<string, string> = {
  low: "#9ece6a",
  medium: "#e0af68",
  high: "#f7768e",
}

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function Spinner({ status }: { status: string }) {
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

interface FinalizeApprovalProps {
  /** Agent's full review text */
  summary: string
  /** Proposed file groups (null if none extracted) */
  proposedGroups: ProposedGroup[] | null
  /** Validation error from group extraction */
  validationError: string | null
  /** Whether agent is currently streaming a refinement response */
  isRefining: boolean
  /** Streaming text from refinement agent */
  refiningText: string
  /** Tool status during refinement */
  toolStatus: string | null
  /** Called when user approves the current grouping */
  onApprove: () => void
  /** Called when user wants to skip grouping and just save summary */
  onSkipGrouping: () => void
  /** Called when user submits feedback for refinement */
  onRefine: (feedback: string) => void
  /** Called when user cancels finalize */
  onCancel: () => void
}

export function FinalizeApproval({
  summary,
  proposedGroups,
  validationError,
  isRefining,
  refiningText,
  toolStatus,
  onApprove,
  onSkipGrouping,
  onRefine,
  onCancel,
}: FinalizeApprovalProps) {
  const textareaRef = useRef<TextareaRenderable | null>(null)
  const [inputKey, setInputKey] = useState(0)
  const [inputBoxHeight, setInputBoxHeight] = useState(3)

  const handleSubmit = useCallback(
    (value: string) => {
      const text = value.trim()
      if (isRefining) return

      if (!text) {
        // Empty submit = approve
        if (proposedGroups && proposedGroups.length > 0) {
          onApprove()
        } else {
          onSkipGrouping()
        }
        return
      }

      onRefine(text)
      setInputKey((k) => k + 1)
    },
    [isRefining, proposedGroups, onApprove, onSkipGrouping, onRefine],
  )

  const handleTextareaSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    handleSubmit(textarea.plainText)
    textarea.setText("")
  }, [handleSubmit])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.onSubmit = handleTextareaSubmit
    textarea.onContentChange = () => {
      const h = Math.min(8, Math.max(3, Math.max(textarea.lineCount, textarea.virtualLineCount) + 2))
      setInputBoxHeight(h)
    }
    setInputBoxHeight(3)
  }, [inputKey, handleTextareaSubmit])

  useKeyboard((key) => {
    if (isRefining) return

    if (key.name === "escape") {
      onCancel()
      return
    }

    // 'a' shortcut for approve
    if (key.name === "a" && !textareaRef.current?.focused) {
      if (proposedGroups && proposedGroups.length > 0) {
        onApprove()
      } else {
        onSkipGrouping()
      }
      return
    }

    // 's' shortcut for skip grouping (save summary only)
    if (key.name === "s" && !textareaRef.current?.focused && proposedGroups && proposedGroups.length > 0) {
      onSkipGrouping()
      return
    }

    // Auto-focus textarea on typing
    const textarea = textareaRef.current
    if (!textarea || textarea.focused) return
    if (key.ctrl || key.meta || key.name.length !== 1) return
    textarea.focus()
    textarea.insertText(key.name)
    key.stopPropagation()
  })

  const hasGroups = proposedGroups && proposedGroups.length > 0

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Finalize — Review Proposed Groups">
      {/* Groups section */}
      {hasGroups && (
        <box flexDirection="column" paddingX={1} paddingTop={1}>
          <text fg="#9ece6a"><strong>Proposed Groups ({proposedGroups.length})</strong></text>
          <box height={1} />
          {proposedGroups.map((g, i) => (
            <box key={g.name} flexDirection="column">
              <text selectable>
                <text fg="#ffffff"><strong>{i + 1}. {g.title}</strong></text>
                <text fg={RISK_COLORS[g.risk] ?? "#888888"}> [{g.risk} risk]</text>
              </text>
              <text fg="#888888" selectable>   Files: {g.files.join(", ")}</text>
              {g.description ? <text fg="#666666" selectable>   {g.description}</text> : null}
            </box>
          ))}
        </box>
      )}

      {!hasGroups && (
        <box flexDirection="column" paddingX={1} paddingTop={1}>
          <text fg="#e0af68">No file groups proposed.</text>
          {validationError && <text fg="#f7768e" selectable>Validation: {validationError}</text>}
        </box>
      )}

      {/* Agent review / refinement area */}
      <scrollbox
        focused={isRefining}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        paddingX={1}
      >
        <box flexDirection="column">
          <markdown content={summary} syntaxStyle={syntaxStyle} />

          {refiningText && (
            <>
              <box height={1} />
              <text fg="#9ece6a"><strong>Refinement</strong></text>
              <markdown content={refiningText} syntaxStyle={syntaxStyle} streaming />
            </>
          )}

          {isRefining && !refiningText && toolStatus && (
            <>
              <box height={1} />
              <Spinner status={toolStatus} />
            </>
          )}

          {isRefining && !refiningText && !toolStatus && (
            <>
              <box height={1} />
              <text fg="#888888">Refining groups...</text>
            </>
          )}
        </box>
      </scrollbox>

      {/* Input */}
      <box flexDirection="column">
        <box paddingX={1}>
          <text fg="#888888">
            {hasGroups
              ? "Enter approve · Type feedback to revise · s skip grouping · Esc cancel"
              : "Enter save summary · Type feedback to revise · Esc cancel"}
          </text>
        </box>
        <box border borderStyle="rounded" height={inputBoxHeight} maxHeight={8} title="Feedback (Shift+Enter for newline)">
          <textarea
            key={inputKey}
            ref={textareaRef}
            placeholder={
              isRefining
                ? "Waiting for response..."
                : hasGroups
                  ? "Press Enter to approve, or type feedback..."
                  : "Press Enter to save summary, or type feedback..."
            }
            focused={!isRefining}
            keyBindings={[
              { name: "return", action: "submit" as const },
              { name: "return", shift: true, action: "newline" as const },
            ]}
          />
        </box>
      </box>
    </box>
  )
}
