import { join } from "node:path"
import type { LoopCallbacks } from "./experiment-loop.ts"

/** Format experiment number as zero-padded 3-digit string: 1 → "001" */
export function streamLogName(experimentNumber: number): string {
  return `stream-${String(experimentNumber).padStart(3, "0")}.log`
}

/**
 * FileCallbacks: a thin LoopCallbacks implementation for the daemon.
 *
 * Writes agent streaming text to per-experiment log files (stream-001.log, etc.)
 * using Bun's FileSink for buffered, high-throughput appending.
 * All other state persistence is handled by the loop itself (state.json, results.tsv).
 */
export function createFileCallbacks(runDir: string): LoopCallbacks {
  let currentExperiment = 0
  let writer: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null

  function getWriter(experimentNumber: number) {
    if (experimentNumber !== currentExperiment || !writer) {
      writer?.end()
      currentExperiment = experimentNumber
      writer = Bun.file(join(runDir, streamLogName(experimentNumber))).writer()
    }
    return writer
  }

  return {
    onPhaseChange: () => {},
    onExperimentStart: (num: number) => {
      getWriter(num)
    },
    onExperimentEnd: () => {
      writer?.end()
      writer = null
    },
    onStateUpdate: () => {},
    onAgentStream: (text: string) => {
      const w = getWriter(currentExperiment)
      w.write(text)
      w.flush()
    },
    onAgentToolUse: (status: string) => {
      const w = getWriter(currentExperiment)
      w.write(`\n[tool] ${status}\n`)
      w.flush()
    },
    onError: () => {},
    onExperimentCost: () => {},
    onRebaseline: () => {},
    onLoopComplete: () => {
      writer?.end()
      writer = null
    },
  }
}
