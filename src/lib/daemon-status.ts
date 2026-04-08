import { join } from "node:path"
import { streamLogName } from "./daemon-callbacks.ts"
import type { RunState, ExperimentResult } from "./run.ts"
import { readAllResults, readState, getMetricHistory } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import { loadProgramConfig } from "./programs.ts"
import {
  readDaemonJson,
  readRunConfig,
  writeRunConfig,
  writeControl,
  readLock,
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
}> {
  const [state, results, programConfig] = await Promise.all([
    readState(runDir),
    readAllResults(runDir),
    loadProgramConfig(programDir),
  ])
  const [streamText, ideasText] = await Promise.all([
    readStreamTail(runDir, state.experiment_number),
    Bun.file(join(runDir, "ideas.md")).text().catch(() => ""),
  ])

  return {
    state,
    results,
    metricHistory: getMetricHistory(results),
    programConfig,
    streamText,
    ideasText,
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
