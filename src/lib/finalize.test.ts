import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { setProvider } from "./agent/index.ts"
import type { AgentEvent, AgentProvider, AgentSession, AgentSessionConfig, AuthResult } from "./agent/types.ts"
import { MockProvider } from "./agent/mock-provider.ts"
import { extractFinalizeGroups, refineFinalizeGroups, runFinalizeReview, validateGroups } from "./finalize.ts"
import type { ModelSlot } from "./config.ts"
import type { ProgramConfig } from "./programs.ts"
import type { RunState } from "./run.ts"

const TEST_MODEL: ModelSlot = { provider: "claude", model: "test-model", effort: "low" }

const TEST_CONFIG: ProgramConfig = {
  metric_field: "runtime_ms",
  direction: "lower",
  noise_threshold: 0.01,
  repeats: 1,
  quality_gates: {},
  max_experiments: 5,
}

class ScriptedProvider implements AgentProvider {
  readonly name = "scripted"

  constructor(
    private readonly events: AgentEvent[],
    private readonly onRun?: (config: AgentSessionConfig) => Promise<void> | void,
  ) {}

  createSession(config: AgentSessionConfig): AgentSession {
    return new ScriptedSession(this.events, this.onRun, config)
  }

  runOnce(_prompt: string, config: AgentSessionConfig): AgentSession {
    return this.createSession(config)
  }

  async checkAuth(): Promise<AuthResult> {
    return { authenticated: true, account: { email: "test@example.com" } }
  }
}

class ScriptedSession implements AgentSession {
  readonly sessionId = "test-session"
  private closed = false

  constructor(
    private readonly events: AgentEvent[],
    private readonly onRun: ((config: AgentSessionConfig) => Promise<void> | void) | undefined,
    private readonly config: AgentSessionConfig,
  ) {}

  pushMessage(): void {}

  endInput(): void {}

  close(): void {
    this.closed = true
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    await this.onRun?.(this.config)
    for (const event of this.events) {
      if (this.closed) break
      yield event
    }
  }
}

async function createFinalizeFixture(): Promise<{
  cleanup: () => Promise<void>
  projectRoot: string
  runDir: string
  state: RunState
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "autoauto-finalize-project-"))
  const runDir = await mkdtemp(join(tmpdir(), "autoauto-finalize-run-"))

  await $`git init`.cwd(projectRoot).quiet()
  await $`git config user.name "AutoAuto Test"`.cwd(projectRoot).quiet()
  await $`git config user.email "test@example.com"`.cwd(projectRoot).quiet()

  await Bun.write(join(projectRoot, "feature.ts"), "export const value = 1\n")
  await $`git add feature.ts`.cwd(projectRoot).quiet()
  await $`git commit -m baseline`.cwd(projectRoot).quiet()

  const baselineSha = (await $`git rev-parse HEAD`.cwd(projectRoot).text()).trim()
  const branchName = (await $`git rev-parse --abbrev-ref HEAD`.cwd(projectRoot).text()).trim()

  await Bun.write(join(projectRoot, "feature.ts"), "export const value = 2\n")
  await $`git commit -am "improve metric"`.cwd(projectRoot).quiet()

  const headSha = (await $`git rev-parse HEAD`.cwd(projectRoot).text()).trim()
  await Bun.write(
    join(runDir, "results.tsv"),
    [
      "experiment_number\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats",
      `1\t${headSha}\t90\t\tkeep\tImprove metric\t1000\t`,
    ].join("\n") + "\n",
  )

  const now = new Date().toISOString()
  const state: RunState = {
    run_id: "20260408-000000",
    program_slug: "demo",
    phase: "complete",
    experiment_number: 1,
    original_baseline: 100,
    current_baseline: 90,
    best_metric: 90,
    best_experiment: 1,
    total_keeps: 1,
    total_discards: 0,
    total_crashes: 0,
    branch_name: branchName,
    original_baseline_sha: baselineSha,
    last_known_good_sha: headSha,
    candidate_sha: null,
    started_at: now,
    updated_at: now,
    provider: "claude",
    model: TEST_MODEL.model,
    effort: TEST_MODEL.effort,
    termination_reason: "max_experiments",
    original_branch: branchName,
    error: null,
    error_phase: null,
  }

  return {
    projectRoot,
    runDir,
    state,
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true })
      await rm(runDir, { recursive: true, force: true })
    },
  }
}

