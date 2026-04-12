import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Screen, ProgramConfig } from "../lib/programs.ts"
import { getProgramDir } from "../lib/programs.ts"
import { formatModelLabel, type ModelSlot } from "../lib/config.ts"
import type { RunState, ExperimentResult, TerminationReason } from "../lib/run.ts"
import { getRunStats, writeState } from "../lib/run.ts"
import { removeWorktree } from "../lib/worktree.ts"
import {
  buildFinalizeContext,
  buildFinalizeInitialMessage,
  saveFinalizeReport,
  extractFinalizeDone,
  generateSummaryReport,
  type FinalizeResult,
} from "../lib/finalize.ts"
import { getFinalizeSystemPrompt } from "../lib/system-prompts/index.ts"
import { runVerification, appendVerificationResults, type VerificationResult } from "../lib/verify.ts"
import { VerifyResultsOverlay } from "../components/VerifyResultsOverlay.tsx"
import { formatShellError, DirtyWorkingTreeError, getWorkingTreeStatus } from "../lib/git.ts"
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
  readDaemonLogTail,
  type DaemonWatcher,
} from "../lib/daemon-client.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"
import { RunSettingsOverlay } from "../components/RunSettingsOverlay.tsx"
import { StatsHeader } from "../components/StatsHeader.tsx"
import { ResultsTable } from "../components/ResultsTable.tsx"
import { AgentPanel } from "../components/AgentPanel.tsx"
import { Chat } from "../components/Chat.tsx"
import { DirtyTreePrompt } from "../components/DirtyTreePrompt.tsx"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { truncateStreamText } from "../lib/format.ts"
import type { QuotaInfo } from "../lib/agent/types.ts"
import { extractExperimentIdeas } from "../lib/ideas-backlog.ts"

type ExecutionPhase = "starting" | "running" | "complete" | "finalizing" | "finalize_complete" | "error" | "dirty"

const FINALIZE_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
import { colors } from "../lib/theme.ts"

const BORDER_ACTIVE = colors.borderActive
const BORDER_DIM = colors.borderDim

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
  maxCostUsd?: number
  /** Use git worktree for isolation (default true). When false, runs in-place in main checkout. */
  useWorktree?: boolean
  /** Carry forward context from previous runs (default true). */
  carryForward?: boolean
  /** Keep experiments that simplify code without improving the metric (default true). */
  keepSimplifications?: boolean
  /** If set, attach to an existing run instead of starting a new one */
  attachRunId?: string
  readOnly?: boolean
  /** Called when user chooses to update the program (from run complete or error screen) */
  onUpdateProgram?: (programSlug: string) => void
  /** If true, automatically start finalize when the run is loaded as complete */
  autoFinalize?: boolean
  /** Fallback model for auto-switching on quota/rate-limit exhaustion. */
  fallbackModel?: ModelSlot | null
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
  dirty: "Uncommitted changes...",
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
  // Strip the top-level "# Ideas Backlog" heading — the panel title already conveys this
  const content = text.replace(/^# [^\n]*\n/, "")
  return (
    <scrollbox flexGrow={1} minHeight={0} stickyScroll stickyStart="bottom">
      <box paddingX={1} flexDirection="column">
        <markdown content={content} syntaxStyle={syntaxStyle} conceal />
      </box>
    </scrollbox>
  )
}

