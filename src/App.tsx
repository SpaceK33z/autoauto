import { useState, useEffect } from "react"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react"
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
      loadProjectConfig(cwd).then(setProjectConfig)
    }
  }, [screen])

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (screen === "home") {
        renderer.destroy()
      }
      // execution screen handles its own Escape
    }
  })

  if (!screen) {
    return (
      <box flexDirection="column" width={width} height={height}>
        <box flexGrow={1} justifyContent="center" alignItems="center">
          <text fg="#888888">Loading...</text>
        </box>
      </box>
    )
  }

  const footerText =
    screen === "home"
      ? " n: new | e: edit | d: delete | f: finalize | s: settings | Tab: switch | Enter: run | Esc: quit"
      : screen === "execution"
        ? " Escape: detach (daemon continues) | Tab: switch panel | s: settings | q: stop | Ctrl+C: abort"
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
              setScreen("setup")
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
                setScreen(s)
              }
            }}
            modelConfig={projectConfig.supportModel}
            programSlug={updateProgramSlug ?? undefined}
          />
        )}
        {screen === "setup" && showPostUpdatePrompt && selectedProgram && (
          <PostUpdatePrompt
            programSlug={selectedProgram}
            onStartRun={() => {
              setShowPostUpdatePrompt(false)
              setUpdateProgramSlug(null)
              setScreen("pre-run")
            }}
            onGoHome={() => {
              setShowPostUpdatePrompt(false)
              setUpdateProgramSlug(null)
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
            useWorktree={preRunOverrides?.useWorktree ?? true}
            attachRunId={attachRunId ?? undefined}
            readOnly={attachReadOnly}
            autoFinalize={autoFinalize}
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

      {screen !== "pre-run" && (
        <box height={1} flexShrink={0} paddingX={1}>
          <text fg="#888888">{footerText}</text>
        </box>
      )}
    </box>
  )
}
