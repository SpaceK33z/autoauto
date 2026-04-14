import { lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, resolve, sep } from "node:path"
import { bundleCreate, getCurrentBranch, getFullSha } from "../git.ts"
import type { ExecOptions, UploadRepoOptions } from "./types.ts"

const decoder = new TextDecoder()

interface RepoUploadProvider {
  exec(command: string[], opts?: ExecOptions): Promise<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>
  copyIn(localPath: string, remotePath: string): Promise<void>
}

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes).trim()
}

async function execChecked(
  provider: RepoUploadProvider,
  command: string[],
  context: string,
  opts?: ExecOptions,
): Promise<string> {
  const result = await provider.exec(command, opts)
  if (result.exitCode !== 0) {
    const output = decode(result.stderr.length > 0 ? result.stderr : result.stdout)
    throw new Error(output ? `${context}: ${output}` : `${context}: exit ${result.exitCode}`)
  }
  return decode(result.stdout)
}

function resolveExtraCopyPath(localDir: string, relativePath: string): string {
  const trimmed = relativePath.trim()
  if (!trimmed || trimmed === ".") {
    throw new Error(`Invalid extra copy path: ${JSON.stringify(relativePath)}`)
  }

  const repoRoot = resolve(localDir)
  const absolutePath = resolve(repoRoot, trimmed)
  if (absolutePath !== repoRoot && !absolutePath.startsWith(repoRoot + sep)) {
    throw new Error(`Extra copy path must stay inside the repo root: ${relativePath}`)
  }

  return absolutePath
}

function toRemotePath(remoteDir: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
  return posix.join(remoteDir, ...normalized)
}

export async function uploadRepoViaGitBundle(
  provider: RepoUploadProvider,
  localDir: string,
  remoteDir: string,
  options?: UploadRepoOptions,
): Promise<void> {
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const localBundleDir = await mkdtemp(join(tmpdir(), "autoauto-upload-"))
  const localBundlePath = join(localBundleDir, "repo.bundle")
  const remoteBundlePath = `/tmp/autoauto-upload-${uploadId}.bundle`
  const remoteClonePath = `/tmp/autoauto-clone-${uploadId}`

  try {
    const [branch, localHead] = await Promise.all([
      getCurrentBranch(localDir).catch(() => "HEAD"),
      getFullSha(localDir),
    ])

    await bundleCreate(localDir, localBundlePath)
    await provider.copyIn(localBundlePath, remoteBundlePath)

    const remoteParent = posix.dirname(remoteDir)
    if (remoteParent !== "/" && remoteParent !== ".") {
      await execChecked(provider, ["mkdir", "-p", remoteParent], "Failed to prepare remote repo parent directory")
    }

    const cloneResult = await provider.exec(["git", "clone", remoteBundlePath, remoteClonePath])
    if (cloneResult.exitCode !== 0) {
      await provider.exec(["rm", "-rf", remoteClonePath]).catch(() => {})
      await execChecked(provider, ["mkdir", "-p", remoteClonePath], "Failed to prepare fallback repo dir")
      await execChecked(provider, ["git", "init"], "Failed to initialize fallback repo", { cwd: remoteClonePath })
      await execChecked(provider, ["git", "bundle", "unbundle", remoteBundlePath], "Failed to restore repository from git bundle", { cwd: remoteClonePath })
      await execChecked(provider, ["git", "checkout", "HEAD"], "Failed to checkout restored repository", { cwd: remoteClonePath })
    }

    if (branch !== "HEAD") {
      await execChecked(provider, ["git", "checkout", branch], `Failed to checkout branch ${branch}`, { cwd: remoteClonePath })
    }

    await execChecked(
      provider,
      ["sh", "-c", 'rm -rf "$1" && mv "$2" "$1"', "sh", remoteDir, remoteClonePath],
      "Failed to replace remote repository",
    )

    const extraCopyPaths = options?.extraCopyPaths ?? []
    await Promise.all(extraCopyPaths.map(async (relativePath) => {
      const localPath = resolveExtraCopyPath(localDir, relativePath)
      try {
        await lstat(localPath)
      } catch {
        return
      }
      await provider.copyIn(localPath, toRemotePath(remoteDir, relativePath))
    }))

    const remoteHead = await execChecked(provider, ["git", "rev-parse", "HEAD"], "Failed to verify uploaded repository", { cwd: remoteDir })
    if (remoteHead !== localHead) {
      throw new Error(`Uploaded repository HEAD mismatch: local=${localHead} remote=${remoteHead}`)
    }
  } finally {
    await rm(localBundleDir, { recursive: true, force: true }).catch(() => {})
    await provider.exec(["rm", "-f", remoteBundlePath]).catch(() => {})
    await provider.exec(["rm", "-rf", remoteClonePath]).catch(() => {})
  }
}
