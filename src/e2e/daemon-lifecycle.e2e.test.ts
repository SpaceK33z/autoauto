import { describe, test, expect, afterEach, beforeEach } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import {
  acquireLock,
  releaseLock,
  readLock,
  updateLockPid,
  writeDaemonJson,
  readDaemonJson,
  updateHeartbeat,
  writeRunConfig,
  readRunConfig,
  setActiveModelInRunConfig,
  runConfigToModelSlot,
  runConfigToFallbackSlot,
  runConfigToActiveSlot,
  type RunLock,
  type DaemonJson,
  type RunConfig,
} from "../lib/daemon-lifecycle.ts"

// --- Helpers to simulate pre-existing state left by a crashed daemon ---

async function writeRawLock(programDir: string, lock: RunLock): Promise<void> {
  await Bun.write(join(programDir, "run.lock"), JSON.stringify(lock, null, 2) + "\n")
}

async function writeRawDaemonJson(runDir: string, daemon: DaemonJson): Promise<void> {
  await Bun.write(join(runDir, "daemon.json"), JSON.stringify(daemon, null, 2) + "\n")
}

function pastIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

/** Plant a stale lock scenario: creates run dir, writes lock, and optionally writes daemon.json. */
async function plantStaleLock(
  programDir: string,
  opts: {
    runId: string
    lockDaemonId?: string
    lockAge: number
    daemon?: { daemonId: string; heartbeatAge?: number }
  },
): Promise<void> {
  const runDir = join(programDir, "runs", opts.runId)
  await mkdir(runDir, { recursive: true })
  await writeRawLock(programDir, {
    run_id: opts.runId,
    daemon_id: opts.lockDaemonId ?? opts.daemon?.daemonId ?? "daemon-old",
    pid: 99999,
    worktree_path: "/tmp/old",
    created_at: pastIso(opts.lockAge),
  })
  if (opts.daemon) {
    await writeRawDaemonJson(runDir, {
      run_id: opts.runId,
      pid: 99999,
      started_at: pastIso(opts.lockAge),
      worktree_path: "/tmp/old",
      daemon_id: opts.daemon.daemonId,
      ...(opts.daemon.heartbeatAge !== undefined
        ? { heartbeat_at: pastIso(opts.daemon.heartbeatAge) }
        : {}),
    })
  }
}

// --- Tests ---

