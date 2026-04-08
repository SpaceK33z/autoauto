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
  onFinalize: () => void
  onAbandon: () => void
  onUpdateProgram: () => void
}

export function RunCompletePrompt({
  state,
  direction,
  terminationReason,
  error,
  onFinalize,
  onAbandon,
  onUpdateProgram,
}: RunCompletePromptProps) {
  const [selected, setSelected] = useState(0)
  const stats = getRunStats(state, direction)

  useKeyboard((key) => {
    if (key.name === "up" || key.name === "k") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (key.name === "down" || key.name === "j") {
      setSelected((s) => Math.min(2, s + 1))
    } else if (key.name === "return") {
      if (selected === 0) onFinalize()
      else if (selected === 1) onUpdateProgram()
      else onAbandon()
    } else if (key.name === "f") {
      onFinalize()
    } else if (key.name === "u") {
      onUpdateProgram()
    } else if (key.name === "a") {
      onAbandon()
    }
  })

  const reasonLabel =
    terminationReason === "aborted" ? "Aborted by user"
    : terminationReason === "max_experiments" ? `Reached max experiments (${state.experiment_number})`
    : terminationReason === "stagnation" ? "Stopped — no improvements (stagnation)"
    : "Run complete"

  const improvementStr = stats.improvement_pct !== 0
    ? ` (${stats.improvement_pct > 0 ? "+" : ""}${stats.improvement_pct.toFixed(1)}%)`
    : ""

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Run Complete">
      <box flexDirection="column" padding={1}>
        <text fg="#9ece6a" selectable><strong>{reasonLabel}</strong></text>
        <box height={1} />
        <text selectable>Program: {state.program_slug}</text>
        <text selectable>Branch: {state.branch_name}</text>
        <text selectable>Experiments: {stats.total_experiments} ({stats.total_keeps} kept, {stats.total_discards} discarded, {stats.total_crashes} crashed)</text>
        <text selectable>Original baseline: {state.original_baseline}</text>
        <text selectable>Best metric: {state.best_metric}{improvementStr}</text>
        {stats.total_keeps > 0 && (
          <text selectable>Keep rate: {(stats.keep_rate * 100).toFixed(0)}%</text>
        )}
        {error && <text fg="#ff5555" selectable>Error: {error}</text>}

        <box height={1} />
        <text><strong>What would you like to do?</strong></text>
        <box height={1} />
        <text fg={selected === 0 ? "#ffffff" : "#888888"}>
          {selected === 0 ? " > " : "   "}
          Finalize (review & package changes)
        </text>
        <text fg={selected === 1 ? "#ffffff" : "#888888"}>
          {selected === 1 ? " > " : "   "}
          Update Program (edit config/scripts)
        </text>
        <text fg={selected === 2 ? "#ffffff" : "#888888"}>
          {selected === 2 ? " > " : "   "}
          Abandon (keep branch as-is)
        </text>
      </box>
    </box>
  )
}
