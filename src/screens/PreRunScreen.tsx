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
  type EffortLevel,
  MODEL_CHOICES,
  EFFORT_CHOICES,
  MODEL_LABELS,
  EFFORT_LABELS,
  EFFORT_DESCRIPTIONS,
  cycleChoice,
} from "../lib/config.ts"
import { CycleField } from "../components/CycleField.tsx"

export interface PreRunOverrides {
  modelConfig: ModelSlot
  maxExperiments: number | undefined
}

interface PreRunScreenProps {
  cwd: string
  programSlug: string
  defaultModelConfig: ModelSlot
  navigate: (screen: Screen) => void
  onStart: (overrides: PreRunOverrides) => void
}

const FIELD_COUNT = 3 // 0=maxExperiments, 1=model, 2=effort

export function PreRunScreen({ cwd, programSlug, defaultModelConfig, navigate, onStart }: PreRunScreenProps) {
  const [selected, setSelected] = useState(0)
  const [maxExpText, setMaxExpText] = useState("")
  const [model, setModel] = useState(defaultModelConfig.model)
  const [effort, setEffort] = useState<EffortLevel>(defaultModelConfig.effort)
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
    onStart({ modelConfig: { model, effort }, maxExperiments })
  }

  function handleCycleModel(direction: -1 | 1) {
    const next = cycleChoice(MODEL_CHOICES, model as (typeof MODEL_CHOICES)[number], direction)
    setModel(next)
    const validEfforts = EFFORT_CHOICES[next] ?? EFFORT_CHOICES.sonnet
    if (!validEfforts.includes(effort)) {
      setEffort("high")
    }
  }

  function handleCycleEffort(direction: -1 | 1) {
    const validEfforts = EFFORT_CHOICES[model] ?? EFFORT_CHOICES.sonnet
    setEffort(cycleChoice(validEfforts, effort, direction))
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("home")
      return
    }
    if (key.name === "return") {
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
      if (key.name === "left" || key.name === "h") handleCycleModel(-1)
      if (key.name === "right" || key.name === "l") handleCycleModel(1)
    } else if (selected === 2) {
      if (key.name === "left" || key.name === "h") handleCycleEffort(-1)
      if (key.name === "right" || key.name === "l") handleCycleEffort(1)
    }
  })

  // Time estimate
  const avgMs = avgDurationMs
  const repeats = programConfig?.repeats ?? 3
  const maxExp = parseInt(maxExpText, 10)
  const hasMaxExp = !isNaN(maxExp) && maxExp > 0

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

      <CycleField label="Model" value={MODEL_LABELS[model] ?? model} isFocused={selected === 1} />
      <CycleField label="Effort" value={EFFORT_LABELS[effort]} description={EFFORT_DESCRIPTIONS[effort]} isFocused={selected === 2} />

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

      <text fg="#565f89">{"  Enter: start run | Escape: back | Tab: next field"}</text>
    </box>
  )
}
