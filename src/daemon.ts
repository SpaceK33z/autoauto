/**
 * AutoAuto Daemon — background experiment loop runner.
 *
 * Spawned by the TUI as a detached process. Runs the experiment loop
 * inside a git worktree, writes state to files in the main .autoauto/ dir.
 *
 * Usage:
 *   bun <path>/daemon.ts --program <slug> --run-id <id> --main-root <path> --worktree <path>
 */

import { join } from "node:path"
import { closeProviders } from "./lib/agent/index.ts"
import { registerDefaultProviders } from "./lib/agent/default-providers.ts"
import { loadProgramConfig } from "./lib/programs.ts"
import { readState, writeState, appendResult, serializeSecondaryValues } from "./lib/run.ts"
import { lockMeasurement, unlockMeasurement } from "./lib/run-setup.ts"
import type { RunState } from "./lib/run.ts"
import { runExperimentLoop } from "./lib/experiment-loop.ts"
import { runMeasurementSeries } from "./lib/measure.ts"
import { getFullSha, getCurrentBranch, formatShellError } from "./lib/git.ts"
import { loadProjectConfig, getNotificationCommand } from "./lib/config.ts"
import { sendNotification } from "./lib/notify.ts"
import { createFileCallbacks } from "./lib/daemon-callbacks.ts"
import {
  writeDaemonJson,
  startHeartbeat,
  readRunConfig,
  runConfigToFallbackSlot,
  runConfigToActiveSlot,
  readControl,
  releaseLock,
  recoverFromCrash,
  waitForDaemonStub,
  killChildProcessTree,
} from "./lib/daemon-lifecycle.ts"
import { startNextFromQueue } from "./lib/queue.ts"
import { removeWorktree } from "./lib/worktree.ts"

// --- Parse CLI args ---

function parseArgs(args: string[]): { programSlug: string; runId: string; mainRoot: string; worktreePath: string; daemonId: string; inPlace: boolean } {
  const inPlace = args.includes("--in-place")
  // Remove --in-place before key-value parsing (it's a boolean flag)
  const kvArgs = args.filter((a) => a !== "--in-place")
  const map = new Map<string, string>()

  for (let i = 0; i < kvArgs.length; i += 2) {
    const key = kvArgs[i]?.replace(/^--/, "")
    const val = kvArgs[i + 1]
    if (key && val) map.set(key, val)
  }

  const programSlug = map.get("program")
  const runId = map.get("run-id")
  const mainRoot = map.get("main-root")
  const worktreePath = map.get("worktree")
  const daemonId = map.get("daemon-id")

  if (!programSlug || !runId || !mainRoot || !worktreePath || !daemonId) {
    process.stderr.write("Usage: daemon.ts --program <slug> --run-id <id> --main-root <path> --worktree <path> --daemon-id <id> [--in-place]\n")
    process.exit(1)
  }

  return { programSlug, runId, mainRoot, worktreePath, daemonId, inPlace }
}

// --- Main ---

