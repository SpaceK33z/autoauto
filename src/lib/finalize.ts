import { join } from "node:path"
import type { ProgramConfig } from "./programs.ts"
import type { RunState, ExperimentResult, RunStats } from "./run.ts"
import { readAllResults, getRunStats } from "./run.ts"
import {
  getDiffBetween,
  getRecentLog,
  getFilesChangedBetween,
} from "./git.ts"

// --- Types ---

export interface FinalizeContext {
  programSlug: string
  branchName: string
  originalBranch?: string
  originalBaselineSha: string
  results: ExperimentResult[]
  stats: RunStats
  state: RunState
  changedFiles: string[]
  riskAssessmentEnabled: boolean
  cwd: string
}

export interface FinalizeResult {
  summary: string
  branch?: string
}

// --- Context Building ---

const MAX_DIFF_LENGTH = 50_000

export async function buildFinalizeContext(
  cwd: string,
  runDir: string,
  state: RunState,
  config: ProgramConfig,
): Promise<FinalizeContext> {
  const [results, changedFiles] = await Promise.all([
    readAllResults(runDir),
    getFilesChangedBetween(cwd, state.original_baseline_sha, "HEAD"),
  ])
  const stats = getRunStats(state, config.direction)

  return {
    programSlug: state.program_slug,
    branchName: state.branch_name,
    originalBranch: state.original_branch,
    originalBaselineSha: state.original_baseline_sha,
    results,
    stats,
    state,
    changedFiles,
    riskAssessmentEnabled: config.finalize_risk_assessment !== false,
    cwd,
  }
}

export async function buildFinalizeInitialMessage(context: FinalizeContext): Promise<string> {
  const { state, results, stats, changedFiles, cwd } = context

  const [diff, gitLog] = await Promise.all([
    getDiffBetween(cwd, state.original_baseline_sha, "HEAD"),
    getRecentLog(cwd, 50),
  ])

  const resultsSummary = results
    .map((r) => `#${r.experiment_number}\t${r.commit.slice(0, 7)}\t${r.metric_value}\t${r.status}\t${r.description}`)
    .join("\n")

  let diffSection: string
  if (diff.length > MAX_DIFF_LENGTH) {
    diffSection = diff.slice(0, MAX_DIFF_LENGTH) +
      `\n\n... (diff truncated at ${MAX_DIFF_LENGTH} chars — use \`git diff ${state.original_baseline_sha} HEAD\` for the full output)`
  } else {
    diffSection = diff
  }

  return `Review this AutoAuto experiment run for program "${state.program_slug}".

## Run Statistics
- Total experiments: ${stats.total_experiments} (${stats.total_keeps} kept, ${stats.total_discards} discarded, ${stats.total_crashes} crashed)
- Original baseline: ${state.original_baseline}
- Current metric: ${state.current_baseline}
- Best metric: ${state.best_metric} (experiment #${state.best_experiment})
- Improvement: ${stats.improvement_pct.toFixed(1)}%
- Branch: ${state.branch_name}
- Baseline SHA: ${state.original_baseline_sha.slice(0, 10)}

## Experiment Results
\`\`\`
${resultsSummary}
\`\`\`

## Changed Files
\`\`\`
${changedFiles.join("\n")}
\`\`\`

## Git History
\`\`\`
${gitLog}
\`\`\`

## Full Diff (baseline → current)
\`\`\`diff
${diffSection}
\`\`\`

Please start the finalize review.`
}

// --- Completion Marker Detection ---

/**
 * Extracts the branch name from a <finalize_done branch="..." /> marker.
 * Only matches near the end of the message (last 500 chars) to avoid
 * false positives from code blocks or discussion of the marker.
 */
export function extractFinalizeDone(text: string): string | null {
  const tail = text.slice(-500)
  const match = tail.match(/<finalize_done\s+branch="([^"]+)"\s*\/>\s*$/)
  return match ? match[1] : null
}

// --- Report Generation ---

