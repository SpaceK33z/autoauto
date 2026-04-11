import { join } from "node:path"
import type { RunState, PreviousRunContext } from "./run.ts"
import type { ModelSlot } from "./config.ts"
import { formatRecentResults, parseLastResult, parseLastKeepResult, parseDiscardedShas, parseSecondaryValues } from "./run.ts"
import {
  getFullSha,
  getRecentLog,
  getLatestCommitMessage,
  getFilesChangedBetween,
  getDiscardedDiffs,
  getDiffStats,
  formatShellError,
  type DiffStats,
} from "./git.ts"
import { getProvider, type AgentCost, type ErrorKind, type QuotaInfo } from "./agent/index.ts"
import { classifyAgentError } from "./agent/error-classifier.ts"
import { formatToolEvent } from "./tool-events.ts"
import {
  parseExperimentNotes,
  readIdeasBacklogSummary,
  type ExperimentNotes,
} from "./ideas-backlog.ts"

// --- Types ---

/** Everything the experiment agent needs to know */
export interface ContextPacket {
  experiment: number
  current_baseline: number
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
  ideas_backlog: string
  secondary_metrics?: Record<string, { direction: "lower" | "higher"; last_kept_value?: number }>
  consecutive_discards: number
  max_consecutive_discards: number
  max_turns?: number
  measurement_diagnostics?: string
  previous_results: string
  previous_ideas: string
  previous_termination?: string | null
}

/** Cost and usage data from an agent session. */
export type ExperimentCost = AgentCost

/** Result of running one experiment agent session */
export type ExperimentOutcome =
  | { type: "committed"; sha: string; description: string; files_changed: string[]; diff_stats: DiffStats; cost?: ExperimentCost; notes?: ExperimentNotes }
  | { type: "no_commit"; cost?: ExperimentCost; notes?: ExperimentNotes }
  | { type: "agent_error"; error: string; errorKind?: ErrorKind; cost?: ExperimentCost; notes?: ExperimentNotes }

/** Result of checking whether locked files were modified */
export interface LockViolation {
  violated: boolean
  files: string[]
}

// --- Context Packet ---

/** Assembles the context packet from disk for a single experiment. */
export async function buildContextPacket(
  cwd: string,
  programDir: string,
  runDir: string,
  state: RunState,
  config: { metric_field: string; direction: "lower" | "higher"; secondary_metrics?: Record<string, { direction: "lower" | "higher" }> },
  options: { ideasBacklogEnabled?: boolean; consecutiveDiscards?: number; maxConsecutiveDiscards?: number; maxTurns?: number; measurementDiagnostics?: string; previousRunContext?: PreviousRunContext } = {},
): Promise<ContextPacket> {
  const [programMd, resultsRaw, recentGitLog] = await Promise.all([
    Bun.file(join(programDir, "program.md")).text(),
    Bun.file(join(runDir, "results.tsv")).text(),
    getRecentLog(cwd, 15),
  ])
  const ideasBacklog = options.ideasBacklogEnabled === false
    ? ""
    : await readIdeasBacklogSummary(runDir)

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
      discardedDiffs = await getDiscardedDiffs(cwd, discardedShas, 2000)
    } catch {
      // Discarded commits may have been garbage-collected — diffs unavailable
      discardedDiffs = ""
    }
  }

  let secondaryMetrics: ContextPacket["secondary_metrics"]
  if (config.secondary_metrics && Object.keys(config.secondary_metrics).length > 0) {
    secondaryMetrics = {}
    const lastKeep = parseLastKeepResult(resultsRaw)
    const lastKeepValues = parseSecondaryValues(lastKeep?.secondary_values)

    for (const [field, metric] of Object.entries(config.secondary_metrics)) {
      const currentValue = lastKeepValues.secondary_metrics[field]
      secondaryMetrics[field] = {
        direction: metric.direction,
        last_kept_value: typeof currentValue === "number" ? currentValue : undefined,
      }
    }
  }

  // Adaptive budget: drop previous ideas if current backlog is already large
  const prev = options.previousRunContext
  const previousIdeas = (prev?.previousIdeas && ideasBacklog.length <= 3000) ? prev.previousIdeas : ""

  return {
    experiment: state.experiment_number,
    current_baseline: state.current_baseline,
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
    ideas_backlog: ideasBacklog,
    secondary_metrics: secondaryMetrics,
    consecutive_discards: options.consecutiveDiscards ?? 0,
    max_consecutive_discards: options.maxConsecutiveDiscards ?? 10,
    max_turns: options.maxTurns,
    measurement_diagnostics: options.measurementDiagnostics,
    previous_results: prev?.previousResults ?? "",
    previous_ideas: previousIdeas,
    previous_termination: prev?.latestTermination,
  }
}

