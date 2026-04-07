import { readFile, writeFile, appendFile, rename, mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { getProgramDir } from "./programs.ts"
import type { ProgramConfig } from "./programs.ts"
import { runMeasurementSeries } from "./measure.ts"
import { getCurrentSha, getFullSha } from "./git.ts"

const execFileAsync = promisify(execFile)

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

/** Returns a timestamp string like "20260407-143022". */
export function generateRunId(): string {
  const now = new Date()
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

// --- Branch Management ---

/** Creates a dedicated git branch from current HEAD for the experiment run. */
export async function createExperimentBranch(
  projectRoot: string,
  programSlug: string,
  runId: string,
): Promise<string> {
  const branchName = `autoauto-${programSlug}-${runId}`

  try {
    await execFileAsync("git", ["checkout", "-b", branchName], { cwd: projectRoot })
  } catch (err) {
    throw new Error(
      `Failed to create branch "${branchName}" — was a previous run interrupted? ` +
        `Delete it with \`git branch -D ${branchName}\` to proceed.`,
      { cause: err },
    )
  }

  return branchName
}

// --- Config ---

/** Reads and validates config.json from the program directory. */
export async function loadProgramConfig(programDir: string): Promise<ProgramConfig> {
  const raw = await readFile(join(programDir, "config.json"), "utf-8")
  const config = JSON.parse(raw) as Record<string, unknown>

  if (!config.metric_field || typeof config.metric_field !== "string") {
    throw new Error("config.json: metric_field must be a non-empty string")
  }
  if (config.direction !== "lower" && config.direction !== "higher") {
    throw new Error('config.json: direction must be "lower" or "higher"')
  }
  if (typeof config.noise_threshold !== "number" || !isFinite(config.noise_threshold) || config.noise_threshold <= 0) {
    throw new Error("config.json: noise_threshold must be a finite positive number")
  }
  if (typeof config.repeats !== "number" || !Number.isInteger(config.repeats) || config.repeats < 1) {
    throw new Error("config.json: repeats must be an integer >= 1")
  }
  if (typeof config.quality_gates !== "object" || config.quality_gates === null || Array.isArray(config.quality_gates)) {
    throw new Error("config.json: quality_gates must be an object")
  }

  return config as unknown as ProgramConfig
}

// --- Evaluator Locking ---

/** Makes measure.sh and config.json read-only (chmod 444). #1 safeguard against metric gaming. */
export async function lockEvaluator(programDir: string): Promise<void> {
  await chmod(join(programDir, "measure.sh"), 0o444)
  await chmod(join(programDir, "config.json"), 0o444)
}

/** Restores write permissions (chmod 644) — called on run completion/cleanup. */
export async function unlockEvaluator(programDir: string): Promise<void> {
  await chmod(join(programDir, "measure.sh"), 0o644)
  await chmod(join(programDir, "config.json"), 0o644)
}

// --- Run Directory ---

/** Creates the run directory structure and initializes files. */
export async function initRunDir(programDir: string, runId: string): Promise<string> {
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  // Initialize results.tsv with header row
  await writeFile(
    join(runDir, "results.tsv"),
    "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\n",
  )

  return runDir
}

// --- State Persistence ---

/** Atomically writes state.json via temp-file + rename. */
export async function writeState(runDir: string, state: RunState): Promise<void> {
  const tmpPath = join(runDir, "state.json.tmp")
  await writeFile(tmpPath, JSON.stringify(state, null, 2) + "\n")
  await rename(tmpPath, join(runDir, "state.json"))
}

/** Reads and parses state.json. */
export async function readState(runDir: string): Promise<RunState> {
  const raw = await readFile(join(runDir, "state.json"), "utf-8")
  return JSON.parse(raw) as RunState
}

// --- Results ---

/** Appends a single row to results.tsv. */
export async function appendResult(runDir: string, result: ExperimentResult): Promise<void> {
  const secondaryStr = result.secondary_values || ""
  const line = `${result.experiment_number}\t${result.commit}\t${result.metric_value}\t${secondaryStr}\t${result.status}\t${result.description}\n`
  await appendFile(join(runDir, "results.tsv"), line)
}

// --- High-Level Orchestration ---

/**
 * Orchestrates the full run setup sequence:
 * 1. Load and validate program config
 * 2. Check for clean working tree
 * 3. Create experiment branch
 * 4. Initialize run directory
 * 5. Lock evaluator
 * 6. Establish baseline measurement
 * 7. Record baseline in results.tsv
 * 8. Write initial state
 */
export async function startRun(
  projectRoot: string,
  programSlug: string,
): Promise<{ runId: string; runDir: string; state: RunState }> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const measureShPath = join(programDir, "measure.sh")

  // 1. Load and validate program config
  const config = await loadProgramConfig(programDir)

  // 2. Check for clean working tree — uncommitted changes would contaminate baseline
  const { stdout: statusOutput } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: projectRoot,
  })
  if (statusOutput.trim()) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them before starting a run.")
  }

  // 3. Record original branch so we can restore on failure
  const { stdout: originalBranch } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: projectRoot },
  )
  const originalBranchName = originalBranch.trim()

  // 4. Generate run ID and create branch
  const runId = generateRunId()
  const branchName = await createExperimentBranch(projectRoot, programSlug, runId)

  // 5. Initialize run directory and files
  const runDir = await initRunDir(programDir, runId)

  // 6. Lock the evaluator (measure.sh + config.json)
  await lockEvaluator(programDir)

  // 7. Establish baseline — run measurement series
  const baseline = await runMeasurementSeries(measureShPath, projectRoot, config)

  if (!baseline.success) {
    await unlockEvaluator(programDir)
    await execFileAsync("git", ["checkout", originalBranchName], { cwd: projectRoot }).catch(
      () => {},
    )
    throw new Error(
      `Baseline measurement failed: ${baseline.individual_runs.map((r) => (r.success ? "ok" : r.error)).join(", ")}`,
    )
  }

  if (!baseline.quality_gates_passed) {
    await unlockEvaluator(programDir)
    await execFileAsync("git", ["checkout", originalBranchName], { cwd: projectRoot }).catch(
      () => {},
    )
    throw new Error(`Baseline quality gates failed: ${baseline.gate_violations.join(", ")}`)
  }

  // 8. Record baseline in results.tsv
  const sha = await getCurrentSha(projectRoot)
  const secondaryValues = JSON.stringify(baseline.median_quality_gates)

  await appendResult(runDir, {
    experiment_number: 0,
    commit: sha,
    metric_value: baseline.median_metric,
    secondary_values: secondaryValues,
    status: "keep",
    description: "baseline",
  })

  // 9. Write initial state
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
    last_known_good_sha: await getFullSha(projectRoot),
    candidate_sha: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  await writeState(runDir, state)

  return { runId, runDir, state }
}
