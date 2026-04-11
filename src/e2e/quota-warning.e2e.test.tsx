/**
 * E2E test for quota warning feature.
 * Verifies that:
 *   1. quota_update events flow through the experiment loop to callbacks
 *   2. daemon callbacks write quota.json with deduplication
 *   3. formatResetsIn and formatElapsed produce correct output
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdir, chmod } from "node:fs/promises"
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { setProvider, getProvider } from "../lib/agent/index.ts"
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentEvent,
  AgentModelOption,
  AuthResult,
  QuotaInfo,
} from "../lib/agent/types.ts"
import { runExperimentLoop, type LoopCallbacks } from "../lib/experiment-loop.ts"
import type { ProgramConfig } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import { createFileCallbacks } from "../lib/daemon-callbacks.ts"
import { formatResetsIn, formatElapsed } from "../lib/format.ts"

// --- Mock provider that emits quota_update events ---

class QuotaMockProvider implements AgentProvider {
  readonly name: string
  private events: AgentEvent[]

  constructor(name: string, events: AgentEvent[]) {
    this.name = name
    this.events = events
  }

  createSession(_config: AgentSessionConfig): AgentSession {
    return new QuotaMockSession(this.events)
  }

  runOnce(_prompt: string, config: AgentSessionConfig): AgentSession {
    const session = this.createSession(config)
    session.endInput()
    return session
  }

  async checkAuth(): Promise<AuthResult> {
    return { authenticated: true, account: { email: "test@example.com" } }
  }

  async listModels(): Promise<AgentModelOption[]> {
    return [{ provider: this.name as "claude", model: "default", label: "Default", isDefault: true }]
  }
}

class QuotaMockSession implements AgentSession {
  private closed = false
  constructor(private events: AgentEvent[]) {}

  pushMessage(): void {}
  endInput(): void {}
  close(): void { this.closed = true }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (const event of this.events) {
      if (this.closed) break
      yield event
    }
  }
}

// --- Test fixtures ---

const MODEL: ModelSlot = { provider: "claude", model: "sonnet", effort: "high" }

const PROGRAM_CONFIG: ProgramConfig = {
  metric_field: "score",
  direction: "lower",
  noise_threshold: 0.02,
  repeats: 1,
  quality_gates: {},
  max_experiments: 1,
}

let cwd: string
let programDir: string
let runDir: string

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "autoauto-quota-e2e-"))
  await $`git init`.cwd(cwd).quiet()
  await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
  await $`git config user.name "Test"`.cwd(cwd).quiet()
  await Bun.write(join(cwd, "README.md"), "# test\n")
  await Bun.write(join(cwd, ".gitignore"), ".autoauto/\n")
  await $`git add -A`.cwd(cwd).quiet()
  await $`git commit -m "init"`.cwd(cwd).quiet()

  programDir = join(cwd, ".autoauto", "programs", "test-prog")
  await mkdir(programDir, { recursive: true })

  await Bun.write(join(programDir, "config.json"), JSON.stringify(PROGRAM_CONFIG, null, 2))
  await Bun.write(join(programDir, "program.md"), "# Test Program\nOptimize the score.\n")
  await Bun.write(join(programDir, "measure.sh"), '#!/bin/bash\necho \'{"score": 42}\'')
  await chmod(join(programDir, "measure.sh"), 0o444)

  const runId = "20260401-130000"
  runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  const initSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
  const branchName = `autoauto-test-prog-${runId}`
  await $`git checkout -b ${branchName}`.cwd(cwd).quiet()

  const state = {
    run_id: runId,
    program_slug: "test-prog",
    phase: "idle",
    experiment_number: 0,
    original_baseline: 42,
    current_baseline: 42,
    best_metric: 42,
    best_experiment: 0,
    total_keeps: 0,
    total_discards: 0,
    total_crashes: 0,
    branch_name: branchName,
    original_baseline_sha: initSha,
    last_known_good_sha: initSha,
    candidate_sha: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    provider: MODEL.provider,
    model: MODEL.model,
    effort: MODEL.effort,
  }
  await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))
  await Bun.write(
    join(runDir, "results.tsv"),
    "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n",
  )
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe("Quota update callback flow", () => {
  let originalProvider: AgentProvider | undefined

  beforeEach(() => {
    try { originalProvider = getProvider("claude") } catch { originalProvider = undefined }
  })

  afterEach(() => {
    if (originalProvider) setProvider("claude", originalProvider)
  })

  test("onQuotaUpdate fires when agent emits quota_update event", async () => {
    const quotaInfo: QuotaInfo = {
      status: "allowed_warning",
      utilization: 0.85,
      resetsAt: Date.now() + 3_600_000,
      rateLimitType: "five_hour",
      updatedAt: Date.now(),
    }

    const provider = new QuotaMockProvider("claude", [
      { type: "quota_update", quota: quotaInfo },
      { type: "result", success: true },
    ])
    setProvider("claude", provider)

    const quotaUpdates: QuotaInfo[] = []
    const callbacks: LoopCallbacks = {
      onPhaseChange: () => {},
      onExperimentStart: () => {},
      onExperimentEnd: () => {},
      onStateUpdate: () => {},
      onAgentStream: () => {},
      onAgentToolUse: () => {},
      onError: () => {},
      onQuotaUpdate: (quota) => { quotaUpdates.push(quota) },
    }

    await runExperimentLoop(cwd, programDir, runDir, PROGRAM_CONFIG, MODEL, callbacks, {
      maxExperiments: 1,
    })

    expect(quotaUpdates.length).toBeGreaterThanOrEqual(1)
    expect(quotaUpdates[0].status).toBe("allowed_warning")
    expect(quotaUpdates[0].utilization).toBe(0.85)
    expect(quotaUpdates[0].rateLimitType).toBe("five_hour")
  }, 30_000)
})

describe("Daemon callbacks write quota.json", () => {
  let callbackRunDir: string

  beforeEach(async () => {
    callbackRunDir = await mkdtemp(join(tmpdir(), "autoauto-quota-cb-"))
  })

  test("writes quota.json on status change", async () => {
    const callbacks = createFileCallbacks(callbackRunDir)

    const quota: QuotaInfo = {
      status: "allowed_warning",
      utilization: 0.82,
      resetsAt: Date.now() + 7_200_000,
      updatedAt: Date.now(),
    }

    callbacks.onQuotaUpdate?.(quota)

    // Give Bun.write a moment to complete
    await Bun.sleep(50)

    const written = await Bun.file(join(callbackRunDir, "quota.json")).json() as QuotaInfo
    expect(written.status).toBe("allowed_warning")
    expect(written.utilization).toBe(0.82)
  })

  test("deduplicates writes when status and utilization unchanged", async () => {
    const callbacks = createFileCallbacks(callbackRunDir)

    const quota1: QuotaInfo = { status: "allowed", utilization: 0.5, updatedAt: Date.now() }
    const quota2: QuotaInfo = { status: "allowed", utilization: 0.52, updatedAt: Date.now() }
    const quota3: QuotaInfo = { status: "allowed", utilization: 0.6, updatedAt: Date.now() }

    callbacks.onQuotaUpdate?.(quota1)
    await Bun.sleep(50)
    const firstWrite = await Bun.file(join(callbackRunDir, "quota.json")).json() as QuotaInfo
    expect(firstWrite.utilization).toBe(0.5)

    // quota2 is within 5% delta — should NOT overwrite
    callbacks.onQuotaUpdate?.(quota2)
    await Bun.sleep(50)
    const afterDedup = await Bun.file(join(callbackRunDir, "quota.json")).json() as QuotaInfo
    expect(afterDedup.utilization).toBe(0.5) // unchanged

    // quota3 has >5% delta — SHOULD overwrite
    callbacks.onQuotaUpdate?.(quota3)
    await Bun.sleep(50)
    const afterUpdate = await Bun.file(join(callbackRunDir, "quota.json")).json() as QuotaInfo
    expect(afterUpdate.utilization).toBe(0.6) // updated
  })

  test("writes on status transition even if utilization similar", async () => {
    const callbacks = createFileCallbacks(callbackRunDir)

    const quota1: QuotaInfo = { status: "allowed", utilization: 0.79, updatedAt: Date.now() }
    const quota2: QuotaInfo = { status: "allowed_warning", utilization: 0.80, updatedAt: Date.now() }

    callbacks.onQuotaUpdate?.(quota1)
    await Bun.sleep(50)
    callbacks.onQuotaUpdate?.(quota2)
    await Bun.sleep(50)

    const written = await Bun.file(join(callbackRunDir, "quota.json")).json() as QuotaInfo
    expect(written.status).toBe("allowed_warning")
    expect(written.utilization).toBe(0.80)
  })
})

describe("formatResetsIn", () => {
  test("returns 'now' for past timestamps", () => {
    expect(formatResetsIn(Date.now() - 1000)).toBe("now")
  })

  test("formats minutes only", () => {
    expect(formatResetsIn(Date.now() + 15 * 60_000)).toBe("15m")
  })

  test("formats hours and minutes", () => {
    expect(formatResetsIn(Date.now() + 2.5 * 3_600_000)).toBe("2h 30m")
  })

  test("formats days and hours for 24h+", () => {
    expect(formatResetsIn(Date.now() + 26 * 3_600_000)).toBe("1d 2h")
  })
})

describe("formatElapsed", () => {
  test("returns 'just now' for recent timestamps", () => {
    expect(formatElapsed(Date.now() - 30_000)).toBe("just now")
  })

  test("formats minutes ago", () => {
    expect(formatElapsed(Date.now() - 10 * 60_000)).toBe("10m ago")
  })

  test("formats hours and minutes ago", () => {
    expect(formatElapsed(Date.now() - 2.5 * 3_600_000)).toBe("2h 30m ago")
  })

  test("formats days for 24h+", () => {
    expect(formatElapsed(Date.now() - 26 * 3_600_000)).toBe("1d 2h ago")
  })
})
