/**
 * DockerContainerProvider — uses the Docker CLI to implement ContainerProvider.
 *
 * Runs containers locally via `docker run`, executes commands via `docker exec`,
 * and transfers files via `docker cp`. Zero npm dependencies — all ops go through
 * the `docker` CLI via Bun.spawn.
 */

import { join } from "node:path"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { unlink } from "node:fs/promises"
import type {
  ContainerProvider,
  ContainerHandle,
  ExecOptions,
  ExecResult,
  StreamingProcess,
} from "./types.ts"

const decoder = new TextDecoder()

export class DockerContainerProvider implements ContainerProvider {
  private containerId: string
  private containerName: string

  constructor(containerId: string, containerName: string) {
    this.containerId = containerId
    this.containerName = containerName
  }

  async exec(command: string[], opts?: ExecOptions): Promise<ExecResult> {
    const args = ["docker", "exec"]
    if (opts?.cwd) args.push("--workdir", opts.cwd)
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`)
      }
    }
    args.push(this.containerId, ...command)

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
    const [stdoutBuf, stderrBuf] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).arrayBuffer(),
    ])
    const exitCode = await proc.exited
    return {
      exitCode,
      stdout: new Uint8Array(stdoutBuf),
      stderr: new Uint8Array(stderrBuf),
    }
  }

  async execStreaming(command: string[], opts?: ExecOptions): Promise<StreamingProcess> {
    const args = ["docker", "exec"]
    if (opts?.cwd) args.push("--workdir", opts.cwd)
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`)
      }
    }
    args.push(this.containerId, ...command)

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
    // Ensure parent directory exists
    const dir = dirname(remotePath)
    if (dir !== "/" && dir !== ".") {
      await this.exec(["mkdir", "-p", dir])
    }

    // Write to local temp file, then docker cp into container (binary-safe)
    const tmpFile = join(tmpdir(), `autoauto-docker-write-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await Bun.write(tmpFile, data)
      const proc = Bun.spawn(["docker", "cp", tmpFile, `${this.containerId}:${remotePath}`], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = decoder.decode(new Uint8Array(await new Response(proc.stderr).arrayBuffer())).trim()
        throw new Error(`docker cp write failed: ${stderr}`)
      }
    } finally {
      await unlink(tmpFile).catch(() => {})
    }
  }

  async uploadRepo(localDir: string, remoteDir: string): Promise<void> {
    // Ensure remote dir exists
    await this.exec(["mkdir", "-p", remoteDir])

    // docker cp localDir/. container:remoteDir — native directory copy
    const proc = Bun.spawn(
      ["docker", "cp", `${localDir}/.`, `${this.containerId}:${remoteDir}`],
      { stdout: "pipe", stderr: "pipe" },
    )
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = decoder.decode(new Uint8Array(await new Response(proc.stderr).arrayBuffer())).trim()
      throw new Error(`docker cp upload failed: ${stderr}`)
    }
  }

  async poll(): Promise<number | null> {
    const proc = Bun.spawn(
      ["docker", "inspect", "--format", "{{.State.Running}}", this.containerId],
      { stdout: "pipe", stderr: "pipe" },
    )
    const stdout = decoder.decode(new Uint8Array(await new Response(proc.stdout).arrayBuffer())).trim()
    const exitCode = await proc.exited

    // Container removed or not found
    if (exitCode !== 0) return 1

    if (stdout === "true") return null

    // Container stopped — get its exit code
    const codeProc = Bun.spawn(
      ["docker", "inspect", "--format", "{{.State.ExitCode}}", this.containerId],
      { stdout: "pipe", stderr: "pipe" },
    )
    const codeStr = decoder.decode(new Uint8Array(await new Response(codeProc.stdout).arrayBuffer())).trim()
    await codeProc.exited
    const code = parseInt(codeStr, 10)
    return isNaN(code) ? 1 : code
  }

  async terminate(): Promise<void> {
    const proc = Bun.spawn(
      ["docker", "rm", "-f", this.containerId],
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
    // Check if container exists and is running
    const proc = Bun.spawn(
      ["docker", "inspect", "--format", "{{.Id}} {{.State.Running}}", name],
      { stdout: "pipe", stderr: "pipe" },
    )
    const stdout = decoder.decode(new Uint8Array(await new Response(proc.stdout).arrayBuffer())).trim()
    const exitCode = await proc.exited

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

const DOCKERFILE = `FROM ubuntu:22.04
RUN apt-get update -qq && apt-get install -y -qq git curl
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH=/root/.bun/bin:$PATH
WORKDIR /workspace
`

/** Ensure the autoauto-runner Docker image exists, building it if needed. */
async function ensureImage(): Promise<void> {
  // Check if image already exists
  const check = Bun.spawn(
    ["docker", "image", "inspect", "autoauto-runner:latest"],
    { stdout: "pipe", stderr: "pipe" },
  )
  if ((await check.exited) === 0) return

  // Build from inline Dockerfile
  const build = Bun.spawn(
    ["docker", "build", "-t", "autoauto-runner:latest", "-"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  build.stdin.write(DOCKERFILE)
  build.stdin.end()
  const exitCode = await build.exited
  if (exitCode !== 0) {
    const stderr = decoder.decode(new Uint8Array(await new Response(build.stderr).arrayBuffer())).trim()
    throw new Error(`Failed to build autoauto-runner image: ${stderr}`)
  }
}

/**
 * Create a new DockerContainerProvider. Called by the container provider registry.
 *
 * Config keys:
 * - programSlug, runId: used to construct container name and labels
 */
export async function createDockerProvider(config: Record<string, unknown>): Promise<DockerContainerProvider> {
  await ensureImage()

  const slug = config.programSlug as string | undefined
  const runId = config.runId as string | undefined
  const name = slug && runId ? `autoauto-${slug}-${runId}` : `autoauto-${Date.now()}`

  // Pre-clean any stale container with the same name
  const rmProc = Bun.spawn(["docker", "rm", "-f", name], { stdout: "pipe", stderr: "pipe" })
  await rmProc.exited

  // Collect env secrets
  const envFlags: string[] = []
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) {
    if (process.env[key]) envFlags.push("--env", `${key}=${process.env[key]}`)
  }

  // Construct labels
  const labelFlags = ["--label", "autoauto=true"]
  if (slug) labelFlags.push("--label", `program_slug=${slug}`)
  if (runId) labelFlags.push("--label", `run_id=${runId}`)

  const runArgs = [
    "docker", "run", "-d",
    "--name", name,
    ...labelFlags,
    ...envFlags,
    "autoauto-runner:latest",
    "sleep", "infinity",
  ]

  const proc = Bun.spawn(runArgs, { stdout: "pipe", stderr: "pipe" })
  const stdout = decoder.decode(new Uint8Array(await new Response(proc.stdout).arrayBuffer())).trim()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = decoder.decode(new Uint8Array(await new Response(proc.stderr).arrayBuffer())).trim()
    throw new Error(`Failed to start Docker container: ${stderr}`)
  }

  const containerId = stdout.slice(0, 12) // short ID
  return new DockerContainerProvider(containerId, name)
}

/**
 * Check if Docker is available and required env vars are set.
 */
export async function checkDockerAuth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const proc = Bun.spawn(["docker", "info"], { stdout: "pipe", stderr: "pipe" })
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      error: "ANTHROPIC_API_KEY required — the experiment agent runs inside the container",
    }
  }

  return { ok: true }
}
