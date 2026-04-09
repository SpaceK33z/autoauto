import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { estimateCodexUsageCostUsd, resolveCodexCostContext } from "./codex-cost.ts"

const ORIGINAL_HOME = process.env.HOME

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = ORIGINAL_HOME
  }
})

async function createCodexHomeFixture(): Promise<{
  cleanup: () => Promise<void>
  homeDir: string
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "autoauto-codex-home-"))
  await mkdir(join(homeDir, ".codex"), { recursive: true })
  return {
    homeDir,
    cleanup: async () => {
      await rm(homeDir, { recursive: true, force: true })
    },
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

describe("estimateCodexUsageCostUsd", () => {
  test("prices cached and uncached input separately", () => {
    const total = estimateCodexUsageCostUsd(
      {
        input_tokens: 1_200,
        cached_input_tokens: 200,
        output_tokens: 500,
      },
      {
        inputUsdPerMillion: 2.5,
        cachedInputUsdPerMillion: 0.25,
        outputUsdPerMillion: 15,
      },
    )

    expect(total).toBeCloseTo(0.01005, 8)
  })
})

describe("resolveCodexCostContext", () => {
  test("computes OpenAI API pricing context for API-key auth", async () => {
    const fixture = await createCodexHomeFixture()
    process.env.HOME = fixture.homeDir
    await ensureDir(join(fixture.homeDir, ".codex"))
    await Bun.write(
      join(fixture.homeDir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "api" }),
    )
    await Bun.write(
      join(fixture.homeDir, ".codex", "config.toml"),
      'model = "gpt-5.4"\n',
    )

    try {
      const context = await resolveCodexCostContext({})
      expect(context.authMode).toBe("api")
      expect(context.model).toBe("gpt-5.4")
      expect(context.modelProvider).toBe("openai")
      expect(context.pricing).toEqual({
        inputUsdPerMillion: 2.5,
        cachedInputUsdPerMillion: 0.25,
        outputUsdPerMillion: 15,
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("uses OpenAI-equivalent token pricing for ChatGPT auth", async () => {
    const fixture = await createCodexHomeFixture()
    process.env.HOME = fixture.homeDir
    await ensureDir(join(fixture.homeDir, ".codex"))
    await Bun.write(
      join(fixture.homeDir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt" }),
    )
    await Bun.write(
      join(fixture.homeDir, ".codex", "config.toml"),
      'model = "gpt-5.4"\n',
    )

    try {
      const context = await resolveCodexCostContext({})
      expect(context.authMode).toBe("chatgpt")
      expect(context.model).toBe("gpt-5.4")
      expect(context.pricing).toEqual({
        inputUsdPerMillion: 2.5,
        cachedInputUsdPerMillion: 0.25,
        outputUsdPerMillion: 15,
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("disables OpenAI pricing for custom model providers", async () => {
    const fixture = await createCodexHomeFixture()
    process.env.HOME = fixture.homeDir
    await ensureDir(join(fixture.homeDir, ".codex"))
    await Bun.write(
      join(fixture.homeDir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "api" }),
    )
    await Bun.write(
      join(fixture.homeDir, ".codex", "config.toml"),
      ['profile = "azure"', '', '[profiles.azure]', 'model_provider = "azure"', 'model = "gpt-5.4"'].join("\n"),
    )

    try {
      const context = await resolveCodexCostContext({})
      expect(context.authMode).toBe("api")
      expect(context.modelProvider).toBe("azure")
      expect(context.pricing).toBeNull()
    } finally {
      await fixture.cleanup()
    }
  })

  test("uses explicit session model over Codex default model", async () => {
    const fixture = await createCodexHomeFixture()
    process.env.HOME = fixture.homeDir
    await ensureDir(join(fixture.homeDir, ".codex"))
    await Bun.write(
      join(fixture.homeDir, ".codex", "auth.json"),
      JSON.stringify({ auth_mode: "api" }),
    )
    await Bun.write(
      join(fixture.homeDir, ".codex", "config.toml"),
      'model = "gpt-5.4"\n',
    )

    try {
      const context = await resolveCodexCostContext({ model: "gpt-5.4-mini" })
      expect(context.model).toBe("gpt-5.4-mini")
      expect(context.pricing).toEqual({
        inputUsdPerMillion: 0.75,
        cachedInputUsdPerMillion: 0.075,
        outputUsdPerMillion: 4.5,
      })
    } finally {
      await fixture.cleanup()
    }
  })
})
