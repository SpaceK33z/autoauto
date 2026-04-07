interface StatsHeaderProps {
  experimentNumber: number
  totalKeeps: number
  totalDiscards: number
  totalCrashes: number
  currentBaseline: number
  originalBaseline: number
  bestMetric: number
  bestExperiment: number
  direction: "lower" | "higher"
  metricField: string
  totalCostUsd: number
  metricHistory: number[]
  currentPhaseLabel: string
}

const BLOCKS = "▁▂▃▄▅▆▇█"

function renderSparkline(values: number[], direction: "lower" | "higher"): string {
  if (values.length === 0) return ""

  // Cap to last 50 values
  const recent = values.length > 50 ? values.slice(-50) : values

  const min = Math.min(...recent)
  const max = Math.max(...recent)

  if (min === max) return BLOCKS[4].repeat(recent.length)

  return recent
    .map((v) => {
      let normalized = (v - min) / (max - min)
      // For "lower" direction, invert so improvements (lower values) render as higher blocks
      if (direction === "lower") normalized = 1 - normalized
      const index = Math.round(normalized * 7)
      return BLOCKS[index]
    })
    .join("")
}

function computeImprovementStr(bestMetric: number, originalBaseline: number): string {
  if (originalBaseline === 0) return ""
  const pct = ((bestMetric - originalBaseline) / Math.abs(originalBaseline)) * 100
  if (pct === 0) return ""
  return ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
}

export function StatsHeader(props: StatsHeaderProps) {
  const improvementStr = computeImprovementStr(props.bestMetric, props.originalBaseline)

  return (
    <box flexDirection="column" border borderStyle="rounded" title={`Experiment #${props.experimentNumber}`}>
      <box flexDirection="column" padding={1}>
        <box flexDirection="row">
          <text fg="#9ece6a"><strong>{props.totalKeeps} kept</strong></text>
          <text>{"  "}</text>
          <text fg="#ff5555">{props.totalDiscards} discarded</text>
          <text>{"  "}</text>
          <text fg="#888888">{props.totalCrashes} crashed</text>
        </box>
        <text>
          Baseline: {props.currentBaseline}  Best: {props.bestMetric}
          {improvementStr}
        </text>
        <text fg="#888888">
          Cost: ${props.totalCostUsd.toFixed(2)}  •  {props.currentPhaseLabel}
        </text>
      </box>
      {props.metricHistory.length > 1 && (
        <box padding={1}>
          <text fg="#7aa2f7">{renderSparkline(props.metricHistory, props.direction)}</text>
        </box>
      )}
    </box>
  )
}
