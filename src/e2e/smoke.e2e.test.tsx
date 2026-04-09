import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy()
    })
    testSetup = null
  }
})

describe("Smoke test", () => {
  test("renders a basic box with text", async () => {
    testSetup = await testRender(
      <box flexDirection="column" width={80} height={10}>
        <text>Hello E2E</text>
      </box>,
      { width: 80, height: 10, useKittyKeyboard: {} },
    )

    await act(async () => {
      await testSetup?.renderOnce()
    })

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("Hello E2E")
  })
})
