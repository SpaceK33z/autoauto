import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { VerifyTarget } from "../lib/verify.ts"

interface VerifyResultsOverlayProps {
  defaultRepeats: number
  onConfirm: (target: VerifyTarget, repeats: number) => void
  onCancel: () => void
}

const TARGETS: { value: VerifyTarget; label: string }[] = [
  { value: "baseline", label: "Baseline only" },
  { value: "current", label: "Current only" },
  { value: "both", label: "Both" },
]

export function VerifyResultsOverlay({ defaultRepeats, onConfirm, onCancel }: VerifyResultsOverlayProps) {
  const [selectedTarget, setSelectedTarget] = useState(2) // default to "both"
  const [repeatsText, setRepeatsText] = useState(String(defaultRepeats))

  const parsedRepeats = parseInt(repeatsText, 10)
  const repeatsValid = Number.isFinite(parsedRepeats) && parsedRepeats > 0

  useKeyboard((key) => {
    key.stopPropagation()
    if (key.name === "escape") {
      onCancel()
    } else if (key.name === "return") {
      if (repeatsValid) {
        onConfirm(TARGETS[selectedTarget].value, parsedRepeats)
      }
    } else if (key.name === "up" || key.name === "k") {
      setSelectedTarget((s) => Math.max(0, s - 1))
    } else if (key.name === "down" || key.name === "j") {
      setSelectedTarget((s) => Math.min(TARGETS.length - 1, s + 1))
    } else if (key.name === "backspace") {
      setRepeatsText((t) => t.slice(0, -1))
    } else if (/^\d$/.test(key.name)) {
      setRepeatsText((t) => t + key.name)
    }
  })

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
        title="Verify Results"
        flexDirection="column"
        paddingX={1}
        width={56}
        backgroundColor="#1a1b26"
      >
        <text fg="#e0af68">Warning: worktree will be temporarily checked out to different commits</text>
        <box height={1} />
        <text><strong>What to verify:</strong></text>
        {TARGETS.map((t, i) => (
          <text key={t.value} fg={i === selectedTarget ? "#ffffff" : "#888888"}>
            {i === selectedTarget ? " > " : "   "}{t.label}
          </text>
        ))}
        <box height={1} />
        <text>
          <span fg="#7aa2f7"><strong>{`Repeats: ${repeatsText}`}<span fg="#7aa2f7">{"\u2588"}</span></strong></span>
          {"  "}
          {!repeatsValid && <span fg="#ff5555">Must be a positive number</span>}
        </text>
        <box height={1} />
        <text fg="#666666">j/k select target · type number for repeats · Enter confirm · Esc cancel</text>
      </box>
    </box>
  )
}
