import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { renderTui, type TuiHarness } from "./helpers.ts"
import { ExecutionScreen } from "../screens/ExecutionScreen.tsx"
import { createTestFixture, type TestFixture, type ResultFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import type { Screen } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"
import type { DaemonJson } from "../lib/daemon-lifecycle.ts"

const MODEL = DEFAULT_CONFIG.executionModel

const RESULTS: ResultFixture[] = [
  { experiment_number: 1, commit: "abc1111", metric_value: 95, status: "keep", description: "Optimize hot path" },
  { experiment_number: 2, commit: "abc2222", metric_value: 110, status: "discard", description: "Try caching" },
  { experiment_number: 3, commit: "abc3333", metric_value: 88, status: "keep", description: "Reduce allocations" },
  { experiment_number: 4, commit: "abc4444", metric_value: 85, status: "keep", description: "Inline small functions" },
  { experiment_number: 5, commit: "abc5555", metric_value: 92, status: "discard", description: "Batch IO ops" },
]

let fixture: TestFixture
let harness: TuiHarness | null = null

beforeAll(async () => {
  registerMockProviders()
  fixture = await createTestFixture()

  await fixture.createProgram("perf-opt", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 10,
  })
  await fixture.createRun("perf-opt", {
    run_id: "20260401-100000",
    phase: "complete",
    experiment_number: 5,
    best_metric: 85,
    best_experiment: 4,
    total_keeps: 3,
    total_discards: 2,
    total_crashes: 0,
    termination_reason: "max_experiments",
    results: RESULTS,
  })
})

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

afterAll(async () => {
  await fixture.cleanup()
})

function renderExecution(navigateFn: (s: Screen) => void = () => {}) {
  return renderTui(
    <ExecutionScreen
      cwd={fixture.cwd}
      programSlug="perf-opt"
      modelConfig={MODEL}
      supportModelConfig={MODEL}
      ideasBacklogEnabled={false}
      navigate={navigateFn}
      maxExperiments={10}
      attachRunId="20260401-100000"
      readOnly
    />,
    { width: 140, height: 40 },
  )
}

function renderExecutionCompact(navigateFn: (s: Screen) => void = () => {}) {
  return renderTui(
    <ExecutionScreen
      cwd={fixture.cwd}
      programSlug="perf-opt"
      modelConfig={MODEL}
      supportModelConfig={MODEL}
      ideasBacklogEnabled={false}
      navigate={navigateFn}
      maxExperiments={10}
      attachRunId="20260401-100000"
      readOnly
    />,
    { width: 120, height: 12 },
  )
}

describe("ExecutionScreen E2E — attach to completed run", () => {
  test("displays completed run with results", async () => {
    harness = await renderExecution()
    // Wait for state reconstruction — results only appear after async load
    const frame = await harness.waitForText("Optimize hot path", 5000)
    expect(frame).toContain("keep")
    expect(frame).toContain("discard")
  })

  test("shows stats header with experiment counts", async () => {
    harness = await renderExecution()
    const frame = await harness.waitForText("kept 3", 5000)
    expect(frame).toContain("disc 2")
  })

  test("Tab then j navigates results table", async () => {
    harness = await renderExecution()
    await harness.waitForText("Optimize hot path", 5000)
    await harness.tab()
    await harness.press("j")
    const frame = await harness.frame()
    expect(frame).toContain("Optimize hot path")
  })

  test("Escape navigates home from completed run", async () => {
    let lastNav: Screen | null = null
    harness = await renderExecution((s) => { lastNav = s })
    await harness.waitForText("kept 3", 5000)
    await harness.escape()
    expect(lastNav).toBe("home")
  })

  test("shows keyboard shortcuts bar at the bottom", async () => {
    harness = await renderExecution()
    await harness.waitForText("kept 3", 5000)
    const frame = await harness.frame()
    expect(frame).toContain("Esc back")
    expect(frame).toContain("f finalize")
  })

  test("keeps results area stable in short terminals", async () => {
    harness = await renderExecutionCompact()
    // Wait for completed state to load (stats header shows "kept 3" once run data is reconstructed)
    const frame = await harness.waitForText("kept 3", 5000)
    const lines = frame.split("\n")
    const resultsLine = lines.find((line) => line.includes("Results"))
    const headerLine = lines.find((line) => line.includes("commit"))

    expect(resultsLine).toBeDefined()
    expect(headerLine).toBeDefined()
    // Verify no text overlap between adjacent rows
    expect(resultsLine).not.toContain("kept")
    expect(resultsLine).not.toContain("disc")
    expect(headerLine).not.toContain("baseline")
    expect(headerLine).not.toContain("best")
  })
})

