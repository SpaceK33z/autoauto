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
} from "../lib/config.ts"
import { CycleField } from "../components/CycleField.tsx"
import { ModelPicker } from "../components/ModelPicker.tsx"

interface SettingsScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  config: ProjectConfig
  onConfigChange: (config: ProjectConfig) => void
}

export function SettingsScreen({ cwd, navigate, config, onConfigChange }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0)
  const [pickingSlot, setPickingSlot] = useState<"executionModel" | "supportModel" | null>(null)

  const updateConfig = (updater: (prev: ProjectConfig) => ProjectConfig) => {
    const next = updater(config)
    onConfigChange(next)
    saveProjectConfig(cwd, next)
  }

  function cycleValue(direction: -1 | 1) {
    if (selected === 0 || selected === 2) {
      setPickingSlot(selected === 0 ? "executionModel" : "supportModel")
      return
    }

    updateConfig((prev) => {
      if (selected === 4) {
        return { ...prev, ideasBacklogEnabled: !prev.ideasBacklogEnabled }
      }

      const slotKey = selected < 2 ? "executionModel" : "supportModel"
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
      setSelected((s) => Math.min(4, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
    if (key.name === "return" && (selected === 0 || selected === 2)) {
      setPickingSlot(selected === 0 ? "executionModel" : "supportModel")
    }
  })

  const execSlot = config.executionModel
  const supportSlot = config.supportModel
  const execEffort = formatEffortSlot(execSlot)
  const supportEffort = formatEffortSlot(supportSlot)

  if (pickingSlot) {
    const title = pickingSlot === "executionModel" ? "Execution Model" : "Support Model"
    return (
      <ModelPicker
        cwd={cwd}
        title={title}
        onCancel={() => setPickingSlot(null)}
        onSelect={(slot) => {
          updateConfig((prev) => ({
            ...prev,
            [pickingSlot]: mergeSelectedModelSlot(prev[pickingSlot], slot),
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
        label="Model"
        value={formatModelSlot(execSlot)}
        isFocused={selected === 0}
      />
      <CycleField
        label="Effort"
        value={execEffort.label}
        description={execEffort.description}
        isFocused={selected === 1}
      />
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Support Model "}</strong></text>
        <text fg="#888888">{"(setup & finalize)"}</text>
      </box>
      <CycleField
        label="Model"
        value={formatModelSlot(supportSlot)}
        isFocused={selected === 2}
      />
      <CycleField
        label="Effort"
        value={supportEffort.label}
        description={supportEffort.description}
        isFocused={selected === 3}
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
        isFocused={selected === 4}
      />
    </box>
  )
}
