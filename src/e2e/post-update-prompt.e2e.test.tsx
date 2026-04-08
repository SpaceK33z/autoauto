import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { PostUpdatePrompt } from "../components/PostUpdatePrompt.tsx"

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("PostUpdatePrompt E2E", () => {
  test("displays program name and both options", async () => {
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => {}}
        onGoHome={() => {}}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Program Updated")
    expect(frame).toContain("Program updated")
    expect(frame).toContain("perf-bench")
    expect(frame).toContain("Start a new run")
    expect(frame).toContain("Go back to home")
  })

  test("Enter on default selection triggers start run", async () => {
    let started = false
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => { started = true }}
        onGoHome={() => {}}
      />,
    )
    await harness.frame()
    await harness.enter()
    expect(started).toBe(true)
  })

  test("j then Enter triggers go home", async () => {
    let wentHome = false
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => {}}
        onGoHome={() => { wentHome = true }}
      />,
    )
    await harness.frame()
    await harness.press("j")
    await harness.enter()
    expect(wentHome).toBe(true)
  })

  test("k after j navigates back to start run", async () => {
    let started = false
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => { started = true }}
        onGoHome={() => {}}
      />,
    )
    await harness.frame()
    await harness.press("j")
    await harness.press("k")
    await harness.enter()
    expect(started).toBe(true)
  })

  test("Escape triggers go home", async () => {
    let wentHome = false
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => {}}
        onGoHome={() => { wentHome = true }}
      />,
    )
    await harness.frame()
    await harness.escape()
    expect(wentHome).toBe(true)
  })

  test("arrow down also navigates to second option", async () => {
    let wentHome = false
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => {}}
        onGoHome={() => { wentHome = true }}
      />,
    )
    await harness.frame()
    await harness.arrow("down")
    await harness.enter()
    expect(wentHome).toBe(true)
  })

  test("arrow up navigates back to first option", async () => {
    let started = false
    harness = await renderTui(
      <PostUpdatePrompt
        programSlug="perf-bench"
        onStartRun={() => { started = true }}
        onGoHome={() => {}}
      />,
    )
    await harness.frame()
    await harness.arrow("down")
    await harness.arrow("up")
    await harness.enter()
    expect(started).toBe(true)
  })
})
