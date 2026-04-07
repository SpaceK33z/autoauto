import type { ExperimentResult } from "../lib/run.ts"
import { syntaxStyle } from "../lib/syntax-theme.ts"

interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
  selectedResult?: ExperimentResult | null
}

import { statusColor } from "./ResultsTable.tsx"

function ExperimentDetail({ result }: { result: ExperimentResult }) {
  const secondaryValues = result.secondary_values ? (() => {
    try { return JSON.parse(result.secondary_values) as Record<string, unknown> } catch { return null }
  })() : null

  return (
    <box flexDirection="column" paddingX={1} gap={1}>
      <box flexDirection="column">
        <text><strong fg="#a9b1d6">Experiment #{result.experiment_number}</strong></text>
        <text fg="#565f89">{"─".repeat(40)}</text>
      </box>

      <box flexDirection="column">
        <text><strong fg="#a9b1d6">Status:  </strong><strong fg={statusColor(result.status)}>{result.status}</strong></text>
        <text><strong fg="#a9b1d6">Commit:  </strong><strong fg="#c0caf5">{result.commit}</strong></text>
        <text><strong fg="#a9b1d6">Metric:  </strong><strong fg="#c0caf5">{result.metric_value ?? "—"}</strong></text>
      </box>

      {secondaryValues && Object.keys(secondaryValues).length > 0 && (
        <box flexDirection="column">
          <text><strong fg="#a9b1d6">Quality Gates:</strong></text>
          {Object.entries(secondaryValues).map(([key, val]) => (
            <text key={key} fg="#c0caf5">  {key}: {String(val)}</text>
          ))}
        </box>
      )}

      <box flexDirection="column">
        <text><strong fg="#a9b1d6">Description:</strong></text>
        <text fg="#c0caf5">{result.description}</text>
      </box>
    </box>
  )
}

export function AgentPanel({ streamingText, toolStatus, isRunning, selectedResult }: AgentPanelProps) {
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
      {toolStatus && isRunning && (
        <box paddingX={1}>
          <text fg="#a9b1d6">⟳ {toolStatus}</text>
        </box>
      )}
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {!streamingText && !toolStatus && isRunning && (
          <box paddingX={1}>
            <text fg="#a9b1d6">Waiting for agent...</text>
          </box>
        )}
        {streamingText && (
          <box paddingX={1} flexDirection="column">
            <markdown content={streamingText} syntaxStyle={syntaxStyle} streaming={isRunning} />
          </box>
        )}
      </scrollbox>
    </box>
  )
}
