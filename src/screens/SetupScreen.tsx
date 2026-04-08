import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { useKeyboard } from "@opentui/react"
import type { TextareaOptions } from "@opentui/core"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts/index.ts"
import { getUpdateSystemPrompt } from "../lib/system-prompts/update.ts"
import { loadProgramSummaries, getProgramDir, type Screen, type ProgramSummary } from "../lib/programs.ts"
import { buildUpdateRunContext } from "../lib/run-context.ts"
import { formatModelLabel, type ModelSlot } from "../lib/config.ts"
import { formatShellError } from "../lib/git.ts"
import { saveDraft, loadDraft, deleteDraft, draftFileName, type DraftSession, type DraftMessage } from "../lib/drafts.ts"

type OpenTUISubmitEvent = Parameters<NonNullable<TextareaOptions["onSubmit"]>>[0]

const SETUP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]

type SetupMode = "choose" | "scope" | "chat"

const MODE_OPTIONS = [
  {
    name: "Analyze my codebase",
    description: "Scan your project and suggest what to optimize",
    value: "analyze",
  },
  {
    name: "I know what I want to optimize",
    description: "Describe your target and start setting up",
    value: "direct",
  },
]

interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  modelConfig: ModelSlot
  /** When set, enters update mode for an existing program */
  programSlug?: string
  /** When set, resume an existing draft session */
  draftName?: string
  /** Called after a draft is saved to disk */
  onDraftSaved?: (name: string) => void
}

