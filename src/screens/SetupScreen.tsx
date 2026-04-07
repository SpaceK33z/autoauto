import { useKeyboard } from "@opentui/react"
import { Chat } from "../components/Chat.tsx"
import type { Screen } from "../lib/programs.ts"

interface SetupScreenProps {
  navigate: (screen: Screen) => void
}

export function SetupScreen({ navigate }: SetupScreenProps) {
  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("home")
    }
  })

  return <Chat />
}