function BottomPanels({ narrowWidth, ideasVisible, ideasText, activeBottomTab, focusedPanel, selectedResult, agentStreamText, toolStatus, isRunning, secondaryMetrics, setFocusedPanel, setActiveBottomTab }: {
  narrowWidth: boolean
  ideasVisible: boolean
  ideasText: string
  activeBottomTab: "agent" | "ideas"
  focusedPanel: string
  selectedResult: ExperimentResult | null | undefined
  agentStreamText: string
  toolStatus: string | null
  isRunning: boolean
  secondaryMetrics: Record<string, import("../lib/programs.ts").SecondaryMetric> | undefined
  setFocusedPanel: (panel: "results" | "agent" | "ideas") => void
  setActiveBottomTab: (tab: "agent" | "ideas") => void
}) {
  if (narrowWidth && ideasVisible) {
    const agentLabel = selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"
    // Title is rendered at offset 2 from box left edge. Active tab has brackets: "[Agent] Ideas" or "Agent [Ideas]"
    // Agent region spans the agent label + brackets (when active), Ideas region starts after the separating space
    const agentPartLen = agentLabel.length + (activeBottomTab === "agent" ? 2 : 0) // +2 for [] when active
    const titleIdeasStart = 2 + agentPartLen + 1 // offset + agent part + space separator
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        minWidth={0}
        border
        borderStyle="rounded"
        borderColor={focusedPanel === activeBottomTab ? BORDER_ACTIVE : BORDER_DIM}
        title={activeBottomTab === "agent"
          ? (selectedResult ? `[Experiment #${selectedResult.experiment_number}] Ideas` : "[Agent] Ideas")
          : (selectedResult ? `Experiment #${selectedResult.experiment_number} [Ideas]` : "Agent [Ideas]")}
        onMouseDown={function (event) {
          const relY = event.y - this.y
          const relX = event.x - this.x
          if (relY === 0) {
            // Click on the title bar — detect which tab label was hit
            if (relX >= 2 && relX < titleIdeasStart) {
              setActiveBottomTab("agent"); setFocusedPanel("agent")
            } else if (relX >= titleIdeasStart) {
              setActiveBottomTab("ideas"); setFocusedPanel("ideas")
            }
          } else {
            setFocusedPanel(activeBottomTab)
          }
        }}
      >
        {activeBottomTab === "agent" ? (
          <AgentPanel
            streamingText={agentStreamText}
            toolStatus={toolStatus}
            isRunning={isRunning}
            selectedResult={selectedResult}
            secondaryMetrics={secondaryMetrics}
          />
        ) : (
          <IdeasPanel text={ideasText} />
        )}
      </box>
    )
  }

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0} minWidth={0}>
      <box
        flexDirection="column"
        flexGrow={ideasVisible ? 3 : 1}
        minHeight={0}
        minWidth={0}
        border
        borderStyle="rounded"
        borderColor={focusedPanel === "agent" ? BORDER_ACTIVE : BORDER_DIM}
        title={selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent"}
        onMouseDown={() => setFocusedPanel("agent")}
      >
        <AgentPanel
          streamingText={agentStreamText}
          toolStatus={toolStatus}
          isRunning={isRunning}
          selectedResult={selectedResult}
          secondaryMetrics={secondaryMetrics}
        />
      </box>
      {ideasVisible && (
        <box
          flexDirection="column"
          flexGrow={2}
          minHeight={0}
          minWidth={0}
          border
          borderStyle="rounded"
          borderColor={focusedPanel === "ideas" ? BORDER_ACTIVE : BORDER_DIM}
          title={selectedResult ? `Ideas · #${selectedResult.experiment_number}` : "Ideas"}
          onMouseDown={() => setFocusedPanel("ideas")}
        >
          <IdeasPanel text={ideasText} />
        </box>
      )}
    </box>
  )
}

