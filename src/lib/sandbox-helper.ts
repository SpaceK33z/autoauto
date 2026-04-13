/**
 * Sandbox Helper — container-side CLI dispatcher.
 *
 * Runs inside the container where everything is local filesystem.
 * Uses Bun.$/Bun.file() directly — does NOT dispatch through ContainerProvider.
 * Real ContainerProvider implementations (Modal, E2B) call into this via
 * provider.exec(["autoauto", "_sandbox-helper", ...]).
 *
 * Commands:
 *   exec <program> [args...]       Run a command, exit with its code
 *   cat <path> [--offset <n>]      Write file contents to stdout
 *   write <path>                   Read stdin and write to path
 *   status <runDir>                Print daemon status JSON to stdout
 */

import { join, dirname } from "node:path"
import { mkdir } from "node:fs/promises"

export async function runSandboxHelper(args: string[]): Promise<void> {
  const command = args[0]

  if (!command) {
    process.stderr.write("Usage: autoauto _sandbox-helper <command> [args...]\n")
    process.exitCode = 1
    return
  }

  switch (command) {
    case "exec":
      await handleExec(args.slice(1))
      break
    case "cat":
      await handleCat(args.slice(1))
      break
    case "write":
      await handleWrite(args.slice(1))
      break
    case "status":
      await handleStatus(args.slice(1))
      break
    default:
      process.stderr.write(`Unknown sandbox-helper command: ${command}\n`)
      process.exitCode = 1
      return
  }
}

async function handleExec(args: string[]): Promise<void> {
  if (args.length === 0) {
    process.stderr.write("Usage: _sandbox-helper exec <program> [args...]\n")
    process.exitCode = 1
    return
  }

  const proc = Bun.spawn(args, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const exitCode = await proc.exited
  process.exit(exitCode)
}

async function handleCat(args: string[]): Promise<void> {
  let filePath: string | undefined
  let offset = 0

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--offset" && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10)
      if (isNaN(parsed) || parsed < 0) {
        process.stderr.write(`Invalid offset: ${args[i]}\n`)
        process.exitCode = 1
        return
      }
      offset = parsed
    } else if (!filePath) {
      filePath = args[i]
    }
  }

  if (!filePath) {
    process.stderr.write("Usage: _sandbox-helper cat <path> [--offset <n>]\n")
    process.exitCode = 1
    return
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    process.stderr.write(`File not found: ${filePath}\n`)
    process.exitCode = 1
    return
  }

  if (offset > 0) {
    const size = file.size
    if (offset >= size) return // nothing to read
    const slice = file.slice(offset, size)
    const bytes = await slice.arrayBuffer()
    process.stdout.write(new Uint8Array(bytes))
  } else {
    const bytes = await file.arrayBuffer()
    process.stdout.write(new Uint8Array(bytes))
  }
}

async function handleWrite(args: string[]): Promise<void> {
  const filePath = args[0]
  if (!filePath) {
    process.stderr.write("Usage: _sandbox-helper write <path>\n")
    process.exitCode = 1
    return
  }

  // Ensure parent directory exists
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })

  // Read all of stdin via streaming (Bun.file("/dev/stdin") returns empty on Linux pipes)
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { merged.set(c, off); off += c.length }
  await Bun.write(filePath, merged)
}

async function handleStatus(args: string[]): Promise<void> {
  const runDir = args[0]
  if (!runDir) {
    process.stderr.write("Usage: _sandbox-helper status <runDir>\n")
    process.exitCode = 1
    return
  }

  try {
    const daemonJson = await Bun.file(join(runDir, "daemon.json")).json()
    const status = {
      alive: true,
      starting: !daemonJson.daemon_id,
      daemonJson,
    }

    // Check heartbeat staleness
    if (daemonJson.heartbeat_at) {
      const heartbeatAge = Date.now() - new Date(daemonJson.heartbeat_at).getTime()
      if (heartbeatAge > 30_000) {
        status.alive = false
      }
    }

    process.stdout.write(JSON.stringify(status) + "\n")
  } catch {
    process.stdout.write(JSON.stringify({ alive: false, starting: false, daemonJson: null }) + "\n")
  }
}
