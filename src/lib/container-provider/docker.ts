/**
 * DockerContainerProvider — uses the Docker CLI to implement ContainerProvider.
 *
 * Runs containers locally via `docker run`, executes commands via `docker exec`,
 * writes individual files via `docker cp`, and uploads repos via git bundles.
 * Zero npm dependencies — all ops go through the `docker` CLI via Bun.spawn.
 */

import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { stat, unlink } from "node:fs/promises"
import { collectContainerEnv, checkAgentAuth, getAgentConfigDirs, type AgentAuthMethod } from "../agent-config.ts"
import { uploadRepoViaGitBundle } from "./sync.ts"
import type {
  ContainerProvider,
  ContainerHandle,
  ExecOptions,
  ExecResult,
  StreamingProcess,
  UploadRepoOptions,
} from "./types.ts"

const decoder = new TextDecoder()

/** Docker binary path — override with setDockerBin() for testing. */
let _dockerBin = "docker"

/** Override the docker binary path (e.g. to a mock script for testing). */
export function setDockerBin(bin: string): void { _dockerBin = bin }

/** Reset the docker binary to the default "docker". */
export function resetDockerBin(): void { _dockerBin = "docker" }

/** Read a subprocess stream to string, trimming whitespace. */
async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ""
  return decoder.decode(new Uint8Array(await new Response(stream).arrayBuffer())).trim()
}

export class DockerContainerProvider implements ContainerProvider {
  private containerId: string
  private containerName: string

  constructor(containerId: string, containerName: string) {
    this.containerId = containerId
    this.containerName = containerName
  }

  private async copyFileToContainer(localPath: string, remotePath: string, context: string): Promise<void> {
    const proc = Bun.spawn([_dockerBin, "cp", localPath, `${this.containerId}:${remotePath}`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderrText, exitCode] = await Promise.all([
      readStream(proc.stderr),
      proc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`${context}: ${stderrText}`)
    }
  }

  private buildExecArgs(command: string[], opts?: ExecOptions): string[] {
    const args = [_dockerBin, "exec"]
    if (opts?.cwd) args.push("--workdir", opts.cwd)
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`)
      }
    }
    args.push(this.containerId, ...command)
    return args
  }

  async exec(command: string[], opts?: ExecOptions): Promise<ExecResult> {
    const args = this.buildExecArgs(command, opts)
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })

    const stdoutPromise = new Response(proc.stdout).arrayBuffer()
    const stderrPromise = new Response(proc.stderr).arrayBuffer()

    // Start timeout before awaiting streams so hung processes are killed
    let timer: ReturnType<typeof setTimeout> | null = null
    const exitCode = await Promise.race([
      proc.exited,
      ...(opts?.timeout ? [new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          proc.kill()
          resolve(124)
        }, opts.timeout)
      })] : []),
    ])
    if (timer) clearTimeout(timer)

    const [stdoutBuf, stderrBuf] = await Promise.all([stdoutPromise, stderrPromise])
    return {
      exitCode,
      stdout: new Uint8Array(stdoutBuf),
      stderr: new Uint8Array(stderrBuf),
    }
  }

  async execStreaming(command: string[], opts?: ExecOptions): Promise<StreamingProcess> {
    const args = this.buildExecArgs(command, opts)
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })

    return {
      stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
      stderr: proc.stderr as unknown as ReadableStream<Uint8Array>,
      exitCode: proc.exited,
      kill: (signal?: string) => {
        proc.kill(signal === "SIGKILL" ? 9 : undefined)
      },
    }
  }

  async readFile(remotePath: string): Promise<Uint8Array> {
    const result = await this.exec(["cat", remotePath])
    if (result.exitCode !== 0) {
      const err = decoder.decode(result.stderr).trim()
      throw new Error(`ENOENT: no such file: ${remotePath}${err ? ` (${err})` : ""}`)
    }
    return result.stdout
  }

  async writeFile(remotePath: string, data: Uint8Array | string): Promise<void> {
    const dir = dirname(remotePath)
    if (dir !== "/" && dir !== ".") {
      await this.exec(["mkdir", "-p", dir])
    }

    // Write to local temp file, then docker cp into container (binary-safe)
    const tmpFile = join(tmpdir(), `autoauto-docker-write-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await Bun.write(tmpFile, data)
      await this.copyFileToContainer(tmpFile, remotePath, "docker cp write failed")
    } finally {
      await unlink(tmpFile).catch(() => {})
    }
  }

