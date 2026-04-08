import { afterEach, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { AuthErrorScreen } from "../screens/AuthErrorScreen.tsx"

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
})

describe("AuthErrorScreen E2E", () => {
  test("displays authentication required message", async () => {
    harness = await renderTui(<AuthErrorScreen error="API key invalid" />)
    const frame = await harness.frame()
    expect(frame).toContain("Authentication required")
    expect(frame).toContain("API key invalid")
  })

  test("shows setup instructions", async () => {
    harness = await renderTui(<AuthErrorScreen error="" />)
    const frame = await harness.frame()
    expect(frame).toContain("claude login")
    expect(frame).toContain("claude setup-token")
    expect(frame).toContain("restart AutoAuto")
  })
})
