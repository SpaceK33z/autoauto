import { useState, useRef, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import type { Screen } from "../lib/programs.ts"
import {
  type ProjectConfig,
  type ModelSlot,
  cycleChoice,
  formatEffortSlot,
  formatModelSlot,
  getEffortChoicesForSlot,
  getNotificationCommand,
  isEffortConfigurable,
  mergeSelectedModelSlot,
  saveProjectConfig,
  DEFAULT_CONFIG,
  NOTIFICATION_PRESETS,
  NOTIFICATION_PRESET_IDS,
  PROVIDER_CHOICES,
  PROVIDER_LABELS,
} from "../lib/config.ts"
import { sendNotification } from "../lib/notify.ts"
import type { RunState } from "../lib/run.ts"
import { CycleField } from "../components/CycleField.tsx"
import { ModelPicker } from "../components/ModelPicker.tsx"
import { colors } from "../lib/theme.ts"

interface SettingsScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  config: ProjectConfig
  onConfigChange: (config: ProjectConfig) => void
}

// Row layout:
// 0: exec provider   1: exec model   2: exec effort
// 3: support provider 4: support model 5: support effort
// 6: fallback enabled (toggle)
// 7: fallback provider  8: fallback model  9: fallback effort  (only when fallback enabled)
// N: ideas backlog
// N+1: notification preset
// N+2: notification command (only when preset === "custom")
// N+3: test notification (only when preset !== "off")
function makeTestState(): RunState {
  return {
    run_id: "20260408-120000",
    program_slug: "example-program",
    phase: "complete",
    experiment_number: 12,
    original_baseline: 100,
    current_baseline: 115,
    best_metric: 115,
    best_experiment: 8,
    total_keeps: 5,
    total_discards: 6,
    total_crashes: 1,
    branch_name: "autoauto-example-20260408",
    original_baseline_sha: "abc1234",
    last_known_good_sha: "def5678",
    candidate_sha: null,
    started_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    termination_reason: "max_experiments",
    error: null,
    error_phase: null,
  }
}

function slotKeyForRow(row: number, fallbackEnabled: boolean): "executionModel" | "supportModel" | "executionFallbackModel" {
  if (row < 3) return "executionModel"
  if (row < 6) return "supportModel"
  if (fallbackEnabled && row >= 7 && row <= 9) return "executionFallbackModel"
  return "executionModel" // shouldn't reach here for effort rows
}

