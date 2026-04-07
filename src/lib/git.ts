import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Returns short (7-char) SHA of HEAD. */
export async function getCurrentSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })
  return stdout.trim()
}

/** Returns full SHA of HEAD (for state.json). */
export async function getFullSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  return stdout.trim()
}

/** Returns recent git log for context packet. */
export async function getRecentLog(cwd: string, count?: number): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "--oneline", "--decorate", "-n", String(count ?? 10)],
    { cwd },
  )
  return stdout.trim()
}

/**
 * Reverts all commits between fromSha (exclusive) and toSha (inclusive).
 * Uses `git revert` to preserve history for agent learning.
 * Returns true if successful, false if revert conflicted (caller should use resetHard).
 */
export async function revertCommits(cwd: string, fromSha: string, toSha: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["rev-list", `${fromSha}..${toSha}`], { cwd })
  const commits = stdout.trim().split("\n").filter(Boolean)

  if (commits.length === 0) return true

  try {
    await execFileAsync("git", ["revert", "--no-edit", ...commits], { cwd })
    return true
  } catch {
    // Conflict during revert — abort and signal caller to fall back to reset
    try {
      await execFileAsync("git", ["revert", "--abort"], { cwd })
    } catch {
      /* ignore abort failure */
    }
    return false
  }
}

/** Fallback hard reset if revert fails (conflict). Only used when revert is impossible. */
export async function resetHard(cwd: string, sha: string): Promise<void> {
  await execFileAsync("git", ["reset", "--hard", sha], { cwd })
}

/** Gets the subject line of HEAD commit (for results.tsv description). */
export async function getLatestCommitMessage(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd })
  return stdout.trim()
}

/** Gets the diff stat of a specific commit (for context packet — discarded diffs). */
export async function getCommitDiff(cwd: string, sha: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", "--stat", sha], { cwd })
  return stdout.trim()
}

/** Checks if a branch name already exists. */
export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    })
    return true
  } catch {
    return false
  }
}
