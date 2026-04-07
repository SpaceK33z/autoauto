import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { RunState } from "../lib/run.ts"

interface RunCompletePromptProps {
  state: RunState
  terminationReason: "aborted" | "max_experiments" | "stopped" | null
  error: string | null
  onCleanup: () => void
  onAbandon: () => void
}

export function RunCompletePrompt({
  state,
  terminationReason,
  error,
  onCleanup,
  onAbandon,
}: RunCompletePromptProps) {
  const [selected, setSelected] = useState(0)

  const totalExperiments = state.total_keeps + state.total_discards + state.total_crashes
  const keepRate = totalExperiments > 0 ? state.total_keeps / totalExperiments : 0
  const improvementPct = state.original_baseline !== 0
    ? ((state.best_metric - state.original_baseline) / Math.abs(state.original_baseline)) * 100
    : 0

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "k") {
      setSelected(0)
    } else if (key.name === "down" || key.name === "j") {
      setSelected(1)
    } else if (key.name === "return") {
      if (selected === 0) onCleanup()
      else onAbandon()
    } else if (key.name === "c") {
      onCleanup()
    } else if (key.name === "a") {
      onAbandon()
    }
  })

  const reasonLabel =
    terminationReason === "aborted" ? "Aborted by user"
    : terminationReason === "max_experiments" ? `Reached max experiments (${state.experiment_number})`
    : "Run complete"

  const improvementStr = improvementPct !== 0
    ? ` (${improvementPct > 0 ? "+" : ""}${improvementPct.toFixed(1)}%)`
    : ""

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Run Complete">
      <box flexDirection="column" padding={1}>
        <text fg="#9ece6a"><strong>{reasonLabel}</strong></text>
        <text>{""}</text>
        <text>Program: {state.program_slug}</text>
        <text>Branch: {state.branch_name}</text>
        <text>Experiments: {totalExperiments} ({state.total_keeps} kept, {state.total_discards} discarded, {state.total_crashes} crashed)</text>
        <text>Original baseline: {state.original_baseline}</text>
        <text>Best metric: {state.best_metric}{improvementStr}</text>
        {state.total_keeps > 0 && (
          <text>Keep rate: {(keepRate * 100).toFixed(0)}%</text>
        )}
        {error && <text fg="#ff5555">Error: {error}</text>}

        <text>{""}</text>
        <text><strong>What would you like to do?</strong></text>
        <text>{""}</text>
        <text fg={selected === 0 ? "#ffffff" : "#888888"}>
          {selected === 0 ? " > " : "   "}
          Run cleanup (review & package changes)
        </text>
        <text fg={selected === 1 ? "#ffffff" : "#888888"}>
          {selected === 1 ? " > " : "   "}
          Abandon (keep branch as-is)
        </text>
      </box>
    </box>
  )
}
