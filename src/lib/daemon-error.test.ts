import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { $ } from "bun"
import { readDaemonLogTail, getDaemonStatus } from "./daemon-status.ts"
import { spawnDaemon } from "./daemon-spawn.ts"
import { releaseLock } from "./daemon-lifecycle.ts"

/** Poll until the daemon PID exits, or timeout. */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      // Still alive
      await new Promise((r) => setTimeout(r, 200))
    } catch {
      return true // exited
    }
  }
  return false
}

// --- readDaemonLogTail unit tests ---

describe("readDaemonLogTail", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "daemon-log-test-"))
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test("returns empty string when daemon.log does not exist", async () => {
    const result = await readDaemonLogTail(join(tmpDir, "nonexistent"))
    expect(result).toBe("")
  })

  test("returns empty string when daemon.log is empty", async () => {
    const runDir = join(tmpDir, "empty-log")
    await mkdir(runDir, { recursive: true })
    await Bun.write(join(runDir, "daemon.log"), "")
    const result = await readDaemonLogTail(runDir)
    expect(result).toBe("")
  })

  test("returns full content for small log", async () => {
    const runDir = join(tmpDir, "small-log")
    await mkdir(runDir, { recursive: true })
    await Bun.write(join(runDir, "daemon.log"), "Daemon fatal error: API key not configured\n")
    const result = await readDaemonLogTail(runDir)
    expect(result).toBe("Daemon fatal error: API key not configured")
  })

  test("returns last ~2KB for large log", async () => {
    const runDir = join(tmpDir, "large-log")
    await mkdir(runDir, { recursive: true })
    // Write 5KB of padding + a distinctive error at the end
    const padding = "x".repeat(4096) + "\n"
    const errorLine = "Daemon fatal error: something broke badly\n"
    await Bun.write(join(runDir, "daemon.log"), padding + errorLine)
    const result = await readDaemonLogTail(runDir)
    expect(result).toContain("Daemon fatal error: something broke badly")
    // Should NOT contain the full padding (only last ~2KB)
    expect(result.length).toBeLessThan(3000)
  })

  test("preserves multiline error output", async () => {
    const runDir = join(tmpDir, "multiline-log")
    await mkdir(runDir, { recursive: true })
    const content = [
      "Starting experiment loop...",
      "Error: ANTHROPIC_API_KEY is not set",
      "  at validateConfig (/src/lib/config.ts:42:11)",
      "  at main (/src/daemon.ts:69:3)",
    ].join("\n")
    await Bun.write(join(runDir, "daemon.log"), content + "\n")
    const result = await readDaemonLogTail(runDir)
    expect(result).toContain("ANTHROPIC_API_KEY is not set")
    expect(result).toContain("at validateConfig")
  })
})

// --- Integration: spawn a real daemon that fails ---