  async copyIn(localPath: string, remotePath: string): Promise<void> {
    const info = await stat(localPath)
    if (info.isDirectory()) {
      await this.exec(["mkdir", "-p", remotePath])
      const source = `${localPath.replace(/\/+$/, "")}/.`
      await this.copyFileToContainer(source, remotePath, "docker cp directory copy failed")
      return
    }

    const dir = dirname(remotePath)
    if (dir !== "/" && dir !== ".") {
      await this.exec(["mkdir", "-p", dir])
    }
    await this.copyFileToContainer(localPath, remotePath, "docker cp file copy failed")
  }

  async uploadRepo(localDir: string, remoteDir: string, options?: UploadRepoOptions): Promise<void> {
    await uploadRepoViaGitBundle(this, localDir, remoteDir, options)
  }

  async poll(): Promise<number | null> {
    // Single inspect call for both running state and exit code
    const proc = Bun.spawn(
      [_dockerBin, "inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", this.containerId],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, exitCode] = await Promise.all([
      readStream(proc.stdout),
      proc.exited,
    ])

    if (exitCode !== 0) return 1 // container removed or not found

    const [running, codeStr] = stdout.split(" ")
    if (running === "true") return null

    const code = parseInt(codeStr, 10)
    return isNaN(code) ? 1 : code
  }

  async terminate(): Promise<void> {
    const proc = Bun.spawn(
      [_dockerBin, "rm", "-f", this.containerId],
      { stdout: "pipe", stderr: "pipe" },
    )
    await proc.exited
  }

  async findByMetadata(metadata: Record<string, string>): Promise<ContainerHandle | null> {
    return lookupDockerContainer(metadata)
  }

  async setMetadata(_metadata: Record<string, string>): Promise<void> {
    // Docker labels are immutable after creation — no-op
  }

  detach(): void {
    // Container keeps running, nothing to do
  }
}

/** Build a deterministic container name from metadata for reconnection */
function buildContainerName(metadata: Record<string, string>): string | null {
  const slug = metadata.program_slug
  const runId = metadata.run_id
  if (!slug || !runId) return null
  return `autoauto-${slug}-${runId}`
}

/**
 * Look up an existing Docker container by metadata. Returns a handle to
 * reconnect, or null if not found / not running.
 *
 * Exported for use by `SandboxRunBackend.findActiveRun()`.
 */
export async function lookupDockerContainer(
  metadata: Record<string, string>,
): Promise<ContainerHandle | null> {
  const name = buildContainerName(metadata)
  if (!name) return null

  try {
    const proc = Bun.spawn(
      [_dockerBin, "inspect", "--format", "{{.Id}} {{.State.Running}}", name],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, exitCode] = await Promise.all([
      readStream(proc.stdout),
      proc.exited,
    ])

    if (exitCode !== 0) return null

    const [containerId, running] = stdout.split(" ")
    if (running !== "true" || !containerId) return null

    return {
      attach: async () => new DockerContainerProvider(containerId, name),
    }
  } catch {
    return null
  }
}

const DEFAULT_DOCKERFILE = `FROM ubuntu:22.04
RUN apt-get update -qq && apt-get install -y -qq git curl
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=/root/.bun/bin:$PATH
WORKDIR /workspace
`

