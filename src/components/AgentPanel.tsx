import { useState, useEffect, useMemo } from "react"
import type { ExperimentResult } from "../lib/run.ts"
import { parseSecondaryValues } from "../lib/run.ts"
import type { SecondaryMetric } from "../lib/programs.ts"
import { parseExperimentNotes, type ExperimentNotes } from "../lib/ideas-backlog.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { statusColor } from "./ResultsTable.tsx"
import { colors } from "../lib/theme.ts"

interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
  selectedResult?: ExperimentResult | null
  phaseLabel?: string | null
  experimentNumber?: number
  secondaryMetrics?: Record<string, SecondaryMetric>
}

function ExperimentDetail({ result, secondaryMetrics }: {
  result: ExperimentResult
  secondaryMetrics?: Record<string, SecondaryMetric>
}) {
  const { quality_gates: gateValues, secondary_metrics: secondaryValues } = parseSecondaryValues(result.secondary_values)
  const gateEntries = Object.entries(gateValues)
  const secondaryEntries = Object.entries(secondaryValues)

  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="column">
        <text selectable><strong fg={colors.text}>Experiment #{result.experiment_number}</strong></text>
        <text fg={colors.textDim}>{"─".repeat(40)}</text>
      </box>

      <box flexDirection="column">
        <text selectable><strong fg={colors.text}>Status:  </strong><strong fg={statusColor(result.status)}>{result.status}</strong></text>
        <text selectable><strong fg={colors.text}>Commit:  </strong><strong fg={colors.text}>{result.commit}</strong></text>
        <text selectable><strong fg={colors.text}>Metric:  </strong><strong fg={colors.text}>{result.metric_value ?? "—"}</strong></text>
      </box>

      {gateEntries.length > 0 && (
        <box flexDirection="column">
          <text><strong fg={colors.text}>Quality Gates:</strong></text>
          {gateEntries.map(([key, val]) => (
            <text key={key} fg={colors.text} selectable>  {key}: {String(val)}</text>
          ))}
        </box>
      )}

      {secondaryEntries.length > 0 && (
        <box flexDirection="column">
          <text><strong fg={colors.text}>Secondary Metrics:</strong></text>
          {secondaryEntries.map(([key, val]) => {
            const dir = secondaryMetrics?.[key]?.direction
            const dirLabel = dir ? ` (${dir} is better)` : ""
            return (
              <text key={key} fg={colors.text} selectable>  {key}: {String(val)}{dirLabel}</text>
            )
          })}
        </box>
      )}

      <box flexDirection="column">
        <text><strong fg={colors.text}>Description:</strong></text>
        <text fg={colors.text} selectable>{result.description}</text>
      </box>
    </box>
  )
}

/** Strip <autoauto_notes> blocks from display text and extract parsed notes if complete. */
function extractNotes(text: string): { cleaned: string; notes: ExperimentNotes | undefined } {
  if (!text.includes("<autoauto_notes>")) return { cleaned: text, notes: undefined }
  const notes = parseExperimentNotes(text)
  let cleaned = text.replace(/<autoauto_notes>[\s\S]*?<\/autoauto_notes>/g, "")
  cleaned = cleaned.replace(/<autoauto_notes>[\s\S]*$/, "")
  return { cleaned, notes }
}

