import { useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import {
  type ProjectConfig,
  DEFAULT_CONFIG,
  MODEL_CHOICES,
  EFFORT_CHOICES,
  MODEL_LABELS,
  EFFORT_LABELS,
  EFFORT_DESCRIPTIONS,
  loadProjectConfig,
  saveProjectConfig,
} from "../lib/config.ts"

interface SettingsScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
}

export function SettingsScreen({ cwd, navigate }: SettingsScreenProps) {
  const [config, setConfig] = useState<ProjectConfig>(DEFAULT_CONFIG)
  const [selected, setSelected] = useState(0)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    loadProjectConfig(cwd).then(setConfig)
  }, [cwd])

  useEffect(() => {
    if (dirty) {
      saveProjectConfig(cwd, config)
      setDirty(false)
    }
  }, [config, dirty, cwd])

  const updateConfig = (updater: (prev: ProjectConfig) => ProjectConfig) => {
    setConfig(updater)
    setDirty(true)
  }

  function cycleValue(direction: -1 | 1) {
    updateConfig((prev) => {
      const slotKey = selected < 2 ? "executionModel" : "supportModel"
      const propKey = selected % 2 === 0 ? "model" : "effort"
      const slot = { ...prev[slotKey] }

      if (propKey === "model") {
        const idx = MODEL_CHOICES.indexOf(slot.model as (typeof MODEL_CHOICES)[number])
        const next =
          MODEL_CHOICES[
            (idx + direction + MODEL_CHOICES.length) % MODEL_CHOICES.length
          ]
        slot.model = next
        const validEfforts = EFFORT_CHOICES[next] ?? EFFORT_CHOICES.sonnet
        if (!validEfforts.includes(slot.effort)) {
          slot.effort = "high"
        }
      } else {
        const validEfforts =
          EFFORT_CHOICES[slot.model] ?? EFFORT_CHOICES.sonnet
        const idx = validEfforts.indexOf(slot.effort)
        slot.effort =
          validEfforts[
            (idx + direction + validEfforts.length) % validEfforts.length
          ]
      }

      return { ...prev, [slotKey]: slot }
    })
  }

  useKeyboard((key) => {
    if (key.name === "escape") navigate("home")
    if (key.name === "up" || key.name === "k")
      setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down" || key.name === "j")
      setSelected((s) => Math.min(3, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
  })

  function renderField(
    index: number,
    label: string,
    value: string,
    description?: string,
  ) {
    const isFocused = selected === index
    return (
      <box flexDirection="column">
        <text>
          {isFocused ? (
            <strong fg="#7aa2f7">{`  ${label}: \u25C2 ${value} \u25B8`}</strong>
          ) : (
            `  ${label}: ${value}`
          )}
        </text>
        {isFocused && description && (
          <text fg="#888888">{`  ${description}`}</text>
        )}
      </box>
    )
  }

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
      <text>{""}</text>
      <box flexDirection="row">
        <text><strong>{"  Execution Model "}</strong></text>
        <text fg="#888888">{"(experiment agents)"}</text>
      </box>
      {renderField(
        0,
        "Model",
        MODEL_LABELS[execSlot.model] ?? execSlot.model,
      )}
      {renderField(
        1,
        "Effort",
        EFFORT_LABELS[execSlot.effort],
        EFFORT_DESCRIPTIONS[execSlot.effort],
      )}
      <text>{""}</text>
      <box flexDirection="row">
        <text><strong>{"  Support Model "}</strong></text>
        <text fg="#888888">{"(setup & cleanup)"}</text>
      </box>
      {renderField(
        2,
        "Model",
        MODEL_LABELS[supportSlot.model] ?? supportSlot.model,
      )}
      {renderField(
        3,
        "Effort",
        EFFORT_LABELS[supportSlot.effort],
        EFFORT_DESCRIPTIONS[supportSlot.effort],
      )}
    </box>
  )
}