function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function computeChangePct(baseline: number, value: number, direction: "lower" | "higher"): string {
  if (baseline === 0) return "N/A"
  const pct = ((value - baseline) / Math.abs(baseline)) * 100
  const sign = pct > 0 ? "+" : ""
  const label = (direction === "higher" ? pct > 0 : pct < 0) ? "improved" : "regressed"
  return `${sign}${pct.toFixed(1)}% (${label})`
}

export function generateSummaryReport(
  state: RunState,
  results: ExperimentResult[],
  config: ProgramConfig,
  agentReview: string,
): string {
  const stats = getRunStats(state, config.direction)

  const lines: string[] = []

  lines.push(`# Run Summary: ${state.program_slug}`)
  lines.push("")

  lines.push("## Overview")
  lines.push(`- **Branch:** ${state.branch_name}`)
  lines.push(`- **Started:** ${state.started_at}`)
  lines.push(`- **Duration:** ${formatDuration(state.started_at, state.updated_at)}`)
  lines.push(`- **Baseline SHA:** ${state.original_baseline_sha.slice(0, 10)}`)
  lines.push("")

  const improvementSign = stats.improvement_pct > 0 ? "+" : ""
  lines.push("## Statistics")
  lines.push("")
  lines.push("| Metric | Value |")
  lines.push("|--------|-------|")
  lines.push(`| Total experiments | ${stats.total_experiments} |`)
  lines.push(`| Kept | ${stats.total_keeps} |`)
  lines.push(`| Discarded | ${stats.total_discards} |`)
  lines.push(`| Crashed | ${stats.total_crashes} |`)
  lines.push(`| Keep rate | ${(stats.keep_rate * 100).toFixed(0)}% |`)
  lines.push(`| Original baseline | ${state.original_baseline} |`)
  lines.push(`| Best metric | ${state.best_metric} (${improvementSign}${stats.improvement_pct.toFixed(1)}%) |`)
  lines.push("")

  // Skip baseline row #0
  const experiments = results.filter((r) => r.experiment_number > 0)
  if (experiments.length > 0) {
    lines.push("## Metric Timeline")
    lines.push("")
    lines.push("| # | Commit | Metric | Status | Description |")
    lines.push("|---|--------|--------|--------|-------------|")
    for (const r of experiments) {
      const metric = r.metric_value != null ? String(r.metric_value) : "-"
      const desc = r.description.length > 60 ? `${r.description.slice(0, 57)}...` : r.description
      lines.push(`| ${r.experiment_number} | ${r.commit.slice(0, 7)} | ${metric} | ${r.status} | ${desc} |`)
    }
    lines.push("")
  }

  const kept = experiments.filter((r) => r.status === "keep")
  if (kept.length > 0) {
    lines.push("## Kept Changes")
    lines.push("")
    for (const r of kept) {
      lines.push(`### Experiment #${r.experiment_number}: ${r.description}`)
      lines.push(`- **Commit:** ${r.commit}`)
      lines.push(`- **Metric:** ${r.metric_value} (${computeChangePct(state.original_baseline, r.metric_value, config.direction)})`)
      lines.push("")
    }
  }

  // Verification results
  const verificationRows = results.filter(
    r => r.status === "verification_baseline" || r.status === "verification_current",
  )
  if (verificationRows.length > 0) {
    lines.push("## Verification")
    lines.push("")
    lines.push("| Target | Verified Metric | Original Metric | Duration |")
    lines.push("|--------|----------------|-----------------|----------|")
    for (const r of verificationRows) {
      const target = r.status === "verification_baseline" ? "Baseline" : "Current"
      const original = r.status === "verification_baseline" ? state.original_baseline : state.current_baseline
      const durationSec = (r.measurement_duration_ms / 1000).toFixed(1)
      lines.push(`| ${target} | ${r.metric_value} | ${original} | ${durationSec}s |`)
    }
    lines.push("")
  }

  if (agentReview) {
    lines.push("## Agent Review")
    lines.push("")
    lines.push(agentReview)
    lines.push("")
  }

  lines.push("---")
  lines.push("*Generated by AutoAuto*")

  return lines.join("\n")
}

// --- Report Persistence ---

export async function saveFinalizeReport(runDir: string, summary: string): Promise<void> {
  await Bun.write(join(runDir, "summary.md"), summary)
}
