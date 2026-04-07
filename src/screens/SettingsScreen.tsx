import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import {
  type ProjectConfig,
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
import { CycleField } from "../components/CycleField.tsx"
import { ModelPicker } from "../components/ModelPicker.tsx"

interface SettingsScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  config: ProjectConfig
  onConfigChange: (config: ProjectConfig) => void
}

// Row layout:
// 0: exec provider   1: exec model   2: exec effort
// 3: support provider 4: support model 5: support effort
// 6: ideas backlog
const ROW_COUNT = 7

function slotKeyForRow(row: number): "executionModel" | "supportModel" {
  return row < 3 ? "executionModel" : "supportModel"
}

export function SettingsScreen({ cwd, navigate, config, onConfigChange }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0)
  const [pickingSlot, setPickingSlot] = useState<"executionModel" | "supportModel" | null>(null)

  const updateConfig = (updater: (prev: ProjectConfig) => ProjectConfig) => {
    const next = updater(config)
    onConfigChange(next)
    saveProjectConfig(cwd, next)
  }

  function cycleProvider(slotKey: "executionModel" | "supportModel", direction: -1 | 1) {
    updateConfig((prev) => {
      const slot = prev[slotKey]
      const nextProvider = cycleChoice(PROVIDER_CHOICES, slot.provider, direction)
      // Reset model to a sensible default when switching provider
      const defaultModel = nextProvider === "claude" ? "sonnet" : "default"
      const effort = nextProvider === "opencode" ? slot.effort : slot.effort
      return { ...prev, [slotKey]: { provider: nextProvider, model: defaultModel, effort } }
    })
  }

  function cycleValue(direction: -1 | 1) {
    // Provider rows
    if (selected === 0) return cycleProvider("executionModel", direction)
    if (selected === 3) return cycleProvider("supportModel", direction)

    // Model rows — open picker
    if (selected === 1 || selected === 4) {
      setPickingSlot(selected === 1 ? "executionModel" : "supportModel")
      return
    }

    // Ideas backlog
    if (selected === 6) {
      updateConfig((prev) => ({ ...prev, ideasBacklogEnabled: !prev.ideasBacklogEnabled }))
      return
    }

    // Effort rows
    const slotKey = slotKeyForRow(selected)
    updateConfig((prev) => {
      const slot = { ...prev[slotKey] }
      if (!isEffortConfigurable(slot)) return prev
      const validEfforts = getEffortChoicesForSlot(slot)
      slot.effort = cycleChoice(validEfforts, slot.effort, direction)
      return { ...prev, [slotKey]: slot }
    })
  }

  useKeyboard((key) => {
    if (pickingSlot) return
    if (key.name === "escape") navigate("home")
    if (key.name === "up" || key.name === "k")
      setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down" || key.name === "j")
      setSelected((s) => Math.min(ROW_COUNT - 1, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
    if (key.name === "return" && (selected === 1 || selected === 4)) {
      setPickingSlot(selected === 1 ? "executionModel" : "supportModel")
    }
  })

  const execSlot = config.executionModel
  const supportSlot = config.supportModel
  const execEffort = formatEffortSlot(execSlot)
  const supportEffort = formatEffortSlot(supportSlot)

  if (pickingSlot) {
    const slot = config[pickingSlot]
    const title = pickingSlot === "executionModel" ? "Execution Model" : "Support Model"
    return (
      <ModelPicker
        cwd={cwd}
        title={`${title} — ${PROVIDER_LABELS[slot.provider]}`}
        providerId={slot.provider}
        onCancel={() => setPickingSlot(null)}
        onSelect={(newSlot) => {
          updateConfig((prev) => ({
            ...prev,
            [pickingSlot]: mergeSelectedModelSlot(prev[pickingSlot], newSlot),
          }))
          setPickingSlot(null)
        }}
      />
    )
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      title="Settings"
    >
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Execution Model "}</strong></text>
        <text fg="#888888">{"(experiment agents)"}</text>
      </box>
      <CycleField
        label="Provider"
        value={PROVIDER_LABELS[execSlot.provider]}
        isFocused={selected === 0}
      />
      <CycleField
        label="Model"
        value={formatModelSlot(execSlot)}
        isFocused={selected === 1}
      />
      <CycleField
        label="Effort"
        value={execEffort.label}
        description={execEffort.description}
        isFocused={selected === 2}
      />
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Support Model "}</strong></text>
        <text fg="#888888">{"(setup & finalize)"}</text>
      </box>
      <CycleField
        label="Provider"
        value={PROVIDER_LABELS[supportSlot.provider]}
        isFocused={selected === 3}
      />
      <CycleField
        label="Model"
        value={formatModelSlot(supportSlot)}
        isFocused={selected === 4}
      />
      <CycleField
        label="Effort"
        value={supportEffort.label}
        description={supportEffort.description}
        isFocused={selected === 5}
      />
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Experiment Memory "}</strong></text>
        <text fg="#888888">{"(ideas backlog)"}</text>
      </box>
      <CycleField
        label="Ideas Backlog"
        value={config.ideasBacklogEnabled ? "On" : "Off"}
        description={config.ideasBacklogEnabled
          ? "Capture why experiments worked or failed and what to try next"
          : "Use results.tsv-based experiment memory only"}
        isFocused={selected === 6}
      />
    </box>
  )
}
