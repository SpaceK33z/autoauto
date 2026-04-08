import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { RunCompletePrompt } from "../components/RunCompletePrompt.tsx"
import type { RunState } from "../lib/run.ts"

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

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("RunCompletePrompt E2E", () => {
  test("displays run summary with stats", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Run Complete")
    expect(frame).toContain("perf-opt")
    expect(frame).toContain("max experiments")
    expect(frame).toContain("82")
    expect(frame).toContain("5 kept")
    expect(frame).toContain("2 discarded")
    expect(frame).toContain("1 crashed")
  })

  test("displays all three action options", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Finalize")
    expect(frame).toContain("Update Program")
    expect(frame).toContain("Done")
  })

  test("shows aborted reason when terminated by user", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="aborted"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Aborted by user")
  })

  test("shows stagnation reason", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="stagnation"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("stagnation")
  })

  test("shows error message when provided", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="aborted"
        error="Agent crashed unexpectedly"
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Agent crashed unexpectedly")
  })

  test("j/k navigates between options", async () => {
    let finalized = false
    let abandoned = false
    let updated = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => { finalized = true }}
        onAbandon={() => { abandoned = true }}
        onUpdateProgram={() => { updated = true }}
      />,
    )
    await harness.frame()

    // Default selection is Finalize (index 0), move to Update Program
    await harness.press("j")
    await harness.enter()
    expect(updated).toBe(true)
    expect(finalized).toBe(false)
    expect(abandoned).toBe(false)
  })

  test("navigates to Done with j/j and Enter abandons", async () => {
    let abandoned = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => { abandoned = true }}
        onUpdateProgram={() => {}}
      />,
    )
    await harness.frame()

    await harness.press("j")
    await harness.press("j")
    await harness.enter()
    expect(abandoned).toBe(true)
  })

  test("k navigates back up after j", async () => {
    let finalized = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => { finalized = true }}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    await harness.frame()

    await harness.press("j")
    await harness.press("k")
    await harness.enter()
    expect(finalized).toBe(true)
  })

  test("f shortcut triggers finalize directly", async () => {
    let finalized = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => { finalized = true }}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    await harness.frame()
    await harness.press("f")
    expect(finalized).toBe(true)
  })

  test("u shortcut triggers update program", async () => {
    let updated = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => { updated = true }}
      />,
    )
    await harness.frame()
    await harness.press("u")
    expect(updated).toBe(true)
  })

  test("d shortcut triggers done/abandon", async () => {
    let abandoned = false
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => { abandoned = true }}
        onUpdateProgram={() => {}}
      />,
    )
    await harness.frame()
    await harness.press("d")
    expect(abandoned).toBe(true)
  })

  test("shows improvement percentage for lower-is-better metric", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    // 82 from 100 = -18% which is an improvement for lower direction
    expect(frame).toContain("%")
  })

  test("shows keep rate", async () => {
    harness = await renderTui(
      <RunCompletePrompt
        state={BASE_STATE}
        direction="lower"
        terminationReason="max_experiments"
        error={null}
        onFinalize={() => {}}
        onAbandon={() => {}}
        onUpdateProgram={() => {}}
      />,
    )
    const frame = await harness.frame()
    // 5 keeps / 8 total = 62.5% → rounds to 63%
    expect(frame).toContain("Keep rate")
    expect(frame).toContain("63%")
  })
})
