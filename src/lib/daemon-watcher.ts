import { watch, statSync, readFileSync, type FSWatcher } from "node:fs"
import { join } from "node:path"
import { streamLogName } from "./daemon-callbacks.ts"
import type { RunState, ExperimentResult } from "./run.ts"
import { readAllResults, readState, getMetricHistory } from "./run.ts"
import { getDaemonStatus } from "./daemon-status.ts"

export interface WatchCallbacks {
  onStateChange: (state: RunState) => void
  onResultsChange: (results: ExperimentResult[], metricHistory: number[]) => void
  onStreamChange: (text: string) => void
  onStreamReset?: () => void
  onToolStatus?: (status: string | null) => void
  onDaemonDied: () => void
}

export interface DaemonWatcher {
  stop: () => void
}

/**
 * Watches the run directory for file changes and calls back with updates.
 * Uses fs.watch on the directory (not individual files) to handle atomic renames.
 * Falls back to polling if fs.watch errors.
 */
export function watchRunDir(
  runDir: string,
  callbacks: WatchCallbacks,
  options: { startAtEnd?: boolean } = {},
): DaemonWatcher {
  let stopped = false
  let watcher: FSWatcher | null = null

  // Track byte offsets for delta reads
  let resultsByteOffset = 0
  let streamByteOffset = 0
  let currentStreamFile = "" // e.g. "stream-001.log"

  if (options.startAtEnd) {
    try {
      resultsByteOffset = statSync(join(runDir, "results.tsv")).size
    } catch {}
    // Determine current stream file from state
    try {
      const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"))
      currentStreamFile = streamLogName(state.experiment_number ?? 0)
      streamByteOffset = statSync(join(runDir, currentStreamFile)).size
    } catch {}
  }

  // Debounce: avoid reading the same file multiple times per event burst
  const pendingReads = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRead(filename: string) {
    pendingReads.add(filename)
    if (!flushTimer) {
      flushTimer = setTimeout(flushReads, 50)
    }
  }

  async function flushReads() {
    flushTimer = null
    const files = [...pendingReads]
    pendingReads.clear()
    if (stopped) return

    for (const file of files) {
      try {
        if (file === "state.json") {
          const state = await readState(runDir)
          callbacks.onStateChange(state)
        } else if (file === "results.tsv") {
          await readResultsDelta()
        } else if (file.startsWith("stream-") && file.endsWith(".log")) {
          await readStreamDelta(file)
        } else if (file === "daemon.json") {
          // Heartbeat check handled by backup timer
        }
      } catch {
        // File may be mid-write — ignore and catch next event
      }
    }
  }

  async function readResultsDelta() {
    try {
      const size = Bun.file(join(runDir, "results.tsv")).size
      if (size <= resultsByteOffset) return // no new data
      resultsByteOffset = size

      const results = await readAllResults(runDir)
      callbacks.onResultsChange(results, getMetricHistory(results))
    } catch {
      // Ignore transient errors
    }
  }

  async function readStreamDelta(file: string) {
    try {
      // New experiment file → reset stream
      if (file !== currentStreamFile) {
        currentStreamFile = file
        streamByteOffset = 0
        callbacks.onStreamReset?.()
      }

      const bunFile = Bun.file(join(runDir, file))
      const size = bunFile.size
      if (size <= streamByteOffset) return

      const delta = await bunFile.slice(streamByteOffset, size).text()
      streamByteOffset = size

      // Extract latest tool status for WaitingIndicator
      if (callbacks.onToolStatus) {
        const toolMatch = delta.match(/\[tool\] (.+)/g)
        if (toolMatch) {
          const last = toolMatch[toolMatch.length - 1]
          callbacks.onToolStatus(last.replace("[tool] ", ""))
        }
      }

      // Pass through full text including [time:] and [tool] markers
      // AgentPanel parses and renders them with styling
      if (delta) callbacks.onStreamChange(delta)
    } catch {
      // Ignore transient errors
    }
  }

  // fs.watch on the directory
  try {
    watcher = watch(runDir, (_event, filename) => {
      if (stopped || !filename || filename.endsWith(".tmp")) return
      scheduleRead(filename)
    })
    watcher.on("error", () => {
      // Fall back to polling if watcher errors
      startPolling()
    })
  } catch {
    startPolling()
  }

  // Backup heartbeat timer (5-10s)
  const heartbeatTimer = setInterval(async () => {
    if (stopped) return
    const status = await getDaemonStatus(runDir)
    if (!status.alive && !status.starting) {
      callbacks.onDaemonDied()
    }
  }, 7_000)

  // Polling fallback
  let pollTimer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    if (pollTimer || stopped) return
    watcher?.close()
    watcher = null

    pollTimer = setInterval(() => {
      if (stopped) return
      scheduleRead("state.json")
      scheduleRead("results.tsv")
      if (currentStreamFile) scheduleRead(currentStreamFile)
    }, 300)
  }

  return {
    stop: () => {
      stopped = true
      watcher?.close()
      clearInterval(heartbeatTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (flushTimer) clearTimeout(flushTimer)
    },
  }
}
