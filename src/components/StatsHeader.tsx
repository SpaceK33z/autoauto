interface StatsHeaderProps {
  experimentNumber: number
  totalKeeps: number
  totalDiscards: number
  totalCrashes: number
  currentBaseline: number
  originalBaseline: number
  bestMetric: number
  direction: "lower" | "higher"
  metricField: string
  totalCostUsd: number
  metricHistory: number[]
  currentPhaseLabel: string
  improvementPct: number
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

function formatImprovementPct(pct: number): string {
  if (pct === 0) return ""
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`
}

export function StatsHeader(props: StatsHeaderProps) {
  const improvementStr = formatImprovementPct(props.improvementPct)
  const sparkline = renderSparkline(props.metricHistory, props.direction)

  return (
      <box paddingX={1} flexDirection="column">
        <box>
          <text selectable>
            <span fg="#9ece6a"><strong>kept {props.totalKeeps}</strong></span>
            {"    "}
            <span fg="#ff5555">disc {props.totalDiscards}</span>
            {"    "}
            <span fg="#a9b1d6">crash {props.totalCrashes}</span>
            {"    "}
            <span fg="#a9b1d6">$</span>
            <span fg="#c0caf5">{props.totalCostUsd.toFixed(2)}</span>
            {"    "}
            <span fg="#a9b1d6">#{props.experimentNumber}</span>
          </text>
        </box>
        <box>
          <text selectable>
            <span fg="#a9b1d6">baseline </span>
            <span fg="#7aa2f7">{props.currentBaseline}</span>
            {"    "}
            <span fg="#a9b1d6">{"best "}</span>
            <span fg="#9ece6a">{props.bestMetric}</span>
            {improvementStr ? (
              <>
                {"    "}
                <span fg="#e0af68">{improvementStr}</span>
              </>
            ) : null}
            {sparkline ? (
              <>
                {"    "}
                <span fg="#7aa2f7">{sparkline}</span>
              </>
            ) : null}
          </text>
        </box>
        <box>
          <text selectable>
            <span fg="#a9b1d6">{"> "}</span>
            <span fg="#c0caf5">{props.currentPhaseLabel}</span>
          </text>
        </box>
      </box>
  )
}
