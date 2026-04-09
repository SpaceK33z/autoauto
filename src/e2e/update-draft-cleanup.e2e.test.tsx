import { useState } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import { PostUpdatePrompt } from "../components/PostUpdatePrompt.tsx"
import { resetProjectRoot } from "../lib/programs.ts"
import { listDrafts, deleteDraft } from "../lib/drafts.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  fixture = await createTestFixture()
  await fixture.createProgram("my-program", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 10,
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

/**
 * Wrapper that mimics App's update-mode exit flow:
 * PostUpdatePrompt → Go home → HomeScreen (with draft cleanup).
 *
 * This mirrors the logic in App.tsx where PostUpdatePrompt's onGoHome/onStartRun
 * must delete the update draft before navigating to the home screen.
 */
function PostUpdateToHome({ cwd, programSlug, draftName }: {
  cwd: string
  programSlug: string
  draftName: string | null
}) {
  const [screen, setScreen] = useState<"post-update" | "home">("post-update")

  if (screen === "post-update") {
    return (
      <PostUpdatePrompt
        programSlug={programSlug}
        onStartRun={() => {
          if (draftName) deleteDraft(cwd, draftName).catch(() => {})
          setScreen("home")
        }}
        onGoHome={() => {
          if (draftName) deleteDraft(cwd, draftName).catch(() => {})
          setScreen("home")
        }}
      />
    )
  }

  return (
    <HomeScreen
      cwd={cwd}
      navigate={noop}
      onSelectProgram={noop}
      onSelectRun={noop}
      onUpdateProgram={noop}
      onFinalizeRun={noop}
      onResumeDraft={noop}
    />
  )
}

describe("Update draft cleanup — PostUpdatePrompt", () => {
  test("update draft is shown on home screen before cleanup", async () => {
    await fixture.createDraft("my-program", {
      type: "update",
      programSlug: "my-program",
      mode: "chat",
      messages: [{ role: "user", content: "fix measurement" }],
    })

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
    const frame = await harness.waitForText("my-program (draft)")
    expect(frame).toContain("my-program (draft)")
  })

  test("Go home from PostUpdatePrompt deletes update draft", async () => {
    await fixture.createDraft("my-program", {
      type: "update",
      programSlug: "my-program",
      mode: "chat",
      messages: [{ role: "user", content: "fix measurement" }],
    })

    // Verify draft exists
    const before = await listDrafts(fixture.cwd)
    expect(before.length).toBe(1)

    harness = await renderTui(
      <PostUpdateToHome
        cwd={fixture.cwd}
        programSlug="my-program"
        draftName="my-program"
      />,
      { width: 120 },
    )

    // PostUpdatePrompt is shown
    await harness.waitForText("Program Updated")

    // Select "Go back to home" (j to move down, Enter to select)
    await harness.press("j")
    await harness.enter()

    // Should transition to HomeScreen without the draft
    const frame = await harness.waitForText("my-program")
    expect(frame).not.toContain("(draft)")

    // Verify draft file was actually deleted from disk
    const after = await listDrafts(fixture.cwd)
    expect(after.length).toBe(0)
  })

  test("Start run from PostUpdatePrompt also deletes update draft", async () => {
    await fixture.createDraft("my-program", {
      type: "update",
      programSlug: "my-program",
      mode: "chat",
      messages: [{ role: "user", content: "fix measurement" }],
    })

    harness = await renderTui(
      <PostUpdateToHome
        cwd={fixture.cwd}
        programSlug="my-program"
        draftName="my-program"
      />,
      { width: 120 },
    )

    await harness.waitForText("Program Updated")

    // "Start a new run" is the default selection — just press Enter
    await harness.enter()

    // Wait for HomeScreen to render (gives deleteDraft time to complete)
    await harness.waitForText("my-program")

    // Draft should be deleted from disk
    const after = await listDrafts(fixture.cwd)
    expect(after.length).toBe(0)
  })
})
