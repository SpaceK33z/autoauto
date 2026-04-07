import { memo, useState, useEffect, useMemo } from "react"
import { useKeyboard } from "@opentui/react"
import type { ExperimentResult, ExperimentStatus } from "../lib/run.ts"
import { parseSecondaryValues } from "../lib/run.ts"
import type { SecondaryMetric } from "../lib/programs.ts"
import { allocateColumnWidths, formatCell } from "../lib/format.ts"

interface ResultsTableProps {
  results: ExperimentResult[]
  metricField: string
  secondaryMetrics?: Record<string, SecondaryMetric>
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

const ResultRow = memo(function ResultRow({ result: r, secondaryFields, highlighted, selected, columnWidths }: {
  result: ExperimentResult
  secondaryFields: string[]
  highlighted?: boolean
  selected?: boolean
  columnWidths: number[]
}) {
  const bg = selected ? "#3d59a1" : highlighted ? "#292e42" : undefined
  const fg = statusColor(r.status)

  const secondaryValues = secondaryFields.length > 0 ? parseSecondaryValues(r.secondary_values) : null
  const fixedCells = [
    formatCell(String(r.experiment_number), columnWidths[0]),
    formatCell(r.commit, columnWidths[1]),
    formatCell(r.metric_value != null ? String(r.metric_value) : "—", columnWidths[2]),
  ]
  const secondaryCells = secondaryFields.map((field, i) => {
    const val = secondaryValues?.secondary_metrics[field]
    return formatCell(val != null ? String(val) : "—", columnWidths[3 + i])
  })
  const trailingCells = [
    formatCell(r.status, columnWidths[3 + secondaryFields.length]),
    formatCell(r.description, columnWidths[4 + secondaryFields.length]),
  ]

  return (
    <box paddingX={1} backgroundColor={bg}>
      <text fg={fg} selectable>
        {fixedCells.join("")}{secondaryCells.join("")}{trailingCells.join("")}
      </text>
    </box>
  )
})

// outer border (2) + paddingX (2)
const CHROME_WIDTH = 4

export function ResultsTable({ results, metricField, secondaryMetrics, width, experimentNumber, focused, selectedResult, onSelect }: ResultsTableProps) {
  const secondaryFields = useMemo(() => secondaryMetrics ? Object.keys(secondaryMetrics) : [], [secondaryMetrics])

  // Skip the baseline row (#0) — it's in the stats header
  const experiments = results.filter(r => r.experiment_number > 0)
  const innerWidth = Math.max(width - CHROME_WIDTH, 0)

  const columnSpecs = useMemo(() => {
    const fixedCols = [
      { ideal: 4, min: 2 },   // #
      { ideal: 9, min: 0 },   // commit
      { ideal: 12, min: 0 },  // primary metric
    ]
    const secondaryCols = secondaryFields.map(() => ({ ideal: 10, min: 0 }))
    const fixedWidth = 4 + 9 + 12 + 12 + secondaryFields.length * 10
    const trailingCols = [
      { ideal: 12, min: 0 },  // status
      { ideal: Math.max(innerWidth - fixedWidth, 0), min: 0 },  // description
    ]
    return [...fixedCols, ...secondaryCols, ...trailingCols]
  }, [secondaryFields, innerWidth])

  const columnWidths = useMemo(() => allocateColumnWidths(innerWidth, columnSpecs), [innerWidth, columnSpecs])

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

  // Build header
  const headerCells = [
    formatCell("#", columnWidths[0]),
    formatCell("commit", columnWidths[1]),
    formatCell(metricField, columnWidths[2]),
    ...secondaryFields.map((field, i) => formatCell(field, columnWidths[3 + i])),
    formatCell("status", columnWidths[3 + secondaryFields.length]),
    formatCell("description", columnWidths[4 + secondaryFields.length]),
  ]

  return (
    <box flexDirection="column" flexGrow={1}>
      <box paddingX={1}>
        <text fg="#a9b1d6">
          {headerCells.join("")}
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
              secondaryFields={secondaryFields}
              columnWidths={columnWidths}
              highlighted={focused && i === safeHighlight}
              selected={selectedResult?.experiment_number === r.experiment_number}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}