function hashTag(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

async function resolveImage(mainRoot?: string): Promise<{ imageTag: string; dockerfilePath?: string }> {
  if (!mainRoot) {
    return { imageTag: `autoauto-runner:${hashTag(DEFAULT_DOCKERFILE)}` }
  }

  const dockerfilePath = join(mainRoot, ".autoauto", "Dockerfile")
  if (!await Bun.file(dockerfilePath).exists()) {
    return { imageTag: `autoauto-runner:${hashTag(DEFAULT_DOCKERFILE)}` }
  }

  const dockerfile = await Bun.file(dockerfilePath).text()
  const projectHash = hashTag(mainRoot)
  const dockerfileHash = hashTag(dockerfile)
  return {
    imageTag: `autoauto-runner:${projectHash}-${dockerfileHash}`,
    dockerfilePath,
  }
}

/** Ensure the Docker image exists, building it if needed. */
async function ensureImage(mainRoot?: string): Promise<string> {
  const { imageTag, dockerfilePath } = await resolveImage(mainRoot)

  const check = Bun.spawn(
    [_dockerBin, "image", "inspect", imageTag],
    { stdout: "pipe", stderr: "pipe" },
  )
  if ((await check.exited) === 0) return imageTag

  const build = dockerfilePath
    ? Bun.spawn(
      [_dockerBin, "build", "-t", imageTag, "-f", dockerfilePath, mainRoot!],
      { stdout: "pipe", stderr: "pipe" },
    )
    : Bun.spawn(
      [_dockerBin, "build", "-t", imageTag, "-"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )

  if (!dockerfilePath) {
    const stdin = build.stdin
    if (!stdin) {
      throw new Error(`Failed to stream default Dockerfile for image ${imageTag}`)
    }
    try {
      stdin.write(DEFAULT_DOCKERFILE)
      stdin.end()
    } catch (error) {
      try {
        stdin.end()
      } catch {}
      build.kill()
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to stream default Dockerfile for image ${imageTag}: ${message}`,
        { cause: error },
      )
    }
  }

  const [stderrText, exitCode] = await Promise.all([
    readStream(build.stderr),
    build.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`Failed to build Docker image ${imageTag}: ${stderrText}`)
  }

  return imageTag
}

/**
 * Create a new DockerContainerProvider. Called by the container provider registry.
 *
 * Config keys:
 * - programSlug, runId: used to construct container name and labels
 */
export async function createDockerProvider(config: Record<string, unknown>): Promise<DockerContainerProvider> {
  const mainRoot = config.mainRoot as string | undefined
  const imageTag = await ensureImage(mainRoot)

  const slug = config.programSlug as string | undefined
  const runId = config.runId as string | undefined
  const name = (slug && runId)
    ? buildContainerName({ program_slug: slug, run_id: runId })!
    : `autoauto-${Date.now()}`

  // Pre-clean any stale container with the same name
  const rmProc = Bun.spawn([_dockerBin, "rm", "-f", name], { stdout: "pipe", stderr: "pipe" })
  await rmProc.exited

  const envFlags: string[] = []
  for (const [key, value] of Object.entries(collectContainerEnv())) {
    envFlags.push("--env", `${key}=${value}`)
  }

  const configMountFlags: string[] = []
  for (const { hostPath, containerPath } of getAgentConfigDirs()) {
    configMountFlags.push("-v", `${hostPath}:${containerPath}:ro`)
  }

  const labelFlags = ["--label", "autoauto=true"]
  if (slug) labelFlags.push("--label", `program_slug=${slug}`)
  if (runId) labelFlags.push("--label", `run_id=${runId}`)

  const runArgs = [
    _dockerBin, "run", "-d",
    "--name", name,
    ...labelFlags,
    ...envFlags,
    ...configMountFlags,
    imageTag,
    "sleep", "infinity",
  ]

  const proc = Bun.spawn(runArgs, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderrText, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`Failed to start Docker container: ${stderrText}`)
  }

  const containerId = stdout.slice(0, 12) // short ID
  return new DockerContainerProvider(containerId, name)
}

/**
 * Check if Docker is available and required env vars are set.
 */
export async function checkDockerAuth(): Promise<{ ok: boolean; error?: string; authMethod?: AgentAuthMethod }> {
  try {
    const proc = Bun.spawn([_dockerBin, "info"], { stdout: "pipe", stderr: "pipe" })
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => {
        proc.kill()
        resolve(1)
      }, 5_000)),
    ])
    if (exitCode !== 0) {
      return {
        ok: false,
        error: "Docker daemon is not running. Start Docker Desktop or the Docker service.",
      }
    }
  } catch {
    return {
      ok: false,
      error: "Docker is not installed or not accessible. Install Docker from https://docker.com",
    }
  }

  const agentAuth = checkAgentAuth()
  if (!agentAuth.ok) return agentAuth

  return { ok: true, authMethod: agentAuth.authMethod }
}
