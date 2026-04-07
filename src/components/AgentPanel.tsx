import { useMemo } from "react"
import type { ExperimentResult } from "../lib/run.ts"
import type { SecondaryMetric } from "../lib/programs.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { statusColor } from "./ResultsTable.tsx"

interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
  selectedResult?: ExperimentResult | null
  phaseLabel?: string | null
  experimentNumber?: number
  qualityGateFields?: string[]
  secondaryMetrics?: Record<string, SecondaryMetric>
}

function parseJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
}

function ExperimentDetail({ result, qualityGateFields, secondaryMetrics }: {
  result: ExperimentResult
  qualityGateFields?: string[]
  secondaryMetrics?: Record<string, SecondaryMetric>
}) {
  const allValues = parseJson(result.secondary_values)
  const gateFields = new Set(qualityGateFields ?? [])
  const secondaryFields = new Set(secondaryMetrics ? Object.keys(secondaryMetrics) : [])

  // Split values into quality gates vs secondary metrics vs unknown
  const gateEntries: [string, unknown][] = []
  const secondaryEntries: [string, unknown][] = []
  if (allValues) {
    for (const [key, val] of Object.entries(allValues)) {
      if (gateFields.has(key)) {
        gateEntries.push([key, val])
      } else if (secondaryFields.has(key)) {
        secondaryEntries.push([key, val])
      } else {
        // Unknown field — show under quality gates for backward compat
        gateEntries.push([key, val])
      }
    }
  }

  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="column">
        <text selectable><strong fg="#a9b1d6">Experiment #{result.experiment_number}</strong></text>
        <text fg="#565f89">{"─".repeat(40)}</text>
      </box>

      <box flexDirection="column">
        <text selectable><strong fg="#a9b1d6">Status:  </strong><strong fg={statusColor(result.status)}>{result.status}</strong></text>
        <text selectable><strong fg="#a9b1d6">Commit:  </strong><strong fg="#c0caf5">{result.commit}</strong></text>
        <text selectable><strong fg="#a9b1d6">Metric:  </strong><strong fg="#c0caf5">{result.metric_value ?? "—"}</strong></text>
      </box>

      {gateEntries.length > 0 && (
        <box flexDirection="column">
          <text><strong fg="#a9b1d6">Quality Gates:</strong></text>
          {gateEntries.map(([key, val]) => (
            <text key={key} fg="#c0caf5" selectable>  {key}: {String(val)}</text>
          ))}
        </box>
      )}

      {secondaryEntries.length > 0 && (
        <box flexDirection="column">
          <text><strong fg="#a9b1d6">Secondary Metrics:</strong></text>
          {secondaryEntries.map(([key, val]) => {
            const dir = secondaryMetrics?.[key]?.direction
            const dirLabel = dir ? ` (${dir} is better)` : ""
            return (
              <text key={key} fg="#c0caf5" selectable>  {key}: {String(val)}{dirLabel}</text>
            )
          })}
        </box>
      )}

      <box flexDirection="column">
        <text><strong fg="#a9b1d6">Description:</strong></text>
        <text fg="#c0caf5" selectable>{result.description}</text>
      </box>
    </box>
  )
}

type StreamSegment =
  | { type: "text"; content: string }
  | { type: "event"; time: number; status?: string }

