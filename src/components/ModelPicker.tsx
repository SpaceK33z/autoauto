import { useCallback, useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { ModelSlot } from "../lib/config.ts"
import type { AgentProviderID } from "../lib/agent/index.ts"
import { loadModelPickerOptions, type ModelPickerOption } from "../lib/model-options.ts"

interface SelectOption {
  name: string
  description: string
  value?: ModelSlot
}

interface ProviderOption {
  name: string
  description: string
  id: AgentProviderID
}

const PROVIDERS: ProviderOption[] = [
  { id: "claude", name: "Claude", description: "Claude Agent SDK (Sonnet, Opus)" },
  { id: "codex", name: "Codex", description: "Codex CLI" },
  { id: "opencode", name: "OpenCode", description: "OpenCode connected models" },
]

interface ModelPickerProps {
  cwd: string
  title: string
  onSelect: (slot: ModelSlot) => void
  onCancel: () => void
}

export function ModelPicker({ cwd, title, onSelect, onCancel }: ModelPickerProps) {
  const [selectedProvider, setSelectedProvider] = useState<AgentProviderID | null>(null)
  const [options, setOptions] = useState<SelectOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadModels = useCallback(async (providerId: AgentProviderID, forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const models = await loadModelPickerOptions(providerId, cwd, forceRefresh)
      if (models.length === 0) {
        setOptions([{ name: "No models available", description: providerId === "opencode" ? "Run opencode auth login or /connect" : "No models found" }])
      } else {
        setOptions(models.map(toSelectOption))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setOptions([{ name: "Unavailable", description: message }])
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    if (selectedProvider) {
      loadModels(selectedProvider).catch(() => {})
    }
  }, [selectedProvider, loadModels])

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (selectedProvider) {
        setSelectedProvider(null)
        setOptions([])
        setError(null)
      } else {
        onCancel()
      }
      return
    }
    if (key.name === "r" && selectedProvider === "opencode") {
      loadModels("opencode", true).catch(() => {})
    }
  })

  if (!selectedProvider) {
    return (
      <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={title}>
        <box height={1} />
        <text fg="#888888">{"  Select a provider — Enter: select | Escape: cancel"}</text>
        <box height={1} />
        <select
          flexGrow={1}
          focused
          options={PROVIDERS.map((p) => ({ name: p.name, description: p.description }))}
          selectedBackgroundColor="#333333"
          selectedTextColor="#ffffff"
          onSelect={(index: number) => {
            setSelectedProvider(PROVIDERS[index].id)
          }}
        />
      </box>
    )
  }

  const providerLabel = PROVIDERS.find((p) => p.id === selectedProvider)!.name
  const hint = selectedProvider === "opencode"
    ? "  Enter: select | r: refresh | Escape: back"
    : "  Enter: select | Escape: back"

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`${title} — ${providerLabel}`}>
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
  // Strip the provider prefix from labels (e.g. "Claude / Sonnet" → "Sonnet")
  const label = option.label.replace(/^(?:Claude|Codex|OpenCode)\s*\/\s*/, "")
  return {
    name: label,
    description: option.description ?? "",
    value: option.value,
  }
}
