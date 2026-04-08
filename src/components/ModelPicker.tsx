import { useCallback, useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { ModelSlot } from "../lib/config.ts"
import type { AgentProviderID } from "../lib/agent/index.ts"
import { loadModelPickerOptions, type ModelPickerOption } from "../lib/model-options.ts"
import { formatShellError } from "../lib/git.ts"

interface SelectOption {
  name: string
  description: string
  value?: ModelSlot
}

interface ModelPickerProps {
  cwd: string
  title: string
  providerId: AgentProviderID
  onSelect: (slot: ModelSlot) => void
  onCancel: () => void
}

export function ModelPicker({ cwd, title, providerId, onSelect, onCancel }: ModelPickerProps) {
  const [options, setOptions] = useState<SelectOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const models = await loadModelPickerOptions(providerId, cwd, forceRefresh)
      if (models.length === 0) {
        setOptions([{
          name: "No models available",
          description: providerId === "opencode" ? "Run opencode auth login or /connect" : "No models found",
        }])
      } else {
        setOptions(models.map(toSelectOption))
      }
    } catch (err) {
      const message = formatShellError(err)
      setError(message)
      setOptions([{ name: "Unavailable", description: message }])
    } finally {
      setLoading(false)
    }
  }, [cwd, providerId])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel()
      return
    }
    if (key.name === "r" && providerId === "opencode") {
      load(true).catch(() => {})
    }
  })

  const hint = providerId === "opencode"
    ? "  Enter: select | r: refresh | Escape: cancel"
    : "  Enter: select | Escape: cancel"

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={title}>
      <box height={1} />
      <text fg="#888888">{hint}</text>
      <box height={1} />
      {error && <text fg="#ff5555">{`  Error: ${error}`}</text>}
      {loading && <text fg="#888888">{"  Loading models..."}</text>}
      <select
        flexGrow={1}
        focused
        options={options}
        selectedBackgroundColor="#333333"
        selectedTextColor="#ffffff"
        onSelect={(_index: number, option: SelectOption | null) => {
          if (!option?.value) return
          onSelect(option.value)
        }}
      />
    </box>
  )
}

function toSelectOption(option: ModelPickerOption): SelectOption {
  // Strip provider prefix from labels (e.g. "Claude / Sonnet" → "Sonnet")
  const label = option.label.replace(/^(?:Claude|Codex|OpenCode)\s*\/\s*/, "")
  return {
    name: label,
    description: option.description ?? "",
    value: option.value,
  }
}
