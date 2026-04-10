import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { colors } from "../lib/theme.ts"

interface PostUpdatePromptProps {
  programSlug: string
  onStartRun: () => void
  onGoHome: () => void
}

export function PostUpdatePrompt({ programSlug, onStartRun, onGoHome }: PostUpdatePromptProps) {
  const [selected, setSelected] = useState(0)

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "k") {
      setSelected(0)
    } else if (key.name === "down" || key.name === "j") {
      setSelected(1)
    } else if (key.name === "return") {
      if (selected === 0) onStartRun()
      else onGoHome()
    } else if (key.name === "escape") {
      onGoHome()
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Program Updated">
      <box flexDirection="column" padding={1}>
        <text fg={colors.success}><strong>Program updated</strong></text>
        <box height={1} />
        <text selectable>Program: {programSlug}</text>
        <box height={1} />
        <text><strong>What would you like to do?</strong></text>
        <box height={1} />
        <text fg={selected === 0 ? colors.text : colors.textMuted}>
          {selected === 0 ? " > " : "   "}
          Start a new run
        </text>
        <text fg={selected === 1 ? colors.text : colors.textMuted}>
          {selected === 1 ? " > " : "   "}
          Go back to home
        </text>
      </box>
    </box>
  )
}
