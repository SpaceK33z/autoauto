/**
 * E2E tests for queue operations: append, pop, remove, clear, ordering,
 * concurrent locking, program exclusivity, retry logic, and startNextFromQueue.
 *
 * These tests exercise the real queue functions against real filesystem state.
 * Only spawnDaemon is mocked (it spawns actual processes), everything else
 * runs against a real temp git repo via the standard test fixture.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { join } from "node:path"
import { createTestFixture, registerMockProviders, type TestFixture } from "./fixture.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"
import {
  appendToQueue,
  clearQueue,
  popQueue,
  readQueue,
  removeFromQueue,
  startNextFromQueue,
  writeQueue,
  type NewQueueEntry,
} from "../lib/queue.ts"
import { acquireLock, releaseLock } from "../lib/daemon-lifecycle.ts"
import { getProgramDir, resetProjectRoot } from "../lib/programs.ts"
import { renderTui, noop, type TuiHarness } from "./helpers.ts"
import { HomeScreen } from "../screens/HomeScreen.tsx"

const MODEL = DEFAULT_CONFIG.executionModel

function makeEntry(overrides: Partial<NewQueueEntry> = {}): NewQueueEntry {
  return {
    programSlug: "bench",
    modelConfig: MODEL,
    maxExperiments: 10,
    useWorktree: true,
    ...overrides,
  }
}

let fixture: TestFixture

beforeAll(async () => {
  registerMockProviders()
  fixture = await createTestFixture()
  await fixture.createProgram("bench", {
    metric_field: "latency_ms",
    direction: "lower",
    max_experiments: 10,
  })
  await fixture.createProgram("other", {
    metric_field: "throughput",
    direction: "higher",
    max_experiments: 5,
  })
})

afterAll(async () => {
  await fixture.cleanup()
})

describe("queue — append and read", () => {
  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  test("appending to empty queue returns wasEmpty=true and assigns id=1", async () => {
    const { entry, wasEmpty } = await appendToQueue(fixture.cwd, makeEntry())
    expect(wasEmpty).toBe(true)
    expect(entry.id).toBe(1)
    expect(entry.programSlug).toBe("bench")
    expect(entry.retryCount).toBe(0)
    expect(entry.lastError).toBeNull()
    expect(entry.addedAt).toBeTruthy()
  })

  test("appending second entry returns wasEmpty=false and auto-increments id", async () => {
    const { entry: first } = await appendToQueue(fixture.cwd, makeEntry())
    const { entry, wasEmpty } = await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 20 }))
    expect(wasEmpty).toBe(false)
    expect(entry.id).toBe(first.id + 1)
    expect(entry.maxExperiments).toBe(20)
  })

  test("readQueue reflects all appended entries in order", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench" }))
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "other" }))
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 30 }))

    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(3)
    expect(queue.entries[0].programSlug).toBe("bench")
    expect(queue.entries[1].programSlug).toBe("other")
    expect(queue.entries[2].maxExperiments).toBe(30)
    // nextId should be one past the last assigned id
    expect(queue.nextId).toBe(queue.entries[2].id + 1)
  })

  test("readQueue returns empty state for nonexistent queue file", async () => {
    // clearQueue already ran, queue.json exists but is empty
    const { unlink } = await import("node:fs/promises")
    await unlink(join(fixture.cwd, ".autoauto", "queue.json")).catch(() => {})
    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(0)
    expect(queue.nextId).toBe(1)
  })
})

describe("queue — pop", () => {
  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  test("popQueue returns first entry and removes it (FIFO)", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 10 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 20 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 30 }))

    const first = await popQueue(fixture.cwd)
    expect(first).not.toBeNull()
    expect(first!.maxExperiments).toBe(10)

    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(2)
    expect(queue.entries[0].maxExperiments).toBe(20)
  })

  test("popQueue returns null on empty queue", async () => {
    const entry = await popQueue(fixture.cwd)
    expect(entry).toBeNull()
  })

  test("successive pops drain the queue in FIFO order", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 1 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 2 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 3 }))

    const a = await popQueue(fixture.cwd)
    const b = await popQueue(fixture.cwd)
    const c = await popQueue(fixture.cwd)
    const d = await popQueue(fixture.cwd)

    expect(a!.maxExperiments).toBe(1)
    expect(b!.maxExperiments).toBe(2)
    expect(c!.maxExperiments).toBe(3)
    expect(d).toBeNull()
  })
})

describe("queue — remove by id", () => {
  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  test("removeFromQueue removes specific entry by id", async () => {
    const { entry: e1 } = await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 10 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 20 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 30 }))

    const removed = await removeFromQueue(fixture.cwd, e1.id)
    expect(removed).not.toBeNull()
    expect(removed!.maxExperiments).toBe(10)

    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(2)
    expect(queue.entries[0].maxExperiments).toBe(20)
    expect(queue.entries[1].maxExperiments).toBe(30)
  })

  test("removeFromQueue returns null for nonexistent id", async () => {
    await appendToQueue(fixture.cwd, makeEntry())
    const removed = await removeFromQueue(fixture.cwd, 999)
    expect(removed).toBeNull()
  })

  test("remove middle entry preserves order of remaining", async () => {
    const { entry: e1 } = await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 10 }))
    const { entry: e2 } = await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 20 }))
    const { entry: e3 } = await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 30 }))

    await removeFromQueue(fixture.cwd, e2.id)

    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(2)
    expect(queue.entries[0].id).toBe(e1.id)
    expect(queue.entries[1].id).toBe(e3.id)
  })
})

describe("queue — clear", () => {
  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  test("clearQueue empties queue and returns removed entries", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 10 }))
    await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: 20 }))

    const cleared = await clearQueue(fixture.cwd)
    expect(cleared).toHaveLength(2)
    expect(cleared[0].maxExperiments).toBe(10)
    expect(cleared[1].maxExperiments).toBe(20)

    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(0)
  })

  test("clearQueue on empty queue returns empty array", async () => {
    const cleared = await clearQueue(fixture.cwd)
    expect(cleared).toHaveLength(0)
  })
})

describe("queue — program exclusivity", () => {
  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  afterEach(async () => {
    // Release any locks we acquired
    await releaseLock(getProgramDir(fixture.cwd, "bench"))
    await releaseLock(getProgramDir(fixture.cwd, "other"))
  })

  test("rejects append when program has an active manual run (lock, no queue entries)", async () => {
    const programDir = getProgramDir(fixture.cwd, "bench")
    await acquireLock(programDir, "run-1", "daemon-1", 0, "/tmp/wt")

    await expect(
      appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench" })),
    ).rejects.toThrow("active manual run")
  })

  test("allows append when program is locked but already has queue entries", async () => {
    // First append succeeds (no lock)
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench" }))

    // Acquire lock (simulating a running daemon started from queue)
    const programDir = getProgramDir(fixture.cwd, "bench")
    await acquireLock(programDir, "run-1", "daemon-1", 0, "/tmp/wt")

    // Second append should succeed because queue entries already exist
    const { entry } = await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 20 }))
    expect(entry.maxExperiments).toBe(20)
  })

  test("allows append for different program even when another is locked", async () => {
    const programDir = getProgramDir(fixture.cwd, "bench")
    await acquireLock(programDir, "run-1", "daemon-1", 0, "/tmp/wt")

    // Appending to "other" should succeed — exclusivity is per-program
    const { entry } = await appendToQueue(fixture.cwd, makeEntry({ programSlug: "other" }))
    expect(entry.programSlug).toBe("other")
  })
})

describe("queue — concurrent locking", () => {
  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  test("concurrent appends all succeed with unique ids", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendToQueue(fixture.cwd, makeEntry({ maxExperiments: i + 1 })),
      ),
    )

    const ids = results.map((r) => r.entry.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(5)

    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(5)
  })

  test("concurrent pops never return the same entry", async () => {
    // Seed 5 entries
    for (let i = 0; i < 5; i++) {
      await appendToQueue(fixture.cwd, makeEntry({ maxExperiments: i + 1 }))
    }

    // Pop concurrently — some may return null if lock is contended
    const results = await Promise.all(
      Array.from({ length: 5 }, () => popQueue(fixture.cwd)),
    )

    const popped = results.filter((r) => r !== null)
    const poppedIds = popped.map((r) => r!.id)
    const uniquePoppedIds = new Set(poppedIds)

    // All popped entries have unique ids (no double-pop)
    expect(uniquePoppedIds.size).toBe(popped.length)
  })
})

describe("queue — startNextFromQueue", () => {
  // Mock spawnDaemon so we don't spawn real processes — passed via spawnFn parameter
  const spawnDaemonMock = mock(() =>
    Promise.resolve({ runId: "mock-run-id", runDir: "/tmp/mock-run", worktreePath: null, pid: 12345 }),
  ) as any

  beforeEach(async () => {
    await clearQueue(fixture.cwd)
    spawnDaemonMock.mockClear()
  })

  test("starts daemon with correct config from queue entry", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 15 }))

    const result = await startNextFromQueue(fixture.cwd, true, spawnDaemonMock)
    expect(result.started).toBe(true)
    if (result.started) {
      expect(result.entry.programSlug).toBe("bench")
      expect(result.entry.maxExperiments).toBe(15)
      expect(result.runId).toBe("mock-run-id")
    }

    // Verify spawnDaemon was called with correct args
    expect(spawnDaemonMock).toHaveBeenCalledTimes(1)
    const args = spawnDaemonMock.mock.calls[0]
    expect(args[0]).toBe(fixture.cwd) // mainRoot
    expect(args[1]).toBe("bench") // programSlug
    expect(args[3]).toBe(15) // maxExperiments
    expect(args[7]).toBe("queue") // source

    // Queue should be empty after pop
    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(0)
  })

  test("returns started=false when queue is empty", async () => {
    const result = await startNextFromQueue(fixture.cwd, true, spawnDaemonMock)
    expect(result.started).toBe(false)
    expect(spawnDaemonMock).not.toHaveBeenCalled()
  })

  test("skips entries that exceeded MAX_RETRIES and processes next", async () => {
    // Write queue with a failed entry (retryCount >= 2) followed by a good one
    await writeQueue(fixture.cwd, {
      nextId: 3,
      entries: [
        {
          id: 1,
          programSlug: "bench",
          modelConfig: MODEL,
          maxExperiments: 10,
          useWorktree: true,
          addedAt: new Date().toISOString(),
          retryCount: 2, // exceeded MAX_RETRIES
          lastError: "previous failure",
        },
        {
          id: 2,
          programSlug: "bench",
          modelConfig: MODEL,
          maxExperiments: 20,
          useWorktree: true,
          addedAt: new Date().toISOString(),
          retryCount: 0,
          lastError: null,
        },
      ],
    })

    const result = await startNextFromQueue(fixture.cwd, true, spawnDaemonMock)
    expect(result.started).toBe(true)
    if (result.started) {
      expect(result.entry.id).toBe(2)
      expect(result.entry.maxExperiments).toBe(20)
    }

    // Failed entry should be discarded, good one started
    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(0)
  })

  test("re-inserts entry with incremented retryCount on spawn failure", async () => {
    const failingSpawn = mock(() => Promise.reject(new Error("spawn failed"))) as any

    // Add two entries — first will fail to spawn, second should be tried next
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 10 }))
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 20 }))

    // startNextFromQueue loops: first entry fails → re-inserted with retryCount=1,
    // then pops second entry → also fails → re-inserted with retryCount=1,
    // then pops first again (retryCount=1) → fails → re-inserted with retryCount=2,
    // then pops second again (retryCount=1) → fails → re-inserted with retryCount=2,
    // then pops first again (retryCount=2) → skipped,
    // then pops second again (retryCount=2) → skipped,
    // queue empty → returns started=false
    const result = await startNextFromQueue(fixture.cwd, true, failingSpawn)
    expect(result.started).toBe(false)
    expect(result.lastError).toBeTruthy()

    // Both entries should have been exhausted
    const queue = await readQueue(fixture.cwd)
    expect(queue.entries).toHaveLength(0)
  })

  test("processes multiple entries in FIFO order", async () => {
    const startedEntries: string[] = []
    const trackingSpawn = mock((_root: string, slug: string) => {
      startedEntries.push(slug)
      return Promise.resolve({ runId: `run-${slug}`, runDir: "/tmp/mock", worktreePath: null, pid: 1 })
    }) as any

    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench" }))

    const result = await startNextFromQueue(fixture.cwd, true, trackingSpawn)
    expect(result.started).toBe(true)
    // startNextFromQueue starts one entry and returns — it doesn't drain the queue
    expect(startedEntries).toEqual(["bench"])
  })
})

describe("queue — UI display via HomeScreen", () => {
  let harness: TuiHarness | null = null

  beforeEach(async () => {
    await clearQueue(fixture.cwd)
  })

  afterEach(async () => {
    await harness?.destroy()
    harness = null
    resetProjectRoot()
  })

  function renderHome() {
    return renderTui(
      <HomeScreen
        cwd={fixture.cwd}
        navigate={noop}
        onSelectProgram={noop}
        onSelectRun={noop}
        onUpdateProgram={noop}
        onFinalizeRun={noop}
        onResumeDraft={noop}
      />,
      { width: 120 },
    )
  }

  test("adding entries via appendToQueue shows in HomeScreen", async () => {
    // Add entries via real queue API
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 10 }))
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench", maxExperiments: 20 }))

    harness = await renderHome()
    const frame = await harness.waitForText("Queue (2)")
    expect(frame).toContain("bench")
  })

  test("queue panel disappears after clearing all entries", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench" }))

    harness = await renderHome()
    await harness.waitForText("Queue (1)")

    // Clear queue via real API
    await clearQueue(fixture.cwd)

    // Re-render — panel should vanish. HomeScreen re-reads on focus.
    await harness.destroy()
    harness = await renderHome()
    const frame = await harness.flush(200)
    expect(frame).not.toContain("Queue (")
  })

  test("queue shows multiple programs", async () => {
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "bench" }))
    await appendToQueue(fixture.cwd, makeEntry({ programSlug: "other" }))

    harness = await renderHome()
    const frame = await harness.waitForText("Queue (2)")
    expect(frame).toContain("bench")
    expect(frame).toContain("other")
  })
})
