import { watch, statSync, readFileSync, type FSWatcher } from "node:fs"
import { open } from "node:fs/promises"
import { join, dirname } from "node:path"
import { streamLogName } from "./daemon-callbacks.ts"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { RunState, ExperimentResult } from "./run.ts"
import { readAllResults, readState, getMetricHistory, generateRunId, initRunDir } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import { getProgramDir, loadProgramConfig } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import { isWorkingTreeClean } from "./git.ts"
import { createWorktree } from "./worktree.ts"
import {
  readDaemonJson,
  readRunConfig,
  writeRunConfig,
  writeControl,
  acquireLock,
  updateLockPid,
  releaseLock,
  readLock,
  type DaemonJson,
  type RunConfig,
} from "./daemon-lifecycle.ts"

// --- Types ---

export interface DaemonStatus {
  alive: boolean
  starting: boolean // daemon_id not yet written
  daemonJson: DaemonJson | null
}

export interface WatchCallbacks {
  onStateChange: (state: RunState) => void
  onResultsChange: (results: ExperimentResult[], metricHistory: number[]) => void
  onStreamChange: (text: string) => void
  onStreamReset?: () => void
  onDaemonDied: () => void
}

export interface DaemonWatcher {
  stop: () => void
}

// --- Spawn ---

/**
 * Prepares and spawns a new daemon for a run. Does everything the TUI needs
 * before handing off to the daemon:
 * 1. Checks working tree is clean
 * 2. Creates git worktree
 * 3. Initializes run directory
 * 4. Writes run-config.json
 * 5. Acquires per-program lock
 * 6. Spawns detached daemon process
 * 7. Writes initial daemon.json with PID
 *
 * Returns run metadata for the TUI to start watching.
 */
export async function spawnDaemon(
  mainRoot: string,
  programSlug: string,
  modelConfig: ModelSlot,
  maxExperiments?: number,
  ideasBacklogEnabled = true,
): Promise<{ runId: string; runDir: string; worktreePath: string; pid: number }> {
  // 1. Check working tree
  if (!(await isWorkingTreeClean(mainRoot))) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them before starting a run.")
  }

  // 2. Generate run ID + acquire lock before creating isolated work
  const runId = generateRunId()
  const programDir = getProgramDir(mainRoot, programSlug)
  const worktreePath = join(mainRoot, ".autoauto", "worktrees", runId)
  const daemonId = randomUUID()

  const locked = await acquireLock(programDir, runId, daemonId, 0, worktreePath)
  if (!locked) {
    throw new Error(`Another run is already active for program "${programSlug}". Stop it first.`)
  }

  try {
    await createWorktree(mainRoot, runId, programSlug)

    // 3. Init run dir in main root + write run-config.json
    const runDir = await initRunDir(programDir, runId)
    const runConfig: RunConfig = {
      model: modelConfig.model,
      effort: modelConfig.effort,
      max_experiments: maxExperiments,
      ideas_backlog_enabled: ideasBacklogEnabled,
    }
    await writeRunConfig(runDir, runConfig)

    // 4. Spawn detached daemon
    const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon.ts")
    const logPath = join(runDir, "daemon.log")
    const logFd = await open(logPath, "w")

    const proc = spawn(
      "bun",
      [daemonPath, "--program", programSlug, "--run-id", runId, "--main-root", mainRoot, "--worktree", worktreePath, "--daemon-id", daemonId],
      {
        detached: true,
        stdio: ["ignore", logFd.fd, logFd.fd],
      },
    )

    const pid = proc.pid!

    // 5. Write initial daemon.json. The daemon waits for this stub, then adds heartbeat_at.
    const initialDaemon: DaemonJson = {
      run_id: runId,
      pid,
      started_at: new Date().toISOString(),
      worktree_path: worktreePath,
      daemon_id: daemonId,
    }
    await Bun.write(join(runDir, "daemon.json"), JSON.stringify(initialDaemon, null, 2) + "\n")
    await updateLockPid(programDir, runId, daemonId, pid)

    proc.unref()
    await logFd.close()

    return { runId, runDir, worktreePath, pid }
  } catch (err) {
    await releaseLock(programDir)
    throw err
  }
}

