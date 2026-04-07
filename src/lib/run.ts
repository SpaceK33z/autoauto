import { rename, mkdir, chmod, readdir, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { getProgramDir, loadProgramConfig, type ProgramConfig } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import { runMeasurementSeries } from "./measure.ts"
import {
  getFullSha,
  isWorkingTreeClean,
  getCurrentBranch,
  createExperimentBranch,
  checkoutBranch,
} from "./git.ts"

// --- Types ---

/** Status values for results.tsv rows */
export type ExperimentStatus = "keep" | "discard" | "measurement_failure" | "crash"

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
  | "cleaning_up"

/** Termination reason for a completed run */
export type TerminationReason = "aborted" | "max_experiments" | "stopped"

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
  /** Model alias used for this run (e.g. "sonnet", "opus") */
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
  /** Error message if the run crashed */
  error?: string | null
  /** Which phase the error occurred in */
  error_phase?: RunPhase | null
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
}

// --- Run ID ---

const pad = (n: number) => String(n).padStart(2, "0")

export function generateRunId(): string {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// --- Measurement Locking ---

/** Makes measure.sh, build.sh, and config.json read-only (chmod 444). #1 safeguard against metric gaming. */
export async function lockMeasurement(programDir: string): Promise<void> {
  await chmod(join(programDir, "measure.sh"), 0o444)
  await chmod(join(programDir, "config.json"), 0o444)
  await chmod(join(programDir, "build.sh"), 0o444).catch(() => {})
}

export async function unlockMeasurement(programDir: string): Promise<void> {
  await chmod(join(programDir, "measure.sh"), 0o644)
  await chmod(join(programDir, "config.json"), 0o644)
  await chmod(join(programDir, "build.sh"), 0o644).catch(() => {})
}

// --- Run Directory ---

export async function initRunDir(programDir: string, runId: string): Promise<string> {
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  await Bun.write(
    join(runDir, "results.tsv"),
    "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\n",
  )

  return runDir
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
  const line = `${result.experiment_number}\t${result.commit}\t${result.metric_value}\t${secondaryStr}\t${result.status}\t${result.description}\t${result.measurement_duration_ms}\n`
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

// --- High-Level Orchestration ---

export async function startRun(
  projectRoot: string,
  programSlug: string,
  modelConfig?: ModelSlot,
): Promise<{ runId: string; runDir: string; state: RunState; originalBranch: string }> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const measureShPath = join(programDir, "measure.sh")
  const buildShPath = join(programDir, "build.sh")

  const config = await loadProgramConfig(programDir)

  if (!(await isWorkingTreeClean(projectRoot))) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them before starting a run.")
  }

  const originalBranchName = await getCurrentBranch(projectRoot)

  const runId = generateRunId()
  const branchName = await createExperimentBranch(projectRoot, programSlug, runId)

  const runDir = await initRunDir(programDir, runId)

  await lockMeasurement(programDir)

  const cleanup = async () => {
    await unlockMeasurement(programDir)
    await checkoutBranch(projectRoot, originalBranchName).catch(() => {})
  }

  const baseline = await runMeasurementSeries(measureShPath, projectRoot, config, undefined, buildShPath)

  if (!baseline.success) {
    await cleanup()
    const failureDetails = [
      baseline.failure_reason,
      ...baseline.individual_runs.map((r) => (r.success ? null : r.error)),
    ].filter((detail): detail is string => Boolean(detail))
    throw new Error(
      `Baseline measurement failed: ${failureDetails.join(", ") || "unknown error"}`,
    )
  }

  if (!baseline.quality_gates_passed) {
    await cleanup()
    throw new Error(`Baseline quality gates failed: ${baseline.gate_violations.join(", ")}`)
  }

  const fullSha = await getFullSha(projectRoot)

  await appendResult(runDir, {
    experiment_number: 0,
    commit: fullSha.slice(0, 7),
    metric_value: baseline.median_metric,
    secondary_values: JSON.stringify(baseline.median_quality_gates),
    status: "keep",
    description: "baseline",
    measurement_duration_ms: baseline.duration_ms,
  })

  const now = new Date().toISOString()
  const state: RunState = {
    run_id: runId,
    program_slug: programSlug,
    phase: "idle",
    experiment_number: 0,
    original_baseline: baseline.median_metric,
    current_baseline: baseline.median_metric,
    best_metric: baseline.median_metric,
    best_experiment: 0,
    total_keeps: 0,
    total_discards: 0,
    total_crashes: 0,
    branch_name: branchName,
    original_baseline_sha: fullSha,
    last_known_good_sha: fullSha,
    candidate_sha: null,
    started_at: now,
    updated_at: now,
    model: modelConfig?.model,
    effort: modelConfig?.effort,
    total_tokens: 0,
    total_cost_usd: 0,
    termination_reason: null,
    original_branch: originalBranchName,
    error: null,
    error_phase: null,
  }

  await writeState(runDir, state)

  return { runId, runDir, state, originalBranch: originalBranchName }
}
