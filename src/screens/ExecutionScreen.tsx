import { useState, useEffect, useRef } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen, ProgramConfig } from "../lib/programs.ts"
import { getProgramDir, loadProgramConfig } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import type { RunState, ExperimentResult } from "../lib/run.ts"
import { startRun } from "../lib/run.ts"
import { checkoutBranch } from "../lib/git.ts"
import { runExperimentLoop, type LoopCallbacks, type TerminationReason } from "../lib/experiment-loop.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"
import { StatsHeader } from "../components/StatsHeader.tsx"
import { ResultsTable } from "../components/ResultsTable.tsx"
import { AgentPanel } from "../components/AgentPanel.tsx"

type ExecutionPhase = "starting" | "running" | "complete" | "error"

interface ExecutionScreenProps {
  cwd: string
  programSlug: string
  modelConfig: ModelSlot
  navigate: (screen: Screen) => void
}

export function ExecutionScreen({ cwd, programSlug, modelConfig, navigate }: ExecutionScreenProps) {
  const [phase, setPhase] = useState<ExecutionPhase>("starting")
  const [runState, setRunState] = useState<RunState | null>(null)
  const [currentPhaseLabel, setCurrentPhaseLabel] = useState("Initializing...")
  const [experimentNumber, setExperimentNumber] = useState(0)
  const [lastError, setLastError] = useState<string | null>(null)
  const [terminationReason, setTerminationReason] = useState<TerminationReason | null>(null)
  const [originalBranch, setOriginalBranch] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController>(null!)

  // Phase 2f: Dashboard state
  const [results, setResults] = useState<ExperimentResult[]>([])
  const [metricHistory, setMetricHistory] = useState<number[]>([])
  const [agentStreamText, setAgentStreamText] = useState("")
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const [totalCostUsd, setTotalCostUsd] = useState(0)
  const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)

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
            if (!cancelled) setAgentStreamText(prev => prev + text)
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

  const handleExit = () => {
    if (originalBranch) {
      checkoutBranch(cwd, originalBranch).catch(() => {})
    }
    navigate("home")
  }

  useKeyboard((key) => {
    if (phase === "complete" || phase === "error") {
      if (key.name === "escape") {
        navigate("home")
      }
      return
    }

    // During execution
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      abortControllerRef.current.abort()
    }
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      {(phase === "starting" || phase === "running") && (
        <box flexDirection="column" flexGrow={1}>
          <StatsHeader
            experimentNumber={experimentNumber}
            totalKeeps={runState?.total_keeps ?? 0}
            totalDiscards={runState?.total_discards ?? 0}
            totalCrashes={runState?.total_crashes ?? 0}
            currentBaseline={runState?.current_baseline ?? 0}
            originalBaseline={runState?.original_baseline ?? 0}
            bestMetric={runState?.best_metric ?? 0}
            bestExperiment={runState?.best_experiment ?? 0}
            direction={programConfig?.direction ?? "lower"}
            metricField={programConfig?.metric_field ?? "metric"}
            totalCostUsd={totalCostUsd}
            metricHistory={metricHistory}
            currentPhaseLabel={currentPhaseLabel}
          />

          <ResultsTable
            results={results}
            metricField={programConfig?.metric_field ?? "metric"}
          />

          <AgentPanel
            streamingText={agentStreamText}
            toolStatus={toolStatus}
            isRunning={phase === "running"}
          />

          {lastError && (
            <box padding={1}>
              <text fg="#ff5555">{lastError}</text>
            </box>
          )}
        </box>
      )}

      {(phase === "complete" || phase === "error") && runState && (
        <RunCompletePrompt
          state={runState}
          terminationReason={terminationReason}
          error={phase === "error" ? lastError : null}
          onCleanup={handleExit}
          onAbandon={handleExit}
        />
      )}

      {phase === "error" && !runState && (
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Error">
          <box padding={1}>
            <text fg="#ff5555">{lastError ?? "Unknown error"}</text>
          </box>
        </box>
      )}
    </box>
  )
}
