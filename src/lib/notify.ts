import { $ } from "bun"
import type { RunState } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"

type QuoteContext = "unquoted" | "single" | "double"

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function escapeTemplateValue(value: string, context: QuoteContext): string {
  if (context === "single") return value.replaceAll("'", "'\\''")
  if (context === "double") return value.replaceAll(/["\\$`]/g, "\\$&")
  return shellQuote(value)
}

export function interpolateTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = ""
  let context: QuoteContext = "unquoted"

  for (let i = 0; i < template.length; i++) {
    const char = template[i]

    if (char === "\\" && context !== "single") {
      result += char
      if (i + 1 < template.length) result += template[++i]
      continue
    }

    if (char === "'" && context !== "double") {
      context = context === "single" ? "unquoted" : "single"
      result += char
      continue
    }

    if (char === '"' && context !== "single") {
      context = context === "double" ? "unquoted" : "double"
      result += char
      continue
    }

    if (char === "{" && template[i + 1] === "{") {
      const end = template.indexOf("}}", i + 2)
      if (end !== -1) {
        const key = template.slice(i + 2, end).trim()
        if (/^\w+$/.test(key)) {
          result += escapeTemplateValue(vars[key] ?? "", context)
          i = end + 1
          continue
        }
      }
    }

    result += char
  }

  return result
}

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function computeImprovementPct(state: RunState, direction: ProgramConfig["direction"]): string {
  if (state.original_baseline === 0) return "N/A"
  const pct = direction === "lower"
    ? ((state.original_baseline - state.best_metric) / Math.abs(state.original_baseline)) * 100
    : ((state.best_metric - state.original_baseline) / Math.abs(state.original_baseline)) * 100
  const sign = pct > 0 ? "+" : ""
  return `${sign}${pct.toFixed(1)}%`
}

function getStatusLabel(state: RunState): string {
  if (state.phase === "crashed") return "crashed"
  if (state.termination_reason === "stagnation") return "stagnation"
  if (state.termination_reason === "aborted") return "aborted"
  if (state.termination_reason === "stopped") return "stopped"
  if (state.termination_reason === "max_experiments") return "complete"
  return state.phase
}

export function buildNotificationVars(
  state: RunState,
  direction: ProgramConfig["direction"] = "higher",
): Record<string, string> {
  const total = state.total_keeps + state.total_discards + state.total_crashes
  return {
    program: state.program_slug,
    run_id: state.run_id,
    status: getStatusLabel(state),
    experiments: String(total),
    keeps: String(state.total_keeps),
    best_metric: String(state.best_metric),
    improvement_pct: computeImprovementPct(state, direction),
    duration: formatDuration(state.started_at),
  }
}

/**
 * Executes the user's notification shell command with template variables
 * interpolated from run state. Failures log to stderr and return false.
 */
export async function sendNotification(
  command: string,
  state: RunState,
  direction: ProgramConfig["direction"] = "higher",
): Promise<boolean> {
  const vars = buildNotificationVars(state, direction)
  const interpolated = interpolateTemplate(command, vars)
  try {
    const result = await $`sh -c ${interpolated}`.quiet().nothrow()
    if (result.exitCode === 0) return true
    const stderr = result.stderr.toString().trim()
    process.stderr.write(
      `[notify] Command failed (${result.exitCode})${stderr ? `: ${stderr}` : ""}\n`,
    )
  } catch (err) {
    process.stderr.write(`[notify] Failed to send notification: ${err}\n`)
  }
  return false
}