export function SetupScreen({ cwd, navigate, modelConfig, programSlug, draftName, onDraftSaved }: SetupScreenProps) {
  const isUpdate = Boolean(programSlug)
  const [existingPrograms, setExistingPrograms] = useState<ProgramSummary[]>([])

  useEffect(() => {
    if (!isUpdate) {
      loadProgramSummaries(cwd).then(setExistingPrograms).catch(() => {})
    }
  }, [cwd, isUpdate])

  // Setup mode: system prompt from setup.ts
  const setupResult = useMemo(
    () => isUpdate ? null : getSetupSystemPrompt(cwd, existingPrograms),
    [cwd, existingPrograms, isUpdate],
  )
  const [setupReady, setSetupReady] = useState(false)

  useEffect(() => {
    if (!setupResult) return
    setSetupReady(false)
    mkdir(dirname(setupResult.referencePath), { recursive: true })
      .then(() => Bun.write(setupResult.referencePath, setupResult.referenceContent))
      .then(() => setSetupReady(true))
      .catch(() => setSetupReady(true)) // proceed anyway — agent can still work without reference
  }, [setupResult])

  const [updateSystemPrompt, setUpdateSystemPrompt] = useState<string | null>(null)
  const [updateInitialMessage, setUpdateInitialMessage] = useState<string | null>(null)
  const [updateLoadError, setUpdateLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!programSlug) return
    const programDir = getProgramDir(cwd, programSlug)

    Promise.all([
      getUpdateSystemPrompt(cwd, programSlug, programDir).then(async (result) => {
        await mkdir(dirname(result.referencePath), { recursive: true })
        await Bun.write(result.referencePath, result.referenceContent)
        return result.systemPrompt
      }),
      buildUpdateRunContext(programDir),
    ]).then(([prompt, context]) => {
      setUpdateSystemPrompt(prompt)
      setUpdateInitialMessage(context)
    }).catch((err: unknown) => {
      setUpdateLoadError(formatShellError(err))
    })
  }, [cwd, programSlug])

  // --- Draft resume state ---
  const [mode, setMode] = useState<SetupMode>(isUpdate ? "chat" : "choose")
  const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined)
  const [resumeMessages, setResumeMessages] = useState<DraftMessage[] | undefined>(undefined)
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined)
  const [draftLoaded, setDraftLoaded] = useState(!draftName) // true immediately if no draft to load

  // Mutable refs for draft saving (avoids re-renders)
  const messagesRef = useRef<DraftMessage[]>([])
  const sdkSessionIdRef = useRef<string | null>(null)
  const currentDraftNameRef = useRef<string | null>(draftName ?? null)

  // Load draft on mount
  useEffect(() => {
    if (!draftName) return
    loadDraft(cwd, draftName).then((draft) => {
      if (draft) {
        setMode(draft.mode)
        if (draft.initialMessage) setInitialMessage(draft.initialMessage)
        if (draft.messages.length > 0) {
          setResumeMessages(draft.messages)
          messagesRef.current = draft.messages
        }
        if (draft.sdkSessionId) {
          setResumeSessionId(draft.sdkSessionId)
          sdkSessionIdRef.current = draft.sdkSessionId
        }
      }
      setDraftLoaded(true)
    }).catch(() => setDraftLoaded(true))
  }, [cwd, draftName])

  const [saving, setSaving] = useState(false)

  const persistAndNavigate = useCallback(async () => {
    if (mode === "choose" || (mode === "scope" && messagesRef.current.length === 0)) {
      navigate("home")
      return
    }

    setSaving(true)

    // If a new program was created during this session, skip saving the draft
    if (!isUpdate) {
      try {
        const currentPrograms = await loadProgramSummaries(cwd)
        const existingSlugs = new Set(existingPrograms.map((p) => p.slug))
        const newProgram = currentPrograms.some((p) => !existingSlugs.has(p.slug))
        if (newProgram) {
          // Clean up the draft if we were resuming one
          if (currentDraftNameRef.current) {
            await deleteDraft(cwd, currentDraftNameRef.current).catch(() => {})
          }
          navigate("home")
          return
        }
      } catch {
        // Fall through to save draft on error
      }
    }

    const name = currentDraftNameRef.current ?? draftFileName({
      type: isUpdate ? "update" : "setup",
      programSlug: programSlug ?? null,
    })
    currentDraftNameRef.current = name

    const draft: DraftSession = {
      type: isUpdate ? "update" : "setup",
      programSlug: programSlug ?? null,
      createdAt: new Date().toISOString(),
      provider: modelConfig.provider,
      model: modelConfig.model,
      effort: modelConfig.effort,
      sdkSessionId: sdkSessionIdRef.current,
      mode,
      initialMessage: initialMessage ?? null,
      messages: messagesRef.current,
    }

    saveDraft(cwd, name, draft)
      .then(() => onDraftSaved?.(name))
      .catch(() => {})
      .finally(() => navigate("home"))
  }, [cwd, isUpdate, programSlug, existingPrograms, modelConfig, mode, initialMessage, onDraftSaved, navigate])

  useKeyboard((key) => {
    if (saving) return
    if (key.name === "escape") {
      if (mode === "scope") {
        setMode("choose")
      } else if (mode === "chat" && messagesRef.current.length > 0) {
        persistAndNavigate()
      } else {
        navigate("home")
      }
    }
  })

  const handleSessionId = useCallback((id: string) => {
    sdkSessionIdRef.current = id
  }, [])

  const handleMessagesChange = useCallback((msgs: Array<{ role: "user" | "assistant"; content: string }>) => {
    messagesRef.current = msgs
  }, [])

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

  if (!draftLoaded) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Resuming...">
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg="#888888">Loading session...</text>
          </box>
        </box>
      </box>
    )
  }

  if (isUpdate && updateLoadError) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`Update: ${programSlug}`}>
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg="#ff5555">Failed to load program: {updateLoadError}</text>
          </box>
        </box>
      </box>
    )
  }

  if (isUpdate && (!updateSystemPrompt || !updateInitialMessage)) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`Update: ${programSlug}`}>
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg="#888888">Loading program context...</text>
          </box>
        </box>
      </box>
    )
  }

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

  // Wait for reference file to be written before rendering Chat
  if (!isUpdate && !setupReady) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="New Program">
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg="#888888">Preparing...</text>
          </box>
        </box>
      </box>
    )
  }

  const modelLabel = formatModelLabel(modelConfig)
  const isResuming = (resumeMessages?.length ?? 0) > 0

  return (
    <Chat
      cwd={cwd}
      systemPrompt={isUpdate ? updateSystemPrompt! : setupResult!.systemPrompt}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      provider={modelConfig.provider}
      model={modelConfig.model}
      effort={modelConfig.effort}
      initialMessage={isUpdate ? updateInitialMessage! : initialMessage}
      emptyStateHint={isUpdate
        ? "Describe what you'd like to change about this program."
        : (!initialMessage ? 'Describe what you want to optimize — e.g. "reduce bundle size", "improve API latency", "increase test coverage".' : undefined)}
      inputPlaceholder={isUpdate
        ? 'e.g. "fix the measurement script" or "widen the scope"'
        : (!initialMessage ? 'e.g. "I want to reduce the homepage load time"' : undefined)}
      title={`${isUpdate ? "Update" : "Setup"}${isResuming ? " (resumed)" : ""} · ${modelLabel}`}
      resumeMessages={resumeMessages}
      resumeSessionId={resumeSessionId}
      onSessionId={handleSessionId}
      onMessagesChange={handleMessagesChange}
    />
  )
}
