import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { RunState } from "./run.ts"
import type { ModelSlot } from "./config.ts"
import { formatRecentResults, parseLastResult, parseDiscardedShas } from "./run.ts"
import {
  getFullSha,
  getRecentLog,
  getLatestCommitMessage,
  getFilesChangedBetween,
  getDiscardedDiffs,
} from "./git.ts"
import { createPushStream } from "./push-stream.ts"
import { type SDKUserMessage, getTextDelta, getToolStatus, extractCost } from "./sdk-helpers.ts"

// --- Types ---

/** Everything the experiment agent needs to know */
export interface ContextPacket {
  iteration: number
  baseline_metric: number
  original_baseline: number
  best_metric: number
  best_experiment: number
  total_keeps: number
  total_discards: number
  metric_field: string
  direction: "lower" | "higher"
  program_md: string
  recent_results: string
  recent_git_log: string
  last_outcome: string
  discarded_diffs: string
}

/** Cost and usage data from the SDK result message */
export interface ExperimentCost {
  total_cost_usd: number
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  input_tokens: number
  output_tokens: number
}

/** Result of running one experiment agent session */
export type ExperimentOutcome =
  | { type: "committed"; sha: string; description: string; files_changed: string[]; cost?: ExperimentCost }
  | { type: "no_commit"; cost?: ExperimentCost }
  | { type: "agent_error"; error: string; cost?: ExperimentCost }

/** Result of checking whether locked files were modified */
export interface LockViolation {
  violated: boolean
  files: string[]
}

// --- Context Packet ---

/** Assembles the context packet from disk for a single iteration. */
export async function buildContextPacket(
  projectRoot: string,
  programDir: string,
  runDir: string,
  state: RunState,
  config: { metric_field: string; direction: "lower" | "higher" },
): Promise<ContextPacket> {
  const [programMd, resultsRaw, recentGitLog] = await Promise.all([
    readFile(join(programDir, "program.md"), "utf-8"),
    readFile(join(runDir, "results.tsv"), "utf-8"),
    getRecentLog(projectRoot, 15),
  ])

  const recentResults = formatRecentResults(resultsRaw, 15)

  // Build last_outcome from last results.tsv row
  const lastResult = parseLastResult(resultsRaw)
  let lastOutcome = "none yet"
  if (lastResult) {
    switch (lastResult.status) {
      case "keep":
        lastOutcome = `kept: improved to ${lastResult.metric_value} (${lastResult.description})`
        break
      case "discard":
        lastOutcome = `discarded: ${lastResult.metric_value} (${lastResult.description})`
        break
      case "crash":
        lastOutcome = `crashed: ${lastResult.description}`
        break
      case "measurement_failure":
        lastOutcome = `measurement failed: ${lastResult.description}`
        break
    }
  }

  // Build discarded diffs from recent discarded commits
  const discardedShas = parseDiscardedShas(resultsRaw, 5)
  let discardedDiffs = ""
  if (discardedShas.length > 0) {
    try {
      discardedDiffs = await getDiscardedDiffs(projectRoot, discardedShas, 2000)
    } catch {
      // Discarded commits may have been reverted — diffs unavailable
      discardedDiffs = ""
    }
  }

  return {
    iteration: state.experiment_number,
    baseline_metric: state.current_baseline,
    original_baseline: state.original_baseline,
    best_metric: state.best_metric,
    best_experiment: state.best_experiment,
    total_keeps: state.total_keeps,
    total_discards: state.total_discards,
    metric_field: config.metric_field,
    direction: config.direction,
    program_md: programMd,
    recent_results: recentResults,
    recent_git_log: recentGitLog,
    last_outcome: lastOutcome,
    discarded_diffs: discardedDiffs,
  }
}

/** Formats the context packet as the user message string for the agent. */
export function buildExperimentPrompt(packet: ContextPacket): string {
  return `You are iteration ${packet.iteration} of an autoresearch experiment loop.

## Current State
- Baseline ${packet.metric_field}: ${packet.baseline_metric} (${packet.direction} is better)
- Original baseline: ${packet.original_baseline}
- Best achieved: ${packet.best_metric} (experiment #${packet.best_experiment})
- Total: ${packet.total_keeps} keeps, ${packet.total_discards} discards

## Last Outcome
${packet.last_outcome}

## Recent Results
\`\`\`
${packet.recent_results}
\`\`\`

## Recent Git History
\`\`\`
${packet.recent_git_log}
\`\`\`

## Recently Discarded Experiments
${packet.discarded_diffs || "(none yet)"}

Discarded experiments remain in git history. Inspect them with \`git show <sha>\` if needed.
Implement ONE change, validate, and commit. Then stop.`
}

// --- Lock Violation Detection ---

/** Checks if any changed files are in the locked .autoauto/ directory. */
export function checkLockViolation(filesChanged: string[]): LockViolation {
  const violated = filesChanged.filter((f) => f.startsWith(".autoauto/"))
  return {
    violated: violated.length > 0,
    files: violated,
  }
}

// --- Experiment Agent ---

/**
 * Spawns a fresh Claude Agent SDK session for one experiment iteration.
 * One-shot: push one user message, iterate to result, return outcome.
 */
export async function runExperimentAgent(
  projectRoot: string,
  systemPrompt: string,
  userPrompt: string,
  modelConfig: ModelSlot,
  startSha: string,
  onStreamText?: (text: string) => void,
  onToolStatus?: (status: string) => void,
  signal?: AbortSignal,
): Promise<ExperimentOutcome> {
  const inputStream = createPushStream<SDKUserMessage>()
  const abortController = new AbortController()

  // Link external signal to our abort controller
  if (signal) {
    if (signal.aborted) {
      return { type: "agent_error", error: "aborted before start" }
    }
    signal.addEventListener("abort", () => abortController.abort(), { once: true })
  }

  // Push the single user message and end the stream (one-shot)
  inputStream.push({
    type: "user",
    message: { role: "user", content: userPrompt },
    parent_tool_use_id: null,
  })
  inputStream.end()

  let cost: ExperimentCost | undefined

  try {
    const q = query({
      prompt: inputStream,
      options: {
        systemPrompt,
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        maxTurns: 30,
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
      if (signal?.aborted) {
        break
      }

      if (message.type === "stream_event") {
        const text = getTextDelta(message)
        if (text) onStreamText?.(text)

        const tool = getToolStatus(message)
        if (tool) onToolStatus?.(tool)
      } else if (message.type === "result") {
        cost = extractCost(message)
        if (message.subtype !== "success") {
          return {
            type: "agent_error",
            error: message.errors.join(", ") || message.subtype,
            cost,
          }
        }
        break
      }
    }
  } catch (err: unknown) {
    if (signal?.aborted) {
      return { type: "agent_error", error: "aborted", cost }
    }
    return {
      type: "agent_error",
      error: err instanceof Error ? err.message : String(err),
      cost,
    }
  }

  // Check if the agent produced a commit
  const endSha = await getFullSha(projectRoot)

  if (endSha === startSha) {
    return { type: "no_commit", cost }
  }

  const description = await getLatestCommitMessage(projectRoot)
  const filesChanged = await getFilesChangedBetween(projectRoot, startSha, endSha)

  return {
    type: "committed",
    sha: endSha,
    description,
    files_changed: filesChanged,
    cost,
  }
}
