import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "./types.ts"
import { OpenCodeProvider } from "./opencode-provider.ts"

function emptyEventStream(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {},
  }
}

describe("OpenCodeProvider", () => {
  test("surfaces parseModel error as error + failed result events", async () => {
    const fakeClient = {
      session: {
        create: async () => ({ data: { id: "ses_root" } }),
        prompt: async () => { throw new Error("should not reach prompt") },
        abort: async () => {},
      },
      event: {
        subscribe: async () => ({ stream: emptyEventStream() }),
      },
    }

    const provider = new OpenCodeProvider()
    ;(provider as OpenCodeProvider & { getInstance: () => Promise<unknown> }).getInstance = async () => ({
      client: fakeClient,
      server: { close() {} },
    })

    // "glm-5.1" has no slash — parseModel should throw, and the error should surface
    const session = provider.runOnce("test prompt", { cwd: "/tmp/project", model: "glm-5.1" })
    const events: AgentEvent[] = []
    for await (const event of session) {
      events.push(event)
    }

    const errorEvent = events.find((e) => e.type === "error")
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === "error") {
      expect(errorEvent.error).toContain("provider/model")
    }

    const resultEvent = events.find((e) => e.type === "result")
    expect(resultEvent).toBeDefined()
    if (resultEvent?.type === "result") {
      expect(resultEvent.success).toBe(false)
    }
  })

  test("aggregates child-session cost for a completed prompt", async () => {
    let prompted = false

    const rootAssistant = {
      id: "msg_root",
      sessionID: "ses_root",
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg_user_root",
      modelID: "gpt-test",
      providerID: "openai",
      mode: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0.01,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    }

    const childAssistant = {
      id: "msg_child",
      sessionID: "ses_child",
      role: "assistant",
      time: { created: 3, completed: 4 },
      parentID: "msg_user_child",
      modelID: "gpt-test",
      providerID: "openai",
      mode: "explore",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0.04,
      tokens: {
        input: 300,
        output: 150,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    }

    const fakeClient = {
      session: {
        create: async () => ({
          data: { id: "ses_root" },
        }),
        prompt: async () => {
          prompted = true
          return {
            data: {
              info: rootAssistant,
              parts: [{ type: "text", text: "Done" }],
            },
          }
        },
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: !prompted
            ? []
            : sessionID === "ses_root"
              ? [{ info: rootAssistant, parts: [] }]
              : [{ info: childAssistant, parts: [] }],
        }),
        children: async ({ sessionID }: { sessionID: string }) => ({
          data: !prompted || sessionID !== "ses_root"
            ? []
            : [{
              id: "ses_child",
              slug: "child",
              projectID: "proj",
              directory: "/tmp/project",
              title: "child",
              version: "1.0.0",
              time: { created: 1, updated: 2 },
              parentID: "ses_root",
            }],
        }),
        abort: async () => {},
      },
      event: {
        subscribe: async () => ({ stream: emptyEventStream() }),
      },
    }

    const provider = new OpenCodeProvider()
    ;(provider as OpenCodeProvider & { getInstance: () => Promise<unknown> }).getInstance = async () => ({
      client: fakeClient,
      server: { close() {} },
    })

    const session = provider.runOnce("check cost", { cwd: "/tmp/project" })
    const events: AgentEvent[] = []
    for await (const event of session) {
      events.push(event)
    }

    const result = events.find((event) => event.type === "result")
    expect(result).toBeDefined()
    expect(events.find((event) => event.type === "assistant_complete")).toEqual({
      type: "assistant_complete",
      text: "Done",
    })
    if (result?.type !== "result") return

    expect(result.success).toBe(true)
    expect(result.cost?.total_cost_usd).toBe(0.05)
    expect(result.cost?.input_tokens).toBe(400)
    expect(result.cost?.output_tokens).toBe(200)
    expect(result.cost?.num_turns).toBe(2)
  })
})