describe("ExecutionScreen E2E — narrow tab click switching", () => {
  let ideasFixture: TestFixture
  let ideasHarness: TuiHarness | null = null

  beforeAll(async () => {
    registerMockProviders()
    ideasFixture = await createTestFixture()

    await ideasFixture.createProgram("perf-opt", {
      metric_field: "latency_ms",
      direction: "lower",
      max_experiments: 10,
    })
    const runDir = await ideasFixture.createRun("perf-opt", {
      run_id: "20260401-100000",
      phase: "complete",
      experiment_number: 3,
      best_metric: 85,
      best_experiment: 2,
      total_keeps: 2,
      total_discards: 1,
      total_crashes: 0,
      termination_reason: "max_experiments",
      results: RESULTS.slice(0, 3),
    })
    // Write ideas.md so the Ideas panel is visible
    await Bun.write(join(runDir, "ideas.md"), "# Ideas\n\n- Try caching\n- Reduce allocations\n")
  })

  afterEach(async () => {
    await ideasHarness?.destroy()
    ideasHarness = null
    resetProjectRoot()
  })

  afterAll(async () => {
    await ideasFixture.cleanup()
  })

  function renderNarrowWithIdeas() {
    return renderTui(
      <ExecutionScreen
        cwd={ideasFixture.cwd}
        programSlug="perf-opt"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={true}
        navigate={() => {}}
        maxExperiments={10}
        attachRunId="20260401-100000"
        readOnly
      />,
      { width: 60, height: 30 },
    )
  }

  /** Find the line index and text containing the tab title pattern */
  function findTitleRow(frame: string): { lineIndex: number; line: string } | null {
    const lines = frame.split("\n")
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("Agent") && lines[i].includes("Ideas") && (lines[i].includes("[") || lines[i].includes("]"))) {
        return { lineIndex: i, line: lines[i] }
      }
    }
    return null
  }

  test("clicking Ideas label in title switches to Ideas tab", async () => {
    ideasHarness = await renderNarrowWithIdeas()
    const frame = await ideasHarness.waitForText("[Agent] Ideas", 5000)

    // Default tab is agent: title shows "[Agent] Ideas"
    const titleRow = findTitleRow(frame)
    expect(titleRow).not.toBeNull()

    // Click on the "Ideas" text. Title is "[Agent] Ideas" starting at offset 2 from box edge.
    // "[Agent]" = 7 chars, " " = 1 char → Ideas starts at offset 10 from box x.
    // The box is inside the layout — find x position of "Ideas" in the title row.
    const ideasOffset = titleRow!.line.indexOf("Ideas")
    expect(ideasOffset).toBeGreaterThan(-1)
    await ideasHarness.click(ideasOffset, titleRow!.lineIndex)

    const afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("Agent [Ideas]")
  })

  test("clicking Agent label in title switches back to Agent tab", async () => {
    ideasHarness = await renderNarrowWithIdeas()
    await ideasHarness.waitForText("[Agent] Ideas", 5000)

    // Switch to Ideas first via keyboard
    await ideasHarness.press("]")
    const switched = await ideasHarness.frame()
    expect(switched).toContain("Agent [Ideas]")

    // Now click on "Agent" text to switch back
    const titleRow = findTitleRow(switched)
    expect(titleRow).not.toBeNull()
    const agentOffset = titleRow!.line.indexOf("Agent")
    expect(agentOffset).toBeGreaterThan(-1)
    await ideasHarness.click(agentOffset, titleRow!.lineIndex)

    const afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("[Agent] Ideas")
  })

  test("clicking at the boundary between Agent and Ideas labels", async () => {
    ideasHarness = await renderNarrowWithIdeas()
    const frame = await ideasHarness.waitForText("[Agent] Ideas", 5000)
    const titleRow = findTitleRow(frame)
    expect(titleRow).not.toBeNull()

    // Title is "[Agent] Ideas". Find exact positions in the rendered line.
    const agentStart = titleRow!.line.indexOf("[Agent]")
    const ideasStart = titleRow!.line.indexOf("Ideas")
    expect(agentStart).toBeGreaterThan(-1)
    expect(ideasStart).toBeGreaterThan(-1)

    // Click on the last character of "[Agent]" (the ']') — should still select Agent
    const lastAgentChar = agentStart + "[Agent]".length - 1
    await ideasHarness.click(lastAgentChar, titleRow!.lineIndex)
    let afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("[Agent] Ideas")

    // Click on the space between "]" and "Ideas" — should select Agent (falls in agent region)
    await ideasHarness.click(lastAgentChar + 1, titleRow!.lineIndex)
    afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("[Agent] Ideas")

    // Click on the first character of "Ideas" — should switch to Ideas
    await ideasHarness.click(ideasStart, titleRow!.lineIndex)
    afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("Agent [Ideas]")

    // Now title is "Agent [Ideas]" — verify boundary in this state too
    const newTitleRow = findTitleRow(afterClick)
    expect(newTitleRow).not.toBeNull()
    const newAgentStart = newTitleRow!.line.indexOf("Agent")
    const newIdeasBracket = newTitleRow!.line.indexOf("[Ideas]")
    expect(newAgentStart).toBeGreaterThan(-1)
    expect(newIdeasBracket).toBeGreaterThan(-1)

    // Click on the last char of "Agent" — should switch back to Agent
    const lastNewAgentChar = newAgentStart + "Agent".length - 1
    await ideasHarness.click(lastNewAgentChar, newTitleRow!.lineIndex)
    afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("[Agent] Ideas")

    // Switch to ideas again, then click on "[" of "[Ideas]" — should select Ideas
    await ideasHarness.press("]")
    afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("Agent [Ideas]")
    const finalTitleRow = findTitleRow(afterClick)!
    const bracketPos = finalTitleRow.line.indexOf("[Ideas]")
    await ideasHarness.click(bracketPos, finalTitleRow.lineIndex)
    afterClick = await ideasHarness.frame()
    expect(afterClick).toContain("Agent [Ideas]")
  })
})

