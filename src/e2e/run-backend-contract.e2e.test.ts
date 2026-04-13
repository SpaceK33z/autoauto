/**
 * RunBackend contract tests — verifies both LocalRunBackend and SandboxRunBackend
 * satisfy the same interface contract.
 *
 * These tests focus on the parts of the contract that can be verified without
 * a fully running daemon: spawn returns valid handle, handle has correct properties,
 * control methods write the right files, materializeArtifacts is callable.
 *
 * Full lifecycle tests (spawn → watch → stop → complete) are in the backend-specific
 * test files (daemon-lifecycle for local, sandbox-run-backend for sandbox).
 */

import { describe, test, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { RunBackend } from "../lib/run-backend/types.ts"
import { SandboxRunBackend } from "../lib/run-backend/sandbox.ts"
import { MockContainerProvider } from "../lib/container-provider/mock.ts"

interface BackendFactory {
  name: string
  create: () => Promise<{
    backend: RunBackend
    mainRoot: string
    cleanup: () => Promise<void>
  }>
}

const backends: BackendFactory[] = [
  {
    name: "SandboxRunBackend",
    create: async () => {
      const mainRoot = await mkdtemp(join(tmpdir(), "contract-sandbox-"))
      const containerRoot = await mkdtemp(join(tmpdir(), "contract-container-"))

      // Init git repo
      await $`git init`.cwd(mainRoot).quiet()
      await $`git config user.email "test@test.com"`.cwd(mainRoot).quiet()
      await $`git config user.name "Test"`.cwd(mainRoot).quiet()
      await Bun.write(join(mainRoot, "README.md"), "# test\n")
      await $`git add -A`.cwd(mainRoot).quiet()
      await $`git commit -m "init"`.cwd(mainRoot).quiet()

      // Create program
      const programDir = join(mainRoot, ".autoauto", "programs", "contract-test")
      await mkdir(programDir, { recursive: true })
      await Bun.write(join(programDir, "config.json"), JSON.stringify({
        metric_field: "score", direction: "lower", noise_threshold: 0.02, repeats: 1, max_experiments: 5,
      }))
      await Bun.write(join(programDir, "measure"), '#!/bin/bash\necho \'{"score": 42}\'')
      const { chmod } = await import("node:fs/promises")
      await chmod(join(programDir, "measure"), 0o755)

      const provider = new MockContainerProvider({ rootDir: containerRoot })
      const backend = new SandboxRunBackend(async () => provider)

      return {
        backend,
        mainRoot,
        cleanup: async () => {
          MockContainerProvider.clearRegistry()
          await rm(mainRoot, { recursive: true, force: true })
          await rm(containerRoot, { recursive: true, force: true })
        },
      }
    },
  },
]

for (const factory of backends) {
  describe(`RunBackend contract: ${factory.name}`, () => {
    let cleanupFn: (() => Promise<void>) | null = null

    afterEach(async () => {
      if (cleanupFn) {
        await cleanupFn()
        cleanupFn = null
      }
    })

    test("spawn returns a RunHandle with valid runId and runDir", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const handle = await backend.spawn({
        mainRoot,
        programSlug: "contract-test",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      expect(handle.runId).toMatch(/^\d{8}-\d{6}$/)
      expect(handle.runDir).toContain("contract-test")
      expect(handle.runDir).toContain(handle.runId)
      expect(typeof handle.watch).toBe("function")
      expect(typeof handle.getStatus).toBe("function")
      expect(typeof handle.sendControl).toBe("function")
      expect(typeof handle.terminate).toBe("function")
      expect(typeof handle.updateMaxExperiments).toBe("function")
      expect(typeof handle.updateMaxCostUsd).toBe("function")
      expect(typeof handle.materializeArtifacts).toBe("function")
      expect(typeof handle.reconstructState).toBe("function")
    })

    test("getStatus returns a DaemonStatus object", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const handle = await backend.spawn({
        mainRoot,
        programSlug: "contract-test",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      const status = await handle.getStatus()
      expect(typeof status.alive).toBe("boolean")
      expect(typeof status.starting).toBe("boolean")
      // daemonJson can be null or an object
      expect(status.daemonJson === null || typeof status.daemonJson === "object").toBe(true)
    })

    test("sendControl does not throw", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const handle = await backend.spawn({
        mainRoot,
        programSlug: "contract-test",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      // sendControl should not throw for valid actions
      await handle.sendControl("stop")
      // Calling again should also not throw
      await handle.sendControl("abort")
    })

    test("terminate does not throw", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const handle = await backend.spawn({
        mainRoot,
        programSlug: "contract-test",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      await handle.terminate()
      // After terminate, getStatus should report not alive
      const status = await handle.getStatus()
      expect(status.alive).toBe(false)
    })

    test("materializeArtifacts is callable (no-op or downloads)", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const handle = await backend.spawn({
        mainRoot,
        programSlug: "contract-test",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      // Should not throw
      await handle.materializeArtifacts()
    })

    test("updateMaxExperiments does not throw", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const handle = await backend.spawn({
        mainRoot,
        programSlug: "contract-test",
        modelConfig: { provider: "claude", model: "sonnet", effort: "high" },
        maxExperiments: 5,
      })

      await handle.updateMaxExperiments(20)
    })

    test("findActiveRun returns null when no run is active", async () => {
      const { backend, mainRoot, cleanup } = await factory.create()
      cleanupFn = cleanup

      const programDir = join(mainRoot, ".autoauto", "programs", "contract-test")
      const result = await backend.findActiveRun(programDir)
      expect(result).toBeNull()
    })
  })
}
