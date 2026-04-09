import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { FinalizeApproval } from "../components/FinalizeApproval.tsx"
import type { ProposedGroup } from "../lib/finalize.ts"

const SAMPLE_GROUPS: ProposedGroup[] = [
  {
    name: "perf-hotpath",
    title: "Hot path optimizations",
    description: "Inline frequently called functions",
    files: ["src/engine.ts", "src/cache.ts"],
    risk: "low",
  },
  {
    name: "api-refactor",
    title: "API endpoint restructuring",
    description: "Consolidate duplicate handlers",
    files: ["src/routes/users.ts"],
    risk: "medium",
  },
]

const SUMMARY = "The run completed 8 experiments with 5 kept changes."

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("FinalizeApproval — action buttons", () => {
  test("Enter on default triggers approve when groups exist", async () => {
    let approved = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => { approved = true }}
        onSkipGrouping={noop}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.enter()
    expect(approved).toBe(true)
  })

  test("right arrow then Enter triggers skip grouping", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={noop}
        onSkipGrouping={() => { skipped = true }}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.arrow("right")
    await harness.enter()
    expect(skipped).toBe(true)
  })

  test("right right then Enter triggers cancel", async () => {
    let cancelled = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={noop}
        onSkipGrouping={noop}
        onRefine={noop}
        onCancel={() => { cancelled = true }}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.arrow("right")
    await harness.arrow("right")
    await harness.enter()
    expect(cancelled).toBe(true)
  })

  test("Tab cycles through actions like right arrow", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={noop}
        onSkipGrouping={() => { skipped = true }}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.tab()
    await harness.enter()
    expect(skipped).toBe(true)
  })

  test("left arrow navigates back after right", async () => {
    let approved = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => { approved = true }}
        onSkipGrouping={noop}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.arrow("right")
    await harness.arrow("left")
    await harness.enter()
    expect(approved).toBe(true)
  })
})

describe("FinalizeApproval — without groups", () => {
  test("Enter on default triggers save summary (skip grouping)", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={null}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={noop}
        onSkipGrouping={() => { skipped = true }}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.enter()
    expect(skipped).toBe(true)
  })

  test("right then Enter triggers cancel without groups", async () => {
    let cancelled = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={null}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={noop}
        onSkipGrouping={noop}
        onRefine={noop}
        onCancel={() => { cancelled = true }}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.arrow("right")
    await harness.enter()
    expect(cancelled).toBe(true)
  })
})

describe("FinalizeApproval — h/l navigation", () => {
  test("h key navigates left (same as left arrow)", async () => {
    let approved = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => { approved = true }}
        onSkipGrouping={noop}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    // Move right then back with h
    await harness.press("l")
    await harness.press("h")
    await harness.enter()
    expect(approved).toBe(true)
  })

  test("l key navigates right (same as right arrow)", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={noop}
        onSkipGrouping={() => { skipped = true }}
        onRefine={noop}
        onCancel={noop}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.press("l")
    await harness.enter()
    expect(skipped).toBe(true)
  })
})
