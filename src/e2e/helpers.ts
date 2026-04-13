/**
 * E2E test helpers: wraps testRender with convenience methods for
 * navigating the AutoAuto TUI, sending keystrokes, and reading frames.
 */

import { testRender } from "@opentui/react/test-utils"
import { act } from "react"

export const noop = () => {}

// Bun runs multiple test files concurrently. OpenTUI's renderer uses React act(),
// which is process-global and cannot overlap across concurrent harnesses.
let actQueue = Promise.resolve()

function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = actQueue.then(fn, fn)
  actQueue = run.then(() => undefined, () => undefined)
  return run
}

export interface TuiHarness {
  /** Render one frame and return the captured text */
  frame: () => Promise<string>
  /** Wait for async effects to settle, then render and return frame */
  flush: (ms?: number) => Promise<string>
  /** Press a single key and render */
  press: (key: string) => Promise<void>
  /** Press Enter and render */
  enter: () => Promise<void>
  /** Press Escape and render */
  escape: () => Promise<void>
  /** Press Tab and render */
  tab: () => Promise<void>
  /** Press Backspace and render */
  backspace: () => Promise<void>
  /** Type a string of characters one-by-one and render */
  type: (text: string) => Promise<void>
  /** Press arrow key: "up" | "down" | "left" | "right" */
  arrow: (dir: "up" | "down" | "left" | "right") => Promise<void>
  /** Click at a specific (x, y) position and render */
  click: (x: number, y: number) => Promise<void>
  /** Wait for a frame containing the given text (with timeout) */
  waitForText: (text: string, timeoutMs?: number) => Promise<string>
  /** Destroy the renderer (call in afterEach) */
  destroy: () => Promise<void>
}

export async function renderTui(
  element: React.JSX.Element,
  options?: { width?: number; height?: number },
): Promise<TuiHarness> {
  const setup = await runSerialized(async () => {
    const rendered = await testRender(element, {
      width: options?.width ?? 120,
      height: options?.height ?? 30,
      useKittyKeyboard: {},
    })

    // Initial render
    await act(async () => {
      await rendered.renderOnce()
    })

    return rendered
  })

  async function frame(): Promise<string> {
    return runSerialized(async () => {
      await act(async () => {
        await setup.renderOnce()
      })
      return setup.captureCharFrame()
    })
  }

  async function flush(ms = 100): Promise<string> {
    return runSerialized(async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, ms))
        await setup.renderOnce()
      })
      return setup.captureCharFrame()
    })
  }

  async function press(key: string): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        await setup.mockInput.pressKeys([key])
        await setup.renderOnce()
      })
    })
  }

  async function enter(): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        setup.mockInput.pressEnter()
        await setup.renderOnce()
      })
    })
  }

  async function escape(): Promise<void> {
    // Use CSI u encoding for escape — \x1b[27u — which is reliably parsed
    // in Kitty keyboard mode without ambiguous timeout handling.
    await runSerialized(async () => {
      await act(async () => {
        await setup.mockInput.pressKeys(["\x1b[27u"])
        await setup.renderOnce()
      })
    })
  }

  async function tab(): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        setup.mockInput.pressTab()
        await setup.renderOnce()
      })
    })
  }

  async function backspace(): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        setup.mockInput.pressBackspace()
        await setup.renderOnce()
      })
    })
  }

  async function type(text: string): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        await setup.mockInput.typeText(text)
        await setup.renderOnce()
      })
    })
  }

  async function arrow(dir: "up" | "down" | "left" | "right"): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        setup.mockInput.pressArrow(dir)
        await setup.renderOnce()
      })
    })
  }

  async function click(x: number, y: number): Promise<void> {
    await runSerialized(async () => {
      await act(async () => {
        await setup.mockMouse.click(x, y)
        await setup.renderOnce()
      })
    })
  }

  async function waitForText(text: string, timeoutMs = 5000): Promise<string> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // Flush pending React state updates (from async useEffect callbacks)
      await runSerialized(async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 50))
          await setup.renderOnce()
        })
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
    await runSerialized(async () => {
      await act(async () => {
        setup.renderer.destroy()
      })
    })
  }

  return { frame, flush, press, enter, escape, tab, backspace, type, arrow, click, waitForText, destroy }
}
