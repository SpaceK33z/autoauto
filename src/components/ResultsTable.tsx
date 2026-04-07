import { memo, useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import type { ExperimentResult, ExperimentStatus } from "../lib/run.ts"
import { padRight, truncate } from "../lib/format.ts"

interface ResultsTableProps {
  results: ExperimentResult[]
  metricField: string
  width: number
  experimentNumber?: number
  focused?: boolean
  selectedResult?: ExperimentResult | null
  onSelect?: (result: ExperimentResult) => void
}

export function statusColor(status: ExperimentStatus): string {
  switch (status) {
    case "keep": return "#9ece6a"
    case "discard": return "#ff5555"
    case "crash": return "#ff5555"
    case "measurement_failure": return "#e0af68"
  }
}


const ResultRow = memo(function ResultRow({ result: r, descWidth, highlighted, selected }: { result: ExperimentResult; descWidth: number; highlighted?: boolean; selected?: boolean }) {
  const bg = selected ? "#3d59a1" : highlighted ? "#292e42" : undefined
  const fg = statusColor(r.status)
  return (
    <box paddingX={1} backgroundColor={bg}>
      <text fg={fg}>
        {padRight(String(r.experiment_number), 4)}
        {padRight(r.commit, 9)}
        {padRight(r.metric_value != null ? String(r.metric_value) : "—", 12)}
        {padRight(r.status, 12)}
        {truncate(r.description, descWidth)}
      </text>
    </box>
  )
})

const FIXED_COLS_WIDTH = 4 + 9 + 12 + 12 // #, commit, metric, status
// outer border (2) + paddingX (2)
const CHROME_WIDTH = 4

export function ResultsTable({ results, metricField, width, experimentNumber, focused, selectedResult, onSelect }: ResultsTableProps) {
  // Skip the baseline row (#0) — it's in the stats header
  const experiments = results.filter(r => r.experiment_number > 0)
  const descWidth = Math.max(width - CHROME_WIDTH - FIXED_COLS_WIDTH, 10)
  const [highlightIndex, setHighlightIndex] = useState(0)

  // Reset highlight to latest row when table gains focus
  useEffect(() => {
    if (focused && experiments.length > 0) {
      setHighlightIndex(experiments.length - 1)
    }
  }, [focused])

  useKeyboard((key) => {
    if (!focused || experiments.length === 0) return

    if (key.name === "up" || key.name === "k") {
      setHighlightIndex(i => Math.max(0, i - 1))
    } else if (key.name === "down" || key.name === "j") {
      setHighlightIndex(i => Math.min(experiments.length - 1, i + 1))
    } else if (key.name === "enter") {
      onSelect?.(experiments[highlightIndex])
    }
  })

  // Keep highlight in bounds when results change
  const safeHighlight = experiments.length > 0 ? Math.min(highlightIndex, experiments.length - 1) : 0

  return (
    <box flexDirection="column" flexGrow={1}>
      <box paddingX={1}>
        <text fg="#a9b1d6">
          {padRight("#", 4)}{padRight("commit", 9)}{padRight(metricField, 12)}{padRight("status", 12)}{padRight("description", descWidth)}
        </text>
      </box>
      <scrollbox flexGrow={1} stickyScroll={!focused} stickyStart="bottom">
        {experiments.length === 0 ? (
          <box paddingX={1}>
            <text fg="#a9b1d6">
              {experimentNumber != null && experimentNumber > 0
                ? `Running experiment #${experimentNumber}...`
                : "Running baseline measurement..."}
            </text>
          </box>
        ) : (
          experiments.map((r, i) => (
            <ResultRow
              key={r.experiment_number}
              result={r}
              descWidth={descWidth}
              highlighted={focused && i === safeHighlight}
              selected={selectedResult?.experiment_number === r.experiment_number}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}
