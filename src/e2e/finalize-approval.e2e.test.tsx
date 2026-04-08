import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { FinalizeApproval } from "../components/FinalizeApproval.tsx"
import type { ProposedGroup } from "../lib/finalize.ts"

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

const SUMMARY = `## Run Summary

The optimization run completed 8 experiments with 5 kept changes.

### Key Changes
- Optimized hot path in engine.ts
- Refactored API endpoints for consistency
- Added database indexes for query performance`

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("FinalizeApproval E2E — with groups", () => {
  test("displays proposed groups with risk levels", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Proposed Groups (3)")
    expect(frame).toContain("Hot path optimizations")
    expect(frame).toContain("API endpoint restructuring")
    expect(frame).toContain("Database schema changes")
    expect(frame).toContain("low risk")
    expect(frame).toContain("medium risk")
    expect(frame).toContain("high risk")
  })

  test("displays file lists for each group", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("src/engine.ts")
    expect(frame).toContain("src/cache.ts")
    expect(frame).toContain("src/routes/users.ts")
    expect(frame).toContain("migrations/002_indexes.sql")
  })

  test("shows approve and skip instructions", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Enter approve")
    expect(frame).toContain("skip grouping")
    expect(frame).toContain("Esc cancel")
  })

  test("a shortcut approves groups", async () => {
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
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.press("a")
    expect(approved).toBe(true)
  })

  test("s shortcut skips grouping", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => { skipped = true }}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.press("s")
    expect(skipped).toBe(true)
  })

  test("Escape cancels finalize", async () => {
    let cancelled = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => { cancelled = true }}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.escape()
    expect(cancelled).toBe(true)
  })
})

describe("FinalizeApproval E2E — without groups", () => {
  test("shows no groups message", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={null}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("No file groups proposed")
  })

  test("shows validation error when present", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={null}
        validationError="Failed to parse group JSON"
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Failed to parse group JSON")
  })

  test("a shortcut calls skipGrouping when no groups", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={null}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => { skipped = true }}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    await harness.frame()
    await harness.press("a")
    expect(skipped).toBe(true)
  })

  test("shows save summary instructions when no groups", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={null}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Enter save summary")
  })
})

describe("FinalizeApproval E2E — refining state", () => {
  test("shows refining text when agent is responding", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={true}
        refiningText="Adjusting the groups based on your feedback..."
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Refinement")
    expect(frame).toContain("Adjusting the groups")
  })

  test("shows tool status spinner when refining without text", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={true}
        refiningText=""
        toolStatus="Reading file src/engine.ts"
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Reading file src/engine.ts")
  })

  test("shows generic refining message when no text or tool status", async () => {
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={SAMPLE_GROUPS}
        validationError={null}
        isRefining={true}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => {}}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("Refining groups")
  })
})

describe("FinalizeApproval E2E — empty groups array", () => {
  test("empty array treated same as no groups", async () => {
    let skipped = false
    harness = await renderTui(
      <FinalizeApproval
        summary={SUMMARY}
        proposedGroups={[]}
        validationError={null}
        isRefining={false}
        refiningText=""
        toolStatus={null}
        onApprove={() => {}}
        onSkipGrouping={() => { skipped = true }}
        onRefine={() => {}}
        onCancel={() => {}}
      />,
      { width: 120, height: 40 },
    )
    const frame = await harness.frame()
    expect(frame).toContain("No file groups proposed")
    // 'a' should skip grouping, not approve
    await harness.press("a")
    expect(skipped).toBe(true)
  })
})