// --- Daemon Status ---

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
}> {
  const [state, results, programConfig] = await Promise.all([
    readState(runDir),
    readAllResults(runDir),
    loadProgramConfig(programDir),
  ])
  const streamText = await readStreamTail(runDir, state.experiment_number)

  return {
    state,
    results,
    metricHistory: getMetricHistory(results),
    programConfig,
    streamText,
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

// --- File Watching ---

/**
 * Watches the run directory for file changes and calls back with updates.
 * Uses fs.watch on the directory (not individual files) to handle atomic renames.
 * Falls back to polling if fs.watch errors.
 */
export function watchRunDir(
  runDir: string,
  callbacks: WatchCallbacks,
  options: { startAtEnd?: boolean } = {},
): DaemonWatcher {
  let stopped = false
  let watcher: FSWatcher | null = null

  // Track byte offsets for delta reads
  let resultsByteOffset = 0
  let streamByteOffset = 0
  let currentStreamFile = "" // e.g. "stream-001.log"

  if (options.startAtEnd) {
    try {
      resultsByteOffset = statSync(join(runDir, "results.tsv")).size
    } catch {}
    // Determine current stream file from state
    try {
      const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"))
      currentStreamFile = streamLogName(state.experiment_number ?? 0)
      streamByteOffset = statSync(join(runDir, currentStreamFile)).size
    } catch {}
  }

  // Debounce: avoid reading the same file multiple times per event burst
  const pendingReads = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRead(filename: string) {
    pendingReads.add(filename)
    if (!flushTimer) {
      flushTimer = setTimeout(flushReads, 50)
    }
  }

  async function flushReads() {
    flushTimer = null
    const files = [...pendingReads]
    pendingReads.clear()
    if (stopped) return

    for (const file of files) {
      try {
        if (file === "state.json") {
          const state = await readState(runDir)
          callbacks.onStateChange(state)
        } else if (file === "results.tsv") {
          await readResultsDelta()
        } else if (file.startsWith("stream-") && file.endsWith(".log")) {
          await readStreamDelta(file)
        } else if (file === "daemon.json") {
          // Heartbeat check handled by backup timer
        }
      } catch {
        // File may be mid-write — ignore and catch next event
      }
    }
  }

  async function readResultsDelta() {
    try {
      const size = Bun.file(join(runDir, "results.tsv")).size
      if (size <= resultsByteOffset) return // no new data
      resultsByteOffset = size

      const results = await readAllResults(runDir)
      callbacks.onResultsChange(results, getMetricHistory(results))
    } catch {
      // Ignore transient errors
    }
  }

  async function readStreamDelta(file: string) {
    try {
      // New experiment file → reset stream
      if (file !== currentStreamFile) {
        currentStreamFile = file
        streamByteOffset = 0
        callbacks.onStreamReset?.()
      }

      const bunFile = Bun.file(join(runDir, file))
      const size = bunFile.size
      if (size <= streamByteOffset) return

      const delta = await bunFile.slice(streamByteOffset, size).text()
      streamByteOffset = size

      callbacks.onStreamChange(delta)
    } catch {
      // Ignore transient errors
    }
  }

  // fs.watch on the directory
  try {
    watcher = watch(runDir, (_event, filename) => {
      if (stopped || !filename || filename.endsWith(".tmp")) return
      scheduleRead(filename)
    })
    watcher.on("error", () => {
      // Fall back to polling if watcher errors
      startPolling()
    })
  } catch {
    startPolling()
  }

  // Backup heartbeat timer (5-10s)
  const heartbeatTimer = setInterval(async () => {
    if (stopped) return
    const status = await getDaemonStatus(runDir)
    if (!status.alive && !status.starting) {
      callbacks.onDaemonDied()
    }
  }, 7_000)

  // Polling fallback
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    if (pollTimer || stopped) return
    watcher?.close()
    watcher = null

    pollTimer = setInterval(() => {
      if (stopped) return
      scheduleRead("state.json")
      scheduleRead("results.tsv")
      if (currentStreamFile) scheduleRead(currentStreamFile)
    }, 300)
  }

  return {
    stop: () => {
      stopped = true
      watcher?.close()
      clearInterval(heartbeatTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (flushTimer) clearTimeout(flushTimer)
    },
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
 * Pass undefined to remove the limit (unlimited).
 */
export async function updateMaxExperiments(runDir: string, maxExperiments: number | undefined): Promise<void> {
  const config = await readRunConfig(runDir)
  if (!config || config.max_experiments === maxExperiments) return
  await writeRunConfig(runDir, { ...config, max_experiments: maxExperiments })
}

/**
 * Reads the current max_experiments from run-config.json.
 */
export async function getMaxExperiments(runDir: string): Promise<number | undefined> {
  const config = await readRunConfig(runDir)
  return config?.max_experiments
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
