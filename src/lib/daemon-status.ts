import { join } from "node:path"
import { rm } from "node:fs/promises"
import { $ } from "bun"
import { streamLogName } from "./daemon-callbacks.ts"
import type { RunState, ExperimentResult, RunInfo } from "./run.ts"
import { readAllResults, readState, getMetricHistory, backfillFinalizedAt, listRuns, isRunActive, writeState } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import { loadProgramConfig, getProgramDir } from "./programs.ts"
import {
  readDaemonJson,
  readRunConfig,
  writeRunConfig,
  writeControl,
  readLock,
  releaseLock,
  type DaemonJson,
} from "./daemon-lifecycle.ts"

export interface DaemonStatus {
  alive: boolean
  starting: boolean // daemon_id not yet written
  daemonJson: DaemonJson | null
}

/**
 * Checks if a daemon is alive for a given run directory.
 */
export async function getDaemonStatus(runDir: string): Promise<DaemonStatus> {
  const daemon = await readDaemonJson(runDir)

  if (!daemon) {
    return { alive: false, starting: false, daemonJson: null }
  }

  // No daemon_id = daemon hasn't started yet (TUI wrote initial stub)
  if (!daemon.daemon_id) {
    // Check if PID is still alive
    try {
      process.kill(daemon.pid, 0)
      return { alive: true, starting: true, daemonJson: daemon }
    } catch {
      return { alive: false, starting: false, daemonJson: daemon }
    }
  }

  if (!daemon.heartbeat_at) {
    const startupAge = Date.now() - new Date(daemon.started_at).getTime()
    try {
      process.kill(daemon.pid, 0)
      return { alive: startupAge <= 30_000, starting: startupAge <= 30_000, daemonJson: daemon }
    } catch {
      return { alive: false, starting: false, daemonJson: daemon }
    }
  }

  // Check heartbeat staleness
  if (daemon.heartbeat_at) {
    const heartbeatAge = Date.now() - new Date(daemon.heartbeat_at).getTime()
    if (heartbeatAge > 30_000) {
      return { alive: false, starting: false, daemonJson: daemon }
    }
  }

  // Heartbeat is fresh, but verify the process is actually alive.
  // The daemon may have crashed right after writing a heartbeat.
  try {
    process.kill(daemon.pid, 0)
  } catch {
    return { alive: false, starting: false, daemonJson: daemon }
  }

  return { alive: true, starting: false, daemonJson: daemon }
}

// --- State Reconstruction ---

/**
 * Reconstructs the full TUI state from files on disk. Used for attach mode
 * and reconnection after terminal close/reopen.
 */
export async function reconstructState(runDir: string, programDir: string): Promise<{
  state: RunState
  results: ExperimentResult[]
  metricHistory: number[]
  programConfig: ProgramConfig
  streamText: string
  ideasText: string
  summaryText: string
}> {
  const [state, results, programConfig] = await Promise.all([
    readState(runDir),
    readAllResults(runDir),
    loadProgramConfig(programDir),
  ])
  const [streamText, ideasText, summaryText] = await Promise.all([
    readStreamTail(runDir, state.experiment_number),
    Bun.file(join(runDir, "ideas.md")).text().catch(() => ""),
    Bun.file(join(runDir, "summary.md")).text().catch(() => ""),
  ])

  backfillFinalizedAt(state, Boolean(summaryText))

  return {
    state,
    results,
    metricHistory: getMetricHistory(results),
    programConfig,
    streamText,
    ideasText,
    summaryText,
  }
}

async function readStreamTail(runDir: string, experimentNumber: number): Promise<string> {
  try {
    const filename = streamLogName(experimentNumber)
    const content = await Bun.file(join(runDir, filename)).text()
    // Same truncation as ExecutionScreen: keep last ~6KB
    return content.length > 8000 ? content.slice(-6000) : content
  } catch {
    return ""
  }
}

// --- Control ---

async function sendControlSignal(runDir: string, action: "stop" | "abort"): Promise<void> {
  const daemon = await readDaemonJson(runDir)
  if (!daemon) return

  await writeControl(runDir, { action, timestamp: new Date().toISOString() })

  try {
    process.kill(daemon.pid, "SIGTERM")
  } catch {
    // Process may already be dead
  }
}

export async function sendStop(runDir: string): Promise<void> {
  return sendControlSignal(runDir, "stop")
}

export async function sendAbort(runDir: string): Promise<void> {
  return sendControlSignal(runDir, "abort")
}

/**
 * Force-kills the daemon (SIGKILL). Used as escalation after abort timeout.
 */
export async function forceKillDaemon(runDir: string): Promise<void> {
  const daemon = await readDaemonJson(runDir)
  if (!daemon) return

  try {
    process.kill(daemon.pid, "SIGKILL")
  } catch {
    // Process may already be dead
  }
}

// --- Run Config Updates ---

