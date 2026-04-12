import { useRef, useEffect, useCallback } from "react"
import type { TextareaRenderable } from "@opentui/core"
import { colors } from "../lib/theme.ts"

interface GuidanceOverlayProps {
  currentGuidance: string
  onSave: (text: string) => void
}

export function GuidanceOverlay({ currentGuidance, onSave }: GuidanceOverlayProps) {
  const textareaRef = useRef<TextareaRenderable | null>(null)

  const handleSubmit = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    onSave(textarea.plainText)
  }, [onSave])

  // Wire up onSubmit imperatively — React reconciler only maps these for <input>, not <textarea>
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.onSubmit = handleSubmit
    if (currentGuidance) {
      textarea.setText(currentGuidance)
    }
  }, [handleSubmit, currentGuidance])

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      zIndex={100}
    >
      <box
        border
        borderStyle="rounded"
        title="Human Guidance"
        flexDirection="column"
        paddingX={1}
        width={60}
        backgroundColor={colors.surface}
      >
        <text fg={colors.textMuted}>
          Steer the experiment agent. This will be included in the next experiment's context.
        </text>
        <box border borderStyle="rounded" height={8}>
          <textarea
            ref={textareaRef}
            placeholder="e.g., Focus on optimizing the hot loop in parser.ts..."
            focused
            keyBindings={[
              { name: "return", action: "submit" as const },
              { name: "return", shift: true, action: "newline" as const },
            ]}
          />
        </box>
        <text fg={colors.textDim}>Enter: save · Shift+Enter: newline · Esc: cancel · Clear text + Enter: remove guidance</text>
      </box>
    </box>
  )
}
