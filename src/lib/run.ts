import { rename, readdir, appendFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { $ } from "bun"
import { getProgramDir, type ProgramConfig } from "./programs.ts"
import { readIdeasBacklogSummary } from "./ideas-backlog.ts"

// --- Types ---

/** Status values for results.tsv rows */
export type ExperimentStatus = "keep" | "discard" | "measurement_failure" | "crash" | "verification_baseline" | "verification_current"

/** Phases the daemon/orchestrator can be in */
export type RunPhase =
  | "idle"
  | "baseline"
  | "agent_running"
  | "measuring"
  | "reverting"
  | "kept"
  | "stopping"
  | "complete"
  | "crashed"
  | "finalizing"

/** Termination reason for a completed run */
export type TerminationReason = "aborted" | "max_experiments" | "stopped" | "stagnation"

/** Persisted run state — the checkpoint file */
export interface RunState {
  run_id: string
  program_slug: string
  phase: RunPhase
  experiment_number: number
  original_baseline: number
  current_baseline: number
  best_metric: number
  best_experiment: number
  total_keeps: number
  total_discards: number
  total_crashes: number
  branch_name: string
  original_baseline_sha: string
  last_known_good_sha: string
  candidate_sha: string | null
  started_at: string
  updated_at: string
  /** Agent provider used for this run. Legacy runs omit this and default to Claude. */
  provider?: string
  /** Model alias/ID used for this run (e.g. "sonnet" or "anthropic/claude-sonnet-4-5") */
  model?: string
  /** Effort level used for this run */
  effort?: string
  /** Cumulative input+output tokens across all experiments */
  total_tokens?: number
  /** Cumulative cost in USD across all experiments */
  total_cost_usd?: number
  /** Why the run terminated (set on completion) */
  termination_reason?: TerminationReason | null
  /** Branch the user was on before the run started */
  original_branch?: string
  /** Absolute path to the AutoAuto-owned worktree */
  worktree_path?: string
  /** True when running without worktree isolation (experiments run in main checkout) */
  in_place?: boolean
  /** Error message if the run crashed */
  error?: string | null
  /** Which phase the error occurred in */
  error_phase?: RunPhase | null
  /** Whether this run was started manually or from the queue */
  source?: "manual" | "queue"
}

/** A single row in results.tsv */
export interface ExperimentResult {
  experiment_number: number
  commit: string
  metric_value: number
  secondary_values: string
  status: ExperimentStatus
  description: string
  /** Total wall time for the measurement series (all repeats), in ms */
  measurement_duration_ms: number
  /** Diff stats JSON — e.g. {"lines_added":12,"lines_removed":5}. Absent for old runs. */
  diff_stats?: string
}

/** Structured secondary values stored in results.tsv */
export interface SecondaryValuesBlob {
  quality_gates: Record<string, number>
  secondary_metrics: Record<string, number>
}

/** Serializes DiffStats into compact JSON for results.tsv. */
export function serializeDiffStats(stats: { lines_added: number; lines_removed: number } | undefined): string {
  if (!stats) return ""
  return JSON.stringify({ lines_added: stats.lines_added, lines_removed: stats.lines_removed })
}

/** Serializes quality gate and secondary metric medians into the structured JSON format. */
export function serializeSecondaryValues(
  qualityGates: Record<string, number>,
  secondaryMetrics: Record<string, number>,
): string {
  return JSON.stringify({ quality_gates: qualityGates, secondary_metrics: secondaryMetrics })
}

/**
 * Parses secondary_values JSON with backward compatibility.
 * New format: { quality_gates: {...}, secondary_metrics: {...} }
 * Old format: flat { field: value, ... } — all values placed under quality_gates.
 */
export function parseSecondaryValues(raw: string | undefined): SecondaryValuesBlob {
  const empty: SecondaryValuesBlob = { quality_gates: {}, secondary_metrics: {} }
  if (!raw) return empty
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return empty
    // Detect new structured format
    if ("quality_gates" in parsed || "secondary_metrics" in parsed) {
      return {
        quality_gates: (parsed as Record<string, unknown>).quality_gates as Record<string, number> ?? {},
        secondary_metrics: (parsed as Record<string, unknown>).secondary_metrics as Record<string, number> ?? {},
      }
    }
    // Old flat format — treat all values as quality gates
    return { quality_gates: parsed as Record<string, number>, secondary_metrics: {} }
  } catch {
    return empty
  }
}

// --- Run ID ---

const pad = (n: number) => String(n).padStart(2, "0")

