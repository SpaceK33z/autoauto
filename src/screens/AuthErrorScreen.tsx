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
        <span fg="#ff5555"><strong>Authentication required</strong></span>
      </text>
      <box height={1} />
      <text>AutoAuto needs access to the Anthropic API to run.</text>
      <box height={1} />
      <text>Run one of:</text>
      <text fg="#7aa2f7">{"  claude login         (recommended)"}</text>
      <text fg="#7aa2f7">{"  claude setup-token   (API key)"}</text>
      <box height={1} />
      <text>Then restart AutoAuto.</text>
      {error && (
        <>
          <box height={1} />
          <text fg="#888888">Error: {error}</text>
        </>
      )}
    </box>
  )
}
