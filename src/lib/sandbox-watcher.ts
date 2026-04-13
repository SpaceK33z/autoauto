/**
 * Remote file watcher that polls container files via ContainerProvider
 * instead of using fs.watch(). Implements the same DaemonWatcher interface
 * and fires the same WatchCallbacks as the local watcher.
 */

import type { ContainerProvider } from "./container-provider/types.ts"
import type { WatchCallbacks, DaemonWatcher } from "./daemon-watcher.ts"
import type { RunState } from "./run.ts"
import type { QuotaInfo } from "./agent/types.ts"
import { parseTsvRows, getMetricHistory } from "./run.ts"
import { streamLogName } from "./daemon-callbacks.ts"

const decoder = new TextDecoder()

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export interface SandboxWatcherOptions {
  /** Polling interval in ms (default: 2000) */
  pollIntervalMs?: number
  /** Start reading from end of existing files */
  startAtEnd?: boolean
}

/**
 * Watches a run directory inside a remote container by polling files
 * via ContainerProvider. Produces the same callbacks as the local watchRunDir.
 */
export function watchSandboxRunDir(
  provider: ContainerProvider,
  remoteRunDir: string,
  callbacks: WatchCallbacks,
  options?: SandboxWatcherOptions,
): DaemonWatcher {
  const pollIntervalMs = options?.pollIntervalMs ?? 2000
  let stopped = false
  let daemonDiedFired = false

  // Track byte offsets for delta reads
  let resultsByteOffset = 0
  let streamByteOffset = 0
  let currentStreamFile = ""
  let currentExperimentNumber = -1

  // Change detection: skip callbacks when content hasn't changed
  let lastStateJson = ""
  let lastIdeasText = ""
  let lastQuotaJson = ""

  // If startAtEnd, we'll initialize offsets on first poll
  let initialized = !options?.startAtEnd

  async function initOffsets() {
    try {
      const stateBytes = await provider.readFile(`${remoteRunDir}/state.json`).catch(() => null)
      if (stateBytes) {
        const state = JSON.parse(decode(stateBytes)) as RunState
        currentExperimentNumber = state.experiment_number ?? 0
        currentStreamFile = streamLogName(currentExperimentNumber)
        lastStateJson = decode(stateBytes)
      }
    } catch { /* file may not exist during startup */ }

    try {
      const bytes = await provider.readFile(`${remoteRunDir}/results.tsv`)
      resultsByteOffset = bytes.length
    } catch { /* file may not exist during startup */ }

    try {
      if (currentStreamFile) {
        const bytes = await provider.readFile(`${remoteRunDir}/${currentStreamFile}`)
        streamByteOffset = bytes.length
      }
    } catch { /* file may not exist during startup */ }

    initialized = true
  }

  async function pollOnce() {
    if (stopped) return

    if (!initialized) {
      await initOffsets()
    }

    // Check liveness
    try {
      const exitCode = await provider.poll()
      if (exitCode !== null && !daemonDiedFired && !stopped) {
        daemonDiedFired = true
        callbacks.onDaemonDied()
      }
    } catch {
      if (!daemonDiedFired && !stopped) {
        daemonDiedFired = true
        callbacks.onDaemonDied()
      }
    }

    // Read state.json — only fire callback if content changed
    try {
      const stateBytes = await provider.readFile(`${remoteRunDir}/state.json`)
      const stateText = decode(stateBytes)
      if (stateText !== lastStateJson) {
        lastStateJson = stateText
        const state = JSON.parse(stateText) as RunState
        callbacks.onStateChange(state)

        // Detect experiment transition
        if (state.experiment_number !== currentExperimentNumber) {
          const newStreamFile = streamLogName(state.experiment_number)
          if (newStreamFile !== currentStreamFile) {
            currentStreamFile = newStreamFile
            streamByteOffset = 0
            callbacks.onStreamReset?.()
          }
          currentExperimentNumber = state.experiment_number
        }
      }
    } catch { /* file may not exist yet */ }

    // Read results.tsv — single read, check size locally
    try {
      const bytes = await provider.readFile(`${remoteRunDir}/results.tsv`)
      if (bytes.length > resultsByteOffset) {
        resultsByteOffset = bytes.length
        const results = parseTsvRows(decode(bytes))
        callbacks.onResultsChange(results, getMetricHistory(results))
      }
    } catch { /* file may not exist yet */ }

    // Read stream log delta via tail
    if (currentStreamFile) {
      try {
        const streamPath = `${remoteRunDir}/${currentStreamFile}`
        const result = await provider.exec(["tail", "-c", `+${streamByteOffset + 1}`, streamPath])
        if (result.exitCode === 0 && result.stdout.length > 0) {
          const delta = decode(result.stdout)
          streamByteOffset += result.stdout.length

          if (callbacks.onToolStatus) {
            const toolMatch = delta.match(/\[tool\] (.+)/g)
            if (toolMatch) {
              const last = toolMatch[toolMatch.length - 1]
              callbacks.onToolStatus(last.replace("[tool] ", ""))
            }
          }

          if (delta) callbacks.onStreamChange(delta)
        }
      } catch { /* file may not exist yet */ }
    }

    // Read ideas.md — only fire if content changed
    if (callbacks.onIdeasChange) {
      try {
        const bytes = await provider.readFile(`${remoteRunDir}/ideas.md`)
        const text = decode(bytes)
        if (text !== lastIdeasText) {
          lastIdeasText = text
          callbacks.onIdeasChange(text)
        }
      } catch { /* file may not exist */ }
    }

    // Read quota.json — only fire if content changed
    if (callbacks.onQuotaChange) {
      try {
        const bytes = await provider.readFile(`${remoteRunDir}/quota.json`)
        const text = decode(bytes)
        if (text !== lastQuotaJson) {
          lastQuotaJson = text
          const quota = JSON.parse(text) as QuotaInfo
          callbacks.onQuotaChange(quota)
        }
      } catch { /* file may not exist */ }
    }
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  async function scheduleNext() {
    if (stopped) return
    try {
      await pollOnce()
    } catch {
      // Keep polling after transient read/parse/callback failures
    } finally {
      if (!stopped) {
        timer = setTimeout(scheduleNext, pollIntervalMs)
      }
    }
  }

  // Fire first poll immediately
  scheduleNext()

  return {
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    },
  }
}
