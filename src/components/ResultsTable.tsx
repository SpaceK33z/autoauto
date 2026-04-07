import { memo, useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import type { ExperimentResult, ExperimentStatus } from "../lib/run.ts"
import { allocateColumnWidths, formatCell } from "../lib/format.ts"

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


interface ResultColumnWidths {
  number: number
  commit: number
  metric: number
  status: number
  description: number
}

const ResultRow = memo(function ResultRow({ result: r, widths, highlighted, selected }: { result: ExperimentResult; widths: ResultColumnWidths; highlighted?: boolean; selected?: boolean }) {
  const bg = selected ? "#3d59a1" : highlighted ? "#292e42" : undefined
  const fg = statusColor(r.status)
  return (
    <box paddingX={1} backgroundColor={bg}>
      <text fg={fg} selectable>
        {formatCell(String(r.experiment_number), widths.number)}
        {formatCell(r.commit, widths.commit)}
        {formatCell(r.metric_value != null ? String(r.metric_value) : "—", widths.metric)}
        {formatCell(r.status, widths.status)}
        {formatCell(r.description, widths.description)}
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
  const innerWidth = Math.max(width - CHROME_WIDTH, 0)
  const [numberWidth, commitWidth, metricWidth, statusWidth, descWidth] = allocateColumnWidths(innerWidth, [
    { ideal: 4, min: 2 },
    { ideal: 9, min: 0 },
    { ideal: 12, min: 0 },
    { ideal: 12, min: 0 },
    { ideal: Math.max(innerWidth - FIXED_COLS_WIDTH, 0), min: 0 },
  ])
  const widths = {
    number: numberWidth,
    commit: commitWidth,
    metric: metricWidth,
    status: statusWidth,
    description: descWidth,
  }
  const [highlightIndex, setHighlightIndex] = useState(0)

  // Reset highlight to latest row when table gains focus
  useEffect(() => {
    if (focused && experiments.length > 0) {
      setHighlightIndex(experiments.length - 1)
    }
  }, [focused, experiments.length])

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
          {formatCell("#", widths.number)}{formatCell("commit", widths.commit)}{formatCell(metricField, widths.metric)}{formatCell("status", widths.status)}{formatCell("description", widths.description)}
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
              widths={widths}
              highlighted={focused && i === safeHighlight}
              selected={selectedResult?.experiment_number === r.experiment_number}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}
