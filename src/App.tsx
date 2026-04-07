import { useState, useEffect } from "react"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react"
import { HomeScreen } from "./screens/HomeScreen.tsx"
import { SetupScreen } from "./screens/SetupScreen.tsx"
import { SettingsScreen } from "./screens/SettingsScreen.tsx"
import { AuthErrorScreen } from "./screens/AuthErrorScreen.tsx"
import { ensureAutoAutoDir, getProjectRoot, type Screen } from "./lib/programs.ts"
import { checkAuth } from "./lib/auth.ts"
import { loadProjectConfig, DEFAULT_CONFIG, type ProjectConfig } from "./lib/config.ts"

const cwd = process.cwd()

export function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [screen, setScreen] = useState<Screen>("home")
  const [projectRoot, setProjectRoot] = useState(cwd)
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "error">("checking")
  const [authError, setAuthError] = useState("")
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(DEFAULT_CONFIG)

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

      {screen === "home" && <HomeScreen cwd={cwd} navigate={setScreen} />}
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

      <text fg="#888888">
        {screen === "home"
          ? " n: new program | s: settings | Escape: quit"
          : screen === "settings"
            ? " ↑↓: navigate | ←→: change | Escape: back"
            : " Escape: back"}
      </text>
    </box>
  )
}
