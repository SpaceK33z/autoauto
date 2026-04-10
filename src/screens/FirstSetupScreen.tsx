import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import type { ModelSlot, ProjectConfig } from "../lib/config.ts"
import {
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

// Row layout:
// 0: conversational provider  1: conversational model  2: conversational effort
// 3: experiment provider      4: experiment model      5: experiment effort
// 6: continue
const CONTINUE_ROW = 6
const ROW_COUNT = 7

export function FirstSetupScreen({ cwd, navigate, onConfigChange }: FirstSetupScreenProps) {
  const [supportSlot, setSupportSlot] = useState<ModelSlot>({ provider: "claude", model: "opus", effort: "high" })
  const [executionSlot, setExecutionSlot] = useState<ModelSlot>({ provider: "claude", model: "sonnet", effort: "high" })
  const [selected, setSelected] = useState(0)
  const [pickingSlot, setPickingSlot] = useState<"support" | "execution" | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleContinue() {
    setChecking(true)
    setError(null)
    try {
      const providers = new Set([supportSlot.provider, executionSlot.provider])
      for (const provider of providers) {
        const result = await checkAuth(provider)
        if (!result.authenticated) {
          setError(`${PROVIDER_LABELS[provider]}: ${result.error}`)
          setChecking(false)
          return
        }
      }
      const config: ProjectConfig = {
        executionModel: { ...executionSlot },
        supportModel: { ...supportSlot },
        ideasBacklogEnabled: true,
        notificationPreset: "off",
        notificationCommand: null,
      }
      await saveProjectConfig(cwd, config)
      onConfigChange(config)
      navigate("setup")
    } catch (err) {
      setError(formatShellError(err))
      setChecking(false)
    }
  }

  function cycleProvider(which: "support" | "execution", direction: -1 | 1) {
    const setter = which === "support" ? setSupportSlot : setExecutionSlot
    const defaultClaude = which === "support" ? "opus" : "sonnet"
    setter((prev) => {
      const nextProvider = cycleChoice(PROVIDER_CHOICES, prev.provider, direction)
      const defaultModel = nextProvider === "claude" ? defaultClaude : "default"
      return { provider: nextProvider, model: defaultModel, effort: "high" }
    })
    setError(null)
  }

  function cycleEffort(which: "support" | "execution", direction: -1 | 1) {
    const setter = which === "support" ? setSupportSlot : setExecutionSlot
    setter((prev) => {
      if (!isEffortConfigurable(prev)) return prev
      const choices = getEffortChoicesForSlot(prev)
      return { ...prev, effort: cycleChoice(choices, prev.effort, direction) }
    })
  }

  function cycleValue(direction: -1 | 1) {
    if (selected === 0) return cycleProvider("support", direction)
    if (selected === 1) { setPickingSlot("support"); return }
    if (selected === 2) return cycleEffort("support", direction)
    if (selected === 3) return cycleProvider("execution", direction)
    if (selected === 4) { setPickingSlot("execution"); return }
    if (selected === 5) return cycleEffort("execution", direction)
  }

  useKeyboard((key) => {
    if (pickingSlot || checking) return
    if (key.name === "up" || key.name === "k")
      setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down" || key.name === "j")
      setSelected((s) => Math.min(ROW_COUNT - 1, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
    if (key.name === "return") {
      if (selected === 1 || selected === 4) {
        setPickingSlot(selected === 1 ? "support" : "execution")
      } else if (selected === CONTINUE_ROW) {
        handleContinue()
      }
    }
  })

  if (pickingSlot) {
    const slot = pickingSlot === "support" ? supportSlot : executionSlot
    const title = pickingSlot === "support" ? "Conversational Agent" : "Experiment Agent"
    const setter = pickingSlot === "support" ? setSupportSlot : setExecutionSlot
    return (
      <ModelPicker
        cwd={cwd}
        title={`${title} — ${PROVIDER_LABELS[slot.provider]}`}
        providerId={slot.provider}
        onCancel={() => setPickingSlot(null)}
        onSelect={(newSlot) => {
          setter((prev) => mergeSelectedModelSlot(prev, newSlot))
          setPickingSlot(null)
        }}
      />
    )
  }

  const supportEffort = formatEffortSlot(supportSlot)
  const execEffort = formatEffortSlot(executionSlot)
  const isContinueFocused = selected === CONTINUE_ROW

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="First-Time Setup">
      <box height={1} />
      <text>{"  Welcome! Pick models for your agents."}</text>
      <text fg="#888888">{"  You can change these later in Settings."}</text>
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Conversational Agent "}</strong></text>
        <text fg="#888888">{"— designs experiments & writes scripts (pick a smart model)"}</text>
      </box>
      <CycleField
        label="Provider"
        value={PROVIDER_LABELS[supportSlot.provider]}
        isFocused={selected === 0}
      />
      <CycleField
        label="Model"
        value={formatModelSlot(supportSlot)}
        isFocused={selected === 1}
      />
      <CycleField
        label="Effort"
        value={supportEffort.label}
        description={supportEffort.description}
        isFocused={selected === 2}
      />
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Experiment Agent "}</strong></text>
        <text fg="#888888">{"— makes focused code changes (cheaper models work fine)"}</text>
      </box>
      <CycleField
        label="Provider"
        value={PROVIDER_LABELS[executionSlot.provider]}
        isFocused={selected === 3}
      />
      <CycleField
        label="Model"
        value={formatModelSlot(executionSlot)}
        isFocused={selected === 4}
      />
      <CycleField
        label="Effort"
        value={execEffort.label}
        description={execEffort.description}
        isFocused={selected === 5}
      />
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
