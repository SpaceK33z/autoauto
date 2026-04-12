#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * AutoAuto MCP Server
 *
 * Exposes tools for managing autoresearch programs via the Model Context Protocol.
 * Primary use case: let a user's coding agent create and configure programs.
 *
 * Transport: stdio (spawned as a subprocess by MCP clients)
 * Launch:    bun run src/mcp.ts [--cwd <project-root>]
 *            autoauto mcp [--cwd <project-root>]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, chmod } from "node:fs/promises"
import {
  listPrograms,
  loadProgramConfig,
  getProgramDir,
  getProgramsDir,
  getProjectRoot,
  ensureAutoAutoDir,
  loadProgramSummaries,
  validateProgramConfig,
  type ProgramConfig,
} from "./lib/programs.ts"
import { listRuns, isRunActive, deleteProgram } from "./lib/run.ts"

// ---------------------------------------------------------------------------
// CWD resolution
// ---------------------------------------------------------------------------

function resolveCwd(): string {
  const idx = process.argv.indexOf("--cwd")
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  return process.cwd()
}

const CWD = resolveCwd()

const VALIDATE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "lib", "validate-measurement.ts")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] }
}

function jsonText(obj: unknown) {
  return text(JSON.stringify(obj, null, 2))
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true as const }
}

async function readFileOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path)
  if (await f.exists()) return f.text()
  return null
}

