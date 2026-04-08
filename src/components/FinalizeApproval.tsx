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

export function stripFinalizeGroupsBlock(text: string): string {
  return text.replace(/<finalize_groups>[\s\S]*?<\/finalize_groups>/g, "").trim()
}

export interface FinalizeApprovalProps {
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
  const [inputFocused, setInputFocused] = useState(false)
  const [selectedAction, setSelectedAction] = useState(0)
  const hasGroups = proposedGroups && proposedGroups.length > 0
  const displaySummary = stripFinalizeGroupsBlock(summary)
  const actions = hasGroups
    ? ["Approve Groups", "Save Summary Only", "Cancel"]
    : ["Save Summary", "Cancel"]

  const runSelectedAction = useCallback(() => {
    if (hasGroups) {
      if (selectedAction === 0) {
        onApprove()
      } else if (selectedAction === 1) {
        onSkipGrouping()
      } else {
        onCancel()
      }
      return
    }

    if (selectedAction === 0) {
      onSkipGrouping()
    } else {
      onCancel()
    }
  }, [hasGroups, selectedAction, onApprove, onSkipGrouping, onCancel])

  const handleSubmit = useCallback(
    (value: string) => {
      const text = value.trim()
      if (isRefining) return

      if (!text) {
        runSelectedAction()
        return
      }

      onRefine(text)
      setInputFocused(false)
      setInputKey((k) => k + 1)
    },
    [isRefining, onRefine, runSelectedAction],
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

  useEffect(() => {
    if (selectedAction <= actions.length - 1) return
    setSelectedAction(actions.length - 1)
  }, [actions.length, selectedAction])

  useEffect(() => {
    if (isRefining) setInputFocused(false)
  }, [isRefining])

  useKeyboard((key) => {
    if (isRefining) return

    const textarea = textareaRef.current

    if (inputFocused) {
      if (key.name === "escape") {
        setInputFocused(false)
        return
      }
      return
    }

    if (key.name === "escape") {
      onCancel()
      return
    }

    if (key.name === "left" || key.name === "h") {
      setSelectedAction((value) => Math.max(0, value - 1))
      return
    }

    if (key.name === "right" || key.name === "l" || key.name === "tab") {
      setSelectedAction((value) => Math.min(actions.length - 1, value + 1))
      return
    }

    if (key.name === "return") {
      runSelectedAction()
      return
    }

    // Auto-focus textarea on typing
    if (!textarea) return
    if (key.ctrl || key.meta || key.name.length !== 1) return
    setInputFocused(true)
    textarea.focus()
    textarea.insertText(key.name)
    key.stopPropagation()
  })

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Finalize — Review Proposed Groups">
      {/* Groups section */}
      {hasGroups && (
        <box flexDirection="column" paddingX={1} paddingTop={1}>
          <text fg="#9ece6a"><strong>{`Proposed Groups (${proposedGroups.length})`}</strong></text>
          <box height={1} />
          {proposedGroups.map((g, i) => (
            <box key={g.name} flexDirection="column">
              <box flexDirection="row">
                <text fg="#ffffff" selectable><strong>{`${i + 1}. ${g.title}`}</strong></text>
                <text fg={RISK_COLORS[g.risk] ?? "#888888"} selectable>{` [${g.risk} risk]`}</text>
              </box>
              <text fg="#888888" selectable>{`   Files: ${g.files.join(", ")}`}</text>
              {g.description ? <text fg="#666666" selectable>   {g.description}</text> : null}
            </box>
          ))}
        </box>
      )}

      {!hasGroups && (
        <box flexDirection="column" paddingX={1} paddingTop={1}>
          {validationError ? (
            <text fg="#f7768e" selectable>Proposed grouping needs revision: {validationError}</text>
          ) : (
            <text fg="#e0af68">No file groups proposed.</text>
          )}
        </box>
      )}

      {/* Agent review / refinement area */}
      <scrollbox
        focused={isRefining}
        flexGrow={1}
        stickyScroll={isRefining}
        stickyStart={isRefining ? "bottom" : undefined}
        paddingX={1}
      >
        <box flexDirection="column">
          <markdown content={displaySummary} syntaxStyle={syntaxStyle} />

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
            {inputFocused
              ? "Enter send feedback · Shift+Enter newline · Esc back to actions"
              : "Left/Right choose action · Enter confirm · Type to revise · Esc cancel"}
          </text>
        </box>
        <box paddingX={1}>
          <text selectable>{actions.map((label, index) => selectedAction === index ? `[${label}]` : label).join("  ")}</text>
        </box>
        <box border borderStyle="rounded" height={inputBoxHeight} maxHeight={8} title="Feedback (Shift+Enter for newline)">
          <textarea
            key={inputKey}
            ref={textareaRef}
            placeholder={
              isRefining
                ? "Waiting for response..."
                : "Type feedback to revise the grouping..."
            }
            focused={inputFocused && !isRefining}
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
