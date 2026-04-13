import { describe, test, expect } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ENTRY = join(import.meta.dir, "..", "index.tsx")

describe("_sandbox-helper CLI", () => {
  let tmpDir: string

  async function setup() {
    tmpDir = await mkdtemp(join(tmpdir(), "sandbox-helper-test-"))
  }

  async function cleanup() {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  }

  // --- exec ---

  test("exec runs command and returns stdout", async () => {
    await setup()
    try {
      const result = await $`bun ${ENTRY} _sandbox-helper exec echo hello`.nothrow().quiet()
      expect(result.exitCode).toBe(0)
      expect(result.text().trim()).toBe("hello")
    } finally {
      await cleanup()
    }
  })

  test("exec returns non-zero exit code", async () => {
    await setup()
    try {
      const result = await $`bun ${ENTRY} _sandbox-helper exec sh -c "exit 42"`.nothrow().quiet()
      expect(result.exitCode).toBe(42)
    } finally {
      await cleanup()
    }
  })

  // --- cat ---

  test("cat outputs file contents", async () => {
    await setup()
    try {
      const filePath = join(tmpDir, "test.txt")
      await Bun.write(filePath, "file contents here")
      const result = await $`bun ${ENTRY} _sandbox-helper cat ${filePath}`.nothrow().quiet()
      expect(result.exitCode).toBe(0)
      expect(result.text()).toBe("file contents here")
    } finally {
      await cleanup()
    }
  })

  test("cat with --offset outputs from byte N", async () => {
    await setup()
    try {
      const filePath = join(tmpDir, "offset.txt")
      await Bun.write(filePath, "0123456789abcdef")
      const result = await $`bun ${ENTRY} _sandbox-helper cat ${filePath} --offset 10`.nothrow().quiet()
      expect(result.exitCode).toBe(0)
      expect(result.text()).toBe("abcdef")
    } finally {
      await cleanup()
    }
  })

  test("cat on non-existent file exits with error", async () => {
    await setup()
    try {
      const result = await $`bun ${ENTRY} _sandbox-helper cat /tmp/nonexistent-file-${Date.now()}.txt`.nothrow().quiet()
      expect(result.exitCode).toBe(1)
    } finally {
      await cleanup()
    }
  })

  // --- write ---

  test("write creates file from stdin", async () => {
    await setup()
    try {
      const filePath = join(tmpDir, "written.txt")
      await $`echo -n "written content" | bun ${ENTRY} _sandbox-helper write ${filePath}`.nothrow().quiet()
      const content = await Bun.file(filePath).text()
      expect(content).toBe("written content")
    } finally {
      await cleanup()
    }
  })

  // --- status ---

  test("status outputs daemon status JSON", async () => {
    await setup()
    try {
      const runDir = join(tmpDir, "run")
      await mkdir(runDir, { recursive: true })
      await Bun.write(join(runDir, "daemon.json"), JSON.stringify({
        run_id: "test",
        pid: 12345,
        started_at: new Date().toISOString(),
        daemon_id: "abc",
        heartbeat_at: new Date().toISOString(),
      }))

      const result = await $`bun ${ENTRY} _sandbox-helper status ${runDir}`.nothrow().quiet()
      expect(result.exitCode).toBe(0)
      const status = JSON.parse(result.text())
      expect(status.alive).toBe(true)
      expect(status.daemonJson.run_id).toBe("test")
    } finally {
      await cleanup()
    }
  })

  test("status returns not alive for missing daemon.json", async () => {
    await setup()
    try {
      const runDir = join(tmpDir, "empty-run")
      await mkdir(runDir, { recursive: true })

      const result = await $`bun ${ENTRY} _sandbox-helper status ${runDir}`.nothrow().quiet()
      expect(result.exitCode).toBe(0)
      const status = JSON.parse(result.text())
      expect(status.alive).toBe(false)
      expect(status.daemonJson).toBeNull()
    } finally {
      await cleanup()
    }
  })

  // --- unknown command ---

  test("unknown command exits with error", async () => {
    await setup()
    try {
      const result = await $`bun ${ENTRY} _sandbox-helper bogus`.nothrow().quiet()
      expect(result.exitCode).toBe(1)
    } finally {
      await cleanup()
    }
  })
})
