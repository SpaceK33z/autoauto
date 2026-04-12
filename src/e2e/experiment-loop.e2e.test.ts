/**
 * E2E tests for the experiment loop lifecycle.
 * Exercises runExperimentLoop() end-to-end with real git repos and
 * a CommittingMockProvider that can create actual git commits.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { join } from "node:path"
import { mkdir, chmod, rm } from "node:fs/promises"
import { $ } from "bun"
import { mkdtemp } from "node:fs/promises"
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

// ---------------------------------------------------------------------------
// Mock provider that can perform real git commits via side effects
// ---------------------------------------------------------------------------

interface MockSessionConfig {
  events: AgentEvent[]
  /** Runs before yielding events. Use to create git commits, modify files, etc. */
  sideEffect?: (cwd: string) => Promise<void>
}

class CommittingMockProvider implements AgentProvider {
  readonly name: string
  private sessionIndex = 0
  private sessions: MockSessionConfig[]
  readonly sessionModels: string[] = []
  readonly receivedPrompts: string[] = []

  constructor(name: string, sessions: MockSessionConfig[]) {
    this.name = name
    this.sessions = sessions
  }

  createSession(config: AgentSessionConfig): AgentSession {
    this.sessionModels.push(config.model ?? "unknown")
    const sessionConfig =
      this.sessions[this.sessionIndex] ?? this.sessions[this.sessions.length - 1]
    this.sessionIndex++
    return new CommittingMockSession(sessionConfig, config.cwd)
  }

  runOnce(prompt: string, config: AgentSessionConfig): AgentSession {
    this.receivedPrompts.push(prompt)
    const session = this.createSession(config)
    session.endInput()
    return session
  }

  async checkAuth(): Promise<AuthResult> {
    return { authenticated: true, account: { email: "test@example.com" } }
  }

  async listModels(): Promise<AgentModelOption[]> {
    return [
      { provider: this.name as "claude", model: "default", label: "Default", isDefault: true },
    ]
  }
}

class CommittingMockSession implements AgentSession {
  private closed = false
  private sideEffectRan = false

  constructor(
    private config: MockSessionConfig,
    private cwd: string | undefined,
  ) {}

