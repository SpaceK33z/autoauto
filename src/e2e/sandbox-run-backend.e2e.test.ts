import { describe, test, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MockContainerProvider } from "../lib/container-provider/mock.ts"
import { SandboxRunBackend } from "../lib/run-backend/sandbox.ts"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("SandboxRunBackend", () => {
  let mainRoot: string
  let containerRoot: string
  let provider: MockContainerProvider

  async function setup() {
    // Create a local git repo as the "project"
    mainRoot = await mkdtemp(join(tmpdir(), "sandbox-backend-main-"))
    containerRoot = await mkdtemp(join(tmpdir(), "sandbox-backend-container-"))
    await $`git init`.cwd(mainRoot).quiet()
    await $`git config user.email "test@test.com"`.cwd(mainRoot).quiet()
    await $`git config user.name "Test"`.cwd(mainRoot).quiet()
    await Bun.write(join(mainRoot, "README.md"), "# test\n")
    await $`git add -A`.cwd(mainRoot).quiet()
    await $`git commit -m "init"`.cwd(mainRoot).quiet()

    // Create .autoauto/programs/test-prog
    const programDir = join(mainRoot, ".autoauto", "programs", "test-prog")
    await mkdir(programDir, { recursive: true })
    await Bun.write(join(programDir, "config.json"), JSON.stringify({
      metric_field: "score",
      direction: "lower",
      noise_threshold: 0.02,
      repeats: 1,
      max_experiments: 5,
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

  test("spawn creates local run dir and uploads repo to container", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    // Run handle should have a valid runId and runDir
    expect(handle.runId).toMatch(/^\d{8}-\d{6}$/)
    expect(handle.runDir).toContain("test-prog")
    expect(handle.runDir).toContain(handle.runId)

    // Local run dir should exist
    expect(await Bun.file(join(handle.runDir, "results.tsv")).exists()).toBe(true)

    // Repo should be uploaded to container
    const result = await provider.exec(["git", "log", "--oneline"], { cwd: "/workspace" })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toContain("init")
  })

  test("sendControl writes control.json inside container", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    await handle.sendControl("stop")

    // control.json should exist in the remote run directory
    const remoteRunDir = join(containerRoot, "workspace", ".autoauto", "programs", "test-prog", "runs", handle.runId)
    const controlFile = await Bun.file(join(remoteRunDir, "control.json")).json()
    expect(controlFile.action).toBe("stop")
  })

  test("updateMaxExperiments modifies run-config.json in container", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    await handle.updateMaxExperiments(20)

    const remoteRunDir = join(containerRoot, "workspace", ".autoauto", "programs", "test-prog", "runs", handle.runId)
    const config = await Bun.file(join(remoteRunDir, "run-config.json")).json()
    expect(config.max_experiments).toBe(20)
  })

  test("getStatus reports status from container", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    const status = await handle.getStatus()
    // Container is alive (no main process set, poll returns null)
    expect(status.alive).toBe(true)
  })

  test("terminate stops the container", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    await handle.terminate()

    const status = await handle.getStatus()
    expect(status.alive).toBe(false)
  })

  test("materializeArtifacts downloads run files to local", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    // Write some state files in the container's run directory
    const remoteRunDir = join(containerRoot, "workspace", ".autoauto", "programs", "test-prog", "runs", handle.runId)
    await Bun.write(join(remoteRunDir, "state.json"), JSON.stringify({
      run_id: handle.runId,
      program_slug: "test-prog",
      phase: "complete",
      experiment_number: 2,
    }, null, 2))

    await handle.materializeArtifacts()

    // Local run dir should now have the state file
    const localState = await Bun.file(join(handle.runDir, "state.json")).json()
    expect(localState.phase).toBe("complete")
    expect(localState.experiment_number).toBe(2)
  })

  test("reconstructState reads files from container", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    // Write state and results in the container
    const remoteRunDir = join(containerRoot, "workspace", ".autoauto", "programs", "test-prog", "runs", handle.runId)
    await Bun.write(join(remoteRunDir, "state.json"), JSON.stringify({
      run_id: handle.runId,
      program_slug: "test-prog",
      phase: "complete",
      experiment_number: 1,
      original_baseline: 100,
      current_baseline: 95,
      best_metric: 90,
      best_experiment: 1,
      total_keeps: 1,
      total_discards: 0,
      total_crashes: 0,
      branch_name: "autoauto-test",
      original_baseline_sha: "abc1234",
      last_known_good_sha: "def5678",
      candidate_sha: null,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, null, 2))

    // Write results.tsv with header + one row
    await Bun.write(join(remoteRunDir, "results.tsv"),
      "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n" +
      "0\tabc1234\t100\t\tkeep\tbaseline\t5000\t\n")

    // Write stream log
    await Bun.write(join(remoteRunDir, "stream-001.log"), "agent output here\n")

    const programDir = join(mainRoot, ".autoauto", "programs", "test-prog")
    const reconstructed = await handle.reconstructState(programDir)

    expect(reconstructed.state.phase).toBe("complete")
    expect(reconstructed.results.length).toBe(1)
    expect(reconstructed.results[0].metric_value).toBe(100)
    expect(reconstructed.metricHistory).toEqual([100])
    expect(reconstructed.streamText).toContain("agent output here")
  })

  test("watch fires callbacks from container files", async () => {
    await setup()

    const backend = new SandboxRunBackend(async () => provider)
    const handle = await backend.spawn({
      mainRoot,
      programSlug: "test-prog",
      modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
      maxExperiments: 5,
    })

    // Write initial state in container
    const remoteRunDir = join(containerRoot, "workspace", ".autoauto", "programs", "test-prog", "runs", handle.runId)
    await Bun.write(join(remoteRunDir, "state.json"), JSON.stringify({
      run_id: handle.runId,
      program_slug: "test-prog",
      phase: "baseline",
      experiment_number: 0,
    }))

    const states: any[] = []
    const watcher = await handle.watch({
      onStateChange: (s) => states.push(s),
      onResultsChange: () => {},
      onStreamChange: () => {},
      onDaemonDied: () => {},
    })

    try {
      await delay(250)
      expect(states.length).toBeGreaterThan(0)
      expect(states[0].phase).toBe("baseline")
    } finally {
      watcher.stop()
    }
  })
})
