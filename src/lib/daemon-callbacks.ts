import { writeFile, truncate } from "node:fs/promises"
import { join } from "node:path"
import type { LoopCallbacks } from "./experiment-loop.ts"

/**
 * FileCallbacks: a thin LoopCallbacks implementation for the daemon.
 *
 * Only handles agent streaming text (stream.log). All other state persistence
 * is handled by the loop itself (state.json, results.tsv).
 */
export function createFileCallbacks(runDir: string): LoopCallbacks {
  const streamLogPath = join(runDir, "stream.log")

  return {
    onPhaseChange: () => {},
    onExperimentStart: () => {
      truncate(streamLogPath, 0).catch(() => {})
    },
    onExperimentEnd: () => {},
    onStateUpdate: () => {},
    onAgentStream: (text: string) => {
      writeFile(streamLogPath, text, { flag: "a" }).catch(() => {})
    },
    onAgentToolUse: (status: string) => {
      writeFile(streamLogPath, `\n[tool] ${status}\n`, { flag: "a" }).catch(() => {})
    },
    onError: () => {},
    onExperimentCost: () => {},
    onRebaseline: () => {},
    onLoopComplete: () => {},
  }
}
