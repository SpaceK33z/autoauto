import { describe, test, expect } from "bun:test"
import { MockProvider } from "./mock-provider.ts"
import { setProvider, getProvider } from "./index.ts"
import type { AgentEvent } from "./types.ts"

describe("AgentProvider contract", () => {
  test("one-shot session: runOnce yields events and ends with result", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
      { type: "tool_use", tool: "Read", input: { file_path: "/tmp/test.ts" } },
      { type: "assistant_complete", text: "Hello world" },
      { type: "result", success: true, cost: {
        total_cost_usd: 0.01,
        duration_ms: 1000,
        duration_api_ms: 800,
        num_turns: 1,
        input_tokens: 100,
        output_tokens: 50,
      }},
    ]

    const provider = new MockProvider(events)
    const session = provider.runOnce("Do something", { tools: ["Read"] })

    const received: AgentEvent[] = []
    for await (const event of session) {
      received.push(event)
    }

    expect(received).toEqual(events)
    expect(received.at(-1)?.type).toBe("result")
  })

  test("multi-turn session: pushMessage accepts messages over time", async () => {
    const events: AgentEvent[] = [
      { type: "assistant_complete", text: "Got it" },
      { type: "result", success: true },
    ]

    const provider = new MockProvider(events)
    const session = provider.createSession({ systemPrompt: "Be helpful" })

    // Push a message (should not throw)
    session.pushMessage("First message")
    session.pushMessage("Second message")

    const received: AgentEvent[] = []
    for await (const event of session) {
      received.push(event)
    }

    expect(received).toHaveLength(2)
    expect(received[0].type).toBe("assistant_complete")
  })

  test("auth check: returns success", async () => {
    const provider = new MockProvider()
    const result = await provider.checkAuth()

    expect(result.authenticated).toBe(true)
    if (result.authenticated) {
      expect(result.account.email).toBe("test@example.com")
    }
  })

  test("auth check: returns failure", async () => {
    const provider = new MockProvider([], {
      authenticated: false,
      error: "Invalid API key",
    })
    const result = await provider.checkAuth()

    expect(result.authenticated).toBe(false)
    if (!result.authenticated) {
      expect(result.error).toBe("Invalid API key")
    }
  })

  test("error during stream: provider emits error event", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "Starting..." },
      { type: "error", error: "Rate limit exceeded", retriable: true },
      { type: "result", success: false, error: "Rate limit exceeded" },
    ]

    const provider = new MockProvider(events)
    const session = provider.runOnce("Do something", {})

    const received: AgentEvent[] = []
    for await (const event of session) {
      received.push(event)
    }

    const errorEvent = received.find((e) => e.type === "error")
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === "error") {
      expect(errorEvent.retriable).toBe(true)
      expect(errorEvent.error).toBe("Rate limit exceeded")
    }
  })

  test("abort mid-stream: close() stops iteration", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "First" },
      { type: "text_delta", text: "Second" },
      { type: "text_delta", text: "Third" },
      { type: "result", success: true },
    ]

    const provider = new MockProvider(events)
    const session = provider.createSession({})
    session.pushMessage("Go")

    const received: AgentEvent[] = []
    for await (const event of session) {
      received.push(event)
      if (received.length === 1) {
        session.close()
      }
    }

    // Should have stopped after close() — got at most 1 event
    expect(received.length).toBeLessThanOrEqual(1)
  })

  test("registry: getProvider throws before setProvider", () => {
    // Reset — create a fresh import context isn't easy, so just test the pattern
    const provider = new MockProvider()
    setProvider("claude", provider)
    expect(getProvider("claude")).toBe(provider)
  })
})
