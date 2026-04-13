import { useState, useEffect, useMemo } from "react"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react"
import { colors } from "./lib/theme.ts"
import { HomeScreen } from "./screens/HomeScreen.tsx"
import { SetupScreen } from "./screens/SetupScreen.tsx"
import { SettingsScreen } from "./screens/SettingsScreen.tsx"
import { ExecutionScreen } from "./screens/ExecutionScreen.tsx"
import { PreRunScreen, type PreRunOverrides } from "./screens/PreRunScreen.tsx"
import { FirstSetupScreen } from "./screens/FirstSetupScreen.tsx"
import { PostUpdatePrompt } from "./components/PostUpdatePrompt.tsx"
import { ensureAutoAutoDir, getProjectRoot, type Screen } from "./lib/programs.ts"
import { loadProjectConfig, configExists, DEFAULT_CONFIG, type ProjectConfig } from "./lib/config.ts"
import { isRunActive } from "./lib/run.ts"
import { deleteDraft, type DraftSession } from "./lib/drafts.ts"
import { readQueue, appendToQueue, startNextFromQueue, programHasQueueEntries } from "./lib/queue.ts"
import { LocalRunBackend } from "./lib/run-backend/local.ts"
import { SandboxRunBackend } from "./lib/run-backend/sandbox.ts"
import { getContainerProviderFactory } from "./lib/container-provider/index.ts"
import type { RunBackend } from "./lib/run-backend/types.ts"

const cwd = process.cwd()

