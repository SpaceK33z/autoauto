import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { RunCompletePrompt } from "./RunCompletePrompt.tsx"
import type { RunState } from "../lib/run.ts"

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy()
    })
    testSetup = null
  }
})

const TEST_STATE: RunState = {
  run_id: "20260408-000000",
  program_slug: "demo",
  phase: "complete",
  experiment_number: 3,
  original_baseline: 100,
  current_baseline: 90,
  best_metric: 88,
  best_experiment: 2,
  total_keeps: 2,
  total_discards: 1,
  total_crashes: 0,
  branch_name: "autoauto-demo-20260408-000000",
  original_baseline_sha: "1234567890abcdef",
  last_known_good_sha: "abcdef1234567890",
  candidate_sha: null,
  started_at: "2026-04-08T10:00:00.000Z",
  updated_at: "2026-04-08T10:10:00.000Z",
  termination_reason: "max_experiments",
}

describe("RunCompletePrompt", () => {
  test("shows keyboard controls", async () => {
    testSetup = await testRender(
      <RunCompletePrompt
        state={TEST_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
        onVerify={() => {}}
        verificationResults={null}
        isVerifying={false}
        verifyProgress={null}
      />,
      { width: 100, height: 24, useKittyKeyboard: {} },
    )

    await act(async () => {
      await testSetup!.renderOnce()
    })

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("j/k move")
    expect(frame).toContain("Enter select")
    expect(frame).toContain("f finalize")
    expect(frame).toContain("u update")
    expect(frame).toContain("v verify")
  })
})
