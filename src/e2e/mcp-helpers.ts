/**
 * MCP E2E test helpers: connects a real MCP Client to the AutoAuto MCP Server
 * via in-memory transport for true end-to-end protocol testing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../mcp.ts"
import { join } from "node:path"
import { mkdir, chmod } from "node:fs/promises"
import { resetProjectRoot } from "../lib/programs.ts"

export interface McpTestContext {
  client: Client
  cleanup: () => Promise<void>
}

/** Create an MCP Client connected to the real MCP Server via in-memory transport. */
export async function createMcpTestClient(cwd: string): Promise<McpTestContext> {
  resetProjectRoot()
  const server = createMcpServer(cwd)
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

/** Extract text content from an MCP CallToolResult. */
export function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((c) => c.type === "text")
  return item?.text ?? ""
}

/** Parse JSON from an MCP CallToolResult text content. */
export function getJsonContent(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(getTextContent(result))
}

export interface McpProgramOpts {
  config?: {
    metric_field?: string
    direction?: "lower" | "higher"
    noise_threshold?: number
    repeats?: number
    max_experiments?: number
    quality_gates?: Record<string, { min?: number; max?: number }>
  }
  programMd?: string
  measureSh?: string
  buildSh?: string
}

/**
 * Create a program directory with the file layout the MCP server expects
 * (measure.sh, program.md, config.json). Unlike the TUI fixture which writes
 * `measure`, the MCP server expects `measure.sh`.
 */
export async function createProgramForMcp(
  cwd: string,
  slug: string,
  opts: McpProgramOpts = {},
): Promise<string> {
  const programDir = join(cwd, ".autoauto", "programs", slug)
  await mkdir(programDir, { recursive: true })

  const config = {
    metric_field: opts.config?.metric_field ?? "score",
    direction: opts.config?.direction ?? "lower",
    noise_threshold: opts.config?.noise_threshold ?? 0.02,
    repeats: opts.config?.repeats ?? 1,
    max_experiments: opts.config?.max_experiments ?? 10,
    quality_gates: opts.config?.quality_gates ?? {},
  }

  const measureSh = opts.measureSh ?? '#!/bin/bash\necho \'{"score": 42}\''
  const programMd = opts.programMd ?? "# Test Program\n\n## Goal\nOptimize the score.\n"

  await Promise.all([
    Bun.write(join(programDir, "config.json"), JSON.stringify(config, null, 2) + "\n"),
    Bun.write(join(programDir, "measure.sh"), measureSh),
    Bun.write(join(programDir, "program.md"), programMd),
    ...(opts.buildSh ? [Bun.write(join(programDir, "build.sh"), opts.buildSh)] : []),
  ])

  await chmod(join(programDir, "measure.sh"), 0o755)
  if (opts.buildSh) await chmod(join(programDir, "build.sh"), 0o755)

  return programDir
}

export interface McpRunOpts {
  runId?: string
  phase?: string
  experimentNumber?: number
  originalBaseline?: number
  currentBaseline?: number
  bestMetric?: number
  bestExperiment?: number
  totalKeeps?: number
  totalDiscards?: number
  totalCrashes?: number
  terminationReason?: string | null
  results?: Array<{
    experiment_number: number
    commit: string
    metric_value: number
    status: "keep" | "discard" | "crash"
    description: string
  }>
}

/**
 * Create a run directory with state.json and results.tsv for MCP tests.
 * Returns the run directory path.
 */
export async function createRunForMcp(
  cwd: string,
  slug: string,
  opts: McpRunOpts = {},
): Promise<string> {
  const runId = opts.runId ?? "20260412-100000"
  const programDir = join(cwd, ".autoauto", "programs", slug)
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  const initSha = (await import("bun").then((b) => b.$`git rev-parse HEAD`.cwd(cwd).text())).trim()

  const state = {
    run_id: runId,
    program_slug: slug,
    phase: opts.phase ?? "complete",
    experiment_number: opts.experimentNumber ?? 0,
    original_baseline: opts.originalBaseline ?? 100,
    current_baseline: opts.currentBaseline ?? 100,
    best_metric: opts.bestMetric ?? 100,
    best_experiment: opts.bestExperiment ?? 0,
    total_keeps: opts.totalKeeps ?? 0,
    total_discards: opts.totalDiscards ?? 0,
    total_crashes: opts.totalCrashes ?? 0,
    branch_name: `autoauto-${slug}-${runId}`,
    original_baseline_sha: initSha,
    last_known_good_sha: initSha,
    candidate_sha: null,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    termination_reason: opts.terminationReason ?? null,
  }
  await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))

  // Write results.tsv
  const header = "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats"
  const rows = (opts.results ?? []).map((r) =>
    `${r.experiment_number}\t${r.commit}\t${r.metric_value}\t\t${r.status}\t${r.description}\t5000\t`,
  )
  await Bun.write(join(runDir, "results.tsv"), [header, ...rows, ""].join("\n"))

  return runDir
}