describe("extractFinalizeGroups", () => {
  test("extracts valid groups", () => {
    const text = `Some review text here.
<finalize_groups>
[
  {
    "name": "lazy-load-images",
    "title": "perf(images): lazy-load below-fold images",
    "description": "Added intersection observer",
    "files": ["src/ImageLoader.tsx", "src/lazy.ts"],
    "risk": "low"
  },
  {
    "name": "remove-lodash",
    "title": "refactor: remove lodash dependency",
    "description": "Replaced with native methods",
    "files": ["package.json", "src/utils.ts"],
    "risk": "medium"
  }
]
</finalize_groups>
More text after.`

    const groups = extractFinalizeGroups(text)
    expect(groups).not.toBeNull()
    expect(groups!.length).toBe(2)
    expect(groups![0].name).toBe("lazy-load-images")
    expect(groups![0].files).toEqual(["src/ImageLoader.tsx", "src/lazy.ts"])
    expect(groups![0].risk).toBe("low")
    expect(groups![1].name).toBe("remove-lodash")
    expect(groups![1].risk).toBe("medium")
  })

  test("returns null when no XML tags present", () => {
    expect(extractFinalizeGroups("just some text without tags")).toBeNull()
  })

  test("returns null for empty array", () => {
    expect(extractFinalizeGroups("<finalize_groups>[]</finalize_groups>")).toBeNull()
  })

  test("returns null for malformed JSON", () => {
    expect(extractFinalizeGroups("<finalize_groups>{not json]</finalize_groups>")).toBeNull()
  })

  test("returns null when name is missing", () => {
    const text = `<finalize_groups>[{"title": "fix", "files": ["a.ts"]}]</finalize_groups>`
    expect(extractFinalizeGroups(text)).toBeNull()
  })

  test("returns null when files is empty", () => {
    const text = `<finalize_groups>[{"name": "a", "title": "fix", "files": []}]</finalize_groups>`
    expect(extractFinalizeGroups(text)).toBeNull()
  })

  test("normalizes group names to kebab-case", () => {
    const text = `<finalize_groups>[{"name": "My Cool Feature!", "title": "feat", "files": ["a.ts"]}]</finalize_groups>`
    const groups = extractFinalizeGroups(text)
    expect(groups![0].name).toBe("my-cool-feature")
  })

  test("defaults risk to low when invalid", () => {
    const text = `<finalize_groups>[{"name": "a", "title": "fix", "files": ["a.ts"], "risk": "extreme"}]</finalize_groups>`
    const groups = extractFinalizeGroups(text)
    expect(groups![0].risk).toBe("low")
  })

  test("defaults description to empty string when missing", () => {
    const text = `<finalize_groups>[{"name": "a", "title": "fix", "files": ["a.ts"]}]</finalize_groups>`
    const groups = extractFinalizeGroups(text)
    expect(groups![0].description).toBe("")
  })
})

describe("validateGroups", () => {
  test("validates a correct partition", () => {
    const groups = [
      { name: "a", title: "fix a", description: "", files: ["x.ts", "y.ts"], risk: "low" as const },
      { name: "b", title: "fix b", description: "", files: ["z.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts", "y.ts", "z.ts"])
    expect(result.valid).toBe(true)
  })

  test("rejects overlapping files", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
      { name: "b", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toContain("x.ts")
  })

  test("rejects when files are unassigned", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts", "y.ts"])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toContain("y.ts")
  })

  test("strips phantom files silently", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts", "phantom.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.groups[0].files).toEqual(["x.ts"])
  })

  test("removes groups left empty after phantom stripping", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
      { name: "b", title: "fix", description: "", files: ["phantom.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.groups.length).toBe(1)
  })

  test("rejects all-phantom groups", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["phantom.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts"])
    expect(result.valid).toBe(false)
  })

  test("rejects duplicate group names", () => {
    const groups = [
      { name: "a", title: "fix", description: "", files: ["x.ts"], risk: "low" as const },
      { name: "a", title: "fix", description: "", files: ["y.ts"], risk: "low" as const },
    ]
    const result = validateGroups(groups, ["x.ts", "y.ts"])
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.reason).toContain("Duplicate")
  })
})

describe("finalize agent safeguards", () => {
  test("runFinalizeReview rejects when the agent dirties the repo", async () => {
    const fixture = await createFinalizeFixture()
    setProvider("claude", new ScriptedProvider(
      [{ type: "result", success: true }],
      async (config) => {
        await Bun.write(join(config.cwd!, "rogue.txt"), "not allowed\n")
      },
    ) as AgentProvider)

    try {
      await expect(runFinalizeReview(
        fixture.projectRoot,
        fixture.runDir,
        fixture.state,
        TEST_CONFIG,
        TEST_MODEL,
        { onStreamText() {}, onToolStatus() {} },
      )).rejects.toThrow("Finalize agent modified the repository")
    } finally {
      await fixture.cleanup()
    }
  })

  test("refineFinalizeGroups rejects when the agent dirties the repo", async () => {
    const fixture = await createFinalizeFixture()
    setProvider("claude", new ScriptedProvider(
      [{ type: "result", success: true }],
      async (config) => {
        await Bun.write(join(config.cwd!, "rogue.txt"), "not allowed\n")
      },
    ) as AgentProvider)

    try {
      await expect(refineFinalizeGroups(
        "previous summary",
        "split this differently",
        ["feature.ts"],
        TEST_MODEL,
        fixture.projectRoot,
        { onStreamText() {}, onToolStatus() {} },
      )).rejects.toThrow("Finalize agent modified the repository")
    } finally {
      await fixture.cleanup()
    }
  })

  test("runFinalizeReview throws AbortError when aborted before the agent runs", async () => {
    const fixture = await createFinalizeFixture()
    setProvider("claude", new MockProvider([]) as unknown as AgentProvider)
    const controller = new AbortController()
    controller.abort()

    try {
      await expect(runFinalizeReview(
        fixture.projectRoot,
        fixture.runDir,
        fixture.state,
        TEST_CONFIG,
        TEST_MODEL,
        { onStreamText() {}, onToolStatus() {} },
        controller.signal,
      )).rejects.toMatchObject({ name: "AbortError" })
    } finally {
      await fixture.cleanup()
    }
  })
})