  pushMessage(): void {}
  endInput(): void {}
  close(): void {
    this.closed = true
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (!this.sideEffectRan && this.config.sideEffect && this.cwd) {
      this.sideEffectRan = true
      await this.config.sideEffect(this.cwd)
    }
    for (const event of this.config.events) {
      if (this.closed) break
      yield event
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL: ModelSlot = { provider: "claude", model: "test-model", effort: "high" }

const RESULTS_HEADER =
  "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n"

const SUCCESS_EVENTS: AgentEvent[] = [{ type: "result", success: true }]

const BASE_CONFIG: ProgramConfig = {
  metric_field: "score",
  direction: "lower",
  noise_threshold: 0.02,
  repeats: 1,
  quality_gates: {},
  max_experiments: 10,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setMeasureOutput(
  programDir: string,
  output: Record<string, unknown>,
): Promise<void> {
  await Bun.write(join(programDir, "measure-output.json"), JSON.stringify(output))
}

async function createGitCommit(
  cwd: string,
  filename: string,
  content: string,
  message: string,
): Promise<void> {
  await Bun.write(join(cwd, filename), content)
  await $`git add ${filename}`.cwd(cwd).quiet()
  await $`git commit -m ${message}`.cwd(cwd).quiet()
}

interface CallbackTracker {
  errors: string[]
  phases: { phase: string; detail?: string }[]
  experimentEnds: { status: string; description: string }[]
  rebaselines: { oldBaseline: number; newBaseline: number; reason: string }[]
  callbacks: LoopCallbacks
}

function createCallbackTracker(): CallbackTracker {
  const tracker: CallbackTracker = {
    errors: [],
    phases: [],
    experimentEnds: [],
    rebaselines: [],
    callbacks: null!,
  }
  tracker.callbacks = {
    onPhaseChange: (phase, detail) => {
      tracker.phases.push({ phase, detail })
    },
    onExperimentStart: () => {},
    onExperimentEnd: (result) => {
      tracker.experimentEnds.push({ status: result.status, description: result.description })
    },
    onStateUpdate: () => {},
    onAgentStream: () => {},
    onAgentToolUse: () => {},
    onError: (error) => {
      tracker.errors.push(error)
    },
    onRebaseline: (oldBaseline, newBaseline, reason) => {
      tracker.rebaselines.push({ oldBaseline, newBaseline, reason })
    },
  }
  return tracker
}

interface TestEnv {
  cwd: string
  programDir: string
  runDir: string
  runId: string
  branchName: string
  initSha: string
}

const MEASURE_SH_CONTENT = '#!/bin/bash\ncat "$(dirname "$0")/measure-output.json"'

async function createTestEnv(
  programConfig: ProgramConfig,
  measureOutput: Record<string, unknown> = { score: 100 },
  extraSetup?: (cwd: string) => Promise<void>,
): Promise<TestEnv> {
  const cwd = await mkdtemp(join(tmpdir(), "autoauto-loop-e2e-"))
  await $`git init`.cwd(cwd).quiet()
  await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
  await $`git config user.name "Test"`.cwd(cwd).quiet()
  await Bun.write(join(cwd, "README.md"), "# test\n")
  await Bun.write(join(cwd, ".gitignore"), ".autoauto/\n")

  if (extraSetup) await extraSetup(cwd)

  await $`git add -A`.cwd(cwd).quiet()
  await $`git commit -m "init"`.cwd(cwd).quiet()

  const programDir = join(cwd, ".autoauto", "programs", "test-prog")
  await mkdir(programDir, { recursive: true })
  await Bun.write(join(programDir, "config.json"), JSON.stringify(programConfig, null, 2))
  await Bun.write(join(programDir, "program.md"), "# Test Program\nOptimize the score.\n")
  await Bun.write(join(programDir, "measure.sh"), MEASURE_SH_CONTENT)
  // Lock ALL measurement files (measure.sh + config.json) — the loop's getMeasurementViolations
  // checks that none of them have write bits.
  await chmod(join(programDir, "measure.sh"), 0o444)
  await chmod(join(programDir, "config.json"), 0o444)
  await setMeasureOutput(programDir, measureOutput)

  const runId = "20260412-120000"
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  const initSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
  const branchName = `autoauto-test-prog-${runId}`
  await $`git checkout -b ${branchName}`.cwd(cwd).quiet()

  await writeInitialState(runDir, runId, branchName, initSha)
  await Bun.write(join(runDir, "results.tsv"), RESULTS_HEADER)

  return { cwd, programDir, runDir, runId, branchName, initSha }
}

async function writeInitialState(
  runDir: string,
  runId: string,
  branchName: string,
  initSha: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const state = {
    run_id: runId,
    program_slug: "test-prog",
    phase: "idle",
    experiment_number: 0,
    original_baseline: 100,
    current_baseline: 100,
    best_metric: 100,
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
    ...overrides,
  }
  await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))
}

async function resetRunState(env: TestEnv, overrides: Record<string, unknown> = {}): Promise<void> {
  await $`git reset --hard ${env.initSha}`.cwd(env.cwd).quiet()
  await writeInitialState(env.runDir, env.runId, env.branchName, env.initSha, overrides)
  await Bun.write(join(env.runDir, "results.tsv"), RESULTS_HEADER)
  // Re-lock measurement files (unlockMeasurement runs in the loop's finally block)
  await chmod(join(env.programDir, "measure.sh"), 0o444).catch(() => {})
  await chmod(join(env.programDir, "config.json"), 0o444).catch(() => {})
}

// ---------------------------------------------------------------------------
// Test Group 1: Keep/discard lifecycle
// ---------------------------------------------------------------------------

describe("Experiment loop: keep/discard lifecycle", () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await createTestEnv(BASE_CONFIG)
  })

