import { useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import {
  type Screen,
  type ProgramConfig,
  getProgramDir,
  loadProgramConfig,
} from "../lib/programs.ts"
import { readAllResults, getAvgMeasurementDuration, listRuns } from "../lib/run.ts"
import type { QuotaInfo } from "../lib/agent/types.ts"
import { formatResetsIn, formatElapsed } from "../lib/format.ts"
import {
  type ModelSlot,
  cycleChoice,
  formatEffortSlot,
  formatModelSlot,
  getEffortChoicesForSlot,
  isEffortConfigurable,
  mergeSelectedModelSlot,
  PROVIDER_CHOICES,
  PROVIDER_LABELS,
} from "../lib/config.ts"
import { MODAL_PROVIDER_ID, DOCKER_PROVIDER_ID } from "../lib/container-provider/index.ts"

type SandboxChoice = "off" | "docker" | "modal"
const SANDBOX_CHOICES: readonly SandboxChoice[] = ["off", DOCKER_PROVIDER_ID, MODAL_PROVIDER_ID]

const SANDBOX_LABELS: Record<SandboxChoice, string> = {
  off: "Off",
  [DOCKER_PROVIDER_ID]: "Docker",
  [MODAL_PROVIDER_ID]: "Modal",
}

const SANDBOX_DESCRIPTIONS: Record<SandboxChoice, string> = {
  off: "Experiments run locally on this machine",
  [DOCKER_PROVIDER_ID]: "Experiments run in a local Docker container — consistent environment, no cloud account",
  [MODAL_PROVIDER_ID]: "Experiments run in a remote Modal sandbox — your computer stays free",
}
import { CycleField } from "../components/CycleField.tsx"
import { ModelPicker } from "../components/ModelPicker.tsx"
import { resolveCompatibleModelSlot } from "../lib/model-options.ts"
import { colors } from "../lib/theme.ts"

export interface PreRunOverrides {
  modelConfig: ModelSlot
  maxExperiments: number
  maxCostUsd?: number
  useWorktree: boolean
  carryForward: boolean
  keepSimplifications: boolean
  useSandbox: boolean
  sandboxProvider?: string
}

interface PreRunScreenProps {
  cwd: string
  programSlug: string
  defaultModelConfig: ModelSlot
  navigate: (screen: Screen) => void
  onStart: (overrides: PreRunOverrides) => void
  onAddToQueue?: (overrides: PreRunOverrides) => void
  programHasQueueEntries?: boolean
}

function QuotaWarning({ quota }: { quota: QuotaInfo }) {
  const isExhausted = quota.status === "rejected"
  const color = isExhausted ? colors.error : colors.warning
  const message = isExhausted
    ? "⚠ Quota exhausted — this run will likely fail."
    : `  ⚠ Quota at ${quota.utilization != null ? `${Math.round(quota.utilization * 100)}%` : "high usage"} — may run out during this run.`
  const advice = isExhausted
    ? "    Configure a fallback model in Settings, or wait for quota to reset."
    : "    Consider configuring a fallback model in Settings."

  return (
    <box flexDirection="column">
      <text fg={color}>{message}</text>
      {quota.resetsAt && (
        <text fg={color}>{`    Resets in ${formatResetsIn(quota.resetsAt)}`}</text>
      )}
      <text fg={color}>{advice}</text>
      <text fg={colors.textDim}>{`    (last checked ${formatElapsed(quota.updatedAt)})`}</text>
    </box>
  )
}

// 0=maxExperiments, 1=maxCostUsd, 2=provider, 3=model, 4=effort, 5=sandbox, 6=runMode, 7=keepSimplifications, 8=carryForward (if previous runs exist)
const BASE_FIELD_COUNT = 8

export function PreRunScreen({ cwd, programSlug, defaultModelConfig, navigate, onStart, onAddToQueue, programHasQueueEntries = false }: PreRunScreenProps) {
  const [selected, setSelected] = useState(0)
  const [maxExpText, setMaxExpText] = useState("")
  const [maxCostText, setMaxCostText] = useState("")
  const [modelSlot, setModelSlot] = useState<ModelSlot>(defaultModelConfig)
  const [useWorktree, setUseWorktree] = useState(true)
  const [keepSimplifications, setKeepSimplifications] = useState(true)
  const [carryForward, setCarryForward] = useState(true)
  const [sandboxChoice, setSandboxChoice] = useState<SandboxChoice>("off")
  const [sandboxAuthError, setSandboxAuthError] = useState<string | null>(null)
  const [sandboxAuthMethod, setSandboxAuthMethod] = useState<string | null>(null)
  const [hasPreviousRuns, setHasPreviousRuns] = useState(false)
  const [pickingModel, setPickingModel] = useState(false)
  const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)
  const [avgDurationMs, setAvgDurationMs] = useState<number | null>(null)
  const [cachedQuota, setCachedQuota] = useState<QuotaInfo | null>(null)
  const useSandbox = sandboxChoice !== "off"
  const fieldCount = hasPreviousRuns ? BASE_FIELD_COUNT + 1 : BASE_FIELD_COUNT

  useEffect(() => {
    const programDir = getProgramDir(cwd, programSlug)
    loadProgramConfig(programDir).then((config) => {
      setProgramConfig(config)
      if (config.max_experiments) {
        setMaxExpText(String(config.max_experiments))
      }
      setKeepSimplifications(config.keep_simplifications !== false)
    })
    listRuns(programDir).then(async (runs) => {
      setCachedQuota(null)
      const completedRuns = runs.filter((r) => r.state?.phase === "complete")
      setHasPreviousRuns(completedRuns.length > 0)
      // Load cached quota from latest run (any status, not just completed)
      const latestAny = runs[0] ?? null
      if (latestAny) {
        try {
          const quota = await Bun.file(`${latestAny.run_dir}/quota.json`).json() as QuotaInfo
          setCachedQuota(quota)
        } catch { /* no cached quota */ }
      }
      const latest = completedRuns[0] ?? null
      if (!latest) return
      try {
        const results = await readAllResults(latest.run_dir)
        setAvgDurationMs(getAvgMeasurementDuration(results))
      } catch {
        setHasPreviousRuns(false)
      }
    })
  }, [cwd, programSlug])

  function buildOverrides(): PreRunOverrides | null {
    const parsed = parseInt(maxExpText, 10)
    if (isNaN(parsed) || parsed < 1) return null
    const costParsed = parseFloat(maxCostText)
    const maxCostUsd = !isNaN(costParsed) && costParsed > 0 ? costParsed : undefined
    return { modelConfig: modelSlot, maxExperiments: parsed, maxCostUsd, useWorktree: useSandbox ? false : useWorktree, carryForward, keepSimplifications, useSandbox, sandboxProvider: useSandbox ? sandboxChoice : undefined }
  }

  function handleStart() {
    if (programHasQueueEntries) return
    if (sandboxAuthError) return
    const overrides = buildOverrides()
    if (overrides) onStart(overrides)
  }

  function handleAddToQueue() {
    if (!onAddToQueue) return
    if (sandboxAuthError) return
    const overrides = buildOverrides()
    if (overrides) onAddToQueue(overrides)
  }

  async function handleCycleProvider(direction: -1 | 1) {
    const nextProvider = cycleChoice(PROVIDER_CHOICES, modelSlot.provider, direction)
    const fallbackModel = nextProvider === "claude" ? "sonnet" : "default"
    const nextSlot = await resolveCompatibleModelSlot(
      { provider: nextProvider, model: fallbackModel, effort: modelSlot.effort },
      cwd,
    )
    setModelSlot(nextSlot)
  }

  function applySandboxAuth(auth: { ok: boolean; error?: string; authMethod?: string }) {
    if (!auth.ok) {
      setSandboxAuthError(auth.error ?? "Sandbox auth failed")
      setSandboxAuthMethod(null)
    } else {
      setSandboxAuthError(null)
      setSandboxAuthMethod(auth.authMethod ?? null)
    }
  }

  function handleCycleSandbox(direction: -1 | 1) {
    const next = cycleChoice(SANDBOX_CHOICES, sandboxChoice, direction)
    setSandboxChoice(next)

    if (next === "off") {
      setSandboxAuthError(null)
      setSandboxAuthMethod(null)
      return
    }

    if (next === DOCKER_PROVIDER_ID) {
      import("../lib/container-provider/docker.ts").then(({ checkDockerAuth }) => {
        checkDockerAuth().then(applySandboxAuth)
      })
      return
    }

    if (next === MODAL_PROVIDER_ID) {
      import("../lib/container-provider/modal.ts").then(({ checkModalAuth }) => {
        applySandboxAuth(checkModalAuth())
      })
    }
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
    if (key.name === "s") {
      handleStart()
      return
    }
    // "a" adds to queue, but not when on text-input fields (0=maxExp, 1=budget) or sandbox is on
    if (key.name === "a" && selected !== 0 && selected !== 1 && !useSandbox) {
      handleAddToQueue()
      return
    }

    // Enter activates the focused field (cycle/toggle/open picker)
    if (key.name === "return") {
      if (selected === 0 || selected === 1) { handleStart(); return }
      if (selected === 2) { handleCycleProvider(1).catch(() => {}); return }
      if (selected === 3) { setPickingModel(true); return }
      if (selected === 4) { handleCycleEffort(1); return }
      if (selected === 5) { handleCycleSandbox(1); return }
      if (selected === 6 && !useSandbox) { setUseWorktree((v) => !v); return }
      if (selected === 7) { setKeepSimplifications((v) => !v); return }
      if (selected === 8 && hasPreviousRuns) { setCarryForward((v) => !v); return }
      return
    }

    // Navigation
    if (key.name === "tab" || key.name === "down" || key.name === "j") {
      setSelected((s) => Math.min(fieldCount - 1, s + 1))
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
      if (key.name === "backspace") setMaxCostText((t) => t.slice(0, -1))
      else if (/^[\d.]$/.test(key.name)) setMaxCostText((t) => t + key.name)
    } else if (selected === 2) {
      if (key.name === "left" || key.name === "h") handleCycleProvider(-1).catch(() => {})
      if (key.name === "right" || key.name === "l") handleCycleProvider(1).catch(() => {})
    } else if (selected === 3) {
      if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") setPickingModel(true)
    } else if (selected === 4) {
      if (key.name === "left" || key.name === "h") handleCycleEffort(-1)
      if (key.name === "right" || key.name === "l") handleCycleEffort(1)
    } else if (selected === 5) {
      if (key.name === "left" || key.name === "h") handleCycleSandbox(-1)
      if (key.name === "right" || key.name === "l") handleCycleSandbox(1)
    } else if (selected === 6 && !useSandbox) {
      if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") {
        setUseWorktree((v) => !v)
      }
    } else if (selected === 7) {
      if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") {
        setKeepSimplifications((v) => !v)
      }
    } else if (selected === 8 && hasPreviousRuns) {
      if (key.name === "left" || key.name === "h" || key.name === "right" || key.name === "l") {
        setCarryForward((v) => !v)
      }
    }
  })

  // Time estimate
  const avgMs = avgDurationMs
  const repeats = programConfig?.repeats ?? 3
  const maxExp = parseInt(maxExpText, 10)
  const hasMaxExp = !isNaN(maxExp) && maxExp > 0
  const effortDisplay = formatEffortSlot(modelSlot)
  const footerHint = onAddToQueue && !useSandbox
    ? programHasQueueEntries
      ? "  a: add to queue | Enter: toggle field | Escape: back | Tab: next"
      : "  s: start | a: add to queue | Enter: toggle field | Escape: back | Tab: next"
    : "  s: start | Enter: toggle field | Escape: back | Tab: next"

  if (pickingModel) {
    return (
      <ModelPicker
        cwd={cwd}
        title={`Run Model — ${PROVIDER_LABELS[modelSlot.provider]}`}
        providerId={modelSlot.provider}
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
            <span fg={colors.primary}><strong>{`  Max Experiments: ${maxExpText || ""}`}<span fg={colors.primary}>{"█"}</span></strong></span>
          ) : (
            `  Max Experiments: ${maxExpText || "(required)"}`
          )}
        </text>
        {selected === 0 && (
          <text fg={colors.textMuted}>{"  Type a number (required)"}</text>
        )}
      </box>

      <box flexDirection="column">
        <text>
          {selected === 1 ? (
            <span fg={colors.primary}><strong>{`  Budget Cap: ${maxCostText ? `$${maxCostText}` : ""}`}<span fg={colors.primary}>{"█"}</span></strong></span>
          ) : (
            `  Budget Cap: ${maxCostText ? `$${maxCostText}` : "(no limit)"}`
          )}
        </text>
        {selected === 1 && (
          <text fg={colors.textMuted}>{"  Max cost in USD (optional — blank for no limit)"}</text>
        )}
      </box>

      <box height={1} />

      <CycleField label="Provider" value={PROVIDER_LABELS[modelSlot.provider]} isFocused={selected === 2} />
      <CycleField label="Model" value={formatModelSlot(modelSlot)} isFocused={selected === 3} />
      <CycleField label="Effort" value={effortDisplay.label} description={effortDisplay.description} isFocused={selected === 4} />

      <box height={1} />

      <CycleField label="Sandbox" value={SANDBOX_LABELS[sandboxChoice]} description={SANDBOX_DESCRIPTIONS[sandboxChoice]} isFocused={selected === 5} />
      {sandboxAuthError && (
        <text fg={colors.error}>{`  ⚠ ${sandboxAuthError}`}</text>
      )}
      {useSandbox && !sandboxAuthError && sandboxAuthMethod === "oauth_token" && (
        <text fg={colors.textMuted}>{"  Using Claude subscription auth (CLAUDE_CODE_OAUTH_TOKEN)"}</text>
      )}
      {useSandbox && (
        <text fg={colors.textMuted}>{"  Sandbox runs cannot be queued yet"}</text>
      )}

      <CycleField label="Run Mode" value={useSandbox ? "In-place (sandbox)" : useWorktree ? "Worktree" : "In-place"} hint={!useSandbox && useWorktree ? "(recommended)" : undefined} description={useSandbox ? "Sandbox runs always use in-place mode — the sandbox itself is the isolation boundary" : useWorktree ? "Your checkout stays usable while experiments run in an isolated copy" : undefined} isFocused={selected === 6} />
      {!useWorktree && !useSandbox && (
        <box flexDirection="column">
          <text fg={colors.error}>{"  ⚠ DANGER: Runs git reset --hard in your main checkout."}</text>
          <text fg={colors.error}>{"    All uncommitted changes will be destroyed between experiments."}</text>
          <text fg={colors.error}>{"    Your branch will be changed. Only use on a clean, throwaway branch."}</text>
        </box>
      )}

      <CycleField label="Keep Simplifications" value={keepSimplifications ? "On" : "Off"} hint={keepSimplifications ? "(recommended)" : undefined} description={keepSimplifications ? "Free wins: keeps code-reducing changes even if the metric stays flat" : "Strict mode: only keep changes that measurably improve the metric"} isFocused={selected === 7} />

      {hasPreviousRuns && (
        <CycleField label="Previous Run Context" value={carryForward ? "On" : "Off"} description={carryForward ? "Avoids repeating failed approaches, but may bias toward previous patterns" : "Fresh perspective for breaking out of local optima, but may re-try failed approaches"} isFocused={selected === 8} />
      )}

      <box height={1} />

      {/* Time estimate */}
      {avgMs != null && (
        <box flexDirection="column">
          <text fg={colors.textMuted}>
            {`  Each measurement takes ~${(avgMs / 1000).toFixed(1)}s (×${repeats} repeats)`}
          </text>
          {hasMaxExp && (
            <text fg={colors.textMuted}>
              {`  ${maxExp} experiments ≈ ~${Math.ceil((avgMs * maxExp * repeats) / 60000)} min (measurement only)`}
            </text>
          )}
        </box>
      )}

      {cachedQuota && modelSlot.provider === "claude" && (cachedQuota.status === "rejected" || cachedQuota.status === "allowed_warning") && (
        <QuotaWarning quota={cachedQuota} />
      )}

      <box flexGrow={1} />

      {programHasQueueEntries && (
        <text fg={colors.orange}>{"  ⚠ This program has queued runs. Press 'a' to add to queue."}</text>
      )}
      <text fg={colors.textDim}>{footerHint}</text>
    </box>
  )
}
