import { memo, useState, useEffect, useMemo } from "react"
import { useKeyboard } from "@opentui/react"
import type { ExperimentResult, ExperimentStatus } from "../lib/run.ts"
import { parseSecondaryValues } from "../lib/run.ts"
import type { SecondaryMetric } from "../lib/programs.ts"
import { allocateColumnWidths, formatCell, type ColumnSpec } from "../lib/format.ts"
import { colors } from "../lib/theme.ts"

interface ResultsTableProps {
  results: ExperimentResult[]
  metricField: string
  secondaryMetrics?: Record<string, SecondaryMetric>
  width: number
  experimentNumber?: number
  focused?: boolean
  selectedResult?: ExperimentResult | null
  onSelect?: (result: ExperimentResult | null) => void
  onHighlight?: (index: number) => void
}

export function statusColor(status: ExperimentStatus): string {
  switch (status) {
    case "keep": return colors.success
    case "discard": return colors.error
    case "crash": return colors.error
    case "measurement_failure": return colors.warning
    case "verification_baseline": return colors.primary
    case "verification_current": return colors.primary
  }
}

const ResultRow = memo(function ResultRow({ result: r, secondaryFields, highlighted, selected, columnWidths, lineWidth, rowWidth, onMouseDown }: {
  result: ExperimentResult
  secondaryFields: string[]
  highlighted?: boolean
  selected?: boolean
  columnWidths: number[]
  lineWidth: number
  rowWidth: number
  onMouseDown?: () => void
}) {
  const bg = selected ? colors.surfaceActiveSelection : highlighted ? colors.surfaceHighlight : undefined
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

  const line = formatCell(`${fixedCells.join("")}${secondaryCells.join("")}${trailingCells.join("")}`, lineWidth)

  return (
    <box width={rowWidth} height={1} paddingX={1} backgroundColor={bg} flexShrink={0} onMouseDown={onMouseDown}>
      <text width={lineWidth} fg={fg} selectable>
        {line}
      </text>
    </box>
  )
})

// outer border (2) + paddingX (2)
const CHROME_WIDTH = 4
const ROW_CHROME_WIDTH = 2

function labelWidth(label: string, base: number, max: number): number {
  return Math.min(Math.max(base, label.length + 2), max)
}

export function ResultsTable({ results, metricField, secondaryMetrics, width, experimentNumber, focused, selectedResult, onSelect, onHighlight }: ResultsTableProps) {
  const secondaryFields = useMemo(() => secondaryMetrics ? Object.keys(secondaryMetrics) : [], [secondaryMetrics])

  // Skip the baseline row (#0) — it's in the stats header
  const experiments = results.filter(r => r.experiment_number > 0)
  const innerWidth = Math.max(width - CHROME_WIDTH, 0)
  const rowWidth = innerWidth + ROW_CHROME_WIDTH

  const columnSpecs = useMemo(() => {
    const fixedCols: ColumnSpec[] = [
      { ideal: 4, min: 3 }, // #
      { ideal: 10, min: 0 }, // commit collapses first on narrow terminals
      { ideal: labelWidth(metricField, 16, 24), min: 8 },
    ]
    const secondaryCols = secondaryFields.map((field) => ({
      ideal: labelWidth(field, 12, 18),
      min: 8,
    }))
    const statusCol = { ideal: 20, min: 8 }
    const usedBeforeDescription = [...fixedCols, ...secondaryCols, statusCol]
      .reduce((sum, spec) => sum + spec.ideal, 0)
    const trailingCols: ColumnSpec[] = [
      statusCol,
      { ideal: Math.max(innerWidth - usedBeforeDescription, 24), min: 8 },
    ]
    return [...fixedCols, ...secondaryCols, ...trailingCols]
  }, [metricField, secondaryFields, innerWidth])

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
      const row = experiments[highlightIndex]
      onSelect?.(selectedResult?.experiment_number === row.experiment_number ? null : row)
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
  const headerLine = formatCell(headerCells.join(""), innerWidth)

  return (
    <box flexDirection="column" flexGrow={1} width="100%" minHeight={0} minWidth={0}>
      <box width={rowWidth} height={1} paddingX={1} flexShrink={0}>
        <text width={innerWidth} fg={colors.text}>
          {headerLine}
        </text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} stickyScroll={!focused} stickyStart="bottom">
        {experiments.length === 0 ? (
          <box width={rowWidth} height={1} paddingX={1} flexShrink={0}>
            <text width={innerWidth} fg={colors.text}>
              {formatCell(experimentNumber != null && experimentNumber > 0
                ? `Running experiment #${experimentNumber}...`
                : "Running baseline measurement...", innerWidth)}
            </text>
          </box>
        ) : (
          experiments.map((r, i) => (
            <ResultRow
              key={r.experiment_number}
              result={r}
              secondaryFields={secondaryFields}
              columnWidths={columnWidths}
              lineWidth={innerWidth}
              rowWidth={rowWidth}
              highlighted={focused && i === safeHighlight}
              selected={selectedResult?.experiment_number === r.experiment_number}
              onMouseDown={(onHighlight || onSelect) ? () => {
                setHighlightIndex(i)
                onHighlight?.(i)
                onSelect?.(selectedResult?.experiment_number === r.experiment_number ? null : r)
              } : undefined}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}
