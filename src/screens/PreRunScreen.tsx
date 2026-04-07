import { useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import {
  type Screen,
  type ProgramConfig,
  getProgramDir,
  loadProgramConfig,
} from "../lib/programs.ts"
import { getLatestRun, readAllResults, getAvgMeasurementDuration } from "../lib/run.ts"
import {
  type ModelSlot,
  cycleChoice,
  formatEffortSlot,
  formatModelSlot,
  getEffortChoicesForSlot,
  isEffortConfigurable,
  mergeSelectedModelSlot,
} from "../lib/config.ts"
import { CycleField } from "../components/CycleField.tsx"
import { ModelPicker } from "../components/ModelPicker.tsx"

export interface PreRunOverrides {
  modelConfig: ModelSlot
  maxExperiments: number | undefined
  useWorktree: boolean
}

interface PreRunScreenProps {
  cwd: string
  programSlug: string
  defaultModelConfig: ModelSlot
  navigate: (screen: Screen) => void
  onStart: (overrides: PreRunOverrides) => void
}

const FIELD_COUNT = 4 // 0=maxExperiments, 1=model, 2=effort, 3=runMode

export function PreRunScreen({ cwd, programSlug, defaultModelConfig, navigate, onStart }: PreRunScreenProps) {
  const [selected, setSelected] = useState(0)
  const [maxExpText, setMaxExpText] = useState("")
  const [modelSlot, setModelSlot] = useState<ModelSlot>(defaultModelConfig)
  const [useWorktree, setUseWorktree] = useState(true)
  const [pickingModel, setPickingModel] = useState(false)
  const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)
  const [avgDurationMs, setAvgDurationMs] = useState<number | null>(null)

  useEffect(() => {
    const programDir = getProgramDir(cwd, programSlug)
    loadProgramConfig(programDir).then((config) => {
      setProgramConfig(config)
      if (config.max_experiments) {
        setMaxExpText(String(config.max_experiments))
      }
    })
    getLatestRun(programDir).then(async (run) => {
      if (!run) return
      const results = await readAllResults(run.run_dir)
      setAvgDurationMs(getAvgMeasurementDuration(results))
    })
  }, [cwd, programSlug])

  function handleStart() {
    const parsed = parseInt(maxExpText, 10)
    const maxExperiments = !isNaN(parsed) && parsed > 0 ? parsed : undefined
    onStart({ modelConfig: modelSlot, maxExperiments, useWorktree })
  }

  function handleCycleModel() {
    setPickingModel(true)
  }

  function handleCycleEffort(direction: -1 | 1) {
    if (!isEffortConfigurable(modelSlot)) return
    const validEfforts = getEffortChoicesForSlot(modelSlot)
    setModelSlot((slot) => ({ ...slot, effort: cycleChoice(validEfforts, slot.effort, direction) }))
  }

  useKeyboard((key) => {
    if (pickingModel) return
    if (key.name === "escape") {
      navigate("home")
      return
    }
    if (key.name === "return") {
      if (selected === 1) {
        handleCycleModel()
        return
      }
      handleStart()
      return
    }

    // Navigation
    if (key.name === "tab" || key.name === "down" || key.name === "j") {
      setSelected((s) => Math.min(FIELD_COUNT - 1, s + 1))
      return
    }
    if (key.name === "shift-tab" || key.name === "up" || key.name === "k") {
      setSelected((s) => Math.max(0, s - 1))
      return
    }

    // Field-specific input
    if (selected === 0) {
      if (key.name === "backspace") setMaxExpText((t) => t.slice(0, -1))
      else if (/^\d$/.test(key.name)) setMaxExpText((t) => t + key.name)
    } else if (selected === 1) {
      if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") handleCycleModel()
    } else if (selected === 2) {
      if (key.name === "left" || key.name === "h") handleCycleEffort(-1)
      if (key.name === "right" || key.name === "l") handleCycleEffort(1)
    } else if (selected === 3) {
      if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") {
        setUseWorktree((v) => !v)
      }
    }
  })

  // Time estimate
  const avgMs = avgDurationMs
  const repeats = programConfig?.repeats ?? 3
  const maxExp = parseInt(maxExpText, 10)
  const hasMaxExp = !isNaN(maxExp) && maxExp > 0
  const effortDisplay = formatEffortSlot(modelSlot)

  if (pickingModel) {
    return (
      <ModelPicker
        cwd={cwd}
        title="Run Model"
        onCancel={() => setPickingModel(false)}
        onSelect={(slot) => {
          setModelSlot((prev) => mergeSelectedModelSlot(prev, slot))
          setPickingModel(false)
        }}
      />
    )
  }

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title={`Run: ${programSlug}`}>
      <box height={1} />

      <box flexDirection="column">
        <text>
          {selected === 0 ? (
            <span fg="#7aa2f7"><strong>{`  Max Experiments: ${maxExpText || ""}`}<span fg="#7aa2f7">{"\u2588"}</span></strong></span>
          ) : (
            `  Max Experiments: ${maxExpText || "(unlimited)"}`
          )}
        </text>
        {selected === 0 && (
          <text fg="#888888">{"  Type a number, or leave empty for unlimited"}</text>
        )}
      </box>

      <box height={1} />

      <CycleField label="Model" value={formatModelSlot(modelSlot)} isFocused={selected === 1} />
      <CycleField label="Effort" value={effortDisplay.label} description={effortDisplay.description} isFocused={selected === 2} />

      <box height={1} />

      <CycleField label="Run Mode" value={useWorktree ? "Worktree (recommended)" : "In-place"} isFocused={selected === 3} />
      {!useWorktree && (
        <box flexDirection="column">
          <text fg="#ff5555">{"  \u26A0 DANGER: Runs git reset --hard in your main checkout."}</text>
          <text fg="#ff5555">{"    All uncommitted changes will be destroyed between experiments."}</text>
          <text fg="#ff5555">{"    Your branch will be changed. Only use on a clean, throwaway branch."}</text>
        </box>
      )}

      <box height={1} />

      {/* Time estimate */}
      {avgMs != null && (
        <box flexDirection="column">
          <text fg="#888888">
            {`  Each measurement takes ~${(avgMs / 1000).toFixed(1)}s (×${repeats} repeats)`}
          </text>
          {hasMaxExp && (
            <text fg="#888888">
              {`  ${maxExp} experiments \u2248 ~${Math.ceil((avgMs * maxExp * repeats) / 60000)} min (measurement only)`}
            </text>
          )}
        </box>
      )}

      <box flexGrow={1} />

      <text fg="#565f89">{"  Enter: start/open model picker | Escape: back | Tab: next field"}</text>
    </box>
  )
}