async function writeScript(path: string, content: string): Promise<void> {
  await Bun.write(path, content)
  await chmod(path, 0o755)
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()

const server = new McpServer(
  { name: "autoauto", version: pkg.version },
  {
    capabilities: { logging: {} },
    instructions: [
      "AutoAuto manages autoresearch programs — autonomous experiment loops that optimize a single metric on any codebase.",
      "Workflow: (1) get_setup_guide to learn artifact formats,",
      "(2) list_programs to check for duplicates,",
      "(3) create_program to write all files,",
      "(4) validate_measurement to verify stability.",
      "Use get_program to inspect existing programs, update_program to modify them, delete_program to remove them.",
    ].join(" "),
  },
)

// ---------------------------------------------------------------------------
// Tool: list_programs
// ---------------------------------------------------------------------------

server.registerTool(
  "list_programs",
  {
    title: "List Programs",
    description:
      "List all autoresearch programs in the project with their goals and run counts.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => {
    const root = await getProjectRoot(CWD)
    const programs = await listPrograms(CWD)
    if (programs.length === 0) return text("No programs found.")

    const summaries = await loadProgramSummaries(CWD)
    const summaryMap = new Map(summaries.map((s) => [s.slug, s.goal]))

    const result = await Promise.all(
      programs.map(async (p) => {
        const programDir = getProgramDir(root, p.name)
        const runs = await listRuns(programDir)
        const activeRun = runs.find(isRunActive)
        return {
          name: p.name,
          goal: summaryMap.get(p.name) ?? "(unknown)",
          totalRuns: runs.length,
          hasActiveRun: !!activeRun,
        }
      }),
    )
    return jsonText(result)
  },
)

// ---------------------------------------------------------------------------
// Tool: get_program
// ---------------------------------------------------------------------------

server.registerTool(
  "get_program",
  {
    title: "Get Program Details",
    description:
      "Get the full details of a program: config.json, program.md, measure.sh, and build.sh.",
    inputSchema: z.object({
      name: z.string().describe("Program slug (e.g. 'homepage-lcp')"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    const root = await getProjectRoot(CWD)
    const programDir = getProgramDir(root, name)

    let config: ProgramConfig
    try {
      config = await loadProgramConfig(programDir)
    } catch (err) {
      return errorResult(`Program '${name}' not found or invalid config: ${err}`)
    }

    const [programMd, measureSh, buildSh] = await Promise.all([
      readFileOrNull(join(programDir, "program.md")),
      readFileOrNull(join(programDir, "measure.sh")),
      readFileOrNull(join(programDir, "build.sh")),
    ])

    return jsonText({
      name,
      config,
      program_md: programMd,
      measure_sh: measureSh,
      build_sh: buildSh,
    })
  },
)

// ---------------------------------------------------------------------------
// Tool: get_setup_guide
// ---------------------------------------------------------------------------

server.registerTool(
  "get_setup_guide",
  {
    title: "Get Setup Guide",
    description: [
      "Get the complete guide for creating AutoAuto programs.",
      "Includes artifact formats (program.md, measure.sh, build.sh, config.json),",
      "measurement requirements, quality gate design, and autoresearch best practices.",
      "Read this BEFORE calling create_program.",
    ].join(" "),
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => {
    const root = await getProjectRoot(CWD)
    const programsDir = getProgramsDir(root)

    const guide = `# AutoAuto Program Setup Guide

## What is an AutoAuto Program?

An optimization program defines a repeatable, measurable experiment loop that an AI agent runs autonomously to improve a specific metric. Each program has:
- **program.md** — Goal, scope, rules, and steps for the agent
- **measure.sh** — Script that outputs a single JSON object with the metric
- **build.sh** (optional) — Build/compile step that runs once before measurements
- **config.json** — Metric configuration, quality gates, and tuning parameters

## Key Principles

- **One metric, one direction, one target.** Every program optimizes exactly one number. Narrow is better — "reduce homepage JS chunk size in bytes" beats "reduce bundle size."
- **Scope is safety.** The experiment agent will exploit any loophole. Tight scope prevents metric gaming.
- **Measurement must be fast and stable.** The script runs hundreds of times. It should complete in seconds, not minutes.
- **Binary over sliding scale.** For subjective metrics, prefer binary yes/no criteria over 1-7 scales.

## Program Directory Structure

Programs live in: ${programsDir}/<slug>/
\`\`\`
${programsDir}/<slug>/
├── program.md      # Goal, scope, rules, steps
├── measure.sh      # Measurement script (chmod +x)
├── build.sh        # Optional build step (chmod +x)
└── config.json     # Metric configuration
\`\`\`

## Artifact Formats

### program.md

\`\`\`markdown
# Program: <Human-Readable Name>

## Goal
<One clear sentence describing what to optimize and in what direction.>

## Scope
- Files: <specific files or glob patterns the experiment agent may modify>
- Off-limits: <files, directories, or systems the agent must NOT touch>

## Rules
<Numbered list of constraints. Be specific.>
1. Do not remove features or functionality
2. Do not modify test fixtures or test data
3. Do not change the public API surface
4. <domain-specific constraints>

## Steps
1. ANALYZE: Read the codebase within scope, review results.tsv for past experiments
2. PLAN: Choose ONE specific, targeted change
3. IMPLEMENT: Make the change, keeping the diff small and focused
4. TEST: Verify the change doesn't break anything
5. COMMIT: Stage and commit with message format: "<type>(scope): description"
\`\`\`

### measure.sh

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

# <Brief description of what this measures>
# Output: JSON object with metric fields

<measurement logic — assumes project is already built>

# Output MUST be a single JSON object on stdout, nothing else
echo '{"<metric_field>": <value>}'
\`\`\`

Requirements:
- Shebang + \`set -euo pipefail\`
- stdout: exactly ONE JSON object, nothing else (logs go to stderr)
- Exit 0 on success, nonzero on failure
- Must complete in <30 seconds ideally
- Must be deterministic: lock random seeds, avoid network calls
- All quality gate and secondary metric fields must be present as finite numbers
- NEVER hardcode absolute home paths — use relative paths or \`$HOME\`

### build.sh (optional)

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

# Build step — runs ONCE before measurement runs
# MUST install dependencies (npm ci, bun install, etc.)
<build logic>
\`\`\`

Only needed when the project has a build/compile step.

### config.json

\`\`\`json
{
  "metric_field": "<key from measure.sh JSON output>",
  "direction": "lower|higher",
  "noise_threshold": 0.02,
  "repeats": 3,
  "max_experiments": 20,
  "quality_gates": {
    "<field_name>": { "min": 1.0 }
  },
  "secondary_metrics": {
    "<field_name>": { "direction": "lower|higher" }
  }
}
\`\`\`

Field reference:
- \`metric_field\`: Key in measure.sh JSON output to optimize
- \`direction\`: "lower" or "higher" — which direction is better
- \`noise_threshold\`: Minimum relative improvement to keep (decimal: 0.02 = 2%)
- \`repeats\`: Measurements per experiment (3 for stable, 5 for noisy)
- \`max_experiments\`: Cap per run (20 default; 10-15 for expensive, 50+ for cheap)
- \`quality_gates\`: Hard pass/fail constraints — experiment discarded if gate fails
- \`secondary_metrics\`: Advisory metrics tracked but not gating (direction required)
- \`max_consecutive_discards\`: (optional) Auto-stop after N consecutive non-improving experiments (default 10)
- \`measurement_timeout\`: (optional) Timeout in ms for each measure.sh run (default 60000)
- \`build_timeout\`: (optional) Timeout in ms for build.sh (default 600000)
- \`max_cost_usd\`: (optional) Cost cap per run

## Measurement Design Tips

- If the metric is naturally deterministic (byte count, line count), noise_threshold=0.01 and repeats=1 may suffice
- For tool-based metrics (Lighthouse, benchmarks), use repeats=3 minimum
- Flag potential noise sources: cold starts, network calls, random seeds, caching
- measure.sh can write \`.autoauto-diagnostics\` sidecar file for rich context to the agent

## Quality Gate Design

- Suggest gates based on what could break when optimizing the primary metric
- Test pass rate is a common default gate: \`"test_pass_rate": { "min": 1.0 }\`
- Keep gates focused — too many gates leads to checklist gaming
- Prefer binary pass/fail over threshold-based gates

## Anti-Gaming Rules

Think about how the agent could game the metric and add rules against it:
- Bundle size → agent might delete features or replace libraries with stubs
- Test coverage → agent might add trivial tests
- Latency → agent might remove error handling or validation
- Line count → agent might minify code or remove comments

## Expectations

- 5-25% keep rate is normal (most experiments get discarded)
- ~$0.05-0.20/experiment, ~$5-10 for 50 experiments
- ~12 experiments/hour at a 5-minute eval budget

## After Creating a Program

Always run validate_measurement to verify the measurement script works and check variance (CV%).`

    return text(guide)
  },
)

// ---------------------------------------------------------------------------
// Tool: create_program
// ---------------------------------------------------------------------------

const QualityGateSchema = z.object({
  min: z.number().optional().describe("Minimum threshold (experiment discarded if below)"),
  max: z.number().optional().describe("Maximum threshold (experiment discarded if above)"),
}).describe("At least one of min or max required")

const SecondaryMetricSchema = z.object({
  direction: z.enum(["lower", "higher"]).describe("Which direction is better"),
})

const ConfigSchema = z.object({
  metric_field: z.string().min(1).describe("Key in measure.sh JSON output to optimize"),
  direction: z.enum(["lower", "higher"]).describe("Which direction is better"),
  noise_threshold: z.number().positive().describe("Minimum relative improvement to keep (decimal: 0.02 = 2%)"),
  repeats: z.number().int().min(1).describe("Measurements per experiment (3 for stable, 5 for noisy)"),
  max_experiments: z.number().int().min(1).describe("Max experiments per run"),
  quality_gates: z.record(z.string(), QualityGateSchema).default({}).describe("Hard pass/fail constraints"),
  secondary_metrics: z.record(z.string(), SecondaryMetricSchema).optional().describe("Advisory metrics (tracked, not gating)"),
  max_consecutive_discards: z.number().int().min(1).optional().describe("Auto-stop after N consecutive non-improving experiments"),
  measurement_timeout: z.number().int().min(1000).optional().describe("Timeout in ms for each measure.sh run"),
  build_timeout: z.number().int().min(1000).optional().describe("Timeout in ms for build.sh"),
  max_cost_usd: z.number().positive().optional().describe("Cost cap per run in USD"),
  max_turns: z.number().int().min(1).optional().describe("Max agent turns per experiment"),
  keep_simplifications: z.boolean().optional().describe("Keep experiments that simplify code without improving metric"),
  finalize_risk_assessment: z.boolean().optional().describe("Run risk assessment during finalization"),
})

server.registerTool(
  "create_program",
  {
    title: "Create Program",
    description: [
      "Create a new autoresearch program with all required files.",
      "Writes program.md, measure.sh, config.json, and optionally build.sh.",
      "Call get_setup_guide first to understand the artifact formats.",
      "After creating, call validate_measurement to verify it works.",
    ].join(" "),
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .regex(/^[a-z0-9-]+$/, "Must be lowercase letters, numbers, and hyphens only")
        .describe("Program slug (e.g. 'homepage-lcp')"),
      program_md: z.string().min(1).describe("Full contents of program.md"),
      measure_sh: z.string().min(1).describe("Full contents of measure.sh"),
      build_sh: z.string().optional().describe("Full contents of build.sh (optional)"),
      config: ConfigSchema.describe("Program configuration (becomes config.json)"),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ name, program_md, measure_sh, build_sh, config }) => {
    const root = await getProjectRoot(CWD)
    const programDir = getProgramDir(root, name)

    // Check for existing program
    if (await Bun.file(join(programDir, "config.json")).exists()) {
      return errorResult(
        `Program '${name}' already exists. Use update_program to modify it, or choose a different name.`,
      )
    }

    // Validate config through the same validator the rest of the system uses
    try {
      validateProgramConfig(config)
    } catch (err) {
      return errorResult(`Invalid config: ${err}`)
    }

    // Ensure .autoauto directory and .gitignore
    await ensureAutoAutoDir(CWD)

    // Create program directory
    await mkdir(programDir, { recursive: true })

    // Write files (independent, run in parallel)
    await Promise.all([
      Bun.write(join(programDir, "program.md"), program_md),
      writeScript(join(programDir, "measure.sh"), measure_sh),
      ...(build_sh ? [writeScript(join(programDir, "build.sh"), build_sh)] : []),
      Bun.write(join(programDir, "config.json"), JSON.stringify(config, null, 2) + "\n"),
    ])

    return text(
      `Program '${name}' created at .autoauto/programs/${name}/.\n\n` +
        `Files written:\n` +
        `  - program.md\n` +
        `  - measure.sh\n` +
        (build_sh ? `  - build.sh\n` : "") +
        `  - config.json\n\n` +
        `Next step: call validate_measurement to verify the measurement script works and check variance.`,
    )
  },
)

// ---------------------------------------------------------------------------
// Tool: update_program
// ---------------------------------------------------------------------------

server.registerTool(
  "update_program",
  {
    title: "Update Program",
    description:
      "Update specific files in an existing program. Only the provided fields are overwritten.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Program slug"),
      program_md: z.string().optional().describe("New contents of program.md"),
      measure_sh: z.string().optional().describe("New contents of measure.sh"),
      build_sh: z.string().optional().describe("New contents of build.sh"),
      config: ConfigSchema.optional().describe("New config.json contents"),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ name, program_md, measure_sh, build_sh, config }) => {
    const root = await getProjectRoot(CWD)
    const programDir = getProgramDir(root, name)

    if (!(await Bun.file(join(programDir, "config.json")).exists())) {
      return errorResult(`Program '${name}' not found.`)
    }

    const updated: string[] = []

    if (program_md !== undefined) {
      await Bun.write(join(programDir, "program.md"), program_md)
      updated.push("program.md")
    }
    if (measure_sh !== undefined) {
      await writeScript(join(programDir, "measure.sh"), measure_sh)
      updated.push("measure.sh")
    }
    if (build_sh !== undefined) {
      await writeScript(join(programDir, "build.sh"), build_sh)
      updated.push("build.sh")
    }
    if (config !== undefined) {
      try {
        validateProgramConfig(config)
      } catch (err) {
        return errorResult(`Invalid config: ${err}`)
      }
      await Bun.write(join(programDir, "config.json"), JSON.stringify(config, null, 2) + "\n")
      updated.push("config.json")
    }

    if (updated.length === 0) {
      return text("No files were provided to update.")
    }

    return text(
      `Updated ${updated.join(", ")} in program '${name}'.\n\n` +
        (updated.includes("measure.sh") || updated.includes("config.json")
          ? "Tip: run validate_measurement to re-check measurement stability."
          : ""),
    )
  },
)

// ---------------------------------------------------------------------------
// Tool: delete_program
// ---------------------------------------------------------------------------

server.registerTool(
  "delete_program",
  {
    title: "Delete Program",
    description:
      "Permanently delete a program and all its runs. Cannot delete a program with an active run.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Program slug"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    }),
    annotations: { destructiveHint: true },
  },
  async ({ name }) => {
    const root = await getProjectRoot(CWD)
    const programDir = getProgramDir(root, name)

    if (!(await Bun.file(join(programDir, "config.json")).exists())) {
      return errorResult(`Program '${name}' not found.`)
    }

    try {
      await deleteProgram(root, name)
    } catch (err) {
      return errorResult(`${err instanceof Error ? err.message : String(err)}`)
    }

    return text(`Program '${name}' and all its runs have been deleted.`)
  },
)

