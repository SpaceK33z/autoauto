import { syntaxStyle } from "../lib/syntax-theme.ts"

interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
}

export function AgentPanel({ streamingText, toolStatus, isRunning }: AgentPanelProps) {
  return (
    <box flexDirection="column" flexGrow={1}>
      {toolStatus && isRunning && (
        <box paddingX={1}>
          <text fg="#565f89">⟳ {toolStatus}</text>
        </box>
      )}
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {!streamingText && !toolStatus && isRunning && (
          <box paddingX={1}>
            <text fg="#565f89">Waiting for agent...</text>
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