/** Returns an escalating diversity directive based on how stuck the loop is. */
function getExplorationDirective(consecutiveDiscards: number, maxConsecutiveDiscards: number): string {
  if (consecutiveDiscards < 1) return ""

  // Use proportional thresholds so directives scale with the configured limit
  const ratio = consecutiveDiscards / maxConsecutiveDiscards

  if (ratio >= 0.7) {
    return `## Exploration Directive — CRITICAL
${consecutiveDiscards} consecutive experiments discarded. Stagnation is imminent (limit: ${maxConsecutiveDiscards}).
- You MUST try something radically different from everything in the results history.
- Profile the code mentally and find the ACTUAL bottleneck — not the assumed one. Question fundamental assumptions.
- If you genuinely cannot find a promising change — EXIT WITHOUT COMMITTING. A no-commit is better than burning another cycle on a doomed approach.`
  }

  if (ratio >= 0.5) {
    return `## Exploration Directive
${consecutiveDiscards} consecutive experiments discarded. You are likely stuck in a local optimum.
- STOP trying variations of what's been tried. Every recent approach has failed.
- Try something orthogonal: a completely different part of the codebase within scope, a different algorithmic family, or a simplification that removes code.
- Re-read the ideas backlog "next" suggestions — pick the LEAST similar to recent attempts.
- Remember: simplification keeps are free wins and can open up new optimization paths.`
  }

  if (ratio >= 0.3) {
    return `## Exploration Directive
${consecutiveDiscards} consecutive experiments discarded. The obvious approaches aren't working.
- Step back and re-read the hot path from scratch — look for something you've been overlooking.
- Try an approach from a DIFFERENT category than recent attempts (e.g., if recent tries were algorithmic, try a data-structure change; if recent tries were micro-optimizations, try a structural change).`
  }

  return ""
}

/** Formats the context packet as the user message string for the agent. */
export function buildExperimentPrompt(packet: ContextPacket): string {
  let secondarySection = ""
  if (packet.secondary_metrics && Object.keys(packet.secondary_metrics).length > 0) {
    const lines = Object.entries(packet.secondary_metrics).map(([field, m]) => {
      const val = m.last_kept_value !== undefined ? String(m.last_kept_value) : "unknown"
      return `- ${field}: ${val} (${m.direction} is better, last kept measurement)`
    })
    secondarySection = `
## Secondary Metrics (advisory — do NOT optimize at the expense of the primary metric)
${lines.join("\n")}
`
  }

  let previousRunSection = ""
  if (packet.previous_results) {
    let terminationNote = ""
    if (packet.previous_termination === "stagnation") {
      terminationNote = "\nThe most recent previous run ended via stagnation (consecutive discards hit the limit). The approaches in the ideas below were exhausted — consider whether this represents a genuine ceiling or whether an orthogonal approach could break through. Do NOT refine what the previous run was already doing."
    } else if (packet.previous_termination === "max_experiments") {
      terminationNote = "\nThe most recent previous run ended at its experiment budget. There may be unexplored productive directions."
    } else if (packet.previous_termination === "budget_exceeded") {
      terminationNote = "\nThe most recent previous run ended because its cost budget was exceeded. There may be unexplored productive directions."
    } else if (packet.previous_termination === "quota_exhausted") {
      terminationNote = "\nThe most recent previous run ended because the provider's quota was exhausted. There may be unexplored productive directions."
    }
    previousRunSection += `
## Previous Runs
The results below are from previous runs on separate branches. The code changes were NOT merged into your working tree. Do not assume these optimizations exist in the current codebase. Use this as guidance for what approaches to try or avoid.${terminationNote}
\`\`\`
${packet.previous_results}
\`\`\`
`
  }
  if (packet.previous_ideas) {
    previousRunSection += `
## Previous Run Ideas
Learnings from the most recent previous run. These reference code as it was during that run — the codebase may have changed since.
${packet.previous_ideas}
`
  }

  return `You are experiment ${packet.experiment} of an autoresearch loop.

## Current State
- Baseline ${packet.metric_field}: ${packet.current_baseline} (${packet.direction} is better)
- Original baseline: ${packet.original_baseline}
- Best achieved: ${packet.best_metric} (experiment #${packet.best_experiment})
- Total: ${packet.total_keeps} keeps, ${packet.total_discards} discards
${packet.max_turns ? `- Turn budget: ${packet.max_turns} turns (you will be terminated if you exceed this — pace yourself)` : ""}
${secondarySection}${previousRunSection}
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
${packet.measurement_diagnostics ? `
## Measurement Diagnostics
Detailed diagnostic output from the last measurement run. Use this to identify exactly which audits, tests, or checks are underperforming — do NOT guess from code inspection alone.
\`\`\`
${packet.measurement_diagnostics}
\`\`\`
` : ""}
${packet.ideas_backlog ? `
## Ideas Backlog
${packet.ideas_backlog}
` : ""}