describe("daemon startup failure", () => {
  test("records baseline failure in state.json with descriptive error", async () => {
    // When measure.sh fails, the daemon handles it gracefully:
    // writes error to state.json and exits cleanly.
    const cwd = await mkdtemp(join(tmpdir(), "daemon-fail-measure-"))
    const programSlug = "bad-measure"
    const programDir = join(cwd, ".autoauto", "programs", programSlug)
    try {
      await $`git init`.cwd(cwd).quiet()
      await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
      await $`git config user.name "Test User"`.cwd(cwd).quiet()
      await mkdir(programDir, { recursive: true })

      await Bun.write(
        join(cwd, ".autoauto", "config.json"),
        JSON.stringify({
          executionModel: { provider: "claude", model: "sonnet", effort: "high" },
          supportModel: { provider: "claude", model: "haiku", effort: "low" },
        }),
      )

      // Measure script that exits non-zero
      await Bun.write(join(programDir, "measure.sh"), "#!/bin/bash\necho 'THIS IS NOT JSON'\nexit 1\n")
      await chmod(join(programDir, "measure.sh"), 0o755)

      await Bun.write(
        join(programDir, "config.json"),
        JSON.stringify({
          metric_field: "score",
          direction: "lower",
          noise_threshold: 0.02,
          repeats: 1,
          max_experiments: 10,
          quality_gates: {},
        }),
      )

      await Bun.write(join(cwd, "README.md"), "# test\n")
      await $`git add -A`.cwd(cwd).quiet()
      await $`git commit -m "init"`.cwd(cwd).quiet()

      const modelConfig = { provider: "claude" as const, model: "sonnet", effort: "high" as const }
      const result = await spawnDaemon(cwd, programSlug, modelConfig, 5, true, false)

      // Wait for daemon process to exit
      const exited = await waitForProcessExit(result.pid, 15_000)
      expect(exited).toBe(true)

      // State should reflect baseline failure with descriptive error
      const state = await Bun.file(join(result.runDir, "state.json")).json() as { phase: string; error: string | null; error_phase: string | null }
      expect(state.phase).toBe("crashed")
      expect(state.error).toContain("Baseline measurement failed")
      expect(state.error_phase).toBe("baseline")

    } finally {
      await releaseLock(programDir).catch(() => {})
      await rm(cwd, { recursive: true, force: true })
    }
  }, 20_000)

  test("getDaemonStatus detects death via PID even with fresh heartbeat", async () => {
    // Simulates a daemon that wrote a heartbeat then crashed immediately.
    // getDaemonStatus should detect the dead PID rather than trusting the fresh heartbeat.
    const cwd = await mkdtemp(join(tmpdir(), "daemon-fail-pidcheck-"))
    const programSlug = "pid-check"
    const programDir = join(cwd, ".autoauto", "programs", programSlug)
    try {
      await $`git init`.cwd(cwd).quiet()
      await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
      await $`git config user.name "Test User"`.cwd(cwd).quiet()
      await mkdir(programDir, { recursive: true })
      await Bun.write(join(cwd, ".autoauto", "config.json"), JSON.stringify({
        executionModel: { provider: "claude", model: "sonnet", effort: "high" },
        supportModel: { provider: "claude", model: "haiku", effort: "low" },
      }))
      // Invalid config to make daemon crash on startup
      await Bun.write(join(programDir, "config.json"), JSON.stringify({ bad: true }))
      await Bun.write(join(cwd, "README.md"), "# test\n")
      await $`git add -A`.cwd(cwd).quiet()
      await $`git commit -m "init"`.cwd(cwd).quiet()

      const modelConfig = { provider: "claude" as const, model: "sonnet", effort: "high" as const }
      const result = await spawnDaemon(cwd, programSlug, modelConfig, 5, true, false)

      // Wait for daemon to exit
      const exited = await waitForProcessExit(result.pid, 10_000)
      expect(exited).toBe(true)

      // daemon.json has a fresh heartbeat_at (written during startup), but PID is dead.
      // getDaemonStatus should report alive=false immediately, not wait 30s.
      const status = await getDaemonStatus(result.runDir)
      expect(status.alive).toBe(false)

    } finally {
      await releaseLock(programDir).catch(() => {})
      await rm(cwd, { recursive: true, force: true })
    }
  }, 15_000)

  test("writes error to daemon.log when program config is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "daemon-fail-noconfig-"))
    const programSlug = "no-config"
    const programDir = join(cwd, ".autoauto", "programs", programSlug)
    try {
      await $`git init`.cwd(cwd).quiet()
      await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
      await $`git config user.name "Test User"`.cwd(cwd).quiet()
      await mkdir(join(programDir, "runs"), { recursive: true })

      await Bun.write(
        join(cwd, ".autoauto", "config.json"),
        JSON.stringify({
          executionModel: { provider: "claude", model: "sonnet", effort: "high" },
          supportModel: { provider: "claude", model: "haiku", effort: "low" },
        }),
      )

      await Bun.write(join(cwd, "README.md"), "# test\n")
      await $`git add -A`.cwd(cwd).quiet()
      await $`git commit -m "init"`.cwd(cwd).quiet()

      const modelConfig = { provider: "claude" as const, model: "sonnet", effort: "high" as const }
      const result = await spawnDaemon(cwd, programSlug, modelConfig, 5, true, false)

      const exited = await waitForProcessExit(result.pid, 15_000)
      expect(exited).toBe(true)

      // daemon.log should contain something about the missing config
      const logTail = await readDaemonLogTail(result.runDir)
      expect(logTail.length).toBeGreaterThan(0)
      // The daemon logs an error referencing the missing config.json
      expect(logTail).toContain("config.json")

    } finally {
      await releaseLock(programDir).catch(() => {})
      await rm(cwd, { recursive: true, force: true })
    }
  }, 20_000)
})