  afterAll(async () => {
    await rm(env.cwd, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await resetRunState(env)
    await setMeasureOutput(env.programDir, { score: 100 })
  })

  test("keeps experiment when metric improves beyond noise threshold", async () => {
    const provider = new CommittingMockProvider("claude", [
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          await setMeasureOutput(env.programDir, { score: 90 })
          await createGitCommit(cwd, "README.md", "# improved\n", "improve performance")
        },
      },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 1, carryForward: false, ideasBacklogEnabled: false },
    )

    const results = await readAllResults(env.runDir)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe("keep")
    expect(results[0].metric_value).toBe(90)

    expect(finalState.total_keeps).toBe(1)
    expect(finalState.best_metric).toBe(90)
    expect(finalState.best_experiment).toBe(1)
    expect(finalState.termination_reason).toBe("max_experiments")

    // Git HEAD should be at committed SHA (not reverted)
    const headSha = (await $`git rev-parse HEAD`.cwd(env.cwd).text()).trim()
    expect(headSha).not.toBe(env.initSha)
  })

  test("discards experiment when metric regresses", async () => {
    const provider = new CommittingMockProvider("claude", [
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          await setMeasureOutput(env.programDir, { score: 110 })
          await createGitCommit(cwd, "README.md", "# worse\n", "make things worse")
        },
      },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 1, carryForward: false, ideasBacklogEnabled: false },
    )

    const results = await readAllResults(env.runDir)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe("discard")
    expect(results[0].metric_value).toBe(110)

    expect(finalState.total_discards).toBe(1)
    expect(finalState.current_baseline).toBe(100) // unchanged

    // Git HEAD should be reverted
    const headSha = (await $`git rev-parse HEAD`.cwd(env.cwd).text()).trim()
    expect(headSha).toBe(env.initSha)
  })

  test("discards noise-band experiment with noise: prefix", async () => {
    const provider = new CommittingMockProvider("claude", [
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          // 0.5% change, within 2% noise threshold
          await setMeasureOutput(env.programDir, { score: 99.5 })
          await createGitCommit(cwd, "README.md", "# tweaked\n", "minor tweak")
        },
      },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 1, carryForward: false, ideasBacklogEnabled: false },
    )

    const results = await readAllResults(env.runDir)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe("discard")
    expect(results[0].description).toStartWith("noise:")

    // Git HEAD should be reverted
    const headSha = (await $`git rev-parse HEAD`.cwd(env.cwd).text()).trim()
    expect(headSha).toBe(env.initSha)
  })
})

// ---------------------------------------------------------------------------
// Test Group 2: Stop conditions
// ---------------------------------------------------------------------------

