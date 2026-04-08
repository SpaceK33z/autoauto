interface RunSettingsOverlayProps {
  maxExpText: string
  experimentNumber: number
  validationError: string | null
}

export function RunSettingsOverlay({ maxExpText, experimentNumber, validationError }: RunSettingsOverlayProps) {
  const parsed = parseInt(maxExpText, 10)
  const hasMax = !isNaN(parsed) && parsed > 0

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      zIndex={100}
    >
      <box
        border
        borderStyle="rounded"
        title="Run Settings"
        flexDirection="column"
        paddingX={1}
        width={50}
        backgroundColor="#1a1b26"
      >
        <box>
          <text>
            <span fg="#7aa2f7"><strong>{`Max Experiments: ${maxExpText}`}<span fg="#7aa2f7">{"\u2588"}</span></strong></span>
            {"  "}
            {hasMax && (
              <span fg="#666666">{`(${experimentNumber} of ${parsed} done)`}</span>
            )}
          </text>
        </box>
        {validationError ? (
          <text fg="#ff5555" selectable>{validationError}</text>
        ) : (
          <text fg="#888888">Type a number to set the experiment limit</text>
        )}
        <text fg="#666666">Esc: close</text>
      </box>
    </box>
  )
}
