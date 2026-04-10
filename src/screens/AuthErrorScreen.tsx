import { colors } from "../lib/theme.ts"

export function AuthErrorScreen({ error }: { error: string }) {
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderStyle="rounded"
      title="AutoAuto"
      justifyContent="center"
      alignItems="center"
    >
      <text>
        <span fg={colors.error}><strong>Authentication required</strong></span>
      </text>
      <box height={1} />
      <text>AutoAuto needs access to the Anthropic API to run.</text>
      <box height={1} />
      <text>Run one of:</text>
      <text fg={colors.primary}>{"  claude login         (recommended)"}</text>
      <text fg={colors.primary}>{"  claude setup-token   (API key)"}</text>
      <box height={1} />
      <text>Then restart AutoAuto.</text>
      {error && (
        <>
          <box height={1} />
          <text fg={colors.textMuted} selectable>Error: {error}</text>
        </>
      )}
    </box>
  )
}
