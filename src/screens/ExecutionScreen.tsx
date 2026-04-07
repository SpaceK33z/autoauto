import { useState, useEffect, useRef, useCallback } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import type { Screen, ProgramConfig } from "../lib/programs.ts"
import { getProgramDir, loadProgramConfig } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import type { RunState, ExperimentResult } from "../lib/run.ts"
import { startRun, getRunStats } from "../lib/run.ts"
import { checkoutBranch } from "../lib/git.ts"
import { runExperimentLoop, type LoopCallbacks, type TerminationReason } from "../lib/experiment-loop.ts"
import { runCleanup, type CleanupResult } from "../lib/cleanup.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"
import { StatsHeader } from "../components/StatsHeader.tsx"
import { ResultsTable } from "../components/ResultsTable.tsx"
import { AgentPanel } from "../components/AgentPanel.tsx"

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
  navigate: (screen: Screen) => void
}

function Divider({ width, label }: { width: number; label?: string }) {
  // Account for outer border (2 chars) and label padding
  const innerWidth = Math.max(width - 2, 0)
  if (label) {
    const labelStr = `─ ${label} `
    const rest = "─".repeat(Math.max(innerWidth - labelStr.length, 0))
    return <text fg="#414868">{labelStr}{rest}</text>
  }
  return <text fg="#414868">{"─".repeat(innerWidth)}</text>
}

export function ExecutionScreen({ cwd, programSlug, modelConfig, supportModelConfig, navigate }: ExecutionScreenProps) {
  const { width: termWidth } = useTerminalDimensions()
  const [phase, setPhase] = useState<ExecutionPhase>("starting")
  const [runState, setRunState] = useState<RunState | null>(null)
  const [currentPhaseLabel, setCurrentPhaseLabel] = useState("Initializing...")
  const [experimentNumber, setExperimentNumber] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [terminationReason, setTerminationReason] = useState<TerminationReason | null>(null)
  const [originalBranch, setOriginalBranch] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController>(null!)

  const [results, setResults] = useState<ExperimentResult[]>([])
  const [metricHistory, setMetricHistory] = useState<number[]>([])
  const [agentStreamText, setAgentStreamText] = useState("")
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [totalCostUsd, setTotalCostUsd] = useState(0)
  const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)
  const [runDir, setRunDir] = useState<string | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)

  useEffect(() => {
    const abortController = new AbortController()
    abortControllerRef.current = abortController
    let cancelled = false

    ;(async () => {
      try {
        // 1. Start run (branch, baseline)
        setCurrentPhaseLabel("Establishing baseline...")
        const runResult = await startRun(cwd, programSlug)
        if (cancelled) return

        setOriginalBranch(runResult.originalBranch)
        setRunDir(runResult.runDir)
        setRunState(runResult.state)
        setMetricHistory([runResult.state.original_baseline])
        setPhase("running")
        setCurrentPhaseLabel("Running experiments...")

        // 2. Load program config
        const programDir = getProgramDir(cwd, programSlug)
        const config = await loadProgramConfig(programDir)
        if (!cancelled) setProgramConfig(config)

        // 3. Build callbacks
        const callbacks: LoopCallbacks = {
          onPhaseChange: (p, detail) => {
            if (!cancelled) setCurrentPhaseLabel(detail ? `${p}: ${detail}` : p)
          },
          onExperimentStart: (num) => {
            if (!cancelled) {
              setExperimentNumber(num)
              setAgentStreamText("")
              setToolStatus(null)
            }
          },
          onExperimentEnd: (result) => {
            if (!cancelled) {
              setResults(prev => [...prev, result])
              if (result.status === "keep") {
                setMetricHistory(prev => [...prev, result.metric_value])
              }
            }
          },
          onStateUpdate: (s) => {
            if (!cancelled) setRunState(s)
          },
          onAgentStream: (text) => {
            if (!cancelled) setAgentStreamText(prev => truncateStreamText(prev, text))
          },
          onAgentToolUse: (status) => {
            if (!cancelled) setToolStatus(status)
          },
          onExperimentCost: (cost) => {
            if (!cancelled) setTotalCostUsd(prev => prev + cost.total_cost_usd)
          },
          onError: (msg) => {
            if (!cancelled) setLastError(msg)
          },
          onLoopComplete: (_state, reason) => {
            if (!cancelled) setTerminationReason(reason)
          },
        }

        // 4. Run the experiment loop
        const finalState = await runExperimentLoop(
          cwd,
          programSlug,
          runResult.runDir,
          config,
          modelConfig,
          callbacks,
          {
            maxExperiments: config.max_experiments,
            signal: abortController.signal,
          },
        )

        if (!cancelled) {
          setRunState(finalState)
          setPhase("complete")
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
      abortController.abort()
    }
  }, [cwd, programSlug, modelConfig])

  const handleAbandon = useCallback(() => {
    if (originalBranch) {
      checkoutBranch(cwd, originalBranch).catch(() => {})
    }
    navigate("home")
  }, [cwd, originalBranch, navigate])

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
        handleAbandon()
      }
      return
    }

    if (phase === "complete") {
      // RunCompletePrompt handles its own keyboard
      return
    }

    // During execution or cleanup
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      abortControllerRef.current.abort()
    }
  })

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

          <Divider width={termWidth} label="Results" />

          <ResultsTable
            results={results}
            metricField={programConfig?.metric_field ?? "metric"}
            width={termWidth}
          />

          <Divider width={termWidth} label="Agent" />

          <AgentPanel
            streamingText={agentStreamText}
            toolStatus={toolStatus}
            isRunning={phase === "running"}
          />

          {lastError && (
            <box paddingX={1}>
              <text fg="#ff5555">{lastError}</text>
            </box>
          )}
        </box>
      )}

      {phase === "complete" && runState && (
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
          <box flexDirection="column" padding={1}>
            {cleanupResult.squashedSha ? (
              <text fg="#9ece6a">Commits squashed into {cleanupResult.squashedSha.slice(0, 7)}</text>
            ) : (
              <text fg="#888888">No changes to squash (0 keeps)</text>
            )}
            <text>{""}</text>
            <text>Summary saved to run directory</text>
            <text fg="#888888">Press Escape to go back</text>
          </box>
          <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
            <text>{cleanupResult.summary}</text>
          </scrollbox>
        </box>
      )}

      {phase === "error" && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Error">
          <box padding={1}>
            <text fg="#ff5555">{lastError ?? "Unknown error"}</text>
          </box>
          <box padding={1}>
            <text fg="#888888">Press Escape to go back</text>
          </box>
        </box>
      )}
    </box>
  )
}
