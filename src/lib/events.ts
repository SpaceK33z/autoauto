import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExperimentResult, RunState } from "./run.ts"
import type { ExperimentCost } from "./experiment.ts"

// --- Types ---

/** Event types for the structural event log */
export type LoopEventType =
  | "phase_change"
  | "experiment_start"
  | "experiment_end"
  | "error"
  | "rebaseline"
  | "agent_tool"
  | "run_start"
  | "run_complete"
  | "experiment_cost"
  | "loop_complete"
  | "cleanup_start"
  | "cleanup_end"
  | "squash_complete"

/** A single event in events.ndjson */
export interface LoopEvent {
  type: LoopEventType
  timestamp: string
  experiment_number: number
  data: Record<string, unknown>
}

/** Helper interface returned by createEventLogger */
export interface EventLogger {
  logPhaseChange: (phase: string, detail?: string) => Promise<void>
  logExperimentStart: (experimentNumber: number) => Promise<void>
  logExperimentEnd: (result: ExperimentResult) => Promise<void>
  logError: (message: string) => Promise<void>
  logRebaseline: (oldBaseline: number, newBaseline: number, reason: string) => Promise<void>
  logAgentTool: (status: string) => Promise<void>
  logRunStart: (state: RunState) => Promise<void>
  logRunComplete: (state: RunState) => Promise<void>
  logExperimentCost: (cost: ExperimentCost) => Promise<void>
  logLoopComplete: (state: RunState, reason: string) => Promise<void>
  logCleanupStart: () => Promise<void>
  logCleanupEnd: (cost: ExperimentCost) => Promise<void>
  logSquashComplete: (newSha: string, commitCount: number) => Promise<void>
}

// --- Append / Read ---

/** Appends a single event as a JSON line to events.ndjson. */
export async function appendEvent(runDir: string, event: LoopEvent): Promise<void> {
  const line = JSON.stringify(event) + "\n"
  await appendFile(join(runDir, "events.ndjson"), line)
}

/** Reads and parses all events from events.ndjson. Tolerates partial trailing lines. */
export async function readEvents(runDir: string): Promise<LoopEvent[]> {
  let raw: string
  try {
    raw = await readFile(join(runDir, "events.ndjson"), "utf-8")
  } catch {
    return []
  }

  const events: LoopEvent[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as LoopEvent)
    } catch {
      // Partial trailing line — ignore
    }
  }
  return events
}

// --- Event Logger Factory ---

/** Creates an event logger that emits typed events alongside LoopCallbacks. */
export function createEventLogger(
  runDir: string,
  getExperimentNumber: () => number,
): EventLogger {
  const emit = async (type: LoopEventType, data: Record<string, unknown>) => {
    try {
      await appendEvent(runDir, {
        type,
        timestamp: new Date().toISOString(),
        experiment_number: getExperimentNumber(),
        data,
      })
    } catch {
      // Event logging is best-effort — never crash the loop
    }
  }

  return {
    logPhaseChange: (phase, detail) => emit("phase_change", { phase, detail }),
    logExperimentStart: (num) => emit("experiment_start", { experiment_number: num }),
    logExperimentEnd: (result) => emit("experiment_end", {
      status: result.status,
      metric_value: result.metric_value,
      description: result.description,
    }),
    logError: (message) => emit("error", { message }),
    logRebaseline: (oldBaseline, newBaseline, reason) =>
      emit("rebaseline", { old_baseline: oldBaseline, new_baseline: newBaseline, reason }),
    logAgentTool: (status) => emit("agent_tool", { status }),
    logRunStart: (state) => emit("run_start", {
      run_id: state.run_id,
      program_slug: state.program_slug,
      original_baseline: state.original_baseline,
      branch_name: state.branch_name,
    }),
    logRunComplete: (state) => emit("run_complete", {
      run_id: state.run_id,
      phase: state.phase,
      total_keeps: state.total_keeps,
      total_discards: state.total_discards,
      total_crashes: state.total_crashes,
      best_metric: state.best_metric,
      original_baseline: state.original_baseline,
    }),
    logExperimentCost: (cost) => emit("experiment_cost", { ...cost }),
    logLoopComplete: (state, reason) => emit("loop_complete", {
      run_id: state.run_id,
      reason,
      total_keeps: state.total_keeps,
      total_discards: state.total_discards,
      total_crashes: state.total_crashes,
      best_metric: state.best_metric,
      original_baseline: state.original_baseline,
    }),
    logCleanupStart: () => emit("cleanup_start", {}),
    logCleanupEnd: (cost) => emit("cleanup_end", { ...cost }),
    logSquashComplete: (newSha, commitCount) =>
      emit("squash_complete", { new_sha: newSha, commit_count: commitCount }),
  }
}
