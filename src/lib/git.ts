import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function getFullSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })
  return stdout.trim()
}

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

/** Only used as fallback when revert fails due to conflicts. */
export async function resetHard(cwd: string, sha: string): Promise<void> {
  await execFileAsync("git", ["reset", "--hard", sha], { cwd })
}

export async function getLatestCommitMessage(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd })
  return stdout.trim()
}

export async function getCommitDiff(cwd: string, sha: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["show", "--stat", sha], { cwd })
  return stdout.trim()
}

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

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd })
  return !stdout.trim()
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })
  return stdout.trim()
}

export async function createExperimentBranch(
  cwd: string,
  programSlug: string,
  runId: string,
): Promise<string> {
  const branchName = `autoauto-${programSlug}-${runId}`

  try {
    await execFileAsync("git", ["checkout", "-b", branchName], { cwd })
  } catch (err) {
    throw new Error(
      `Failed to create branch "${branchName}" — was a previous run interrupted? ` +
        `Delete it with \`git branch -D ${branchName}\` to proceed.`,
      { cause: err },
    )
  }

  return branchName
}

export async function checkoutBranch(cwd: string, branchName: string): Promise<void> {
  await execFileAsync("git", ["checkout", branchName], { cwd })
}

/** Returns files changed between two SHAs (relative paths). */
export async function getFilesChangedBetween(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git", ["diff", "--name-only", fromSha, toSha], { cwd },
  )
  return stdout.trim().split("\n").filter(Boolean)
}

/** Returns the number of commits between two SHAs. */
export async function countCommitsBetween(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<number> {
  const { stdout } = await execFileAsync(
    "git", ["rev-list", "--count", `${fromSha}..${toSha}`], { cwd },
  )
  return parseInt(stdout.trim(), 10)
}

/** Returns the full unified diff between two SHAs. */
export async function getDiffBetween(cwd: string, fromSha: string, toSha: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["diff", fromSha, toSha], { cwd })
  return stdout
}

/** Squashes all commits between baselineSha and HEAD into a single commit.
 *  Uses git reset --soft + commit. Rolls back on failure. Returns the new SHA. */
export async function squashCommits(
  cwd: string,
  baselineSha: string,
  commitMessage: string,
): Promise<string> {
  const savedHead = await getFullSha(cwd)

  await execFileAsync("git", ["reset", "--soft", baselineSha], { cwd })

  try {
    await execFileAsync("git", ["commit", "-m", commitMessage], { cwd })
  } catch (err) {
    // Rollback: restore HEAD to where it was before the reset
    await execFileAsync("git", ["reset", "--soft", savedHead], { cwd })
    throw err
  }

  return getFullSha(cwd)
}

/** Returns formatted diff summaries for discarded commits, capped at maxLength chars. */
export async function getDiscardedDiffs(
  cwd: string,
  shas: string[],
  maxLength = 2000,
): Promise<string> {
  const parts: string[] = []
  let totalLength = 0

  for (const sha of shas) {
    if (totalLength >= maxLength) break
    const diff = await getCommitDiff(cwd, sha) // eslint-disable-line no-await-in-loop -- lazy fetch, stops at maxLength
    const entry = `[${sha.slice(0, 7)}]\n${diff}\n`
    parts.push(entry)
    totalLength += entry.length
  }

  return parts.join("\n")
}
