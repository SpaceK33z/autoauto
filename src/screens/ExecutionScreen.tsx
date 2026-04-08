import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Screen, ProgramConfig } from "../lib/programs.ts"
import { getProgramDir } from "../lib/programs.ts"
import { formatModelLabel, type ModelSlot } from "../lib/config.ts"
import type { RunState, ExperimentResult, TerminationReason } from "../lib/run.ts"
import { getRunStats } from "../lib/run.ts"
import { removeWorktree } from "../lib/worktree.ts"
import {
  runFinalizeReview,
  refineFinalizeGroups,
  applyFinalizeGroups,
  saveSummaryOnly,
  type FinalizeResult,
  type FinalizeReviewResult,
  type ProposedGroup,
} from "../lib/finalize.ts"
import { formatShellError } from "../lib/git.ts"
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
import { FinalizeApproval } from "../components/FinalizeApproval.tsx"
import { syntaxStyle } from "../lib/syntax-theme.ts"

type ExecutionPhase = "starting" | "running" | "complete" | "finalizing" | "finalize_review" | "finalize_complete" | "error"

function truncateStreamText(prev: string, text: string): string {
  const next = prev + text
  return next.length > 8000 ? next.slice(-6000) : next
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError"
}

interface ExecutionScreenProps {
  cwd: string
  programSlug: string
  modelConfig: ModelSlot
  supportModelConfig: ModelSlot
  ideasBacklogEnabled: boolean
  navigate: (screen: Screen) => void
  maxExperiments: number
  /** Use git worktree for isolation (default true). When false, runs in-place in main checkout. */
  useWorktree?: boolean
  /** If set, attach to an existing run instead of starting a new one */
  attachRunId?: string
  readOnly?: boolean
  /** Called when user chooses to update the program (from run complete or error screen) */
  onUpdateProgram?: (programSlug: string) => void
  /** If true, automatically start finalize when the run is loaded as complete */
  autoFinalize?: boolean
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
  finalizing: "Finalizing...",
}

function getPhaseLabel(phase: RunState["phase"], error?: string | null, isStopping = false): string {
  if (isStopping) return "Stopping after current experiment..."
  if (phase === "crashed") return `Crashed: ${error ?? "unknown"}`
  return PHASE_LABELS[phase] ?? phase
}

const formatHeaderModelLabel = formatModelLabel

function getRunModelConfig(state: RunState | null, fallback: ModelSlot): ModelSlot {
  if (
    state?.model &&
    (state.provider === "claude" || state.provider === "codex" || state.provider === "opencode") &&
    (state.effort === "low" || state.effort === "medium" || state.effort === "high" || state.effort === "max")
  ) {
    return { provider: state.provider, model: state.model, effort: state.effort }
  }
  return fallback
}

function IdeasPanel({ text }: { text: string }) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
      <box paddingX={1} flexDirection="column">
        <markdown content={text} syntaxStyle={syntaxStyle} conceal />
      </box>
    </scrollbox>
  )
}

function Divider({ width, label }: { width: number; label?: string }) {
  const innerWidth = Math.max(width - 2, 0)
  if (label) {
    const labelStr = `─ ${label} `
    const rest = "─".repeat(Math.max(innerWidth - labelStr.length, 0))
    return <text fg="#666666">{labelStr}{rest}</text>
  }
  return <text fg="#666666">{"─".repeat(innerWidth)}</text>
}

