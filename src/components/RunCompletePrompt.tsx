import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { RunState } from "../lib/run.ts"
import { getRunStats } from "../lib/run.ts"
import type { TerminationReason } from "../lib/experiment-loop.ts"

interface RunCompletePromptProps {
  state: RunState
  direction: "lower" | "higher"
  terminationReason: TerminationReason | null
  error: string | null
  onCleanup: () => void
  onAbandon: () => void
}

export function RunCompletePrompt({
  state,
  direction,
  terminationReason,
  error,
  onCleanup,
  onAbandon,
}: RunCompletePromptProps) {
  const [selected, setSelected] = useState(0)
  const stats = getRunStats(state, direction)

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

  const improvementStr = stats.improvement_pct !== 0
    ? ` (${stats.improvement_pct > 0 ? "+" : ""}${stats.improvement_pct.toFixed(1)}%)`
    : ""

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Run Complete">
      <box flexDirection="column" padding={1}>
        <text fg="#9ece6a"><strong>{reasonLabel}</strong></text>
        <text>{""}</text>
        <text>Program: {state.program_slug}</text>
        <text>Branch: {state.branch_name}</text>
        <text>Experiments: {stats.total_experiments} ({stats.total_keeps} kept, {stats.total_discards} discarded, {stats.total_crashes} crashed)</text>
        <text>Original baseline: {state.original_baseline}</text>
        <text>Best metric: {state.best_metric}{improvementStr}</text>
        {stats.total_keeps > 0 && (
          <text>Keep rate: {(stats.keep_rate * 100).toFixed(0)}%</text>
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
