import { rename, unlink, open } from "node:fs/promises"
import { join } from "node:path"
import { $ } from "bun"
import type { RunState } from "./run.ts"
import { writeState, readState, appendResult, readAllResults } from "./run.ts"
import { resetHard } from "./git.ts"
import type { ModelSlot } from "./config.ts"
import type { AgentProviderID } from "./agent/index.ts"

// --- Types ---

export interface DaemonJson {
  run_id: string
  pid: number
  started_at: string
  worktree_path: string
  daemon_id?: string
  heartbeat_at?: string
}

export interface RunConfig {
  provider?: AgentProviderID
  model: string
  effort: string
  max_experiments: number
  ideas_backlog_enabled?: boolean
  in_place?: boolean
  carry_forward?: boolean
}

export interface ControlAction {
  action: "stop" | "abort"
  timestamp: string
}

export interface RunLock {
  run_id: string
  daemon_id: string
  pid: number
  worktree_path: string
  created_at: string
}

// --- Daemon Identity ---

/**
 * Writes full daemon.json with daemon_id + heartbeat, overwriting the TUI's initial stub.
 */
export async function writeDaemonJson(
  runDir: string,
  runId: string,
  worktreePath: string,
  daemonId: string,
): Promise<string> {
  const now = new Date().toISOString()
  const existing = await readDaemonJson(runDir)
  const json: DaemonJson = {
    run_id: runId,
    pid: process.pid,
    started_at: existing?.started_at ?? now,
    worktree_path: worktreePath,
    daemon_id: daemonId,
    heartbeat_at: now,
  }
  const tmpPath = join(runDir, "daemon.json.tmp")
  await Bun.write(tmpPath, JSON.stringify(json, null, 2) + "\n")
  await rename(tmpPath, join(runDir, "daemon.json"))
  return daemonId
}

export async function waitForDaemonStub(runDir: string, daemonId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const daemon = await readDaemonJson(runDir)
    if (daemon?.daemon_id === daemonId) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export async function readDaemonJson(runDir: string): Promise<DaemonJson | null> {
  try {
    return await Bun.file(join(runDir, "daemon.json")).json() as DaemonJson
  } catch {
    return null
  }
}

/**
 * Updates heartbeat_at in daemon.json. Called every 10s by the daemon.
 */
export async function updateHeartbeat(runDir: string, daemonId: string): Promise<void> {
  const existing = await readDaemonJson(runDir)
  if (!existing || existing.daemon_id !== daemonId) return

  const updated: DaemonJson = { ...existing, heartbeat_at: new Date().toISOString() }
  const tmpPath = join(runDir, "daemon.json.tmp")
  await Bun.write(tmpPath, JSON.stringify(updated, null, 2) + "\n")
  await rename(tmpPath, join(runDir, "daemon.json"))
}

/**
 * Starts a heartbeat interval. Returns the interval handle for cleanup.
 */
export function startHeartbeat(runDir: string, daemonId: string, intervalMs = 10_000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    updateHeartbeat(runDir, daemonId).catch(() => {})
  }, intervalMs)
}

// --- Run Config ---

export async function readRunConfig(runDir: string): Promise<RunConfig | null> {
  try {
    return await Bun.file(join(runDir, "run-config.json")).json() as RunConfig
  } catch {
    return null
  }
}

export async function writeRunConfig(runDir: string, config: RunConfig): Promise<void> {
  await Bun.write(join(runDir, "run-config.json"), JSON.stringify(config, null, 2) + "\n")
}

export function runConfigToModelSlot(config: RunConfig): ModelSlot {
  return {
    provider: config.provider ?? "claude",
    model: config.model,
    effort: config.effort as ModelSlot["effort"],
  }
}

// --- Locking ---

const LOCK_FILE = "run.lock"

/**
 * Acquires a per-program lock. Uses exclusive file creation (O_EXCL) for atomicity.
 * Returns true if lock acquired, false if already locked by a live daemon.
 * Handles stale lock detection via daemon_id cross-check + heartbeat staleness.
 */
export async function acquireLock(
  programDir: string,
  runId: string,
  daemonId: string,
  pid: number,
  worktreePath: string,
): Promise<boolean> {
  const lockPath = join(programDir, LOCK_FILE)
  const lock: RunLock = {
    run_id: runId,
    daemon_id: daemonId,
    pid,
    worktree_path: worktreePath,
    created_at: new Date().toISOString(),
  }

  try {
    // O_EXCL: fail if file already exists
    const fd = await open(lockPath, "wx")
    await fd.writeFile(JSON.stringify(lock, null, 2) + "\n")
    await fd.close()
    return true
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err

    // Lock exists — check if stale
    const isStale = await isLockStale(programDir)
    if (isStale) {
      await unlink(lockPath).catch(() => {})
      // Retry once after removing stale lock
      try {
        const fd = await open(lockPath, "wx")
        await fd.writeFile(JSON.stringify(lock, null, 2) + "\n")
        await fd.close()
        return true
      } catch {
        return false
      }
    }

    return false
  }
}

