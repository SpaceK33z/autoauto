import { useState, useEffect } from "react"

interface StatsHeaderProps {
  experimentNumber: number
  maxExperiments: number
  width: number
  modelLabel: string
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
  isRunning?: boolean
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

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function Spinner() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(interval)
  }, [])

  return <span fg="#7aa2f7">{SPINNER_CHARS[tick % SPINNER_CHARS.length]}</span>
}

export function StatsHeader({ isRunning = false, ...props }: StatsHeaderProps) {
  const improvementStr = formatImprovementPct(props.improvementPct)
  const sparkline = renderSparkline(props.metricHistory, props.direction)
  const contentWidth = Math.max(props.width - 4, 0)

  return (
      <box paddingX={1} flexDirection="column">
        <box width={contentWidth} flexDirection="row" justifyContent="space-between">
          <text selectable>
            <span fg="#9ece6a"><strong>kept {props.totalKeeps}</strong></span>
            {"    "}
            <span fg="#ff5555">disc {props.totalDiscards}</span>
            {"    "}
            <span fg="#ffffff">crash {props.totalCrashes}</span>
            {"    "}
            <span fg="#ffffff">$</span>
            <span fg="#ffffff">{props.totalCostUsd.toFixed(2)}</span>
            {"    "}
            <span fg="#ffffff">#{props.experimentNumber}/{props.maxExperiments}</span>
          </text>
          <text fg="#666666" selectable>{props.modelLabel}</text>
        </box>
        <box>
          <text selectable>
            <span fg="#ffffff">baseline </span>
            <span fg="#7aa2f7">{props.currentBaseline}</span>
            {"    "}
            <span fg="#ffffff">{"best "}</span>
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
            {isRunning ? <Spinner /> : <span fg="#ffffff">{">"}</span>}
            <span fg="#ffffff">{" "}{props.currentPhaseLabel}</span>
          </text>
        </box>
      </box>
  )
}
