import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import type { ModelSlot, ProjectConfig } from "../lib/config.ts"
import {
  DEFAULT_CONFIG,
  cycleChoice,
  formatEffortSlot,
  formatModelSlot,
  getEffortChoicesForSlot,
  isEffortConfigurable,
  mergeSelectedModelSlot,
  saveProjectConfig,
  PROVIDER_CHOICES,
  PROVIDER_LABELS,
} from "../lib/config.ts"
import { checkAuth } from "../lib/auth.ts"
import { formatShellError } from "../lib/git.ts"
import { CycleField } from "../components/CycleField.tsx"
import { ModelPicker } from "../components/ModelPicker.tsx"

interface FirstSetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  onConfigChange: (config: ProjectConfig) => void
}

export function FirstSetupScreen({ cwd, navigate, onConfigChange }: FirstSetupScreenProps) {
  const [slot, setSlot] = useState<ModelSlot>({ ...DEFAULT_CONFIG.executionModel })
  const [selected, setSelected] = useState(0)
  const [picking, setPicking] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const showEffort = isEffortConfigurable(slot)
  const continueRow = showEffort ? 3 : 2
  const rowCount = continueRow + 1

  async function handleContinue() {
    setChecking(true)
    setError(null)
    try {
      const result = await checkAuth(slot.provider)
      if (!result.authenticated) {
        setError(result.error)
        setChecking(false)
        return
      }
      const config: ProjectConfig = {
        executionModel: { ...slot },
        supportModel: { ...slot },
        ideasBacklogEnabled: true,
      }
      await saveProjectConfig(cwd, config)
      onConfigChange(config)
      navigate("setup")
    } catch (err) {
      setError(formatShellError(err))
      setChecking(false)
    }
  }

  function cycleProvider(direction: -1 | 1) {
    const nextProvider = cycleChoice(PROVIDER_CHOICES, slot.provider, direction)
    const defaultModel = nextProvider === "claude" ? "sonnet" : "default"
    setSlot({ provider: nextProvider, model: defaultModel, effort: "high" })
    setError(null)
  }

  function cycleEffort(direction: -1 | 1) {
    if (!isEffortConfigurable(slot)) return
    const choices = getEffortChoicesForSlot(slot)
    setSlot((prev) => ({ ...prev, effort: cycleChoice(choices, prev.effort, direction) }))
  }

  function cycleValue(direction: -1 | 1) {
    if (selected === 0) return cycleProvider(direction)
    if (selected === 1) {
      setPicking(true)
      return
    }
    if (showEffort && selected === 2) return cycleEffort(direction)
    // continue row — no cycling
  }

  useKeyboard((key) => {
    if (picking || checking) return
    if (key.name === "up" || key.name === "k")
      setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down" || key.name === "j")
      setSelected((s) => Math.min(rowCount - 1, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
    if (key.name === "return") {
      if (selected === 1) {
        setPicking(true)
      } else if (selected === continueRow) {
        handleContinue()
      }
    }
  })

  if (picking) {
    return (
      <ModelPicker
        cwd={cwd}
        title={`Model — ${PROVIDER_LABELS[slot.provider]}`}
        providerId={slot.provider}
        onCancel={() => setPicking(false)}
        onSelect={(newSlot) => {
          setSlot(mergeSelectedModelSlot(slot, newSlot))
          setPicking(false)
        }}
      />
    )
  }

  const effortInfo = formatEffortSlot(slot)
  const isContinueFocused = selected === continueRow

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="First-Time Setup">
      <box height={1} />
      <text>{"  Welcome! Pick a provider and model to get started."}</text>
      <text fg="#888888">{"  You can change these later in Settings."}</text>
      <box height={1} />
      <CycleField
        label="Provider"
        value={PROVIDER_LABELS[slot.provider]}
        isFocused={selected === 0}
      />
      <CycleField
        label="Model"
        value={formatModelSlot(slot)}
        isFocused={selected === 1}
      />
      {showEffort && (
        <CycleField
          label="Effort"
          value={effortInfo.label}
          description={effortInfo.description}
          isFocused={selected === 2}
        />
      )}
      <box height={1} />
      <text>
        {isContinueFocused ? (
          <span fg="#7aa2f7"><strong>{"  [ Continue ]"}</strong></span>
        ) : (
          <span fg="#888888">{"  [ Continue ]"}</span>
        )}
      </text>
      {checking && (
        <>
          <box height={1} />
          <text fg="#888888">{"  Checking authentication..."}</text>
        </>
      )}
      {error && (
        <>
          <box height={1} />
          <text fg="#ff5555">{`  Auth failed: ${error}`}</text>
          <text fg="#888888">{"  Change provider or fix credentials, then try again."}</text>
        </>
      )}
    </box>
  )
}
