/**
 * ModalContainerProvider — wraps Modal JS SDK to implement ContainerProvider.
 *
 * Uses Modal Sandboxes for remote container execution. Auth requires
 * MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables.
 */

import { dirname, join, posix } from "node:path"
import { readdir } from "node:fs/promises"
import { ModalClient, NotFoundError } from "modal"
import { collectContainerEnv, checkSandboxAgentAuth, getAgentConfigFiles, type AgentAuthMethod } from "../agent-config.ts"
import type { Sandbox, Secret } from "modal"
import type {
  ContainerProvider,
  ContainerHandle,
  ExecOptions,
  ExecResult,
  StreamingProcess,
  UploadRepoOptions,
} from "./types.ts"
import { uploadRepoViaGitBundle } from "./sync.ts"
import type { AgentProviderID } from "../agent/types.ts"

export interface ModalProviderConfig {
  /** CPU cores for the sandbox (default: 2) */
  cpu?: number
  /** Memory in MiB (default: 4096) */
  memoryMiB?: number
  /** Sandbox timeout in ms (default: 86_400_000 = 24h) */
  timeoutMs?: number
  /** Modal app name (default: "autoauto") */
  appName?: string
  /** Sandbox name for reconnection (optional) */
  sandboxName?: string
}

const encoder = new TextEncoder()

export class ModalContainerProvider implements ContainerProvider {
  private modal: ModalClient
  private sandbox: Sandbox
  private appName: string
  private metadata: Record<string, string> = {}

  constructor(modal: ModalClient, sandbox: Sandbox, appName: string) {
    this.modal = modal
    this.sandbox = sandbox
    this.appName = appName
  }

  /** The Modal sandbox ID — exposed for persistence in sandbox.json */
  get sandboxId(): string {
    return this.sandbox.sandboxId
  }

  async exec(command: string[], opts?: ExecOptions): Promise<ExecResult> {
    const p = await this.sandbox.exec(command, {
      stdout: "pipe",
      stderr: "pipe",
      workdir: opts?.cwd,
      env: opts?.env,
      timeoutMs: opts?.timeout,
    })
    const [stdoutText, stderrText] = await Promise.all([
      p.stdout.readText(),
      p.stderr.readText(),
    ])
    const exitCode = await p.wait()
    return {
      exitCode,
      stdout: encoder.encode(stdoutText),
      stderr: encoder.encode(stderrText),
    }
  }

  async execStreaming(command: string[], opts?: ExecOptions): Promise<StreamingProcess> {
    const p = await this.sandbox.exec(command, {
      mode: "binary",
      stdout: "pipe",
      stderr: "pipe",
      workdir: opts?.cwd,
      env: opts?.env,
      timeoutMs: opts?.timeout,
    })

    return {
      // ModalReadStream<Uint8Array> extends ReadableStream<Uint8Array>
      stdout: p.stdout as ReadableStream<Uint8Array>,
      stderr: p.stderr as ReadableStream<Uint8Array>,
      exitCode: p.wait(),
      kill: () => {
        // Modal doesn't expose per-process kill; terminate the sandbox
        this.sandbox.terminate().catch(() => {})
      },
    }
  }

  async readFile(remotePath: string): Promise<Uint8Array> {
    const handle = await this.sandbox.open(remotePath, "r")
    try {
      return await handle.read()
    } finally {
      await handle.close()
    }
  }

  async writeFile(remotePath: string, data: Uint8Array | string): Promise<void> {
    // Ensure parent directory exists
    const dir = dirname(remotePath)
    if (dir !== "/" && dir !== ".") {
      await this.sandbox.exec(["mkdir", "-p", dir], { stdout: "ignore", stderr: "ignore" })
    }

    const handle = await this.sandbox.open(remotePath, "w")
    try {
      const bytes = typeof data === "string" ? encoder.encode(data) : data
      await handle.write(bytes)
    } finally {
      await handle.close()
    }
  }

  async copyIn(localPath: string, remotePath: string): Promise<void> {
    await this.copyInRecursive(localPath, remotePath, new Set())
  }

