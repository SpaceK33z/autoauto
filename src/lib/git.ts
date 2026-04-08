import { $ } from "bun"

/** Extract a meaningful message from a Bun ShellError (which has .stderr Buffer but a generic .message). */
export function formatShellError(err: unknown, context?: string): string {
  if (err instanceof Error) {
    // Bun ShellError has .stderr as a Buffer
    const shellErr = err as Error & { stderr?: Buffer; exitCode?: number }
    const stderr = shellErr.stderr ? shellErr.stderr.toString().trim() : ""
    const prefix = context ? `${context}: ` : ""
    if (stderr) return `${prefix}${stderr}`
    if (shellErr.message && !shellErr.message.startsWith("Failed with exit code")) {
      return `${prefix}${shellErr.message}`
    }
    return `${prefix}exit code ${shellErr.exitCode ?? "unknown"}`
  }
  return context ? `${context}: ${String(err)}` : String(err)
}

export async function getFullSha(cwd: string): Promise<string> {
  return (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
}

export async function getRecentLog(cwd: string, count?: number): Promise<string> {
  return (await $`git log --oneline --decorate -n ${String(count ?? 10)}`.cwd(cwd).text()).trim()
}

/** Resets HEAD to the given SHA, discarding all changes. Primary discard mechanism for failed experiments. */
export async function resetHard(cwd: string, sha: string): Promise<void> {
  await $`git reset --hard ${sha}`.cwd(cwd).quiet()
}

export async function getLatestCommitMessage(cwd: string): Promise<string> {
  return (await $`git log -1 --format=%s`.cwd(cwd).text()).trim()
}

export async function getCommitDiff(cwd: string, sha: string): Promise<string> {
  return (await $`git show --stat ${sha}`.cwd(cwd).text()).trim()
}

export async function branchExists(cwd: string, branchName: string): Promise<boolean> {
  const result = await $`git show-ref --verify --quiet refs/heads/${branchName}`.cwd(cwd).nothrow().quiet()
  return result.exitCode === 0
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  return !(await $`git status --porcelain`.cwd(cwd).text()).trim()
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return (await $`git rev-parse --abbrev-ref HEAD`.cwd(cwd).text()).trim()
}

export async function createExperimentBranch(
  cwd: string,
  programSlug: string,
  runId: string,
): Promise<string> {
  const branchName = `autoauto-${programSlug}-${runId}`

  const result = await $`git checkout -b ${branchName}`.cwd(cwd).nothrow().quiet()
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create branch "${branchName}" — was a previous run interrupted? ` +
        `Delete it with \`git branch -D ${branchName}\` to proceed.`,
    )
  }

  return branchName
}

export async function checkoutBranch(cwd: string, branchName: string): Promise<void> {
  await $`git checkout ${branchName}`.cwd(cwd).quiet()
}

/** Returns files changed between two SHAs (relative paths). */
export async function getFilesChangedBetween(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  return (await $`git diff --name-only ${fromSha} ${toSha}`.cwd(cwd).text())
    .trim()
    .split("\n")
    .filter(Boolean)
}

/** Returns the number of commits between two SHAs. */
export async function countCommitsBetween(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<number> {
  return parseInt((await $`git rev-list --count ${fromSha}..${toSha}`.cwd(cwd).text()).trim(), 10)
}

/** Returns the full unified diff between two SHAs. */
export async function getDiffBetween(cwd: string, fromSha: string, toSha: string): Promise<string> {
  return await $`git diff ${fromSha} ${toSha}`.cwd(cwd).text()
}

/** Squashes all commits between baselineSha and HEAD into a single commit.
 *  Uses git reset --soft + commit. Rolls back on failure. Returns the new SHA. */
export async function squashCommits(
  cwd: string,
  baselineSha: string,
  commitMessage: string,
): Promise<string> {
  const savedHead = await getFullSha(cwd)

  await $`git reset --soft ${baselineSha}`.cwd(cwd).quiet()

  try {
    await $`git commit -m ${commitMessage}`.cwd(cwd).quiet()
  } catch (err) {
    // Rollback: restore HEAD to where it was before the reset
    await $`git reset --soft ${savedHead}`.cwd(cwd).quiet()
    throw err
  }

  return getFullSha(cwd)
}

/** Creates a group branch from baseline, applying only the specified files from headSha.
 *  Used by finalize to split kept experiments into independent, mergeable branches.
 *  Returns the new commit SHA. */
export async function createGroupBranch(
  cwd: string,
  branchName: string,
  baselineSha: string,
  headSha: string,
  files: string[],
  commitMessage: string,
): Promise<string> {
  // Delete stale branch from a previous crashed attempt
  if (await branchExists(cwd, branchName)) {
    await $`git branch -D ${branchName}`.cwd(cwd).quiet()
  }

  try {
    await $`git checkout -b ${branchName} ${baselineSha}`.cwd(cwd).quiet()
  } catch (err) {
    throw new Error(formatShellError(err, `git checkout -b ${branchName}`), { cause: err })
  }

  try {
    // Stage only this group's files from the final experiment state
    await $`git checkout ${headSha} -- ${files}`.cwd(cwd).quiet()
  } catch (err) {
    throw new Error(formatShellError(err, `git checkout files from ${headSha.slice(0, 10)}`), { cause: err })
  }

  try {
    await $`git commit -m ${commitMessage}`.cwd(cwd).quiet()
  } catch (err) {
    throw new Error(formatShellError(err, `git commit for group "${branchName}"`), { cause: err })
  }

  return getFullSha(cwd)
}

/** Diff statistics: lines added and removed between two SHAs. */
export interface DiffStats {
  lines_added: number
  lines_removed: number
}

/** Returns lines added/removed between two SHAs using git diff --shortstat. */
export async function getDiffStats(cwd: string, fromSha: string, toSha: string): Promise<DiffStats> {
  const output = (await $`git diff --shortstat ${fromSha} ${toSha}`.cwd(cwd).text()).trim()
  if (!output) return { lines_added: 0, lines_removed: 0 }

  const insertions = output.match(/(\d+) insertion/)
  const deletions = output.match(/(\d+) deletion/)
  return {
    lines_added: insertions ? parseInt(insertions[1], 10) : 0,
    lines_removed: deletions ? parseInt(deletions[1], 10) : 0,
  }
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