export function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [screen, setScreen] = useState<Screen | null>(null)
  const [selectedProgram, setSelectedProgram] = useState<string | null>(null)
  const [projectRoot, setProjectRoot] = useState(cwd)
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(DEFAULT_CONFIG)
  const [preRunOverrides, setPreRunOverrides] = useState<PreRunOverrides | null>(null)
  const [attachRunId, setAttachRunId] = useState<string | null>(null)
  const [attachReadOnly, setAttachReadOnly] = useState(false)
  const [autoFinalize, setAutoFinalize] = useState(false)
  const [updateProgramSlug, setUpdateProgramSlug] = useState<string | null>(null)
  const [showPostUpdatePrompt, setShowPostUpdatePrompt] = useState(false)
  const [draftName, setDraftName] = useState<string | null>(null)
  const [queueHasProgram, setQueueHasProgram] = useState(false)

  const runBackend: RunBackend = useMemo(() => {
    if (preRunOverrides?.useSandbox && preRunOverrides.sandboxProvider) {
      const factory = getContainerProviderFactory(preRunOverrides.sandboxProvider)
      if (factory) {
        return new SandboxRunBackend(() => factory({}))
      }
    }
    return new LocalRunBackend()
  }, [preRunOverrides?.useSandbox, preRunOverrides?.sandboxProvider])

  useEffect(() => {
    getProjectRoot(cwd).then(setProjectRoot).catch(() => {})
    ensureAutoAutoDir(cwd).catch(() => {})
    configExists(cwd).then((exists) => {
      setScreen(exists ? "home" : "first-setup")
    })
  }, [])

  // Load project config + reload when returning to home
  useEffect(() => {
    if (screen === "home") {
      loadProjectConfig(cwd).then((config) => {
        setProjectConfig(config)
      })
    }
    if (screen === "pre-run" && selectedProgram) {
      readQueue(projectRoot).then((queue) => {
        setQueueHasProgram(programHasQueueEntries(queue, selectedProgram))
      })
    }
  }, [screen, projectRoot, selectedProgram])

  useKeyboard((key) => {
    if (key.name === "q" && screen === "home") {
      renderer.destroy()
    }

    // Dev-only: Ctrl+D dumps a debug snapshot to /tmp
    if (process.env.DEV && key.ctrl && key.name === "d") {
      key.stopPropagation()
      const buffer = renderer.currentRenderBuffer
      if (buffer) {
        const frameBytes = buffer.getRealCharBytes(true)
        const frame = new TextDecoder().decode(frameBytes)
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        const meta = `Screen: ${screen} | ${width}x${height} | ${timestamp}\n${"─".repeat(width)}\n`
        Bun.write(`/tmp/autoauto-debug-${timestamp}.txt`, meta + frame)
      }
    }
  })

  if (!screen) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg={colors.textMuted}>Loading...</text>
        </box>
      </box>
    )
  }

  const footerText =
    screen === "home"
      ? " n: new/resume | e: edit | d: delete | f: finalize | s: settings | Tab: cycle | Enter: run | q: quit"
      : screen === "settings"
          ? " ↑↓: navigate | ←→: change/open | Enter: open model picker | Escape: back"
          : screen === "first-setup"
            ? " ↑↓: navigate | ←→: cycle | Enter: select/continue"
            : " Escape: back"

  return (
    <box flexDirection="column" width={width} height={height}>
      {screen !== "execution" && screen !== "pre-run" && (
        <box
          height={3}
          border
          borderStyle="rounded"
          justifyContent="center"
          alignItems="center"
        >
          <text>
            <strong>AutoAuto</strong>
          </text>
        </box>
      )}

      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        {screen === "first-setup" && (
          <FirstSetupScreen
            cwd={cwd}
            navigate={setScreen}
            onConfigChange={setProjectConfig}
          />
        )}
        {screen === "home" && (
          <HomeScreen
            cwd={cwd}
            navigate={setScreen}
            onSelectProgram={(slug) => {
              setSelectedProgram(slug)
              setAttachRunId(null)
              setAttachReadOnly(false)
              setScreen("pre-run")
            }}
            onSelectRun={(run) => {
              if (!run.state) return
              setSelectedProgram(run.state.program_slug)
              setPreRunOverrides(null)
              setAttachRunId(run.run_id)
              setAutoFinalize(false)
              setAttachReadOnly(!isRunActive(run))
              setScreen("execution")
            }}
            onFinalizeRun={(run) => {
              if (!run.state) return
              setSelectedProgram(run.state.program_slug)
              setPreRunOverrides(null)
              setAttachRunId(run.run_id)
              setAutoFinalize(true)
              setAttachReadOnly(false)
              setScreen("execution")
            }}
            onUpdateProgram={(slug) => {
              setUpdateProgramSlug(slug)
              setSelectedProgram(slug)
              setDraftName(null)
              setScreen("setup")
            }}
            onResumeDraft={(name: string, draft: DraftSession) => {
              setDraftName(name)
              if (draft.type === "update" && draft.programSlug) {
                setUpdateProgramSlug(draft.programSlug)
                setSelectedProgram(draft.programSlug)
              } else {
                setUpdateProgramSlug(null)
              }
              setScreen("setup")
            }}
            onResumeQueue={async () => {
              try {
                await startNextFromQueue(projectRoot, projectConfig.ideasBacklogEnabled)
              } catch (err) {
                process.stderr.write(`[queue] Resume failed: ${err}\n`)
              }
            }}
          />
        )}
        {screen === "setup" && !showPostUpdatePrompt && (
          <SetupScreen
            cwd={projectRoot}
            navigate={(s) => {
              if (updateProgramSlug && s === "home") {
                // Leaving update mode — show post-update prompt
                setShowPostUpdatePrompt(true)
              } else {
                setUpdateProgramSlug(null)
                setDraftName(null)
                setScreen(s)
              }
            }}
            modelConfig={projectConfig.supportModel}
            programSlug={updateProgramSlug ?? undefined}
            draftName={draftName ?? undefined}
            onDraftSaved={(name) => {
              setDraftName(name)
            }}
          />
        )}
        {screen === "setup" && showPostUpdatePrompt && selectedProgram && (
          <PostUpdatePrompt
            programSlug={selectedProgram}
            onStartRun={() => {
              setShowPostUpdatePrompt(false)
              if (draftName) deleteDraft(projectRoot, draftName).catch(() => {})
              setUpdateProgramSlug(null)
              setDraftName(null)
              setScreen("pre-run")
            }}
            onGoHome={() => {
              setShowPostUpdatePrompt(false)
              if (draftName) deleteDraft(projectRoot, draftName).catch(() => {})
              setUpdateProgramSlug(null)
              setDraftName(null)
              setScreen("home")
            }}
          />
        )}
        {screen === "settings" && (
          <SettingsScreen
            cwd={cwd}
            navigate={setScreen}
            config={projectConfig}
            onConfigChange={setProjectConfig}
          />
        )}
        {screen === "pre-run" && selectedProgram && (
          <PreRunScreen
            cwd={projectRoot}
            programSlug={selectedProgram}
            defaultModelConfig={projectConfig.executionModel}
            navigate={setScreen}
            onStart={(overrides) => {
              setPreRunOverrides(overrides)
              setAttachRunId(null)
              setAttachReadOnly(false)
              setScreen("execution")
            }}
            programHasQueueEntries={queueHasProgram}
            onAddToQueue={async (overrides) => {
              try {
                await appendToQueue(projectRoot, {
                  programSlug: selectedProgram,
                  modelConfig: overrides.modelConfig,
                  maxExperiments: overrides.maxExperiments,
                  maxCostUsd: overrides.maxCostUsd,
                  useWorktree: overrides.useWorktree,
                })
              } catch (err) {
                process.stderr.write(`[queue] Failed to enqueue: ${err}\n`)
              } finally {
                setScreen("home")
              }
            }}
          />
        )}
        {screen === "execution" && selectedProgram && (preRunOverrides || attachRunId) && (
          <ExecutionScreen
            cwd={projectRoot}
            programSlug={selectedProgram}
            modelConfig={preRunOverrides?.modelConfig ?? projectConfig.executionModel}
            supportModelConfig={projectConfig.supportModel}
            ideasBacklogEnabled={projectConfig.ideasBacklogEnabled}
            navigate={(s) => { setPreRunOverrides(null); setAttachRunId(null); setAttachReadOnly(false); setAutoFinalize(false); setScreen(s) }}
            maxExperiments={preRunOverrides?.maxExperiments ?? 0}
            maxCostUsd={preRunOverrides?.maxCostUsd}
            useWorktree={preRunOverrides?.useWorktree ?? true}
            carryForward={preRunOverrides?.carryForward ?? true}
            keepSimplifications={preRunOverrides?.keepSimplifications}
            attachRunId={attachRunId ?? undefined}
            readOnly={attachReadOnly}
            autoFinalize={autoFinalize}
            fallbackModel={projectConfig.executionFallbackModel}
            runBackend={runBackend}
            isSandbox={preRunOverrides?.useSandbox ?? false}
            sandboxProvider={preRunOverrides?.sandboxProvider}
            onUpdateProgram={(slug) => {
              setPreRunOverrides(null)
              setAttachRunId(null)
              setAttachReadOnly(false)
              setAutoFinalize(false)
              setUpdateProgramSlug(slug)
              setSelectedProgram(slug)
              setScreen("setup")
            }}
          />
        )}
      </box>

      {screen !== "pre-run" && screen !== "execution" && (
        <box height={1} flexShrink={0} paddingX={1}>
          <text fg={colors.textMuted}>{footerText}</text>
        </box>
      )}
    </box>
  )
}
