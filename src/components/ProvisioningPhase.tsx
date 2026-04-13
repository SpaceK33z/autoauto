import { useState, useEffect } from "react"
import { colors } from "../lib/theme.ts"

const SPINNER_CHARS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

interface ProvisioningPhaseProps {
  status: string | null
}

export function ProvisioningPhase({ status }: ProvisioningPhaseProps) {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(interval)
  }, [])

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Provisioning Sandbox">
      <box padding={1} flexDirection="column">
        <text>
          <span fg={colors.primary}>{SPINNER_CHARS[tick % SPINNER_CHARS.length]}</span>
          <span fg={colors.text}>{" Setting up remote sandbox..."}</span>
        </text>
        {status && <text fg={colors.textMuted}>{`  ${status}`}</text>}
      </box>
      <box flexGrow={1} />
      <box paddingX={1} flexShrink={0}>
        <text fg={colors.textMuted}>Escape: cancel</text>
      </box>
    </box>
  )
}
