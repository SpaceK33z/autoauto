import { readFile, writeFile, appendFile, rename, mkdir, chmod, readdir } from "node:fs/promises"
import { join } from "node:path"
import { getProgramDir, loadProgramConfig } from "./programs.ts"
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
  last_known_good_sha: string
  candidate_sha: string | null
  started_at: string
  updated_at: string
}

/** A single row in results.tsv */
export interface ExperimentResult {
  experiment_number: number
  commit: string
  metric_value: number
  secondary_values: string
  status: ExperimentStatus
  description: string
}

// --- Run ID ---

const pad = (n: number) => String(n).padStart(2, "0")

export function generateRunId(): string {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// --- Evaluator Locking ---

/** Makes measure.sh and config.json read-only (chmod 444). #1 safeguard against metric gaming. */
export async function lockEvaluator(programDir: string): Promise<void> {
  await chmod(join(programDir, "measure.sh"), 0o444)
  await chmod(join(programDir, "config.json"), 0o444)
}

export async function unlockEvaluator(programDir: string): Promise<void> {
  await chmod(join(programDir, "measure.sh"), 0o644)
  await chmod(join(programDir, "config.json"), 0o644)
}

// --- Run Directory ---

export async function initRunDir(programDir: string, runId: string): Promise<string> {
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  await writeFile(
    join(runDir, "results.tsv"),
    "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\n",
  )

  // Initialize events.ndjson as empty file
  await writeFile(join(runDir, "events.ndjson"), "")

  return runDir
}

// --- State Persistence ---

/** Atomically writes state.json via temp-file + rename. */
export async function writeState(runDir: string, state: RunState): Promise<void> {
  const tmpPath = join(runDir, "state.json.tmp")
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n")
  await rename(tmpPath, join(runDir, "state.json"))
}

export async function readState(runDir: string): Promise<RunState> {
  const raw = await readFile(join(runDir, "state.json"), "utf-8")
  return JSON.parse(raw) as RunState
}

// --- Results ---

export async function appendResult(runDir: string, result: ExperimentResult): Promise<void> {
  const secondaryStr = result.secondary_values || ""
  const line = `${result.experiment_number}\t${result.commit}\t${result.metric_value}\t${secondaryStr}\t${result.status}\t${result.description}\n`
  await appendFile(join(runDir, "results.tsv"), line)
}

// --- Results Parsing (synchronous — operate on pre-read content) ---

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

  const lastLine = lines[lines.length - 1]
  const parts = lastLine.split("\t")
  if (parts.length < 6) return null

  return {
    experiment_number: parseInt(parts[0], 10),
    commit: parts[1],
    metric_value: parseFloat(parts[2]),
    secondary_values: parts[3],
    status: parts[4] as ExperimentStatus,
    description: parts[5],
  }
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
  const raw = await readFile(join(runDir, "results.tsv"), "utf-8")
  const lines = raw.trim().split("\n")
  if (lines.length <= 1) return [] // only header

  const results: ExperimentResult[] = []
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t")
    if (parts.length < 6) continue
    results.push({
      experiment_number: parseInt(parts[0], 10),
      commit: parts[1],
      metric_value: parseFloat(parts[2]),
      secondary_values: parts[3],
      status: parts[4] as ExperimentStatus,
      description: parts[5],
    })
  }
  return results
}

/** Extracts metric values from keep results for sparkline/chart rendering. */
export function getMetricHistory(results: ExperimentResult[]): number[] {
  return results
    .filter((r) => r.status === "keep")
    .map((r) => r.metric_value)
}

/** Derived statistics from results + state for the TUI dashboard. */
export interface RunStats {
  total_experiments: number
  total_keeps: number
  total_discards: number
  total_crashes: number
  keep_rate: number
  improvement_pct: number
  current_improvement_pct: number
  metric_direction: "lower" | "higher" | null
}

/** Computes derived statistics from results + state. */
export function getRunStats(results: ExperimentResult[], state: RunState): RunStats {
  const experiments = results.filter((r) => r.experiment_number > 0)
  const keeps = experiments.filter((r) => r.status === "keep")
  const discards = experiments.filter((r) => r.status === "discard")
  const crashes = experiments.filter((r) => r.status === "crash" || r.status === "measurement_failure")

  const total = experiments.length

  const improvementPct = state.original_baseline !== 0
    ? ((state.best_metric - state.original_baseline) / Math.abs(state.original_baseline)) * 100
    : 0

  const currentImprovementPct = state.original_baseline !== 0
    ? ((state.current_baseline - state.original_baseline) / Math.abs(state.original_baseline)) * 100
    : 0

  return {
    total_experiments: total,
    total_keeps: keeps.length,
    total_discards: discards.length,
    total_crashes: crashes.length,
    keep_rate: total > 0 ? keeps.length / total : 0,
    improvement_pct: improvementPct,
    current_improvement_pct: currentImprovementPct,
    metric_direction: null,
  }
}

// --- Run Listing ---

/** Metadata for a run, used in list views. */
export interface RunInfo {
  run_id: string
  run_dir: string
  state: RunState | null
  started_at: string | null
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

  const runs: RunInfo[] = []
  for (const runId of entries) {
    const runDir = join(runsDir, runId)
    let state: RunState | null = null
    try {
      state = await readState(runDir)
    } catch {
      // state.json missing or corrupt
    }
    runs.push({
      run_id: runId,
      run_dir: runDir,
      state,
      started_at: state?.started_at ?? null,
    })
  }

  runs.sort((a, b) => b.run_id.localeCompare(a.run_id))
  return runs
}

/** Returns the most recent run for a program. */
export async function getLatestRun(programDir: string): Promise<RunInfo | null> {
  const runs = await listRuns(programDir)
  return runs.length > 0 ? runs[0] : null
}

// --- High-Level Orchestration ---

export async function startRun(
  projectRoot: string,
  programSlug: string,
): Promise<{ runId: string; runDir: string; state: RunState }> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const measureShPath = join(programDir, "measure.sh")

  const config = await loadProgramConfig(programDir)

  if (!(await isWorkingTreeClean(projectRoot))) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them before starting a run.")
  }

  const originalBranchName = await getCurrentBranch(projectRoot)

  const runId = generateRunId()
  const branchName = await createExperimentBranch(projectRoot, programSlug, runId)

  const runDir = await initRunDir(programDir, runId)

  await lockEvaluator(programDir)

  const cleanup = async () => {
    await unlockEvaluator(programDir)
    await checkoutBranch(projectRoot, originalBranchName).catch(() => {})
  }

  const baseline = await runMeasurementSeries(measureShPath, projectRoot, config)

  if (!baseline.success) {
    await cleanup()
    throw new Error(
      `Baseline measurement failed: ${baseline.individual_runs.map((r) => (r.success ? "ok" : r.error)).join(", ")}`,
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
    last_known_good_sha: fullSha,
    candidate_sha: null,
    started_at: now,
    updated_at: now,
  }

  await writeState(runDir, state)

  return { runId, runDir, state }
}