export function ExecutionScreen({ cwd, programSlug, modelConfig, supportModelConfig, ideasBacklogEnabled, navigate, maxExperiments, maxCostUsd, useWorktree = true, carryForward = true, keepSimplifications, attachRunId, readOnly = false, autoFinalize = false, onUpdateProgram, fallbackModel }: ExecutionScreenProps) {
  const { width: termWidth, height: termHeight } = useTerminalDimensions()
  const compact = termHeight < 30
  const [phase, setPhase] = useState<ExecutionPhase>("starting")
  const [runState, setRunState] = useState<RunState | null>(null)
  const [currentPhaseLabel, setCurrentPhaseLabel] = useState(attachRunId ? "Connecting..." : "Starting daemon...")
  const [experimentNumber, setExperimentNumber] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [terminationReason, setTerminationReason] = useState<TerminationReason | null>(null)
  const [dirtyFiles, setDirtyFiles] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  const [results, setResults] = useState<ExperimentResult[]>([])
  const [metricHistory, setMetricHistory] = useState<number[]>([])
  const [agentStreamText, setAgentStreamText] = useState("")
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [totalCostUsd, setTotalCostUsd] = useState(0)
  const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)
  const [runDir, setRunDir] = useState<string | null>(null)
  const [finalizeResult, setFinalizeResult] = useState<FinalizeResult | null>(null)
  type FocusPanel = "results" | "agent" | "ideas"
  const [focusedPanel, setFocusedPanel] = useState<FocusPanel>("agent")
  const [selectedResult, setSelectedResult] = useState<ExperimentResult | null>(null)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [maxExpText, setMaxExpText] = useState(String(maxExperiments))
  const maxExpTextRef = useRef(maxExpText)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [quotaInfo, setQuotaInfo] = useState<QuotaInfo | undefined>()
  const [ideasText, setIdeasText] = useState("")
  const [summaryText, setSummaryText] = useState("")
  const [showIdeas, setShowIdeas] = useState(true)
  const [activeBottomTab, setActiveBottomTab] = useState<"agent" | "ideas">("agent")

  // Verification state
  const [showVerifyOverlay, setShowVerifyOverlay] = useState(false)
  const [isVerifying, setIsVerifying] = useState(false)
  const [verifyProgress, setVerifyProgress] = useState<string | null>(null)
  const [verificationResults, setVerificationResults] = useState<VerificationResult[] | null>(null)

  // Finalize chat state
  const [finalizeSystemPrompt, setFinalizeSystemPrompt] = useState<string | null>(null)
  const [finalizeInitialMessage, setFinalizeInitialMessage] = useState<string | null>(null)
  const [finalizeCwd, setFinalizeCwd] = useState<string | null>(null)

  const secondaryMetricsConfig = useMemo(() => programConfig?.secondary_metrics, [programConfig])
  const ideasVisible = showIdeas && ideasText.length > 0
  const narrowWidth = termWidth < 80
  const displayIdeasText = useMemo(
    () => selectedResult ? extractExperimentIdeas(ideasText, selectedResult.experiment_number) : ideasText,
    [ideasText, selectedResult],
  )

  const watcherRef = useRef<DaemonWatcher | null>(null)
  const abortControllerRef = useRef<AbortController>(new AbortController())
  const abortSentRef = useRef(false)
  const abortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stoppingRef = useRef(false)
  const lastProviderRef = useRef<string | undefined>(undefined)
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
    setQuotaInfo(undefined)
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
              const [reconstructed, currentMax, logTail] = await Promise.all([
                reconstructState(activeRunDir, programDir),
                getMaxExperiments(activeRunDir),
                readDaemonLogTail(activeRunDir),
              ])
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
                setSummaryText(reconstructed.summaryText)
                setTerminationReason(reconstructed.state.termination_reason ?? null)
                if (currentMax != null) {
                  const text = String(currentMax)
                  setMaxExpText(text)
                  maxExpTextRef.current = text
                }
                if (reconstructed.state.phase === "crashed") {
                  setLastError(reconstructed.state.error ?? (logTail || "Daemon crashed"))
                  setPhase("error")
                } else if (reconstructed.state.phase === "complete") {
                  setPhase("complete")
                } else {
                  const detail = logTail ? `\n\n${logTail}` : ""
                  setLastError(`Daemon is not running; last phase was ${reconstructed.state.phase}${detail}`)
                  setPhase("error")
                }
              }
            } catch (err: unknown) {
              if (!cancelled) {
                const logTail = await readDaemonLogTail(activeRunDir)
                setLastError(logTail || formatShellError(err))
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
            setSummaryText(reconstructed.summaryText)
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
          const result = await spawnDaemon(cwd, programSlug, modelConfig, maxExperiments, ideasBacklogEnabled, useWorktree, carryForward, "manual", maxCostUsd, keepSimplifications, fallbackModel)
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
              // Clear quota data when provider switches (fallback model activated)
              if (lastProviderRef.current && lastProviderRef.current !== state.provider) {
                setQuotaInfo(undefined)
              }
              lastProviderRef.current = state.provider
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
            onQuotaChange: (quota) => {
              if (cancelled) return
              setQuotaInfo(quota)
            },
            onDaemonDied: () => {
              if (cancelled) return
              // Re-read final state + daemon log for error context
              Promise.all([
                reconstructState(activeRunDir, programDir).catch(() => null),
                readDaemonLogTail(activeRunDir),
              ]).then(([final, logTail]) => {
                if (cancelled) return
                if (final) {
                  setRunState(final.state)
                  setResults(final.results)
                  setMetricHistory(final.metricHistory)
                  setTerminationReason(final.state.termination_reason ?? null)
                  if (final.state.phase === "crashed") {
                    setLastError(final.state.error ?? (logTail || "Daemon died unexpectedly"))
                    setPhase("error")
                  } else if (final.state.phase === "complete") {
                    setPhase("complete")
                  } else {
                    // Persist crashed state to disk so the run doesn't stay
                    // stuck in a non-terminal phase after the TUI closes
                    const crashedState: RunState = {
                      ...final.state,
                      phase: "crashed",
                      error: logTail || "Daemon died unexpectedly",
                      error_phase: final.state.phase,
                      updated_at: new Date().toISOString(),
                    }
                    writeState(activeRunDir, crashedState).catch(() => {})
                    setRunState(crashedState)
                    const detail = logTail ? `\n\n${logTail}` : ""
                    setLastError(`Daemon died unexpectedly while ${final.state.phase}${detail}`)
                    setPhase("error")
                  }
                } else {
                  setLastError(logTail || "Daemon died and state could not be read")
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
          if (err instanceof DirtyWorkingTreeError) {
            const status = await getWorkingTreeStatus(cwd)
            setDirtyFiles(status)
            setPhase("dirty")
          } else {
            setLastError(formatShellError(err))
            setPhase("error")
          }
        }
      }
    })()

    return () => {
      cancelled = true
      watcherRef.current?.stop()
    }
  }, [cwd, programSlug, modelConfig, maxExperiments, maxCostUsd, useWorktree, carryForward, keepSimplifications, attachRunId, ideasBacklogEnabled, retryCount, fallbackModel])

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

  const handleDirtyRetry = useCallback(() => {
    setPhase("starting")
    setDirtyFiles(null)
    setLastError(null)
    setRetryCount(c => c + 1)
  }, [])

  const handleDirtyQuit = useCallback(() => navigate("home"), [navigate])

  const handleFinalize = useCallback(async () => {
    if (!runState || !runDir || !programConfig) return
    setPhase("finalizing")

    try {
      const worktreePath = runState.in_place ? undefined : runState.worktree_path
      const effectiveCwd = worktreePath ?? cwd
      const context = await buildFinalizeContext(effectiveCwd, runDir, runState, programConfig)
      const systemPrompt = getFinalizeSystemPrompt(context)
      const initialMessage = await buildFinalizeInitialMessage(context)
      setFinalizeSystemPrompt(systemPrompt)
      setFinalizeInitialMessage(initialMessage)
      setFinalizeCwd(effectiveCwd)
    } catch (err: unknown) {
      setLastError(formatShellError(err, "Finalize failed"))
      setPhase("error")
    }
  }, [cwd, runDir, runState, programConfig])

  const restoreInPlaceBranch = useCallback(async () => {
    if (runState?.in_place && runState.original_branch) {
      const { checkoutBranch } = await import("../lib/git.ts")
      await checkoutBranch(cwd, runState.original_branch).catch(() => {})
    }
  }, [cwd, runState])

  const handleFinalizeMessagesChange = useCallback(async (messages: Array<{ role: "user" | "assistant"; content: string }>) => {
    if (!runState || !runDir || !programConfig) return

    // Check the last assistant message for the completion marker
    const lastAssistant = messages.findLast(m => m.role === "assistant")
    if (!lastAssistant) return

    const branch = extractFinalizeDone(lastAssistant.content)
    if (!branch) return

    // Agent is done — save report and transition
    try {
      const summary = generateSummaryReport(runState, results, programConfig, lastAssistant.content)
      await saveFinalizeReport(runDir, summary)

      // Persist finalization metadata to state.json
      await writeState(runDir, {
        ...runState,
        finalized_at: new Date().toISOString(),
        finalized_branch: branch,
      })

      await restoreInPlaceBranch()
      setFinalizeResult({ summary, branch })
      setPhase("finalize_complete")
    } catch (err: unknown) {
      setLastError(formatShellError(err, "Failed to save finalize report"))
      setPhase("error")
    }
  }, [runState, runDir, programConfig, results, restoreInPlaceBranch])

  const handleUpdateProgram = useCallback(async () => {
    await cleanupRunEnvironment()
    onUpdateProgram?.(programSlug)
  }, [cleanupRunEnvironment, programSlug, onUpdateProgram])

  const handleVerifyStart = useCallback(() => {
    setShowVerifyOverlay(true)
  }, [])

  const handleVerifyConfirm = useCallback(async (target: "baseline" | "current" | "both", repeats: number) => {
    if (!runState || !runDir || !programConfig) return
    setShowVerifyOverlay(false)
    setIsVerifying(true)
    setVerifyProgress("Preparing verification...")

    const verifyAbort = new AbortController()
    abortControllerRef.current = verifyAbort

    try {
      const worktreeCwd = runState.in_place ? cwd : (runState.worktree_path ?? cwd)
      const programDir = getProgramDir(cwd, programSlug)

      const verificationRunResults = await runVerification({
        target,
        repeats,
        config: programConfig,
        state: runState,
        programDir,
        cwd: worktreeCwd,
        signal: verifyAbort.signal,
        onProgress: (status) => setVerifyProgress(status),
      })

      await appendVerificationResults(runDir, verificationRunResults, runState)
      setVerificationResults(prev => [...(prev ?? []), ...verificationRunResults])
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        setLastError(formatShellError(err, "Verification failed"))
      }
    } finally {
      setIsVerifying(false)
      setVerifyProgress(null)
    }
  }, [cwd, runDir, runState, programConfig, programSlug])

  const handleVerifyCancel = useCallback(() => {
    setShowVerifyOverlay(false)
  }, [])

  // Auto-finalize: trigger finalize immediately when attaching to a completed run with autoFinalize
  const autoFinalizeTriggered = useRef(false)
  useEffect(() => {
    if (autoFinalize && phase === "complete" && !autoFinalizeTriggered.current) {
      autoFinalizeTriggered.current = true
      handleFinalize()
    }
  }, [autoFinalize, phase, handleFinalize])

  useKeyboard((key) => {
    if (phase === "finalizing") {
      // Escape cancels finalize and returns to complete phase
      // (unmounting Chat triggers session cleanup)
      if (key.name === "escape") {
        setPhase("complete")
        setFinalizeSystemPrompt(null)
        setFinalizeInitialMessage(null)
        setFinalizeCwd(null)
      }
      // Chat component handles all other keyboard input
      return
    }

    if (phase === "finalize_complete") {
      if (key.name === "escape") {
        navigate("home")
      }
      return
    }

    if (phase === "dirty") {
      // DirtyTreePrompt handles its own keyboard
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

    // Verify overlay intercepts all keys
    if (showVerifyOverlay) return

    // Ctrl+C during verification aborts
    if (isVerifying && key.ctrl && key.name === "c") {
      abortControllerRef.current.abort()
      return
    }

    if (phase === "complete" && readOnly) {
      if (key.name === "escape") {
        navigate("home")
      } else if ((key.name === "[" || key.name === "]") && ideasVisible) {
        const next: FocusPanel = activeBottomTab === "agent" ? "ideas" : "agent"
        setActiveBottomTab(next)
        setFocusedPanel(next)
      } else if (key.name === "i" && !runState?.finalized_at) {
        setShowIdeas(v => !v)
      } else if (key.name === "f" && !runState?.finalized_at) {
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
      } else if (key.name === "a") {
        setShowStopConfirm(false)
        setStopping(true)
        setCurrentPhaseLabel("Aborting...")
        abortSentRef.current = true
        if (runDir) sendAbort(runDir).catch(() => {})
        abortTimerRef.current = setTimeout(() => {
          if (runDir) forceKillDaemon(runDir).catch(() => {})
        }, 5_000)
      } else if (key.name === "n" || key.name === "escape") {
        setShowStopConfirm(false)
      }
      return
    }

    // During execution: Tab to cycle panel focus
    if ((phase === "starting" || phase === "running") && key.name === "tab") {
      const next: FocusPanel =
        focusedPanel === "results" ? "agent" :
        focusedPanel === "agent" ? (ideasVisible ? "ideas" : "results") :
        "results"
      setFocusedPanel(next)
      if (next === "agent" || next === "ideas") setActiveBottomTab(next)
      return
    }

    // [ and ] to switch between Agent and Ideas panels (lazygit-style)
    if ((key.name === "[" || key.name === "]") && ideasVisible && (phase === "starting" || phase === "running")) {
      const next: FocusPanel = activeBottomTab === "agent" ? "ideas" : "agent"
      setActiveBottomTab(next)
      setFocusedPanel(next)
      return
    }

    // Escape: deselect first, then unfocus panel, then detach (go back while daemon continues)
    if (key.name === "escape") {
      if (selectedResult) {
        setSelectedResult(null)
        return
      }
      if (focusedPanel !== "agent") {
        setFocusedPanel("agent")
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

  })

  // Clean up abort timer on unmount
  useEffect(() => {
    return () => {
      if (abortTimerRef.current) clearTimeout(abortTimerRef.current)
    }
  }, [])

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      {(phase === "starting" || phase === "running") && (
        <box flexDirection="column" flexGrow={1}>
          <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={BORDER_DIM} title={programSlug}>
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
              maxCostUsd={maxCostUsd}
              metricHistory={metricHistory}
              currentPhaseLabel={currentPhaseLabel}
              improvementPct={runState && programConfig ? getRunStats(runState, programConfig.direction).improvement_pct : 0}
              isRunning
              quotaInfo={quotaInfo}
            />
          </box>

          {compact ? (
            <box
              flexDirection="column"
              flexGrow={1}
              border
              borderStyle="rounded"
              borderColor={BORDER_ACTIVE}
              title={focusedPanel === "results" ? "Results" : (selectedResult ? `Experiment #${selectedResult.experiment_number}` : "Agent")}
              onMouseDown={() => setFocusedPanel(p => p === "results" ? "agent" : "results")}
            >
              {focusedPanel === "results" ? (
                <ResultsTable
                  results={results}
                  metricField={programConfig?.metric_field ?? "metric"}
                  secondaryMetrics={secondaryMetricsConfig}
                  width={termWidth}
                  experimentNumber={experimentNumber}
                  focused={focusedPanel === "results"}
                  selectedResult={selectedResult}
                  onSelect={setSelectedResult}
                  onHighlight={() => setFocusedPanel("results")}
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
            </box>
          ) : (
            <>
              <box
                flexDirection="column"
                flexGrow={1}
                border
                borderStyle="rounded"
                borderColor={focusedPanel === "results" ? BORDER_ACTIVE : BORDER_DIM}
                title="Results"
                onMouseDown={() => setFocusedPanel("results")}
              >
                <ResultsTable
                  results={results}
                  metricField={programConfig?.metric_field ?? "metric"}
                  secondaryMetrics={secondaryMetricsConfig}
                  width={termWidth}
                  experimentNumber={experimentNumber}
                  focused={focusedPanel === "results"}
                  selectedResult={selectedResult}
                  onSelect={setSelectedResult}
                  onHighlight={() => setFocusedPanel("results")}
                />
              </box>

              <BottomPanels
                narrowWidth={narrowWidth}
                ideasVisible={ideasVisible}
                ideasText={displayIdeasText}
                activeBottomTab={activeBottomTab}
                focusedPanel={focusedPanel}
                selectedResult={selectedResult}
                agentStreamText={agentStreamText}
                toolStatus={toolStatus}
                isRunning={phase === "running"}
                secondaryMetrics={secondaryMetricsConfig}
                setFocusedPanel={setFocusedPanel}
                setActiveBottomTab={setActiveBottomTab}
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
              <text fg={colors.warning} selectable>Stop after current experiment (y) / Abort immediately (a) / Cancel (n)</text>
            </box>
          )}

          {stopping && !showStopConfirm && (
            <box paddingX={1}>
              <text fg={colors.warning} selectable>Stopping after current experiment...</text>
            </box>
          )}

          {lastError && (
            <box paddingX={1}>
              <text fg={colors.error} selectable>{lastError}</text>
            </box>
          )}

          <box paddingX={1} flexShrink={0}>
            <text fg={colors.textMuted}>Esc: detach · Tab: switch panel · s: settings · q: stop{ideasVisible ? " · [/]: agent/ideas · i: ideas" : ideasText.length > 0 ? " · i: ideas" : ""}</text>
          </box>
        </box>
      )}

      {phase === "complete" && runState && readOnly && (
        <box flexDirection="column" flexGrow={1}>
          <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={BORDER_DIM} title={programSlug}>
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
              maxCostUsd={maxCostUsd}
              metricHistory={metricHistory}
              currentPhaseLabel="Complete"
              improvementPct={programConfig ? getRunStats(runState, programConfig.direction).improvement_pct : 0}
              quotaInfo={quotaInfo}
            />
          </box>
          <box
            flexDirection="column"
            flexGrow={1}
            border
            borderStyle="rounded"
            borderColor={focusedPanel === "results" ? BORDER_ACTIVE : BORDER_DIM}
            title="Results"
            onMouseDown={() => setFocusedPanel("results")}
          >
            <ResultsTable
              results={results}
              metricField={programConfig?.metric_field ?? "metric"}
              secondaryMetrics={secondaryMetricsConfig}
              width={termWidth}
              experimentNumber={experimentNumber}
              focused={focusedPanel === "results"}
              selectedResult={selectedResult}
              onSelect={setSelectedResult}
              onHighlight={() => setFocusedPanel("results")}
            />
          </box>
          {summaryText ? (
            <box
              flexDirection="column"
              flexGrow={1}
              border
              borderStyle="rounded"
              borderColor={focusedPanel === "agent" ? BORDER_ACTIVE : BORDER_DIM}
              title="Summary"
              onMouseDown={() => setFocusedPanel("agent")}
            >
              <scrollbox flexGrow={1} focused>
                <box paddingX={1} flexDirection="column">
                  <markdown content={summaryText} syntaxStyle={syntaxStyle} />
                </box>
              </scrollbox>
            </box>
          ) : (
            <BottomPanels
              narrowWidth={narrowWidth}
              ideasVisible={ideasVisible}
              ideasText={displayIdeasText}
              activeBottomTab={activeBottomTab}
              focusedPanel={focusedPanel}
              selectedResult={selectedResult}
              agentStreamText={agentStreamText}
              toolStatus={toolStatus}
              isRunning={false}
              secondaryMetrics={secondaryMetricsConfig}
              setFocusedPanel={setFocusedPanel}
              setActiveBottomTab={setActiveBottomTab}
            />
          )}
          <box paddingX={1} flexShrink={0}>
            <text fg={colors.textMuted}>
              {summaryText
                ? "Esc back"
                : `Esc back · f finalize${ideasVisible ? " · [/]: agent/ideas · i toggle ideas" : ideasText.length > 0 ? " · i toggle ideas" : ""}`}
            </text>
          </box>
        </box>
      )}

      {phase === "complete" && runState && !readOnly && (
        <>
          <RunCompletePrompt
            state={runState}
            direction={programConfig?.direction ?? "lower"}
            terminationReason={terminationReason}
            error={lastError}
            onFinalize={handleFinalize}
            onAbandon={handleAbandon}
            onUpdateProgram={handleUpdateProgram}
            onVerify={handleVerifyStart}
            verificationResults={verificationResults}
            isVerifying={isVerifying}
            verifyProgress={verifyProgress}
          />
          {showVerifyOverlay && (
            <VerifyResultsOverlay
              defaultRepeats={programConfig?.repeats ?? 3}
              onConfirm={handleVerifyConfirm}
              onCancel={handleVerifyCancel}
            />
          )}
        </>
      )}

      {phase === "finalizing" && finalizeSystemPrompt && (
        <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
          <Chat
            cwd={finalizeCwd ?? cwd}
            systemPrompt={finalizeSystemPrompt}
            tools={FINALIZE_TOOLS}
            allowedTools={FINALIZE_TOOLS}
            provider={supportModelConfig.provider}
            model={supportModelConfig.model}
            effort={supportModelConfig.effort}
            initialMessage={finalizeInitialMessage ?? undefined}
            title={`Finalize · ${headerModelLabel}`}
            onMessagesChange={handleFinalizeMessagesChange}
          />
          <box paddingX={1} flexShrink={0}>
            <text fg={colors.textMuted}>Esc: cancel finalize</text>
          </box>
        </box>
      )}

      {phase === "finalize_complete" && finalizeResult && (
        <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
          <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0} border borderStyle="rounded" title="Finalize Complete">
            <box flexDirection="column" paddingX={1}>
              {finalizeResult.branch && (
                <text fg={colors.success} selectable>Changes packaged on branch: {finalizeResult.branch}</text>
              )}
              <box height={1} />
              <text fg={colors.text}>Summary saved to run directory.</text>
            </box>
            <scrollbox flexGrow={1} focused>
              <box paddingX={1} flexDirection="column">
                <markdown content={finalizeResult.summary} syntaxStyle={syntaxStyle} />
              </box>
            </scrollbox>
          </box>
          <box paddingX={1} flexShrink={0}>
            <text fg={colors.textMuted}>Esc: back</text>
          </box>
        </box>
      )}

      {phase === "dirty" && (
        <DirtyTreePrompt
          cwd={cwd}
          dirtyFiles={dirtyFiles ?? ""}
          modelConfig={modelConfig}
          onRetry={handleDirtyRetry}
          onQuit={handleDirtyQuit}
        />
      )}

      {phase === "error" && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Error">
          <box padding={1}>
            <text fg={colors.error} selectable>{lastError ?? "Unknown error"}</text>
          </box>
          <box padding={1}>
            <text fg={colors.textMuted}>
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
