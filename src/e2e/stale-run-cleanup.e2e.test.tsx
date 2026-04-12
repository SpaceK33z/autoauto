import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import { resetProjectRoot } from "../lib/programs.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { readState } from "../lib/run.ts"

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

describe("Stale run cleanup on HomeScreen load", () => {
  let fixture: TestFixture

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("run stuck in agent_running with dead daemon is marked crashed", async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("stale-prog", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    const runDir = await fixture.createRun("stale-prog", {
      run_id: "20260401-100000",
      phase: "agent_running",
      experiment_number: 2,
      total_keeps: 0,
      total_discards: 1,
    })

    // Write a daemon.json with a dead PID and stale heartbeat to simulate crash
    await Bun.write(
      join(runDir, "daemon.json"),
      JSON.stringify({
        run_id: "20260401-100000",
        pid: 999999, // non-existent PID
        started_at: "2026-04-01T10:00:00.000Z",
        worktree_path: "/tmp/nonexistent-worktree",
        daemon_id: "test-dead-daemon",
        heartbeat_at: "2026-04-01T10:05:00.000Z", // stale
      }),
    )

    // Verify state is agent_running before loading HomeScreen
    const before = await readState(runDir)
    expect(before.phase).toBe("agent_running")

    // Loading the HomeScreen triggers cleanupStaleRuns
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    await harness.waitForText("stale-prog")

    // Verify state was cleaned up on disk
    const after = await readState(runDir)
    expect(after.phase).toBe("crashed")
    expect(after.error_phase).toBe("agent_running")
  })

  test("stale run becomes deletable after cleanup", async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("del-stale", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    const runDir = await fixture.createRun("del-stale", {
      run_id: "20260401-200000",
      phase: "measuring",
      experiment_number: 3,
    })

    // Write a daemon.json with dead PID
    await Bun.write(
      join(runDir, "daemon.json"),
      JSON.stringify({
        run_id: "20260401-200000",
        pid: 999999,
        started_at: "2026-04-01T10:00:00.000Z",
        worktree_path: "/tmp/nonexistent-worktree",
        daemon_id: "test-dead-daemon-2",
        heartbeat_at: "2026-04-01T10:05:00.000Z",
      }),
    )

    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    await harness.waitForText("del-stale")

    // Tab to runs panel, try to delete
    await harness.tab()
    await harness.press("d")
    const frame = await harness.waitForText("Delete this run?")
    expect(frame).toContain("20260401-200000")
  })

  test("run without daemon.json is NOT cleaned up", async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("no-daemon", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    const runDir = await fixture.createRun("no-daemon", {
      run_id: "20260401-300000",
      phase: "idle",
      experiment_number: 3,
    })

    // No daemon.json — should not be cleaned up
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    await harness.waitForText("no-daemon")

    // State should remain idle (not cleaned up)
    const after = await readState(runDir)
    expect(after.phase).toBe("idle")
  })
})
