/**
 * ContainerProvider — the low-level contract for communicating with a container
 * (local process, Modal sandbox, E2B, Docker, etc.).
 *
 * All sandbox providers implement this interface. `SandboxRunBackend` depends on
 * `ContainerProvider`, not on any specific vendor SDK.
 */

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** Timeout in milliseconds */
  timeout?: number
}

export interface ExecResult {
  exitCode: number
  stdout: Uint8Array
  stderr: Uint8Array
}

export interface StreamingProcess {
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exitCode: Promise<number>
  kill(signal?: string): void
}

/** Handle returned by findByMetadata — can be attached to reconnect. */
export interface ContainerHandle {
  attach(): Promise<ContainerProvider>
}

export interface ContainerProvider {
  /** Run a command to completion, collecting output */
  exec(command: string[], opts?: ExecOptions): Promise<ExecResult>

  /** Run a command with streaming stdout/stderr */
  execStreaming(command: string[], opts?: ExecOptions): Promise<StreamingProcess>

  /** Read a file from the container filesystem */
  readFile(remotePath: string): Promise<Uint8Array>

  /** Write a file to the container filesystem */
  writeFile(remotePath: string, data: Uint8Array | string): Promise<void>

  /** Upload a local repo into the container (e.g. via git bundle) */
  uploadRepo(localDir: string, remoteDir: string): Promise<void>

  /** Check if container is still running. Returns exit code if exited, null if alive. */
  poll(): Promise<number | null>

  /** Terminate the container (force kill) */
  terminate(): Promise<void>

  /** Find an existing container by metadata. Returns a handle to reconnect, or null. */
  findByMetadata(metadata: Record<string, string>): Promise<ContainerHandle | null>

  /** Set metadata labels on the current container for later lookup */
  setMetadata(metadata: Record<string, string>): Promise<void>

  /** Detach from the container without terminating it */
  detach(): void
}
