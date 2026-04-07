import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { LoopCallbacks } from "./experiment-loop.ts"

/** Format experiment number as zero-padded 3-digit string: 1 → "001" */
export function streamLogName(experimentNumber: number): string {
  return `stream-${String(experimentNumber).padStart(3, "0")}.log`
}

/**
 * FileCallbacks: a thin LoopCallbacks implementation for the daemon.
 *
 * Writes agent streaming text to per-experiment log files (stream-001.log, etc.).
 * All other state persistence is handled by the loop itself (state.json, results.tsv).
 */
export function createFileCallbacks(runDir: string): LoopCallbacks {
  let currentExperiment = 0

  return {
    onPhaseChange: () => {},
    onExperimentStart: (num: number) => {
      currentExperiment = num
    },
    onExperimentEnd: () => {},
    onStateUpdate: () => {},
    onAgentStream: (text: string) => {
      const path = join(runDir, streamLogName(currentExperiment))
      writeFile(path, text, { flag: "a" }).catch(() => {})
    },
    onAgentToolUse: (status: string) => {
      const path = join(runDir, streamLogName(currentExperiment))
      writeFile(path, `\n[tool] ${status}\n`, { flag: "a" }).catch(() => {})
    },
    onError: () => {},
    onExperimentCost: () => {},
    onRebaseline: () => {},
    onLoopComplete: () => {},
  }
}
