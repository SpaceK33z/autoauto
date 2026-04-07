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
        <strong fg="#ff5555">Authentication required</strong>
      </text>
      <text>{""}</text>
      <text>AutoAuto needs access to the Anthropic API to run.</text>
      <text>{""}</text>
      <text>Run one of:</text>
      <text fg="#7aa2f7">{"  claude login         (recommended)"}</text>
      <text fg="#7aa2f7">{"  claude setup-token   (API key)"}</text>
      <text>{""}</text>
      <text>Then restart AutoAuto.</text>
      {error && (
        <>
          <text>{""}</text>
          <text fg="#888888">Error: {error}</text>
        </>
      )}
    </box>
  )
}
