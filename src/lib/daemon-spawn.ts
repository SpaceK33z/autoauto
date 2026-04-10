import { open } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { generateRunId } from "./run.ts"
import { initRunDir } from "./run-setup.ts"
import { getProgramDir } from "./programs.ts"
import type { ModelSlot } from "./config.ts"
import { isWorkingTreeClean, DirtyWorkingTreeError, formatShellError } from "./git.ts"
import { createWorktree, getWorktreePath } from "./worktree.ts"
import {
  acquireLock,
  updateLockPid,
  releaseLock,
  writeRunConfig,
  type DaemonJson,
  type RunConfig,
} from "./daemon-lifecycle.ts"

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
  maxExperiments: number,
  ideasBacklogEnabled = true,
  useWorktree = true,
  carryForward = true,
  source: "manual" | "queue" = "manual",
  maxCostUsd?: number,
  keepSimplifications?: boolean,
): Promise<{ runId: string; runDir: string; worktreePath: string | null; pid: number }> {
  // 1. Check working tree
  if (!(await isWorkingTreeClean(mainRoot))) {
    throw new DirtyWorkingTreeError(mainRoot)
  }

  // 2. Generate run ID + acquire lock before creating isolated work
  const runId = generateRunId()
  const programDir = getProgramDir(mainRoot, programSlug)
  const worktreePath = useWorktree ? getWorktreePath(mainRoot, programSlug, runId) : mainRoot
  const daemonId = randomUUID()

  const locked = await acquireLock(programDir, runId, daemonId, 0, worktreePath)
  if (!locked) {
    throw new Error(`Another run is already active for program "${programSlug}". Stop it first.`)
  }

  try {
    if (useWorktree) {
      await createWorktree(mainRoot, runId, programSlug)
    } else {
      // In-place mode: create experiment branch directly in main checkout
      const { $ } = await import("bun")
      const branchName = `autoauto-${programSlug}-${runId}`
      try {
        await $`git checkout -b ${branchName}`.cwd(mainRoot).quiet()
      } catch (err) {
        throw new Error(formatShellError(err, `git checkout -b ${branchName}`), { cause: err })
      }
    }

    // 3. Init run dir in main root + write run-config.json
    const runDir = await initRunDir(programDir, runId)
    const runConfig: RunConfig = {
      provider: modelConfig.provider,
      model: modelConfig.model,
      effort: modelConfig.effort,
      max_experiments: maxExperiments,
      max_cost_usd: maxCostUsd,
      ideas_backlog_enabled: ideasBacklogEnabled,
      in_place: useWorktree ? undefined : true,
      carry_forward: carryForward,
      keep_simplifications: keepSimplifications,
      source,
    }
    await writeRunConfig(runDir, runConfig)

    // 4. Spawn detached daemon
    const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon.ts")
    const logPath = join(runDir, "daemon.log")
    const logFd = await open(logPath, "w")

    const daemonArgs = [daemonPath, "--program", programSlug, "--run-id", runId, "--main-root", mainRoot, "--worktree", worktreePath, "--daemon-id", daemonId]
    if (!useWorktree) daemonArgs.push("--in-place")

    const proc = spawn(
      "bun",
      daemonArgs,
      {
        detached: true,
        stdio: ["ignore", logFd.fd, logFd.fd],
      },
    )

    const pid = proc.pid!

    // Prevent macOS from sleeping while the daemon is running.
    // caffeinate -i -w <pid> prevents idle sleep and auto-exits when the daemon dies.
    if (process.platform === "darwin") {
      const caff = spawn("caffeinate", ["-i", "-w", String(pid)], {
        detached: true,
        stdio: "ignore",
      })
      caff.unref()
    }

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

    return { runId, runDir, worktreePath: useWorktree ? worktreePath : null, pid }
  } catch (err) {
    await releaseLock(programDir)
    throw err
  }
}