describe("ExecutionScreen E2E — attach phase label updates from Connecting", () => {
  let attachFixture: TestFixture
  let attachHarness: TuiHarness | null = null

  beforeAll(async () => {
    registerMockProviders()
    attachFixture = await createTestFixture()

    await attachFixture.createProgram("running-prog", {
      metric_field: "latency_ms",
      direction: "lower",
      max_experiments: 10,
    })

    // Create a run in "idle" phase (daemon actively running experiments)
    const runDir = await attachFixture.createRun("running-prog", {
      run_id: "20260401-200000",
      phase: "idle",
      experiment_number: 3,
      best_metric: 85,
      best_experiment: 2,
      total_keeps: 2,
      total_discards: 1,
      total_crashes: 0,
      results: RESULTS.slice(0, 3),
    })

    // Write daemon.json with current process PID + fresh heartbeat
    // so getDaemonStatus considers the daemon alive
    const daemonJson: DaemonJson = {
      run_id: "20260401-200000",
      pid: process.pid,
      started_at: new Date().toISOString(),
      worktree_path: attachFixture.cwd,
      daemon_id: "test-daemon-id",
      heartbeat_at: new Date().toISOString(),
    }
    await Bun.write(join(runDir, "daemon.json"), JSON.stringify(daemonJson, null, 2) + "\n")

    // Write run-config.json (required by watcher/status checks)
    await Bun.write(join(runDir, "run-config.json"), JSON.stringify({
      provider: "claude",
      model: "sonnet",
      effort: "high",
      max_experiments: 10,
    }, null, 2) + "\n")
  })

  afterEach(async () => {
    await attachHarness?.destroy()
    attachHarness = null
    resetProjectRoot()
  })

  afterAll(async () => {
    await attachFixture.cleanup()
  })

  test("phase label updates from 'Connecting...' to actual phase after attach", async () => {
    attachHarness = await renderTui(
      <ExecutionScreen
        cwd={attachFixture.cwd}
        programSlug="running-prog"
        modelConfig={MODEL}
        supportModelConfig={MODEL}
        ideasBacklogEnabled={false}
        navigate={() => {}}
        maxExperiments={10}
        attachRunId="20260401-200000"
      />,
      { width: 140, height: 40 },
    )

    // The phase label should update to "Running experiments..." (the label for "idle" phase)
    // and NOT stay stuck on "Connecting..."
    const frame = await attachHarness.waitForText("Running experiments...", 5000)
    expect(frame).not.toContain("Connecting...")
  })
})
