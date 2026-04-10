import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import type { RunState } from "../lib/run.ts"
import { getRunStats } from "../lib/run.ts"
import type { TerminationReason } from "../lib/experiment-loop.ts"
import type { VerificationResult } from "../lib/verify.ts"
import { colors } from "../lib/theme.ts"

interface RunCompletePromptProps {
  state: RunState
  direction: "lower" | "higher"
  terminationReason: TerminationReason | null
  error: string | null
  onFinalize: () => void
  onAbandon: () => void
  onUpdateProgram: () => void
  onVerify: () => void
  verificationResults: VerificationResult[] | null
  isVerifying: boolean
  verifyProgress: string | null
}

function formatPctDelta(original: number, verified: number): string {
  if (original === 0) return "N/A"
  const pct = ((verified - original) / Math.abs(original)) * 100
  const sign = pct > 0 ? "+" : ""
  return `${sign}${pct.toFixed(1)}%`
}

export function RunCompletePrompt({
  state,
  direction,
  terminationReason,
  error,
  onFinalize,
  onAbandon,
  onUpdateProgram,
  onVerify,
  verificationResults,
  isVerifying,
  verifyProgress,
}: RunCompletePromptProps) {
  const [selected, setSelected] = useState(0)
  const stats = getRunStats(state, direction)
  const menuDisabled = isVerifying

  useKeyboard((key) => {
    if (menuDisabled) return

    if (key.name === "up" || key.name === "k") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (key.name === "down" || key.name === "j") {
      setSelected((s) => Math.min(3, s + 1))
    } else if (key.name === "return") {
      if (selected === 0) onFinalize()
      else if (selected === 1) onUpdateProgram()
      else if (selected === 2) onVerify()
      else onAbandon()
    } else if (key.name === "f") {
      onFinalize()
    } else if (key.name === "u") {
      onUpdateProgram()
    } else if (key.name === "v") {
      onVerify()
    } else if (key.name === "d") {
      onAbandon()
    }
  })

  const reasonLabel =
    terminationReason === "aborted" ? "Aborted by user"
    : terminationReason === "max_experiments" ? `Reached max experiments (${state.experiment_number})`
    : terminationReason === "stagnation" ? "Stopped — no improvements (stagnation)"
    : terminationReason === "budget_exceeded" ? `Budget exceeded ($${(state.total_cost_usd ?? 0).toFixed(2)})`
    : terminationReason === "quota_exhausted" ? "Provider quota exhausted"
    : "Run complete"

  const improvementStr = stats.improvement_pct !== 0
    ? ` (${stats.improvement_pct > 0 ? "+" : ""}${stats.improvement_pct.toFixed(1)}%)`
    : ""

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Run Complete">
      <box flexDirection="column" padding={1}>
        <text fg={colors.success} selectable><strong>{reasonLabel}</strong></text>
        <box height={1} />
        <text selectable>Program: {state.program_slug}</text>
        <text selectable>Branch: {state.branch_name}</text>
        <text selectable>Experiments: {stats.total_experiments} ({stats.total_keeps} kept, {stats.total_discards} discarded, {stats.total_crashes} crashed)</text>
        <text selectable>Original baseline: {state.original_baseline}</text>
        <text selectable>Best metric: {state.best_metric}{improvementStr}</text>
        {stats.total_keeps > 0 && (
          <text selectable>Keep rate: {(stats.keep_rate * 100).toFixed(0)}%</text>
        )}
        {error && <text fg={colors.error} selectable>Error: {error}</text>}

        {verificationResults && verificationResults.length > 0 && (
          <>
            <box height={1} />
            <text fg={colors.primary} selectable><strong>Verification Results</strong></text>
            {verificationResults.map((r, i) => (
              <box key={`${r.target}-${i}`} flexDirection="column">
                {r.success ? (
                  <text selectable>
                    {"  "}{r.target === "baseline" ? "Baseline" : "Current"}: {r.original_metric} {"\u2192"} {r.median_metric} ({formatPctDelta(r.original_metric, r.median_metric)})
                  </text>
                ) : (
                  <text fg={colors.error} selectable>
                    {"  "}{r.target === "baseline" ? "Baseline" : "Current"}: failed — {r.failure_reason}
                  </text>
                )}
                {r.success && Object.keys(r.median_quality_gates).length > 0 && (
                  <text fg={colors.textMuted} selectable>
                    {"    "}Quality gates: {Object.entries(r.median_quality_gates).map(([k, v]) => `${k}=${v}`).join(", ")}
                    {!r.quality_gates_passed && r.gate_violations.length > 0 ? ` (FAILED: ${r.gate_violations.join("; ")})` : ""}
                  </text>
                )}
                {r.success && Object.keys(r.median_secondary_metrics).length > 0 && (
                  <text fg={colors.textMuted} selectable>
                    {"    "}Secondary: {Object.entries(r.median_secondary_metrics).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </text>
                )}
              </box>
            ))}
          </>
        )}

        {isVerifying && (
          <>
            <box height={1} />
            <text fg={colors.warning} selectable>{verifyProgress ?? "Verifying..."}</text>
          </>
        )}

        <box height={1} />
        <text><strong>What would you like to do?</strong></text>
        <box height={1} />
        <text fg={selected === 0 ? colors.text : colors.textMuted}>
          {selected === 0 ? " > " : "   "}
          Finalize (review & package changes)
        </text>
        <text fg={selected === 1 ? colors.text : colors.textMuted}>
          {selected === 1 ? " > " : "   "}
          Update Program (edit config/scripts)
        </text>
        <text fg={selected === 2 ? colors.text : colors.textMuted}>
          {selected === 2 ? " > " : "   "}
          Verify Results (re-run measurements)
        </text>
        <text fg={selected === 3 ? colors.text : colors.textMuted}>
          {selected === 3 ? " > " : "   "}
          Done (keep branch as-is)
        </text>
        <box height={1} />
        <text fg={colors.textMuted}>j/k move · Enter select · f finalize · u update · v verify · d done</text>
      </box>
    </box>
  )
}
