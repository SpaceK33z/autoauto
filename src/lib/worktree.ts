import { $ } from "bun"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { formatShellError } from "./git.ts"

/** Returns the canonical worktree path for a run. */
export function getWorktreePath(mainRoot: string, programSlug: string, runId: string): string {
  return join(mainRoot, ".autoauto", "worktrees", `${programSlug}-${runId}`)
}

/**
 * Creates a git worktree for a run. The worktree is created inside
 * .autoauto/worktrees/<programSlug>-<runId>/ and checks out a new experiment branch.
 *
 * Returns the absolute worktree path.
 */
export async function createWorktree(
  mainRoot: string,
  runId: string,
  programSlug: string,
): Promise<string> {
  const worktreesDir = join(mainRoot, ".autoauto", "worktrees")
  await mkdir(worktreesDir, { recursive: true })

  const worktreePath = getWorktreePath(mainRoot, programSlug, runId)
  const branchName = `autoauto-${programSlug}-${runId}`

  try {
    await $`git worktree add -b ${branchName} ${worktreePath}`.cwd(mainRoot).quiet()
  } catch (err) {
    throw new Error(formatShellError(err, `git worktree add (branch ${branchName})`), { cause: err })
  }

  return worktreePath
}

/**
 * Removes a git worktree. Safe to call if the worktree doesn't exist.
 */
export async function removeWorktree(
  mainRoot: string,
  worktreePath: string,
): Promise<void> {
  await $`git worktree remove --force ${worktreePath}`.cwd(mainRoot).nothrow().quiet()
}
