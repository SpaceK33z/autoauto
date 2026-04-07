import { $ } from "bun"

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
