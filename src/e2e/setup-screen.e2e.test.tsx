import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { SetupScreen } from "../screens/SetupScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"
import type { AgentEvent } from "../lib/agent/types.ts"

const MODEL = DEFAULT_CONFIG.executionModel

/** Realistic agent event sequence for a setup conversation. */
const SETUP_EVENTS: AgentEvent[] = [
  { type: "text_delta", text: "I'll analyze your codebase " },
  { type: "text_delta", text: "to find optimization opportunities.\n\n" },
  { type: "tool_use", tool: "Glob", input: { pattern: "**/*.ts" } },
  { type: "tool_use", tool: "Read", input: { file_path: "/tmp/test/package.json" } },
  { type: "text_delta", text: "Based on my analysis, here are some suggestions:\n\n" },
  { type: "text_delta", text: "1. **Bundle size** - Your build output could be reduced\n" },
  { type: "text_delta", text: "2. **API latency** - Several endpoints are slow\n" },
  {
    type: "assistant_complete",
    text: "I'll analyze your codebase to find optimization opportunities.\n\nBased on my analysis, here are some suggestions:\n\n1. **Bundle size** - Your build output could be reduced\n2. **API latency** - Several endpoints are slow",
  },
  {
    type: "result",
    success: true,
    cost: {
      total_cost_usd: 0.03,
      duration_ms: 5000,
      duration_api_ms: 4000,
      num_turns: 1,
      input_tokens: 1500,
      output_tokens: 200,
    },
  },
]

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders(SETUP_EVENTS)
  fixture = await createTestFixture()
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

afterAll(async () => {
  await fixture.cleanup()
})

function renderSetup(navigateFn: (s: Screen) => void = () => {}) {
  return renderTui(
    <SetupScreen
      cwd={fixture.cwd}
      navigate={navigateFn}
      modelConfig={MODEL}
    />,
  )
}

describe("SetupScreen E2E", () => {
  test("shows mode chooser on initial render", async () => {
    harness = await renderSetup()
    const frame = await harness.frame()
    expect(frame).toContain("New Program")
    expect(frame).toContain("Analyze my codebase")
    expect(frame).toContain("I know what I want")
  })

  test("selecting 'Analyze' shows scope input", async () => {
    harness = await renderSetup()
    await harness.frame()
    await harness.enter()
    const frame = await harness.waitForText("focus")
    expect(frame).toContain("area")
  })

  test("selecting 'I know what I want' goes to chat", async () => {
    harness = await renderSetup()
    await harness.frame()
    await harness.press("j")
    await harness.enter()
    await harness.waitForText("Setup", 3000)
  })

  test("Escape from chooser navigates home", async () => {
    let lastNav: Screen | null = null
    harness = await renderSetup((s) => { lastNav = s })
    await harness.frame()
    await harness.escape()
    expect(lastNav).toBe("home")
  })

  test("scope input submits and enters chat mode", async () => {
    harness = await renderSetup()
    await harness.frame()
    await harness.enter()
    await harness.waitForText("area", 2000)
    await harness.type("API server")
    await harness.enter()
    await harness.waitForText("Setup", 3000)
  })

  test("chat mode streams agent responses", async () => {
    harness = await renderSetup()
    await harness.frame()
    await harness.press("j")
    await harness.enter()
    await harness.waitForText("Setup", 3000)
    const frame = await harness.waitForText("optimization", 5000)
    expect(frame).toContain("Bundle size")
  })
})
