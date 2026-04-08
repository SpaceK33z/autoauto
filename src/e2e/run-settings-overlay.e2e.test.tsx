import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { RunSettingsOverlay } from "../components/RunSettingsOverlay.tsx"

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("RunSettingsOverlay E2E", () => {
  test("displays current max experiments value", async () => {
    harness = await renderTui(
      <RunSettingsOverlay
        maxExpText="25"
        experimentNumber={10}
        validationError={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Run Settings")
    expect(frame).toContain("Max Experiments: 25")
    expect(frame).toContain("10 of 25 done")
  })

  test("shows progress for partially completed run", async () => {
    harness = await renderTui(
      <RunSettingsOverlay
        maxExpText="50"
        experimentNumber={33}
        validationError={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("33 of 50 done")
  })

  test("shows validation error when input is invalid", async () => {
    harness = await renderTui(
      <RunSettingsOverlay
        maxExpText="abc"
        experimentNumber={5}
        validationError="Must be a positive number"
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Must be a positive number")
  })

  test("shows help text when no error", async () => {
    harness = await renderTui(
      <RunSettingsOverlay
        maxExpText="20"
        experimentNumber={8}
        validationError={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Type a number to set the experiment limit")
  })

  test("shows escape hint", async () => {
    harness = await renderTui(
      <RunSettingsOverlay
        maxExpText="15"
        experimentNumber={3}
        validationError={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Esc: close")
  })

  test("hides progress when text is not a valid number", async () => {
    harness = await renderTui(
      <RunSettingsOverlay
        maxExpText=""
        experimentNumber={5}
        validationError={null}
      />,
    )
    const frame = await harness.frame()
    expect(frame).toContain("Max Experiments:")
    expect(frame).not.toContain("of")
    expect(frame).not.toContain("done")
  })
})
