import { useKeyboard } from "@opentui/react"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts.ts"
import type { Screen } from "../lib/programs.ts"

/** Read-only tools for repo inspection */
const SETUP_TOOLS = ["Read", "Bash", "Glob", "Grep"]

/** Auto-allow all inspection tools (no permission prompts) */
const SETUP_ALLOWED_TOOLS = SETUP_TOOLS

/** Max tool-use round-trips per user message */
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
      allowedTools={SETUP_ALLOWED_TOOLS}
      maxTurns={SETUP_MAX_TURNS}
    />
  )
}
