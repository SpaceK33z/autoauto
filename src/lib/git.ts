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

export async function getRecentLog(cwd: string, count?: number, ref?: string): Promise<string> {
  const args = ref ? [ref] : []
  return (await $`git log ${args} --oneline --decorate -n ${String(count ?? 10)}`.cwd(cwd).text()).trim()
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

export class DirtyWorkingTreeError extends Error {
  constructor(public readonly cwd: string) {
    super("Working tree has uncommitted changes")
    this.name = "DirtyWorkingTreeError"
  }
}

function isOnlyAutoAutoGitignorePatch(diff: string): boolean {
  if (!diff.trim()) return true

  for (const line of diff.split("\n")) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@")
    ) {
      continue
    }

    if ((line.startsWith("+") || line.startsWith("-")) && line.slice(1).trim() !== ".autoauto/") {
      return false
    }
  }

  return true
}

async function isOnlyAutoAutoGitignoreChange(cwd: string): Promise<boolean> {
  const [unstaged, staged] = await Promise.all([
    $`git diff -- .gitignore`.cwd(cwd).text(),
    $`git diff --cached -- .gitignore`.cwd(cwd).text(),
  ])

  return isOnlyAutoAutoGitignorePatch(unstaged) && isOnlyAutoAutoGitignorePatch(staged)
}

export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const lines = (await $`git status --porcelain`.cwd(cwd).text()).trim()
  if (!lines) return true
  const allowAutoAutoGitignore = lines.includes(".gitignore")
    ? await isOnlyAutoAutoGitignoreChange(cwd)
    : false
  const significant: string[] = []

  for (const line of lines.split("\n")) {
    if (!line || / \.autoauto-/.test(line)) continue

    const path = line.slice(3).trim()
    if (path === ".gitignore" && allowAutoAutoGitignore) continue

    significant.push(line)
  }

  return significant.length === 0
}

export async function getWorkingTreeStatus(cwd: string): Promise<string> {
  return (await $`git status --porcelain`.cwd(cwd).text()).trim()
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

// --- Git Bundle Operations ---

/** Creates a git bundle from a repository. If ref is provided, bundles that ref; otherwise bundles all refs. */
export async function bundleCreate(cwd: string, bundlePath: string, ref?: string): Promise<void> {
  try {
    if (ref) {
      await $`git bundle create ${bundlePath} ${ref}`.cwd(cwd).quiet()
    } else {
      await $`git bundle create ${bundlePath} --all`.cwd(cwd).quiet()
    }
  } catch (err) {
    throw new Error(formatShellError(err, "git bundle create"), { cause: err })
  }
}

/** Unbundles a git bundle. Clones into targetDir if it doesn't exist or isn't a repo, otherwise fetches. */
export async function bundleUnbundle(targetDir: string, bundlePath: string): Promise<void> {
  try {
    const isRepo = (await $`git rev-parse --is-inside-work-tree`.cwd(targetDir).nothrow().quiet()).exitCode === 0
    if (isRepo) {
      // Force-update heads and tags in a single fetch to avoid conflicts with checked-out branches
      await $`git fetch --update-head-ok ${bundlePath} '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'`.cwd(targetDir).quiet()
    } else {
      await $`git clone ${bundlePath} ${targetDir}`.quiet()
    }
  } catch (err) {
    // If targetDir doesn't exist, cwd() throws ENOENT — fall back to clone
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await $`git clone ${bundlePath} ${targetDir}`.quiet()
        return
      } catch (cloneErr) {
        throw new Error(formatShellError(cloneErr, "git bundle unbundle"), { cause: cloneErr })
      }
    }
    throw new Error(formatShellError(err, "git bundle unbundle"), { cause: err })
  }
}

/** Verifies a git bundle is valid. Returns true if valid, false otherwise. */
export async function bundleVerify(bundlePath: string): Promise<boolean> {
  const result = await $`git bundle verify ${bundlePath}`.nothrow().quiet()
  return result.exitCode === 0
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