export async function updateLockPid(programDir: string, runId: string, daemonId: string, pid: number): Promise<void> {
  const lockPath = join(programDir, LOCK_FILE)
  const lock = await readLock(programDir)
  if (!lock || lock.run_id !== runId || lock.daemon_id !== daemonId) return
  const updated: RunLock = { ...lock, pid }
  const tmpPath = `${lockPath}.tmp`
  await Bun.write(tmpPath, JSON.stringify(updated, null, 2) + "\n")
  await rename(tmpPath, lockPath)
}

export async function releaseLock(programDir: string): Promise<void> {
  try {
    await unlink(join(programDir, LOCK_FILE))
  } catch {
    // Lock may already be removed
  }
}

export async function readLock(programDir: string): Promise<RunLock | null> {
  try {
    return await Bun.file(join(programDir, LOCK_FILE)).json() as RunLock
  } catch {
    return null
  }
}

/**
 * Checks if an existing lock is stale. A lock is stale if:
 * - daemon.json doesn't exist in the run dir (daemon never started)
 * - daemon_id in lock doesn't match daemon_id in daemon.json
 * - heartbeat_at is older than 30s (daemon is dead regardless of PID)
 */
async function isLockStale(programDir: string): Promise<boolean> {
  const lock = await readLock(programDir)
  if (!lock) return true

  // Find the run dir from the lock's run_id
  const runDir = join(programDir, "runs", lock.run_id)
  const daemon = await readDaemonJson(runDir)
  const lockAge = Date.now() - new Date(lock.created_at).getTime()

  if (!daemon) return lockAge > 30_000 // allow daemon startup handshake
  if (daemon.daemon_id !== lock.daemon_id) return true // different daemon

  if (!daemon.heartbeat_at) return lockAge > 30_000

  if (daemon.heartbeat_at) {
    const heartbeatAge = Date.now() - new Date(daemon.heartbeat_at).getTime()
    if (heartbeatAge > 30_000) return true // heartbeat stale — daemon is dead
  }

  return false
}

// --- Control ---

export async function readControl(runDir: string): Promise<ControlAction | null> {
  try {
    return await Bun.file(join(runDir, "control.json")).json() as ControlAction
  } catch {
    return null
  }
}

export async function writeControl(runDir: string, action: ControlAction): Promise<void> {
  await Bun.write(join(runDir, "control.json"), JSON.stringify(action, null, 2) + "\n")
}

// --- Crash Recovery ---

/**
 * Handles crash recovery on daemon startup. Reads state.json and cleans up
 * any in-flight operation by restoring the worktree to a known-good state.
 *
 * Returns the recovered state, or null if no recovery was needed.
 */
export async function recoverFromCrash(
  runDir: string,
  worktreePath: string,
): Promise<RunState | null> {
  let state: RunState
  try {
    state = await readState(runDir)
  } catch {
    return null // no state.json — first run, no recovery needed
  }

  const phase = state.phase

  // Terminal states — no recovery needed
  if (phase === "complete" || phase === "crashed") return null

  // Clean states — can resume. "stopping" means the previous daemon accepted a stop,
  // so do not silently restart work.
  if (phase === "idle" || phase === "kept") return state
  if (phase === "stopping") {
    const stoppedState: RunState = {
      ...state,
      phase: "complete",
      termination_reason: "stopped",
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, stoppedState)
    return null
  }

  // In-flight states — need cleanup
  if (phase === "baseline") {
    // Baseline was interrupted. Nothing to recover.
    const crashedState: RunState = {
      ...state,
      phase: "crashed",
      error: "baseline measurement interrupted by crash",
      error_phase: "baseline",
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, crashedState)
    return null
  }

  // agent_running, measuring, reverting — restore worktree to last known good
  if (state.last_known_good_sha) {
    await resetHard(worktreePath, state.last_known_good_sha)
  }

  const results = await readAllResults(runDir).catch(() => [])
  const alreadyLogged = results.some((r) => r.experiment_number === state.experiment_number && r.status === "crash")
  if (!alreadyLogged && state.experiment_number > 0) {
    await appendResult(runDir, {
      experiment_number: state.experiment_number,
      commit: (state.candidate_sha ?? state.last_known_good_sha ?? "").slice(0, 7),
      metric_value: state.current_baseline,
      secondary_values: "",
      status: "crash",
      description: `daemon recovered interrupted ${phase}`,
      measurement_duration_ms: 0,
    })
  }

  const recoveredState: RunState = {
    ...state,
    phase: "idle",
    candidate_sha: null,
    total_crashes: alreadyLogged ? state.total_crashes : state.total_crashes + 1,
    error: `recovered interrupted ${phase}`,
    error_phase: phase,
    updated_at: new Date().toISOString(),
  }
  await writeState(runDir, recoveredState)

  return recoveredState
}

// --- Child Process Cleanup ---

export async function killChildProcessTree(parentPid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const stdout = await $`ps -axo pid=,ppid=`.nothrow().text()
  const childrenByParent = new Map<number, number[]>()

  for (const line of stdout.split("\n")) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/)
    const pid = Number(pidRaw)
    const ppid = Number(ppidRaw)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const children = childrenByParent.get(ppid) ?? []
    children.push(pid)
    childrenByParent.set(ppid, children)
  }

  const children: number[] = []
  const stack = [...(childrenByParent.get(parentPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    children.push(pid)
    stack.push(...(childrenByParent.get(pid) ?? []))
  }

  for (const pid of children.toReversed()) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already exited.
    }
  }
}
