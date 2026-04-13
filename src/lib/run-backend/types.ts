/**
 * RunBackend — high-level orchestration interface for running experiments.
 *
 * Local and sandbox runs implement the same lifecycle operations. The TUI/CLI
 * depends on `RunBackend`, not on transport-specific code.
 */

import type { WatchCallbacks, DaemonWatcher } from "../daemon-watcher.ts"
import type { DaemonStatus } from "../daemon-status.ts"
import type { ModelSlot } from "../config.ts"
import type { RunState, ExperimentResult } from "../run.ts"
import type { ProgramConfig } from "../programs.ts"

/** Input for spawning a new run — matches spawnDaemon parameters */
export interface SpawnRunInput {
  mainRoot: string
  programSlug: string
  modelConfig: ModelSlot
  maxExperiments: number
  ideasBacklogEnabled?: boolean
  useWorktree?: boolean
  carryForward?: boolean
  source?: "manual" | "queue"
  maxCostUsd?: number
  keepSimplifications?: boolean
  fallbackModel?: ModelSlot | null
}

/** Full state reconstructed from run files — used for attach/reconnect */
export interface ReconstructedState {
  state: RunState
  results: ExperimentResult[]
  metricHistory: number[]
  programConfig: ProgramConfig
  streamText: string
  ideasText: string
  summaryText: string
}

/** Handle for controlling and watching a running experiment loop */
export interface RunHandle {
  /** The run ID (e.g., "20260413-141530") */
  readonly runId: string

  /** The local run directory path (.autoauto/programs/<slug>/runs/<id>) */
  readonly runDir: string

  /** Start watching for state/results/stream changes */
  watch(callbacks: WatchCallbacks, options?: { startAtEnd?: boolean }): Promise<DaemonWatcher>

  /** Check daemon/process liveness */
  getStatus(): Promise<DaemonStatus>

  /** Send stop or abort signal */
  sendControl(action: "stop" | "abort"): Promise<void>

  /** Force terminate (SIGKILL / container terminate) */
  terminate(): Promise<void>

  /** Update max experiments mid-run */
  updateMaxExperiments(value: number): Promise<void>

  /** Update max cost mid-run */
  updateMaxCostUsd(value: number | undefined): Promise<void>

  /**
   * Download artifacts from remote to local filesystem.
   * For LocalRunBackend this is a no-op (files are already local).
   * For SandboxRunBackend this downloads run dir + git bundle.
   */
  materializeArtifacts(): Promise<void>

  /** Reconstruct full state from files (for attach/reconnect) */
  reconstructState(programDir: string): Promise<ReconstructedState>
}

/** Return value from findActiveRun */
export interface ActiveRun {
  runId: string
  runDir: string
  daemonAlive: boolean
}

/** The backend abstraction — local daemon or remote sandbox */
export interface RunBackend {
  /** Spawn a new run and return a handle for controlling it */
  spawn(input: SpawnRunInput): Promise<RunHandle>

  /** Find an active (locked) run for a program */
  findActiveRun(programDir: string): Promise<ActiveRun | null>
}
