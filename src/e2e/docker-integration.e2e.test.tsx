/**
 * Docker integration E2E tests — exercises the real DockerContainerProvider
 * against a mock Docker CLI (mock-docker.sh) that simulates Docker behavior
 * using the local filesystem. No real Docker daemon required.
 *
 * Covers:
 * - checkDockerAuth (daemon detection, provider-specific auth validation)
 * - createDockerProvider (container creation, labels, env vars)
 * - exec, readFile, writeFile, uploadRepo
 * - poll / terminate lifecycle
 * - lookupDockerContainer reconnection
 * - PreRunScreen sandbox selection flow
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test"
import { mkdtemp, rm, mkdir, chmod, readdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { $ } from "bun"

import {
  createDockerProvider,
  checkDockerAuth,
  lookupDockerContainer,
  setDockerBin,
  resetDockerBin,
} from "../lib/container-provider/docker.ts"
import type { ContainerProvider } from "../lib/container-provider/types.ts"

// TUI test imports (for PreRunScreen tests)
import { renderTui, type TuiHarness } from "./helpers.ts"
import { PreRunScreen, type PreRunOverrides } from "../screens/PreRunScreen.tsx"
import { createTestFixture, type TestFixture, registerMockProviders } from "./fixture.ts"
import { resetProjectRoot } from "../lib/programs.ts"
import { DEFAULT_CONFIG } from "../lib/config.ts"

const decoder = new TextDecoder()

/** Navigate to the Sandbox field (index 5) in PreRunScreen. */
async function goToSandbox(h: TuiHarness) {
  await h.waitForText("Max Experiments")
  await h.tab(); await h.tab(); await h.tab(); await h.tab(); await h.tab()
}

// ---------------------------------------------------------------------------
// Shared mock Docker setup
// ---------------------------------------------------------------------------

let mockDir: string       // Mock state directory (containers, ids, etc.)
let mockBinDir: string    // Temp dir containing the "docker" mock binary
let originalApiKey: string | undefined

async function clearMockState() {
  const entries = await readdir(mockDir)
  await Promise.all(entries.map((e) => rm(join(mockDir, e), { recursive: true, force: true })))
}

