import { syntaxStyle } from "../lib/syntax-theme.ts"

interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
}

export function AgentPanel({ streamingText, toolStatus, isRunning }: AgentPanelProps) {
  return (
    <box flexDirection="column" height={12} border borderStyle="rounded" title="Agent">
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {!streamingText && !toolStatus && isRunning && (
          <box padding={1}>
            <text fg="#888888">Waiting for agent...</text>
          </box>
        )}
        {streamingText && (
          <box padding={1} flexDirection="column">
            <markdown content={streamingText} syntaxStyle={syntaxStyle} streaming={isRunning} />
          </box>
        )}
      </scrollbox>
      {toolStatus && isRunning && (
        <box padding={1}>
          <text fg="#888888">⟳ {toolStatus}</text>
        </box>
      )}
    </box>
  )
}