function NotesCard({ notes }: { notes: ExperimentNotes }) {
  const items: Array<{ label: string; value: string; color: string }> = []
  if (notes.hypothesis) items.push({ label: "Tried", value: notes.hypothesis, color: colors.text })
  if (notes.why) items.push({ label: "Result", value: notes.why, color: colors.textMuted })
  if (notes.avoid?.length) items.push({ label: "Avoid", value: notes.avoid.join("; "), color: colors.warning })
  if (notes.next?.length) items.push({ label: "Next", value: notes.next.join("; "), color: colors.info })
  if (items.length === 0) return null

  const labelWidth = 8 // "Result  " — enough for longest label + padding

  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={colors.textDimmer} selectable>{"─── "}Agent Notes{"  "}{"─".repeat(30)}</text>
      {items.map(({ label, value, color }) => (
        <text key={label} selectable>
          <span fg={colors.textDim}>{label.padEnd(labelWidth)}</span>
          <span fg={color}>{value}</span>
        </text>
      ))}
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

export function AgentPanel({ streamingText, toolStatus, isRunning, selectedResult, phaseLabel, experimentNumber, secondaryMetrics }: AgentPanelProps) {
  const { displayText, notes } = useMemo(() => {
    const { cleaned, notes } = extractNotes(streamingText)
    return { displayText: cleaned, notes }
  }, [streamingText])
  const { segments, hasMarkers, lastTextIdx } = useMemo(() => {
    const segs = parseStreamSegments(displayText)
    return {
      segments: segs,
      hasMarkers: segs.some(s => s.type === "event"),
      lastTextIdx: segs.findLastIndex(s => s.type === "text"),
    }
  }, [displayText])

  if (selectedResult) {
    return (
      <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        <scrollbox flexGrow={1} minHeight={0}>
          <ExperimentDetail result={selectedResult} secondaryMetrics={secondaryMetrics} />
        </scrollbox>
        <box paddingX={1}>
          <text fg={colors.textDim}>Esc to return to live view</text>
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
        {!displayText && isRunning && (
          <box paddingX={1} flexDirection="column">
            <WaitingIndicator phaseLabel={phaseLabel} experimentNumber={experimentNumber} toolStatus={toolStatus} />
          </box>
        )}
        {displayText && (
          <box paddingX={1} flexDirection="column">
            {toolStatus && isRunning && !hasMarkers && (
              <text fg={colors.textDim} selectable>{toolStatus}</text>
            )}
            {hasMarkers ? (
              segments.map((segment, i) => {
                if (segment.type === "event") {
                  const ts = formatTimestamp(segment.time)
                  if (segment.status) {
                    return (
                      <text key={i} fg={colors.textDim} selectable>
                        {ts ? <><span fg={colors.textDimmer}>{ts}</span>{"  "}</> : null}{segment.status}
                      </text>
                    )
                  }
                  return ts ? <text key={i} fg={colors.textDimmer} selectable>{ts}</text> : null
                }
                return (
                  <markdown key={i} content={segment.content} syntaxStyle={syntaxStyle} streaming={isRunning && i === lastTextIdx} />
                )
              })
            ) : (
              <markdown content={displayText} syntaxStyle={syntaxStyle} streaming={isRunning} />
            )}
            {notes && <NotesCard notes={notes} />}
          </box>
        )}
      </scrollbox>
    </box>
  )
}

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function WaitingSpinner() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(interval)
  }, [])

  const seconds = Math.floor(tick / 10)
  const timeStr =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
      : `${seconds}s`

  return <span fg={colors.primary}>{SPINNER_CHARS[tick % SPINNER_CHARS.length]} {timeStr}</span>
}

function WaitingIndicator({ phaseLabel, experimentNumber, toolStatus }: { phaseLabel?: string | null; experimentNumber?: number; toolStatus?: string | null }) {
  const expLabel = experimentNumber ? `#${experimentNumber}` : ""

  // Phase-specific status
  if (phaseLabel) {
    const lower = phaseLabel.toLowerCase()
    if (lower.includes("baseline") && !lower.includes("re-baseline")) {
      return (
        <box flexDirection="column">
          <text><WaitingSpinner /> <span fg={colors.text}>Establishing baseline</span></text>
          <text fg={colors.textDim}>  Running measurement to set the starting metric</text>
        </box>
      )
    }
    if (lower.includes("measuring") || lower.includes("re-baseline")) {
      return (
        <box flexDirection="column">
          <text><WaitingSpinner /> <span fg={colors.text}>{phaseLabel}</span></text>
          <text fg={colors.textDim}>  Evaluating experiment {expLabel} via measure.sh</text>
        </box>
      )
    }
    if (lower.includes("reverting")) {
      return (
        <box flexDirection="column">
          <text><WaitingSpinner /> <span fg={colors.warning}>{phaseLabel}</span></text>
          <text fg={colors.textDim}>  Resetting to last known good state</text>
        </box>
      )
    }
    if (lower.includes("kept")) {
      return <text><span fg={colors.text}>{">"}</span> <span fg={colors.success}>{phaseLabel}</span></text>
    }
    if (lower.includes("starting daemon")) {
      return (
        <box flexDirection="column">
          <text><WaitingSpinner /> <span fg={colors.text}>Starting daemon</span></text>
          <text fg={colors.textDim}>  Creating worktree and spawning background process</text>
        </box>
      )
    }
  }

  // Agent running but no text yet — show tool if available, otherwise thinking
  if (toolStatus) {
    return (
      <box flexDirection="column">
        <text><WaitingSpinner /> <span fg={colors.text}>Agent working</span> <span fg={colors.textDim}>{expLabel}</span></text>
        <text fg={colors.textDim}>  {toolStatus}</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text><WaitingSpinner /> <span fg={colors.text}>Agent thinking</span> <span fg={colors.textDim}>{expLabel}</span></text>
      <text fg={colors.textDim}>  Building context and waiting for first response</text>
    </box>
  )
}
