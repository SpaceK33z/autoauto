/**
 * E2E test for model fallback on quota exhaustion.
 * Verifies that when the primary model hits a quota error, the loop:
 *   1. Does NOT record a crash row for the quota event
 *   2. Switches to the fallback model
 *   3. Runs the next experiment with the fallback model
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "node:path"
import { mkdir, chmod } from "node:fs/promises"
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { setProvider } from "../lib/agent/index.ts"
import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentEvent,
  AgentModelOption,
  AuthResult,
} from "../lib/agent/types.ts"
import { runExperimentLoop, type LoopCallbacks } from "../lib/experiment-loop.ts"
import type { ProgramConfig } from "../lib/programs.ts"
import type { ModelSlot } from "../lib/config.ts"
import { readState, readAllResults } from "../lib/run.ts"
import { readRunConfig } from "../lib/daemon-lifecycle.ts"

// --- Sequence-aware mock provider ---

/** Mock provider that emits a different event sequence for each successive session. */
class SequenceMockProvider implements AgentProvider {
  readonly name: string
  private sessionIndex = 0
  private sequences: AgentEvent[][]
  /** Records which model was requested for each session. */
  readonly sessionModels: string[] = []

  constructor(name: string, sequences: AgentEvent[][]) {
    this.name = name
    this.sequences = sequences
  }

