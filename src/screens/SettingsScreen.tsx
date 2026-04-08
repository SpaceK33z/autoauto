import { useState, useRef, useEffect } from "react"
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
  DEFAULT_NOTIFICATION_COMMAND,
  PROVIDER_CHOICES,
  PROVIDER_LABELS,
} from "../lib/config.ts"
import { sendNotification } from "../lib/notify.ts"
import type { RunState } from "../lib/run.ts"
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
// 7: notification toggle  8: notification command  9: test notification
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

function slotKeyForRow(row: number): "executionModel" | "supportModel" {
  return row < 3 ? "executionModel" : "supportModel"
}

export function SettingsScreen({ cwd, navigate, config, onConfigChange }: SettingsScreenProps) {
  const [selected, setSelected] = useState(0)
  const [pickingSlot, setPickingSlot] = useState<"executionModel" | "supportModel" | null>(null)
  const [editingCommand, setEditingCommand] = useState(false)
  const [inputKey, setInputKey] = useState(0)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notifyEnabled = config.notificationCommand !== null
  const rowCount = notifyEnabled ? 10 : 8

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

  function toggleNotifications() {
    updateConfig((prev) => ({
      ...prev,
      notificationCommand: prev.notificationCommand === null
        ? DEFAULT_NOTIFICATION_COMMAND
        : null,
    }))
  }

  function handleCommandSubmit(value: unknown) {
    if (typeof value !== "string") return
    updateConfig((prev) => ({ ...prev, notificationCommand: value || null }))
    setEditingCommand(false)
  }

  async function fireTestNotification() {
    const cmd = config.notificationCommand
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

    // Notification toggle
    if (selected === 7) {
      toggleNotifications()
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
      } else if (selected === 8 && notifyEnabled) {
        setEditingCommand(true)
        setInputKey((k) => k + 1)
      } else if (selected === 9 && notifyEnabled) {
        fireTestNotification()
      }
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
      <box height={1} />
      <box flexDirection="row">
        <text><strong>{"  Notifications "}</strong></text>
        <text fg="#888888">{"(on run complete)"}</text>
      </box>
      <CycleField
        label="Enabled"
        value={notifyEnabled ? "On" : "Off"}
        description={notifyEnabled
          ? "Run a shell command when a run finishes"
          : "No notifications"}
        isFocused={selected === 7}
      />
      {notifyEnabled && (
        <>
          <box flexDirection="column">
            {editingCommand && selected === 8 ? (
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
                {selected === 8 ? (
                  <span fg="#7aa2f7"><strong>{`  Command: ${config.notificationCommand ?? ""}`}</strong></span>
                ) : (
                  `  Command: ${config.notificationCommand ?? ""}`
                )}
              </text>
            )}
            {selected === 8 && !editingCommand && (
              <text fg="#888888">{"  Enter to edit \u2022 Variables: {{program}} {{run_id}} {{status}} {{experiments}} {{keeps}} {{best_metric}} {{improvement_pct}} {{duration}}"}</text>
            )}
          </box>
          <box flexDirection="column">
            <text>
              {selected === 9 ? (
                <span fg="#7aa2f7"><strong>{`  Test Notification${testStatus ? ` \u2014 ${testStatus}` : ""}`}</strong></span>
              ) : (
                `  Test Notification${testStatus ? ` \u2014 ${testStatus}` : ""}`
              )}
            </text>
            {selected === 9 && (
              <text fg="#888888">{"  Press Enter to send a test notification with sample data"}</text>
            )}
          </box>
        </>
      )}
    </box>
  )
}
