import type { ExperimentResult } from "../lib/run.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"
import { statusColor } from "./ResultsTable.tsx"

interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
  selectedResult?: ExperimentResult | null
  phaseLabel?: string | null
  experimentNumber?: number
}

function parseJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return null }
}

function ExperimentDetail({ result }: { result: ExperimentResult }) {
  const secondaryValues = parseJson(result.secondary_values)

  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="column">
        <text selectable><strong fg="#a9b1d6">Experiment #{result.experiment_number}</strong></text>
        <text fg="#565f89">{"─".repeat(40)}</text>
      </box>

      <box flexDirection="column">
        <text selectable><strong fg="#a9b1d6">Status:  </strong><strong fg={statusColor(result.status)}>{result.status}</strong></text>
        <text selectable><strong fg="#a9b1d6">Commit:  </strong><strong fg="#c0caf5">{result.commit}</strong></text>
        <text selectable><strong fg="#a9b1d6">Metric:  </strong><strong fg="#c0caf5">{result.metric_value ?? "—"}</strong></text>
      </box>

      {secondaryValues && Object.keys(secondaryValues).length > 0 && (
        <box flexDirection="column">
          <text><strong fg="#a9b1d6">Quality Gates:</strong></text>
          {Object.entries(secondaryValues).map(([key, val]) => (
            <text key={key} fg="#c0caf5" selectable>  {key}: {String(val)}</text>
          ))}
        </box>
      )}

      <box flexDirection="column">
        <text><strong fg="#a9b1d6">Description:</strong></text>
        <text fg="#c0caf5" selectable>{result.description}</text>
      </box>
    </box>
  )
}

export function AgentPanel({ streamingText, toolStatus, isRunning, selectedResult, phaseLabel, experimentNumber }: AgentPanelProps) {
  if (selectedResult) {
    return (
      <box flexDirection="column" flexGrow={1}>
        <scrollbox flexGrow={1}>
          <ExperimentDetail result={selectedResult} />
        </scrollbox>
        <box paddingX={1}>
          <text fg="#565f89">Esc to return to live view</text>
        </box>
      </box>
    )
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {!streamingText && isRunning && (
          <box paddingX={1} flexDirection="column">
            <WaitingIndicator phaseLabel={phaseLabel} experimentNumber={experimentNumber} toolStatus={toolStatus} />
          </box>
        )}
        {streamingText && (
          <box paddingX={1} flexDirection="column">
            {toolStatus && isRunning && (
              <text fg="#565f89" selectable>{toolStatus}</text>
            )}
            <markdown content={streamingText} syntaxStyle={syntaxStyle} streaming={isRunning} />
          </box>
        )}
      </scrollbox>
    </box>
  )
}

function WaitingIndicator({ phaseLabel, experimentNumber, toolStatus }: { phaseLabel?: string | null; experimentNumber?: number; toolStatus?: string | null }) {
  const expLabel = experimentNumber ? `#${experimentNumber}` : ""

  // Phase-specific status
  if (phaseLabel) {
    const lower = phaseLabel.toLowerCase()
    if (lower.includes("baseline") && !lower.includes("re-baseline")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Establishing baseline</span></text>
          <text fg="#565f89">  Running measurement to set the starting metric</text>
        </box>
      )
    }
    if (lower.includes("measuring") || lower.includes("re-baseline")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">{phaseLabel}</span></text>
          <text fg="#565f89">  Evaluating experiment {expLabel} via measure.sh</text>
        </box>
      )
    }
    if (lower.includes("reverting")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#e0af68">{phaseLabel}</span></text>
          <text fg="#565f89">  Resetting to last known good state</text>
        </box>
      )
    }
    if (lower.includes("kept")) {
      return <text><span fg="#a9b1d6">{">"}</span> <span fg="#9ece6a">{phaseLabel}</span></text>
    }
    if (lower.includes("starting daemon")) {
      return (
        <box flexDirection="column">
          <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Starting daemon</span></text>
          <text fg="#565f89">  Creating worktree and spawning background process</text>
        </box>
      )
    }
  }

  // Agent running but no text yet — show tool if available, otherwise thinking
  if (toolStatus) {
    return (
      <box flexDirection="column">
        <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Agent working</span> <span fg="#565f89">{expLabel}</span></text>
        <text fg="#565f89">  {toolStatus}</text>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text><span fg="#a9b1d6">{">"}</span> <span fg="#c0caf5">Agent thinking</span> <span fg="#565f89">{expLabel}</span></text>
      <text fg="#565f89">  Building context and waiting for first response</text>
    </box>
  )
}
