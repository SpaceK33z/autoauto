/**
 * MockContainerProvider — uses local filesystem + Bun.$ for testing.
 *
 * The `rootDir` parameter acts as the container's filesystem root.
 * All exec/readFile/writeFile operations happen relative to it.
 * Used by ContainerProvider contract tests and SandboxRunBackend tests.
 */

import { join, dirname } from "node:path"
import { chmod, mkdir, readdir, stat, unlink } from "node:fs/promises"
import type {
  ContainerProvider,
  ContainerHandle,
  ExecOptions,
  ExecResult,
  StreamingProcess,
  UploadRepoOptions,
} from "./types.ts"
import { bundleCreate, bundleUnbundle } from "../git.ts"

// Static registry for findByMetadata — keyed by "key=value" pairs
const activeProviders = new Map<string, MockContainerProvider>()

function metadataKey(metadata: Record<string, string>): string {
  return Object.entries(metadata).toSorted(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&")
}

export interface MockContainerOptions {
  rootDir: string
}

export class MockContainerProvider implements ContainerProvider {
  readonly rootDir: string
  private metadata: Record<string, string> = {}
  private mainProcess: import("bun").Subprocess | null = null
  private terminated = false
  private detached = false

  constructor(options: MockContainerOptions) {
    this.rootDir = options.rootDir
  }

  async exec(command: string[], opts?: ExecOptions): Promise<ExecResult> {
    const cwd = opts?.cwd ? join(this.rootDir, opts.cwd) : this.rootDir
    const env = { ...process.env, ...opts?.env }
    const [bin, ...args] = command
    const proc = Bun.spawn([Bun.which(bin) ?? bin, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
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
    const cwd = opts?.cwd ? join(this.rootDir, opts.cwd) : this.rootDir
    const env = { ...process.env, ...opts?.env }
    const [bin, ...args] = command
    const proc = Bun.spawn([Bun.which(bin) ?? bin, ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    // Track as main process for poll/terminate
    this.mainProcess = proc

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
    const fullPath = join(this.rootDir, remotePath)
    const file = Bun.file(fullPath)
    if (!(await file.exists())) {
      throw new Error(`ENOENT: no such file: ${remotePath}`)
    }
    return new Uint8Array(await file.arrayBuffer())
  }

  async writeFile(remotePath: string, data: Uint8Array | string): Promise<void> {
    const fullPath = join(this.rootDir, remotePath)
    const dir = dirname(fullPath)
    await mkdir(dir, { recursive: true })
    await Bun.write(fullPath, data)
  }

  async copyIn(localPath: string, remotePath: string): Promise<void> {
    await this.copyInRecursive(localPath, remotePath, new Set())
  }

  private async copyInRecursive(
    localPath: string,
    remotePath: string,
    visitedDirs: Set<string>,
  ): Promise<void> {
    const fullPath = join(this.rootDir, remotePath)
    const info = await stat(localPath)

    if (info.isDirectory()) {
      const dirKey = `${info.dev}:${info.ino}`
      if (visitedDirs.has(dirKey)) return
      visitedDirs.add(dirKey)

      try {
        await mkdir(fullPath, { recursive: true })
        const entries = await readdir(localPath, { withFileTypes: true })
        for (const entry of entries) {
          await this.copyInRecursive(
            join(localPath, entry.name),
            join(remotePath, entry.name),
            visitedDirs,
          )
        }
      } finally {
        visitedDirs.delete(dirKey)
      }
      return
    }

    const dir = dirname(fullPath)
    await mkdir(dir, { recursive: true })
    await Bun.write(fullPath, Bun.file(localPath))
    await chmod(fullPath, info.mode & 0o777)
  }

  async uploadRepo(localDir: string, remoteDir: string, options?: UploadRepoOptions): Promise<void> {
    const absoluteRemoteDir = join(this.rootDir, remoteDir)
    await mkdir(absoluteRemoteDir, { recursive: true })

    const bundlePath = join(this.rootDir, ".tmp-upload.bundle")
    try {
      await bundleCreate(localDir, bundlePath)
      await bundleUnbundle(absoluteRemoteDir, bundlePath)

      await Promise.all((options?.extraCopyPaths ?? []).map(async (relativePath) => {
        const hostPath = join(localDir, relativePath)
        try {
          await stat(hostPath)
        } catch {
          return
        }
        await this.copyIn(hostPath, join(remoteDir, relativePath))
      }))
    } finally {
      await unlink(bundlePath).catch(() => {})
    }
  }

  async poll(): Promise<number | null> {
    if (this.terminated) return 1
    if (!this.mainProcess) return null
    // Bun's .exitCode property may not update synchronously after .exited resolves,
    // so race against a microtask to check without blocking
    return Promise.race([
      this.mainProcess.exited.then((code) => code),
      Promise.resolve().then(() => null as number | null),
    ])
  }

  async terminate(): Promise<void> {
    this.terminated = true
    if (this.mainProcess) {
      this.mainProcess.kill()
      await this.mainProcess.exited.catch(() => {})
    }
  }

  async findByMetadata(metadata: Record<string, string>): Promise<ContainerHandle | null> {
    // Search the static registry for a matching provider
    for (const [, provider] of activeProviders) {
      const matches = Object.entries(metadata).every(
        ([k, v]) => provider.metadata[k] === v,
      )
      if (matches && !provider.terminated) {
        return {
          attach: async () => provider,
        }
      }
    }
    return null
  }

  async setMetadata(metadata: Record<string, string>): Promise<void> {
    this.metadata = { ...this.metadata, ...metadata }
    // Register in the static registry
    const key = metadataKey(this.metadata)
    activeProviders.set(key, this)
  }

  detach(): void {
    this.detached = true
    // Remove from active tracking but don't terminate
    for (const [key, provider] of activeProviders) {
      if (provider === this) {
        activeProviders.delete(key)
        break
      }
    }
  }

  /** Test helper: set the main process that poll/terminate track */
  setMainProcess(proc: import("bun").Subprocess): void {
    this.mainProcess = proc
  }

  /** Test helper: clear the static registry (call in afterEach) */
  static clearRegistry(): void {
    activeProviders.clear()
  }
}
