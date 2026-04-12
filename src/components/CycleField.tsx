import { colors } from "../lib/theme.ts"

interface CycleFieldProps {
  label: string
  value: string
  hint?: string
  description?: string
  isFocused: boolean
}

export function CycleField({ label, value, hint, description, isFocused }: CycleFieldProps) {
  return (
    <box flexDirection="column">
      <text>
        {isFocused ? (
          <><span fg={colors.primary}><strong>{`  ${label}: \u25C2 ${value} \u25B8`}</strong></span>{hint && <span fg={colors.textDim}>{` ${hint}`}</span>}</>
        ) : (
          <>{`  ${label}: ${value}`}{hint && <span fg={colors.textDim}>{` ${hint}`}</span>}</>
        )}
      </text>
      {isFocused && description && (
        <text fg={colors.textMuted}>{`  ${description}`}</text>
      )}
    </box>
  )
}
