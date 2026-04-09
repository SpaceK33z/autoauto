import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"
import type { RunState } from "../lib/run.ts"
import type { VerificationResult } from "../lib/verify.ts"

const BASE_STATE: RunState = {
  run_id: "20260401-100000",
  program_slug: "perf-opt",
  phase: "complete",
  experiment_number: 8,
  original_baseline: 100,
  current_baseline: 85,
  best_metric: 82,
  best_experiment: 6,
  total_keeps: 5,
  total_discards: 2,
  total_crashes: 1,
  branch_name: "autoauto-perf-opt-20260401-100000",
  original_baseline_sha: "aaa1111",
  last_known_good_sha: "bbb2222",
  candidate_sha: null,
  started_at: "2026-04-01T10:00:00Z",
  updated_at: "2026-04-01T12:00:00Z",
  termination_reason: "max_experiments",
}

const VERIFICATION_PASS: VerificationResult[] = [
  {
    target: "baseline",
    success: true,
    original_metric: 100,
    median_metric: 98,
    median_quality_gates: {},
    median_secondary_metrics: {},
    quality_gates_passed: true,
    gate_violations: [],
    duration_ms: 5000,
  },
  {
    target: "current",
    success: true,
    original_metric: 82,
    median_metric: 83,
    median_quality_gates: {},
    median_secondary_metrics: {},
    quality_gates_passed: true,
    gate_violations: [],
    duration_ms: 5000,
  },
]

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("RunCompletePrompt — verify shortcut", () => {
  test("v shortcut triggers onVerify", async () => {
    let verified = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={noop}
        onAbandon={noop}
        onUpdateProgram={noop}
        onVerify={() => { verified = true }}
        verificationResults={null}
        isVerifying={false}
        verifyProgress={null}
      />,
    )
    await harness.frame()
    await harness.press("v")
    expect(verified).toBe(true)
  })

  test("j j Enter selects Verify Results via menu", async () => {
    let verified = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={noop}
        onAbandon={noop}
        onUpdateProgram={noop}
        onVerify={() => { verified = true }}
        verificationResults={null}
        isVerifying={false}
        verifyProgress={null}
      />,
    )
    await harness.frame()
    await harness.press("j")
    await harness.press("j")
    await harness.enter()
    expect(verified).toBe(true)
  })

  test("displays verification results when provided", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={noop}
        onAbandon={noop}
        onUpdateProgram={noop}
        onVerify={noop}
        verificationResults={VERIFICATION_PASS}
        isVerifying={false}
        verifyProgress={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Verification Results")
    expect(frame).toContain("Baseline")
    expect(frame).toContain("Current")
  })

  test("shows verifying progress text", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={noop}
        onAbandon={noop}
        onUpdateProgram={noop}
        onVerify={noop}
        verificationResults={null}
        isVerifying={true}
        verifyProgress="Measuring baseline (2/5)..."
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Measuring baseline (2/5)...")
  })

  test("keyboard is disabled during verification", async () => {
    let finalized = false
    let updated = false
    let verified = false
    let abandoned = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => { finalized = true }}
        onAbandon={() => { abandoned = true }}
        onUpdateProgram={() => { updated = true }}
        onVerify={() => { verified = true }}
        verificationResults={null}
        isVerifying={true}
        verifyProgress="Verifying..."
      />,
    )
    await harness.frame()
    await harness.press("f")
    await harness.press("u")
    await harness.press("v")
    await harness.press("d")
    expect(finalized).toBe(false)
    expect(updated).toBe(false)
    expect(verified).toBe(false)
    expect(abandoned).toBe(false)
  })

  test("displays failed verification", async () => {
    const failedResults: VerificationResult[] = [
      {
        target: "baseline",
        success: false,
        original_metric: 100,
        median_metric: 0,
        median_quality_gates: {},
        median_secondary_metrics: {},
        quality_gates_passed: false,
        gate_violations: [],
        duration_ms: 5000,
        failure_reason: "Measurement script timed out",
      },
    ]
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={noop}
        onAbandon={noop}
        onUpdateProgram={noop}
        onVerify={noop}
        verificationResults={failedResults}
        isVerifying={false}
        verifyProgress={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Verification Results")
    expect(frame).toContain("failed")
    expect(frame).toContain("Measurement script timed out")
  })
})
