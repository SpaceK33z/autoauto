import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ModelSlot } from "./config.ts"
import type { ProgramConfig } from "./programs.ts"
import type { RunState } from "./run.ts"
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
  runDir: string,
  projectRoot: string,
  config: ProgramConfig,
): Promise<string> {
  const [diff, results, gitLog] = await Promise.all([
    getDiffBetween(projectRoot, state.original_baseline_sha, "HEAD"),
    readAllResults(runDir),
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

  const systemPrompt = getCleanupSystemPrompt()
  const userPrompt = await buildCleanupPrompt(state, runDir, projectRoot, config)

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

  await writeFile(join(runDir, "summary.md"), summary)

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

  return { summary, commitMessage, squashedSha, cost }
}
