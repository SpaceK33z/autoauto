import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import {
  type ProjectConfig,
  MODEL_CHOICES,
  EFFORT_CHOICES,
  MODEL_LABELS,
  EFFORT_LABELS,
  EFFORT_DESCRIPTIONS,
  cycleChoice,
  saveProjectConfig,
} from "../lib/config.ts"
import { CycleField } from "../components/CycleField.tsx"

interface SettingsScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  config: ProjectConfig
  onConfigChange: (config: ProjectConfig) => void
}

export function SettingsScreen({ cwd, navigate, config, onConfigChange }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0)

  const updateConfig = (updater: (prev: ProjectConfig) => ProjectConfig) => {
    const next = updater(config)
    onConfigChange(next)
    saveProjectConfig(cwd, next)
  }

  function cycleValue(direction: -1 | 1) {
    updateConfig((prev) => {
      if (selected === 4) {
        return { ...prev, ideasBacklogEnabled: !prev.ideasBacklogEnabled }
      }

      const slotKey = selected < 2 ? "executionModel" : "supportModel"
      const propKey = selected % 2 === 0 ? "model" : "effort"
      const slot = { ...prev[slotKey] }

      if (propKey === "model") {
        slot.model = cycleChoice(MODEL_CHOICES, slot.model as (typeof MODEL_CHOICES)[number], direction)
        const validEfforts = EFFORT_CHOICES[slot.model] ?? EFFORT_CHOICES.sonnet
        if (!validEfforts.includes(slot.effort)) {
          slot.effort = "high"
        }
      } else {
        const validEfforts = EFFORT_CHOICES[slot.model] ?? EFFORT_CHOICES.sonnet
        slot.effort = cycleChoice(validEfforts, slot.effort, direction)
      }

      return { ...prev, [slotKey]: slot }
    })
  }

  useKeyboard((key) => {
    if (key.name === "escape") navigate("home")
    if (key.name === "up" || key.name === "k")
      setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down" || key.name === "j")
      setSelected((s) => Math.min(4, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
  })

  const execSlot = config.executionModel
  const supportSlot = config.supportModel

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
        value={MODEL_LABELS[execSlot.model] ?? execSlot.model}
        isFocused={selected === 0}
      />
      <CycleField
        label="Effort"
        value={EFFORT_LABELS[execSlot.effort]}
        description={EFFORT_DESCRIPTIONS[execSlot.effort]}
        isFocused={selected === 1}
      />
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Support Model "}</strong></text>
        <text fg="#888888">{"(setup & finalize)"}</text>
      </box>
      <CycleField
        label="Model"
        value={MODEL_LABELS[supportSlot.model] ?? supportSlot.model}
        isFocused={selected === 2}
      />
      <CycleField
        label="Effort"
        value={EFFORT_LABELS[supportSlot.effort]}
        description={EFFORT_DESCRIPTIONS[supportSlot.effort]}
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
