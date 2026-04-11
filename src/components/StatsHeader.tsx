import { useState, useEffect } from "react"
import { colors } from "../lib/theme.ts"
import type { QuotaInfo } from "../lib/agent/types.ts"
import { formatResetsIn } from "../lib/format.ts"

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
  maxCostUsd?: number
  metricHistory: number[]
  currentPhaseLabel: string
  improvementPct: number
  isRunning?: boolean
  quotaInfo?: QuotaInfo
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

function getQuotaDisplay(info: QuotaInfo | undefined): { text: string; color: string } | null {
  if (!info) return null

  const resetStr = info.resetsAt ? ` resets ${formatResetsIn(info.resetsAt)}` : ""

  if (info.status === "rejected") {
    return { text: `Quota: EXHAUSTED${resetStr}`, color: colors.error }
  }
  if (info.status === "allowed_warning") {
    const pct = info.utilization != null ? `${Math.round(info.utilization * 100)}%` : "high"
    return { text: `Quota: ${pct}${resetStr}`, color: colors.warning }
  }
  // allowed — only show if utilization data is available
  if (info.utilization != null) {
    return { text: `Quota: ${Math.round(info.utilization * 100)}%${resetStr}`, color: colors.textDim }
  }
  return null
}

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function Spinner() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(interval)
  }, [])

  return <span fg={colors.primary}>{SPINNER_CHARS[tick % SPINNER_CHARS.length]}</span>
}

export function StatsHeader({ isRunning = false, ...props }: StatsHeaderProps) {
  const improvementStr = formatImprovementPct(props.improvementPct)
  const sparkline = renderSparkline(props.metricHistory, props.direction)
  const quotaDisplay = getQuotaDisplay(props.quotaInfo)
  const contentWidth = Math.max(props.width - 4, 0)
  const quotaWidth = quotaDisplay ? quotaDisplay.text.length + 4 : 0
  const modelWidth = Math.min(props.modelLabel.length, Math.max(Math.floor(contentWidth * 0.35), 0))
  const separatorWidth = modelWidth > 0 && contentWidth > modelWidth ? 1 : 0
  const statsWidth = Math.max(contentWidth - modelWidth - separatorWidth - quotaWidth, 0)
  const costDisplay = props.maxCostUsd != null
    ? `$${props.totalCostUsd.toFixed(2)}/$${props.maxCostUsd.toFixed(2)}`
    : `$${props.totalCostUsd.toFixed(2)}`

  return (
      <box paddingX={1} flexDirection="column" flexShrink={0}>
        <box width={contentWidth} height={1} flexDirection="row" flexShrink={0}>
          <text width={statsWidth} selectable>
            <span fg={colors.success}><strong>kept {props.totalKeeps}</strong></span>
            {"    "}
            <span fg={colors.error}>disc {props.totalDiscards}</span>
            {"    "}
            <span fg={colors.text}>crash {props.totalCrashes}</span>
            {"    "}
            <span fg={colors.text}>{costDisplay}</span>
            {"    "}
            <span fg={colors.text}>#{props.experimentNumber}/{props.maxExperiments}</span>
          </text>
          {separatorWidth > 0 && <box width={separatorWidth} />}
          <text width={modelWidth} fg={colors.textDim} selectable>{props.modelLabel}</text>
          {quotaDisplay && (
            <text selectable>{"    "}<span fg={quotaDisplay.color}>{quotaDisplay.text}</span></text>
          )}
        </box>
        <box width={contentWidth} height={1} flexShrink={0}>
          <text width={contentWidth} selectable>
            <span fg={colors.text}>baseline </span>
            <span fg={colors.primary}>{props.currentBaseline}</span>
            {"    "}
            <span fg={colors.text}>{"best "}</span>
            <span fg={colors.success}>{props.bestMetric}</span>
            {improvementStr ? (
              <>
                {"    "}
                <span fg={colors.warning}>{improvementStr}</span>
              </>
            ) : null}
            {sparkline ? (
              <>
                {"    "}
                <span fg={colors.primary}>{sparkline}</span>
              </>
            ) : null}
          </text>
        </box>
        <box width={contentWidth} height={1} flexShrink={0}>
          <text width={contentWidth} selectable>
            {isRunning ? <Spinner /> : <span fg={colors.text}>{">"}</span>}
            <span fg={colors.text}>{" "}{props.currentPhaseLabel}</span>
          </text>
        </box>
      </box>
  )
}
