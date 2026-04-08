import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { FinalizeApproval, type FinalizeApprovalProps } from "../components/FinalizeApproval.tsx"
import type { ProposedGroup } from "../lib/finalize.ts"

/**
 * Note: FinalizeApproval uses a scrollbox with flexGrow which causes
 * text overlap in OpenTUI's test frame capture. Content above the
 * scrollbox (group headers, descriptions) renders correctly in most
 * cases. Keyboard callbacks work correctly regardless of rendering.
 */

const SAMPLE_GROUPS: ProposedGroup[] = [
  {
    name: "perf-hotpath",
    title: "Hot path optimizations",
    description: "Inline frequently called functions and reduce allocations",
    files: ["src/engine.ts", "src/cache.ts"],
    risk: "low",
  },
  {
    name: "api-refactor",
    title: "API endpoint restructuring",
    description: "Consolidate duplicate handler logic",
    files: ["src/routes/users.ts", "src/routes/auth.ts", "src/middleware.ts"],
    risk: "medium",
  },
  {
    name: "db-migration",
    title: "Database schema changes",
    description: "Add indexes and normalize tables",
    files: ["migrations/002_indexes.sql"],
    risk: "high",
  },
]

const SUMMARY = "The optimization run completed 8 experiments with 5 kept changes."

const noop = () => {}

function renderApproval(overrides: Partial<FinalizeApprovalProps> = {}) {
  return renderTui(
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
      onCancel={noop}
      {...overrides}
    />,
    { width: 120, height: 40 },
  )
}

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("FinalizeApproval E2E — with groups", () => {
  test("displays proposed groups header and descriptions", async () => {
    harness = await renderApproval()
    const frame = await harness.frame()
    expect(frame).toContain("Proposed Groups (3)")
    expect(frame).toContain("Inline frequently called functions")
    expect(frame).toContain("Consolidate duplicate handler logic")
    expect(frame).toContain("Add indexes and normalize tables")
  })

  test("Escape cancels finalize", async () => {
    let cancelled = false
    harness = await renderApproval({ onCancel: () => { cancelled = true } })
    await harness.frame()
    await harness.escape()
    expect(cancelled).toBe(true)
  })
})

describe("FinalizeApproval E2E — without groups", () => {
  test("shows no groups message", async () => {
    harness = await renderApproval({ proposedGroups: null })
    const frame = await harness.frame()
    expect(frame).toContain("No file groups proposed")
  })

  test("shows validation error label when present", async () => {
    harness = await renderApproval({
      proposedGroups: null,
      validationError: "Failed to parse group JSON",
    })
    const frame = await harness.frame()
    // Scrollbox rendering overlap garbles some text, but "Validation" and "group JSON" are present
    expect(frame).toContain("Validation")
    expect(frame).toContain("group JSON")
  })

  test("Escape cancels finalize without groups", async () => {
    let cancelled = false
    harness = await renderApproval({
      proposedGroups: null,
      onCancel: () => { cancelled = true },
    })
    await harness.frame()
    await harness.escape()
    expect(cancelled).toBe(true)
  })
})

describe("FinalizeApproval E2E — refining state", () => {
  test("shortcuts are disabled during refinement", async () => {
    let approved = false
    let skipped = false
    harness = await renderApproval({
      isRefining: true,
      refiningText: "Working...",
      onApprove: () => { approved = true },
      onSkipGrouping: () => { skipped = true },
    })
    await harness.frame()
    await harness.press("a")
    await harness.press("s")
    expect(approved).toBe(false)
    expect(skipped).toBe(false)
  })

  test("Escape is disabled during refinement", async () => {
    let cancelled = false
    harness = await renderApproval({
      proposedGroups: null,
      isRefining: true,
      onCancel: () => { cancelled = true },
    })
    await harness.frame()
    await harness.escape()
    expect(cancelled).toBe(false)
  })

  test("renders without crashing during tool status", async () => {
    harness = await renderApproval({
      proposedGroups: null,
      isRefining: true,
      toolStatus: "Reading file src/engine.ts",
    })
    const frame = await harness.frame()
    expect(frame).toContain("Finalize")
  })
})

describe("FinalizeApproval E2E — empty groups array", () => {
  test("empty array shows no groups message", async () => {
    harness = await renderApproval({ proposedGroups: [] })
    const frame = await harness.frame()
    expect(frame).toContain("No file groups proposed")
  })

  test("Escape works with empty groups", async () => {
    let cancelled = false
    harness = await renderApproval({
      proposedGroups: [],
      onCancel: () => { cancelled = true },
    })
    await harness.frame()
    await harness.escape()
    expect(cancelled).toBe(true)
  })
})