${getExplorationDirective(packet.consecutive_discards, packet.max_consecutive_discards)}

Review the recent results and discarded experiments${packet.ideas_backlog ? ", ideas backlog" : ""}${packet.previous_results || packet.previous_ideas ? ", and previous run history" : ""} above. Focus on what was tried, why it failed, and what should be tried next.
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
 * Spawns a fresh agent session for one experiment.
 * One-shot: push one user message, iterate to result, return outcome.
 */
export async function runExperimentAgent(
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
  modelConfig: ModelSlot,
  startSha: string,
  onStreamText?: (text: string) => void,
  onToolStatus?: (status: string) => void,
  signal?: AbortSignal,
  maxTurns?: number,
  onQuotaUpdate?: (quota: QuotaInfo) => void,
): Promise<ExperimentOutcome> {
  const raw = await runExperimentAgentRaw(cwd, systemPrompt, userPrompt, modelConfig, startSha, onStreamText, onToolStatus, signal, maxTurns, onQuotaUpdate)
  return { ...raw.outcome, notes: parseExperimentNotes(raw.assistantText) }
}

async function runExperimentAgentRaw(
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
  modelConfig: ModelSlot,
  startSha: string,
  onStreamText?: (text: string) => void,
  onToolStatus?: (status: string) => void,
  signal?: AbortSignal,
  maxTurns?: number,
  onQuotaUpdate?: (quota: QuotaInfo) => void,
): Promise<{ outcome: ExperimentOutcome; assistantText: string }> {
  if (signal?.aborted) {
    return { outcome: { type: "agent_error", error: "aborted before start" }, assistantText: "" }
  }

  let cost: ExperimentCost | undefined
  let assistantText = ""

  try {
    const session = getProvider(modelConfig.provider).runOnce(userPrompt, {
      systemPrompt,
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"],
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Task"],
      maxTurns,
      cwd,
      model: modelConfig.model,
      effort: modelConfig.provider !== "opencode" ? modelConfig.effort : undefined,
      signal,
    })

    for await (const event of session) {
      if (signal?.aborted) break

      switch (event.type) {
        case "text_delta":
          onStreamText?.(event.text)
          break
        case "tool_use":
          onToolStatus?.(formatToolEvent(event.tool, event.input ?? {}))
          break
        case "assistant_complete":
          assistantText += `\n${event.text}`
          break
        case "error":
          return { outcome: { type: "agent_error", error: event.error, errorKind: event.errorKind, cost }, assistantText }
        case "result":
          cost = event.cost
          if (!event.success) {
            const errorMsg = event.error ?? "unknown"
            return { outcome: { type: "agent_error", error: errorMsg, errorKind: classifyAgentError(errorMsg), cost }, assistantText }
          }
          break
        case "quota_update":
          onQuotaUpdate?.(event.quota)
          break
      }
    }
  } catch (err: unknown) {
    if (signal?.aborted) {
      return { outcome: { type: "agent_error", error: "aborted", cost }, assistantText }
    }
    const errorMsg = formatShellError(err)
    return {
      outcome: { type: "agent_error", error: errorMsg, errorKind: classifyAgentError(errorMsg), cost },
      assistantText,
    }
  }

  // Check if the agent produced a commit
  const endSha = await getFullSha(cwd)

  if (endSha === startSha) {
    return { outcome: { type: "no_commit", cost }, assistantText }
  }

  const [description, filesChanged, diffStats] = await Promise.all([
    getLatestCommitMessage(cwd),
    getFilesChangedBetween(cwd, startSha, endSha),
    getDiffStats(cwd, startSha, endSha),
  ])

  return {
    outcome: { type: "committed", sha: endSha, description, files_changed: filesChanged, diff_stats: diffStats, cost },
    assistantText,
  }
}
