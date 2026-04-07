import { useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts.ts"
import { getProjectRoot, type Screen } from "../lib/programs.ts"

const SETUP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
const SETUP_MAX_TURNS = 30

interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
}

export function SetupScreen({ cwd, navigate }: SetupScreenProps) {
  const [projectRoot, setProjectRoot] = useState<string | null>(null)

  useEffect(() => {
    getProjectRoot(cwd).then(setProjectRoot).catch(() => setProjectRoot(cwd))
  }, [cwd])

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("home")
    }
  })

  if (!projectRoot) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#888888">Resolving project root...</text>
      </box>
    )
  }

  return (
    <Chat
      cwd={projectRoot}
      systemPrompt={getSetupSystemPrompt(projectRoot)}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      maxTurns={SETUP_MAX_TURNS}
    />
  )
}
