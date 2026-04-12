/**
 * E2E tests for MCP daemon tools (start_run, stop_run, update_run_limit).
 * These tools interact with daemon processes, so we inject mock daemon
 * dependencies via createMcpServer's daemonDeps parameter instead of using
 * mock.module (which is process-wide in Bun and causes segfaults when
 * combined with OpenTUI test renderer).
 */

import { describe, test, expect, beforeEach, afterEach, mock, type Mock } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createTestFixture, type TestFixture } from "./fixture.ts"
import { createProgramForMcp, createRunForMcp, getTextContent, getJsonContent, type McpTestContext } from "./mcp-helpers.ts"
import { createMcpServer, type McpDaemonDeps } from "../mcp.ts"
import { resetProjectRoot } from "../lib/programs.ts"

// ---------------------------------------------------------------------------
// Mock daemon functions — injected via createMcpServer's daemonDeps
// ---------------------------------------------------------------------------

const mockSpawnDaemon = mock(() =>
  Promise.resolve({ runId: "20260412-100000", runDir: "/tmp/fake", worktreePath: null, pid: 99999 }),
)
const mockFindActiveRun = mock(() => Promise.resolve(null)) as Mock<() => Promise<{
  runId: string
  runDir: string
  daemonAlive: boolean
} | null>>
const mockSendStop = mock(() => Promise.resolve())
const mockSendAbort = mock(() => Promise.resolve())
const mockForceKillDaemon = mock(() => Promise.resolve())
const mockGetDaemonStatus = mock(() => Promise.resolve({ alive: false, starting: false, daemonJson: null }))
const mockUpdateMaxExperiments = mock(() => Promise.resolve())

const daemonDeps: Partial<McpDaemonDeps> = {
  spawnDaemon: mockSpawnDaemon,
  getDaemonStatus: mockGetDaemonStatus,
  sendStop: mockSendStop,
  sendAbort: mockSendAbort,
  forceKillDaemon: mockForceKillDaemon,
  findActiveRun: mockFindActiveRun,
  updateMaxExperiments: mockUpdateMaxExperiments,
}

async function createMcpClient(cwd: string): Promise<McpTestContext> {
  resetProjectRoot()
  const server = createMcpServer(cwd, daemonDeps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    cleanup: async () => {
      await client.close()
      await server.close()
    },
  }
}

// ---------------------------------------------------------------------------
// start_run
// ---------------------------------------------------------------------------

describe("MCP start_run", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpClient(fixture.cwd)
    mockSpawnDaemon.mockClear()
    mockSpawnDaemon.mockImplementation(() =>
      Promise.resolve({ runId: "20260412-100000", runDir: "/tmp/fake", worktreePath: null, pid: 99999 }),
    )
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("starts a run and returns run info", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")

    const result = await mcp.client.callTool({
      name: "start_run",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { run_id: string; daemon_pid: number; status: string }
    expect(data.run_id).toBe("20260412-100000")
    expect(data.daemon_pid).toBe(99999)
    expect(data.status).toBe("started")
    expect(mockSpawnDaemon).toHaveBeenCalledTimes(1)
  })

  test("passes custom model and max_experiments to daemon", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")

    await mcp.client.callTool({
      name: "start_run",
      arguments: {
        name: "test-prog",
        provider: "codex",
        model: "o3",
        effort: "max",
        max_experiments: 50,
      },
    })

    expect(mockSpawnDaemon).toHaveBeenCalledTimes(1)
    const args = mockSpawnDaemon.mock.calls[0]
    expect(args[2]).toEqual({ provider: "codex", model: "o3", effort: "max" })
    expect(args[3]).toBe(50)
  })

  test("allows start_run immediately after create_program adds .autoauto to .gitignore", async () => {
    const created = await mcp.client.callTool({
      name: "create_program",
      arguments: {
        name: "fresh-prog",
        program_md: "# Fresh Program\n\n## Goal\nKeep score low.\n",
        measure_sh: '#!/bin/bash\necho \'{"score": 1}\'',
        config: {
          metric_field: "score",
          direction: "lower",
          noise_threshold: 0.01,
          repeats: 1,
          max_experiments: 5,
          quality_gates: {},
        },
      },
    })
    expect(created.isError).toBeFalsy()

    const result = await mcp.client.callTool({
      name: "start_run",
      arguments: { name: "fresh-prog" },
    })

    expect(result.isError).toBeFalsy()
    expect(mockSpawnDaemon).toHaveBeenCalledTimes(1)
  })

  test("returns error for non-existent program", async () => {
    const result = await mcp.client.callTool({
      name: "start_run",
      arguments: { name: "no-such" },
    })
    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("not found")
    expect(mockSpawnDaemon).not.toHaveBeenCalled()
  })

  test("returns error when daemon spawn fails", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    mockSpawnDaemon.mockImplementation(() => Promise.reject(new Error("Working tree is dirty")))

    const result = await mcp.client.callTool({
      name: "start_run",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("dirty")
  })
})