function parseStreamSegments(text: string): StreamSegment[] {
  const segments: StreamSegment[] = []
  const lines = text.split("\n")
  let textLines: string[] = []

  function flushText() {
    if (textLines.length > 0) {
      const content = textLines.join("\n")
      if (content.trim()) {
        segments.push({ type: "text", content })
      }
      textLines = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const timeMatch = lines[i].match(/^\[time:(\d+)\]$/)

    if (timeMatch) {
      flushText()
      const epoch = Number(timeMatch[1])
      // Merge with following tool marker if present
      const nextToolMatch = lines[i + 1]?.match(/^\[tool\] (.+)$/)
      if (nextToolMatch) {
        segments.push({ type: "event", time: epoch, status: nextToolMatch[1] })
        i++
      } else {
        segments.push({ type: "event", time: epoch })
      }
    } else if (lines[i].startsWith("[tool] ")) {
      flushText()
      segments.push({ type: "event", time: 0, status: lines[i].slice(7) })
    } else {
      textLines.push(lines[i])
    }
  }

  flushText()
  return segments
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function formatTimestamp(epoch: number): string {
  if (epoch === 0) return ""
  const date = new Date(epoch)
  const now = new Date()
  const isToday = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const time = `${hours}:${minutes}`

  if (isToday) return time
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()} ${time}`
}

export function AgentPanel({ streamingText, toolStatus, isRunning, selectedResult, phaseLabel, experimentNumber, qualityGateFields, secondaryMetrics }: AgentPanelProps) {
  const { segments, hasMarkers, lastTextIdx } = useMemo(() => {
    const segs = parseStreamSegments(streamingText)
    return {
      segments: segs,
      hasMarkers: segs.some(s => s.type === "event"),
      lastTextIdx: segs.findLastIndex(s => s.type === "text"),
    }
  }, [streamingText])

  if (selectedResult) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <scrollbox flexGrow={1}>
          <ExperimentDetail result={selectedResult} qualityGateFields={qualityGateFields} secondaryMetrics={secondaryMetrics} />
        </scrollbox>
        <box paddingX={1}>
          <text fg="#565f89">Esc to return to live view</text>
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {!streamingText && isRunning && (
          <box paddingX={1} flexDirection="column">
            <WaitingIndicator phaseLabel={phaseLabel} experimentNumber={experimentNumber} toolStatus={toolStatus} />
          </box>
        )}
        {streamingText && (
          <box paddingX={1} flexDirection="column">
            {toolStatus && isRunning && !hasMarkers && (
              <text fg="#565f89" selectable>{toolStatus}</text>
            )}
            {hasMarkers ? (
              segments.map((segment, i) => {
                if (segment.type === "event") {
                  const ts = formatTimestamp(segment.time)
                  if (segment.status) {
                    return (
                      <text key={i} fg="#565f89" selectable>
                        {ts ? <><span fg="#444b6a">{ts}</span>{"  "}</> : null}{segment.status}
                      </text>
                    )
                  }
                  return ts ? <text key={i} fg="#444b6a" selectable>{ts}</text> : null
                }
                return (
                  <markdown key={i} content={segment.content} syntaxStyle={syntaxStyle} streaming={isRunning && i === lastTextIdx} />
                )
              })
            ) : (
              <markdown content={streamingText} syntaxStyle={syntaxStyle} streaming={isRunning} />
            )}
          </box>
        )}
      </scrollbox>
    </box>
  )
}

function WaitingIndicator({ phaseLabel, experimentNumber, toolStatus }: { phaseLabel?: string | null; experimentNumber?: number; toolStatus?: string | null }) {
  const expLabel = experimentNumber ? `#${experimentNumber}` : ""

  // Phase-specific status
  if (phaseLabel) {
    const lower = phaseLabel.toLowerCase()
    if (lower.includes("baseline") && !lower.includes("re-baseline")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Establishing baseline</span></text>
          <text fg="#565f89">  Running measurement to set the starting metric</text>
        </box>
      )
    }
    if (lower.includes("measuring") || lower.includes("re-baseline")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">{phaseLabel}</span></text>
          <text fg="#565f89">  Evaluating experiment {expLabel} via measure.sh</text>
        </box>
      )
    }
    if (lower.includes("reverting")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#e0af68">{phaseLabel}</span></text>
          <text fg="#565f89">  Resetting to last known good state</text>
        </box>
      )
    }
    if (lower.includes("kept")) {
      return <text><span fg="#a9b1d6">{">"}</span> <span fg="#9ece6a">{phaseLabel}</span></text>
    }
    if (lower.includes("starting daemon")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Starting daemon</span></text>
          <text fg="#565f89">  Creating worktree and spawning background process</text>
        </box>
      )
    }
  }

  // Agent running but no text yet — show tool if available, otherwise thinking
  if (toolStatus) {
    return (
      <box flexDirection="column">
        <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Agent working</span> <span fg="#565f89">{expLabel}</span></text>
        <text fg="#565f89">  {toolStatus}</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Agent thinking</span> <span fg="#565f89">{expLabel}</span></text>
      <text fg="#565f89">  Building context and waiting for first response</text>
    </box>
  )
}
