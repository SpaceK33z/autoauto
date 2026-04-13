/**
 * LocalRunBackend — thin adapter wrapping existing daemon functions.
 *
 * Every method is pure delegation. Zero behavioral changes.
 */

import type { RunBackend, RunHandle, SpawnRunInput, ActiveRun, ReconstructedState } from "./types.ts"
import type { WatchCallbacks, DaemonWatcher } from "../daemon-watcher.ts"
import type { DaemonStatus } from "../daemon-status.ts"
import { spawnDaemon } from "../daemon-spawn.ts"
import { watchRunDir } from "../daemon-watcher.ts"
import {
  getDaemonStatus,
  reconstructState as _reconstructState,
  sendStop,
  sendAbort,
  forceKillDaemon,
  updateMaxExperiments as _updateMaxExperiments,
  updateMaxCostUsd as _updateMaxCostUsd,
  findActiveRun as _findActiveRun,
} from "../daemon-status.ts"

class LocalRunHandle implements RunHandle {
  readonly runId: string
  readonly runDir: string

  constructor(runId: string, runDir: string) {
    this.runId = runId
    this.runDir = runDir
  }

  async watch(callbacks: WatchCallbacks, options?: { startAtEnd?: boolean }): Promise<DaemonWatcher> {
    return watchRunDir(this.runDir, callbacks, options)
  }

  async getStatus(): Promise<DaemonStatus> {
    return getDaemonStatus(this.runDir)
  }

  async sendControl(action: "stop" | "abort"): Promise<void> {
    if (action === "stop") {
      await sendStop(this.runDir)
    } else {
      await sendAbort(this.runDir)
    }
  }

  async terminate(): Promise<void> {
    await forceKillDaemon(this.runDir)
  }

  async updateMaxExperiments(value: number): Promise<void> {
    await _updateMaxExperiments(this.runDir, value)
  }

  async updateMaxCostUsd(value: number | undefined): Promise<void> {
    await _updateMaxCostUsd(this.runDir, value)
  }

  async materializeArtifacts(): Promise<void> {
    // No-op for local backend — files are already on the local filesystem
  }

  async reconstructState(programDir: string): Promise<ReconstructedState> {
    return _reconstructState(this.runDir, programDir)
  }
}

export class LocalRunBackend implements RunBackend {
  async spawn(input: SpawnRunInput): Promise<RunHandle> {
    const result = await spawnDaemon(
      input.mainRoot,
      input.programSlug,
      input.modelConfig,
      input.maxExperiments,
      input.ideasBacklogEnabled,
      input.useWorktree,
      input.carryForward,
      input.source,
      input.maxCostUsd,
      input.keepSimplifications,
      input.fallbackModel,
    )
    return new LocalRunHandle(result.runId, result.runDir)
  }

  async findActiveRun(programDir: string): Promise<ActiveRun | null> {
    return _findActiveRun(programDir)
  }
}