describe("Experiment loop: stop conditions", () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await createTestEnv(BASE_CONFIG)
  })

  afterAll(async () => {
    await rm(env.cwd, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await resetRunState(env)
    await setMeasureOutput(env.programDir, { score: 100 })
  })

  test("soft stop terminates cleanly between iterations", async () => {
    let callCount = 0
    const stopRequested = () => {
      callCount++
      return callCount > 1 // false first time, true after
    }

    const provider = new CommittingMockProvider("claude", [
      { events: SUCCESS_EVENTS }, // no_commit (no side effect)
      { events: SUCCESS_EVENTS }, // should never run
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      {
        maxExperiments: 10,
        stopRequested,
        carryForward: false,
        ideasBacklogEnabled: false,
      },
    )

    expect(finalState.phase).toBe("complete")
    expect(finalState.termination_reason).toBe("stopped")
    expect(finalState.experiment_number).toBe(1)
    expect(provider.sessionModels).toHaveLength(1)
  })

  test("hard abort produces crash row and reverts", async () => {
    const controller = new AbortController()

    const provider = new CommittingMockProvider("claude", [
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          await createGitCommit(cwd, "README.md", "# aborted\n", "will be aborted")
          controller.abort()
        },
      },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      {
        maxExperiments: 5,
        signal: controller.signal,
        carryForward: false,
        ideasBacklogEnabled: false,
      },
    )

    expect(finalState.phase).toBe("complete")
    expect(finalState.termination_reason).toBe("aborted")

    const results = await readAllResults(env.runDir)
    const crashRows = results.filter((r) => r.status === "crash")
    expect(crashRows).toHaveLength(1)
    expect(crashRows[0].description).toContain("aborted")
  })

  test("stagnation stops after N consecutive discards", async () => {
    const stagnationConfig: ProgramConfig = { ...BASE_CONFIG, max_consecutive_discards: 3 }

    const provider = new CommittingMockProvider("claude", [
      { events: SUCCESS_EVENTS }, // no_commit → crash, discard counter++
      { events: SUCCESS_EVENTS },
      { events: SUCCESS_EVENTS },
      { events: SUCCESS_EVENTS }, // should never run
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      stagnationConfig,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 10, carryForward: false, ideasBacklogEnabled: false },
    )

    expect(finalState.phase).toBe("complete")
    expect(finalState.termination_reason).toBe("stagnation")
    expect(finalState.experiment_number).toBe(3)
    expect(provider.sessionModels).toHaveLength(3)
  })

  test("budget exceeded stops when cost exceeds maxCostUsd", async () => {
    const provider = new CommittingMockProvider("claude", [
      {
        events: [
          {
            type: "result",
            success: true,
            cost: {
              total_cost_usd: 0.6,
              duration_ms: 100,
              duration_api_ms: 80,
              num_turns: 1,
              input_tokens: 1000,
              output_tokens: 500,
            },
          },
        ],
      }, // no_commit with cost
      { events: SUCCESS_EVENTS }, // should never run
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      {
        maxExperiments: 10,
        maxCostUsd: 0.5,
        carryForward: false,
        ideasBacklogEnabled: false,
      },
    )

    expect(finalState.phase).toBe("complete")
    expect(finalState.termination_reason).toBe("budget_exceeded")
    expect(finalState.experiment_number).toBe(1)
    expect(finalState.total_cost_usd).toBeGreaterThanOrEqual(0.6)
    expect(provider.sessionModels).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test Group 3: Measurement integrity
// ---------------------------------------------------------------------------

describe("Experiment loop: measurement integrity", () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await createTestEnv(BASE_CONFIG)
  })

  afterAll(async () => {
    await rm(env.cwd, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await resetRunState(env)
    await setMeasureOutput(env.programDir, { score: 100 })
    // Restore measure.sh content in case a previous test modified it
    await chmod(join(env.programDir, "measure.sh"), 0o644).catch(() => {})
    await Bun.write(join(env.programDir, "measure.sh"), MEASURE_SH_CONTENT)
    await chmod(join(env.programDir, "measure.sh"), 0o444)
    await chmod(join(env.programDir, "config.json"), 0o444).catch(() => {})
  })

  test("lock violation on measurement file modification discards and restores", async () => {
    const measureShPath = join(env.programDir, "measure.sh")

    const provider = new CommittingMockProvider("claude", [
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          // Modify measure.sh (lock violation)
          await chmod(measureShPath, 0o644)
          await Bun.write(measureShPath, "#!/bin/bash\necho 'tampered'")
          // Also create a legitimate commit so outcome is "committed"
          await createGitCommit(cwd, "README.md", "# changed\n", "agent commit")
        },
      },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 1, carryForward: false, ideasBacklogEnabled: false },
    )

    const results = await readAllResults(env.runDir)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe("discard")
    expect(results[0].description).toContain("lock violation")

    // measure.sh should be restored to original content
    // (unlockMeasurement in finally block sets it to 644, but content is restored)
    const restored = await Bun.file(measureShPath).text()
    expect(restored).toBe(MEASURE_SH_CONTENT)

    // Git HEAD should be reverted
    const headSha = (await $`git rev-parse HEAD`.cwd(env.cwd).text()).trim()
    expect(headSha).toBe(env.initSha)
  })

  test("quality gate failure discards despite metric improvement", async () => {
    const gatedConfig: ProgramConfig = {
      ...BASE_CONFIG,
      quality_gates: { errors: { max: 5 } },
    }

    // Create fresh env with gated config
    const gatedEnv = await createTestEnv(gatedConfig, { score: 80, errors: 10 })

    const provider = new CommittingMockProvider("claude", [
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          // Metric improves (80 < 100) but errors=10 > max=5
          await setMeasureOutput(gatedEnv.programDir, { score: 80, errors: 10 })
          await createGitCommit(cwd, "README.md", "# gated\n", "improve score but break gate")
        },
      },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      gatedEnv.cwd,
      gatedEnv.programDir,
      gatedEnv.runDir,
      gatedConfig,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 1, carryForward: false, ideasBacklogEnabled: false },
    )

    const results = await readAllResults(gatedEnv.runDir)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe("discard")
    expect(results[0].description).toContain("quality gate")
    expect(finalState.total_discards).toBe(1)
    expect(finalState.current_baseline).toBe(100) // unchanged

    await rm(gatedEnv.cwd, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Test Group 4: Advanced behaviors
// ---------------------------------------------------------------------------

describe("Experiment loop: rebaseline on drift", () => {
  let env: TestEnv

  beforeAll(async () => {
    // measure-output.json returns drifted value from the start
    // Since no experiments commit, only the rebaseline measurement runs
    env = await createTestEnv(BASE_CONFIG, { score: 90 })
  })

  afterAll(async () => {
    await rm(env.cwd, { recursive: true, force: true })
  })

  test("rebaselines after 5 consecutive discards on drift detection", async () => {
    const provider = new CommittingMockProvider("claude", [
      { events: SUCCESS_EVENTS }, // no_commit × 6
      { events: SUCCESS_EVENTS },
      { events: SUCCESS_EVENTS },
      { events: SUCCESS_EVENTS },
      { events: SUCCESS_EVENTS },
      { events: SUCCESS_EVENTS },
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      { ...BASE_CONFIG, max_consecutive_discards: 10 },
      MODEL,
      tracker.callbacks,
      { maxExperiments: 5, carryForward: false, ideasBacklogEnabled: false },
    )

    // Rebaseline should have been triggered at discard 5
    expect(tracker.rebaselines).toHaveLength(1)
    expect(tracker.rebaselines[0].oldBaseline).toBe(100)
    expect(tracker.rebaselines[0].newBaseline).toBe(90)
    expect(tracker.rebaselines[0].reason).toBe("drift")

    // State should reflect drifted baseline
    const state = await readState(env.runDir)
    expect(state.current_baseline).toBe(90)

    // Error callback should mention drift
    const driftError = tracker.errors.find((e) => e.includes("Baseline drift detected"))
    expect(driftError).toBeDefined()
  })
})

describe("Experiment loop: simplification auto-keep", () => {
  let env: TestEnv

  beforeAll(async () => {
    // Create a file with many lines that can be trimmed for simplification
    env = await createTestEnv(
      { ...BASE_CONFIG, max_consecutive_discards: 3 },
      { score: 100 },
      async (cwd) => {
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
        await Bun.write(join(cwd, "padding.txt"), lines)
      },
    )
  })

  afterAll(async () => {
    await rm(env.cwd, { recursive: true, force: true })
  })

  test("simplification keep does not reset consecutive discard counter", async () => {
    // Sequence: no_commit → no_commit → simplification keep → no_commit → stagnation
    // If simplification reset the counter, we'd need 3 more no-commits after it.
    // Stagnation at 4 experiments proves the counter was NOT reset.
    const provider = new CommittingMockProvider("claude", [
      { events: SUCCESS_EVENTS }, // no_commit, discards=1
      { events: SUCCESS_EVENTS }, // no_commit, discards=2
      {
        events: SUCCESS_EVENTS,
        sideEffect: async (cwd) => {
          // Trim padding.txt (net-negative LOC) + noise-band metric
          await setMeasureOutput(env.programDir, { score: 99.5 })
          const lines =
            Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
          await Bun.write(join(cwd, "padding.txt"), lines)
          await $`git add padding.txt`.cwd(cwd).quiet()
          await $`git commit -m "trim padding"`.cwd(cwd).quiet()
        },
      }, // simplification keep, discards stays 2
      { events: SUCCESS_EVENTS }, // no_commit, discards=3 → stagnation
    ])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    const finalState = await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      { ...BASE_CONFIG, max_consecutive_discards: 3 },
      MODEL,
      tracker.callbacks,
      { maxExperiments: 10, carryForward: false, ideasBacklogEnabled: false },
    )

    // Experiment 3 should be a simplification keep
    const keeps = tracker.experimentEnds.filter((e) => e.status === "keep")
    expect(keeps).toHaveLength(1)
    expect(keeps[0].description).toContain("simplification:")

    // 4 experiments total, then stagnation
    expect(finalState.experiment_number).toBe(4)
    expect(finalState.termination_reason).toBe("stagnation")
    expect(finalState.total_keeps).toBe(1)
  })
})

describe("Experiment loop: carry-forward context", () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await createTestEnv(BASE_CONFIG)

    // Create a previous completed run with results
    const prevRunId = "20260411-100000"
    const prevRunDir = join(env.programDir, "runs", prevRunId)
    await mkdir(prevRunDir, { recursive: true })

    await Bun.write(
      join(prevRunDir, "state.json"),
      JSON.stringify({
        run_id: prevRunId,
        program_slug: "test-prog",
        phase: "complete",
        experiment_number: 3,
        original_baseline: 120,
        current_baseline: 95,
        best_metric: 95,
        best_experiment: 2,
        total_keeps: 2,
        total_discards: 1,
        total_crashes: 0,
        branch_name: "autoauto-test-prog-prev",
        original_baseline_sha: env.initSha,
        last_known_good_sha: env.initSha,
        candidate_sha: null,
        started_at: "2026-04-11T10:00:00.000Z",
        updated_at: "2026-04-11T11:00:00.000Z",
        termination_reason: "max_experiments",
      }),
    )

    // Previous run results with a keep row
    await Bun.write(
      join(prevRunDir, "results.tsv"),
      RESULTS_HEADER +
        "1\tabc1234\t110\t\tkeep\tcached hot path\t500\t\n" +
        "2\tdef5678\t95\t\tkeep\treduced allocations\t600\t\n" +
        "3\tghi9012\t105\t\tdiscard\tnoise: minor tweak\t400\t\n",
    )
  })

  afterAll(async () => {
    await rm(env.cwd, { recursive: true, force: true })
  })

  test("feeds previous run context to agent prompt", async () => {
    const provider = new CommittingMockProvider("claude", [{ events: SUCCESS_EVENTS }])
    setProvider("claude", provider)

    const tracker = createCallbackTracker()
    await runExperimentLoop(
      env.cwd,
      env.programDir,
      env.runDir,
      BASE_CONFIG,
      MODEL,
      tracker.callbacks,
      { maxExperiments: 1, carryForward: true, ideasBacklogEnabled: false },
    )

    // The agent should have received the previous run context in its prompt
    expect(provider.receivedPrompts).toHaveLength(1)
    const prompt = provider.receivedPrompts[0]
    expect(prompt).toContain("20260411-100000") // previous run ID
    expect(prompt).toContain("cached hot path") // keep description from previous run
    expect(prompt).toContain("reduced allocations") // another keep description
  })
})