// ---------------------------------------------------------------------------
// stop_run
// ---------------------------------------------------------------------------

describe("MCP stop_run", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpClient(fixture.cwd)
    mockFindActiveRun.mockClear()
    mockSendStop.mockClear()
    mockSendAbort.mockClear()
    mockForceKillDaemon.mockClear()
    mockGetDaemonStatus.mockClear()
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("sends soft stop signal", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", { phase: "agent_running" })

    mockFindActiveRun.mockImplementation(() =>
      Promise.resolve({ runId: "20260412-100000", runDir, daemonAlive: true }),
    )

    const result = await mcp.client.callTool({
      name: "stop_run",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { action: string; status: string }
    expect(data.action).toBe("stop")
    expect(data.status).toBe("stopping")
    expect(mockSendStop).toHaveBeenCalledTimes(1)
  })

  test("sends abort signal with abort=true", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", { phase: "agent_running" })

    mockFindActiveRun.mockImplementation(() =>
      Promise.resolve({ runId: "20260412-100000", runDir, daemonAlive: true }),
    )
    // getDaemonStatus returns not alive after abort
    mockGetDaemonStatus.mockImplementation(() =>
      Promise.resolve({ alive: false, starting: false, daemonJson: null }),
    )

    const result = await mcp.client.callTool({
      name: "stop_run",
      arguments: { name: "test-prog", abort: true },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { action: string; status: string }
    expect(data.action).toBe("abort")
    expect(data.status).toBe("aborted")
    expect(mockSendAbort).toHaveBeenCalledTimes(1)
  })

  test("returns error when no active run", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    mockFindActiveRun.mockImplementation(() => Promise.resolve(null))

    const result = await mcp.client.callTool({
      name: "stop_run",
      arguments: { name: "test-prog" },
    })

    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("No active run")
  })
})

// ---------------------------------------------------------------------------
// update_run_limit
// ---------------------------------------------------------------------------

describe("MCP update_run_limit", () => {
  let fixture: TestFixture
  let mcp: McpTestContext

  beforeEach(async () => {
    fixture = await createTestFixture()
    mcp = await createMcpClient(fixture.cwd)
    mockFindActiveRun.mockClear()
    mockUpdateMaxExperiments.mockClear()
  })

  afterEach(async () => {
    await mcp.cleanup()
    await fixture.cleanup()
  })

  test("updates max experiments on active run", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    const runDir = await createRunForMcp(fixture.cwd, "test-prog", { phase: "agent_running" })

    mockFindActiveRun.mockImplementation(() =>
      Promise.resolve({ runId: "20260412-100000", runDir, daemonAlive: true }),
    )

    const result = await mcp.client.callTool({
      name: "update_run_limit",
      arguments: { name: "test-prog", max_experiments: 100 },
    })

    expect(result.isError).toBeFalsy()
    const data = getJsonContent(result) as { run_id: string; max_experiments: number }
    expect(data.max_experiments).toBe(100)
    expect(mockUpdateMaxExperiments).toHaveBeenCalledTimes(1)
    expect(mockUpdateMaxExperiments.mock.calls[0][0]).toBe(runDir)
    expect(mockUpdateMaxExperiments.mock.calls[0][1]).toBe(100)
  })

  test("returns error when no active run", async () => {
    await createProgramForMcp(fixture.cwd, "test-prog")
    mockFindActiveRun.mockImplementation(() => Promise.resolve(null))

    const result = await mcp.client.callTool({
      name: "update_run_limit",
      arguments: { name: "test-prog", max_experiments: 50 },
    })

    expect(result.isError).toBe(true)
    expect(getTextContent(result)).toContain("No active run")
  })
})
