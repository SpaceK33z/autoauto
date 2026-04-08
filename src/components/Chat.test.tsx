import { afterEach, describe, expect, test } from "bun:test"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { Chat } from "./Chat.tsx"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"

let testSetup: Awaited<ReturnType<typeof testRender>> | null = null

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup?.renderer.destroy()
    })
    testSetup = null
  }
})

function findTextarea(renderable: Renderable): TextareaRenderable | null {
  if (renderable instanceof TextareaRenderable) return renderable
  for (const child of renderable.getChildren()) {
    const textarea = findTextarea(child)
    if (textarea) return textarea
  }
  return null
}

async function pressRaw(sequence: string): Promise<void> {
  await act(async () => {
    await testSetup?.mockInput.pressKeys([sequence])
    await testSetup?.renderOnce()
  })
}

describe("Chat", () => {
  test("expands textarea after Shift+Enter newline", async () => {
    setProvider("claude", new MockProvider([]))
    testSetup = await testRender(<Chat provider="claude" />, {
      width: 80,
      height: 20,
      useKittyKeyboard: {},
    })

    await act(async () => {
      await testSetup?.renderOnce()
    })

    const textarea = findTextarea(testSetup.renderer.root)
    expect(textarea).not.toBeNull()

    await pressRaw("h")
    await pressRaw("e")
    await pressRaw("l")
    await pressRaw("l")
    await pressRaw("o")
    await pressRaw("\x1b[13;2u")
    await pressRaw("w")
    await pressRaw("o")
    await pressRaw("r")
    await pressRaw("l")
    await pressRaw("d")

    expect(textarea!.plainText).toBe("hello\nworld")
    expect(textarea!.height).toBe(2)

    const frame = testSetup.captureCharFrame()
    expect(frame).toContain("hello")
    expect(frame).toContain("world")
  })
})
