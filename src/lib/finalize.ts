import { join } from "node:path"
import type { ModelSlot } from "./config.ts"
import type { ProgramConfig } from "./programs.ts"
import type { RunState, ExperimentResult } from "./run.ts"
import { readAllResults, getRunStats } from "./run.ts"
import type { ExperimentCost } from "./experiment.ts"
import {
  getFullSha,
  getDiffBetween,
  getRecentLog,
  getFilesChangedBetween,
  createGroupBranch,
  checkoutBranch,
  resetHard,
  getWorkingTreeStatus,
  formatShellError,
} from "./git.ts"
import { getProvider } from "./agent/index.ts"
import { formatToolEvent } from "./tool-events.ts"
import { getFinalizeSystemPrompt } from "./system-prompts/index.ts"

// --- Types ---

export interface ProposedGroup {
  name: string
  title: string
  description: string
  files: string[]
  risk: "low" | "medium" | "high"
}

export interface FinalizeGroupResult {
  name: string
  branchName: string
  commitSha: string
  title: string
  description: string
  files: string[]
  risk: "low" | "medium" | "high"
}

export interface FinalizeResult {
  summary: string
  mode: "grouped" | "summary-only"
  groups: FinalizeGroupResult[]
  cost?: ExperimentCost
}

export interface FinalizeCallbacks {
  onStreamText: (text: string) => void
  onToolStatus: (status: string) => void
}

// --- Extraction ---

const VALID_RISKS = new Set(["low", "medium", "high"])

export function extractFinalizeGroups(text: string): ProposedGroup[] | null {
  const match = text.match(/<finalize_groups>\s*([\s\S]*?)\s*<\/finalize_groups>/)
  if (!match) return null

  try {
    const raw = JSON.parse(match[1])
    if (!Array.isArray(raw) || raw.length === 0) return null

    const groups: ProposedGroup[] = []
    for (const item of raw) {
      if (typeof item !== "object" || item == null) return null
      const { name, title, description, files, risk } = item as Record<string, unknown>

      if (typeof name !== "string" || !name.trim()) return null
      if (typeof title !== "string" || !title.trim()) return null
      if (!Array.isArray(files) || files.length === 0) return null
      if (!files.every((f): f is string => typeof f === "string" && f.trim().length > 0)) return null

      groups.push({
        name: normalizeName(name),
        title: title.trim(),
        description: typeof description === "string" ? description.trim() : "",
        files: files.map((f) => f.trim()),
        risk: typeof risk === "string" && VALID_RISKS.has(risk) ? (risk as ProposedGroup["risk"]) : "low",
      })
    }

    return groups
  } catch {
    return null
  }
}

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
}

// --- Validation ---

export interface ValidatedGroups {
  valid: true
  groups: ProposedGroup[]
}

export interface ValidationError {
  valid: false
  reason: string
}

export function validateGroups(
  proposedGroups: ProposedGroup[],
  changedFiles: string[],
): ValidatedGroups | ValidationError {
  const changedSet = new Set(changedFiles)
  const fileToGroup = new Map<string, string>()

  // Check for overlaps and strip phantom files
  for (const group of proposedGroups) {
    const validFiles: string[] = []
    for (const file of group.files) {
      if (!changedSet.has(file)) continue // strip phantom files silently
      if (fileToGroup.has(file)) {
        return { valid: false, reason: `File "${file}" assigned to both "${fileToGroup.get(file)}" and "${group.name}"` }
      }
      fileToGroup.set(file, group.name)
      validFiles.push(file)
    }
    group.files = validFiles
  }

  // Remove empty groups after phantom stripping
  const nonEmpty = proposedGroups.filter((g) => g.files.length > 0)
  if (nonEmpty.length === 0) {
    return { valid: false, reason: "All groups empty after removing unrecognized file paths" }
  }

  // Check coverage — all changed files must be assigned
  const unassigned = changedFiles.filter((f) => !fileToGroup.has(f))
  if (unassigned.length > 0) {
    return { valid: false, reason: `Files not assigned to any group: ${unassigned.slice(0, 5).join(", ")}${unassigned.length > 5 ? ` (+${unassigned.length - 5} more)` : ""}` }
  }

  // Check unique group names
  const names = new Set<string>()
  for (const group of nonEmpty) {
    if (names.has(group.name)) {
      return { valid: false, reason: `Duplicate group name: "${group.name}"` }
    }
    names.add(group.name)
  }

  return { valid: true, groups: nonEmpty }
}

// --- Prompt Building ---

const MAX_DIFF_LENGTH = 50_000

export async function buildFinalizePrompt(
  state: RunState,
  results: ExperimentResult[],
  projectRoot: string,
  config: ProgramConfig,
  changedFiles: string[],
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

## Changed Files
These are the files that changed between the baseline and current HEAD. Each file must appear in exactly one group — do not invent file paths.
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

Review these changes, group them into logical changesets, and produce your structured summary. Use \`git show <sha>\` to inspect individual experiment commits if needed.`
}

