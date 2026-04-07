import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Screen, ProgramConfig } from "../lib/programs.ts"
import { getProgramDir } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import type { RunState, ExperimentResult, TerminationReason } from "../lib/run.ts"
import { getRunStats } from "../lib/run.ts"
import { removeWorktree } from "../lib/worktree.ts"
import { runCleanup, type CleanupResult } from "../lib/cleanup.ts"
import {
  spawnDaemon,
  watchRunDir,
  sendStop,
  sendAbort,
  forceKillDaemon,
  reconstructState,
  getDaemonStatus,
  updateMaxExperiments,
  getMaxExperiments,
  type DaemonWatcher,
} from "../lib/daemon-client.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"
import { RunSettingsOverlay } from "../components/RunSettingsOverlay.tsx"
import { StatsHeader } from "../components/StatsHeader.tsx"
import { ResultsTable } from "../components/ResultsTable.tsx"
import { AgentPanel } from "../components/AgentPanel.tsx"
import { syntaxStyle } from "../lib/syntax-theme.ts"

type ExecutionPhase = "starting" | "running" | "complete" | "cleaning_up" | "cleanup_complete" | "error"

function truncateStreamText(prev: string, text: string): string {
  const next = prev + text
  return next.length > 8000 ? next.slice(-6000) : next
}

interface ExecutionScreenProps {
  cwd: string
  programSlug: string
  modelConfig: ModelSlot
  supportModelConfig: ModelSlot
  ideasBacklogEnabled: boolean
  navigate: (screen: Screen) => void
  maxExperiments?: number
  /** If set, attach to an existing run instead of starting a new one */
  attachRunId?: string
  readOnly?: boolean
}

const PHASE_LABELS: Record<string, string> = {
  baseline: "Establishing baseline...",
  agent_running: "Agent running...",
  measuring: "Measuring...",
  reverting: "Reverting...",
  kept: "Kept improvement!",
  idle: "Running experiments...",
  stopping: "Stopping...",
  complete: "Complete",
  cleaning_up: "Reviewing changes...",
}

function getPhaseLabel(phase: RunState["phase"], error?: string | null, isStopping = false): string {
  if (isStopping) return "Stopping after current experiment..."
  if (phase === "crashed") return `Crashed: ${error ?? "unknown"}`
  return PHASE_LABELS[phase] ?? phase
}

function Divider({ width, label }: { width: number; label?: string }) {
  const innerWidth = Math.max(width - 2, 0)
  if (label) {
    const labelStr = `─ ${label} `
    const rest = "─".repeat(Math.max(innerWidth - labelStr.length, 0))
    return <text fg="#565f89">{labelStr}{rest}</text>
  }
  return <text fg="#565f89">{"─".repeat(innerWidth)}</text>
}

