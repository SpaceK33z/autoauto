import { describe, test, expect, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MockContainerProvider } from "../lib/container-provider/mock.ts"
import { watchSandboxRunDir } from "../lib/sandbox-watcher.ts"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("sandbox-watcher", () => {
  let rootDir: string
  let provider: MockContainerProvider
  const runDir = "runs/test-run"

  async function setup() {
    rootDir = await mkdtemp(join(tmpdir(), "sandbox-watcher-test-"))
    provider = new MockContainerProvider({ rootDir })
    const fullRunDir = join(rootDir, runDir)
    await mkdir(fullRunDir, { recursive: true })
  }

  afterEach(async () => {
    MockContainerProvider.clearRegistry()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  test("fires onStateChange when state.json changes", async () => {
    await setup()
    const states: any[] = []

    // Write initial state
    const state = {
      run_id: "test",
      program_slug: "prog",
      phase: "baseline",
      experiment_number: 0,
    }
    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify(state))
    // Write results header so TSV parsing doesn't error
    await Bun.write(join(rootDir, runDir, "results.tsv"), "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n")

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: (s) => states.push(s),
      onResultsChange: () => {},
      onStreamChange: () => {},
      onDaemonDied: () => {},
    }, { pollIntervalMs: 100 })

    try {
      await delay(250)
      expect(states.length).toBeGreaterThan(0)
      expect(states[0].phase).toBe("baseline")

      // Update state
      await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({ ...state, phase: "agent_running" }))
      await delay(250)
      const latestState = states[states.length - 1]
      expect(latestState.phase).toBe("agent_running")
    } finally {
      watcher.stop()
    }
  })

  test("fires onResultsChange with new rows", async () => {
    await setup()
    const resultSets: any[][] = []

    // Write state and results header
    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
      run_id: "test", program_slug: "prog", phase: "idle", experiment_number: 0,
    }))
    const header = "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n"
    const row0 = "0\tabc1234\t100\t\tkeep\tbaseline\t5000\t\n"
    await Bun.write(join(rootDir, runDir, "results.tsv"), header + row0)

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: () => {},
      onResultsChange: (results) => resultSets.push([...results]),
      onStreamChange: () => {},
      onDaemonDied: () => {},
    }, { pollIntervalMs: 100 })

    try {
      await delay(250)
      expect(resultSets.length).toBeGreaterThan(0)
      expect(resultSets[0].length).toBe(1)
      expect(resultSets[0][0].metric_value).toBe(100)

      // Append a new result row
      const { appendFile } = await import("node:fs/promises")
      await appendFile(join(rootDir, runDir, "results.tsv"), "1\tdef5678\t95\t\tkeep\timproved\t4000\t\n")
      await delay(250)

      const latest = resultSets[resultSets.length - 1]
      expect(latest.length).toBe(2)
      expect(latest[1].metric_value).toBe(95)
    } finally {
      watcher.stop()
    }
  })

  test("fires onStreamChange with delta bytes", async () => {
    await setup()
    const streamChunks: string[] = []

    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
      run_id: "test", program_slug: "prog", phase: "agent_running", experiment_number: 1,
    }))
    await Bun.write(join(rootDir, runDir, "results.tsv"), "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n")
    await Bun.write(join(rootDir, runDir, "stream-001.log"), "initial output\n")

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: () => {},
      onResultsChange: () => {},
      onStreamChange: (text) => streamChunks.push(text),
      onDaemonDied: () => {},
    }, { pollIntervalMs: 100 })

    try {
      await delay(250)
      // Should have received initial content
      expect(streamChunks.length).toBeGreaterThan(0)
      expect(streamChunks.join("")).toContain("initial output")

      // Append more content
      const { appendFile } = await import("node:fs/promises")
      await appendFile(join(rootDir, runDir, "stream-001.log"), "more output\n")
      await delay(250)

      const allText = streamChunks.join("")
      expect(allText).toContain("more output")
    } finally {
      watcher.stop()
    }
  })

  test("fires onStreamReset on experiment number change", async () => {
    await setup()
    let resetFired = false

    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
      run_id: "test", program_slug: "prog", phase: "agent_running", experiment_number: 1,
    }))
    await Bun.write(join(rootDir, runDir, "results.tsv"), "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n")
    await Bun.write(join(rootDir, runDir, "stream-001.log"), "exp 1 output\n")

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: () => {},
      onResultsChange: () => {},
      onStreamChange: () => {},
      onStreamReset: () => { resetFired = true },
      onDaemonDied: () => {},
    }, { pollIntervalMs: 100 })

    try {
      await delay(250)

      // Change experiment number
      await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
        run_id: "test", program_slug: "prog", phase: "agent_running", experiment_number: 2,
      }))
      await Bun.write(join(rootDir, runDir, "stream-002.log"), "exp 2 output\n")
      await delay(250)

      expect(resetFired).toBe(true)
    } finally {
      watcher.stop()
    }
  })

  test("fires onDaemonDied when process exits", async () => {
    await setup()
    let died = false

    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
      run_id: "test", program_slug: "prog", phase: "agent_running", experiment_number: 0,
    }))
    await Bun.write(join(rootDir, runDir, "results.tsv"), "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n")

    // Start a process that exits quickly
    const proc = Bun.spawn(["sh", "-c", "exit 0"], { cwd: rootDir })
    provider.setMainProcess(proc)
    await proc.exited

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: () => {},
      onResultsChange: () => {},
      onStreamChange: () => {},
      onDaemonDied: () => { died = true },
    }, { pollIntervalMs: 100 })

    try {
      await delay(250)
      expect(died).toBe(true)
    } finally {
      watcher.stop()
    }
  })

  test("stop prevents further callbacks", async () => {
    await setup()
    let callCount = 0

    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
      run_id: "test", program_slug: "prog", phase: "idle", experiment_number: 0,
    }))
    await Bun.write(join(rootDir, runDir, "results.tsv"), "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n")

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: () => { callCount++ },
      onResultsChange: () => {},
      onStreamChange: () => {},
      onDaemonDied: () => {},
    }, { pollIntervalMs: 100 })

    await delay(250)
    watcher.stop()
    const countAfterStop = callCount
    await delay(300)
    expect(callCount).toBe(countAfterStop)
  })

  test("extracts tool status from stream", async () => {
    await setup()
    let lastTool: string | null = null

    await Bun.write(join(rootDir, runDir, "state.json"), JSON.stringify({
      run_id: "test", program_slug: "prog", phase: "agent_running", experiment_number: 1,
    }))
    await Bun.write(join(rootDir, runDir, "results.tsv"), "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n")
    await Bun.write(join(rootDir, runDir, "stream-001.log"), "[tool] Running build.sh\n")

    const watcher = watchSandboxRunDir(provider, runDir, {
      onStateChange: () => {},
      onResultsChange: () => {},
      onStreamChange: () => {},
      onToolStatus: (status) => { lastTool = status },
      onDaemonDied: () => {},
    }, { pollIntervalMs: 100 })

    try {
      await delay(250)
      expect(lastTool).toBe("Running build.sh")
    } finally {
      watcher.stop()
    }
  })
})
