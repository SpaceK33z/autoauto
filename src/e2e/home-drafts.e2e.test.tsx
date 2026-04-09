import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import { resetProjectRoot } from "../lib/programs.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import type { DraftSession } from "../lib/drafts.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  fixture = await createTestFixture()
  await fixture.createProgram("perf-benchmark", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 20,
  })
})

beforeEach(async () => {
  // Recreate draft before each test since some tests delete it
  await fixture.createDraft("draft-20260401-1200", {
    type: "setup",
    createdAt: "2026-04-01T12:00:00Z",
    mode: "chat",
    messages: [{ role: "user", content: "test" }],
  })
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

afterAll(async () => {
  await fixture.cleanup()
})

describe("HomeScreen — drafts", () => {
  test("displays drafts in programs panel", async () => {
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    const frame = await harness.waitForText("perf-benchmark")
    expect(frame).toContain("Draft")
  })

  test("n key resumes first draft instead of creating new", async () => {
    let resumedName: string | null = null
    let resumedDraft: DraftSession | null = null
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={(name, draft) => { resumedName = name; resumedDraft = draft }}
      />,
      { width: 120 },
    )
    await harness.waitForText("Draft")
    await harness.press("n")
    expect(resumedName).toBe("draft-20260401-1200")
    expect(resumedDraft).not.toBeNull()
  })

  test("Enter on selected draft resumes it", async () => {
    let resumedName: string | null = null
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={(name) => { resumedName = name }}
      />,
      { width: 120 },
    )
    await harness.waitForText("Draft")
    // Drafts appear above programs, so index 0 is the draft
    await harness.enter()
    expect(resumedName).toBe("draft-20260401-1200")
  })

  test("d on selected draft deletes it without confirmation", async () => {
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    await harness.waitForText("Draft")
    await harness.press("d")
    // After deleting the draft, wait for reload — draft should disappear
    const frame = await harness.waitForText("perf-benchmark")
    // The "Draft" label from the draft entry should be gone
    // Only "perf-benchmark" should remain in the programs panel
    expect(frame).toContain("perf-benchmark")
  })

  test("j from draft to program then e edits program", async () => {
    let editedSlug: string | null = null
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={(slug) => { editedSlug = slug }}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    await harness.waitForText("Draft")
    // Move from draft (index 0) to program (index 1)
    await harness.press("j")
    await harness.press("e")
    expect(editedSlug).toBe("perf-benchmark")
  })
})
