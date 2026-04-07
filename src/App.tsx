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
import { AuthErrorScreen } from "./screens/AuthErrorScreen.tsx"
import { ensureAutoAutoDir, getProjectRoot, type Screen } from "./lib/programs.ts"
import { checkAuth } from "./lib/auth.ts"
import { loadProjectConfig, DEFAULT_CONFIG, type ProjectConfig } from "./lib/config.ts"
import { isRunActive } from "./lib/run.ts"

const cwd = process.cwd()

export function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [screen, setScreen] = useState<Screen>("home")
  const [selectedProgram, setSelectedProgram] = useState<string | null>(null)
  const [projectRoot, setProjectRoot] = useState(cwd)
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "error">("checking")
  const [authError, setAuthError] = useState("")
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(DEFAULT_CONFIG)
  const [preRunOverrides, setPreRunOverrides] = useState<PreRunOverrides | null>(null)
  const [attachRunId, setAttachRunId] = useState<string | null>(null)
  const [attachReadOnly, setAttachReadOnly] = useState(false)

  useEffect(() => {
    getProjectRoot(cwd).then(setProjectRoot).catch(() => {})
    ensureAutoAutoDir(cwd).catch(() => {})
  }, [])

  // Auth check on mount
  useEffect(() => {
    checkAuth().then((result) => {
      if (result.authenticated) {
        setAuthState("authenticated")
      } else {
        setAuthState("error")
        setAuthError(result.error)
      }
    })
  }, [])

  // Load project config after auth succeeds + reload when returning to home
  useEffect(() => {
    if (screen === "home" && authState === "authenticated") {
      loadProjectConfig(cwd).then(setProjectConfig)
    }
  }, [screen, authState])

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (screen === "home" || authState === "error") {
        renderer.destroy()
      }
      // execution screen handles its own Escape
    }
  })

  // Loading state
  if (authState === "checking") {
    return (
      <box
        flexDirection="column"
        width={width}
        height={height}
        justifyContent="center"
        alignItems="center"
      >
        <text fg="#888888">Connecting...</text>
      </box>
    )
  }

  // Auth error
  if (authState === "error") {
    return (
      <box flexDirection="column" width={width} height={height}>
        <AuthErrorScreen error={authError} />
        <text fg="#888888">{" Escape: quit"}</text>
      </box>
    )
  }

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
            setAttachReadOnly(!isRunActive(run))
            setScreen("execution")
          }}
        />
      )}
      {screen === "setup" && (
        <SetupScreen
          cwd={projectRoot}
          navigate={setScreen}
          modelConfig={projectConfig.supportModel}
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
          navigate={(s) => { setPreRunOverrides(null); setAttachRunId(null); setAttachReadOnly(false); setScreen(s) }}
          maxExperiments={preRunOverrides?.maxExperiments}
          attachRunId={attachRunId ?? undefined}
          readOnly={attachReadOnly}
        />
      )}

      {screen !== "pre-run" && (
        <text fg="#888888">
          {screen === "home"
            ? " n: new program | s: settings | Tab: switch panel | Enter: run | Escape: quit"
            : screen === "execution"
              ? " q: abort run | Escape: back (after completion)"
              : screen === "settings"
                ? " ↑↓: navigate | ←→: change | Escape: back"
                : " Escape: back"}
        </text>
      )}
    </box>
  )
}