export function SettingsScreen({ cwd, navigate, config, onConfigChange }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0)
  const [pickingSlot, setPickingSlot] = useState<"executionModel" | "supportModel" | "executionFallbackModel" | null>(null)
  const [editingCommand, setEditingCommand] = useState(false)
  const [inputKey, setInputKey] = useState(0)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fallbackEnabled = config.executionFallbackModel != null
  const fallbackRows = fallbackEnabled ? 3 : 0 // provider/model/effort when enabled
  const preset = config.notificationPreset
  const isCustom = preset === "custom"
  const notifyEnabled = preset !== "off"
  // 6 base (exec+support) + 1 fallback toggle + fallbackRows + 1 ideas + 1 preset + optional command + optional test
  const rowCount = 6 + 1 + fallbackRows + 1 + 1 + (notifyEnabled ? (isCustom ? 2 : 1) : 0)

  // Dynamic row indices (shift everything after fallback section)
  const ROW_FALLBACK_TOGGLE = 6
  const ROW_FALLBACK_PROVIDER = 7
  const ROW_FALLBACK_MODEL = 8
  const ROW_FALLBACK_EFFORT = 9
  const ROW_IDEAS = 6 + 1 + fallbackRows
  const ROW_PRESET = ROW_IDEAS + 1
  const ROW_COMMAND = ROW_PRESET + 1 // only when custom
  const ROW_TEST = notifyEnabled ? rowCount - 1 : -1

  useEffect(() => {
    return () => {
      if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current)
    }
  }, [])

  useEffect(() => {
    setSelected((current) => Math.min(current, rowCount - 1))
  }, [rowCount])

  const updateConfig = (updater: (prev: ProjectConfig) => ProjectConfig) => {
    const next = updater(config)
    onConfigChange(next)
    saveProjectConfig(cwd, next)
  }

  function cycleProvider(slotKey: "executionModel" | "supportModel" | "executionFallbackModel", direction: -1 | 1) {
    updateConfig((prev) => {
      const slot = slotKey === "executionFallbackModel"
        ? (prev.executionFallbackModel ?? DEFAULT_CONFIG.executionModel)
        : prev[slotKey]
      const nextProvider = cycleChoice(PROVIDER_CHOICES, slot.provider, direction)
      const defaultModel = nextProvider === "claude" ? "sonnet" : "default"
      const effort = nextProvider === "opencode" ? slot.effort : slot.effort
      return { ...prev, [slotKey]: { provider: nextProvider, model: defaultModel, effort } }
    })
  }

  function cyclePreset(direction: -1 | 1) {
    updateConfig((prev) => ({
      ...prev,
      notificationPreset: cycleChoice(NOTIFICATION_PRESET_IDS, prev.notificationPreset, direction),
    }))
  }

  function handleCommandSubmit(value: unknown) {
    if (typeof value !== "string") return
    updateConfig((prev) => ({ ...prev, notificationCommand: value || null }))
    setEditingCommand(false)
  }

  async function fireTestNotification() {
    const cmd = getNotificationCommand(config)
    if (!cmd) return
    if (testTimeoutRef.current) clearTimeout(testTimeoutRef.current)
    setTestStatus("Sending...")
    const sent = await sendNotification(cmd, makeTestState())
    setTestStatus(sent ? "Sent!" : "Failed")
    testTimeoutRef.current = setTimeout(() => setTestStatus(null), 3000)
  }

  function cycleValue(direction: -1 | 1) {
    // Provider rows
    if (selected === 0) return cycleProvider("executionModel", direction)
    if (selected === 3) return cycleProvider("supportModel", direction)
    if (fallbackEnabled && selected === ROW_FALLBACK_PROVIDER) return cycleProvider("executionFallbackModel", direction)

    // Model rows — open picker
    if (selected === 1) { setPickingSlot("executionModel"); return }
    if (selected === 4) { setPickingSlot("supportModel"); return }
    if (fallbackEnabled && selected === ROW_FALLBACK_MODEL) { setPickingSlot("executionFallbackModel"); return }

    // Fallback toggle
    if (selected === ROW_FALLBACK_TOGGLE) {
      updateConfig((prev) => ({
        ...prev,
        executionFallbackModel: prev.executionFallbackModel != null ? null : { ...DEFAULT_CONFIG.executionModel },
      }))
      return
    }

    // Ideas backlog
    if (selected === ROW_IDEAS) {
      updateConfig((prev) => ({ ...prev, ideasBacklogEnabled: !prev.ideasBacklogEnabled }))
      return
    }

    // Notification preset
    if (selected === ROW_PRESET) {
      cyclePreset(direction)
      return
    }

    // Effort rows (exec: 2, support: 5, fallback: 9)
    const slotKey = slotKeyForRow(selected, fallbackEnabled)
    updateConfig((prev) => {
      const slot = slotKey === "executionFallbackModel"
        ? { ...(prev.executionFallbackModel ?? DEFAULT_CONFIG.executionModel) }
        : { ...prev[slotKey] }
      if (!isEffortConfigurable(slot)) return prev
      const validEfforts = getEffortChoicesForSlot(slot)
      slot.effort = cycleChoice(validEfforts, slot.effort, direction)
      return { ...prev, [slotKey]: slot }
    })
  }

  useKeyboard((key) => {
    if (pickingSlot || editingCommand) return
    if (key.name === "escape") navigate("home")
    if (key.name === "up" || key.name === "k")
      setSelected((s) => Math.max(0, s - 1))
    if (key.name === "down" || key.name === "j")
      setSelected((s) => Math.min(rowCount - 1, s + 1))
    if (key.name === "left" || key.name === "h") cycleValue(-1)
    if (key.name === "right" || key.name === "l") cycleValue(1)
    if (key.name === "return") {
      if (selected === 1 || selected === 4) {
        setPickingSlot(selected === 1 ? "executionModel" : "supportModel")
      } else if (fallbackEnabled && selected === ROW_FALLBACK_MODEL) {
        setPickingSlot("executionFallbackModel")
      } else if (selected === ROW_FALLBACK_TOGGLE) {
        cycleValue(1)
      } else if (isCustom && selected === ROW_COMMAND) {
        setEditingCommand(true)
        setInputKey((k) => k + 1)
      } else if (notifyEnabled && selected === ROW_TEST) {
        fireTestNotification()
      }
    }
  })

  const execSlot = config.executionModel
  const supportSlot = config.supportModel
  const fallbackSlot = config.executionFallbackModel ?? DEFAULT_CONFIG.executionModel
  const execEffort = formatEffortSlot(execSlot)
  const supportEffort = formatEffortSlot(supportSlot)
  const fallbackEffort = formatEffortSlot(fallbackSlot)

  if (pickingSlot) {
    const slot: ModelSlot = pickingSlot === "executionFallbackModel"
      ? (config.executionFallbackModel ?? DEFAULT_CONFIG.executionModel)
      : config[pickingSlot]
    const title = pickingSlot === "executionModel" ? "Execution Model"
      : pickingSlot === "supportModel" ? "Support Model"
      : "Fallback Model"
    return (
      <ModelPicker
        cwd={cwd}
        title={`${title} — ${PROVIDER_LABELS[slot.provider]}`}
        providerId={slot.provider}
        onCancel={() => setPickingSlot(null)}
        onSelect={(newSlot) => {
          updateConfig((prev) => {
            const prevSlot: ModelSlot = pickingSlot === "executionFallbackModel"
              ? (prev.executionFallbackModel ?? DEFAULT_CONFIG.executionModel)
              : prev[pickingSlot]
            return { ...prev, [pickingSlot]: mergeSelectedModelSlot(prevSlot, newSlot) }
          })
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
        <text fg={colors.textMuted}>{"(experiment agents)"}</text>
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
        <text fg={colors.textMuted}>{"(setup & finalize)"}</text>
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
        <text><strong>{"  Execution Fallback "}</strong></text>
        <text fg={colors.textMuted}>{"(auto-switch on quota/rate limits)"}</text>
      </box>
      <CycleField
        label="Fallback Model"
        value={fallbackEnabled ? "On" : "Off"}
        description={fallbackEnabled
          ? "Keeps the run going with a backup model, but experiment quality may drop"
          : "Run stops cleanly on quota/rate limits — resume later to maintain quality"}
        isFocused={selected === ROW_FALLBACK_TOGGLE}
      />
      {fallbackEnabled && (
        <>
          <CycleField
            label="Provider"
            value={PROVIDER_LABELS[fallbackSlot.provider]}
            isFocused={selected === ROW_FALLBACK_PROVIDER}
          />
          <CycleField
            label="Model"
            value={formatModelSlot(fallbackSlot)}
            isFocused={selected === ROW_FALLBACK_MODEL}
          />
          <CycleField
            label="Effort"
            value={fallbackEffort.label}
            description={fallbackEffort.description}
            isFocused={selected === ROW_FALLBACK_EFFORT}
          />
        </>
      )}
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Experiment Memory "}</strong></text>
        <text fg={colors.textMuted}>{"(ideas backlog)"}</text>
      </box>
      <CycleField
        label="Ideas Backlog"
        value={config.ideasBacklogEnabled ? "On" : "Off"}
        description={config.ideasBacklogEnabled
          ? "Prevents repeating failed approaches, but uses extra context per experiment"
          : "Saves context for the agent, but may waste cycles re-trying dead ends"}
        isFocused={selected === ROW_IDEAS}
      />
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Notifications "}</strong></text>
        <text fg={colors.textMuted}>{"(on run complete)"}</text>
      </box>
      <CycleField
        label="Preset"
        value={NOTIFICATION_PRESETS.find((p) => p.id === preset)?.label ?? "Off"}
        isFocused={selected === ROW_PRESET}
      />
      {notifyEnabled && (
        <>
          {isCustom && (
            <box flexDirection="column">
              {editingCommand && selected === ROW_COMMAND ? (
                <box border borderStyle="rounded" height={3}>
                  <input
                    key={inputKey}
                    focused
                    value={config.notificationCommand ?? ""}
                    placeholder="Shell command with {{program}}, {{status}}, etc."
                    onSubmit={handleCommandSubmit}
                  />
                </box>
              ) : (
                <text>
                  {selected === ROW_COMMAND ? (
                    <span fg={colors.primary}><strong>{`  Command: ${config.notificationCommand ?? ""}`}</strong></span>
                  ) : (
                    `  Command: ${config.notificationCommand ?? ""}`
                  )}
                </text>
              )}
              {selected === ROW_COMMAND && !editingCommand && (
                <text fg={colors.textMuted}>{"  Enter to edit \u2022 Variables: {{program}} {{run_id}} {{status}} {{experiments}} {{keeps}} {{best_metric}} {{improvement_pct}} {{duration}}"}</text>
              )}
            </box>
          )}
          <box flexDirection="column">
            <text>
              {selected === ROW_TEST ? (
                <span fg={colors.primary}><strong>{`  Test Notification${testStatus ? ` \u2014 ${testStatus}` : ""}`}</strong></span>
              ) : (
                `  Test Notification${testStatus ? ` \u2014 ${testStatus}` : ""}`
              )}
            </text>
            {selected === ROW_TEST && (
              <text fg={colors.textMuted}>{"  Press Enter to send a test notification with sample data"}</text>
            )}
          </box>
        </>
      )}
    </box>
  )
}
