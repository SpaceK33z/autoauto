import { useState, useEffect } from "react"
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react"
import { HomeScreen } from "./screens/HomeScreen.tsx"
import { SetupScreen } from "./screens/SetupScreen.tsx"
import { ensureAutoAutoDir, type Screen } from "./lib/programs.ts"

const cwd = process.cwd()

export function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [screen, setScreen] = useState<Screen>("home")

  useEffect(() => {
    ensureAutoAutoDir(cwd).catch(() => {})
  }, [])

  useKeyboard((key) => {
    if (key.name === "escape" && screen === "home") {
      renderer.destroy()
    }
  })

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
      {screen === "setup" && <SetupScreen cwd={cwd} navigate={setScreen} />}

      <text fg="#888888">
        {screen === "home"
          ? " n: new program | Escape: quit"
          : " Escape: back"}
      </text>
    </box>
  )
}
