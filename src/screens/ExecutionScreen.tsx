import { useState, useEffect, useRef } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import { getProgramDir, loadProgramConfig } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import type { RunState } from "../lib/run.ts"
import { startRun } from "../lib/run.ts"
import { checkoutBranch } from "../lib/git.ts"
import { runExperimentLoop, type LoopCallbacks } from "../lib/experiment-loop.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"

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
  const [terminationReason, setTerminationReason] = useState<"aborted" | "max_experiments" | "stopped" | null>(null)
  const [originalBranch, setOriginalBranch] = useState<string | null>(null)
  const abortControllerRef = useRef(new AbortController())

  useEffect(() => {
    const abortController = abortControllerRef.current
    let cancelled = false

    ;(async () => {
      try {
        // 1. Start run (branch, baseline)
        setCurrentPhaseLabel("Establishing baseline...")
        const runResult = await startRun(cwd, programSlug)
        if (cancelled) return

        setOriginalBranch(runResult.originalBranch)
        setRunState(runResult.state)
        setPhase("running")
        setCurrentPhaseLabel("Running experiments...")

        // 2. Load program config for maxExperiments
        const programDir = getProgramDir(cwd, programSlug)
        const config = await loadProgramConfig(programDir)

        // 3. Build callbacks
        const callbacks: LoopCallbacks = {
          onPhaseChange: (p, detail) => {
            if (!cancelled) setCurrentPhaseLabel(detail ? `${p}: ${detail}` : p)
          },
          onExperimentStart: (num) => {
            if (!cancelled) setExperimentNumber(num)
          },
          onExperimentEnd: () => {},
          onStateUpdate: (s) => {
            if (!cancelled) setRunState(s)
          },
          onAgentStream: () => {},
          onAgentToolUse: (status) => {
            if (!cancelled) setCurrentPhaseLabel(status)
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
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`Running: ${programSlug}`}>
          <box flexDirection="column" padding={1}>
            <text>
              <strong>Experiment #{experimentNumber}</strong>
            </text>
            <text fg="#888888">{currentPhaseLabel}</text>
            {runState && (
              <box flexDirection="column">
                <text>{""}</text>
                <text>Baseline: {runState.original_baseline}</text>
                <text>Current: {runState.current_baseline}</text>
                <text>Keeps: {runState.total_keeps} | Discards: {runState.total_discards} | Crashes: {runState.total_crashes}</text>
              </box>
            )}
            {lastError && <text fg="#ff5555">{lastError}</text>}
          </box>
        </box>
      )}

      {(phase === "complete" || phase === "error") && runState && (
        <RunCompletePrompt
          state={runState}
          terminationReason={terminationReason}
          error={phase === "error" ? lastError : null}
          onCleanup={() => {
            // Phase 3 will implement cleanup. For now, navigate home.
            if (originalBranch) {
              checkoutBranch(cwd, originalBranch).catch(() => {})
            }
            navigate("home")
          }}
          onAbandon={() => {
            if (originalBranch) {
              checkoutBranch(cwd, originalBranch).catch(() => {})
            }
            navigate("home")
          }}
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
