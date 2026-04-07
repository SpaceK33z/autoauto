import { useKeyboard } from "@opentui/react"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts.ts"
import type { Screen } from "../lib/programs.ts"

const SETUP_TOOLS = ["Read", "Bash", "Glob", "Grep"]
const SETUP_MAX_TURNS = 20

interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
}

export function SetupScreen({ cwd, navigate }: SetupScreenProps) {
  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("home")
    }
  })

  return (
    <Chat
      cwd={cwd}
      systemPrompt={getSetupSystemPrompt(cwd)}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      maxTurns={SETUP_MAX_TURNS}
    />
  )
}
