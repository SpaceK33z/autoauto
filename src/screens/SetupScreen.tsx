import { useState, useMemo, useCallback } from "react"
import { useKeyboard } from "@opentui/react"
import type { TextareaOptions } from "@opentui/core"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts.ts"
import type { Screen } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"

type OpenTUISubmitEvent = Parameters<NonNullable<TextareaOptions["onSubmit"]>>[0]

const SETUP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
const SETUP_MAX_TURNS = 40

type SetupMode = "choose" | "scope" | "chat"

const MODE_OPTIONS = [
  {
    name: "Analyze my codebase",
    description: "Scan your project and suggest what to optimize",
    value: "analyze",
  },
  {
    name: "I know what I want to optimize",
    description: "Jump straight into the conversation",
    value: "direct",
  },
]

interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  modelConfig: ModelSlot
}

export function SetupScreen({ cwd, navigate, modelConfig }: SetupScreenProps) {
  const systemPrompt = useMemo(() => getSetupSystemPrompt(cwd), [cwd])
  const [mode, setMode] = useState<SetupMode>("choose")
  const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined)

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (mode === "scope") {
        setMode("choose")
      } else {
        navigate("home")
      }
    }
  })

  const handleModeSelect = useCallback((_index: number, option: { value?: unknown } | null) => {
    if (!option) return
    if (option.value === "direct") {
      setMode("chat")
    } else if (option.value === "analyze") {
      setMode("scope")
    }
  }, [])

  const handleScopeSubmit = useCallback((value: unknown) => {
    if (typeof value !== "string") return
    const scope = value.trim()
    if (scope) {
      setInitialMessage(`What could I optimize in this codebase, focusing on ${scope}?`)
    } else {
      setInitialMessage("What could I optimize in this codebase?")
    }
    setMode("chat")
  }, []) as
    & ((event: OpenTUISubmitEvent) => void)
    & ((value: string) => void)

  if (mode === "choose") {
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="New Program">
          <box height={1} />
          <text>{"  How would you like to start?"}</text>
          <box height={1} />
          <select
            flexGrow={1}
            focused
            options={MODE_OPTIONS}
            onSelect={handleModeSelect}
            selectedBackgroundColor="#333333"
            selectedTextColor="#ffffff"
          />
        </box>
      </box>
    )
  }

  if (mode === "scope") {
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="New Program">
          <box height={1} />
          <text>{"  What area should I focus on?"}</text>
          <box height={1} />
          <box border borderStyle="rounded" height={3}>
            <input
              focused
              placeholder='e.g. "web app", "packages/ui", "API server"'
              onSubmit={handleScopeSubmit}
            />
          </box>
          <box height={1} />
          <text fg="#888888">{"  Press Enter to skip and analyze everything"}</text>
        </box>
      </box>
    )
  }

  return (
    <Chat
      cwd={cwd}
      systemPrompt={systemPrompt}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      maxTurns={SETUP_MAX_TURNS}
      model={modelConfig.model}
      effort={modelConfig.effort}
      initialMessage={initialMessage}
    />
  )
}