/**
 * Updates max_experiments in run-config.json. The daemon re-reads this file
 * at each iteration boundary, so the change takes effect after the current experiment.
 * Must be a positive integer.
 */
export async function updateMaxExperiments(runDir: string, maxExperiments: number): Promise<void> {
  const config = await readRunConfig(runDir)
  if (!config || config.max_experiments === maxExperiments) return
  await writeRunConfig(runDir, { ...config, max_experiments: maxExperiments })
}

/**
 * Reads the current max_experiments from run-config.json.
 */
export async function getMaxExperiments(runDir: string): Promise<number | null> {
  const config = await readRunConfig(runDir)
  return config?.max_experiments ?? null
}

/**
 * Updates max_cost_usd in run-config.json. The daemon re-reads this file
 * at each iteration boundary, so the change takes effect after the current experiment.
 */
export async function updateMaxCostUsd(runDir: string, maxCostUsd: number | undefined): Promise<void> {
  const config = await readRunConfig(runDir)
  if (!config) return
  await writeRunConfig(runDir, { ...config, max_cost_usd: maxCostUsd })
}

/**
 * Reads the current max_cost_usd from run-config.json.
 */
export async function getMaxCostUsd(runDir: string): Promise<number | undefined> {
  const config = await readRunConfig(runDir)
  return config?.max_cost_usd
}

// --- Daemon Log ---

/**
 * Read the last ~2KB of daemon.log for error context when daemon dies.
 * Returns empty string if the log doesn't exist or is empty.
 */
export async function readDaemonLogTail(runDir: string): Promise<string> {
  try {
    const file = Bun.file(join(runDir, "daemon.log"))
    const size = file.size
    if (size === 0) return ""
    const tail = size > 2048
      ? await file.slice(size - 2048, size).text()
      : await file.text()
    return tail.trim()
  } catch {
    return ""
  }
}

// --- Active Run Detection ---

/**
 * Finds the active run for a program, if any. Checks the lock file first,
 * then verifies the daemon is actually alive.
 */
export async function findActiveRun(programDir: string): Promise<{
  runId: string
  runDir: string
  daemonAlive: boolean
} | null> {
  const lock = await readLock(programDir)
  if (!lock) return null

  const runDir = join(programDir, "runs", lock.run_id)
  const status = await getDaemonStatus(runDir)

  return {
    runId: lock.run_id,
    runDir,
    daemonAlive: status.alive,
  }
}

/**
 * Abort and delete all active runs for a program.
 * Used when a queue entry is deleted to clean up any run that was
 * auto-started from the queue before the user could cancel it.
 */
export async function abortAndDeleteActiveRuns(
  projectRoot: string,
  programSlug: string,
): Promise<void> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const runs = await listRuns(programDir)
  const activeRuns = runs.filter(isRunActive)

  for (const run of activeRuns) {
    await forceKillDaemon(run.run_dir)

    const state = run.state
    if (state?.worktree_path && !state?.in_place) {
      await $`git worktree remove --force ${state.worktree_path}`.cwd(projectRoot).nothrow().quiet()
    }
    if (state?.branch_name) {
      await $`git branch -D ${state.branch_name}`.cwd(projectRoot).nothrow().quiet()
    }

    await rm(run.run_dir, { recursive: true, force: true })
  }

  await releaseLock(programDir)
}

// --- Stale Run Cleanup ---

/**
 * Detects runs that appear active but whose daemon is dead, and marks them
 * as crashed. Called from loadHomeData to clean up after daemon crashes that
 * happened while the TUI wasn't watching (e.g. TUI was closed).
 *
 * Only acts when daemon.json exists (proving a daemon once started). Runs
 * with no daemon.json are left untouched — they may be test fixtures or in
 * a startup race.
 *
 * @param programDir - The program directory (used for lock release)
 * @param runs - All runs for the program (mutated in-place if cleaned up)
 */
export async function cleanupStaleRuns(programDir: string, runs: RunInfo[]): Promise<void> {
  let cleaned = false

  for (const run of runs) {
    if (!isRunActive(run) || !run.state) continue

    const status = await getDaemonStatus(run.run_dir)
    // Only clean up if daemon.json exists (daemon once started) and is now dead
    if (status.alive || status.starting || !status.daemonJson) continue

    // Daemon is dead but state is non-terminal — mark as crashed
    const logTail = await readDaemonLogTail(run.run_dir)
    const crashedState: RunState = {
      ...run.state,
      phase: "crashed",
      error: logTail || "Daemon died unexpectedly",
      error_phase: run.state.phase,
      updated_at: new Date().toISOString(),
    }
    await writeState(run.run_dir, crashedState)
    run.state = crashedState // update in-place so callers see the fix
    cleaned = true
  }

  if (cleaned) {
    // Release program lock if no more active runs remain
    const stillActive = runs.some((r) => isRunActive(r))
    if (!stillActive) {
      await releaseLock(programDir)
    }
  }
}