describe("acquireLock and releaseLock", () => {
  let fixture: TestFixture
  let programDir: string

  beforeEach(async () => {
    fixture = await createTestFixture()
    programDir = await fixture.createProgram("lock-test", {})
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("acquireLock succeeds on fresh directory", async () => {
    const result = await acquireLock(programDir, "run-1", "daemon-1", process.pid, "/tmp/wt")
    expect(result).toBe(true)

    const lock = await readLock(programDir)
    expect(lock).not.toBeNull()
    expect(lock!.run_id).toBe("run-1")
    expect(lock!.daemon_id).toBe("daemon-1")
    expect(lock!.pid).toBe(process.pid)
    expect(lock!.worktree_path).toBe("/tmp/wt")
    expect(lock!.created_at).toBeTruthy()
  })

  test("acquireLock fails when held by live daemon", async () => {
    await acquireLock(programDir, "run-1", "daemon-A", process.pid, "/tmp/wt")
    const runDir = join(programDir, "runs", "run-1")
    await mkdir(runDir, { recursive: true })
    await writeDaemonJson(runDir, "run-1", "/tmp/wt", "daemon-A")

    const result = await acquireLock(programDir, "run-2", "daemon-B", process.pid, "/tmp/wt2")
    expect(result).toBe(false)

    const lock = await readLock(programDir)
    expect(lock!.daemon_id).toBe("daemon-A")
  })

  test("releaseLock removes the lock", async () => {
    await acquireLock(programDir, "run-1", "daemon-1", process.pid, "/tmp/wt")
    await releaseLock(programDir)

    const lock = await readLock(programDir)
    expect(lock).toBeNull()
  })

  test("releaseLock is idempotent on missing lock", async () => {
    await releaseLock(programDir)
    await releaseLock(programDir)
  })

  test("readLock returns null when no lock exists", async () => {
    const lock = await readLock(programDir)
    expect(lock).toBeNull()
  })

  test("updateLockPid updates the pid", async () => {
    await acquireLock(programDir, "run-1", "daemon-1", 100, "/tmp/wt")

    await updateLockPid(programDir, "run-1", "daemon-1", 200)

    const lock = await readLock(programDir)
    expect(lock!.pid).toBe(200)
    expect(lock!.run_id).toBe("run-1")
    expect(lock!.daemon_id).toBe("daemon-1")
  })

  test("updateLockPid is a no-op when run_id does not match", async () => {
    await acquireLock(programDir, "run-1", "daemon-1", 100, "/tmp/wt")

    await updateLockPid(programDir, "run-wrong", "daemon-1", 999)

    const lock = await readLock(programDir)
    expect(lock!.pid).toBe(100)
  })
})

describe("stale lock detection", () => {
  let fixture: TestFixture
  let programDir: string

  beforeEach(async () => {
    fixture = await createTestFixture()
    programDir = await fixture.createProgram("stale-test", {})
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("acquires lock when no daemon.json and lock age > 30s", async () => {
    await plantStaleLock(programDir, { runId: "run-old", lockAge: 60_000 })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(true)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-new")
  })

  test("does NOT acquire lock when no daemon.json and lock age <= 30s", async () => {
    await plantStaleLock(programDir, { runId: "run-recent", lockAge: 5_000 })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(false)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-old")
  })

  test("acquires lock when daemon_id in daemon.json mismatches lock", async () => {
    await plantStaleLock(programDir, {
      runId: "run-mismatch",
      lockDaemonId: "daemon-lock",
      lockAge: 5_000, // recent — would NOT be stale without mismatch
      daemon: { daemonId: "daemon-different", heartbeatAge: 0 },
    })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(true)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-new")
  })

  test("acquires lock when heartbeat > 30s old", async () => {
    await plantStaleLock(programDir, {
      runId: "run-stale-hb",
      lockAge: 60_000,
      daemon: { daemonId: "daemon-A", heartbeatAge: 60_000 },
    })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(true)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-new")
  })

  test("does NOT acquire lock when heartbeat is fresh", async () => {
    await plantStaleLock(programDir, {
      runId: "run-live",
      lockAge: 60_000,
      daemon: { daemonId: "daemon-A", heartbeatAge: 5_000 },
    })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(false)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-A")
  })

  test("acquires lock when no heartbeat_at and lock age > 30s", async () => {
    await plantStaleLock(programDir, {
      runId: "run-no-hb",
      lockAge: 60_000,
      daemon: { daemonId: "daemon-A" }, // no heartbeatAge → no heartbeat_at
    })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(true)
  })

  test("does NOT acquire lock when no heartbeat_at and lock age <= 30s", async () => {
    await plantStaleLock(programDir, {
      runId: "run-no-hb-recent",
      lockAge: 5_000,
      daemon: { daemonId: "daemon-A" },
    })

    const result = await acquireLock(programDir, "run-new", "daemon-new", process.pid, "/tmp/new")
    expect(result).toBe(false)
  })
})

describe("writeDaemonJson and updateHeartbeat", () => {
  let fixture: TestFixture
  let runDir: string

  beforeEach(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("daemon-test", {})
    runDir = await fixture.createRun("daemon-test", { run_id: "run-1" })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("writeDaemonJson round-trips via readDaemonJson", async () => {
    await writeDaemonJson(runDir, "run-1", "/tmp/wt", "daemon-1")

    const daemon = await readDaemonJson(runDir)
    expect(daemon).not.toBeNull()
    expect(daemon!.run_id).toBe("run-1")
    expect(daemon!.daemon_id).toBe("daemon-1")
    expect(daemon!.worktree_path).toBe("/tmp/wt")
    expect(daemon!.pid).toBe(process.pid)
    expect(daemon!.started_at).toBeTruthy()
    expect(daemon!.heartbeat_at).toBeTruthy()
  })

  test("writeDaemonJson preserves existing started_at", async () => {
    const fixedStart = "2026-01-01T00:00:00.000Z"
    await writeRawDaemonJson(runDir, {
      run_id: "run-1",
      pid: 1234,
      started_at: fixedStart,
      worktree_path: "/tmp/wt",
    })

    await writeDaemonJson(runDir, "run-1", "/tmp/wt", "daemon-1")

    const daemon = await readDaemonJson(runDir)
    expect(daemon!.started_at).toBe(fixedStart)
    expect(daemon!.daemon_id).toBe("daemon-1")
  })

  test("readDaemonJson returns null for missing file", async () => {
    const freshDir = join(runDir, "..", "run-empty")
    await mkdir(freshDir, { recursive: true })

    const daemon = await readDaemonJson(freshDir)
    expect(daemon).toBeNull()
  })

  test("updateHeartbeat advances heartbeat_at", async () => {
    await writeDaemonJson(runDir, "run-1", "/tmp/wt", "daemon-1")
    const before = (await readDaemonJson(runDir))!.heartbeat_at!

    await new Promise((r) => setTimeout(r, 10))
    await updateHeartbeat(runDir, "daemon-1")

    const after = (await readDaemonJson(runDir))!.heartbeat_at!
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime())
  })

  test("updateHeartbeat is a no-op when daemon_id does not match", async () => {
    await writeDaemonJson(runDir, "run-1", "/tmp/wt", "daemon-1")
    const before = (await readDaemonJson(runDir))!.heartbeat_at!

    await updateHeartbeat(runDir, "daemon-wrong")

    const after = (await readDaemonJson(runDir))!.heartbeat_at!
    expect(after).toBe(before)
  })
})

describe("run config persistence", () => {
  let fixture: TestFixture
  let runDir: string

  beforeEach(async () => {
    fixture = await createTestFixture()
    await fixture.createProgram("config-test", {})
    runDir = await fixture.createRun("config-test", { run_id: "run-1" })
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("writeRunConfig and readRunConfig round-trip", async () => {
    const config: RunConfig = {
      provider: "claude",
      model: "sonnet",
      effort: "high",
      max_experiments: 20,
      max_cost_usd: 5.0,
      ideas_backlog_enabled: true,
      carry_forward: true,
    }
    await writeRunConfig(runDir, config)

    const read = await readRunConfig(runDir)
    expect(read).toEqual(config)
  })

  test("readRunConfig returns null for missing file", async () => {
    const freshDir = join(runDir, "..", "run-empty")
    await mkdir(freshDir, { recursive: true })

    const config = await readRunConfig(freshDir)
    expect(config).toBeNull()
  })
})

describe("model slot helpers", () => {
  const baseConfig: RunConfig = {
    model: "sonnet",
    effort: "high",
    max_experiments: 10,
  }

  test("runConfigToModelSlot extracts primary slot", () => {
    const slot = runConfigToModelSlot({ ...baseConfig, provider: "claude" })
    expect(slot).toEqual({ provider: "claude", model: "sonnet", effort: "high" })
  })

  test("runConfigToModelSlot defaults provider to claude", () => {
    const slot = runConfigToModelSlot(baseConfig)
    expect(slot.provider).toBe("claude")
  })

  test("runConfigToFallbackSlot returns slot when all fallback fields set", () => {
    const config: RunConfig = {
      ...baseConfig,
      fallback_provider: "codex",
      fallback_model: "o3",
      fallback_effort: "max",
    }
    expect(runConfigToFallbackSlot(config)).toEqual({ provider: "codex", model: "o3", effort: "max" })
  })

  test("runConfigToFallbackSlot returns null when any fallback field missing", () => {
    const config: RunConfig = {
      ...baseConfig,
      fallback_provider: "codex",
      fallback_model: "o3",
    }
    expect(runConfigToFallbackSlot(config)).toBeNull()
  })

  test("runConfigToActiveSlot returns active override when set", () => {
    const config: RunConfig = {
      ...baseConfig,
      active_provider: "codex",
      active_model: "o3",
      active_effort: "max",
    }
    expect(runConfigToActiveSlot(config)).toEqual({ provider: "codex", model: "o3", effort: "max" })
  })

  test("runConfigToActiveSlot falls back to primary when no active fields", () => {
    const slot = runConfigToActiveSlot({ ...baseConfig, provider: "claude" })
    expect(slot).toEqual({ provider: "claude", model: "sonnet", effort: "high" })
  })

  test("runConfigToActiveSlot falls back to primary when active fields incomplete", () => {
    const config: RunConfig = {
      ...baseConfig,
      provider: "claude",
      active_provider: "codex",
    }
    expect(runConfigToActiveSlot(config)).toEqual({ provider: "claude", model: "sonnet", effort: "high" })
  })

  test("setActiveModelInRunConfig returns new config with active fields", () => {
    const result = setActiveModelInRunConfig(baseConfig, {
      provider: "codex",
      model: "o3",
      effort: "max",
    })
    expect(result.active_provider).toBe("codex")
    expect(result.active_model).toBe("o3")
    expect(result.active_effort).toBe("max")
  })

  test("setActiveModelInRunConfig does not mutate the original", () => {
    const original: RunConfig = { ...baseConfig, max_cost_usd: 10 }
    const originalCopy = { ...original }

    setActiveModelInRunConfig(original, {
      provider: "codex",
      model: "o3",
      effort: "max",
    })

    expect(original).toEqual(originalCopy)
  })

  test("setActiveModelInRunConfig preserves all other config fields", () => {
    const config: RunConfig = {
      ...baseConfig,
      provider: "claude",
      max_cost_usd: 10,
      ideas_backlog_enabled: true,
      carry_forward: true,
      source: "queue",
    }
    const result = setActiveModelInRunConfig(config, {
      provider: "codex",
      model: "o3",
      effort: "max",
    })
    expect(result.provider).toBe("claude")
    expect(result.model).toBe("sonnet")
    expect(result.max_cost_usd).toBe(10)
    expect(result.ideas_backlog_enabled).toBe(true)
    expect(result.carry_forward).toBe(true)
    expect(result.source).toBe("queue")
  })
})

describe("lock contention", () => {
  let fixture: TestFixture
  let programDir: string

  beforeEach(async () => {
    fixture = await createTestFixture()
    programDir = await fixture.createProgram("contention-test", {})
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  test("second caller is blocked while first holds the lock", async () => {
    await acquireLock(programDir, "run-A", "daemon-A", process.pid, "/tmp/a")
    const runDir = join(programDir, "runs", "run-A")
    await mkdir(runDir, { recursive: true })
    await writeDaemonJson(runDir, "run-A", "/tmp/a", "daemon-A")

    const resultB = await acquireLock(programDir, "run-B", "daemon-B", process.pid, "/tmp/b")
    expect(resultB).toBe(false)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-A")
  })

  test("repeated attempts by loser still fail", async () => {
    await acquireLock(programDir, "run-A", "daemon-A", process.pid, "/tmp/a")
    const runDir = join(programDir, "runs", "run-A")
    await mkdir(runDir, { recursive: true })
    await writeDaemonJson(runDir, "run-A", "/tmp/a", "daemon-A")

    expect(await acquireLock(programDir, "run-B", "daemon-B", process.pid, "/tmp/b")).toBe(false)
    expect(await acquireLock(programDir, "run-B", "daemon-B", process.pid, "/tmp/b")).toBe(false)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-A")
  })

  test("winner releases, then loser can acquire", async () => {
    await acquireLock(programDir, "run-A", "daemon-A", process.pid, "/tmp/a")
    await releaseLock(programDir)

    const result = await acquireLock(programDir, "run-B", "daemon-B", process.pid, "/tmp/b")
    expect(result).toBe(true)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-B")
  })

  test("sequential acquire-release-acquire works", async () => {
    expect(await acquireLock(programDir, "run-1", "daemon-1", process.pid, "/tmp/1")).toBe(true)
    await releaseLock(programDir)

    expect(await acquireLock(programDir, "run-2", "daemon-2", process.pid, "/tmp/2")).toBe(true)
    expect((await readLock(programDir))!.daemon_id).toBe("daemon-2")
  })
})
