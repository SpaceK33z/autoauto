/**
 * E2E tests for the AutoAuto MCP server — filesystem tools.
 * Uses real MCP Client ↔ Server communication via InMemoryTransport.
 * Zero mocking: all tool handlers run against a real temp git repo.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdir, unlink } from "node:fs/promises"
import {
  createMcpTestClient,
  getTextContent,
  getJsonContent,
  createProgramForMcp,
  createRunForMcp,
  type McpTestContext,
} from "./mcp-helpers.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { setProvider } from "../lib/agent/index.ts"
import { MockProvider } from "../lib/agent/mock-provider.ts"
import { saveProjectConfig } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// list_programs
// ---------------------------------------------------------------------------

describe("MCP list_programs", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns empty message when no programs exist", async () => {
    const result = await mcp.client.callTool({ name: "list_programs", arguments: {} })
    expect(getTextContent(result)).toBe("No programs found.")
  })

  test("lists programs with goals and run counts", async () => {
    await createProgramForMcp(fixture.cwd, "prog-a", {
      programMd: "# Prog A\n\n## Goal\nReduce bundle size.\n",
    })
    await createProgramForMcp(fixture.cwd, "prog-b", {
      programMd: "# Prog B\n\n## Goal\nImprove latency.\n",
    })
    await createRunForMcp(fixture.cwd, "prog-a", { runId: "20260101-000000" })

    const result = await mcp.client.callTool({ name: "list_programs", arguments: {} })
    const data = getJsonContent(result) as Array<{
      name: string
      goal: string
      totalRuns: number
      hasActiveRun: boolean
    }>

    expect(data).toHaveLength(2)
    const progA = data.find((p) => p.name === "prog-a")!
    const progB = data.find((p) => p.name === "prog-b")!
    expect(progA.goal).toContain("bundle size")
    expect(progA.totalRuns).toBe(1)
    expect(progA.hasActiveRun).toBe(false)
    expect(progB.goal).toContain("latency")
    expect(progB.totalRuns).toBe(0)
  })

  test("uses the detected project root when started in a subdirectory", async () => {
    await createProgramForMcp(fixture.cwd, "root-prog", {
      programMd: "# Root Program\n\n## Goal\nMeasure from repo root.\n",
    })

    const nestedCwd = join(fixture.cwd, "packages", "app")
    await mkdir(nestedCwd, { recursive: true })
    const nestedMcp = await createMcpTestClient(nestedCwd)

    try {
      const result = await nestedMcp.client.callTool({ name: "list_programs", arguments: {} })
      const data = getJsonContent(result) as Array<{ name: string }>
      expect(data.some((program) => program.name === "root-prog")).toBe(true)
    } finally {
      await nestedMcp.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// get_program
// ---------------------------------------------------------------------------

describe("MCP get_program", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns full program details", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog", {
      programMd: "# My Program\n\n## Goal\nTest goal.\n",
      measureSh: '#!/bin/bash\necho \'{"score": 99}\'',
    })

    const result = await mcp.client.callTool({ name: "get_program", arguments: { name: "test-prog" } })
    const data = getJsonContent(result) as {
      name: string
      config: { metric_field: string }
      program_md: string
      measure_sh: string
      build_sh: string | null
    }

    expect(data.name).toBe("test-prog")
    expect(data.config.metric_field).toBe("score")
    expect(data.program_md).toContain("My Program")
    expect(data.measure_sh).toContain("score")
    expect(data.build_sh).toBeNull()
  })

  test("returns error for non-existent program", async () => {
    const result = await mcp.client.callTool({ name: "get_program", arguments: { name: "no-such" } })
    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("not found")
  })
})

// ---------------------------------------------------------------------------
// get_setup_guide
// ---------------------------------------------------------------------------

describe("MCP get_setup_guide", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns concise setup guide with resource pointer", async () => {
    const result = await mcp.client.callTool({ name: "get_setup_guide", arguments: {} })
    const text = getTextContent(result)
    expect(text).toContain("Quick Guide")
    expect(text).toContain("Mandatory Workflow")
    expect(text).toContain("autoauto://setup-guide")
    // Still standalone — contains essential info
    expect(text).toContain("measure.sh")
    expect(text).toContain("config.json")
    // Emphasizes user confirmation
    expect(text).toContain("Do NOT call create_program until the user explicitly confirms")
  })

  test("includes first-time warning when no config exists", async () => {
    await unlink(join(fixture.cwd, ".autoauto", "config.json"))
    const result = await mcp.client.callTool({ name: "get_setup_guide", arguments: {} })
    const text = getTextContent(result)
    expect(text).toContain("First-Time Setup Required")
    expect(text).toContain("set_config")
    expect(text).toContain("check_auth")
  })

  test("omits first-time warning when config exists", async () => {
    await saveProjectConfig(fixture.cwd, {
      executionModel: { provider: "claude", model: "sonnet", effort: "high" },
      supportModel: { provider: "claude", model: "sonnet", effort: "high" },
      ideasBacklogEnabled: true,
      notificationPreset: "off",
      notificationCommand: null,
    })

    const result = await mcp.client.callTool({ name: "get_setup_guide", arguments: {} })
    const text = getTextContent(result)
    expect(text).toContain("Quick Guide")
    expect(text).not.toContain("First-Time Setup Required")
  })
})

// ---------------------------------------------------------------------------
// MCP Resources
// ---------------------------------------------------------------------------

describe("MCP resources", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("lists setup-guide as a static resource", async () => {
    const result = await mcp.client.listResources()
    const setupGuide = result.resources.find((r) => r.uri === "autoauto://setup-guide")
    expect(setupGuide).toBeDefined()
    expect(setupGuide!.name).toBe("setup-guide")
    expect(setupGuide!.mimeType).toBe("text/markdown")
  })

  test("reads setup-guide resource with critical checkpoints", async () => {
    const result = await mcp.client.readResource({ uri: "autoauto://setup-guide" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("Critical Checkpoints")
    expect(text).toContain("User Confirmation")
    expect(text).toContain("Quality Gates Discussion")
    expect(text).toContain("Config Review After Validation")
    expect(text).toContain("Cost/Time Estimate")
    // Full artifact formats
    expect(text).toContain("program.md")
    expect(text).toContain("measure.sh")
    expect(text).toContain("config.json")
    // Validation interpretation table
    expect(text).toContain("Deterministic")
    expect(text).toContain("noise_threshold")
  })

  test("lists program resource template", async () => {
    const result = await mcp.client.listResourceTemplates()
    const template = result.resourceTemplates.find((t) => t.uriTemplate === "autoauto://program/{name}")
    expect(template).toBeDefined()
    expect(template!.name).toBe("program")
  })

  test("lists programs via resource template", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog", {
      programMd: "# Test\n\n## Goal\nOptimize score.\n",
    })
    const result = await mcp.client.listResources()
    const prog = result.resources.find((r) => r.uri === "autoauto://program/test-prog")
    expect(prog).toBeDefined()
    expect(prog!.name).toBe("test-prog")
  })

  test("reads program resource with full details", async () => {
    await createProgramForMcp(fixture.cwd, "my-prog", {
      programMd: "# My Program\n\n## Goal\nTest goal.\n",
      measureSh: '#!/bin/bash\necho \'{"score": 42}\'',
      buildSh: "#!/bin/bash\nnpm run build",
    })
    const result = await mcp.client.readResource({ uri: "autoauto://program/my-prog" })
    expect(result.contents).toHaveLength(1)
    const text = result.contents[0].text as string
    expect(text).toContain("# Program: my-prog")
    expect(text).toContain("My Program")
    expect(text).toContain("config.json")
    expect(text).toContain("measure.sh")
    expect(text).toContain("build.sh")
    expect(text).toContain("npm run build")
  })

  test("returns not-found for non-existent program resource", async () => {
    const result = await mcp.client.readResource({ uri: "autoauto://program/nonexistent" })
    expect(result.contents[0].text).toContain("not found")
  })
})

// ---------------------------------------------------------------------------
// create_program
// ---------------------------------------------------------------------------

describe("MCP create_program", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("creates program with all files on disk", async () => {
    const result = await mcp.client.callTool({
      name: "create_program",
      arguments: {
        name: "new-prog",
        program_md: "# New Program\n\n## Goal\nReduce size.\n",
        measure_sh: '#!/bin/bash\necho \'{"bytes": 1000}\'',
        build_sh: "#!/bin/bash\nnpm run build",
        config: {
          metric_field: "bytes",
          direction: "lower",
          noise_threshold: 0.01,
          repeats: 1,
          max_experiments: 5,
          quality_gates: {},
        },
      },
    })

    expect(result.isError).toBeFalsy()
    expect(getTextContent(result)).toContain("created")

    // Verify filesystem
    const programDir = join(fixture.cwd, ".autoauto", "programs", "new-prog")
    const config = await Bun.file(join(programDir, "config.json")).json()
    expect(config.metric_field).toBe("bytes")
    expect(config.direction).toBe("lower")

    const programMd = await Bun.file(join(programDir, "program.md")).text()
    expect(programMd).toContain("New Program")

    const measureSh = await Bun.file(join(programDir, "measure.sh")).text()
    expect(measureSh).toContain("bytes")

    const buildSh = await Bun.file(join(programDir, "build.sh")).text()
    expect(buildSh).toContain("npm run build")
  })

  test("rejects duplicate program name", async () => {
    await createProgramForMcp(fixture.cwd, "existing-prog")

    const result = await mcp.client.callTool({
      name: "create_program",
      arguments: {
        name: "existing-prog",
        program_md: "# Dup",
        measure_sh: "#!/bin/bash\necho '{}'",
        config: {
          metric_field: "x",
          direction: "lower",
          noise_threshold: 0.01,
          repeats: 1,
          max_experiments: 5,
        },
      },
    })

    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("already exists")
  })

  test("validates slug format", async () => {
    // Zod validation should reject path-traversal slugs
    try {
      const result = await mcp.client.callTool({
        name: "create_program",
        arguments: {
          name: "../../evil",
          program_md: "# Evil",
          measure_sh: "#!/bin/bash",
          config: {
            metric_field: "x",
            direction: "lower",
            noise_threshold: 0.01,
            repeats: 1,
            max_experiments: 5,
          },
        },
      })
      // If we get a result, it should be an error
      expect(result.isError).toBe(true)
    } catch (err) {
      expect(String(err)).toMatch(/name|slug|invalid|validation/i)
    }
  })

  test("creates program files under the detected project root", async () => {
    const nestedCwd = join(fixture.cwd, "apps", "web")
    await mkdir(nestedCwd, { recursive: true })
    const nestedMcp = await createMcpTestClient(nestedCwd)

    try {
      const result = await nestedMcp.client.callTool({
        name: "create_program",
        arguments: {
          name: "nested-prog",
          program_md: "# Nested Program\n\n## Goal\nWrite into root .autoauto.\n",
          measure_sh: '#!/bin/bash\necho \'{"bytes": 1000}\'',
          config: {
            metric_field: "bytes",
            direction: "lower",
            noise_threshold: 0.01,
            repeats: 1,
            max_experiments: 5,
            quality_gates: {},
          },
        },
      })

      expect(result.isError).toBeFalsy()
      expect(await Bun.file(join(fixture.cwd, ".autoauto", "programs", "nested-prog", "config.json")).exists()).toBe(true)
      expect(await Bun.file(join(nestedCwd, ".autoauto", "programs", "nested-prog", "config.json")).exists()).toBe(false)
    } finally {
      await nestedMcp.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// update_program
// ---------------------------------------------------------------------------

describe("MCP update_program", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("updates selective files", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog", {
      programMd: "# Original",
      measureSh: '#!/bin/bash\necho \'{"score": 1}\'',
    })

    const result = await mcp.client.callTool({
      name: "update_program",
      arguments: {
        name: "test-prog",
        measure_sh: '#!/bin/bash\necho \'{"score": 2}\'',
      },
    })

    expect(result.isError).toBeFalsy()
    expect(getTextContent(result)).toContain("Updated measure.sh")

    // measure.sh changed
    const programDir = join(fixture.cwd, ".autoauto", "programs", "test-prog")
    const measureSh = await Bun.file(join(programDir, "measure.sh")).text()
    expect(measureSh).toContain("score\": 2")

    // program.md unchanged
    const programMd = await Bun.file(join(programDir, "program.md")).text()
    expect(programMd).toContain("Original")
  })

  test("returns error for non-existent program", async () => {
    const result = await mcp.client.callTool({
      name: "update_program",
      arguments: { name: "no-such", program_md: "# New" },
    })
    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("not found")
  })
})

// ---------------------------------------------------------------------------
// delete_program
// ---------------------------------------------------------------------------

describe("MCP delete_program", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("deletes program and all runs", async () => {
    await createProgramForMcp(fixture.cwd, "to-delete")
    await createRunForMcp(fixture.cwd, "to-delete", {
      runId: "20260101-000000",
      phase: "complete",
    })

    const result = await mcp.client.callTool({
      name: "delete_program",
      arguments: { name: "to-delete", confirm: true },
    })

    expect(result.isError).toBeFalsy()
    expect(getTextContent(result)).toContain("deleted")

    // Verify directory removed
    const exists = await Bun.file(join(fixture.cwd, ".autoauto", "programs", "to-delete", "config.json")).exists()
    expect(exists).toBe(false)
  })

  test("refuses deletion of active run", async () => {
    await createProgramForMcp(fixture.cwd, "active-prog")
    await createRunForMcp(fixture.cwd, "active-prog", {
      runId: "20260101-000000",
      phase: "agent_running",
    })

    const result = await mcp.client.callTool({
      name: "delete_program",
      arguments: { name: "active-prog", confirm: true },
    })

    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("active run")
  })
})

// ---------------------------------------------------------------------------
// list_runs
// ---------------------------------------------------------------------------

describe("MCP list_runs", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns message when no runs exist", async () => {
    await createProgramForMcp(fixture.cwd, "empty-prog")

    const result = await mcp.client.callTool({ name: "list_runs", arguments: { name: "empty-prog" } })
    expect(getTextContent(result)).toBe("No runs found.")
  })

  test("lists runs with summary info", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", {
      runId: "20260101-000000",
      phase: "complete",
      totalKeeps: 3,
      totalDiscards: 2,
      totalCrashes: 1,
      bestMetric: 90,
      originalBaseline: 100,
    })
    await createRunForMcp(fixture.cwd, "test-prog", {
      runId: "20260102-000000",
      phase: "complete",
      totalKeeps: 5,
      bestMetric: 80,
      originalBaseline: 100,
    })

    const result = await mcp.client.callTool({ name: "list_runs", arguments: { name: "test-prog" } })
    const data = getJsonContent(result) as Array<{ run_id: string; phase: string; experiments: number }>

    expect(data).toHaveLength(2)
    expect(data.some((r) => r.run_id === "20260101-000000")).toBe(true)
    expect(data.some((r) => r.run_id === "20260102-000000")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// get_run_status
// ---------------------------------------------------------------------------

describe("MCP get_run_status", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns status for a specific run", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", {
      runId: "20260412-100000",
      phase: "complete",
      experimentNumber: 5,
      originalBaseline: 100,
      bestMetric: 85,
      bestExperiment: 3,
      totalKeeps: 3,
      totalDiscards: 1,
      totalCrashes: 1,
    })

    const result = await mcp.client.callTool({
      name: "get_run_status",
      arguments: { name: "test-prog", run_id: "20260412-100000" },
    })

    const data = getJsonContent(result) as Record<string, unknown>
    expect(data.run_id).toBe("20260412-100000")
    expect(data.phase).toBe("complete")
    expect(data.experiment_number).toBe(5)
    expect(data.best_metric).toBe(85)
    expect(data.keeps).toBe(3)
    expect(data.discards).toBe(1)
    expect(data.crashes).toBe(1)
    expect(data.daemon_alive).toBe(false)
  })

  test("returns latest run when run_id omitted", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", { runId: "20260101-000000", phase: "complete" })
    await createRunForMcp(fixture.cwd, "test-prog", { runId: "20260102-000000", phase: "complete" })

    const result = await mcp.client.callTool({
      name: "get_run_status",
      arguments: { name: "test-prog" },
    })

    const data = getJsonContent(result) as Record<string, unknown>
    // Latest run (by directory sort) should be returned
    expect(data.run_id).toBe("20260102-000000")
  })

  test("returns error for non-existent program", async () => {
    const result = await mcp.client.callTool({
      name: "get_run_status",
      arguments: { name: "no-such" },
    })
    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("not found")
  })
})

// ---------------------------------------------------------------------------
// get_run_results
// ---------------------------------------------------------------------------

describe("MCP get_run_results", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns experiment results table", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", {
      results: [
        { experiment_number: 0, commit: "abc1234", metric_value: 100, status: "keep", description: "baseline" },
        { experiment_number: 1, commit: "def5678", metric_value: 95, status: "keep", description: "optimize loop" },
        { experiment_number: 2, commit: "ghi9012", metric_value: 98, status: "discard", description: "bad change" },
      ],
    })

    const result = await mcp.client.callTool({
      name: "get_run_results",
      arguments: { name: "test-prog" },
    })

    const data = getJsonContent(result) as { total_results: number; results: Array<{ experiment_number: number; status: string }> }
    expect(data.total_results).toBe(3)
    expect(data.results).toHaveLength(3)
    expect(data.results[0].status).toBe("keep")
    expect(data.results[1].status).toBe("keep")
    expect(data.results[2].status).toBe("discard")
  })

  test("respects limit parameter", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", {
      results: [
        { experiment_number: 0, commit: "a000000", metric_value: 100, status: "keep", description: "baseline" },
        { experiment_number: 1, commit: "a111111", metric_value: 95, status: "keep", description: "exp 1" },
        { experiment_number: 2, commit: "a222222", metric_value: 93, status: "keep", description: "exp 2" },
        { experiment_number: 3, commit: "a333333", metric_value: 97, status: "discard", description: "exp 3" },
      ],
    })

    const result = await mcp.client.callTool({
      name: "get_run_results",
      arguments: { name: "test-prog", limit: 2 },
    })

    const data = getJsonContent(result) as { total_results: number; results: Array<{ experiment_number: number }> }
    expect(data.total_results).toBe(4)
    expect(data.results).toHaveLength(2)
    // Last 2 results
    expect(data.results[0].experiment_number).toBe(2)
    expect(data.results[1].experiment_number).toBe(3)
  })

  test("returns message when no results yet", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog")

    const result = await mcp.client.callTool({
      name: "get_run_results",
      arguments: { name: "test-prog" },
    })
    expect(getTextContent(result)).toContain("No results yet")
  })
})

// ---------------------------------------------------------------------------
// get_experiment_log
// ---------------------------------------------------------------------------

describe("MCP get_experiment_log", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns stream log content", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", {
      results: [
        { experiment_number: 0, commit: "aaa0000", metric_value: 100, status: "keep", description: "baseline" },
        { experiment_number: 1, commit: "bbb1111", metric_value: 90, status: "keep", description: "exp 1" },
      ],
    })

    // Write a stream log file
    await Bun.write(join(runDir, "stream-001.log"), "Agent thinking...\nEditing file.ts\nDone.")

    const result = await mcp.client.callTool({
      name: "get_experiment_log",
      arguments: { name: "test-prog", experiment_number: 1 },
    })

    expect(result.isError).toBeFalsy()
    expect(getTextContent(result)).toContain("Agent thinking...")
    expect(getTextContent(result)).toContain("Done.")
  })

  test("returns error when no log exists", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog")

    const result = await mcp.client.callTool({
      name: "get_experiment_log",
      arguments: { name: "test-prog", experiment_number: 5 },
    })
    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("No log found")
  })

  test("handles 'latest' experiment_number", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", {
      results: [
        { experiment_number: 0, commit: "aaa0000", metric_value: 100, status: "keep", description: "baseline" },
        { experiment_number: 1, commit: "bbb1111", metric_value: 90, status: "keep", description: "exp 1" },
        { experiment_number: 2, commit: "ccc2222", metric_value: 85, status: "keep", description: "exp 2" },
      ],
    })

    await Bun.write(join(runDir, "stream-002.log"), "Latest experiment log content")

    const result = await mcp.client.callTool({
      name: "get_experiment_log",
      arguments: { name: "test-prog", experiment_number: "latest" },
    })

    expect(result.isError).toBeFalsy()
    expect(getTextContent(result)).toContain("Latest experiment log content")
  })
})

// ---------------------------------------------------------------------------
// get_run_summary
// ---------------------------------------------------------------------------

describe("MCP get_run_summary", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns existing summary", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", { phase: "complete" })
    await Bun.write(join(runDir, "summary.md"), "# Run Summary\n\nGreat results!")

    const result = await mcp.client.callTool({
      name: "get_run_summary",
      arguments: { name: "test-prog" },
    })

    const data = getJsonContent(result) as { has_summary: boolean; generated: boolean; summary: string }
    expect(data.has_summary).toBe(true)
    expect(data.generated).toBe(false)
    expect(data.summary).toContain("Great results!")
  })

  test("generates stats summary for completed run", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", {
      phase: "complete",
      totalKeeps: 3,
      totalDiscards: 2,
      bestMetric: 80,
      originalBaseline: 100,
      results: [
        { experiment_number: 0, commit: "aaa0000", metric_value: 100, status: "keep", description: "baseline" },
        { experiment_number: 1, commit: "bbb1111", metric_value: 80, status: "keep", description: "improved" },
      ],
    })

    const result = await mcp.client.callTool({
      name: "get_run_summary",
      arguments: { name: "test-prog", generate: true },
    })

    const data = getJsonContent(result) as { has_summary: boolean; generated: boolean; summary: string }
    expect(data.has_summary).toBe(true)
    expect(data.generated).toBe(true)
    expect(data.summary).toBeTruthy()

    // Verify file was written to disk
    const summaryExists = await Bun.file(join(runDir, "summary.md")).exists()
    expect(summaryExists).toBe(true)
  })

  test("returns hint when no summary and generate=false", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", { phase: "complete" })

    const result = await mcp.client.callTool({
      name: "get_run_summary",
      arguments: { name: "test-prog" },
    })

    const data = getJsonContent(result) as { has_summary: boolean; hint: string }
    expect(data.has_summary).toBe(false)
    expect(data.hint).toContain("generate=true")
  })

  test("rejects generate for active run", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog", { phase: "agent_running" })

    const result = await mcp.client.callTool({
      name: "get_run_summary",
      arguments: { name: "test-prog", generate: true },
    })

    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("completed or crashed")
  })
})

// ---------------------------------------------------------------------------
// validate_measurement (real subprocess)
// ---------------------------------------------------------------------------

describe("MCP validate_measurement", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("validates a working measurement script", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog", {
      measureSh: '#!/usr/bin/env bash\nset -euo pipefail\necho \'{"score": 42}\'',
    })

    const result = await mcp.client.callTool({
      name: "validate_measurement",
      arguments: { name: "test-prog", runs: 2 },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { validation: { success: boolean } }
    expect(data.validation.success).toBe(true)
  }, 60_000) // generous timeout for subprocess

  test("returns error for missing program", async () => {
    const result = await mcp.client.callTool({
      name: "validate_measurement",
      arguments: { name: "no-such", runs: 1 },
    })
    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("not found")
  })
}, 90_000)


// ---------------------------------------------------------------------------
// get_guidance
// ---------------------------------------------------------------------------

describe("MCP get_guidance", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("returns no guidance when file does not exist", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    await createRunForMcp(fixture.cwd, "test-prog")

    const result = await mcp.client.callTool({
      name: "get_guidance",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { has_guidance: boolean; guidance: string | null }
    expect(data.has_guidance).toBe(false)
    expect(data.guidance).toBeNull()
  })

  test("returns guidance when file exists", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog")
    await Bun.write(join(runDir, "guidance.md"), "Focus on parser optimizations\n")

    const result = await mcp.client.callTool({
      name: "get_guidance",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { has_guidance: boolean; guidance: string }
    expect(data.has_guidance).toBe(true)
    expect(data.guidance).toBe("Focus on parser optimizations")
  })

  test("returns error for non-existent program", async () => {
    const result = await mcp.client.callTool({
      name: "get_guidance",
      arguments: { name: "no-such" },
    })
    expect(result.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// conversational sessions
// ---------------------------------------------------------------------------

describe("MCP conversational sessions", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    setProvider("claude", new MockProvider([
      { type: "tool_use", tool: "Read", input: { file_path: "/tmp/test.txt" } },
      { type: "assistant_complete", text: "Mock reply." },
      { type: "result", success: true },
    ]))
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("start_setup_session creates a session and returns first reply", async () => {
    const result = await mcp.client.callTool({
      name: "start_setup_session",
      arguments: {
        mode: "direct",
        message: "I want to optimize bundle size.",
      },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as {
      session_id: string
      kind: string
      assistant_message: string
      tool_events: string[]
      messages: Array<{ role: string; content: string }>
    }

    expect(data.kind).toBe("setup")
    expect(data.assistant_message).toBe("Mock reply.")
    expect(data.tool_events[0]).toContain("Reading")
    expect(data.messages).toEqual([
      { role: "user", content: "I want to optimize bundle size." },
      { role: "assistant", content: "Mock reply." },
    ])
  })

  test("sessions persist across MCP server reconnects", async () => {
    const started = await mcp.client.callTool({
      name: "start_setup_session",
      arguments: { mode: "direct", message: "First turn." },
    })
    const { session_id } = getJsonContent(started) as { session_id: string }

    await mcp.cleanup()
    mcp = await createMcpTestClient(fixture.cwd)

    const replied = await mcp.client.callTool({
      name: "send_session_message",
      arguments: {
        session_id,
        message: "Second turn.",
      },
    })

    expect(replied.isError).toBeFalsy()
    const session = await mcp.client.callTool({
      name: "get_session",
      arguments: { session_id },
    })

    const data = getJsonContent(session) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(data.messages).toEqual([
      { role: "user", content: "First turn." },
      { role: "assistant", content: "Mock reply." },
      { role: "user", content: "Second turn." },
      { role: "assistant", content: "Mock reply." },
    ])
  })

  test("start_update_session auto-seeds from program context", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")

    const result = await mcp.client.callTool({
      name: "start_update_session",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as {
      kind: string
      program_slug: string
      assistant_message: string
      messages: Array<{ role: string; content: string }>
    }

    expect(data.kind).toBe("update")
    expect(data.program_slug).toBe("test-prog")
    expect(data.assistant_message).toBe("Mock reply.")
    expect(data.messages[0]?.role).toBe("user")
    expect(data.messages[0]?.content).toContain("No previous runs found")
  })
})

// ---------------------------------------------------------------------------
// config / models / auth
// ---------------------------------------------------------------------------

describe("MCP config and provider metadata", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    setProvider("claude", new MockProvider(
      [],
      { authenticated: true, account: { email: "claude@example.com" } },
      [{ provider: "claude", model: "sonnet", label: "Sonnet", isDefault: true }],
    ))
    setProvider("codex", new MockProvider(
      [],
      { authenticated: false, error: "Codex login required" },
      [{ provider: "codex", model: "default", label: "Codex Default", isDefault: true }],
    ))
    setProvider("opencode", new MockProvider(
      [],
      { authenticated: true, account: { email: "opencode@example.com" } },
      [{ provider: "opencode", model: "openai/gpt-5", label: "GPT-5" }],
    ))
    mcp = await createMcpTestClient(fixture.cwd)
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("get_config returns defaults with is_default_config=true when no config exists", async () => {
    // Fixture creates config by default — remove it to simulate first-time user
    await unlink(join(fixture.cwd, ".autoauto", "config.json"))
    const result = await mcp.client.callTool({ name: "get_config", arguments: {} })
    const data = getJsonContent(result) as {
      executionModel: { provider: string; model: string; effort: string }
      supportModel: { provider: string; model: string; effort: string }
      ideasBacklogEnabled: boolean
      _meta: { config_exists: boolean; is_default_config: boolean }
    }

    expect(data.executionModel).toEqual({ provider: "claude", model: "sonnet", effort: "high" })
    expect(data.supportModel).toEqual({ provider: "claude", model: "sonnet", effort: "high" })
    expect(data.ideasBacklogEnabled).toBe(true)
    expect(data._meta.config_exists).toBe(false)
    expect(data._meta.is_default_config).toBe(true)
  })

  test("get_config returns is_default_config=false after config is saved", async () => {
    await saveProjectConfig(fixture.cwd, {
      executionModel: { provider: "claude", model: "sonnet", effort: "high" },
      supportModel: { provider: "claude", model: "opus", effort: "high" },
      ideasBacklogEnabled: true,
      notificationPreset: "off",
      notificationCommand: null,
    })

    const result = await mcp.client.callTool({ name: "get_config", arguments: {} })
    const data = getJsonContent(result) as {
      _meta: { config_exists: boolean; is_default_config: boolean }
    }

    expect(data._meta.config_exists).toBe(true)
    expect(data._meta.is_default_config).toBe(false)
  })

  test("set_config merges provided fields", async () => {
    await saveProjectConfig(fixture.cwd, {
      executionModel: { provider: "claude", model: "sonnet", effort: "high" },
      supportModel: { provider: "claude", model: "sonnet", effort: "high" },
      executionFallbackModel: null,
      ideasBacklogEnabled: true,
      notificationPreset: "off",
      notificationCommand: null,
    })

    const result = await mcp.client.callTool({
      name: "set_config",
      arguments: {
        supportModel: { provider: "opencode", model: "openai/gpt-5", effort: "high" },
        executionFallbackModel: { provider: "codex", model: "default", effort: "medium" },
        ideasBacklogEnabled: false,
      },
    })

    const data = getJsonContent(result) as {
      executionModel: { provider: string; model: string; effort: string }
      supportModel: { provider: string; model: string; effort: string }
      executionFallbackModel: { provider: string; model: string; effort: string } | null
      ideasBacklogEnabled: boolean
    }

    expect(data.executionModel).toEqual({ provider: "claude", model: "sonnet", effort: "high" })
    expect(data.supportModel).toEqual({ provider: "opencode", model: "openai/gpt-5", effort: "high" })
    expect(data.executionFallbackModel).toEqual({ provider: "codex", model: "default", effort: "medium" })
    expect(data.ideasBacklogEnabled).toBe(false)
  })

  test("list_models returns models for all providers", async () => {
    const result = await mcp.client.callTool({ name: "list_models", arguments: {} })
    const data = getJsonContent(result) as Array<{
      provider: string
      available: boolean
      default_model: string | null
      models: Array<{ model: string }>
    }>

    expect(data).toHaveLength(3)
    expect(data.find((p) => p.provider === "claude")).toMatchObject({
      available: true,
      default_model: "sonnet",
      models: [{ model: "sonnet" }],
    })
    expect(data.find((p) => p.provider === "codex")).toMatchObject({
      available: true,
      default_model: "default",
      models: [{ model: "default" }],
    })
  })

  test("check_auth returns auth state for all providers", async () => {
    const result = await mcp.client.callTool({ name: "check_auth", arguments: {} })
    const data = getJsonContent(result) as Array<{
      provider: string
      authenticated: boolean
      error: string | null
    }>

    expect(data.find((p) => p.provider === "claude")).toMatchObject({
      authenticated: true,
      error: null,
    })
    expect(data.find((p) => p.provider === "codex")).toMatchObject({
      authenticated: false,
      error: "Codex login required",
    })
  })
})
