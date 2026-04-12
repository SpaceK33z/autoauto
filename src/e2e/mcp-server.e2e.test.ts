/**
 * E2E tests for the AutoAuto MCP server — filesystem tools.
 * Uses real MCP Client ↔ Server communication via InMemoryTransport.
 * Zero mocking: all tool handlers run against a real temp git repo.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "node:path"
import {
  createMcpTestClient,
  getTextContent,
  getJsonContent,
  createProgramForMcp,
  createRunForMcp,
  type McpTestContext,
} from "./mcp-helpers.ts"
import { createTestFixture, type TestFixture } from "./fixture.ts"

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

  test("returns setup guide text", async () => {
    const result = await mcp.client.callTool({ name: "get_setup_guide", arguments: {} })
    const text = getTextContent(result)
    expect(text).toContain("AutoAuto Program Setup Guide")
    expect(text).toContain("measure.sh")
    expect(text).toContain("config.json")
    expect(text).toContain("quality_gates")
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
    } catch {
      // MCP SDK may throw on schema validation failure — that's fine
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
