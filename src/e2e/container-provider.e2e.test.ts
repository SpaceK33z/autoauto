import { describe, test, expect, afterEach } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MockContainerProvider } from "../lib/container-provider/mock.ts"

describe("ContainerProvider contract (MockContainerProvider)", () => {
  let rootDir: string
  let provider: MockContainerProvider

  async function setup() {
    rootDir = await mkdtemp(join(tmpdir(), "container-provider-test-"))
    provider = new MockContainerProvider({ rootDir })
  }

  afterEach(async () => {
    MockContainerProvider.clearRegistry()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  // --- exec ---

  test("exec returns stdout, stderr, and exitCode", async () => {
    await setup()
    const result = await provider.exec(["echo", "hello"])
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("hello")
  })

  test("exec captures non-zero exit code", async () => {
    await setup()
    const result = await provider.exec(["sh", "-c", "exit 42"])
    expect(result.exitCode).toBe(42)
  })

  test("exec captures stderr", async () => {
    await setup()
    const result = await provider.exec(["sh", "-c", "echo err >&2"])
    expect(new TextDecoder().decode(result.stderr).trim()).toBe("err")
  })

  test("exec with cwd option runs in specified directory", async () => {
    await setup()
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(rootDir, "subdir"), { recursive: true })
    await Bun.write(join(rootDir, "subdir", "test.txt"), "found")
    const result = await provider.exec(["cat", "test.txt"], { cwd: "subdir" })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("found")
  })

  // --- readFile / writeFile ---

  test("writeFile creates a file, readFile returns it", async () => {
    await setup()
    const data = "hello world"
    await provider.writeFile("test.txt", data)
    const result = await provider.readFile("test.txt")
    expect(new TextDecoder().decode(result)).toBe(data)
  })

  test("writeFile creates parent directories", async () => {
    await setup()
    await provider.writeFile("deep/nested/dir/file.txt", "nested content")
    const result = await provider.readFile("deep/nested/dir/file.txt")
    expect(new TextDecoder().decode(result)).toBe("nested content")
  })

  test("writeFile with Uint8Array", async () => {
    await setup()
    const bytes = new TextEncoder().encode("binary data")
    await provider.writeFile("binary.bin", bytes)
    const result = await provider.readFile("binary.bin")
    expect(new TextDecoder().decode(result)).toBe("binary data")
  })

  test("readFile on non-existent file throws", async () => {
    await setup()
    await expect(provider.readFile("does-not-exist.txt")).rejects.toThrow("ENOENT")
  })

  // --- uploadRepo ---

  test("uploadRepo makes repo available in container", async () => {
    await setup()
    // Create a local git repo
    const localRepo = join(rootDir, "local-repo")
    const { mkdir: mkdirFs } = await import("node:fs/promises")
    await mkdirFs(localRepo, { recursive: true })
    await $`git init`.cwd(localRepo).quiet()
    await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
    await $`git config user.name "Test"`.cwd(localRepo).quiet()
    await Bun.write(join(localRepo, "hello.txt"), "hello from repo")
    await $`git add -A`.cwd(localRepo).quiet()
    await $`git commit -m "init"`.cwd(localRepo).quiet()

    await provider.uploadRepo(localRepo, "workspace")

    // Verify git log works in the uploaded repo
    const result = await provider.exec(["git", "log", "--oneline"], { cwd: "workspace" })
    expect(result.exitCode).toBe(0)
    const logOutput = new TextDecoder().decode(result.stdout).trim()
    expect(logOutput).toContain("init")
  })

  test("uploadRepo copies explicit extra paths after restoring the git bundle", async () => {
    await setup()
    const localRepo = join(rootDir, "local-repo-extra")
    const { mkdir: mkdirFs } = await import("node:fs/promises")
    await mkdirFs(join(localRepo, "extras", "nested"), { recursive: true })
    await $`git init`.cwd(localRepo).quiet()
    await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
    await $`git config user.name "Test"`.cwd(localRepo).quiet()
    await Bun.write(join(localRepo, "tracked.txt"), "tracked")
    await $`git add -A`.cwd(localRepo).quiet()
    await $`git commit -m "init"`.cwd(localRepo).quiet()

    await Bun.write(join(localRepo, "extras", "config.local.json"), '{"token":"secret"}\n')
    await Bun.write(join(localRepo, "extras", "nested", "note.txt"), "nested note\n")

    await provider.uploadRepo(localRepo, "workspace", {
      extraCopyPaths: ["extras/config.local.json", "extras/nested"],
    })

    expect(new TextDecoder().decode(await provider.readFile("workspace/extras/config.local.json"))).toContain("secret")
    expect(new TextDecoder().decode(await provider.readFile("workspace/extras/nested/note.txt"))).toContain("nested note")
  })

  test("uploadRepo follows symlinked extra directories", async () => {
    await setup()
    const localRepo = join(rootDir, "local-repo-symlink")
    const { mkdir: mkdirFs } = await import("node:fs/promises")
    await mkdirFs(join(localRepo, "extras", "real-dir"), { recursive: true })
    await $`git init`.cwd(localRepo).quiet()
    await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
    await $`git config user.name "Test"`.cwd(localRepo).quiet()
    await Bun.write(join(localRepo, "tracked.txt"), "tracked")
    await $`git add -A`.cwd(localRepo).quiet()
    await $`git commit -m "init"`.cwd(localRepo).quiet()

    await Bun.write(join(localRepo, "extras", "real-dir", "note.txt"), "through symlink\n")
    await symlink("real-dir", join(localRepo, "extras", "link-dir"))

    await provider.uploadRepo(localRepo, "workspace", {
      extraCopyPaths: ["extras/link-dir"],
    })

    expect(new TextDecoder().decode(await provider.readFile("workspace/extras/link-dir/note.txt"))).toContain("through symlink")
  })

  test("uploadRepo ignores broken symlink extra paths", async () => {
    await setup()
    const localRepo = join(rootDir, "local-repo-broken-symlink")
    const { mkdir: mkdirFs } = await import("node:fs/promises")
    await mkdirFs(join(localRepo, "extras"), { recursive: true })
    await $`git init`.cwd(localRepo).quiet()
    await $`git config user.email "test@test.com"`.cwd(localRepo).quiet()
    await $`git config user.name "Test"`.cwd(localRepo).quiet()
    await Bun.write(join(localRepo, "tracked.txt"), "tracked")
    await $`git add -A`.cwd(localRepo).quiet()
    await $`git commit -m "init"`.cwd(localRepo).quiet()

    await symlink("missing-dir", join(localRepo, "extras", "broken-link"))

    await expect(provider.uploadRepo(localRepo, "workspace", {
      extraCopyPaths: ["extras/broken-link"],
    })).resolves.toBeUndefined()

    const result = await provider.exec(["git", "log", "--oneline"], { cwd: "workspace" })
    expect(result.exitCode).toBe(0)
    await expect(provider.readFile("workspace/extras/broken-link")).rejects.toThrow("ENOENT")
  })

  // --- poll / terminate ---

  test("poll returns null when no main process", async () => {
    await setup()
    expect(await provider.poll()).toBeNull()
  })

  test("poll returns null for running process, exit code after exit", async () => {
    await setup()
    const proc = Bun.spawn(["sleep", "10"], { cwd: rootDir })
    provider.setMainProcess(proc)

    expect(await provider.poll()).toBeNull()

    proc.kill()
    await proc.exited
    const code = await provider.poll()
    expect(code).not.toBeNull()
  })

  test("terminate makes poll return non-null", async () => {
    await setup()
    const proc = Bun.spawn(["sleep", "10"], { cwd: rootDir })
    provider.setMainProcess(proc)
    expect(await provider.poll()).toBeNull()

    await provider.terminate()
    const code = await provider.poll()
    expect(code).not.toBeNull()
  })

  // --- execStreaming ---

  test("execStreaming returns streaming process", async () => {
    await setup()
    const proc = await provider.execStreaming(["echo", "streamed"])
    const exitCode = await proc.exitCode
    expect(exitCode).toBe(0)
  })

  test("execStreaming sets main process for poll tracking", async () => {
    await setup()
    const proc = await provider.execStreaming(["sleep", "10"])
    expect(await provider.poll()).toBeNull()
    proc.kill()
    await proc.exitCode.catch(() => {})
    // After kill, poll should return non-null
    const code = await provider.poll()
    expect(code).not.toBeNull()
  })

  // --- metadata ---

  test("setMetadata + findByMetadata round-trip", async () => {
    await setup()
    await provider.setMetadata({ run_id: "abc", program: "test" })

    const handle = await provider.findByMetadata({ run_id: "abc" })
    expect(handle).not.toBeNull()

    const attached = await handle!.attach()
    expect(attached).toBe(provider)
  })

  test("findByMetadata returns null for no match", async () => {
    await setup()
    await provider.setMetadata({ run_id: "abc" })
    const handle = await provider.findByMetadata({ run_id: "xyz" })
    expect(handle).toBeNull()
  })

  test("findByMetadata returns null for terminated provider", async () => {
    await setup()
    await provider.setMetadata({ run_id: "abc" })
    await provider.terminate()
    const handle = await provider.findByMetadata({ run_id: "abc" })
    expect(handle).toBeNull()
  })

  // --- detach ---

  test("detach removes from findByMetadata but does not terminate", async () => {
    await setup()
    await provider.setMetadata({ run_id: "detach-test" })
    provider.detach()

    // No longer findable
    const handle = await provider.findByMetadata({ run_id: "detach-test" })
    expect(handle).toBeNull()

    // But poll still returns null (not terminated)
    expect(await provider.poll()).toBeNull()
  })
})
