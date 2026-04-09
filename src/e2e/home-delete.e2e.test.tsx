import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"
import { resetProjectRoot } from "../lib/programs.ts"
import { createTestFixture, branchExists, type TestFixture } from "./fixture.ts"

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.destroy()
  harness = null
  resetProjectRoot()
})

describe("HomeScreen — delete program", () => {
  let fixture: TestFixture

  beforeEach(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("deletable-prog", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("d on program shows delete confirmation", async () => {
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
    await harness.waitForText("deletable-prog")
    await harness.press("d")
    const frame = await harness.waitForText("Delete this program?")
    expect(frame).toContain("deletable-prog")
    expect(frame).toContain("Enter to confirm")
  })

  test("d then Enter deletes program", async () => {
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
    await harness.waitForText("deletable-prog")
    await harness.press("d")
    await harness.waitForText("Delete this program?")
    await harness.enter()
    const frame = await harness.waitForText("No programs yet")
    expect(frame).toContain("No programs yet")
  })

  test("d then Escape cancels delete", async () => {
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
    await harness.waitForText("deletable-prog")
    await harness.press("d")
    await harness.waitForText("Delete this program?")
    await harness.escape()
    const frame = await harness.frame()
    expect(frame).toContain("deletable-prog")
    expect(frame).not.toContain("Delete this program?")
  })

  test("d then n cancels delete", async () => {
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
    await harness.waitForText("deletable-prog")
    await harness.press("d")
    await harness.waitForText("Delete this program?")
    await harness.press("n")
    const frame = await harness.frame()
    expect(frame).toContain("deletable-prog")
    expect(frame).not.toContain("Delete this program?")
  })
})

describe("HomeScreen — delete run", () => {
  let fixture: TestFixture

  beforeEach(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("run-prog", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    await fixture.createRun("run-prog", {
      run_id: "20260401-100000",
      phase: "complete",
      total_keeps: 3,
      total_discards: 1,
      termination_reason: "max_experiments",
    })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("d on run shows delete confirmation", async () => {
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
    await harness.waitForText("run-prog")
    await harness.tab()
    await harness.press("d")
    const frame = await harness.waitForText("Delete this run?")
    expect(frame).toContain("20260401-100000")
    expect(frame).toContain("Enter to confirm")
  })

  test("d then Enter deletes run", async () => {
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
    await harness.waitForText("run-prog")
    await harness.tab()
    await harness.press("d")
    await harness.waitForText("Delete this run?")
    await harness.enter()
    const frame = await harness.waitForText("No runs yet", 5000)
    expect(frame).toContain("No runs yet")
  })
})

describe("HomeScreen — active run blocks", () => {
  let fixture: TestFixture

  beforeAll(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("active-prog", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    await fixture.createRun("active-prog", {
      run_id: "20260401-200000",
      phase: "idle",
      experiment_number: 3,
    })
  })

  afterAll(async () => {
    await fixture.cleanup()
  })

  test("d does not show dialog for program with active run", async () => {
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
    await harness.waitForText("active-prog")
    await harness.press("d")
    const frame = await harness.frame()
    expect(frame).not.toContain("Delete this program?")
    expect(frame).toContain("Cannot edit/delete while run is active")
  })

  test("e does not trigger update for program with active run", async () => {
    let editedSlug: string | null = null
    harness = await renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={(slug) => { editedSlug = slug }}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
    await harness.waitForText("active-prog")
    await harness.press("e")
    expect(editedSlug).toBeNull()
  })
})

describe("HomeScreen — delete run cleans up git branch", () => {
  let fixture: TestFixture
  const BRANCH = "autoauto-git-prog-20260401-300000"

  beforeEach(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("git-prog", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    await fixture.createRun("git-prog", {
      run_id: "20260401-300000",
      phase: "complete",
      total_keeps: 2,
      termination_reason: "max_experiments",
      createGitBranch: true,
      commitCount: 2,
    })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("git branch exists before deletion", async () => {
    expect(await branchExists(fixture.cwd, BRANCH)).toBe(true)
  })

  test("deleting run removes git branch", async () => {
    expect(await branchExists(fixture.cwd, BRANCH)).toBe(true)

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
    await harness.waitForText("git-prog")
    await harness.tab() // → runs panel
    await harness.press("d")
    await harness.waitForText("Delete this run?")
    await harness.enter()
    await harness.waitForText("No runs yet", 5000)
    expect(await branchExists(fixture.cwd, BRANCH)).toBe(false)
  })
})

describe("HomeScreen — delete program cleans up git branches", () => {
  let fixture: TestFixture
  const BRANCH_1 = "autoauto-multi-prog-20260401-400000"
  const BRANCH_2 = "autoauto-multi-prog-20260401-400001"

  beforeEach(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("multi-prog", {
      metric_field: "score",
      direction: "lower",
      max_experiments: 10,
    })
    await fixture.createRun("multi-prog", {
      run_id: "20260401-400000",
      phase: "complete",
      total_keeps: 1,
      termination_reason: "max_experiments",
      createGitBranch: true,
      commitCount: 1,
    })
    await fixture.createRun("multi-prog", {
      run_id: "20260401-400001",
      phase: "complete",
      total_keeps: 3,
      termination_reason: "max_experiments",
      createGitBranch: true,
      commitCount: 2,
    })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("deleting program removes all git branches", async () => {
    expect(await branchExists(fixture.cwd, BRANCH_1)).toBe(true)
    expect(await branchExists(fixture.cwd, BRANCH_2)).toBe(true)

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
    await harness.waitForText("multi-prog")
    await harness.press("d")
    await harness.waitForText("Delete this program?")
    await harness.enter()
    await harness.waitForText("No programs yet", 5000)
    expect(await branchExists(fixture.cwd, BRANCH_1)).toBe(false)
    expect(await branchExists(fixture.cwd, BRANCH_2)).toBe(false)
  })
})
