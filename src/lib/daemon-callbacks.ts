import { join } from "node:path"
import type { LoopCallbacks } from "./experiment-loop.ts"
import type { QuotaInfo } from "./agent/types.ts"

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
  let lastQuotaStatus: string | undefined
  let lastQuotaUtilization: number | undefined

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
      const w = getWriter(num)
      w.write(`[time:${Date.now()}]\n`)
      w.flush()
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
      w.write(`\n[time:${Date.now()}]\n[tool] ${status}\n`)
      w.flush()
    },
    onError: (error: string) => {
      const w = getWriter(currentExperiment)
      w.write(`\n[time:${Date.now()}]\n[error] ${error}\n`)
      w.flush()
    },
    onExperimentCost: () => {},
    onQuotaUpdate: (quota: QuotaInfo) => {
      // Deduplicate: skip write if status and utilization haven't meaningfully changed
      const nullTransition = (quota.utilization == null) !== (lastQuotaUtilization == null)
      const utilizationDelta = Math.abs((quota.utilization ?? 0) - (lastQuotaUtilization ?? 0))
      if (quota.status === lastQuotaStatus && !nullTransition && utilizationDelta < 0.05) return
      lastQuotaStatus = quota.status
      lastQuotaUtilization = quota.utilization
      Bun.write(join(runDir, "quota.json"), JSON.stringify(quota))
    },
    onRebaseline: () => {},
    onLoopComplete: () => {
      writer?.end()
      writer = null
    },
  }
}
