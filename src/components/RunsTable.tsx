import { memo } from "react"
import type { RunInfo, RunState } from "../lib/run.ts"
import type { ProgramConfig } from "../lib/programs.ts"
import { allocateColumnWidths, formatCell } from "../lib/format.ts"
import { formatModelSlot, type EffortLevel } from "../lib/config.ts"
import { colors } from "../lib/theme.ts"

export interface RunsTableProps {
  runs: RunInfo[]
  /** Map from program_slug → ProgramConfig for computing gains */
  programConfigs: Record<string, ProgramConfig>
  width: number
  focused?: boolean
  selectedIndex?: number
  onSelectIndex?: (index: number) => void
}

function phaseColor(state: RunState | null): string {
  if (!state) return colors.textDim
  if (state.phase === "complete" && state.finalized_at) return colors.info
  switch (state.phase) {
    case "agent_running":
    case "measuring":
    case "baseline":
      return colors.primary
    case "complete":
      return colors.success
    case "crashed":
      return colors.error
    case "stopping":
    case "finalizing":
      return colors.warning
    default:
      return colors.textDim
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
    return { text: "—", color: colors.textDim }
  }

  if (!config) {
    return { text: "—", color: colors.textDim }
  }

  const original = state.original_baseline
  const best = state.best_metric

  if (original === 0) {
    return { text: "—", color: colors.textDim }
  }

  const absDelta = best - original
  const relPct = ((best - original) / Math.abs(original)) * 100

  const isGood = config.direction === "lower" ? absDelta < 0 : absDelta > 0
  const color = isGood ? colors.success : colors.error

  const sign = absDelta >= 0 ? "+" : ""
  const absStr = Math.abs(absDelta) >= 1000
    ? `${sign}${(absDelta / 1000).toFixed(1)}K`
    : `${sign}${Number(absDelta.toFixed(2))}`
  const relStr = `${sign}${relPct.toFixed(1)}%`

  return { text: `${absStr} (${relStr})`, color }
}

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "max"])

function formatModelEffort(state: RunState): string {
  if (!state.model) return "—"
  const provider = state.provider === "opencode" || state.provider === "codex" ? state.provider : "claude"
  const effort: EffortLevel = VALID_EFFORTS.has(state.effort ?? "") ? state.effort as EffortLevel : "high"
  if (provider === "opencode") {
    return formatModelSlot({ provider, model: state.model, effort }, true)
  }
  // Short format: "sonnet/high", "cx/sonnet/high", "opus/max"
  const prefix = provider === "codex" ? "cx/" : ""
  return state.effort ? `${prefix}${state.model}/${state.effort}` : `${prefix}${state.model}`
}



const COL_STATUS = 2    // color dot
const COL_PROGRAM = 30
const COL_EXP = 5       // "##"
const COL_MODEL = 16    // "cx/sonnet/high" or "sonnet/high"
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
  lineWidth,
  rowWidth,
  selected,
  onMouseDown,
}: {
  run: RunInfo
  config: ProgramConfig | undefined
  widths: RunColumnWidths
  lineWidth: number
  rowWidth: number
  selected: boolean
  onMouseDown?: () => void
}) {
  const state = run.state
  if (!state) return null

  const dotColor = phaseColor(state)
  const dotChar = state.finalized_at ? "✓ " : "● "
  const totalExp = state.total_keeps + state.total_discards + state.total_crashes
  const gains = formatGains(state, config)
  const gainsText = state.finalized_branch
    ? `${gains.text} → ${state.finalized_branch}`
    : gains.text
  const gainsColor = state.finalized_at ? colors.info : gains.color
  const slug = state.program_slug

  return (
    <box width={rowWidth} height={1} paddingX={1} backgroundColor={selected ? colors.surfaceSelected : undefined} flexShrink={0} onMouseDown={onMouseDown}>
      <text width={lineWidth} selectable>
        <span fg={dotColor}>{formatCell(dotChar, widths.status)}</span>
        <span fg={colors.text}>{formatCell(slug, widths.program)}</span>
        <span fg={colors.text}>{formatCell(String(totalExp), widths.exp)}</span>
        <span fg={colors.text}>{formatCell(formatModelEffort(state), widths.model)}</span>
        <span fg={colors.text}>{formatCell(formatTokens(state.total_tokens), widths.tokens)}</span>
        <span fg={colors.text}>{formatCell(formatDuration(state.started_at, state.updated_at, state.phase), widths.time)}</span>
        <span fg={gainsColor}>{formatCell(gainsText, widths.gains)}</span>
      </text>
    </box>
  )
})

export function RunsTable({ runs, programConfigs, width, focused = false, selectedIndex = 0, onSelectIndex }: RunsTableProps) {
  const innerWidth = Math.max(width - CHROME, 0)
  const rowWidth = innerWidth + 2
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
    <box flexDirection="column" flexGrow={1} width="100%" minHeight={0} minWidth={0}>
      {/* Header */}
      <box width={rowWidth} height={1} paddingX={1} flexShrink={0}>
        <text width={innerWidth} fg={colors.textDim}>
          {formatCell("", widths.status)}
          {formatCell("program", widths.program)}
          {formatCell("exp", widths.exp)}
          {formatCell("model", widths.model)}
          {formatCell("tokens", widths.tokens)}
          {formatCell("time", widths.time)}
          {formatCell("gains", widths.gains)}
        </text>
      </box>

      <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
        {validRuns.length === 0 ? (
          <box height={1} paddingX={1} flexShrink={0}>
            <text fg={colors.textDim}>No runs yet.</text>
          </box>
        ) : (
          validRuns.map((run, index) => (
            <RunRow
              key={`${run.state!.program_slug}-${run.run_id}`}
              run={run}
              config={programConfigs[run.state!.program_slug]}
              widths={widths}
              lineWidth={innerWidth}
              rowWidth={rowWidth}
              selected={focused && index === selectedIndex}
              onMouseDown={onSelectIndex ? () => onSelectIndex(index) : undefined}
            />
          ))
        )}
      </scrollbox>
    </box>
  )
}