export function generateRunId(): string {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// --- State Persistence ---

/** Atomically writes state.json via temp-file + rename. */
export async function writeState(runDir: string, state: RunState): Promise<void> {
  const tmpPath = join(runDir, "state.json.tmp")
  await Bun.write(tmpPath, JSON.stringify(state, null, 2) + "\n")
  await rename(tmpPath, join(runDir, "state.json"))
}

export async function readState(runDir: string): Promise<RunState> {
  return Bun.file(join(runDir, "state.json")).json() as Promise<RunState>
}

// --- Results ---

export async function appendResult(runDir: string, result: ExperimentResult): Promise<void> {
  const secondaryStr = result.secondary_values || ""
  const diffStatsStr = result.diff_stats || ""
  const line = `${result.experiment_number}\t${result.commit}\t${result.metric_value}\t${secondaryStr}\t${result.status}\t${result.description}\t${result.measurement_duration_ms}\t${diffStatsStr}\n`
  await appendFile(join(runDir, "results.tsv"), line)
}

// --- Results Parsing (synchronous — operate on pre-read content) ---

/** Parses a single TSV row into a typed result. Returns null if malformed. */
function parseTsvRow(line: string): ExperimentResult | null {
  const parts = line.split("\t")
  if (parts.length < 6) return null
  return {
    experiment_number: parseInt(parts[0], 10),
    commit: parts[1],
    metric_value: parseFloat(parts[2]),
    secondary_values: parts[3],
    status: parts[4] as ExperimentStatus,
    description: parts[5],
    measurement_duration_ms: parts[6] ? parseInt(parts[6], 10) : 0,
    diff_stats: parts[7] || undefined,
  }
}

/** Formats header + last N data rows from raw results.tsv content. */
export function formatRecentResults(raw: string, count = 15): string {
  const lines = raw.split("\n").filter(Boolean)
  if (lines.length <= 1) return lines.join("\n")

  const header = lines[0]
  const rows = lines.slice(1)
  const recent = rows.slice(-count)
  return [header, ...recent].join("\n")
}

/** Parses the last row of raw results.tsv content into a typed object. */
export function parseLastResult(raw: string): ExperimentResult | null {
  const lines = raw.trim().split("\n")
  if (lines.length <= 1) return null // only header
  return parseTsvRow(lines[lines.length - 1])
}

/** Parses the last keep row from raw results.tsv content. */
export function parseLastKeepResult(raw: string): ExperimentResult | null {
  const lines = raw.trim().split("\n")
  for (let i = lines.length - 1; i >= 1; i--) {
    const row = parseTsvRow(lines[i])
    if (row?.status === "keep") return row
  }
  return null
}

/** Extracts SHAs of recent discarded/crashed experiments from raw results.tsv content. */
export function parseDiscardedShas(raw: string, count = 5): string[] {
  const lines = raw.trim().split("\n")
  const shas: string[] = []

  for (let i = lines.length - 1; i >= 1 && shas.length < count; i--) {
    const parts = lines[i].split("\t")
    if (parts.length >= 5) {
      const status = parts[4]
      if (status === "discard" || status === "crash" || status === "measurement_failure") {
        shas.push(parts[1]) // commit SHA
      }
    }
  }

  return shas
}

// --- Results Reading ---

/** Parses the entire results.tsv into a typed array. */
export async function readAllResults(runDir: string): Promise<ExperimentResult[]> {
  const raw = await Bun.file(join(runDir, "results.tsv")).text()
  const lines = raw.trim().split("\n")
  if (lines.length <= 1) return [] // only header

  const results: ExperimentResult[] = []
  for (let i = 1; i < lines.length; i++) {
    const row = parseTsvRow(lines[i])
    if (row) results.push(row)
  }
  return results
}

/** Extracts metric values from keep results for sparkline/chart rendering. */
export function getMetricHistory(results: ExperimentResult[]): number[] {
  return results
    .filter((r) => r.status === "keep")
    .map((r) => r.metric_value)
}

/** Computes average measurement duration from results that have duration data. */
export function getAvgMeasurementDuration(results: ExperimentResult[]): number | null {
  const durations = results
    .filter((r) => r.measurement_duration_ms > 0)
    .map((r) => r.measurement_duration_ms)
  if (durations.length === 0) return null
  return Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
}

/** Derived statistics from state for the TUI dashboard. */
export interface RunStats {
  total_experiments: number
  total_keeps: number
  total_discards: number
  total_crashes: number
  keep_rate: number
  improvement_pct: number
  current_improvement_pct: number
}

function computeImprovementPct(
  original: number,
  current: number,
  direction: ProgramConfig["direction"],
): number {
  if (original === 0) return 0
  return direction === "lower"
    ? ((original - current) / Math.abs(original)) * 100
    : ((current - original) / Math.abs(original)) * 100
}

/** Computes derived statistics from run state. Counts come from RunState's authoritative counters. */
export function getRunStats(state: RunState, direction: ProgramConfig["direction"]): RunStats {
  const total = state.total_keeps + state.total_discards + state.total_crashes

  return {
    total_experiments: total,
    total_keeps: state.total_keeps,
    total_discards: state.total_discards,
    total_crashes: state.total_crashes,
    keep_rate: total > 0 ? state.total_keeps / total : 0,
    improvement_pct: computeImprovementPct(state.original_baseline, state.best_metric, direction),
    current_improvement_pct: computeImprovementPct(state.original_baseline, state.current_baseline, direction),
  }
}

// --- Run Listing ---

/** Metadata for a run, used in list views. */
export interface RunInfo {
  run_id: string
  run_dir: string
  state: RunState | null
}

/** Lists all runs for a program, sorted newest first. */
export async function listRuns(programDir: string): Promise<RunInfo[]> {
  const runsDir = join(programDir, "runs")
  let entries: string[]
  try {
    const dirents = await readdir(runsDir, { withFileTypes: true })
    entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }

  const runs = await Promise.all(
    entries.map(async (runId): Promise<RunInfo> => {
      const runDir = join(runsDir, runId)
      let state: RunState | null = null
      try {
        state = await readState(runDir)
      } catch {
        // state.json missing or corrupt
      }
      return { run_id: runId, run_dir: runDir, state }
    }),
  )

  runs.sort((a, b) => b.run_id.localeCompare(a.run_id))
  return runs
}

/** Returns the most recent run for a program. */
export async function getLatestRun(programDir: string): Promise<RunInfo | null> {
  const runs = await listRuns(programDir)
  return runs.length > 0 ? runs[0] : null
}

export function isRunActive(r: RunInfo): boolean {
  const phase = r.state?.phase
  return phase != null && phase !== "complete" && phase !== "crashed"
}

// --- Previous Run Context ---

export interface PreviousRunContext {
  previousResults: string
  previousIdeas: string
}

/**
 * Reads context from previous completed runs of the same program.
 * - Results: keep rows only + 1-line summary per run (most recent first), capped at 3000 chars.
 * - Ideas: ideas.md from the latest completed previous run, capped at 2000 chars.
 */
export async function readPreviousRunContext(programDir: string, currentRunId: string): Promise<PreviousRunContext> {
  const empty: PreviousRunContext = { previousResults: "", previousIdeas: "" }

  let runs: RunInfo[]
  try {
    runs = await listRuns(programDir)
  } catch {
    return empty
  }

  // Filter to only completed previous runs
  const previousRuns = runs.filter((r) => r.run_id !== currentRunId && r.state?.phase === "complete")
  if (previousRuns.length === 0) return empty

  // Build combined results: keep rows + per-run summary, most recent first
  const MAX_RESULTS_CHARS = 3000
  const resultParts: string[] = []
  let totalChars = 0

  for (const run of previousRuns) {
    if (totalChars >= MAX_RESULTS_CHARS) break
    try {
      const raw = await Bun.file(join(run.run_dir, "results.tsv")).text()
      const lines = raw.trim().split("\n")
      if (lines.length <= 1) continue

      // Parse all rows, extract keeps
      const keeps: string[] = []
      let totalExperiments = 0
      let totalKeeps = 0
      for (let i = 1; i < lines.length; i++) {
        const row = parseTsvRow(lines[i])
        if (!row || row.status === "verification_baseline" || row.status === "verification_current") continue
        totalExperiments++
        if (row.status === "keep") {
          totalKeeps++
          keeps.push(`  ${row.experiment_number}\t${row.metric_value}\t${row.description}`)
        }
      }

      // Build run summary
      const state = run.state
      const baselineStr = state ? `baseline ${state.original_baseline} -> ${state.current_baseline}` : ""
      const summary = `Run ${run.run_id}: ${totalExperiments} experiments, ${totalKeeps} kept${baselineStr ? `, ${baselineStr}` : ""}`

      const runBlock = keeps.length > 0
        ? `${summary}\n${keeps.join("\n")}`
        : summary

      if (totalChars + runBlock.length > MAX_RESULTS_CHARS && totalChars > 0) break
      resultParts.push(runBlock)
      totalChars += runBlock.length + 1
    } catch {
      continue
    }
  }

  // Read ideas from latest completed previous run
  let previousIdeas = ""
  try {
    previousIdeas = await readIdeasBacklogSummary(previousRuns[0].run_dir, 2000)
  } catch {
    // ideas.md missing or unreadable
  }

  return {
    previousResults: resultParts.join("\n\n"),
    previousIdeas,
  }
}

// --- Run Deletion ---

/** Deletes a completed/crashed run: removes run directory, worktree, and git branch. */
export async function deleteRun(projectRoot: string, run: RunInfo): Promise<void> {
  if (isRunActive(run)) {
    throw new Error("Cannot delete an active run")
  }

  const state = run.state

  // Remove worktree if it exists (skip for in-place runs — there's no worktree)
  if (state?.worktree_path && !state?.in_place) {
    await $`git worktree remove --force ${state.worktree_path}`.cwd(projectRoot).nothrow().quiet()
  }

  // Delete the experiment branch
  if (state?.branch_name) {
    await $`git branch -D ${state.branch_name}`.cwd(projectRoot).nothrow().quiet()
  }

  // Remove the run directory
  await rm(run.run_dir, { recursive: true, force: true })
}

/** Deletes an entire program: removes all runs (worktrees + branches) and the program directory. */
export async function deleteProgram(projectRoot: string, slug: string): Promise<void> {
  const programDir = getProgramDir(projectRoot, slug)
  const runs = await listRuns(programDir)

  const activeRun = runs.find(isRunActive)
  if (activeRun) {
    throw new Error("Cannot delete a program with an active run")
  }

  // Delete all runs first (cleans up worktrees + branches)
  for (const run of runs) {
    await deleteRun(projectRoot, run)
  }

  // Remove the program directory
  await rm(programDir, { recursive: true, force: true })
}