export async function startDaemon(args = process.argv.slice(2)) {
  registerDefaultProviders()
  const { programSlug, runId, mainRoot, worktreePath, daemonId, inPlace } = parseArgs(args)
  const programDir = join(mainRoot, ".autoauto", "programs", programSlug)
  const runDir = join(programDir, "runs", runId)

  // 1. Write daemon.json with daemon_id + heartbeat
  await waitForDaemonStub(runDir, daemonId)
  await writeDaemonJson(runDir, runId, worktreePath, daemonId)
  const heartbeatInterval = startHeartbeat(runDir, daemonId)

  // 2. Read per-run config
  const runConfig = await readRunConfig(runDir)
  const modelConfig = runConfig ? runConfigToActiveSlot(runConfig) : { provider: "claude" as const, model: "sonnet", effort: "high" as const }
  const fallbackModel = runConfig ? runConfigToFallbackSlot(runConfig) : null
  if (!runConfig?.max_experiments) throw new Error("run-config.json must specify max_experiments")
  const maxExperiments = runConfig.max_experiments
  const maxCostUsd = runConfig?.max_cost_usd
  const ideasBacklogEnabled = runConfig?.ideas_backlog_enabled ?? true
  const carryForward = runConfig?.carry_forward ?? true
  const source = runConfig?.source ?? "manual"

  // 3. Stop/abort signals
  let stopRequested = false
  const abortController = new AbortController()

  process.on("SIGTERM", async () => {
    const control = await readControl(runDir)
    if (control?.action === "abort") {
      abortController.abort()
      setTimeout(() => {
        killChildProcessTree(process.pid).catch(() => {})
      }, 3_000).unref()
    } else {
      // Default: stop after current experiment
      stopRequested = true
    }
  })

  try {
    // 5. Crash recovery
    const recoveredState = await recoverFromCrash(runDir, worktreePath)

    if (recoveredState === null) {
      // Either first run (no state.json yet) or crashed during baseline.
      // Check if state.json exists and is in crashed state
      let existingState: RunState | null = null
      try {
        existingState = await readState(runDir)
      } catch {
        // No state.json — first run
      }

      if (existingState?.phase === "crashed") {
        // Baseline crash — nothing we can do
        process.stderr.write(`Run crashed during ${existingState.error_phase}: ${existingState.error}\n`)
        return
      }

      // 6. Fresh run: write initial state with phase: "baseline"
      const config = await loadProgramConfig(programDir)
      const originalBranch = await getCurrentBranch(mainRoot)
      const now = new Date().toISOString()

      const baselineState: RunState = {
        run_id: runId,
        program_slug: programSlug,
        phase: "baseline",
        experiment_number: 0,
        original_baseline: 0,
        current_baseline: 0,
        best_metric: 0,
        best_experiment: 0,
        total_keeps: 0,
        total_discards: 0,
        total_crashes: 0,
        branch_name: `autoauto-${programSlug}-${runId}`,
        original_baseline_sha: "",
        last_known_good_sha: "",
        candidate_sha: null,
        started_at: now,
        updated_at: now,
        model: modelConfig.model,
        provider: modelConfig.provider,
        effort: modelConfig.effort,
        total_tokens: 0,
        total_cost_usd: 0,
        termination_reason: null,
        original_branch: originalBranch,
        worktree_path: worktreePath,
        in_place: inPlace || undefined,
        error: null,
        error_phase: null,
        source,
      }
      await writeState(runDir, baselineState)

      // 7. Lock measurement files + run baseline
      await lockMeasurement(programDir)

      const measureShPath = join(programDir, "measure.sh")
      const buildShPath = join(programDir, "build.sh")
      const baseline = await runMeasurementSeries(measureShPath, worktreePath, config, abortController.signal, buildShPath)

      if (!baseline.success) {
        // If aborted by user, treat as a clean abort — not a crash
        if (abortController.signal.aborted) {
          const abortedState: RunState = {
            ...baselineState,
            phase: "complete",
            termination_reason: "aborted",
            updated_at: new Date().toISOString(),
          }
          await writeState(runDir, abortedState)
          await unlockMeasurement(programDir)
          await releaseLock(programDir)
          return
        }

        const errorState: RunState = {
          ...baselineState,
          phase: "crashed",
          error: `Baseline measurement failed: ${baseline.failure_reason ?? "unknown error"}`,
          error_phase: "baseline",
          updated_at: new Date().toISOString(),
        }
        await writeState(runDir, errorState)
        await unlockMeasurement(programDir)
        await releaseLock(programDir)
        return
      }

      if (!baseline.quality_gates_passed) {
        const errorState: RunState = {
          ...baselineState,
          phase: "crashed",
          error: `Baseline quality gates failed: ${baseline.gate_violations.join(", ")}`,
          error_phase: "baseline",
          updated_at: new Date().toISOString(),
        }
        await writeState(runDir, errorState)
        await unlockMeasurement(programDir)
        await releaseLock(programDir)
        return
      }

      const fullSha = await getFullSha(worktreePath)

      await appendResult(runDir, {
        experiment_number: 0,
        commit: fullSha.slice(0, 7),
        metric_value: baseline.median_metric,
        secondary_values: serializeSecondaryValues(baseline.median_quality_gates, baseline.median_secondary_metrics),
        status: "keep",
        description: "baseline",
        measurement_duration_ms: baseline.duration_ms,
      })

      const readyState: RunState = {
        ...baselineState,
        phase: "idle",
        original_baseline: baseline.median_metric,
        current_baseline: baseline.median_metric,
        best_metric: baseline.median_metric,
        original_baseline_sha: fullSha,
        last_known_good_sha: fullSha,
        updated_at: new Date().toISOString(),
      }
      await writeState(runDir, readyState)

      // 8. Run the experiment loop
      const callbacks = createFileCallbacks(runDir)
      await runExperimentLoop(
        worktreePath,
        programDir,
        runDir,
        config,
        modelConfig,
        callbacks,
        {
          maxExperiments,
          maxCostUsd,
          signal: abortController.signal,
          stopRequested: () => stopRequested,
          ideasBacklogEnabled,
          carryForward,
          baselineDiagnostics: baseline.diagnostics,
          fallbackModel: fallbackModel ?? undefined,
        },
      )
    } else {
      // Recovered from crash — resume the loop
      const config = await loadProgramConfig(programDir)
      const callbacks = createFileCallbacks(runDir)
      await runExperimentLoop(
        worktreePath,
        programDir,
        runDir,
        config,
        modelConfig,
        callbacks,
        {
          maxExperiments,
          maxCostUsd,
          signal: abortController.signal,
          stopRequested: () => stopRequested,
          ideasBacklogEnabled,
          carryForward,
          fallbackModel: fallbackModel ?? undefined,
        },
      )
    }
  } finally {
    // Cleanup
    clearInterval(heartbeatInterval)
    await closeProviders()
    await releaseLock(programDir)
    await unlockMeasurement(programDir).catch(() => {})

    // Send notification if configured
    let projectConfig: Awaited<ReturnType<typeof loadProjectConfig>> | null = null
    let programConfig: Awaited<ReturnType<typeof loadProgramConfig>> | null = null
    try {
      const [pc, pgc, finalState] = await Promise.all([
        loadProjectConfig(mainRoot),
        loadProgramConfig(programDir),
        readState(runDir),
      ])
      projectConfig = pc
      programConfig = pgc
      const notifyCmd = getNotificationCommand(pc)
      if (notifyCmd) {
        await sendNotification(notifyCmd, finalState, pgc.direction)
      }
    } catch (err) {
      process.stderr.write(`[notify] Error: ${err}\n`)
    }

    // Queue: clean up worktree and chain to next run
    if (source === "queue") {
      if (worktreePath && worktreePath !== mainRoot) {
        await removeWorktree(mainRoot, worktreePath).catch((err) => {
          process.stderr.write(`[queue] Worktree cleanup failed: ${err}\n`)
        })
      }

      const cfg = projectConfig ?? await loadProjectConfig(mainRoot).catch(() => null)
      if (cfg) {
        try {
          const result = await startNextFromQueue(mainRoot, cfg.ideasBacklogEnabled)
          if (result.started) {
            process.stderr.write(`[queue] Started next: ${result.entry.programSlug} (run ${result.runId})\n`)
          } else if (result.lastError) {
            const queueNotifyCmd = getNotificationCommand(cfg)
            if (queueNotifyCmd) {
              const failState = await readState(runDir).catch(() => null)
              if (failState) {
                await sendNotification(queueNotifyCmd, {
                  ...failState,
                  error: `Queue: ${result.lastError}`,
                }, programConfig?.direction ?? "higher").catch(() => {})
              }
            }
          }
        } catch (err) {
          process.stderr.write(`[queue] Chain failed: ${err}\n`)
          const chainNotifyCmd = getNotificationCommand(cfg)
          if (chainNotifyCmd) {
            try {
              const failState = await readState(runDir).catch(() => null)
              if (failState) {
                await sendNotification(chainNotifyCmd, {
                  ...failState,
                  error: `Queue chain failed: ${err}`,
                }, programConfig?.direction ?? "higher")
              }
            } catch {}
          }
        }
      }
    }
  }
}

if (import.meta.main) {
  startDaemon().catch((err) => {
    process.stderr.write(`Daemon fatal error: ${formatShellError(err)}\n`)
    process.exit(1)
  })
}
