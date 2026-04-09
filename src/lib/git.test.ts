import { describe, test, expect } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { isWorkingTreeClean } from "./git.ts"

describe("isWorkingTreeClean", () => {
  let cwd: string

  async function setup() {
    cwd = await mkdtemp(join(tmpdir(), "git-test-"))
    await $`git init`.cwd(cwd).quiet()
    await $`git commit --allow-empty -m init`.cwd(cwd).quiet()
  }

  async function cleanup() {
    await rm(cwd, { recursive: true, force: true })
  }

  test("returns true for clean repo", async () => {
    await setup()
    try {
      expect(await isWorkingTreeClean(cwd)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("returns false for untracked user files", async () => {
    await setup()
    try {
      await Bun.write(join(cwd, "foo.txt"), "hello")
      expect(await isWorkingTreeClean(cwd)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("ignores .autoauto-* files (measurement PID/log/diagnostics)", async () => {
    await setup()
    try {
      await Bun.write(join(cwd, ".autoauto-homepage-lighthouse.pid"), "12345")
      await Bun.write(join(cwd, ".autoauto-homepage-lighthouse.log"), "server started")
      await Bun.write(join(cwd, ".autoauto-diagnostics"), "some diag")
      expect(await isWorkingTreeClean(cwd)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("detects real dirty files even with .autoauto-* present", async () => {
    await setup()
    try {
      await Bun.write(join(cwd, ".autoauto-test.pid"), "12345")
      await Bun.write(join(cwd, "real-change.ts"), "export const x = 1")
      expect(await isWorkingTreeClean(cwd)).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
