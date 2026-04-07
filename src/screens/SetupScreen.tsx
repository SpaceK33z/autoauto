import { useMemo } from "react"
import { useKeyboard } from "@opentui/react"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts.ts"
import type { Screen } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"

const SETUP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
const SETUP_MAX_TURNS = 40

interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  modelConfig: ModelSlot
}

export function SetupScreen({ cwd, navigate, modelConfig }: SetupScreenProps) {
  const systemPrompt = useMemo(() => getSetupSystemPrompt(cwd), [cwd])

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("home")
    }
  })

  return (
    <Chat
      cwd={cwd}
      systemPrompt={systemPrompt}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      maxTurns={SETUP_MAX_TURNS}
      model={modelConfig.model}
      effort={modelConfig.effort}
    />
  )
}
