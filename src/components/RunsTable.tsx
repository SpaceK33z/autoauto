import { memo } from "react"
import type { RunInfo, RunState } from "../lib/run.ts"
import type { ProgramConfig } from "../lib/programs.ts"
import { padRight, truncate } from "../lib/format.ts"

export interface RunsTableProps {
  runs: RunInfo[]
  /** Map from program_slug → ProgramConfig for computing gains */
  programConfigs: Record<string, ProgramConfig>
  width: number
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
    case "cleaning_up":
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

const RunRow = memo(function RunRow({
  run,
  config,
  gainsWidth,
}: {
  run: RunInfo
  config: ProgramConfig | undefined
  gainsWidth: number
}) {
  const state = run.state
  if (!state) return null

  const dotColor = phaseColor(state)
  const totalExp = state.total_keeps + state.total_discards + state.total_crashes
  const gains = formatGains(state, config)
  const slug = state.program_slug

  return (
    <box paddingX={1}>
      <text>
        <span fg={dotColor}>{"● "}</span>
        <span fg="#c0caf5">{padRight(truncate(slug, COL_PROGRAM - 1), COL_PROGRAM)}</span>
        <span fg="#a9b1d6">{padRight(String(totalExp), COL_EXP)}</span>
        <span fg="#a9b1d6">{padRight(formatModelEffort(state), COL_MODEL)}</span>
        <span fg="#a9b1d6">{padRight(formatTokens(state.total_tokens), COL_TOKENS)}</span>
        <span fg="#a9b1d6">{padRight(formatDuration(state.started_at, state.updated_at, state.phase), COL_TIME)}</span>
        <span fg={gains.color}>{padRight(truncate(gains.text, gainsWidth), gainsWidth)}</span>
      </text>
    </box>
  )
})

export function RunsTable({ runs, programConfigs, width }: RunsTableProps) {
  const innerWidth = Math.max(width - CHROME, 0)
  const fixedWidth = COL_STATUS + COL_PROGRAM + COL_EXP + COL_MODEL + COL_TOKENS + COL_TIME
  const gainsWidth = Math.max(innerWidth - fixedWidth, COL_GAINS_MIN)

  const validRuns = runs.filter((r) => r.state != null)

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <box paddingX={1}>
        <text fg="#565f89">
          {"  "}
          {padRight("program", COL_PROGRAM)}
          {padRight("exp", COL_EXP)}
          {padRight("model", COL_MODEL)}
          {padRight("tokens", COL_TOKENS)}
          {padRight("time", COL_TIME)}
          {padRight("gains", gainsWidth)}
        </text>
      </box>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {validRuns.length === 0 ? (
          <box paddingX={1}>
            <text fg="#565f89">No runs yet.</text>
          </box>
        ) : (
          validRuns.map((run) => (
            <RunRow
              key={`${run.state!.program_slug}-${run.run_id}`}
              run={run}
              config={programConfigs[run.state!.program_slug]}
              gainsWidth={gainsWidth}
            />
          ))
        )}
      </scrollbox>

      {/* TODO: Enter on a run row → resume monitoring / attach to live output */}
    </box>
  )
}
