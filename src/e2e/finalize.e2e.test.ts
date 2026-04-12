import { describe, test, expect, afterEach } from "bun:test"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { buildFinalizeContext, buildFinalizeInitialMessage } from "../lib/finalize.ts"
import { loadProgramConfig } from "../lib/programs.ts"
import type { RunState } from "../lib/run.ts"
import { join } from "node:path"

describe("finalize with removed worktree", () => {
  let fixture: TestFixture

  afterEach(async () => {
    await fixture?.cleanup()
  })

  test("buildFinalizeContext succeeds when worktree is gone and headRef is branch name", async () => {
    fixture = await createTestFixture()
    const programDir = await fixture.createProgram("perf", {
      metric_field: "score",
      direction: "lower",
    })
    const runDir = await fixture.createRun("perf", {
      run_id: "20260412-190000",
      phase: "complete",
      experiment_number: 2,
      best_metric: 90,
      best_experiment: 1,
      total_keeps: 1,
      total_discards: 1,
      createGitBranch: true,
      commitCount: 2,
      results: [
        { experiment_number: 1, commit: "aaa1111", metric_value: 90, status: "keep", description: "opt 1" },
        { experiment_number: 2, commit: "bbb2222", metric_value: 105, status: "discard", description: "opt 2" },
      ],
    })

    const config = await loadProgramConfig(programDir)
    const state: RunState = await Bun.file(join(runDir, "state.json")).json()

    // Simulate worktree being removed: use the main checkout (fixture.cwd)
    // and pass the branch name as headRef instead of "HEAD"
    const context = await buildFinalizeContext(
      fixture.cwd,
      runDir,
      state,
      config,
      fixture.cwd,
      state.branch_name,
    )

    expect(context.changedFiles.length).toBeGreaterThan(0)
    expect(context.results.length).toBe(2)

    const message = await buildFinalizeInitialMessage(context, state.branch_name)
    expect(message).toContain("perf")
    expect(message).toContain("Changed Files")
    expect(message).toContain("Full Diff")
    // The diff should show actual experiment commits, not be empty
    expect(message).not.toContain("```diff\n\n```")
  })

  test("buildFinalizeContext fails when worktree path does not exist and HEAD is used", async () => {
    fixture = await createTestFixture()
    const programDir = await fixture.createProgram("perf", {
      metric_field: "score",
      direction: "lower",
    })
    const runDir = await fixture.createRun("perf", {
      run_id: "20260412-190001",
      phase: "complete",
      experiment_number: 1,
      best_metric: 90,
      best_experiment: 1,
      total_keeps: 1,
      createGitBranch: true,
      commitCount: 1,
      results: [
        { experiment_number: 1, commit: "aaa1111", metric_value: 90, status: "keep", description: "opt 1" },
      ],
    })

    const config = await loadProgramConfig(programDir)
    const state: RunState = await Bun.file(join(runDir, "state.json")).json()

    // Using a nonexistent worktree path should fail
    const fakeWorktreePath = join(fixture.cwd, ".autoauto", "worktrees", "gone")
    await expect(
      buildFinalizeContext(fakeWorktreePath, runDir, state, config),
    ).rejects.toThrow()
  })
})