// --- Agent Runner ---

async function runFinalizeAgent(
  projectRoot: string,
  systemPrompt: string,
  userPrompt: string,
  modelConfig: ModelSlot,
  callbacks: FinalizeCallbacks,
  signal?: AbortSignal,
): Promise<{ summary: string; cost?: ExperimentCost }> {
  throwIfAborted(signal)

  let fullText = ""
  let cost: ExperimentCost | undefined
  const session = getProvider(modelConfig.provider).runOnce(userPrompt, {
    systemPrompt,
    tools: ["Read", "Bash", "Glob", "Grep"],
    allowedTools: ["Read", "Bash", "Glob", "Grep"],
    maxTurns: 10,
    cwd: projectRoot,
    model: modelConfig.model,
    effort: modelConfig.provider !== "opencode" ? modelConfig.effort : undefined,
    signal,
  })

  try {
    for await (const event of session) {
      throwIfAborted(signal)

      switch (event.type) {
        case "text_delta":
          fullText += event.text
          callbacks.onStreamText(event.text)
          break
        case "tool_use":
          callbacks.onToolStatus(formatToolEvent(event.tool, event.input ?? {}))
          break
        case "result":
          cost = event.cost
          break
      }
    }
    throwIfAborted(signal)
  } catch (err: unknown) {
    if (isAbortError(err) || signal?.aborted) throwAbortError(signal)
    throw err
  } finally {
    session.close()
  }

  return { summary: fullText, cost }
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

function stripGroupsXml(text: string): string {
  return text.replace(/<finalize_groups>[\s\S]*?<\/finalize_groups>/g, "").trim()
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
  groups?: FinalizeGroupResult[],
  cost?: ExperimentCost,
): string {
  const stats = getRunStats(state, config.direction)
  const strippedReview = stripGroupsXml(agentReview)

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

  // Per-group section (grouped finalize only)
  if (groups && groups.length > 0) {
    lines.push("## Finalize Groups")
    lines.push("")
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      lines.push(`### ${i + 1}. ${g.name}`)
      lines.push(`- **Branch:** \`${g.branchName}\``)
      lines.push(`- **Commit:** ${g.commitSha.slice(0, 7)}`)
      lines.push(`- **Risk:** ${g.risk}`)
      lines.push(`- **Files:** ${g.files.join(", ")}`)
      if (g.description) lines.push(`- ${g.description}`)
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

// --- Phase 1: Review ---

export interface FinalizeReviewResult {
  summary: string
  proposedGroups: ProposedGroup[] | null
  validationError: string | null
  changedFiles: string[]
  savedHead: string
  results: ExperimentResult[]
  cost?: ExperimentCost
}

export async function runFinalizeReview(
  projectRoot: string,
  runDir: string,
  state: RunState,
  config: ProgramConfig,
  modelConfig: ModelSlot,
  callbacks: FinalizeCallbacks,
  signal?: AbortSignal,
  worktreePath?: string,
): Promise<FinalizeReviewResult> {
  const gitCwd = worktreePath ?? projectRoot

  const savedHead = await getFullSha(gitCwd)
  const preAgentSha = savedHead
  const preAgentStatus = await getWorkingTreeStatus(gitCwd)

  const results = await readAllResults(runDir)
  const changedFiles = await getFilesChangedBetween(gitCwd, state.original_baseline_sha, "HEAD")

  const systemPrompt = getFinalizeSystemPrompt()
  const userPrompt = await buildFinalizePrompt(state, results, gitCwd, config, changedFiles)

  const { summary, cost } = await runFinalizeAgent(
    gitCwd,
    systemPrompt,
    userPrompt,
    modelConfig,
    callbacks,
    signal,
  )

  // Verify agent didn't modify the repo
  const postAgentSha = await getFullSha(gitCwd)
  const postAgentStatus = await getWorkingTreeStatus(gitCwd)
  if (postAgentSha !== preAgentSha || postAgentStatus !== preAgentStatus) {
    throw new Error("Finalize agent modified the repository. Aborting.")
  }

  const { proposedGroups, validationError } =
    state.total_keeps > 0 && changedFiles.length > 0
      ? extractAndValidateGroups(summary, changedFiles)
      : { proposedGroups: null, validationError: null }

  return { summary, proposedGroups, validationError, changedFiles, savedHead, results, cost }
}

// --- Phase 2: Refine ---

export interface FinalizeRefineResult {
  summary: string
  proposedGroups: ProposedGroup[] | null
  validationError: string | null
  cost?: ExperimentCost
}

export async function refineFinalizeGroups(
  previousSummary: string,
  userFeedback: string,
  changedFiles: string[],
  modelConfig: ModelSlot,
  projectRoot: string,
  callbacks: FinalizeCallbacks,
  signal?: AbortSignal,
  worktreePath?: string,
): Promise<FinalizeRefineResult> {
  const gitCwd = worktreePath ?? projectRoot
  const preAgentSha = await getFullSha(gitCwd)
  const preAgentStatus = await getWorkingTreeStatus(gitCwd)

  const systemPrompt = `You are the AutoAuto Finalize Agent refining a changeset grouping based on user feedback.

You previously analyzed an experiment run and proposed file groupings. The user wants changes.

## Rules
- You are READ-ONLY. Do NOT modify files.
- Use ONLY files from the Changed Files list below.
- Each file must appear in exactly ONE group.
- All changed files must be assigned to a group.
- Output your revised grouping in the same <finalize_groups> XML format.

## Changed Files
${changedFiles.join("\n")}
`

  const userPrompt = `Here is your previous analysis:

${previousSummary}

The user's feedback:

${userFeedback}

Please revise the grouping based on this feedback. Include a brief explanation of what you changed, then output the revised <finalize_groups> block.`

  const { summary, cost } = await runFinalizeAgent(
    gitCwd,
    systemPrompt,
    userPrompt,
    modelConfig,
    callbacks,
    signal,
  )

  const postAgentSha = await getFullSha(gitCwd)
  const postAgentStatus = await getWorkingTreeStatus(gitCwd)
  if (postAgentSha !== preAgentSha || postAgentStatus !== preAgentStatus) {
    throw new Error("Finalize agent modified the repository. Aborting.")
  }

  const { proposedGroups, validationError } = extractAndValidateGroups(summary, changedFiles)

  return { summary, proposedGroups, validationError, cost }
}

// --- Shared Helpers ---

function extractAndValidateGroups(
  text: string,
  changedFiles: string[],
): { proposedGroups: ProposedGroup[] | null; validationError: string | null } {
  const proposed = extractFinalizeGroups(text)
  if (!proposed || proposed.length === 0) return { proposedGroups: null, validationError: null }

  const validation = validateGroups(proposed, changedFiles)
  if (validation.valid) return { proposedGroups: validation.groups, validationError: null }
  return { proposedGroups: null, validationError: validation.reason }
}

// --- Phase 3: Apply ---

export async function applyFinalizeGroups(
  projectRoot: string,
  programSlug: string,
  runDir: string,
  state: RunState,
  config: ProgramConfig,
  groups: ProposedGroup[],
  savedHead: string,
  agentSummary: string,
  results: ExperimentResult[],
  worktreePath?: string,
  cost?: ExperimentCost,
): Promise<FinalizeResult> {
  const gitCwd = worktreePath ?? projectRoot

  const createdGroups: FinalizeGroupResult[] = []
  try {
    for (const group of groups) {
      const branchName = `autoauto-${programSlug}-${state.run_id}-${group.name}`.slice(0, 100)
      const commitSha = await createGroupBranch(
        gitCwd,
        branchName,
        state.original_baseline_sha,
        savedHead,
        group.files,
        group.title,
      )
      createdGroups.push({
        name: group.name,
        branchName,
        commitSha,
        title: group.title,
        description: group.description,
        files: group.files,
        risk: group.risk,
      })
    }
  } catch (err: unknown) {
    // Partial failure — restore worktree to original state
    await checkoutBranch(gitCwd, state.branch_name).catch(() => {})
    await resetHard(gitCwd, savedHead).catch(() => {})
    const partial =
      createdGroups.length > 0
        ? ` Partial branches kept: ${createdGroups.map((group) => group.branchName).join(", ")}.`
        : ""
    throw new Error(`${formatShellError(err, "Finalize branch creation failed")}.${partial}`, { cause: err })
  }

  // Restore worktree to original experiment branch
  await checkoutBranch(gitCwd, state.branch_name).catch(() => {})
  await resetHard(gitCwd, savedHead).catch(() => {})

  const report = generateSummaryReport(state, results, config, agentSummary, createdGroups, cost)
  await Bun.write(join(runDir, "summary.md"), report)
  return { summary: report, mode: "grouped", groups: createdGroups, cost }
}

// --- Summary-only fallback ---

export async function saveSummaryOnly(
  state: RunState,
  results: ExperimentResult[],
  config: ProgramConfig,
  agentSummary: string,
  runDir: string,
  cost?: ExperimentCost,
): Promise<FinalizeResult> {
  const report = generateSummaryReport(state, results, config, agentSummary, undefined, cost)
  await Bun.write(join(runDir, "summary.md"), report)

  return { summary: report, mode: "summary-only", groups: [], cost }
}


function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throwAbortError(signal)
}

function throwAbortError(signal?: AbortSignal): never {
  const reason = signal?.reason
  if (reason instanceof Error) {
    reason.name = "AbortError"
    throw reason
  }
  const error = new Error(typeof reason === "string" && reason.length > 0 ? reason : "Finalize aborted")
  error.name = "AbortError"
  throw error
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}