// ---------------------------------------------------------------------------
// Tool: validate_measurement
// ---------------------------------------------------------------------------

server.registerTool(
  "validate_measurement",
  {
    title: "Validate Measurement",
    description: [
      "Run the measurement validation script for a program.",
      "Creates a temporary git worktree, runs build.sh + measure.sh multiple times,",
      "and reports CV%, assessment (deterministic/excellent/acceptable/noisy/unstable),",
      "and recommended config values.",
    ].join(" "),
    inputSchema: z.object({
      name: z.string().min(1).describe("Program slug"),
      runs: z.number().int().min(1).max(20).default(5).describe("Number of measurement runs (default 5)"),
    }),
  },
  async ({ name, runs }) => {
    const root = await getProjectRoot(CWD)
    const programDir = getProgramDir(root, name)
    const measureSh = join(programDir, "measure.sh")
    const configJson = join(programDir, "config.json")

    if (!(await Bun.file(measureSh).exists())) {
      return errorResult(`Program '${name}' not found or missing measure.sh.`)
    }

    try {
      const proc = Bun.spawn(
        ["bun", "run", VALIDATE_SCRIPT, measureSh, configJson, String(runs)],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      )

      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])

      const exitCode = await proc.exited

      if (exitCode !== 0 && !stdout.trim()) {
        return errorResult(`Validation script exited with code ${exitCode}\n\nstderr:\n${stderr}`)
      }

      if (!stdout.trim()) {
        return errorResult(`Validation produced no output.\n\nstderr:\n${stderr}`)
      }

      let result: unknown
      try {
        result = JSON.parse(stdout)
      } catch {
        return errorResult(`Validation output was not valid JSON:\n${stdout}\n\nstderr:\n${stderr}`)
      }

      // Return the structured result plus stderr progress
      return jsonText({
        validation: result,
        ...(stderr.trim() ? { progress_log: stderr.trim() } : {}),
      })
    } catch (err) {
      return errorResult(`Validation failed: ${err}`)
    }
  },
)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startMcpServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // All logging must go to stderr — stdout is the MCP protocol channel
  console.error(`AutoAuto MCP server running (cwd: ${CWD})`)
}

// Direct execution
if (import.meta.main) {
  startMcpServer().catch((err) => {
    console.error("Fatal:", err)
    process.exit(1)
  })
}
