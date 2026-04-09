import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import { resetProjectRoot } from "../lib/programs.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  fixture = await createTestFixture()

  // Program without active run
  await fixture.createProgram("editable-prog", {
    metric_field: "score",
    direction: "lower",
    max_experiments: 10,
  })

  // Program with active run
  await fixture.createProgram("active-prog", {
    metric_field: "score",
    direction: "lower",
    max_experiments: 10,
  })
  await fixture.createRun("active-prog", {
    run_id: "20260401-200000",
    phase: "idle",
    experiment_number: 3,
  })

  // Draft
  await fixture.createDraft("draft-edit-test", {
    type: "setup",
    createdAt: "2026-04-01T12:00:00Z",
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

describe("HomeScreen — edit shortcut (e)", () => {
  test("e on program without active run calls onUpdateProgram", async () => {
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
    await harness.waitForText("editable-prog")
    // Draft is at index 0, active-prog at index 1 (pinned: has active run),
    // editable-prog at index 2. Navigate down twice.
    await harness.press("j")
    await harness.press("j")
    await harness.press("e")
    expect(editedSlug).toBe("editable-prog")
  })

  test("e on program with active run does nothing", async () => {
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
    await harness.waitForText("active-prog")
    // Navigate to active-prog (index 1, after draft at index 0)
    await harness.press("j")
    await harness.press("e")
    expect(editedSlug).toBeNull()
  })

  test("e on draft does nothing", async () => {
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
    // Draft is at index 0, already selected
    await harness.press("e")
    expect(editedSlug).toBeNull()
  })
})