  createSession(config: AgentSessionConfig): AgentSession {
    this.sessionModels.push(config.model ?? "unknown")
    const events = this.sequences[this.sessionIndex] ?? this.sequences[this.sequences.length - 1]
    this.sessionIndex++
    return new SequenceMockSession(events)
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

class SequenceMockSession implements AgentSession {
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

const PRIMARY: ModelSlot = { provider: "claude", model: "sonnet", effort: "high" }
const FALLBACK: ModelSlot = { provider: "codex", model: "fallback-model", effort: "high" }

const PROGRAM_CONFIG: ProgramConfig = {
  metric_field: "score",
  direction: "lower",
  noise_threshold: 0.02,
  repeats: 1,
  quality_gates: {},
  max_experiments: 5,
}

let cwd: string
let programDir: string
let runDir: string
let claudeProvider: SequenceMockProvider
let codexProvider: SequenceMockProvider

/** Tracking for callbacks */
let errors: string[] = []
let phases: { phase: string; detail?: string }[] = []
let experimentEnds: { status: string; description: string }[] = []
let stateUpdates: { provider?: string; model?: string }[] = []

function makeCallbacks(): LoopCallbacks {
  return {
    onPhaseChange: (phase, detail) => { phases.push({ phase, detail }) },
    onExperimentStart: () => {},
    onExperimentEnd: (result) => { experimentEnds.push({ status: result.status, description: result.description }) },
    onStateUpdate: (state) => { stateUpdates.push({ provider: state.provider, model: state.model }) },
    onAgentStream: () => {},
    onAgentToolUse: () => {},
    onError: (error) => { errors.push(error) },
  }
}

beforeAll(async () => {
  // Create temp git repo
  cwd = await mkdtemp(join(tmpdir(), "autoauto-fallback-e2e-"))
  await $`git init`.cwd(cwd).quiet()
  await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
  await $`git config user.name "Test"`.cwd(cwd).quiet()
  await Bun.write(join(cwd, "README.md"), "# test\n")
  await Bun.write(join(cwd, ".gitignore"), ".autoauto/\n")
  await $`git add -A`.cwd(cwd).quiet()
  await $`git commit -m "init"`.cwd(cwd).quiet()

  // Create program directory
  programDir = join(cwd, ".autoauto", "programs", "test-prog")
  await mkdir(programDir, { recursive: true })

  await Bun.write(join(programDir, "config.json"), JSON.stringify(PROGRAM_CONFIG, null, 2))
  await Bun.write(join(programDir, "program.md"), "# Test Program\nOptimize the score.\n")
  await Bun.write(join(programDir, "measure.sh"), '#!/bin/bash\necho \'{"score": 42}\'')
  await chmod(join(programDir, "measure.sh"), 0o444)

  // Create run directory
  const runId = "20260401-120000"
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
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    effort: PRIMARY.effort,
  }
  await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))

  // results.tsv with header only
  await Bun.write(
    join(runDir, "results.tsv"),
    "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n",
  )

  // run-config.json (needed for persistModelSwitch to persist active model override)
  await Bun.write(join(runDir, "run-config.json"), JSON.stringify({
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    effort: PRIMARY.effort,
    max_experiments: 1,
    fallback_provider: FALLBACK.provider,
    fallback_model: FALLBACK.model,
    fallback_effort: FALLBACK.effort,
  }, null, 2))
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe("Model fallback on quota exhaustion", () => {
  test("switches to fallback on quota_exhausted without crash row, then uses fallback for next experiment", async () => {
    // Claude provider: always returns quota_exhausted
    claudeProvider = new SequenceMockProvider("claude", [
      [{ type: "error", error: "You've hit your API quota limit", retriable: false, errorKind: "quota_exhausted" }],
    ])

    // Codex provider: returns success with no commit (simplest outcome)
    codexProvider = new SequenceMockProvider("codex", [
      [{ type: "result", success: true }],
    ])

    setProvider("claude", claudeProvider)
    setProvider("codex", codexProvider)

    // Reset tracking
    errors = []
    phases = []
    experimentEnds = []
    stateUpdates = []

    const finalState = await runExperimentLoop(
      cwd,
      programDir,
      runDir,
      PROGRAM_CONFIG,
      PRIMARY,
      makeCallbacks(),
      {
        maxExperiments: 1,
        fallbackModel: FALLBACK,
        carryForward: false,
        ideasBacklogEnabled: false,
      },
    )

    // --- 1. No crash row from the quota event ---
    const results = await readAllResults(runDir)
    const quotaCrashRows = results.filter((r) =>
      r.description.includes("quota") || r.description.includes("You've hit"),
    )
    expect(quotaCrashRows).toHaveLength(0)

    // --- 2. Fallback activated: check error callback reported the switch ---
    const switchError = errors.find((e) => e.includes("switching to"))
    expect(switchError).toBeDefined()
    expect(switchError).toContain("Quota exhausted")

    // --- 3. State reflects fallback model ---
    const persistedState = await readState(runDir)
    expect(persistedState.provider).toBe(FALLBACK.provider)
    expect(persistedState.model).toBe(FALLBACK.model)

    // --- 4. Run-config has active model override persisted ---
    const runConfig = await readRunConfig(runDir)
    expect(runConfig?.active_provider).toBe(FALLBACK.provider)
    expect(runConfig?.active_model).toBe(FALLBACK.model)
    expect(runConfig?.active_effort).toBe(FALLBACK.effort)

    // --- 5. Codex provider actually received a session (fallback was used) ---
    expect(codexProvider.sessionModels).toHaveLength(1)
    expect(codexProvider.sessionModels[0]).toBe(FALLBACK.model)

    // --- 6. Claude provider was only called once (the quota attempt) ---
    expect(claudeProvider.sessionModels).toHaveLength(1)
    expect(claudeProvider.sessionModels[0]).toBe(PRIMARY.model)

    // --- 7. The experiment that ran on fallback produced a result (no_commit → crash) ---
    const fallbackResults = results.filter((r) => r.status === "crash")
    expect(fallbackResults).toHaveLength(1)
    expect(fallbackResults[0].description).toContain("no commit")

    // --- 8. Final state is complete (reached max_experiments=1) ---
    expect(finalState.phase).toBe("complete")
    expect(finalState.experiment_number).toBe(1)
  })

  test("quota_exhausted without fallback configured stops the run", async () => {
    // Reset run state for a clean test
    const initSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
    const state = {
      run_id: "20260401-120000",
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
      branch_name: `autoauto-test-prog-20260401-120000`,
      original_baseline_sha: initSha,
      last_known_good_sha: initSha,
      candidate_sha: null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider: PRIMARY.provider,
      model: PRIMARY.model,
      effort: PRIMARY.effort,
    }
    await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))
    await Bun.write(
      join(runDir, "results.tsv"),
      "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n",
    )
    // Remove run-config from previous test so no fallback is configured via file
    await rm(join(runDir, "run-config.json"), { force: true })

    claudeProvider = new SequenceMockProvider("claude", [
      [{ type: "error", error: "quota exceeded", retriable: false, errorKind: "quota_exhausted" }],
    ])
    setProvider("claude", claudeProvider)

    errors = []
    phases = []
    experimentEnds = []

    const finalState = await runExperimentLoop(
      cwd,
      programDir,
      runDir,
      PROGRAM_CONFIG,
      PRIMARY,
      makeCallbacks(),
      {
        maxExperiments: 5,
        // no fallbackModel
        carryForward: false,
        ideasBacklogEnabled: false,
      },
    )

    // Run should stop with quota_exhausted termination
    expect(finalState.phase).toBe("complete")
    expect(finalState.termination_reason).toBe("quota_exhausted")

    // No crash row from the quota event
    const results = await readAllResults(runDir)
    expect(results).toHaveLength(0)

    // Error message reported
    const quotaError = errors.find((e) => e.includes("quota"))
    expect(quotaError).toBeDefined()
  })

  test("rate_limited falls back after threshold consecutive hits", async () => {
    // Reset run state
    const initSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
    const state = {
      run_id: "20260401-120000",
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
      branch_name: `autoauto-test-prog-20260401-120000`,
      original_baseline_sha: initSha,
      last_known_good_sha: initSha,
      candidate_sha: null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      provider: PRIMARY.provider,
      model: PRIMARY.model,
      effort: PRIMARY.effort,
    }
    await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))
    await Bun.write(
      join(runDir, "results.tsv"),
      "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n",
    )
    await rm(join(runDir, "run-config.json"), { force: true })

    // Claude: 3 consecutive rate limits (threshold = 3), then would be unreachable
    claudeProvider = new SequenceMockProvider("claude", [
      [{ type: "error", error: "rate limit hit", retriable: true, errorKind: "rate_limited" }],
      [{ type: "error", error: "rate limit hit", retriable: true, errorKind: "rate_limited" }],
      [{ type: "error", error: "rate limit hit", retriable: true, errorKind: "rate_limited" }],
    ])

    // Codex: success (no commit)
    codexProvider = new SequenceMockProvider("codex", [
      [{ type: "result", success: true }],
    ])

    setProvider("claude", claudeProvider)
    setProvider("codex", codexProvider)

    errors = []
    phases = []
    experimentEnds = []
    stateUpdates = []

    // Write run-config with max_experiments=1 so the loop stops after one fallback experiment
    await Bun.write(join(runDir, "run-config.json"), JSON.stringify({
      provider: PRIMARY.provider,
      model: PRIMARY.model,
      effort: PRIMARY.effort,
      max_experiments: 1,
      fallback_provider: FALLBACK.provider,
      fallback_model: FALLBACK.model,
      fallback_effort: FALLBACK.effort,
    }, null, 2))

    // The rate limit path pauses 60s per hit before threshold (2 pauses × 60s).
    // This makes the test take ~2 minutes, but it verifies the real pause behavior.
    await runExperimentLoop(
      cwd,
      programDir,
      runDir,
      PROGRAM_CONFIG,
      PRIMARY,
      makeCallbacks(),
      {
        maxExperiments: 1,
        fallbackModel: FALLBACK,
        carryForward: false,
        ideasBacklogEnabled: false,
      },
    )

    // Claude should have been called 3 times (the threshold)
    expect(claudeProvider.sessionModels).toHaveLength(3)

    // After 3 consecutive rate limits, fallback should have activated
    const switchError = errors.find((e) => e.includes("consecutive rate limits"))
    expect(switchError).toBeDefined()
    expect(switchError).toContain("switching to")

    // Codex provider should have been called for the post-fallback experiment
    expect(codexProvider.sessionModels).toHaveLength(1)
    expect(codexProvider.sessionModels[0]).toBe(FALLBACK.model)
  }, 180_000) // generous timeout for rate limit pauses
})
