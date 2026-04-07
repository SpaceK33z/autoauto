interface CycleFieldProps {
  label: string
  value: string
  description?: string
  isFocused: boolean
}

export function CycleField({ label, value, description, isFocused }: CycleFieldProps) {
  return (
    <box flexDirection="column">
      <text>
        {isFocused ? (
          <span fg="#7aa2f7"><strong>{`  ${label}: \u25C2 ${value} \u25B8`}</strong></span>
        ) : (
          `  ${label}: ${value}`
        )}
      </text>
      {isFocused && description && (
        <text fg="#888888">{`  ${description}`}</text>
      )}
    </box>
  )
}