describe("Docker E2E (mocked CLI)", () => {
  beforeAll(async () => {
    // Create temp directories
    mockDir = await mkdtemp(join(tmpdir(), "docker-mock-state-"))
    mockBinDir = await mkdtemp(join(tmpdir(), "docker-mock-bin-"))

    // Create a wrapper "docker" binary that bakes in DOCKER_MOCK_DIR
    // (Bun.spawn doesn't reliably inherit process.env modifications)
    const mockScriptPath = join(dirname(import.meta.path), "mock-docker.sh")
    const dockerBinPath = join(mockBinDir, "docker")
    const wrapper = `#!/bin/bash\nexport DOCKER_MOCK_DIR="${mockDir}"\nexec "${mockScriptPath}" "$@"\n`
    await Bun.write(dockerBinPath, wrapper)
    await chmod(dockerBinPath, 0o755)

    // Point the Docker provider at the mock binary
    setDockerBin(dockerBinPath)
    process.env.DOCKER_MOCK_DIR = mockDir

    // Ensure API key is set for tests
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "test-api-key-for-e2e"
  })

  afterEach(async () => {
    // Clear all mock state between tests
    await clearMockState()
  })

  afterAll(async () => {
    // Restore environment
    resetDockerBin()
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    } else {
      delete process.env.ANTHROPIC_API_KEY
    }
    delete process.env.DOCKER_MOCK_DIR

    // Clean up temp directories
    await rm(mockDir, { recursive: true, force: true })
    await rm(mockBinDir, { recursive: true, force: true })
  })

  // Helper: create a provider with deterministic names
  async function makeProvider(slug = "test-prog", runId = "20240101-120000"): Promise<ContainerProvider> {
    return createDockerProvider({ programSlug: slug, runId })
  }

  // =========================================================================
  // checkDockerAuth
  // =========================================================================
  describe("checkDockerAuth", () => {
    test("returns ok when Docker running and API key set", async () => {
      const result = await checkDockerAuth()
      expect(result.ok).toBe(true)
      expect(result.error).toBeUndefined()
    })

    test("returns error when Docker daemon is not running", async () => {
      // Signal the mock to fail on `docker info`
      await Bun.write(join(mockDir, ".no-daemon"), "")

      const result = await checkDockerAuth()
      expect(result.ok).toBe(false)
      expect(result.error).toContain("Docker daemon is not running")
    })

    test("returns error when ANTHROPIC_API_KEY is not set", async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const result = await checkDockerAuth()
        expect(result.ok).toBe(false)
        expect(result.error).toContain("ANTHROPIC_API_KEY")
      } finally {
        process.env.ANTHROPIC_API_KEY = saved
      }
    })
  })

  // =========================================================================
  // createDockerProvider
  // =========================================================================
  describe("createDockerProvider", () => {
    test("creates container with deterministic name from slug and runId", async () => {
      await makeProvider("my-prog", "run-001")

      // Container should exist in mock state with the expected name
      const containerDir = join(mockDir, "containers", "autoauto-my-prog-run-001")
      expect((await Bun.file(join(containerDir, "status")).text()).trim()).toBe("running")
    })

    test("sets labels on the container", async () => {
      await makeProvider("bench", "run-42")

      const labelsFile = join(mockDir, "containers", "autoauto-bench-run-42", "labels")
      const labels = (await Bun.file(labelsFile).text()).trim().split("\n")
      expect(labels).toContain("autoauto=true")
      expect(labels).toContain("program_slug=bench")
      expect(labels).toContain("run_id=run-42")
    })

    test("forwards ANTHROPIC_API_KEY env var to container", async () => {
      await makeProvider("env-test", "run-env")

      const envFile = join(mockDir, "containers", "autoauto-env-test-run-env", "env")
      const envVars = (await Bun.file(envFile).text()).trim().split("\n")
      expect(envVars.some((e: string) => e.startsWith("ANTHROPIC_API_KEY="))).toBe(true)
    })

    test("pre-cleans stale container with the same name", async () => {
      // Create a "stale" container manually
      const staleName = "autoauto-stale-run-1"
      const staleDir = join(mockDir, "containers", staleName, "rootfs")
      await mkdir(staleDir, { recursive: true })
      await Bun.write(join(mockDir, "containers", staleName, "status"), "running")

      // Creating a provider with the same name should succeed (pre-clean removes the stale one)
      const provider = await makeProvider("stale", "run-1")
      expect(provider).toBeDefined()

      // New container should be running
      const status = (await Bun.file(join(mockDir, "containers", staleName, "status")).text()).trim()
      expect(status).toBe("running")
    })

    test("builds the default image on first use", async () => {
      await makeProvider("image-default", "run-image-default")

      expect(await Bun.file(join(mockDir, "last-build-args")).exists()).toBe(true)
      const buildArgs = (await Bun.file(join(mockDir, "last-build-args")).text()).trim().split("\n")
      expect(buildArgs[0]).toBe("-t")
      expect(buildArgs[1]).toContain("autoauto-runner:")
      expect(buildArgs[2]).toBe("-")
    })

    test("mock docker image without subcommand returns a helpful usage error", async () => {
      const proc = Bun.spawn([join(mockBinDir, "docker"), "image"], { stdout: "pipe", stderr: "pipe" })
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode).toBe(1)
      expect(stderr).toContain("Usage: docker image <subcommand>")
    })

    test("uses .autoauto/Dockerfile when mainRoot provides one", async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "docker-project-"))
      await mkdir(join(projectRoot, ".autoauto"), { recursive: true })
      await Bun.write(
        join(projectRoot, ".autoauto", "Dockerfile"),
        "FROM ubuntu:22.04\nRUN echo custom > /custom.txt\n",
      )

      try {
        await createDockerProvider({
          programSlug: "custom-image",
          runId: "run-custom-image",
          mainRoot: projectRoot,
        })

        const buildArgs = (await Bun.file(join(mockDir, "last-build-args")).text()).trim().split("\n")
        expect(buildArgs[0]).toBe("-t")
        expect(buildArgs[1]).toContain("autoauto-runner:")
        expect(buildArgs[2]).toBe("-f")
        expect(buildArgs[3]).toBe(join(projectRoot, ".autoauto", "Dockerfile"))
        expect(buildArgs[4]).toBe(projectRoot)
      } finally {
        await rm(projectRoot, { recursive: true, force: true })
      }
    })
  })

  // =========================================================================
  // exec
  // =========================================================================
  describe("exec", () => {
    test("runs command and captures stdout, stderr, and exit code", async () => {
      const provider = await makeProvider()

      const result = await provider.exec(["echo", "hello world"])
      expect(result.exitCode).toBe(0)
      expect(decoder.decode(result.stdout).trim()).toBe("hello world")
    })

    test("captures stderr and non-zero exit code", async () => {
      const provider = await makeProvider()

      const result = await provider.exec(["sh", "-c", "echo err >&2; exit 42"])
      expect(result.exitCode).toBe(42)
      expect(decoder.decode(result.stderr).trim()).toBe("err")
    })

    test("passes --workdir option", async () => {
      const provider = await makeProvider("wd-test", "run-wd")

      // Create a file inside a subdirectory of the container rootfs
      const rootfs = join(mockDir, "containers", "autoauto-wd-test-run-wd", "rootfs")
      await mkdir(join(rootfs, "mydir"), { recursive: true })
      await Bun.write(join(rootfs, "mydir", "data.txt"), "found it")

      const result = await provider.exec(["cat", "data.txt"], { cwd: "/mydir" })
      expect(result.exitCode).toBe(0)
      expect(decoder.decode(result.stdout).trim()).toBe("found it")
    })

    test("fails clearly when workdir cannot be entered", async () => {
      const provider = await makeProvider("bad-wd", "run-bad-wd")

      const rootfs = join(mockDir, "containers", "autoauto-bad-wd-run-bad-wd", "rootfs")
      await Bun.write(join(rootfs, "blocked"), "not a directory")

      const result = await provider.exec(["pwd"], { cwd: "/blocked" })
      expect(result.exitCode).not.toBe(0)
      expect(decoder.decode(result.stderr)).toContain("Failed to cd to workdir")
    })

    test("passes --env option", async () => {
      const provider = await makeProvider()

      const result = await provider.exec(
        ["sh", "-c", "echo $MY_VAR"],
        { env: { MY_VAR: "test-value" } },
      )
      expect(result.exitCode).toBe(0)
      expect(decoder.decode(result.stdout).trim()).toBe("test-value")
    })
  })

  // =========================================================================
  // readFile / writeFile
  // =========================================================================
  describe("readFile / writeFile", () => {
    test("writeFile then readFile round-trip", async () => {
      const provider = await makeProvider()

      await provider.writeFile("/workspace/hello.txt", "hello from test")
      const data = await provider.readFile("/workspace/hello.txt")
      expect(decoder.decode(data)).toBe("hello from test")
    })

    test("writeFile creates parent directories", async () => {
      const provider = await makeProvider()

      await provider.writeFile("/deep/nested/dir/file.txt", "nested content")
      const data = await provider.readFile("/deep/nested/dir/file.txt")
      expect(decoder.decode(data)).toBe("nested content")
    })

    test("readFile throws for non-existent file", async () => {
      const provider = await makeProvider()

      await expect(provider.readFile("/no-such-file.txt")).rejects.toThrow("ENOENT")
    })

    test("writeFile with Uint8Array binary data", async () => {
      const provider = await makeProvider()

      const bytes = new TextEncoder().encode("binary payload 🎉")
      await provider.writeFile("/workspace/binary.bin", bytes)
      const data = await provider.readFile("/workspace/binary.bin")
      expect(decoder.decode(data)).toBe("binary payload 🎉")
    })
  })

  // =========================================================================
  // uploadRepo
  // =========================================================================
  describe("uploadRepo", () => {
    test("restores committed repo contents into container via git bundle", async () => {
      const provider = await makeProvider("upload-test", "run-up")

      const localRepo = await mkdtemp(join(tmpdir(), "upload-src-"))
      try {
        await $`git init`.cwd(localRepo).quiet()
        await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
        await $`git config user.name "Test"`.cwd(localRepo).quiet()
        await Bun.write(join(localRepo, "README.md"), "# Test Repo\n")
        await mkdir(join(localRepo, "src"), { recursive: true })
        await Bun.write(join(localRepo, "src", "index.ts"), "console.log('hello')\n")
        await $`git add -A`.cwd(localRepo).quiet()
        await $`git commit -m "initial commit"`.cwd(localRepo).quiet()

        await Bun.write(join(localRepo, "README.md"), "# Uncommitted change\n")
        await Bun.write(join(localRepo, "untracked.txt"), "should not upload\n")

        await provider.uploadRepo(localRepo, "/workspace")

        const readme = await provider.readFile("/workspace/README.md")
        expect(decoder.decode(readme)).toBe("# Test Repo\n")

        const index = await provider.readFile("/workspace/src/index.ts")
        expect(decoder.decode(index)).toBe("console.log('hello')\n")

        await expect(provider.readFile("/workspace/untracked.txt")).rejects.toThrow("ENOENT")
      } finally {
        await rm(localRepo, { recursive: true, force: true })
      }
    })

    test("git operations work in uploaded git repo", async () => {
      const provider = await makeProvider("git-upload", "run-git")

      // Create a local git repo
      const localRepo = await mkdtemp(join(tmpdir(), "upload-git-"))
      try {
        await $`git init`.cwd(localRepo).quiet()
        await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
        await $`git config user.name "Test"`.cwd(localRepo).quiet()
        await Bun.write(join(localRepo, "hello.txt"), "hello from repo")
        await $`git add -A`.cwd(localRepo).quiet()
        await $`git commit -m "initial commit"`.cwd(localRepo).quiet()

        await provider.uploadRepo(localRepo, "/workspace")

        // Verify git log works inside the container
        const result = await provider.exec(["git", "log", "--oneline"], { cwd: "/workspace" })
        expect(result.exitCode).toBe(0)
        expect(decoder.decode(result.stdout)).toContain("initial commit")
      } finally {
        await rm(localRepo, { recursive: true, force: true })
      }
    })

    test("copies explicit extra files and directories after the bundle restore", async () => {
      const provider = await makeProvider("upload-extra", "run-extra")

      const localRepo = await mkdtemp(join(tmpdir(), "upload-extra-src-"))
      try {
        await $`git init`.cwd(localRepo).quiet()
        await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
        await $`git config user.name "Test"`.cwd(localRepo).quiet()
        await mkdir(join(localRepo, "extras", "nested"), { recursive: true })
        await Bun.write(join(localRepo, "README.md"), "# Test Repo\n")
        await $`git add -A`.cwd(localRepo).quiet()
        await $`git commit -m "initial commit"`.cwd(localRepo).quiet()

        await Bun.write(join(localRepo, "extras", "config.local.json"), '{"token":"secret"}\n')
        await Bun.write(join(localRepo, "extras", "nested", "note.txt"), "nested note\n")

        await provider.uploadRepo(localRepo, "/workspace", {
          extraCopyPaths: ["extras/config.local.json", "extras/nested"],
        })

        expect(decoder.decode(await provider.readFile("/workspace/extras/config.local.json"))).toContain("secret")
        expect(decoder.decode(await provider.readFile("/workspace/extras/nested/note.txt"))).toContain("nested note")
      } finally {
        await rm(localRepo, { recursive: true, force: true })
      }
    })
  })

  // =========================================================================
  // poll / terminate
  // =========================================================================
  describe("poll / terminate", () => {
    test("poll returns null for a running container", async () => {
      const provider = await makeProvider()
      expect(await provider.poll()).toBeNull()
    })

    test("terminate makes poll return non-null", async () => {
      const provider = await makeProvider()
      expect(await provider.poll()).toBeNull()

      await provider.terminate()

      // After terminate, container is removed — poll should return 1
      const code = await provider.poll()
      expect(code).not.toBeNull()
    })

    test("poll returns 1 for a container removed externally", async () => {
      const provider = await makeProvider("rm-test", "run-rm")

      // Manually remove the container directory to simulate external removal
      await rm(join(mockDir, "containers", "autoauto-rm-test-run-rm"), { recursive: true, force: true })
      // Also remove ID mappings
      const entries = await readdir(join(mockDir, "ids")).catch(() => [] as string[])
      const idTargets = await Promise.all(
        entries.map(async (e) => ({ name: e, target: await Bun.file(join(mockDir, "ids", e)).text() })),
      )
      await Promise.all(
        idTargets.filter((t) => t.target.trim() === "autoauto-rm-test-run-rm").map((t) => rm(join(mockDir, "ids", t.name))),
      )

      const code = await provider.poll()
      expect(code).toBe(1)
    })
  })

  // =========================================================================
  // lookupDockerContainer
  // =========================================================================
  describe("lookupDockerContainer", () => {
    test("finds a running container by metadata", async () => {
      // Create a container with known slug + runId
      await makeProvider("lookup-prog", "run-lookup")

      const handle = await lookupDockerContainer({
        program_slug: "lookup-prog",
        run_id: "run-lookup",
      })
      expect(handle).not.toBeNull()

      // Attach and verify the provider works
      const provider = await handle!.attach()
      const result = await provider.exec(["echo", "reconnected"])
      expect(result.exitCode).toBe(0)
      expect(decoder.decode(result.stdout).trim()).toBe("reconnected")
    })

    test("returns null for a non-existent container", async () => {
      const handle = await lookupDockerContainer({
        program_slug: "no-such-prog",
        run_id: "no-such-run",
      })
      expect(handle).toBeNull()
    })

    test("returns null for a terminated container", async () => {
      const provider = await makeProvider("term-lookup", "run-term")
      await provider.terminate()

      const handle = await lookupDockerContainer({
        program_slug: "term-lookup",
        run_id: "run-term",
      })
      expect(handle).toBeNull()
    })

    test("returns null when metadata is incomplete", async () => {
      await makeProvider("partial", "run-partial")

      // Missing run_id
      const handle1 = await lookupDockerContainer({ program_slug: "partial" })
      expect(handle1).toBeNull()

      // Missing program_slug
      const handle2 = await lookupDockerContainer({ run_id: "run-partial" })
      expect(handle2).toBeNull()
    })

    test("reconnected provider can read files written by original", async () => {
      const original = await makeProvider("recon-rw", "run-recon")
      await original.writeFile("/workspace/state.json", '{"phase":"running"}')

      // Reconnect via lookup
      const handle = await lookupDockerContainer({
        program_slug: "recon-rw",
        run_id: "run-recon",
      })
      expect(handle).not.toBeNull()
      const reconnected = await handle!.attach()

      const data = await reconnected.readFile("/workspace/state.json")
      expect(decoder.decode(data)).toBe('{"phase":"running"}')
    })
  })

  // =========================================================================
  // PreRunScreen Docker integration
  // =========================================================================
  describe("PreRunScreen Docker integration", () => {
    let fixture: TestFixture
    let harness: TuiHarness | null = null

    beforeAll(async () => {
      registerMockProviders()
      fixture = await createTestFixture()
      await fixture.createProgram("docker-e2e", {
        metric_field: "score",
        direction: "lower",
        max_experiments: 10,
      })
    })

    afterEach(async () => {
      await harness?.destroy()
      harness = null
      resetProjectRoot()
      // Clear mock docker state
      await clearMockState()
    })

    afterAll(async () => {
      await fixture.cleanup()
    })

    function renderPreRun(opts?: {
      defaultModelConfig?: PreRunOverrides["modelConfig"]
      navigate?: (s: import("../lib/programs.ts").Screen) => void
      onStart?: (o: PreRunOverrides) => void
    }) {
      return renderTui(
        <PreRunScreen
          cwd={fixture.cwd}
          programSlug="docker-e2e"
          defaultModelConfig={opts?.defaultModelConfig ?? DEFAULT_CONFIG.executionModel}
          navigate={opts?.navigate ?? (() => {})}
          onStart={opts?.onStart ?? (() => {})}
        />,
      )
    }

    test("cycling sandbox to Docker succeeds when auth passes", async () => {
      harness = await renderPreRun()
      await goToSandbox(harness)

      // Cycle right from "Off" → "Docker"
      await harness.press("l")

      // Wait for async auth check to complete and UI to update
      const frame = await harness.waitForText("local Docker container")
      expect(frame).toContain("Sandbox")
      expect(frame).toContain("Docker")
    })

    test("cycling sandbox to Docker shows error when auth fails", async () => {
      // Make docker daemon unavailable
      await Bun.write(join(mockDir, ".no-daemon"), "")

      harness = await renderPreRun()
      await goToSandbox(harness)

      // Try to cycle to Docker
      await harness.press("l")

      // Should show the auth error
      const frame = await harness.waitForText("Docker daemon is not running")
      expect(frame).toContain("Docker daemon is not running")

      // Sandbox should still be "Off" since auth failed
      expect(frame).toContain("Sandbox")
    })

    test("Docker sandbox forces worktree to in-place mode", async () => {
      harness = await renderPreRun()
      await goToSandbox(harness)

      // Select Docker
      await harness.press("l")
      await harness.waitForText("local Docker container")

      // Navigate down to Run Mode field
      await harness.tab()
      const frame = await harness.frame()

      // Run Mode should show "In-place (sandbox)"
      expect(frame).toContain("In-place (sandbox)")
    })

    test("starting with Docker includes sandbox overrides", async () => {
      let startOverrides: PreRunOverrides | null = null
      harness = await renderPreRun({ onStart: (o) => { startOverrides = o } })
      await goToSandbox(harness)

      // Select Docker
      await harness.press("l")
      await harness.waitForText("local Docker container")

      // Press s to start
      await harness.press("s")

      expect(startOverrides).not.toBeNull()
      expect(startOverrides!.useSandbox).toBe(true)
      expect(startOverrides!.sandboxProvider).toBe("docker")
      // Sandbox forces worktree off
      expect(startOverrides!.useWorktree).toBe(false)
    })

    test("Codex sandbox auth does not require ANTHROPIC_API_KEY", async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY

      try {
        let startOverrides: PreRunOverrides | null = null
        harness = await renderPreRun({
          defaultModelConfig: { provider: "codex", model: "default", effort: "high" },
          onStart: (o) => { startOverrides = o },
        })
        await goToSandbox(harness)

        await harness.press("l")
        const frame = await harness.waitForText("local Docker container")
        expect(frame).toContain("Docker")
        expect(frame).not.toContain("ANTHROPIC_API_KEY")

        await harness.press("s")
        expect(startOverrides).not.toBeNull()
        expect(startOverrides!.modelConfig.provider).toBe("codex")
        expect(startOverrides!.useSandbox).toBe(true)
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })
  })
})
