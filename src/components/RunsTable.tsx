import { memo } from "react"
import type { RunInfo, RunState } from "../lib/run.ts"
import type { ProgramConfig } from "../lib/programs.ts"
import { allocateColumnWidths, formatCell } from "../lib/format.ts"

export interface RunsTableProps {
  runs: RunInfo[]
  /** Map from program_slug → ProgramConfig for computing gains */
  programConfigs: Record<string, ProgramConfig>
  width: number
  focused?: boolean
  selectedIndex?: number
}

function phaseColor(state: RunState | null): string {
  if (!state) return "#565f89"
  switch (state.phase) {
    case "agent_running":
    case "measuring":
    case "baseline":
      return "#7aa2f7" // blue — in progress
    case "complete":
      return "#9ece6a" // green
    case "crashed":
      return "#ff5555" // red
    case "stopping":
    case "finalizing":
      return "#e0af68" // yellow
    default:
      return "#565f89" // dim
  }
}

function formatTokens(n: number | undefined): string {
  if (n == null || n === 0) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function formatDuration(startedAt: string, updatedAt: string, phase: string): string {
  const start = new Date(startedAt).getTime()
  const end = phase === "complete" || phase === "crashed"
    ? new Date(updatedAt).getTime()
    : Date.now()
  const ms = Math.max(0, end - start)
  const totalSec = Math.floor(ms / 1000)
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${seconds}s`
}

function formatGains(
  state: RunState,
  config: ProgramConfig | undefined,
): { text: string; color: string } {
  const hasKeeps = state.total_keeps > 0

  if (!hasKeeps) {
    return { text: "—", color: "#565f89" }
  }

  if (!config) {
    return { text: "—", color: "#565f89" }
  }

  const original = state.original_baseline
  const best = state.best_metric

  if (original === 0) {
    return { text: "—", color: "#565f89" }
  }

  const absDelta = best - original
  const relPct = ((best - original) / Math.abs(original)) * 100

  const isGood = config.direction === "lower" ? absDelta < 0 : absDelta > 0
  const color = isGood ? "#9ece6a" : "#ff5555"

  const sign = absDelta >= 0 ? "+" : ""
  const absStr = Math.abs(absDelta) >= 1000
    ? `${sign}${(absDelta / 1000).toFixed(1)}K`
    : `${sign}${Number(absDelta.toFixed(2))}`
  const relStr = `${sign}${relPct.toFixed(1)}%`

  return { text: `${absStr} (${relStr})`, color }
}

function formatModelEffort(state: RunState): string {
  if (!state.model) return "—"
  return state.effort ? `${state.model}/${state.effort}` : state.model
}



const COL_STATUS = 2    // color dot
const COL_PROGRAM = 30
const COL_EXP = 5       // "##"
const COL_MODEL = 14    // "sonnet/high"
const COL_TOKENS = 7
const COL_TIME = 9
const COL_GAINS_MIN = 16
const CHROME = 4 // border + padding

interface RunColumnWidths {
  status: number
  program: number
  exp: number
  model: number
  tokens: number
  time: number
  gains: number
}

const RunRow = memo(function RunRow({
  run,
  config,
  widths,
  selected,
}: {
  run: RunInfo
  config: ProgramConfig | undefined
  widths: RunColumnWidths
  selected: boolean
}) {
  const state = run.state
  if (!state) return null

  const dotColor = phaseColor(state)
  const totalExp = state.total_keeps + state.total_discards + state.total_crashes
  const gains = formatGains(state, config)
  const slug = state.program_slug

  return (
    <box paddingX={1} backgroundColor={selected ? "#333333" : undefined}>
      <text selectable>
        <span fg={dotColor}>{formatCell("● ", widths.status)}</span>
        <span fg="#c0caf5">{formatCell(slug, widths.program)}</span>
        <span fg="#a9b1d6">{formatCell(String(totalExp), widths.exp)}</span>
        <span fg="#a9b1d6">{formatCell(formatModelEffort(state), widths.model)}</span>
        <span fg="#a9b1d6">{formatCell(formatTokens(state.total_tokens), widths.tokens)}</span>
        <span fg="#a9b1d6">{formatCell(formatDuration(state.started_at, state.updated_at, state.phase), widths.time)}</span>
        <span fg={gains.color}>{formatCell(gains.text, widths.gains)}</span>
      </text>
    </box>
  )
})

export function RunsTable({ runs, programConfigs, width, focused = false, selectedIndex = 0 }: RunsTableProps) {
  const innerWidth = Math.max(width - CHROME, 0)
  const fixedWidth = COL_STATUS + COL_PROGRAM + COL_EXP + COL_MODEL + COL_TOKENS + COL_TIME
  const [statusWidth, programWidth, expWidth, modelWidth, tokensWidth, timeWidth, gainsWidth] = allocateColumnWidths(innerWidth, [
    { ideal: COL_STATUS, min: 0 },
    { ideal: COL_PROGRAM, min: 8 },
    { ideal: COL_EXP, min: 0 },
    { ideal: COL_MODEL, min: 0 },
    { ideal: COL_TOKENS, min: 0 },
    { ideal: COL_TIME, min: 0 },
    { ideal: Math.max(innerWidth - fixedWidth, COL_GAINS_MIN), min: 0 },
  ])
  const widths = {
    status: statusWidth,
    program: programWidth,
    exp: expWidth,
    model: modelWidth,
    tokens: tokensWidth,
    time: timeWidth,
    gains: gainsWidth,
  }

  const validRuns = runs.filter((r) => r.state != null)

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <box paddingX={1}>
        <text fg="#565f89">
          {formatCell("", widths.status)}
          {formatCell("program", widths.program)}
          {formatCell("exp", widths.exp)}
          {formatCell("model", widths.model)}
          {formatCell("tokens", widths.tokens)}
          {formatCell("time", widths.time)}
          {formatCell("gains", widths.gains)}
        </text>
      </box>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {validRuns.length === 0 ? (
          <box paddingX={1}>
            <text fg="#565f89">No runs yet.</text>
          </box>
        ) : (
          validRuns.map((run, index) => (
            <RunRow
              key={`${run.state!.program_slug}-${run.run_id}`}
              run={run}
              config={programConfigs[run.state!.program_slug]}
              widths={widths}
              selected={focused && index === selectedIndex}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}
