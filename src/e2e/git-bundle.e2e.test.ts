import { describe, test, expect } from "bun:test"
import { $ } from "bun"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { bundleCreate, bundleUnbundle, bundleVerify } from "../lib/git.ts"

describe("git bundle operations", () => {
  let cwd: string

  async function setup() {
    cwd = await mkdtemp(join(tmpdir(), "git-bundle-test-"))
    await $`git init`.cwd(cwd).quiet()
    await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
    await $`git config user.name "Test User"`.cwd(cwd).quiet()
    await Bun.write(join(cwd, "README.md"), "# test\n")
    await $`git add -A`.cwd(cwd).quiet()
    await $`git commit -m "initial commit"`.cwd(cwd).quiet()
    return cwd
  }

  async function cleanup() {
    await rm(cwd, { recursive: true, force: true })
  }

  test("bundleCreate creates a valid bundle", async () => {
    await setup()
    try {
      const bundlePath = join(cwd, "test.bundle")
      await bundleCreate(cwd, bundlePath)
      expect(await Bun.file(bundlePath).exists()).toBe(true)
      expect(await bundleVerify(bundlePath)).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("bundleVerify returns false for garbage data", async () => {
    await setup()
    try {
      const garbagePath = join(cwd, "garbage.bundle")
      await Bun.write(garbagePath, "this is not a git bundle")
      expect(await bundleVerify(garbagePath)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("bundleVerify returns false for non-existent file", async () => {
    await setup()
    try {
      expect(await bundleVerify(join(cwd, "nope.bundle"))).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("bundleUnbundle into new directory preserves commits", async () => {
    await setup()
    try {
      // Add a second commit
      await Bun.write(join(cwd, "file.txt"), "hello world")
      await $`git add -A`.cwd(cwd).quiet()
      await $`git commit -m "second commit"`.cwd(cwd).quiet()

      const headSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
      const bundlePath = join(cwd, "repo.bundle")
      await bundleCreate(cwd, bundlePath)

      // Clone from bundle into a new directory
      const cloneDir = join(cwd, "clone")
      await bundleUnbundle(cloneDir, bundlePath)

      const cloneSha = (await $`git rev-parse HEAD`.cwd(cloneDir).text()).trim()
      expect(cloneSha).toBe(headSha)

      // Verify commit count matches
      const originCount = (await $`git rev-list --count HEAD`.cwd(cwd).text()).trim()
      const cloneCount = (await $`git rev-list --count HEAD`.cwd(cloneDir).text()).trim()
      expect(cloneCount).toBe(originCount)
    } finally {
      await cleanup()
    }
  })

  test("bundleUnbundle fetches into existing repo", async () => {
    await setup()
    try {
      // Create initial bundle and clone
      const bundlePath1 = join(cwd, "v1.bundle")
      await bundleCreate(cwd, bundlePath1)
      const cloneDir = join(cwd, "clone")
      await bundleUnbundle(cloneDir, bundlePath1)

      // Add another commit to the original repo
      await Bun.write(join(cwd, "new.txt"), "new content")
      await $`git add -A`.cwd(cwd).quiet()
      await $`git commit -m "third commit"`.cwd(cwd).quiet()
      const newSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()

      // Bundle again and fetch into existing clone
      const bundlePath2 = join(cwd, "v2.bundle")
      await bundleCreate(cwd, bundlePath2)
      await bundleUnbundle(cloneDir, bundlePath2)

      // The new commit should be fetchable
      const fetchedSha = (await $`git rev-parse ${newSha}`.cwd(cloneDir).nothrow().text()).trim()
      expect(fetchedSha).toBe(newSha)
    } finally {
      await cleanup()
    }
  })

  test("bundleCreate with specific ref bundles only that ref", async () => {
    await setup()
    try {
      // Create a branch with its own commit
      await $`git checkout -b feature`.cwd(cwd).quiet()
      await Bun.write(join(cwd, "feature.txt"), "feature work")
      await $`git add -A`.cwd(cwd).quiet()
      await $`git commit -m "feature commit"`.cwd(cwd).quiet()
      const featureSha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
      await $`git checkout -`.cwd(cwd).quiet()

      const bundlePath = join(cwd, "feature.bundle")
      await bundleCreate(cwd, bundlePath, "feature")
      expect(await bundleVerify(bundlePath)).toBe(true)

      // Clone from the bundle — HEAD may be detached, checkout the feature ref
      const cloneDir = join(cwd, "feature-clone")
      await bundleUnbundle(cloneDir, bundlePath)
      await $`git checkout feature`.cwd(cloneDir).quiet()
      const content = await Bun.file(join(cloneDir, "feature.txt")).text()
      expect(content).toBe("feature work")

      const cloneSha = (await $`git rev-parse HEAD`.cwd(cloneDir).text()).trim()
      expect(cloneSha).toBe(featureSha)
    } finally {
      await cleanup()
    }
  })

  test("bundleCreate throws on empty repo with no commits", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "git-bundle-empty-"))
    try {
      await $`git init`.cwd(emptyDir).quiet()
      await $`git config user.email "test@test.com"`.cwd(emptyDir).quiet()
      await $`git config user.name "Test User"`.cwd(emptyDir).quiet()

      const bundlePath = join(emptyDir, "empty.bundle")
      await expect(bundleCreate(emptyDir, bundlePath)).rejects.toThrow()
    } finally {
      await rm(emptyDir, { recursive: true, force: true })
    }
  })
})