export function ExecutionScreen({ cwd, programSlug, modelConfig, supportModelConfig, ideasBacklogEnabled, navigate, maxExperiments, useWorktree = true, attachRunId, readOnly = false, autoFinalize = false, onUpdateProgram }: ExecutionScreenProps) {
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
  const [finalizeResult, setFinalizeResult] = useState<FinalizeResult | null>(null)
  const [tableFocused, setTableFocused] = useState(false)
  const [selectedResult, setSelectedResult] = useState<ExperimentResult | null>(null)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [maxExpText, setMaxExpText] = useState(String(maxExperiments))
  const maxExpTextRef = useRef(maxExpText)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [ideasText, setIdeasText] = useState("")
  const [showIdeas, setShowIdeas] = useState(true)

  // Finalize review state
  const [reviewData, setReviewData] = useState<FinalizeReviewResult | null>(null)
  const [reviewSummary, setReviewSummary] = useState("")
  const [reviewGroups, setReviewGroups] = useState<ProposedGroup[] | null>(null)
  const [reviewValidationError, setReviewValidationError] = useState<string | null>(null)
  const [isRefining, setIsRefining] = useState(false)
  const [refiningText, setRefiningText] = useState("")
  const [refiningToolStatus, setRefiningToolStatus] = useState<string | null>(null)

  const secondaryMetricsConfig = useMemo(() => programConfig?.secondary_metrics, [programConfig])
  const ideasVisible = showIdeas && ideasText.length > 0

  const watcherRef = useRef<DaemonWatcher | null>(null)
  const abortControllerRef = useRef<AbortController>(new AbortController())
  const abortSentRef = useRef(false)
  const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stoppingRef = useRef(false)
  stoppingRef.current = stopping // ref for use inside effect closures
  const parsedMaxExperiments = Number.parseInt(maxExpText, 10)
  const displayMaxExperiments = Number.isFinite(parsedMaxExperiments) && parsedMaxExperiments > 0
    ? parsedMaxExperiments
    : maxExperiments
  const headerModelLabel = useMemo(
    () => formatHeaderModelLabel(getRunModelConfig(runState, modelConfig)),
    [runState, modelConfig],
  )

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
              const currentMax = await getMaxExperiments(activeRunDir)
              if (!cancelled) {
                setRunDir(activeRunDir)
                setRunState(reconstructed.state)
                setResults(reconstructed.results)
                setMetricHistory(reconstructed.metricHistory)
                setProgramConfig(reconstructed.programConfig)
                setTotalCostUsd(reconstructed.state.total_cost_usd ?? 0)
                setExperimentNumber(reconstructed.state.experiment_number)
                setAgentStreamText(reconstructed.streamText)
                setIdeasText(reconstructed.ideasText)
                setTerminationReason(reconstructed.state.termination_reason ?? null)
                if (currentMax != null) {
                  const text = String(currentMax)
                  setMaxExpText(text)
                  maxExpTextRef.current = text
                }
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
                setLastError(formatShellError(err))
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
            setIdeasText(reconstructed.ideasText)
            setPhase("running")
            // Sync maxExpText from run-config for settings panel
            const currentMax = await getMaxExperiments(activeRunDir)
            if (!cancelled && currentMax != null) {
              const text = String(currentMax)
              setMaxExpText(text)
              maxExpTextRef.current = text
            }
          }
        } else {
          // Spawn mode: create worktree, spawn daemon
          const result = await spawnDaemon(cwd, programSlug, modelConfig, maxExperiments, ideasBacklogEnabled, useWorktree)
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
            onIdeasChange: (text) => {
              if (cancelled) return
              setIdeasText(text)
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
          setLastError(formatShellError(err))
          setPhase("error")
        }
      }
    })()

    return () => {
      cancelled = true
      watcherRef.current?.stop()
    }
  }, [cwd, programSlug, modelConfig, maxExperiments, useWorktree, attachRunId, ideasBacklogEnabled])

  const cleanupRunEnvironment = useCallback(async () => {
    if (runState?.in_place) {
      if (runState.original_branch) {
        const { checkoutBranch } = await import("../lib/git.ts")
        await checkoutBranch(cwd, runState.original_branch).catch(() => {})
      }
    } else if (runState?.worktree_path) {
      await removeWorktree(cwd, runState.worktree_path).catch(() => {})
    }
  }, [cwd, runState])

  const handleAbandon = useCallback(async () => {
    await cleanupRunEnvironment()
    navigate("home")
  }, [cleanupRunEnvironment, navigate])

  const handleFinalize = useCallback(async () => {
    if (!runState || !runDir || !programConfig) return

    const finalizeAbort = new AbortController()
    abortControllerRef.current = finalizeAbort

    setPhase("finalizing")
    setAgentStreamText("")
    setToolStatus(null)
    setCurrentPhaseLabel("Finalizing...")

    try {
      const worktreePath = runState.in_place ? undefined : runState.worktree_path
      const review = await runFinalizeReview(
        cwd,
        runDir,
        runState,
        programConfig,
        supportModelConfig,
        {
          onStreamText: (text) => setAgentStreamText(prev => truncateStreamText(prev, text)),
          onToolStatus: (status) => setToolStatus(status),
        },
        finalizeAbort.signal,
        worktreePath,
      )

      setTotalCostUsd(prev => prev + (review.cost?.total_cost_usd ?? 0))
      setReviewData(review)
      setReviewSummary(review.summary)
      setReviewGroups(review.proposedGroups)
      setReviewValidationError(review.validationError)
      setPhase("finalize_review")
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setToolStatus(null)
        setPhase("complete")
        return
      }
      setLastError(formatShellError(err, "Finalize failed"))
      setPhase("error")
    }
  }, [cwd, runDir, runState, programConfig, supportModelConfig])

  const restoreInPlaceBranch = useCallback(async () => {
    if (runState?.in_place && runState.original_branch) {
      const { checkoutBranch } = await import("../lib/git.ts")
      await checkoutBranch(cwd, runState.original_branch).catch(() => {})
    }
  }, [cwd, runState])

  const completeFinalizeWith = useCallback((result: FinalizeResult) => {
    setFinalizeResult(result)
    setReviewData(null)
    setPhase("finalize_complete")
  }, [])

  const handleFinalizeApprove = useCallback(async () => {
    if (!runState || !runDir || !programConfig || !reviewData || !reviewGroups) return

    setPhase("finalizing")
    setAgentStreamText("")
    setCurrentPhaseLabel("Creating branches...")

    try {
      const worktreePath = runState.in_place ? undefined : runState.worktree_path
      const result = await applyFinalizeGroups(
        cwd,
        programSlug,
        runDir,
        runState,
        programConfig,
        reviewGroups,
        reviewData.savedHead,
        reviewSummary,
        reviewData.results,
        worktreePath,
        reviewData.cost,
      )

      await restoreInPlaceBranch()
      completeFinalizeWith(result)
    } catch (err: unknown) {
      setLastError(formatShellError(err, "Finalize failed"))
      setPhase("error")
    }
  }, [cwd, programSlug, runDir, runState, programConfig, reviewData, reviewGroups, reviewSummary, restoreInPlaceBranch, completeFinalizeWith])

  const handleFinalizeSkipGrouping = useCallback(async () => {
    if (!runState || !runDir || !programConfig || !reviewData) return

    try {
      const result = await saveSummaryOnly(
        runState,
        reviewData.results,
        programConfig,
        reviewSummary,
        runDir,
        reviewData.cost,
      )

      await restoreInPlaceBranch()
      completeFinalizeWith(result)
    } catch (err: unknown) {
      setLastError(formatShellError(err, "Finalize failed"))
      setPhase("error")
    }
  }, [runDir, runState, programConfig, reviewData, reviewSummary, restoreInPlaceBranch, completeFinalizeWith])

  const handleFinalizeRefine = useCallback(async (feedback: string) => {
    if (!runState || !reviewData) return

    const refineAbort = new AbortController()
    abortControllerRef.current = refineAbort

    setIsRefining(true)
    setRefiningText("")
    setRefiningToolStatus(null)

    try {
      const worktreePath = runState.in_place ? undefined : runState.worktree_path
      const refined = await refineFinalizeGroups(
        reviewSummary,
        feedback,
        reviewData.changedFiles,
        supportModelConfig,
        cwd,
        {
          onStreamText: (text) => setRefiningText(prev => truncateStreamText(prev, text)),
          onToolStatus: (status) => setRefiningToolStatus(status),
        },
        refineAbort.signal,
        worktreePath,
      )

      setTotalCostUsd(prev => prev + (refined.cost?.total_cost_usd ?? 0))
      setReviewSummary(refined.summary)
      setReviewGroups(refined.proposedGroups)
      setReviewValidationError(refined.validationError)
    } catch (err: unknown) {
      if (isAbortError(err)) return
      setLastError(formatShellError(err, "Refinement failed"))
    } finally {
      setIsRefining(false)
      setRefiningText("")
      setRefiningToolStatus(null)
    }
  }, [cwd, runState, reviewData, reviewSummary, supportModelConfig])

  const handleFinalizeCancel = useCallback(() => {
    abortControllerRef.current.abort()
    setPhase("complete")
    setReviewData(null)
  }, [])

  const handleUpdateProgram = useCallback(async () => {
    await cleanupRunEnvironment()
    onUpdateProgram?.(programSlug)
  }, [cleanupRunEnvironment, programSlug, onUpdateProgram])

  // Auto-finalize: trigger finalize immediately when attaching to a completed run with autoFinalize
  const autoFinalizeTriggered = useRef(false)
  useEffect(() => {
    if (autoFinalize && phase === "complete" && !autoFinalizeTriggered.current) {
      autoFinalizeTriggered.current = true
      handleFinalize()
    }
  }, [autoFinalize, phase, handleFinalize])

  useKeyboard((key) => {
    if (phase === "finalize_review") {
      // Ctrl+C during refinement aborts the agent
      if (isRefining && key.ctrl && key.name === "c") {
        abortControllerRef.current.abort()
      }
      // FinalizeApproval component handles the rest
      return
    }

    if (phase === "finalize_complete") {
      if (key.name === "escape") {
        navigate("home")
      }
      return
    }

    if (phase === "error") {
      if (key.name === "escape") {
        navigate("home")
      } else if (key.name === "u" && runState && !readOnly && onUpdateProgram) {
        handleUpdateProgram()
      }
      return
    }

    if (phase === "complete" && readOnly) {
      if (key.name === "escape") {
        navigate("home")
      } else if (key.name === "i") {
        setShowIdeas(v => !v)
      } else if (key.name === "f") {
        handleFinalize()
      }
      return
    }

    if (phase === "complete") {
      // Escape navigates home; RunCompletePrompt handles the rest
      if (key.name === "escape") {
        navigate("home")
        return
      }
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
        if (next === "" || isNaN(parsed) || parsed < 1) {
          setSettingsError("Must be a positive integer")
        } else if (parsed < experimentNumber) {
          setSettingsError(`Must be at least ${experimentNumber} (experiments already done)`)
        } else {
          setSettingsError(null)
          if (runDir) updateMaxExperiments(runDir, parsed)
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
      if (key.name === "i") {
        setShowIdeas(v => !v)
        return
      }

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

    // During finalize: Ctrl+C to abort
    if (phase === "finalizing" && (key.ctrl && key.name === "c")) {
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
            maxExperiments={displayMaxExperiments}
            width={termWidth}
            modelLabel={headerModelLabel}
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
            isRunning
          />

          {compact ? (
            <>
              <box paddingX={1}>
                <text>
                  {tableFocused ? (
                    <>
                      <span fg="#7aa2f7"><strong>[ Results ]</strong></span>
                      {"  "}
                      <span fg="#666666">Agent</span>
                    </>
                  ) : (
                    <>
                      <span fg="#666666">Results</span>
                      {"  "}
                      <span fg="#7aa2f7"><strong>[ {selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} ]</strong></span>
                    </>
                  )}
                  {"  "}
                  <span fg="#666666">Tab ⇄</span>
                </text>
              </box>
              {tableFocused ? (
                <ResultsTable
                  results={results}
                  metricField={programConfig?.metric_field ?? "metric"}
                  secondaryMetrics={secondaryMetricsConfig}
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
                secondaryMetrics={secondaryMetricsConfig}
                width={termWidth}
                experimentNumber={experimentNumber}
                focused={tableFocused}
                selectedResult={selectedResult}
                onSelect={setSelectedResult}
              />

              {ideasVisible ? (
                <>
                  <box flexDirection="row">
                    <box flexGrow={3}>
                      <Divider width={Math.ceil(termWidth * 0.6)} label={selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} />
                    </box>
                    <box flexGrow={2}>
                      <Divider width={Math.floor(termWidth * 0.4)} label="Ideas" />
                    </box>
                  </box>
                  <box flexDirection="row" flexGrow={1}>
                    <box flexDirection="column" flexGrow={3}>
                      <AgentPanel
                        streamingText={agentStreamText}
                        toolStatus={toolStatus}
                        isRunning={phase === "running"}
                        selectedResult={selectedResult}
                        secondaryMetrics={secondaryMetricsConfig}
                      />
                    </box>
                    <box flexDirection="column" flexGrow={2}>
                      <IdeasPanel text={ideasText} />
                    </box>
                  </box>
                </>
              ) : (
                <>
                  <Divider width={termWidth} label={selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} />
                  <AgentPanel
                    streamingText={agentStreamText}
                    toolStatus={toolStatus}
                    isRunning={phase === "running"}
                    selectedResult={selectedResult}
                    secondaryMetrics={secondaryMetricsConfig}
                  />
                </>
              )}
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
            maxExperiments={displayMaxExperiments}
            width={termWidth}
            modelLabel={headerModelLabel}
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
            secondaryMetrics={secondaryMetricsConfig}
            width={termWidth}
            experimentNumber={experimentNumber}
            focused={tableFocused}
            selectedResult={selectedResult}
            onSelect={setSelectedResult}
          />
          <Divider width={termWidth} label={selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"} />
          {ideasVisible ? (
            <box flexDirection="row" flexGrow={1}>
              <box flexDirection="column" flexGrow={3}>
                <AgentPanel
                  streamingText={agentStreamText}
                  toolStatus={toolStatus}
                  isRunning={false}
                  selectedResult={selectedResult}
                  secondaryMetrics={secondaryMetricsConfig}
                />
              </box>
              <box flexDirection="column" flexGrow={2}>
                <Divider width={Math.floor(termWidth * 0.38)} label="Ideas" />
                <IdeasPanel text={ideasText} />
              </box>
            </box>
          ) : (
            <AgentPanel
              streamingText={agentStreamText}
              toolStatus={toolStatus}
              isRunning={false}
              selectedResult={selectedResult}
              secondaryMetrics={secondaryMetricsConfig}
            />
          )}
          <box paddingX={1}>
            <text fg="#888888">Esc back · f finalize{ideasText.length > 0 ? " · i toggle ideas" : ""}</text>
          </box>
        </box>
      )}

      {phase === "complete" && runState && !readOnly && (
        <RunCompletePrompt
          state={runState}
          direction={programConfig?.direction ?? "lower"}
          terminationReason={terminationReason}
          error={null}
          onFinalize={handleFinalize}
          onAbandon={handleAbandon}
          onUpdateProgram={handleUpdateProgram}
        />
      )}

      {phase === "finalizing" && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Finalize">
          <StatsHeader
            experimentNumber={experimentNumber}
            maxExperiments={displayMaxExperiments}
            width={termWidth}
            modelLabel={headerModelLabel}
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
            isRunning
          />

          <Divider width={termWidth} label="Agent" />

          <AgentPanel
            streamingText={agentStreamText}
            toolStatus={toolStatus}
            isRunning={true}
          />
        </box>
      )}

      {phase === "finalize_review" && (
        <FinalizeApproval
          summary={reviewSummary}
          proposedGroups={reviewGroups}
          validationError={reviewValidationError}
          isRefining={isRefining}
          refiningText={refiningText}
          toolStatus={refiningToolStatus}
          onApprove={handleFinalizeApprove}
          onSkipGrouping={handleFinalizeSkipGrouping}
          onRefine={handleFinalizeRefine}
          onCancel={handleFinalizeCancel}
        />
      )}

      {phase === "finalize_complete" && finalizeResult && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Finalize Complete">
          <box flexDirection="column" paddingX={1}>
            {finalizeResult.mode === "grouped" && finalizeResult.groups.length > 0 ? (
              <>
                <text fg="#9ece6a" selectable>Created {finalizeResult.groups.length} branch{finalizeResult.groups.length > 1 ? "es" : ""}:</text>
                <box height={1} />
                {finalizeResult.groups.map((g) => (
                  <box key={g.name} flexDirection="column">
                    <text fg="#9ece6a" selectable>  {g.branchName}</text>
                    <text fg="#666666" selectable>    {g.files.length} file{g.files.length > 1 ? "s" : ""}: {g.files.map((f) => f.split("/").pop()).join(", ")}</text>
                  </box>
                ))}
              </>
            ) : (
              <text fg="#888888" selectable>No group branches created</text>
            )}
            <box height={1} />
            <text fg="#ffffff">Summary saved to run directory. Press Escape to go back.</text>
          </box>
          <scrollbox flexGrow={1} focused>
            <box paddingX={1} flexDirection="column">
              <markdown content={finalizeResult.summary} syntaxStyle={syntaxStyle} />
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
            <text fg="#888888">
              {runState && !readOnly && onUpdateProgram
                ? "Press u to update program · Escape to go back"
                : "Press Escape to go back"}
            </text>
          </box>
        </box>
      )}
    </box>
  )
}
