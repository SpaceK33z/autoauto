import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readGuidance, writeGuidance } from "./guidance.ts"

describe("guidance", () => {
  test("returns empty string for missing file", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      expect(await readGuidance(runDir)).toBe("")
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("write and read roundtrip", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      await writeGuidance(runDir, "Focus on parser optimizations")
      const result = await readGuidance(runDir)
      expect(result).toBe("Focus on parser optimizations")

      // File on disk should have trailing newline
      const raw = await Bun.file(join(runDir, "guidance.md")).text()
      expect(raw).toBe("Focus on parser optimizations\n")
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("trims whitespace on write and read", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      await writeGuidance(runDir, "  padded text  \n\n")
      expect(await readGuidance(runDir)).toBe("padded text")
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("clearing guidance deletes the file", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      await writeGuidance(runDir, "some guidance")
      expect(await readGuidance(runDir)).toBe("some guidance")

      await writeGuidance(runDir, "")
      expect(await readGuidance(runDir)).toBe("")
      expect(await Bun.file(join(runDir, "guidance.md")).exists()).toBe(false)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("clearing whitespace-only guidance deletes the file", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      await writeGuidance(runDir, "some guidance")
      await writeGuidance(runDir, "   \n  ")
      expect(await readGuidance(runDir)).toBe("")
      expect(await Bun.file(join(runDir, "guidance.md")).exists()).toBe(false)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("clearing non-existent file does not throw", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      await writeGuidance(runDir, "")
      // Should not throw
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("truncates long guidance", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      const longText = "x".repeat(3000)
      await writeGuidance(runDir, longText)
      const result = await readGuidance(runDir)
      const expected = "x".repeat(2000) + "\n[truncated]"
      expect(result).toBe(expected)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("replaces existing guidance atomically", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      await writeGuidance(runDir, "first guidance")
      await writeGuidance(runDir, "second guidance")
      expect(await readGuidance(runDir)).toBe("second guidance")
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("preserves multi-line guidance", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-guidance-"))
    try {
      const multiline = "Line 1\nLine 2\nLine 3"
      await writeGuidance(runDir, multiline)
      expect(await readGuidance(runDir)).toBe(multiline)
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })
})
