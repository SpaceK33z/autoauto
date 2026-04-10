import { colors } from "../lib/theme.ts"

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
        backgroundColor={colors.surface}
      >
        <box>
          <text>
            <span fg={colors.primary}><strong>{`Max Experiments: ${maxExpText}`}<span fg={colors.primary}>{"\u2588"}</span></strong></span>
            {"  "}
            {hasMax && (
              <span fg={colors.textDim}>{`(${experimentNumber} of ${parsed} done)`}</span>
            )}
          </text>
        </box>
        {validationError ? (
          <text fg={colors.error} selectable>{validationError}</text>
        ) : (
          <text fg={colors.textMuted}>Type a number to set the experiment limit</text>
        )}
        <text fg={colors.textDim}>Esc: close</text>
      </box>
    </box>
  )
}
