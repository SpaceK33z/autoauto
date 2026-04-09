import { rename, unlink, open } from "node:fs/promises"
import { join } from "node:path"
import type { ModelSlot } from "./config.ts"
import { AUTOAUTO_DIR, getProgramDir } from "./programs.ts"
import { readLock } from "./daemon-lifecycle.ts"
import { spawnDaemon } from "./daemon-spawn.ts"

// --- Types ---

export interface QueueEntry {
  id: number
  programSlug: string
  modelConfig: ModelSlot
  maxExperiments: number
  useWorktree: boolean
  addedAt: string
  retryCount: number
  lastError: string | null
}

export interface QueueFile {
  nextId: number
  entries: QueueEntry[]
}

const QUEUE_FILE = "queue.json"
const QUEUE_LOCK = "queue.lock"
const MAX_RETRIES = 2

// --- Path helpers ---

function getQueuePath(cwd: string): string {
  return join(cwd, AUTOAUTO_DIR, QUEUE_FILE)
}

function getQueueLockPath(cwd: string): string {
  return join(cwd, AUTOAUTO_DIR, QUEUE_LOCK)
}

// --- Read / Write ---

export async function readQueue(cwd: string): Promise<QueueFile> {
  try {
    return await Bun.file(getQueuePath(cwd)).json() as QueueFile
  } catch {
    return { nextId: 1, entries: [] }
  }
}

export async function writeQueue(cwd: string, queue: QueueFile): Promise<void> {
  const queuePath = getQueuePath(cwd)
  const tmpPath = `${queuePath}.tmp`
  await Bun.write(tmpPath, JSON.stringify(queue, null, 2) + "\n")
  await rename(tmpPath, queuePath)
}

// --- Locking ---

/** Acquire queue.lock with O_EXCL and run fn, retrying on contention.
 *  All queue read-modify-write operations must go through this to prevent races. */
async function withQueueLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getQueueLockPath(cwd)

  for (let attempt = 0; attempt < 20; attempt++) {
    let lockFd: import("node:fs/promises").FileHandle
    try {
      lockFd = await open(lockPath, "wx")
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        await Bun.sleep(50)
        continue
      }
      throw err
    }

    try {
      return await fn()
    } finally {
      await lockFd.close()
      await unlink(lockPath).catch(() => {})
    }
  }
  throw new Error("Failed to acquire queue lock")
}

// --- Manipulation ---

/** Fields the caller provides when appending to the queue. */
export type NewQueueEntry = Omit<QueueEntry, "id" | "retryCount" | "lastError" | "addedAt">

/** Append a run to the queue. Assigns an auto-incrementing ID and defaults internal fields.
 *  Enforces program exclusivity: rejects if program has an active manual run
 *  (active lock + no existing queue entries for that program).
 *  Returns the created entry and whether the queue was previously empty. */
export async function appendToQueue(
  cwd: string,
  entry: NewQueueEntry,
): Promise<{ entry: QueueEntry; wasEmpty: boolean }> {
  return withQueueLock(cwd, async () => {
    const queue = await readQueue(cwd)

    // Exclusivity check: if program has an active lock but no queue entries,
    // it's a manual run — reject.
    const hasEntries = queue.entries.some((e) => e.programSlug === entry.programSlug)
    if (!hasEntries) {
      const programDir = getProgramDir(cwd, entry.programSlug)
      const lock = await readLock(programDir)
      if (lock) {
        throw new Error(`Program "${entry.programSlug}" has an active manual run. Stop it before queueing.`)
      }
    }

    const wasEmpty = queue.entries.length === 0
    const fullEntry: QueueEntry = { ...entry, id: queue.nextId, retryCount: 0, lastError: null, addedAt: new Date().toISOString() }
    queue.nextId++
    queue.entries.push(fullEntry)
    await writeQueue(cwd, queue)
    return { entry: fullEntry, wasEmpty }
  })
}

/** Remove a queue entry by ID. Returns the removed entry or null. */
export async function removeFromQueue(cwd: string, id: number): Promise<QueueEntry | null> {
  return withQueueLock(cwd, async () => {
    const queue = await readQueue(cwd)
    const idx = queue.entries.findIndex((e) => e.id === id)
    if (idx === -1) return null
    const [removed] = queue.entries.splice(idx, 1)
    await writeQueue(cwd, queue)
    return removed
  })
}

/** Pop the first entry from the queue. Uses O_EXCL lock to prevent
 *  concurrent pops from daemon and TUI. Returns null if lock is held
 *  (competitive pop — lets the other process win). */
export async function popQueue(cwd: string): Promise<QueueEntry | null> {
  const lockPath = getQueueLockPath(cwd)
  let lockFd: import("node:fs/promises").FileHandle | null = null

  try {
    lockFd = await open(lockPath, "wx")
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Another process holds the lock — let it win
      return null
    }
    throw err
  }

  try {
    const queue = await readQueue(cwd)
    if (queue.entries.length === 0) return null
    const [entry] = queue.entries.splice(0, 1)
    await writeQueue(cwd, queue)
    return entry
  } finally {
    await lockFd.close()
    await unlink(lockPath).catch(() => {})
  }
}

/** Clear all pending queue entries. Returns the cleared entries. */
export async function clearQueue(cwd: string): Promise<QueueEntry[]> {
  return withQueueLock(cwd, async () => {
    const queue = await readQueue(cwd)
    const cleared = queue.entries
    queue.entries = []
    await writeQueue(cwd, queue)
    return cleared
  })
}

// --- Query helpers ---

export function programHasQueueEntries(queue: QueueFile, programSlug: string): boolean {
  return queue.entries.some((e) => e.programSlug === programSlug)
}

// --- Queue advancement ---

/** Pop the next viable entry from the queue and spawn a daemon for it.
 *  Skips entries that have exceeded MAX_RETRIES.
 *  Returns lastError when entries were skipped/failed so callers can notify. */
export async function startNextFromQueue(
  cwd: string,
  ideasBacklogEnabled: boolean,
): Promise<{ started: true; entry: QueueEntry; runId: string } | { started: false; lastError?: string }> {
  let lastError: string | undefined
  while (true) {
    const entry = await popQueue(cwd)
    if (!entry) return { started: false, lastError }

    if (entry.retryCount >= MAX_RETRIES) {
      lastError = `Skipped ${entry.programSlug} after ${entry.retryCount} failures: ${entry.lastError}`
      process.stderr.write(`[queue] ${lastError}\n`)
      continue
    }

    try {
      const { runId } = await spawnDaemon(
        cwd,
        entry.programSlug,
        entry.modelConfig,
        entry.maxExperiments,
        ideasBacklogEnabled,
        entry.useWorktree,
        true, // carryForward
        "queue",
      )
      return { started: true, entry, runId }
    } catch (err) {
      // Re-insert with incremented retryCount (locked to prevent races)
      lastError = `Failed to start ${entry.programSlug}: ${err}`
      entry.retryCount++
      entry.lastError = String(err)
      await withQueueLock(cwd, async () => {
        const queue = await readQueue(cwd)
        queue.entries.unshift(entry)
        await writeQueue(cwd, queue)
      })
      process.stderr.write(`[queue] ${lastError}\n`)
      // Continue loop to try next entry
    }
  }
}
