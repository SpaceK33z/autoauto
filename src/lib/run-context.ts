import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { getLatestRun, readAllResults, getRunStats } from "./run.ts"
import { loadProgramConfig } from "./programs.ts"
import { streamLogName } from "./daemon-callbacks.ts"

const MAX_LOG_LINES = 500

/**
 * Builds the auto-analysis initial message for the update agent.
 * Gathers context from the latest run: summary stats, last experiment log, log paths.
 */
export async function buildUpdateRunContext(programDir: string): Promise<string> {
  const latest = await getLatestRun(programDir)
  if (!latest || !latest.state) {
    return "No previous runs found for this program. Please describe what you'd like to change."
  }

  const { run_dir: runDir, state } = latest

  const [config, results] = await Promise.all([
    loadProgramConfig(programDir).catch(() => null),
    readAllResults(runDir),
  ])

  const direction = config?.direction ?? "lower"
  const stats = getRunStats(state, direction)

  // Build run summary
  const lines: string[] = [
    "Here are the results from the latest run of this program:",
    "",
    "## Run Summary",
    `- Phase: ${state.phase}`,
  ]

  if (state.termination_reason) {
    lines.push(`- Termination reason: ${state.termination_reason}`)
  }

  lines.push(
    `- Experiments: ${stats.total_experiments} total (${stats.total_keeps} kept, ${stats.total_discards} discarded, ${stats.total_crashes} crashed)`,
  )

  if (stats.total_experiments > 0) {
    lines.push(`- Keep rate: ${(stats.keep_rate * 100).toFixed(0)}%`)
    lines.push(
      `- Original baseline: ${state.original_baseline} → Best: ${state.best_metric} (${stats.improvement_pct >= 0 ? "+" : ""}${stats.improvement_pct.toFixed(1)}%)`,
    )
  }

  if (state.error) {
    lines.push(`- Error: ${state.error}`)
  }

  // Last few results from results.tsv
  if (results.length > 0) {
    lines.push("", "## Recent Experiment Results")
    const recent = results.slice(-5)
    for (const r of recent) {
      const tag = r.status === "keep" ? "KEEP" : r.status === "discard" ? "DISCARD" : r.status.toUpperCase()
      lines.push(`- #${r.experiment_number} [${tag}] metric=${r.metric_value} — ${r.description}`)
    }
  }

  // Read last experiment stream log
  const lastExpNum = state.experiment_number
  if (lastExpNum > 0) {
    const logFile = streamLogName(lastExpNum)
    const logPath = join(runDir, logFile)
    try {
      const logContent = await Bun.file(logPath).text()
      const logLines = logContent.split("\n")
      const truncated = logLines.length > MAX_LOG_LINES
      const displayLines = truncated ? logLines.slice(-MAX_LOG_LINES) : logLines
      lines.push(
        "",
        `## Last Experiment (#${lastExpNum}) Stream Log${truncated ? ` (last ${MAX_LOG_LINES} lines)` : ""}`,
        "```",
        displayLines.join("\n"),
        "```",
      )
    } catch {
      // Log file doesn't exist
    }
  }

  // List all available stream logs
  try {
    const entries = await readdir(runDir)
    const logFiles = entries.filter((f) => f.startsWith("stream-") && f.endsWith(".log")).toSorted()
    if (logFiles.length > 0) {
      lines.push(
        "",
        "## Additional Logs",
        "The following log files are available if you need more context (use the Read tool):",
      )
      for (const f of logFiles) {
        lines.push(`- ${join(runDir, f)}`)
      }
    }
  } catch {
    // Can't list directory
  }

  lines.push(
    "",
    "Please analyze these results and suggest what should be fixed or improved in the program configuration.",
  )

  return lines.join("\n")
}
