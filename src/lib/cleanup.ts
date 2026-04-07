import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ModelSlot } from "./config.ts"
import type { ProgramConfig } from "./programs.ts"
import type { RunState, ExperimentResult } from "./run.ts"
import { readAllResults, getRunStats } from "./run.ts"
import type { ExperimentCost } from "./experiment.ts"
import {
  getFullSha,
  getDiffBetween,
  getRecentLog,
  squashCommits,
  countCommitsBetween,
} from "./git.ts"
import { createEventLogger } from "./events.ts"
import { createPushStream } from "./push-stream.ts"
import { type SDKUserMessage, getTextDelta, getToolStatus, extractCost } from "./sdk-helpers.ts"
import { getCleanupSystemPrompt } from "./system-prompts.ts"

export interface CleanupResult {
  summary: string
  commitMessage: string
  squashedSha: string | null
  cost?: ExperimentCost
}

export interface CleanupCallbacks {
  onStreamText: (text: string) => void
  onToolStatus: (status: string) => void
}

const FALLBACK_COMMIT_MESSAGE = "chore: squash autoauto experiment commits"

export function extractCommitMessage(summary: string): string {
  const match = summary.match(/<commit_message>\s*([\s\S]*?)\s*<\/commit_message>/)
  if (match) {
    const msg = match[1].trim()
    if (msg.length > 0) return msg
  }
  return FALLBACK_COMMIT_MESSAGE
}

const MAX_DIFF_LENGTH = 50_000

export async function buildCleanupPrompt(
  state: RunState,
  results: ExperimentResult[],
  projectRoot: string,
  config: ProgramConfig,
): Promise<string> {
  const [diff, gitLog] = await Promise.all([
    getDiffBetween(projectRoot, state.original_baseline_sha, "HEAD"),
    getRecentLog(projectRoot, 50),
  ])

  const stats = getRunStats(state, config.direction)

  const resultsSummary = results
    .map((r) => `#${r.experiment_number}\t${r.status}\t${r.metric_value}\t${r.description}`)
    .join("\n")

  let diffSection: string
  if (diff.length > MAX_DIFF_LENGTH) {
    diffSection = diff.slice(0, MAX_DIFF_LENGTH) +
      `\n\n... (diff truncated at ${MAX_DIFF_LENGTH} chars — use \`git diff ${state.original_baseline_sha} HEAD\` for the full output)`
  } else {
    diffSection = diff
  }

  return `You are reviewing an AutoAuto experiment run for program "${state.program_slug}".

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

## Git History
\`\`\`
${gitLog}
\`\`\`

## Full Diff (baseline → current)
\`\`\`diff
${diffSection}
\`\`\`

Review these changes and produce your structured summary. Use \`git show <sha>\` to inspect individual experiment commits if needed.`
}

async function runCleanupAgent(
  projectRoot: string,
  systemPrompt: string,
  userPrompt: string,
  modelConfig: ModelSlot,
  callbacks: CleanupCallbacks,
  signal?: AbortSignal,
): Promise<{ summary: string; cost?: ExperimentCost }> {
  const inputStream = createPushStream<SDKUserMessage>()
  const abortController = new AbortController()

  if (signal) {
    if (signal.aborted) {
      return { summary: "" }
    }
    signal.addEventListener("abort", () => abortController.abort(), { once: true })
  }

  inputStream.push({
    type: "user",
    message: { role: "user", content: userPrompt },
    parent_tool_use_id: null,
  })
  inputStream.end()

  let fullText = ""
  let cost: ExperimentCost | undefined

  try {
    const q = query({
      prompt: inputStream,
      options: {
        systemPrompt,
        tools: ["Read", "Bash", "Glob", "Grep"],
        allowedTools: ["Read", "Bash", "Glob", "Grep"],
        maxTurns: 10,
        cwd: projectRoot,
        model: modelConfig.model,
        effort: modelConfig.effort,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        includePartialMessages: true,
        abortController,
      },
    })

    for await (const message of q) {
      if (signal?.aborted) break

      if (message.type === "stream_event") {
        const text = getTextDelta(message)
        if (text) {
          fullText += text
          callbacks.onStreamText(text)
        }

        const tool = getToolStatus(message)
        if (tool) callbacks.onToolStatus(tool)
      } else if (message.type === "result") {
        cost = extractCost(message)
        break
      }
    }
  } catch (err: unknown) {
    if (signal?.aborted) {
      return { summary: fullText, cost }
    }
    throw err
  }

  return { summary: fullText, cost }
}

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

function stripCommitMessageXml(text: string): string {
  return text.replace(/<commit_message>[\s\S]*?<\/commit_message>/g, "").trim()
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
  cost?: ExperimentCost,
): string {
  const stats = getRunStats(state, config.direction)
  const strippedReview = stripCommitMessageXml(agentReview)

  const lines: string[] = []

  lines.push(`# Run Summary: ${state.program_slug}`)
  lines.push("")

  lines.push("## Overview")
  lines.push(`- **Branch:** ${state.branch_name}`)
  lines.push(`- **Started:** ${state.started_at}`)
  lines.push(`- **Duration:** ${formatDuration(state.started_at, state.updated_at)}`)
  lines.push(`- **Baseline SHA:** ${state.original_baseline_sha.slice(0, 10)}`)
  if (cost) {
    lines.push(`- **Total cost:** $${cost.total_cost_usd.toFixed(2)}`)
  }
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

  // Skip baseline row #0 — it's a reference point, not an experiment
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

  if (strippedReview) {
    lines.push("## Agent Review")
    lines.push("")
    lines.push(strippedReview)
    lines.push("")
  }

  lines.push("---")
  lines.push("*Generated by AutoAuto*")

  return lines.join("\n")
}

export async function runCleanup(
  projectRoot: string,
  programSlug: string,
  runDir: string,
  state: RunState,
  config: ProgramConfig,
  modelConfig: ModelSlot,
  callbacks: CleanupCallbacks,
  signal?: AbortSignal,
): Promise<CleanupResult> {
  const eventLogger = createEventLogger(runDir, () => state.experiment_number)
  await eventLogger.logCleanupStart()

  const preAgentSha = await getFullSha(projectRoot)

  const results = await readAllResults(runDir)

  const systemPrompt = getCleanupSystemPrompt()
  const userPrompt = await buildCleanupPrompt(state, results, projectRoot, config)

  const { summary, cost } = await runCleanupAgent(
    projectRoot,
    systemPrompt,
    userPrompt,
    modelConfig,
    callbacks,
    signal,
  )

  if (cost) {
    await eventLogger.logCleanupEnd(cost)
  }

  const postAgentSha = await getFullSha(projectRoot)
  if (postAgentSha !== preAgentSha) {
    throw new Error("Cleanup agent modified the repository. Aborting cleanup.")
  }

  const commitMessage = extractCommitMessage(summary)

  const report = generateSummaryReport(state, results, config, summary, cost)
  await writeFile(join(runDir, "summary.md"), report)

  let squashedSha: string | null = null
  if (state.total_keeps > 0) {
    const commitCount = await countCommitsBetween(
      projectRoot,
      state.original_baseline_sha,
      "HEAD",
    )
    squashedSha = await squashCommits(projectRoot, state.original_baseline_sha, commitMessage)
    await eventLogger.logSquashComplete(squashedSha, commitCount)
  }

  return { summary: report, commitMessage, squashedSha, cost }
}
