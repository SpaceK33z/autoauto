/**
 * E2E test helpers: wraps testRender with convenience methods for
 * navigating the AutoAuto TUI, sending keystrokes, and reading frames.
 */

import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

type TestSetup = Awaited<ReturnType<typeof testRender>>

export interface TuiHarness {
  /** The underlying OpenTUI test setup */
  setup: TestSetup
  /** Render one frame and return the captured text */
  frame: () => Promise<string>
  /** Press a single key and render */
  press: (key: string) => Promise<void>
  /** Press Enter and render */
  enter: () => Promise<void>
  /** Press Escape and render */
  escape: () => Promise<void>
  /** Press Tab and render */
  tab: () => Promise<void>
  /** Type a string of characters one-by-one and render */
  type: (text: string) => Promise<void>
  /** Press arrow key: "up" | "down" | "left" | "right" */
  arrow: (dir: "up" | "down" | "left" | "right") => Promise<void>
  /** Wait for a frame containing the given text (with timeout) */
  waitForText: (text: string, timeoutMs?: number) => Promise<string>
  /** Destroy the renderer (call in afterEach) */
  destroy: () => Promise<void>
}

const ARROW_SEQUENCES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
}

export async function renderTui(
  element: React.JSX.Element,
  options?: { width?: number; height?: number },
): Promise<TuiHarness> {
  const setup = await testRender(element, {
    width: options?.width ?? 120,
    height: options?.height ?? 30,
    useKittyKeyboard: {},
  })

  // Initial render
  await act(async () => {
    await setup.renderOnce()
  })

  async function frame(): Promise<string> {
    await act(async () => {
      await setup.renderOnce()
    })
    return setup.captureCharFrame()
  }

  async function press(key: string): Promise<void> {
    await act(async () => {
      await setup.mockInput.pressKeys([key])
      await setup.renderOnce()
    })
  }

  async function enter(): Promise<void> {
    await press("\r")
  }

  async function escape(): Promise<void> {
    await press("\x1b")
  }

  async function tab(): Promise<void> {
    await press("\t")
  }

  async function type(text: string): Promise<void> {
    for (const char of text) {
      await press(char)
    }
  }

  async function arrow(dir: "up" | "down" | "left" | "right"): Promise<void> {
    await press(ARROW_SEQUENCES[dir])
  }

  async function waitForText(text: string, timeoutMs = 5000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // Flush pending React state updates (from async useEffect callbacks)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50))
        await setup.renderOnce()
      })
      const output = setup.captureCharFrame()
      if (output.includes(text)) return output
    }
    const lastFrame = setup.captureCharFrame()
    throw new Error(
      `Timed out waiting for "${text}" after ${timeoutMs}ms.\nLast frame:\n${lastFrame}`,
    )
  }

  async function destroy(): Promise<void> {
    await act(async () => {
      setup.renderer.destroy()
    })
  }

  return { setup, frame, press, enter, escape, tab, type, arrow, waitForText, destroy }
}
