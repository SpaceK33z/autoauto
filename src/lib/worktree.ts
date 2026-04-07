import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { join } from "node:path"
import { mkdir } from "node:fs/promises"

const execFileAsync = promisify(execFile)

/**
 * Creates a git worktree for a run. The worktree is created inside
 * .autoauto/worktrees/<runId>/ and checks out a new experiment branch.
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

  const worktreePath = join(worktreesDir, runId)
  const branchName = `autoauto-${programSlug}-${runId}`

  await execFileAsync(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath],
    { cwd: mainRoot },
  )

  return worktreePath
}

/**
 * Removes a git worktree. Safe to call if the worktree doesn't exist.
 */
export async function removeWorktree(
  mainRoot: string,
  worktreePath: string,
): Promise<void> {
  try {
    await execFileAsync(
      "git",
      ["worktree", "remove", "--force", worktreePath],
      { cwd: mainRoot },
    )
  } catch {
    // Worktree may already be removed or not exist
  }
}