  private async copyInRecursive(
    localPath: string,
    remotePath: string,
    visitedDirs: Set<string>,
  ): Promise<void> {
    const info = await Bun.file(localPath).stat()

    if (info.isDirectory()) {
      // Ancestor-stack cycle guard: only tracks the active recursion chain so
      // non-cyclic symlink aliases (e.g. dir/link -> ../dir/real) still get
      // materialized while true cycles are detected and skipped.
      const dirKey = `${info.dev}:${info.ino}`
      if (visitedDirs.has(dirKey)) return
      visitedDirs.add(dirKey)

      try {
        await this.sandbox.exec(["mkdir", "-p", remotePath], { stdout: "ignore", stderr: "ignore" })
        const entries = await readdir(localPath, { withFileTypes: true })
        for (const entry of entries) {
          await this.copyInRecursive(
            join(localPath, entry.name),
            posix.join(remotePath, entry.name),
            visitedDirs,
          )
        }
      } finally {
        visitedDirs.delete(dirKey)
      }
      return
    }

    const bytes = new Uint8Array(await Bun.file(localPath).arrayBuffer())
    await this.writeFile(remotePath, bytes)

    const mode = (info.mode & 0o777).toString(8)
    const chmod = await this.sandbox.exec(["chmod", mode, remotePath], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const [stderrText, exitCode] = await Promise.all([
      chmod.stderr.readText(),
      chmod.wait(),
    ])
    if (exitCode !== 0) {
      const stderr = stderrText.trim()
      throw new Error(
        stderr
          ? `Failed to chmod ${remotePath} to ${mode} in Modal sandbox: ${stderr}`
          : `Failed to chmod ${remotePath} to ${mode} in Modal sandbox (exit ${exitCode})`,
      )
    }
  }

  async uploadRepo(localDir: string, remoteDir: string, options?: UploadRepoOptions): Promise<void> {
    await uploadRepoViaGitBundle(this, localDir, remoteDir, options)
  }

  async poll(): Promise<number | null> {
    return this.sandbox.poll()
  }

  async terminate(): Promise<void> {
    await this.sandbox.terminate()
  }

  async findByMetadata(metadata: Record<string, string>): Promise<ContainerHandle | null> {
    // Construct sandbox name from metadata (matches name used at creation)
    const name = buildSandboxName(metadata)
    if (!name) return null

    try {
      const found = await this.modal.sandboxes.fromName(this.appName, name)
      // Check if it's still alive
      const exitCode = await found.poll()
      if (exitCode !== null) return null

      const modal = this.modal
      const appName = this.appName
      return {
        attach: async () => new ModalContainerProvider(modal, found, appName),
      }
    } catch (err) {
      if (err instanceof NotFoundError) return null
      throw err
    }
  }

  async setMetadata(metadata: Record<string, string>): Promise<void> {
    this.metadata = { ...this.metadata, ...metadata }
    await this.sandbox.setTags(this.metadata)
  }

  detach(): void {
    this.sandbox.detach()
  }
}

/** Build a deterministic sandbox name from metadata for reconnection */
function buildSandboxName(metadata: Record<string, string>): string | null {
  const slug = metadata.program_slug
  const runId = metadata.run_id
  if (!slug || !runId) return null
  return `autoauto-${slug}-${runId}`
}

/**
 * Create a new ModalContainerProvider. Called by the container provider registry.
 *
 * Config keys:
 * - cpu, memoryMiB, timeoutMs: sandbox resource allocation
 * - appName: Modal app name (default "autoauto")
 * - sandboxName: explicit sandbox name (for reconnection)
 * - programSlug, runId: used to construct sandbox name if sandboxName not set
 */
export async function createModalProvider(config: Record<string, unknown>): Promise<ModalContainerProvider> {
  const modal = new ModalClient()
  const appName = (config.appName as string) ?? "autoauto"
  const app = await modal.apps.fromName(appName, { createIfMissing: true })

  // Pre-install git + bun in image
  const image = modal.images
    .fromRegistry("ubuntu:22.04")
    .dockerfileCommands([
      "RUN apt-get update -qq && apt-get install -y -qq git curl",
      "RUN curl -fsSL https://bun.sh/install | bash",
      "ENV PATH=/root/.bun/bin:$PATH",
    ])

  // Collect secrets from env vars — the experiment agent needs these inside the sandbox
  const envSecrets = collectContainerEnv()
  const secrets: Secret[] = []
  if (Object.keys(envSecrets).length > 0) {
    secrets.push(await modal.secrets.fromObject(envSecrets))
  }

  // Construct sandbox name for reconnection
  const name = (config.sandboxName as string) ??
    (config.programSlug && config.runId
      ? `autoauto-${config.programSlug}-${config.runId}`
      : undefined)

  const sandbox = await modal.sandboxes.create(app, image, {
    cpu: (config.cpu as number) ?? 2,
    memoryMiB: (config.memoryMiB as number) ?? 4096,
    timeoutMs: (config.timeoutMs as number) ?? 86_400_000, // 24h
    secrets,
    ...(name ? { name } : {}),
  })

  const provider = new ModalContainerProvider(modal, sandbox, appName)

  // Upload agent config files (Claude, Codex, OpenCode) into the sandbox
  const configFiles = await getAgentConfigFiles()
  const uploadResults = await Promise.allSettled(
    configFiles.map(async ({ localPath, remotePath }) => {
      const data = new Uint8Array(await Bun.file(localPath).arrayBuffer())
      await provider.writeFile(remotePath, data)
    }),
  )
  uploadResults.forEach((result, index) => {
    if (result.status === "fulfilled") return
    const { localPath, remotePath } = configFiles[index]!
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
    process.stderr.write(
      `[modal] Failed to upload agent config via provider.writeFile: ${localPath} -> ${remotePath}: ${reason}\n`,
    )
  })

  return provider
}

/**
 * Lightweight Modal sandbox lookup — only creates a ModalClient, does NOT
 * provision a new sandbox. Use for reconnection checks in findActiveRun().
 */
export async function lookupModalSandbox(
  metadata: Record<string, string>,
  appName = "autoauto",
): Promise<ContainerHandle | null> {
  const name = buildSandboxName(metadata)
  if (!name) return null

  try {
    const modal = new ModalClient()
    const found = await modal.sandboxes.fromName(appName, name)
    const exitCode = await found.poll()
    if (exitCode !== null) return null

    return {
      attach: async () => new ModalContainerProvider(modal, found, appName),
    }
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/**
 * Check if Modal auth env vars are set and the selected agent provider can
 * authenticate inside the sandbox.
 */
export async function checkModalAuth(
  provider: AgentProviderID = "claude",
): Promise<{ ok: boolean; error?: string; authMethod?: AgentAuthMethod }> {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    return {
      ok: false,
      error: "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET environment variables (https://modal.com/settings)",
    }
  }
  const agentAuth = await checkSandboxAgentAuth(provider)
  if (!agentAuth.ok) return agentAuth

  return { ok: true, authMethod: agentAuth.authMethod }
}
