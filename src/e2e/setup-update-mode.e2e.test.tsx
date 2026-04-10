import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { SetupScreen } from "../screens/SetupScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"
import type { AgentEvent } from "../lib/agent/types.ts"

const MODEL = DEFAULT_CONFIG.executionModel

const SETUP_EVENTS: AgentEvent[] = [
  { type: "text_delta", text: "I'll review the current config " },
  { type: "text_delta", text: "and suggest improvements.\n\n" },
  { type: "text_delta", text: "Here's what I found:\n" },
  {
    type: "assistant_complete",
    text: "I'll review the current config and suggest improvements.\n\nHere's what I found:\n",
  },
  {
    type: "result",
    success: true,
    cost: { total_cost_usd: 0.02, duration_ms: 3000, duration_api_ms: 2000, num_turns: 1, input_tokens: 1000, output_tokens: 150 },
  },
]

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders(SETUP_EVENTS)
  fixture = await createTestFixture()
  await fixture.createProgram("perf-opt", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 20,
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

describe("SetupScreen — update mode", () => {
  test("update mode skips chooser and shows update title", async () => {
    harness = await renderTui(
      <SetupScreen
        cwd={fixture.cwd}
        navigate={noop}
        modelConfig={MODEL}
        programSlug="perf-opt"
      />,
    )
    const frame = await harness.flush(200)
    // Should NOT show the mode chooser
    expect(frame).not.toContain("Analyze my codebase")
    expect(frame).not.toContain("I know what I want")
  })

  test("update mode shows program context loading", async () => {
    harness = await renderTui(
      <SetupScreen
        cwd={fixture.cwd}
        navigate={noop}
        modelConfig={MODEL}
        programSlug="perf-opt"
      />,
    )
    // Should show loading or the update title while loading context
    const frame = await harness.flush(500)
    expect(frame).toContain("perf-opt")
  })
})

describe("SetupScreen — draft resume", () => {
  test("draft resume enters chat mode", async () => {
    await fixture.createDraft("resume-test", {
      type: "setup",
      mode: "chat",
      messages: [
        { role: "user", content: "optimize bundle size" },
        { role: "assistant", content: "I'll analyze your bundle." },
      ],
    })

    harness = await renderTui(
      <SetupScreen
        cwd={fixture.cwd}
        navigate={noop}
        modelConfig={MODEL}
        draftName="resume-test"
      />,
    )
    // Should show chat mode, not the chooser
    const frame = await harness.flush(500)
    expect(frame).not.toContain("Analyze my codebase")
  })
})
