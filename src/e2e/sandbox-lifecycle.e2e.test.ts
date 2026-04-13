/**
 * Full lifecycle and reconnection e2e tests for sandbox (container) runs.
 *
 * These tests verify the two most critical user flows:
 * 1. spawn → watch progress → experiment transitions → complete → materialize
 * 2. detach → find via metadata → reattach → reconstruct state → resume watching
 *
 * All tests use MockContainerProvider (filesystem-backed) to avoid requiring
 * Docker or Modal. The daemon is simulated by writing files directly.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm, mkdir, appendFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MockContainerProvider } from "../lib/container-provider/mock.ts"
import { SandboxRunBackend } from "../lib/run-backend/sandbox.ts"
import { watchSandboxRunDir } from "../lib/sandbox-watcher.ts"
import type { RunState } from "../lib/run.ts"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const TSV_HEADER = "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n"

function tsvRow(exp: number, commit: string, metric: number, status: string, desc: string): string {
  return `${exp}\t${commit}\t${metric}\t\t${status}\t${desc}\t5000\t\n`
}

function makeState(runId: string, overrides: Partial<RunState> = {}): RunState {
  return {
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
    branch_name: "autoauto-test",
    original_baseline_sha: "aaa1111",
    last_known_good_sha: "aaa1111",
    candidate_sha: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe("sandbox lifecycle", () => {
  let mainRoot: string
  let containerRoot: string
  let provider: MockContainerProvider

  async function setup() {
    mainRoot = await mkdtemp(join(tmpdir(), "sandbox-lifecycle-main-"))
    containerRoot = await mkdtemp(join(tmpdir(), "sandbox-lifecycle-container-"))

    // Init git repo
    await $`git init`.cwd(mainRoot).quiet()
    await $`git config user.email "test@test.com"`.cwd(mainRoot).quiet()
    await $`git config user.name "Test"`.cwd(mainRoot).quiet()
    await Bun.write(join(mainRoot, "README.md"), "# test\n")
    await $`git add -A`.cwd(mainRoot).quiet()
    await $`git commit -m "init"`.cwd(mainRoot).quiet()

    // Create program
    const programDir = join(mainRoot, ".autoauto", "programs", "test-prog")
    await mkdir(programDir, { recursive: true })
    await Bun.write(join(programDir, "config.json"), JSON.stringify({
      metric_field: "score",
      direction: "lower",
      noise_threshold: 0.02,
      repeats: 1,
      max_experiments: 10,
    }, null, 2))
    await Bun.write(join(programDir, "measure"), '#!/bin/bash\necho \'{"score": 42}\'')
    const { chmod } = await import("node:fs/promises")
    await chmod(join(programDir, "measure"), 0o755)

    provider = new MockContainerProvider({ rootDir: containerRoot })
  }

  afterEach(async () => {
    MockContainerProvider.clearRegistry()
    if (mainRoot) await rm(mainRoot, { recursive: true, force: true })
    if (containerRoot) await rm(containerRoot, { recursive: true, force: true })
  })

  /** Resolve the remote run directory inside the container filesystem */
  function remoteRunDir(runId: string): string {
    return join(containerRoot, "workspace", ".autoauto", "programs", "test-prog", "runs", runId)
  }

  /** Remote path relative to container root (for watchSandboxRunDir) */
  function relativeRemoteRunDir(runId: string): string {
    return join("workspace", ".autoauto", "programs", "test-prog", "runs", runId)
  }

  // ---------------------------------------------------------------------------
  // Test 1: Full lifecycle — spawn → watch → experiment transitions → complete → materialize
  // ---------------------------------------------------------------------------

  describe("full lifecycle: spawn → watch → complete → materialize", () => {
    test("progresses through baseline, experiments, and completion with all callbacks firing", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 10,
      })

      // The daemon process spawned during spawn() exits immediately (no real daemon
      // in temp dir). Replace with a long-running process so poll() reports alive.
      const daemonProc = Bun.spawn(["sleep", "60"], { cwd: containerRoot })
      provider.setMainProcess(daemonProc)

      const runDir = remoteRunDir(handle.runId)
      const relRunDir = relativeRemoteRunDir(handle.runId)
      const states: RunState[] = []
      const resultSets: { length: number; lastMetric?: number }[] = []
      const streamChunks: string[] = []
      let streamResets = 0
      let daemonDied = false

      // --- Phase 1: Write baseline state + results ---
      const baselineState = makeState(handle.runId, {
        phase: "baseline",
        experiment_number: 0,
      })
      await Bun.write(join(runDir, "state.json"), JSON.stringify(baselineState))
      await Bun.write(join(runDir, "results.tsv"), TSV_HEADER + tsvRow(0, "aaa1111", 100, "keep", "baseline"))
      await Bun.write(join(runDir, "stream-000.log"), "Measuring baseline...\n")

      // --- Start watcher (use watchSandboxRunDir directly for fast polling + relative paths) ---
      const watcher = watchSandboxRunDir(provider, relRunDir, {
        onStateChange: (s) => states.push(s),
        onResultsChange: (results) => resultSets.push({
          length: results.length,
          lastMetric: results[results.length - 1]?.metric_value,
        }),
        onStreamChange: (text) => streamChunks.push(text),
        onStreamReset: () => { streamResets++ },
        onDaemonDied: () => { daemonDied = true },
      }, { pollIntervalMs: 100 })

      try {
        await delay(250)

        // Verify baseline state was picked up
        expect(states.length).toBeGreaterThan(0)
        expect(states[0].phase).toBe("baseline")
        expect(resultSets.length).toBeGreaterThan(0)
        expect(resultSets[0].length).toBe(1)
        expect(resultSets[0].lastMetric).toBe(100)
        expect(streamChunks.join("")).toContain("Measuring baseline")

        // --- Phase 2: Experiment 1 starts (agent_running) ---
        const exp1State = makeState(handle.runId, {
          phase: "agent_running",
          experiment_number: 1,
          current_baseline: 100,
        })
        await Bun.write(join(runDir, "state.json"), JSON.stringify(exp1State))
        await Bun.write(join(runDir, "stream-001.log"), "[tool] Editing src/main.ts\nMaking optimization changes...\n")
        await delay(250)

        // Experiment transition should fire stream reset
        expect(streamResets).toBeGreaterThanOrEqual(1)
        const statesAfterExp1 = states.filter((s) => s.experiment_number === 1)
        expect(statesAfterExp1.length).toBeGreaterThan(0)
        expect(statesAfterExp1[0].phase).toBe("agent_running")

        // --- Phase 3: Experiment 1 measured and kept ---
        const exp1Kept = makeState(handle.runId, {
          phase: "kept",
          experiment_number: 1,
          current_baseline: 95,
          best_metric: 95,
          best_experiment: 1,
          total_keeps: 1,
        })
        await Bun.write(join(runDir, "state.json"), JSON.stringify(exp1Kept))
        await appendFile(join(runDir, "results.tsv"), tsvRow(1, "bbb2222", 95, "keep", "optimized main loop"))
        await delay(250)

        // Verify results grew
        const lastResults = resultSets[resultSets.length - 1]
        expect(lastResults.length).toBe(2)
        expect(lastResults.lastMetric).toBe(95)

        // --- Phase 4: Experiment 2 runs and gets discarded ---
        const exp2State = makeState(handle.runId, {
          phase: "agent_running",
          experiment_number: 2,
        })
        await Bun.write(join(runDir, "state.json"), JSON.stringify(exp2State))
        await Bun.write(join(runDir, "stream-002.log"), "Trying a different approach...\n")
        await delay(250)

        const exp2Discarded = makeState(handle.runId, {
          phase: "measuring",
          experiment_number: 2,
          total_keeps: 1,
          total_discards: 1,
        })
        await Bun.write(join(runDir, "state.json"), JSON.stringify(exp2Discarded))
        await appendFile(join(runDir, "results.tsv"), tsvRow(2, "ccc3333", 110, "discard", "regression"))
        await delay(250)

        const resultsAfterDiscard = resultSets[resultSets.length - 1]
        expect(resultsAfterDiscard.length).toBe(3)

        // --- Phase 5: Run completes ---
        const completeState = makeState(handle.runId, {
          phase: "complete",
          experiment_number: 2,
          current_baseline: 95,
          best_metric: 95,
          best_experiment: 1,
          total_keeps: 1,
          total_discards: 1,
          termination_reason: "stopped",
        })
        await Bun.write(join(runDir, "state.json"), JSON.stringify(completeState))
        await Bun.write(join(runDir, "ideas.md"), "## Ideas\n- Try vectorization\n")
        await delay(250)

        const lastState = states[states.length - 1]
        expect(lastState.phase).toBe("complete")
        expect(lastState.best_metric).toBe(95)
        expect(lastState.total_keeps).toBe(1)
        expect(lastState.total_discards).toBe(1)

        // Stream content from each experiment should have been picked up
        const allStream = streamChunks.join("")
        expect(allStream).toContain("Measuring baseline")
        expect(allStream).toContain("Editing src/main.ts")
        expect(allStream).toContain("Trying a different approach")

        // Stream resets: exp 0→1 and exp 1→2
        expect(streamResets).toBeGreaterThanOrEqual(2)

        // Daemon should not have died (we never killed the container)
        expect(daemonDied).toBe(false)
      } finally {
        watcher.stop()
        daemonProc.kill()
        await daemonProc.exited.catch(() => {})
      }

      // --- Phase 6: Materialize artifacts to local ---
      await handle.materializeArtifacts()

      // Verify local files were downloaded
      const localState = await Bun.file(join(handle.runDir, "state.json")).json() as RunState
      expect(localState.phase).toBe("complete")
      expect(localState.best_metric).toBe(95)

      const localResults = await Bun.file(join(handle.runDir, "results.tsv")).text()
      expect(localResults).toContain("bbb2222")
      expect(localResults).toContain("ccc3333")

      const localIdeas = await Bun.file(join(handle.runDir, "ideas.md")).text()
      expect(localIdeas).toContain("Try vectorization")

      // Stream logs should be downloaded
      const localStream0 = await Bun.file(join(handle.runDir, "stream-000.log")).text()
      expect(localStream0).toContain("Measuring baseline")
      const localStream1 = await Bun.file(join(handle.runDir, "stream-001.log")).text()
      expect(localStream1).toContain("Editing src/main.ts")
    })

    test("fires onDaemonDied when container process exits mid-run", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      const runDir = remoteRunDir(handle.runId)
      const relRunDir = relativeRemoteRunDir(handle.runId)
      let daemonDied = false

      // Write initial state
      await Bun.write(join(runDir, "state.json"), JSON.stringify(
        makeState(handle.runId, { phase: "agent_running", experiment_number: 1 }),
      ))
      await Bun.write(join(runDir, "results.tsv"), TSV_HEADER + tsvRow(0, "aaa1111", 100, "keep", "baseline"))

      // Simulate the daemon process dying (terminate the container)
      await provider.terminate()

      const watcher = watchSandboxRunDir(provider, relRunDir, {
        onStateChange: () => {},
        onResultsChange: () => {},
        onStreamChange: () => {},
        onDaemonDied: () => { daemonDied = true },
      }, { pollIntervalMs: 100 })

      try {
        await delay(250)
        expect(daemonDied).toBe(true)

        // getStatus should also report not alive
        const status = await handle.getStatus()
        expect(status.alive).toBe(false)
      } finally {
        watcher.stop()
      }
    })

    test("sendControl writes stop signal that halts the run", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 10,
      })

      const daemonProc = Bun.spawn(["sleep", "60"], { cwd: containerRoot })
      provider.setMainProcess(daemonProc)

      const runDir = remoteRunDir(handle.runId)
      const relRunDir = relativeRemoteRunDir(handle.runId)
      const states: RunState[] = []

      // Start with an active experiment
      await Bun.write(join(runDir, "state.json"), JSON.stringify(
        makeState(handle.runId, { phase: "agent_running", experiment_number: 1 }),
      ))
      await Bun.write(join(runDir, "results.tsv"), TSV_HEADER + tsvRow(0, "aaa1111", 100, "keep", "baseline"))

      const watcher = watchSandboxRunDir(provider, relRunDir, {
        onStateChange: (s) => states.push(s),
        onResultsChange: () => {},
        onStreamChange: () => {},
        onDaemonDied: () => {},
      }, { pollIntervalMs: 100 })

      try {
        await delay(250)
        expect(states[0].phase).toBe("agent_running")

        // Send stop signal
        await handle.sendControl("stop")

        // Verify control.json was written in the container
        const controlFile = await Bun.file(join(runDir, "control.json")).json()
        expect(controlFile.action).toBe("stop")
        expect(controlFile.timestamp).toBeDefined()

        // Simulate daemon responding to stop
        await Bun.write(join(runDir, "state.json"), JSON.stringify(
          makeState(handle.runId, {
            phase: "complete",
            experiment_number: 1,
            total_keeps: 1,
            termination_reason: "stopped",
          }),
        ))
        await delay(250)

        const lastState = states[states.length - 1]
        expect(lastState.phase).toBe("complete")
        expect(lastState.termination_reason).toBe("stopped")
      } finally {
        watcher.stop()
        daemonProc.kill()
        await daemonProc.exited.catch(() => {})
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Test 2: Reconnection — detach → reattach → resume watching
  // ---------------------------------------------------------------------------

  describe("reconnection: detach → reattach → resume watching", () => {
    test("sandbox.json is persisted with correct provider identity after spawn", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider, "mock-test")
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      // sandbox.json should exist in local run dir with identity info
      const sandboxInfo = await Bun.file(join(handle.runDir, "sandbox.json")).json() as Record<string, string>
      expect(sandboxInfo.provider).toBe("mock-test")
      expect(sandboxInfo.program_slug).toBe("test-prog")
      expect(sandboxInfo.run_id).toBe(handle.runId)
      expect(sandboxInfo.created_at).toBeDefined()
    })

    test("findByMetadata locates container and reconstructState rebuilds full state", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 10,
      })

      const runDir = remoteRunDir(handle.runId)

      // Simulate a run that progressed through 3 experiments
      const state = makeState(handle.runId, {
        phase: "agent_running",
        experiment_number: 3,
        current_baseline: 85,
        best_metric: 85,
        best_experiment: 2,
        total_keeps: 2,
        total_discards: 1,
      })
      await Bun.write(join(runDir, "state.json"), JSON.stringify(state))
      await Bun.write(join(runDir, "results.tsv"),
        TSV_HEADER +
        tsvRow(0, "aaa1111", 100, "keep", "baseline") +
        tsvRow(1, "bbb2222", 92, "keep", "improved parsing") +
        tsvRow(2, "ccc3333", 105, "discard", "regression") +
        tsvRow(3, "ddd4444", 85, "keep", "optimized allocations"),
      )
      await Bun.write(join(runDir, "stream-003.log"), "Current experiment in progress...\n")
      await Bun.write(join(runDir, "ideas.md"), "- Try SIMD instructions\n")

      // --- Simulate TUI crash: provider stays in registry, we just lose our handle ---
      // In a real crash, the process dies but the container keeps running.
      // MockContainerProvider keeps the provider registered in its static registry.

      // Re-discover the container by metadata (this is what findActiveRun does internally)
      const containerHandle = await provider.findByMetadata({
        run_id: handle.runId,
        program_slug: "test-prog",
      })
      expect(containerHandle).not.toBeNull()

      // Attach to get the provider back
      const reattachedProvider = await containerHandle!.attach()
      expect(reattachedProvider).toBe(provider) // same instance

      // Reconstruct state through the original handle
      // (in production, a new SandboxRunHandle would be created with the reattached provider)
      const programDir = join(mainRoot, ".autoauto", "programs", "test-prog")
      const reconstructed = await handle.reconstructState(programDir)

      expect(reconstructed.state.phase).toBe("agent_running")
      expect(reconstructed.state.experiment_number).toBe(3)
      expect(reconstructed.state.best_metric).toBe(85)
      expect(reconstructed.results.length).toBe(4)
      expect(reconstructed.metricHistory).toEqual([100, 92, 85]) // only "keep" results
      expect(reconstructed.streamText).toContain("Current experiment in progress")
      expect(reconstructed.ideasText).toContain("SIMD instructions")
    })

    test("watcher resumes from current position after reconnect with startAtEnd", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 10,
      })

      const runDir = remoteRunDir(handle.runId)
      const relRunDir = relativeRemoteRunDir(handle.runId)

      // --- Phase 1: Write state as if 2 experiments already happened ---
      await Bun.write(join(runDir, "state.json"), JSON.stringify(
        makeState(handle.runId, {
          phase: "agent_running",
          experiment_number: 2,
          total_keeps: 1,
          total_discards: 1,
        }),
      ))
      await Bun.write(join(runDir, "results.tsv"),
        TSV_HEADER +
        tsvRow(0, "aaa1111", 100, "keep", "baseline") +
        tsvRow(1, "bbb2222", 95, "keep", "improvement"),
      )
      await Bun.write(join(runDir, "stream-002.log"), "Previous output before reconnect\n")

      // --- Phase 2: Start watcher with startAtEnd (simulates reconnect) ---
      // The watcher should skip existing content and only fire on NEW changes
      const states: RunState[] = []
      const resultSets: number[] = [] // track result counts
      const streamChunks: string[] = []

      const watcher = watchSandboxRunDir(provider, relRunDir, {
        onStateChange: (s) => states.push(s),
        onResultsChange: (results) => resultSets.push(results.length),
        onStreamChange: (text) => streamChunks.push(text),
        onDaemonDied: () => {},
      }, { pollIntervalMs: 100, startAtEnd: true })

      try {
        // Wait for initialization (reads offsets) and first no-op poll
        await delay(300)

        // startAtEnd should NOT have fired callbacks for existing content
        // (state change fires once because the watcher detects the initial state)
        const initialStreamContent = streamChunks.join("")
        expect(initialStreamContent).not.toContain("Previous output before reconnect")

        // --- Phase 3: Write NEW data (simulates progress after reconnect) ---
        await Bun.write(join(runDir, "state.json"), JSON.stringify(
          makeState(handle.runId, {
            phase: "measuring",
            experiment_number: 2,
            total_keeps: 2,
          }),
        ))
        await appendFile(join(runDir, "stream-002.log"), "New output after reconnect\n")
        await appendFile(join(runDir, "results.tsv"), tsvRow(2, "ccc3333", 88, "keep", "further optimization"))
        await delay(300)

        // New state change should be detected
        const lastState = states[states.length - 1]
        expect(lastState.phase).toBe("measuring")

        // New stream content should appear
        const allStream = streamChunks.join("")
        expect(allStream).toContain("New output after reconnect")

        // New results should be reported (full set including old ones)
        const lastResultCount = resultSets[resultSets.length - 1]
        expect(lastResultCount).toBe(3)
      } finally {
        watcher.stop()
      }
    })

    test("terminated container is not findable via metadata", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      // Container should be findable before termination
      const before = await provider.findByMetadata({
        run_id: handle.runId,
        program_slug: "test-prog",
      })
      expect(before).not.toBeNull()

      // Terminate the container
      await handle.terminate()

      // Container should NOT be findable after termination
      const after = await provider.findByMetadata({
        run_id: handle.runId,
        program_slug: "test-prog",
      })
      expect(after).toBeNull()

      // Status should report dead
      const status = await handle.getStatus()
      expect(status.alive).toBe(false)
    })

    test("reconstructState works correctly with large stream log truncation", async () => {
      await setup()

      const backend = new SandboxRunBackend(async () => provider)
      const handle = await backend.spawn({
        mainRoot,
        programSlug: "test-prog",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      const runDir = remoteRunDir(handle.runId)

      // Write state with a very large stream log (>8000 chars, triggers truncation)
      await Bun.write(join(runDir, "state.json"), JSON.stringify(
        makeState(handle.runId, { phase: "agent_running", experiment_number: 1 }),
      ))
      await Bun.write(join(runDir, "results.tsv"), TSV_HEADER + tsvRow(0, "aaa1111", 100, "keep", "baseline"))

      // Generate a 10KB stream log
      const longLine = "x".repeat(200) + "\n"
      const streamContent = "START_MARKER\n" + longLine.repeat(50) + "END_MARKER\n"
      await Bun.write(join(runDir, "stream-001.log"), streamContent)

      const programDir = join(mainRoot, ".autoauto", "programs", "test-prog")
      const reconstructed = await handle.reconstructState(programDir)

      // Stream should be truncated to ~6000 chars (tail)
      expect(reconstructed.streamText.length).toBeLessThanOrEqual(8000)
      // The end marker should be preserved (tail truncation keeps the end)
      expect(reconstructed.streamText).toContain("END_MARKER")
      // The start marker may be lost due to truncation
      expect(reconstructed.state.phase).toBe("agent_running")
    })
  })
})
