import { describe, test, expect, beforeAll } from "bun:test"
import { checkModelCompatibility, assertCompatibleModelSlot } from "./model-options.ts"
import { setProvider } from "./agent/index.ts"
import { MockProvider } from "./agent/mock-provider.ts"

describe("checkModelCompatibility", () => {
  beforeAll(() => {
    setProvider("opencode", new MockProvider([], { authenticated: true, account: {} }, [
      { provider: "opencode", model: "zhipu/glm-5.1", label: "GLM 5.1", isDefault: true },
      { provider: "opencode", model: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet" },
    ]))
  })

  test("rejects opencode model without provider/model format but still lists available models", async () => {
    const result = await checkModelCompatibility(
      { provider: "opencode", model: "glm-5.1", effort: "high" },
      "/tmp",
    )
    expect(result.compatible).toBe(false)
    expect(result.availableModels).toContain("zhipu/glm-5.1")
    expect(result.defaultModel).toBe("zhipu/glm-5.1")
  })

  test("accepts opencode model with provider/model format", async () => {
    const result = await checkModelCompatibility(
      { provider: "opencode", model: "zhipu/glm-5.1", effort: "high" },
      "/tmp",
    )
    expect(result.compatible).toBe(true)
  })

  test("assertCompatibleModelSlot throws with format hint for opencode", async () => {
    await expect(
      assertCompatibleModelSlot(
        { provider: "opencode", model: "glm-5.1", effort: "high" },
        "/tmp",
      ),
    ).rejects.toThrow("provider/model")
  })
})