export function ExecutionScreen({ cwd, programSlug, modelConfig, supportModelConfig, ideasBacklogEnabled, navigate, maxExperiments, attachRunId, readOnly = false }: ExecutionScreenProps) {
  const { width: termWidth, height: termHeight } = useTerminalDimensions()
  const compact = termHeight < 30
  const [phase, setPhase] = useState<ExecutionPhase>("starting")
  const [runState, setRunState] = useState<RunState | null>(null)
  const [currentPhaseLabel, setCurrentPhaseLabel] = useState(attachRunId ? "Connecting..." : "Starting daemon...")
  const [experimentNumber, setExperimentNumber] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [terminationReason, setTerminationReason] = useState<TerminationReason | null>(null)

  const [results, setResults] = useState<ExperimentResult[]>([])
  const [metricHistory, setMetricHistory] = useState<number[]>([])
  const [agentStreamText, setAgentStreamText] = useState("")
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [totalCostUsd, setTotalCostUsd] = useState(0)
  const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)
  const [runDir, setRunDir] = useState<string | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const [tableFocused, setTableFocused] = useState(false)
  const [selectedResult, setSelectedResult] = useState<ExperimentResult | null>(null)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [maxExpText, setMaxExpText] = useState(maxExperiments != null ? String(maxExperiments) : "")
  const maxExpTextRef = useRef(maxExpText)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const qualityGateFields = useMemo(() => programConfig ? Object.keys(programConfig.quality_gates) : [], [programConfig])
  const secondaryMetricsConfig = useMemo(() => programConfig?.secondary_metrics, [programConfig])

  const watcherRef = useRef<DaemonWatcher | null>(null)
  const abortControllerRef = useRef<AbortController>(new AbortController())
  const abortSentRef = useRef(false)
  const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stoppingRef = useRef(false)
  stoppingRef.current = stopping // ref for use inside effect closures

  useEffect(() => {
    let cancelled = false
    const programDir = getProgramDir(cwd, programSlug)

    ;(async () => {
      try {
        let activeRunDir: string

        if (attachRunId) {
          // Attach mode: reconstruct state from existing run
          activeRunDir = `${programDir}/runs/${attachRunId}`
          const status = await getDaemonStatus(activeRunDir)
          if (!status.alive) {
            // Daemon died — show complete state
            try {
              const reconstructed = await reconstructState(activeRunDir, programDir)
              if (!cancelled) {
                setRunDir(activeRunDir)
                setRunState(reconstructed.state)
                setResults(reconstructed.results)
                setMetricHistory(reconstructed.metricHistory)
                setProgramConfig(reconstructed.programConfig)
                setTotalCostUsd(reconstructed.state.total_cost_usd ?? 0)
                setExperimentNumber(reconstructed.state.experiment_number)
                setAgentStreamText(reconstructed.streamText)
                setTerminationReason(reconstructed.state.termination_reason ?? null)
                if (reconstructed.state.phase === "crashed") {
                  setLastError(reconstructed.state.error ?? "Daemon crashed")
                  setPhase("error")
                } else if (reconstructed.state.phase === "complete") {
                  setPhase("complete")
                } else {
                  setLastError(`Daemon is not running; last phase was ${reconstructed.state.phase}`)
                  setPhase("error")
                }
              }
            } catch (err: unknown) {
              if (!cancelled) {
                setLastError(err instanceof Error ? err.message : String(err))
                setPhase("error")
              }
            }
            return
          }

          // Daemon alive — reconstruct and watch
          const reconstructed = await reconstructState(activeRunDir, programDir)
          if (!cancelled) {
            setRunDir(activeRunDir)
            setRunState(reconstructed.state)
            setResults(reconstructed.results)
            setMetricHistory(reconstructed.metricHistory)
            setProgramConfig(reconstructed.programConfig)
            setTotalCostUsd(reconstructed.state.total_cost_usd ?? 0)
            setExperimentNumber(reconstructed.state.experiment_number)
            setAgentStreamText(reconstructed.streamText)
            setPhase("running")
            // Sync maxExpText from run-config for settings panel
            const currentMax = await getMaxExperiments(activeRunDir)
            if (!cancelled) {
              const text = currentMax != null ? String(currentMax) : ""
              setMaxExpText(text)
              maxExpTextRef.current = text
            }
          }
        } else {
          // Spawn mode: create worktree, spawn daemon
          const result = await spawnDaemon(cwd, programSlug, modelConfig, maxExperiments, ideasBacklogEnabled)
          if (cancelled) return

          activeRunDir = result.runDir
          setRunDir(result.runDir)

          // Load program config for display
          const { loadProgramConfig } = await import("../lib/programs.ts")
          const config = await loadProgramConfig(programDir)
          if (!cancelled) {
            setProgramConfig(config)
            setPhase("running")
          }
        }

        // Start watching the run directory
        if (!cancelled) {
          const watcher = watchRunDir(activeRunDir, {
            onStateChange: (state) => {
              if (cancelled) return
              setRunState(state)
              setExperimentNumber(state.experiment_number)
              setTotalCostUsd(state.total_cost_usd ?? 0)
              setCurrentPhaseLabel(getPhaseLabel(state.phase, state.error, stoppingRef.current))

              // Detect completion
              if (state.phase === "complete" || state.phase === "crashed") {
                setTerminationReason(state.termination_reason ?? null)
                if (state.phase === "crashed") {
                  setLastError(state.error ?? "Daemon crashed")
                  setPhase("error")
                } else {
                  setPhase("complete")
                }
                watcher.stop()
              }
            },
            onResultsChange: (newResults, newMetricHistory) => {
              if (cancelled) return
              setResults(newResults)
              setMetricHistory(newMetricHistory)
            },
            onStreamChange: (text) => {
              if (cancelled) return
              setAgentStreamText(prev => truncateStreamText(prev, text))
            },
            onStreamReset: () => {
              if (cancelled) return
              setAgentStreamText("")
              setToolStatus(null)
            },
            onToolStatus: (status) => {
              if (cancelled) return
              setToolStatus(status)
            },
            onDaemonDied: () => {
              if (cancelled) return
              // Re-read final state
              reconstructState(activeRunDir, programDir).then((final) => {
                if (cancelled) return
                setRunState(final.state)
                setResults(final.results)
                setMetricHistory(final.metricHistory)
                setTerminationReason(final.state.termination_reason ?? null)
                if (final.state.phase === "crashed") {
                  setLastError(final.state.error ?? "Daemon died unexpectedly")
                  setPhase("error")
                } else if (final.state.phase === "complete") {
                  setPhase("complete")
                } else {
                  setLastError(`Daemon died unexpectedly while ${final.state.phase}`)
                  setPhase("error")
                }
              }).catch(() => {
                if (!cancelled) {
                  setLastError("Daemon died and state could not be read")
                  setPhase("error")
                }
              })
              watcher.stop()
            },
          }, { startAtEnd: Boolean(attachRunId) })
          watcherRef.current = watcher
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setLastError(err instanceof Error ? err.message : String(err))
          setPhase("error")
        }
      }
    })()

    return () => {
      cancelled = true
      watcherRef.current?.stop()
    }
  }, [cwd, programSlug, modelConfig, maxExperiments, attachRunId, ideasBacklogEnabled])

  const handleAbandon = useCallback(async () => {
    // Remove worktree if we have the path
    if (runState?.worktree_path) {
      await removeWorktree(cwd, runState.worktree_path).catch(() => {})
    }
    navigate("home")
  }, [cwd, runState, navigate])

  const handleCleanup = useCallback(async () => {
    if (!runState || !runDir || !programConfig) return

    const cleanupAbort = new AbortController()
    abortControllerRef.current = cleanupAbort

    setPhase("cleaning_up")
    setAgentStreamText("")
    setToolStatus(null)
    setCurrentPhaseLabel("Reviewing changes...")

    try {
      const result = await runCleanup(
        cwd,
        programSlug,
        runDir,
        runState,
        programConfig,
        supportModelConfig,
        {
          onStreamText: (text) => setAgentStreamText(prev => truncateStreamText(prev, text)),
          onToolStatus: (status) => setToolStatus(status),
        },
        cleanupAbort.signal,
        runState.worktree_path, // Use worktree as git cwd
      )
      setCleanupResult(result)
      setTotalCostUsd(prev => prev + (result.cost?.total_cost_usd ?? 0))
      setPhase("cleanup_complete")
    } catch (err: unknown) {
      setLastError(err instanceof Error ? err.message : String(err))
      setPhase("error")
    }
  }, [cwd, programSlug, runDir, runState, programConfig, supportModelConfig])

  useKeyboard((key) => {
    if (phase === "cleanup_complete" || phase === "error") {
      if (key.name === "escape") {
        navigate("home")
      }
      return
    }

    if (phase === "complete" && readOnly) {
      if (key.name === "escape") {
        navigate("home")
      }
      return
    }

    if (phase === "complete") {
      // RunCompletePrompt handles its own keyboard
      return
    }

    // Settings overlay
    if (showSettings) {
      if (key.name === "escape") {
        setShowSettings(false)
        return
      }
      if (key.name === "backspace" || /^\d$/.test(key.name)) {
        const prev = maxExpTextRef.current
        const next = key.name === "backspace" ? prev.slice(0, -1) : prev + key.name
        maxExpTextRef.current = next
        setMaxExpText(next)

        // Validate and auto-save
        const parsed = parseInt(next, 10)
        if (next === "") {
          setSettingsError(null)
          if (runDir) updateMaxExperiments(runDir, undefined)
        } else if (!isNaN(parsed) && parsed > 0 && parsed >= experimentNumber) {
          setSettingsError(null)
          if (runDir) updateMaxExperiments(runDir, parsed)
        } else if (!isNaN(parsed) && parsed > 0 && parsed < experimentNumber) {
          setSettingsError(`Must be at least ${experimentNumber} (experiments already done)`)
        }
      }
      return
    }

    // Stop confirmation dialog
    if (showStopConfirm) {
      if (key.name === "y") {
        setShowStopConfirm(false)
        setStopping(true)
        setCurrentPhaseLabel("Stopping after current experiment...")
        if (runDir) sendStop(runDir).catch(() => {})
      } else if (key.name === "n" || key.name === "escape") {
        setShowStopConfirm(false)
      }
      return
    }

    // During execution: Tab to toggle table focus
    if ((phase === "starting" || phase === "running") && key.name === "tab") {
      setTableFocused(f => !f)
      return
    }

    // Escape: deselect first, then unfocus table, then detach (go back while daemon continues)
    if (key.name === "escape") {
      if (selectedResult) {
        setSelectedResult(null)
        return
      }
      if (tableFocused) {
        setTableFocused(false)
        return
      }
      // Detach from daemon — it keeps running in background
      watcherRef.current?.stop()
      navigate("home")
      return
    }

    // Stop/abort during execution
    if (phase === "starting" || phase === "running") {
      if (key.name === "s") {
        setShowSettings(true)
        return
      }

      if (key.name === "q") {
        // Show stop confirmation
        setShowStopConfirm(true)
        return
      }

      if (key.ctrl && key.name === "c") {
        if (abortSentRef.current) {
          // Second Ctrl+C: force kill after timeout
          if (runDir) {
            forceKillDaemon(runDir).catch(() => {})
          }
        } else {
          // First Ctrl+C: abort
          abortSentRef.current = true
          if (runDir) sendAbort(runDir).catch(() => {})
          // Set up SIGKILL escalation after 5s
          abortTimerRef.current = setTimeout(() => {
            if (runDir) forceKillDaemon(runDir).catch(() => {})
          }, 5_000)
        }
        return
      }
    }

    // During cleanup: Ctrl+C to abort cleanup
    if (phase === "cleaning_up" && (key.ctrl && key.name === "c")) {
      abortControllerRef.current.abort()
    }
  })

  // Clean up abort timer on unmount
  useEffect(() => {
    return () => {
      if (abortTimerRef.current) clearTimeout(abortTimerRef.current)
    }
  }, [])

  return (
    <box flexDirection="column" flexGrow={1}>
      {(phase === "starting" || phase === "running") && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`${programSlug}`}>
          <StatsHeader
            experimentNumber={experimentNumber}
            totalKeeps={runState?.total_keeps ?? 0}
            totalDiscards={runState?.total_discards ?? 0}
            totalCrashes={runState?.total_crashes ?? 0}
            currentBaseline={runState?.current_baseline ?? 0}
            originalBaseline={runState?.original_baseline ?? 0}
            bestMetric={runState?.best_metric ?? 0}
            direction={programConfig?.direction ?? "lower"}
            metricField={programConfig?.metric_field ?? "metric"}
            totalCostUsd={totalCostUsd}
            metricHistory={metricHistory}
            currentPhaseLabel={currentPhaseLabel}
            improvementPct={runState && programConfig ? getRunStats(runState, programConfig.direction).improvement_pct : 0}
          />

          {compact ? (
            <>
              <box paddingX={1}>
                <text>
                  {tableFocused ? (
                    <>
                      <span fg="#7aa2f7"><strong>[ Results ]</strong></span>
                      {"  "}
                      <span fg="#565f89">Agent</span>
                    </>
                  ) : (
                    <>
                      <span fg="#565f89">Results</span>
                      {"  "}
                      <span fg="#7aa2f7"><strong>[ {selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} ]</strong></span>
                    </>
                  )}
                  {"  "}
                  <span fg="#565f89">Tab ⇄</span>
                </text>
              </box>
              {tableFocused ? (
                <ResultsTable
                  results={results}
                  metricField={programConfig?.metric_field ?? "metric"}
                  width={termWidth}
                  experimentNumber={experimentNumber}
                  focused={tableFocused}
                  selectedResult={selectedResult}
                  onSelect={setSelectedResult}
                />
              ) : (
                <AgentPanel
                  streamingText={agentStreamText}
                  toolStatus={toolStatus}
                  isRunning={phase === "running"}
                  selectedResult={selectedResult}
                  phaseLabel={currentPhaseLabel}
                  experimentNumber={experimentNumber}
                  qualityGateFields={qualityGateFields}
                  secondaryMetrics={secondaryMetricsConfig}
                />
              )}
            </>
          ) : (
            <>
              <Divider width={termWidth} label="Results" />

              <ResultsTable
                results={results}
                metricField={programConfig?.metric_field ?? "metric"}
                width={termWidth}
                experimentNumber={experimentNumber}
                focused={tableFocused}
                selectedResult={selectedResult}
                onSelect={setSelectedResult}
              />

              <Divider width={termWidth} label={selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} />

              <AgentPanel
                streamingText={agentStreamText}
                toolStatus={toolStatus}
                isRunning={phase === "running"}
                selectedResult={selectedResult}
                qualityGateFields={qualityGateFields}
                secondaryMetrics={secondaryMetricsConfig}
              />
            </>
          )}

          {showSettings && (
            <RunSettingsOverlay
              maxExpText={maxExpText}
              experimentNumber={experimentNumber}
              validationError={settingsError}
            />
          )}

          {showStopConfirm && (
            <box paddingX={1}>
              <text fg="#e0af68" selectable>Stop after current experiment finishes? (y/n)</text>
            </box>
          )}

          {stopping && !showStopConfirm && (
            <box paddingX={1}>
              <text fg="#e0af68" selectable>Stopping after current experiment...</text>
            </box>
          )}

          {lastError && (
            <box paddingX={1}>
              <text fg="#ff5555" selectable>{lastError}</text>
            </box>
          )}
        </box>
      )}

      {phase === "complete" && runState && readOnly && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`${programSlug}`}>
          <StatsHeader
            experimentNumber={experimentNumber}
            totalKeeps={runState.total_keeps}
            totalDiscards={runState.total_discards}
            totalCrashes={runState.total_crashes}
            currentBaseline={runState.current_baseline}
            originalBaseline={runState.original_baseline}
            bestMetric={runState.best_metric}
            direction={programConfig?.direction ?? "lower"}
            metricField={programConfig?.metric_field ?? "metric"}
            totalCostUsd={totalCostUsd}
            metricHistory={metricHistory}
            currentPhaseLabel="Complete"
            improvementPct={programConfig ? getRunStats(runState, programConfig.direction).improvement_pct : 0}
          />
          <Divider width={termWidth} label="Results" />
          <ResultsTable
            results={results}
            metricField={programConfig?.metric_field ?? "metric"}
            width={termWidth}
            experimentNumber={experimentNumber}
            focused={tableFocused}
            selectedResult={selectedResult}
            onSelect={setSelectedResult}
          />
          <Divider width={termWidth} label={selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} />
          <AgentPanel
            streamingText={agentStreamText}
            toolStatus={toolStatus}
            isRunning={false}
            selectedResult={selectedResult}
            qualityGateFields={qualityGateFields}
            secondaryMetrics={secondaryMetricsConfig}
          />
          <box paddingX={1}>
            <text fg="#888888">Press Escape to go back</text>
          </box>
        </box>
      )}

      {phase === "complete" && runState && !readOnly && (
        <RunCompletePrompt
          state={runState}
          direction={programConfig?.direction ?? "higher"}
          terminationReason={terminationReason}
          error={null}
          onCleanup={handleCleanup}
          onAbandon={handleAbandon}
        />
      )}

      {phase === "cleaning_up" && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Cleanup">
          <StatsHeader
            experimentNumber={experimentNumber}
            totalKeeps={runState?.total_keeps ?? 0}
            totalDiscards={runState?.total_discards ?? 0}
            totalCrashes={runState?.total_crashes ?? 0}
            currentBaseline={runState?.current_baseline ?? 0}
            originalBaseline={runState?.original_baseline ?? 0}
            bestMetric={runState?.best_metric ?? 0}
            direction={programConfig?.direction ?? "lower"}
            metricField={programConfig?.metric_field ?? "metric"}
            totalCostUsd={totalCostUsd}
            metricHistory={metricHistory}
            currentPhaseLabel={currentPhaseLabel}
            improvementPct={runState && programConfig ? getRunStats(runState, programConfig.direction).improvement_pct : 0}
          />

          <Divider width={termWidth} label="Agent" />

          <AgentPanel
            streamingText={agentStreamText}
            toolStatus={toolStatus}
            isRunning={true}
          />
        </box>
      )}

      {phase === "cleanup_complete" && cleanupResult && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Cleanup Complete">
          <box flexDirection="column" paddingX={1}>
            {cleanupResult.squashedSha ? (
              <text fg="#9ece6a" selectable>Commits squashed into {cleanupResult.squashedSha.slice(0, 7)}</text>
            ) : (
              <text fg="#888888" selectable>No changes to squash (0 keeps)</text>
            )}
            <text fg="#a9b1d6">Summary saved to run directory. Press Escape to go back.</text>
          </box>
          <scrollbox flexGrow={1} focused>
            <box paddingX={1} flexDirection="column">
              <markdown content={cleanupResult.summary} syntaxStyle={syntaxStyle} />
            </box>
          </scrollbox>
        </box>
      )}

      {phase === "error" && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Error">
          <box padding={1}>
            <text fg="#ff5555" selectable>{lastError ?? "Unknown error"}</text>
          </box>
          <box padding={1}>
            <text fg="#888888">Press Escape to go back</text>
          </box>
        </box>
      )}
    </box>
  )
}
