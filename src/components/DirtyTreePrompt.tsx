import { useState, useCallback, useRef, useMemo, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import type { ModelSlot } from "../lib/config.ts"
import { formatShellError, getCurrentBranch } from "../lib/git.ts"
import { getProvider } from "../lib/agent/index.ts"
import { formatToolEvent } from "../lib/tool-events.ts"
import { truncateStreamText } from "../lib/format.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { colors } from "../lib/theme.ts"

interface DirtyTreePromptProps {
  cwd: string
  dirtyFiles: string
  modelConfig: ModelSlot
  onRetry: () => void
  onQuit: () => void
}

export function DirtyTreePrompt({
  cwd,
  dirtyFiles,
  modelConfig,
  onRetry,
  onQuit,
}: DirtyTreePromptProps) {
  const [selected, setSelected] = useState(0)
  const [commitStreamText, setCommitStreamText] = useState("")
  const [commitToolStatus, setCommitToolStatus] = useState<string | null>(null)
  const [isCommitting, setIsCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    getCurrentBranch(cwd).then(setBranch).catch(() => {})
  }, [cwd])

  const handleCommit = useCallback(async () => {
    setIsCommitting(true)
    setCommitStreamText("")
    setCommitToolStatus(null)
    setCommitError(null)

    const abort = new AbortController()
    abortRef.current = abort

    try {
      const prompt = `The working directory has uncommitted changes:\n\n${dirtyFiles}\n\nAnalyze these changes and create an appropriate git commit. Use conventional commit format. Stage all changes with git add and then commit them.`

      const session = getProvider(modelConfig.provider).runOnce(prompt, {
        systemPrompt: "You are a git assistant. Your only job is to commit the current uncommitted changes. Run git add to stage files, then git commit with a clear conventional commit message. Do not modify any files. Only use git commands.",
        tools: ["Bash"],
        allowedTools: ["Bash"],
        maxTurns: 10,
        cwd,
        model: modelConfig.model,
        effort: modelConfig.effort,
        signal: abort.signal,
      })

      for await (const event of session) {
        if (abort.signal.aborted) break
        switch (event.type) {
          case "text_delta":
            setCommitStreamText(prev => truncateStreamText(prev, event.text))
            break
          case "tool_use":
            setCommitToolStatus(formatToolEvent(event.tool, event.input ?? {}))
            break
          case "error":
            setCommitError(event.error)
            setIsCommitting(false)
            return
          case "result":
            if (!event.success) {
              setCommitError(event.error ?? "Commit agent failed")
              setIsCommitting(false)
              return
            }
            break
        }
      }

      if (!abort.signal.aborted) {
        setIsCommitting(false)
        onRetry()
      }
    } catch (err: unknown) {
      if (!abort.signal.aborted) {
        setCommitError(formatShellError(err))
        setIsCommitting(false)
      }
    }
  }, [cwd, dirtyFiles, modelConfig, onRetry])

  const handleQuit = useCallback(() => {
    abortRef.current?.abort()
    onQuit()
  }, [onQuit])

  useKeyboard((key) => {
    if (isCommitting) {
      if (key.ctrl && key.name === "c") {
        abortRef.current?.abort()
        setIsCommitting(false)
      }
      return
    }

    if (key.name === "up" || key.name === "k") {
      setSelected(s => Math.max(0, s - 1))
    } else if (key.name === "down" || key.name === "j") {
      setSelected(s => Math.min(2, s + 1))
    } else if (key.name === "return") {
      if (selected === 0) handleCommit()
      else if (selected === 1) onRetry()
      else handleQuit()
    } else if (key.name === "c") {
      handleCommit()
    } else if (key.name === "r") {
      onRetry()
    } else if (key.name === "escape" || key.name === "q") {
      handleQuit()
    }
  })

  const fileLines = useMemo(() => dirtyFiles.split("\n").filter(Boolean), [dirtyFiles])

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Uncommitted Changes">
      <box flexDirection="column" padding={1}>
        <text fg={colors.warning}><strong>Working tree has uncommitted changes</strong></text>
        <box height={1} />
        <text fg={colors.textMuted}>Working directory: {cwd}{branch ? ` (${branch})` : ""}</text>
        <box height={1} />
        <text fg={colors.text}><strong>Changed files:</strong></text>
        {fileLines.map((line, i) => (
          <text key={i} fg={colors.orange} selectable>{"  "}{line}</text>
        ))}
      </box>

      {commitError && (
        <box padding={1}>
          <text fg={colors.error}>{commitError}</text>
        </box>
      )}

      {isCommitting ? (
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
          <box paddingX={1} flexDirection="column">
            {commitToolStatus && (
              <text fg={colors.textDim} selectable>{commitToolStatus}</text>
            )}
            {commitStreamText ? (
              <markdown content={commitStreamText} syntaxStyle={syntaxStyle} streaming />
            ) : (
              <text fg={colors.primary}>Agent analyzing changes...</text>
            )}
          </box>
        </scrollbox>
      ) : (
        <box flexDirection="column" padding={1}>
          <box height={1} />
          <text><strong>What would you like to do?</strong></text>
          <box height={1} />
          <text fg={selected === 0 ? colors.text : colors.textMuted}>
            {selected === 0 ? " > " : "   "}
            Commit (let agent analyze & commit changes)
          </text>
          <text fg={selected === 1 ? colors.text : colors.textMuted}>
            {selected === 1 ? " > " : "   "}
            Retry (re-check and try again)
          </text>
          <text fg={selected === 2 ? colors.text : colors.textMuted}>
            {selected === 2 ? " > " : "   "}
            Quit (go back to home)
          </text>
          <box height={1} />
          <text fg={colors.textMuted}>j/k move · Enter select · c commit · r retry · q/Esc quit</text>
        </box>
      )}
    </box>
  )
}
