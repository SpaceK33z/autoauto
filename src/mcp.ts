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

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { join } from "node:path"
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
import {
  listRuns,
  isRunActive,
  deleteProgram,
  readState,
  readAllResults,
  parseTsvRows,
  getRunStats,
  getLatestRun,
  type RunState,
} from "./lib/run.ts"
import {
  spawnDaemon as _spawnDaemon,
  getDaemonStatus as _getDaemonStatus,
  sendStop as _sendStop,
  sendAbort as _sendAbort,
  forceKillDaemon as _forceKillDaemon,
  findActiveRun as _findActiveRun,
  updateMaxExperiments as _updateMaxExperiments,
  readGuidance,
  writeGuidance,
} from "./lib/daemon-client.ts"

/** Daemon function overrides for testing (avoids process-wide mock.module). */
export interface McpDaemonDeps {
  spawnDaemon: typeof _spawnDaemon
  getDaemonStatus: typeof _getDaemonStatus
  sendStop: typeof _sendStop
  sendAbort: typeof _sendAbort
  forceKillDaemon: typeof _forceKillDaemon
  findActiveRun: typeof _findActiveRun
  updateMaxExperiments: typeof _updateMaxExperiments
}
import {
  loadProjectConfig,
  saveProjectConfig,
  configExists,
  NOTIFICATION_PRESET_IDS,
  PROVIDER_CHOICES,
  type ProjectConfig,
  type ModelSlot,
} from "./lib/config.ts"
import { streamLogName } from "./lib/daemon-callbacks.ts"
import { formatRunDuration, formatChangePct } from "./lib/format.ts"
import { generateSummaryReport, saveFinalizeReport } from "./lib/finalize.ts"
import { getSelfCommand } from "./lib/self-command.ts"
import {
  deleteSession as deleteAgentSession,
  listSessions as listAgentSessions,
  loadSession as loadAgentSession,
  sendSessionMessage,
  startSetupSession,
  startUpdateSession,
} from "./lib/mcp-agent-sessions.ts"
import { getProvider } from "./lib/agent/index.ts"
import { registerDefaultProviders } from "./lib/agent/default-providers.ts"
import { SandboxRunBackend } from "./lib/run-backend/sandbox.ts"
import { getContainerProviderFactory, registerDefaultContainerProviders, lookupContainerByInfo } from "./lib/container-provider/index.ts"
import type { ContainerProvider } from "./lib/container-provider/types.ts"
import { AUTOAUTO_VERSION } from "./version.ts"

// ---------------------------------------------------------------------------
// CWD resolution
// ---------------------------------------------------------------------------

function resolveCwd(): string {
  const idx = process.argv.indexOf("--cwd")
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  return process.cwd()
}

/** Reusable slug schema — prevents path traversal via names like "../../etc" */
const SlugSchema = z.string().min(1).regex(/^[a-z0-9-]+$/, "Must be lowercase letters, numbers, and hyphens only")
const RunIdSchema = z.string().regex(/^[A-Za-z0-9._-]+$/, "Invalid run_id format")

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

function getProviderOrError(provider: typeof PROVIDER_CHOICES[number]) {
  try {
    return { provider: getProvider(provider), error: null }
  } catch (err) {
    return {
      provider: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path)
  if (await f.exists()) return f.text()
  return null
}

async function readProgramFiles(programDir: string) {
  const [programMd, measureSh, buildSh] = await Promise.all([
    readFileOrNull(join(programDir, "program.md")),
    readFileOrNull(join(programDir, "measure.sh")),
    readFileOrNull(join(programDir, "build.sh")),
  ])
  return { programMd, measureSh, buildSh }
}

async function resolveRunDir(
  programDir: string,
  runId?: string,
): Promise<{ runDir: string; runId: string }> {
  if (runId) {
    const runDir = join(programDir, "runs", runId)
    const hasState = await Bun.file(join(runDir, "state.json")).exists()
    const hasSandbox = !hasState && await Bun.file(join(runDir, "sandbox.json")).exists()
    if (!hasState && !hasSandbox) {
      throw new Error(`Run "${runId}" not found.`)
    }
    return { runDir, runId }
  }

  const latest = await getLatestRun(programDir)
  if (!latest) throw new Error("No runs found.")
  return { runDir: latest.run_dir, runId: latest.run_id }
}

async function writeScript(path: string, content: string): Promise<void> {
  await Bun.write(path, content)
  await chmod(path, 0o755)
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/** Create an MCP server instance bound to the given project root. */
export function createMcpServer(cwd: string, daemonDeps?: Partial<McpDaemonDeps>): McpServer {
  registerDefaultProviders()
  registerDefaultContainerProviders()

  const spawnDaemon = daemonDeps?.spawnDaemon ?? _spawnDaemon
  const getDaemonStatus = daemonDeps?.getDaemonStatus ?? _getDaemonStatus
  const sendStop = daemonDeps?.sendStop ?? _sendStop
  const sendAbort = daemonDeps?.sendAbort ?? _sendAbort
  const forceKillDaemon = daemonDeps?.forceKillDaemon ?? _forceKillDaemon
  const findActiveRun = daemonDeps?.findActiveRun ?? _findActiveRun
  const updateMaxExperiments = daemonDeps?.updateMaxExperiments ?? _updateMaxExperiments

  const REMOTE_WORKSPACE = "/workspace"
  const _decoder = new TextDecoder()

  interface SandboxConnection {
    provider: ContainerProvider
    remoteRunDir: string
  }

  /** Connect to an active sandbox container for a run. Returns null if not a sandbox run or container is dead. */
  async function connectToSandbox(runDir: string): Promise<SandboxConnection | null> {
    try {
      const info = await Bun.file(join(runDir, "sandbox.json")).json() as { provider?: string; program_slug?: string; run_id?: string }
      const handle = await lookupContainerByInfo(info)
      if (!handle) return null

      const provider = await handle.attach()
      const remoteRunDir = [REMOTE_WORKSPACE, ".autoauto", "programs", info.program_slug, "runs", info.run_id].join("/")
      return { provider, remoteRunDir }
    } catch {
      return null
    }
  }

  /** Read a text file from a run — tries sandbox container first, then local filesystem. */
  async function readRunFile(runDir: string, filename: string, sandbox: SandboxConnection | null): Promise<string | null> {
    if (sandbox) {
      try {
        const bytes = await sandbox.provider.readFile(`${sandbox.remoteRunDir}/${filename}`)
        return _decoder.decode(bytes)
      } catch { /* fall through to local */ }
    }
    const f = Bun.file(join(runDir, filename))
    if (await f.exists()) return f.text()
    return null
  }

  async function resolveProgram(name: string): Promise<{ root: string; programDir: string; programConfig: ProgramConfig }> {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)
    try {
      const programConfig = await loadProgramConfig(programDir)
      return { root, programDir, programConfig }
    } catch {
      throw new Error(`Program '${name}' not found.`)
    }
  }

  const server = new McpServer(
    { name: "autoauto", version: AUTOAUTO_VERSION },
    {
      capabilities: { logging: {}, resources: {} },
      instructions: [
        "AutoAuto manages autoresearch programs — autonomous experiment loops that optimize a single metric on any codebase.",
        "First-time check: Call get_config first. If _meta.is_default_config is true, the user has never configured AutoAuto — guide them to choose execution and support models (set_config), then verify auth (check_auth) for the selected providers before proceeding. Use list_models to show available options.",
        "Setup workflow: (1) get_setup_guide to learn principles and workflow, (2) list_programs to check for duplicates, (3) create_program to write all files (get user confirmation first!), (4) validate_measurement to verify stability, (5) review config with user based on validation results.",
        "Run workflow: (1) start_run to launch an experiment loop (give cost/time estimate first; use backend='docker' or 'modal' for container sandbox runs), (2) get_run_status to check progress, (3) get_run_results to see experiment outcomes, (4) get_experiment_log for agent output on a specific experiment, (5) stop_run to stop when satisfied, (6) get_run_summary for a post-run report.",
        "Management: list_programs for overview, get_program to inspect, update_program to modify, delete_program to remove. Use list_runs to see run history, update_run_limit to change max experiments mid-run, set_guidance to steer the agent's direction.",
        "Resources: read autoauto://setup-guide for the full setup reference (artifact formats, validation procedures, anti-gaming rules, config tuning). Read autoauto://program/{name} for a program's full details.",
      ].join("\n"),
    },
  )

// ---------------------------------------------------------------------------
// Resource: autoauto://setup-guide
// ---------------------------------------------------------------------------

server.registerResource(
  "setup-guide",
  "autoauto://setup-guide",
  {
    description:
      "Full setup reference for creating AutoAuto programs: artifact formats, validation procedures, anti-gaming rules, config tuning, quality gate design, and cost estimates. Read this before creating or updating programs.",
    mimeType: "text/markdown",
  },
  async () => {
    const root = await getProjectRoot(cwd)
    const programsDir = getProgramsDir(root)

    return {
      contents: [
        {
          uri: "autoauto://setup-guide",
          mimeType: "text/markdown",
          text: `# AutoAuto Setup Reference

## Critical Checkpoints

These are mandatory steps that must not be skipped:

1. **User Confirmation**: NEVER create a program without the user's explicit "yes." Present all artifacts (program.md, measure.sh, config.json) as code blocks and ask the user to confirm before calling create_program.
2. **Quality Gates Discussion**: Ask the user what metrics must not regress while optimizing the primary metric. Don't silently set empty quality gates — discuss first, then use empty gates only if the user agrees none are needed.
3. **Config Review After Validation**: After validate_measurement returns CV% and recommendations, present the recommended config changes to the user and get approval before updating. Never silently leave config at defaults.
4. **Cost/Time Estimate**: Before calling start_run, tell the user: expected cost (~$0.05-0.20/experiment), time (~12 experiments/hour at 5-min eval), and keep rate (5-25% is normal). Get acknowledgment.

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
- measure.sh can write \`.autoauto-diagnostics\` sidecar file for rich context to the agent

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
  "max_experiments": 10,
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
- \`max_experiments\`: Cap per run (10 default for new programs — start small to validate, scale up later)
- \`quality_gates\`: Hard pass/fail constraints — experiment discarded if gate fails
- \`secondary_metrics\`: Advisory metrics tracked but not gating (direction required)
- \`max_consecutive_discards\`: (optional) Auto-stop after N consecutive non-improving experiments (default 10)
- \`measurement_timeout\`: (optional) Timeout in ms for each measure.sh run (default 60000)
- \`build_timeout\`: (optional) Timeout in ms for build.sh (default 600000)
- \`max_cost_usd\`: (optional) Cost cap per run

## Quality Gate Design

- Suggest gates based on what could realistically break when optimizing the primary metric
- Test pass rate is a common default gate: \`"test_pass_rate": { "min": 1.0 }\`
- Keep gates focused — too many gates leads to "checklist gaming"
- Prefer binary pass/fail over threshold-based gates
- Not every program needs gates — say so if none are needed, but always discuss it

## Anti-Gaming Rules

Think about how the agent could game the metric and add rules against it:
- Bundle size → agent might delete features or replace libraries with stubs
- Test coverage → agent might add trivial tests
- Latency → agent might remove error handling or validation
- Line count → agent might minify code or remove comments
- Performance benchmarks → agent might optimize only for the benchmark input shape (won't generalize)

## Validation Interpretation

After running validate_measurement, interpret the CV% results:

| CV% | Assessment | Recommended Config |
|-----|-----------|-------------------|
| < 1% | Deterministic | noise_threshold=0.01, repeats=1 (but use repeats=3 minimum for tool-based metrics like benchmarks) |
| 1-5% | Excellent | noise_threshold=0.02, repeats=3 |
| 5-15% | Acceptable | noise_threshold=max(CV%*1.5/100, 0.05), repeats=5 |
| 15-30% | Noisy | noise_threshold=max(CV%*2/100, 0.10), repeats=7. Try to reduce noise first. |
| >= 30% | Unstable | Do NOT proceed — fix the measurement first |

**Important**: noise_threshold must EXCEED the noise floor. Never set it lower than the observed CV%.

### Discrete & Near-Ceiling Metrics

If the metric is near its theoretical max/min (e.g., Lighthouse score at 98/100), the smallest possible improvement is a tiny percentage. Calculate: \`minimum_step / baseline_value\`. Set noise_threshold to at most HALF that ratio.

Example: Lighthouse composite at 98 → minimum improvement is 1/98 ≈ 1.02% → noise_threshold ≤ 0.005. Use repeats ≥ 3.

## Common Noise Causes & Fixes

1. **Cold starts** — First run is slower. Fix: add warmup run in measure.sh.
2. **Background processes** — CPU contention. Fix: close resource-heavy apps or measure relative to baseline.
3. **Network calls** — Variable latency. Fix: mock or cache external calls.
4. **Non-deterministic code** — Random seeds, shuffled data. Fix: lock seeds, fix ordering.
5. **Caching** — First run populates caches. Fix: always warm or always clear cache.
6. **Shared state** — Previous run affects next. Fix: clean up between runs.
7. **Short measurement duration** — Timer resolution issues. Fix: increase sample size.

## Config Tuning After Validation

Based on validation results, update these config values:

- \`noise_threshold\`: Set based on CV% table above. Present to user with reasoning.
- \`repeats\`: Set based on CV% table. More repeats = more reliable but slower.
- \`measurement_timeout\`: Validation output includes \`recommended_timeout\` (3x avg duration, floor 60s). Set this when measurements take >15s average.
- \`max_consecutive_discards\`: Fast/cheap measurements → 10-15. Slow/expensive → 5-8. Noisy (CV% 10%+) → 12-15.
- \`max_experiments\`: 10 default for new programs. The first run is a dry run — validate measurement, scope, and agent behavior before scaling up. Users can increase to 30-50+ from the pre-run screen once validated.

## Cost & Time Expectations

Share these with the user before starting a run:
- 5-25% keep rate is normal (most experiments get discarded)
- High revert rates map the search ceiling — they're information, not waste
- ~$0.05-0.20/experiment, ~$5-10 for 50 experiments
- ~12 experiments/hour at a 5-minute eval budget; cached evals push much higher
- When keep rate drops to 0% for 10+ experiments, the target likely has no remaining headroom`,
        },
      ],
    }
  },
)

// ---------------------------------------------------------------------------
// Resource: autoauto://program/{name}
// ---------------------------------------------------------------------------

server.registerResource(
  "program",
  new ResourceTemplate("autoauto://program/{name}", {
    list: async () => {
      const root = await getProjectRoot(cwd)
      const programs = await loadProgramSummaries(root)
      return {
        resources: programs.map((p) => ({
          uri: `autoauto://program/${p.slug}`,
          name: p.slug,
          description: p.goal,
          mimeType: "text/markdown",
        })),
      }
    },
  }),
  {
    description: "Full details of an autoresearch program: program.md, config.json, measure.sh, and build.sh.",
    mimeType: "text/markdown",
  },
  async (uri, { name }) => {
    const slug = SlugSchema.parse(name)
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, slug)

    let config: ProgramConfig
    try {
      config = await loadProgramConfig(programDir)
    } catch {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: `Program '${slug}' not found.`,
          },
        ],
      }
    }

    const { programMd, measureSh, buildSh } = await readProgramFiles(programDir)

    const sections = [
      `# Program: ${name}`,
      "",
      "## program.md",
      programMd ?? "(not found)",
      "",
      "## config.json",
      "```json",
      JSON.stringify(config, null, 2),
      "```",
      "",
      "## measure.sh",
      "```bash",
      measureSh ?? "(not found)",
      "```",
    ]

    if (buildSh) {
      sections.push("", "## build.sh", "```bash", buildSh, "```")
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: sections.join("\n"),
        },
      ],
    }
  },
)

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ModelSlotSchema = z.object({
  provider: z.enum(PROVIDER_CHOICES),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "max"]),
})

const PartialProjectConfigSchema = z.object({
  executionModel: ModelSlotSchema.optional(),
  supportModel: ModelSlotSchema.optional(),
  executionFallbackModel: z.union([ModelSlotSchema, z.null()]).optional(),
  ideasBacklogEnabled: z.boolean().optional(),
  notificationPreset: z.enum(NOTIFICATION_PRESET_IDS).optional(),
  notificationCommand: z.union([z.string(), z.null()]).optional(),
})

function mergeProjectConfig(current: ProjectConfig, patch: z.infer<typeof PartialProjectConfigSchema>): ProjectConfig {
  return {
    ...current,
    ...patch,
    executionModel: patch.executionModel ?? current.executionModel,
    supportModel: patch.supportModel ?? current.supportModel,
    executionFallbackModel: patch.executionFallbackModel !== undefined
      ? patch.executionFallbackModel
      : current.executionFallbackModel,
  }
}

server.registerTool(
  "get_config",
  {
    title: "Get Config",
    description: "Get the project configuration used for execution, setup/update, fallback, ideas backlog, and notifications.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => {
    const root = await getProjectRoot(cwd)
    const [config, exists] = await Promise.all([
      loadProjectConfig(root),
      configExists(root),
    ])
    return jsonText({
      ...config,
      _meta: {
        config_exists: exists,
        is_default_config: !exists,
      },
    })
  },
)

server.registerTool(
  "set_config",
  {
    title: "Set Config",
    description: "Update project configuration fields. Only provided fields are changed.",
    inputSchema: PartialProjectConfigSchema,
  },
  async (patch) => {
    const root = await getProjectRoot(cwd)
    const current = await loadProjectConfig(root)
    const next = mergeProjectConfig(current, patch)
    await saveProjectConfig(root, next)
    return jsonText(next)
  },
)

server.registerTool(
  "list_models",
  {
    title: "List Models",
    description: "List available models for one provider or all providers, including the provider default model when available.",
    inputSchema: z.object({
      provider: z.enum(PROVIDER_CHOICES).optional().describe("Optional provider filter"),
      force_refresh: z.boolean().default(false).describe("Ask the provider to refresh model data"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ provider, force_refresh }) => {
    const root = await getProjectRoot(cwd)
    const providers = provider ? [provider] as const : PROVIDER_CHOICES
    const results = await Promise.all(providers.map(async (providerId) => {
      const resolved = getProviderOrError(providerId)
      if (!resolved.provider) {
        return {
          provider: providerId,
          available: false,
          error: resolved.error,
          default_model: null,
          models: [],
        }
      }

      try {
        const [models, defaultModel] = await Promise.all([
          resolved.provider.listModels?.(root, force_refresh) ?? Promise.resolve([]),
          resolved.provider.getDefaultModel?.(root) ?? Promise.resolve(null),
        ])
        return {
          provider: providerId,
          available: true,
          error: null,
          default_model: defaultModel,
          models: models.map((model) => ({
            provider: model.provider,
            model: model.model,
            label: model.label,
            description: model.description ?? null,
            is_default: model.isDefault ?? false,
          })),
        }
      } catch (err) {
        return {
          provider: providerId,
          available: false,
          error: err instanceof Error ? err.message : String(err),
          default_model: null,
          models: [],
        }
      }
    }))

    return jsonText(provider ? results[0] : results)
  },
)

server.registerTool(
  "check_auth",
  {
    title: "Check Auth",
    description: "Check authentication status for one provider or all providers.",
    inputSchema: z.object({
      provider: z.enum(PROVIDER_CHOICES).optional().describe("Optional provider filter"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ provider }) => {
    const providers = provider ? [provider] as const : PROVIDER_CHOICES
    const results = await Promise.all(providers.map(async (providerId) => {
      const resolved = getProviderOrError(providerId)
      if (!resolved.provider) {
        return {
          provider: providerId,
          available: false,
          authenticated: false,
          error: resolved.error,
          account: null,
        }
      }

      try {
        const auth = await resolved.provider.checkAuth()
        return {
          provider: providerId,
          available: true,
          authenticated: auth.authenticated,
          error: auth.authenticated ? null : auth.error,
          account: auth.authenticated ? auth.account : null,
        }
      } catch (err) {
        return {
          provider: providerId,
          available: false,
          authenticated: false,
          error: err instanceof Error ? err.message : String(err),
          account: null,
        }
      }
    }))

    return jsonText(provider ? results[0] : results)
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
    const root = await getProjectRoot(cwd)
    const programs = await listPrograms(root)
    if (programs.length === 0) return text("No programs found.")

    const summaries = await loadProgramSummaries(root)
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
      name: SlugSchema.describe("Program slug (e.g. 'homepage-lcp')"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)

    let config: ProgramConfig
    try {
      config = await loadProgramConfig(programDir)
    } catch (err) {
      return errorResult(`Program '${name}' not found or invalid config: ${err}`)
    }

    const { programMd, measureSh, buildSh } = await readProgramFiles(programDir)

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
      "Get the setup workflow for creating AutoAuto programs.",
      "Returns key principles, mandatory step-by-step workflow, and config field summary.",
      "For full artifact formats, validation tables, and anti-gaming rules,",
      "read the autoauto://setup-guide resource.",
      "Read this BEFORE calling create_program.",
    ].join(" "),
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => {
    const root = await getProjectRoot(cwd)
    const programsDir = getProgramsDir(root)
    const hasConfig = await configExists(root)

    const firstTimeWarning = hasConfig ? "" : `## ⚠ First-Time Setup Required

No project configuration found. Before creating programs, you must:
1. **Choose models**: Call \`set_config\` with \`executionModel\` (experiment agent — cheaper models like Sonnet work well) and \`supportModel\` (setup/finalize agent — use a smarter model like Opus). Use \`list_models\` to see available options.
2. **Verify authentication**: Call \`check_auth\` to confirm the selected providers are authenticated.

---

`

    const guide = `# AutoAuto Program Setup — Quick Guide

${firstTimeWarning}## What You're Creating

An optimization program: a repeatable experiment loop that an AI agent runs autonomously. Each program has 3-4 files in ${programsDir}/<slug>/:
- **program.md** — Goal, scope, rules, and steps
- **measure.sh** — Outputs a single JSON object with the metric (must be fast, stable, deterministic)
- **build.sh** (optional) — Build/compile step that runs once before measurements
- **config.json** — Metric configuration, quality gates, tuning parameters

## Key Principles

1. **One metric, one direction, one target.** Narrow beats broad — "reduce homepage JS chunk size in bytes" beats "reduce bundle size."
2. **Scope is safety.** The experiment agent will exploit any loophole. Tight scope prevents metric gaming.
3. **Measurement must be fast and stable.** The script runs hundreds of times. Seconds, not minutes.
4. **Binary over sliding scale.** For subjective metrics, prefer binary yes/no criteria over 1-7 scales.

## Mandatory Workflow (follow every step)

### 1. Understand the project
Read the repo structure, config files, build system, and test setup before asking the user anything.

### 2. Discuss goals with the user
Narrow to ONE specific, measurable target. Confirm: metric name, direction (lower/higher), what "good" looks like.

### 3. Define scope and rules
Propose specific file paths. Define what's off-limits. Suggest 3-5 anti-gaming rules.

### 4. Discuss quality gates
Suggest secondary metrics that must not regress (e.g., test pass rate). Not every program needs gates — say so if none are needed, but always discuss it.

### 5. Present artifacts and get user confirmation
Present ALL artifacts (program.md, measure.sh, config.json) as code blocks. **Do NOT call create_program until the user explicitly confirms.** This is a hard requirement.

### 6. Create the program
Call create_program with the confirmed artifacts.

### 7. Validate measurement
Call validate_measurement immediately after creation. Do NOT skip this step.

### 8. Review validation results and update config
Based on CV% results, propose updated noise_threshold and repeats to the user. Update config if needed via update_program. **Do NOT proceed to a run without reviewing validation results with the user.**

### 9. Provide cost/time estimate before starting a run
Before calling start_run, tell the user:
- Estimated cost: ~$0.05-0.20/experiment, ~$5-10 for 50 experiments
- Estimated time: ~12 experiments/hour at 5-minute eval, faster for cached evals
- Expected keep rate: 5-25% is normal (most experiments get discarded)

## config.json Field Summary

- \`metric_field\`: key from measure.sh JSON output
- \`direction\`: "lower" or "higher"
- \`noise_threshold\`: minimum relative improvement (decimal, e.g., 0.02 = 2%)
- \`repeats\`: measurements per experiment (3 for stable, 5 for noisy)
- \`max_experiments\`: cap per run (10 default for new programs)
- \`quality_gates\`: hard pass/fail constraints, e.g., \`{"test_pass_rate": {"min": 1.0}}\`
- \`secondary_metrics\`: advisory tracked metrics (not gating)
- \`max_consecutive_discards\`: (optional) auto-stop after N consecutive non-improving experiments (default 10)
- \`measurement_timeout\`: (optional) timeout in ms for each measure.sh run (default 60000)

For full artifact format templates, validation interpretation tables, anti-gaming rules, config tuning formulas, and measurement debugging tips, read the **autoauto://setup-guide** resource.`

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

// Keep in sync with validateProgramConfig() in programs.ts — both validate config shape
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
  "start_setup_session",
  {
    title: "Start Setup Session",
    description:
      "Start a conversational setup agent session. Use mode='analyze' for ideation or mode='direct' when you already know the target.",
    inputSchema: z.object({
      mode: z.enum(["direct", "analyze"]).describe("Conversation mode"),
      message: z.string().optional().describe("Optional first message for direct mode"),
      focus: z.string().optional().describe("Optional area to focus on for analyze mode"),
      provider: z.enum(["claude", "codex", "opencode"]).optional().describe("Support-model provider override"),
      model: z.string().optional().describe("Support-model name override"),
      effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Support-model effort override"),
    }),
  },
  async ({ mode, message, focus, provider, model, effort }) => {
    try {
      const result = await startSetupSession(cwd, { mode, message, focus, provider, model, effort })
      return jsonText({
        session_id: result.session.id,
        kind: result.session.kind,
        provider: result.session.provider,
        model: result.session.model,
        effort: result.session.effort,
        auto_sent: Boolean(result.firstTurn),
        assistant_message: result.firstTurn?.assistantMessage ?? null,
        tool_events: result.firstTurn?.toolEvents ?? [],
        messages: result.firstTurn?.messages ?? result.session.messages,
      })
    } catch (err) {
      return errorResult(`Failed to start setup session: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
)

server.registerTool(
  "start_update_session",
  {
    title: "Start Update Session",
    description:
      "Start a conversational update agent session for an existing program. Auto-seeds the agent with the latest run context.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      provider: z.enum(["claude", "codex", "opencode"]).optional().describe("Support-model provider override"),
      model: z.string().optional().describe("Support-model name override"),
      effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Support-model effort override"),
    }),
  },
  async ({ name, provider, model, effort }) => {
    try {
      const result = await startUpdateSession(cwd, name, { provider, model, effort })
      return jsonText({
        session_id: result.session.id,
        kind: result.session.kind,
        program_slug: result.session.programSlug,
        provider: result.session.provider,
        model: result.session.model,
        effort: result.session.effort,
        assistant_message: result.firstTurn.assistantMessage,
        tool_events: result.firstTurn.toolEvents,
        messages: result.firstTurn.messages,
      })
    } catch (err) {
      return errorResult(`Failed to start update session: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
)

server.registerTool(
  "send_session_message",
  {
    title: "Send Session Message",
    description:
      "Send a user message to a setup/update session and wait for the agent's next reply.",
    inputSchema: z.object({
      session_id: z.string().min(1).describe("Session ID from start_setup_session or start_update_session"),
      message: z.string().min(1).describe("User message to send"),
    }),
  },
  async ({ session_id, message }) => {
    try {
      const result = await sendSessionMessage(cwd, session_id, message)
      return jsonText({
        session_id,
        assistant_message: result.assistantMessage,
        tool_events: result.toolEvents,
        messages: result.messages,
      })
    } catch (err) {
      return errorResult(`Failed to send session message: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
)

server.registerTool(
  "get_session",
  {
    title: "Get Session",
    description: "Get the current transcript and metadata for a setup/update session.",
    inputSchema: z.object({
      session_id: z.string().min(1).describe("Session ID"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ session_id }) => {
    const session = await loadAgentSession(cwd, session_id)
    if (!session) return errorResult(`Session "${session_id}" not found.`)
    return jsonText({
      session_id: session.id,
      kind: session.kind,
      program_slug: session.programSlug,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      provider: session.provider,
      model: session.model,
      effort: session.effort,
      messages: session.messages,
    })
  },
)

server.registerTool(
  "list_sessions",
  {
    title: "List Sessions",
    description: "List persisted setup/update conversation sessions.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  },
  async () => {
    const sessions = await listAgentSessions(cwd)
    return jsonText(sessions.map((session) => ({
      session_id: session.id,
      kind: session.kind,
      program_slug: session.programSlug,
      updated_at: session.updatedAt,
      provider: session.provider,
      model: session.model,
      effort: session.effort,
      message_count: session.messages.length,
    })))
  },
)

server.registerTool(
  "delete_session",
  {
    title: "Delete Session",
    description: "Delete a persisted setup/update conversation session.",
    inputSchema: z.object({
      session_id: z.string().min(1).describe("Session ID"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    }),
    annotations: { destructiveHint: true },
  },
  async ({ session_id, confirm }) => {
    if (!confirm) return errorResult("Deletion requires confirm=true.")
    const session = await loadAgentSession(cwd, session_id)
    if (!session) return errorResult(`Session "${session_id}" not found.`)
    await deleteAgentSession(cwd, session_id)
    return text(`Session '${session_id}' deleted.`)
  },
)

server.registerTool(
  "create_program",
  {
    title: "Create Program",
    description: [
      "Create a new autoresearch program with all required files.",
      "Writes program.md, measure.sh, config.json, and optionally build.sh.",
      "Call get_setup_guide first for the workflow. Read autoauto://setup-guide for full artifact format reference.",
      "IMPORTANT: Get explicit user confirmation before calling this tool.",
      "After creating, call validate_measurement to verify it works.",
    ].join(" "),
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug (e.g. 'homepage-lcp')"),
      program_md: z.string().min(1).describe("Full contents of program.md"),
      measure_sh: z.string().min(1).describe("Full contents of measure.sh"),
      build_sh: z.string().optional().describe("Full contents of build.sh (optional)"),
      config: ConfigSchema.describe("Program configuration (becomes config.json)"),
    }),
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({ name, program_md, measure_sh, build_sh, config }) => {
    const root = await getProjectRoot(cwd)
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
    await ensureAutoAutoDir(root)

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
      name: SlugSchema.describe("Program slug"),
      program_md: z.string().optional().describe("New contents of program.md"),
      measure_sh: z.string().optional().describe("New contents of measure.sh"),
      build_sh: z.string().optional().describe("New contents of build.sh"),
      config: ConfigSchema.optional().describe("New config.json contents"),
    }),
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ name, program_md, measure_sh, build_sh, config }) => {
    const root = await getProjectRoot(cwd)
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
      name: SlugSchema.describe("Program slug"),
      confirm: z.literal(true).describe("Must be true to confirm deletion"),
    }),
    annotations: { destructiveHint: true },
  },
  async ({ name, confirm }) => {
    if (!confirm) {
      return errorResult("Deletion requires confirm=true.")
    }

    const root = await getProjectRoot(cwd)
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
      "After validation, review results with the user and update config via update_program if needed.",
      "See autoauto://setup-guide for validation interpretation tables.",
    ].join(" "),
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      runs: z.number().int().min(1).max(20).default(5).describe("Number of measurement runs (default 5)"),
    }),
  },
  async ({ name, runs }) => {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)
    const measureSh = join(programDir, "measure.sh")
    const configJson = join(programDir, "config.json")

    if (!(await Bun.file(measureSh).exists())) {
      return errorResult(`Program '${name}' not found or missing measure.sh.`)
    }

    try {
      const validator = getSelfCommand("__validate_measurement")
      const proc = Bun.spawn(
        [validator.command, ...validator.args, measureSh, configJson, String(runs)],
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
// Tool: start_run
// ---------------------------------------------------------------------------

server.registerTool(
  "start_run",
  {
    title: "Start Run",
    description: [
      "Start an experiment run for a program.",
      "Spawns a background daemon that measures a baseline then runs experiments autonomously.",
      "Returns immediately — use get_run_status to poll for progress.",
      "IMPORTANT: Before starting, give the user a cost/time estimate (~$0.05-0.20/experiment, ~12 experiments/hour at 5-min eval).",
      "Use backend='docker' or 'modal' to run in a container sandbox instead of locally.",
    ].join(" "),
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      provider: z.enum(["claude", "codex", "opencode"]).optional().describe("Agent provider (default: from project config)"),
      model: z.string().optional().describe("Model name, e.g. 'sonnet', 'opus' (default: from project config)"),
      effort: z.enum(["low", "medium", "high", "max"]).optional().describe("Effort level (default: from project config)"),
      max_experiments: z.number().int().min(1).optional().describe("Max experiments (default: from program config)"),
      use_worktree: z.boolean().default(true).describe("Use git worktree isolation (default true, ignored for sandbox backends)"),
      carry_forward: z.boolean().default(true).describe("Carry forward results from previous runs (default true)"),
      backend: z.enum(["local", "docker", "modal"]).default("local").describe("Run backend: 'local' (default), 'docker' (local Docker container), or 'modal' (Modal cloud sandbox)"),
    }),
  },
  async ({ name, provider, model, effort, max_experiments, use_worktree, carry_forward, backend }) => {
    let resolved: Awaited<ReturnType<typeof resolveProgram>>
    try {
      resolved = await resolveProgram(name)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
    const { root, programConfig } = resolved

    const projectConfig = await loadProjectConfig(root)
    const modelConfig: ModelSlot = {
      provider: provider ?? projectConfig.executionModel.provider,
      model: model ?? projectConfig.executionModel.model,
      effort: effort ?? projectConfig.executionModel.effort,
    }
    const maxExp = max_experiments ?? programConfig.max_experiments ?? 10

    if (backend === "local") {
      try {
        const result = await spawnDaemon(
          root,
          name,
          modelConfig,
          maxExp,
          projectConfig.ideasBacklogEnabled,
          use_worktree,
          carry_forward,
          "manual",
          programConfig.max_cost_usd,
          programConfig.keep_simplifications,
          projectConfig.executionFallbackModel,
        )

        return jsonText({
          run_id: result.runId,
          backend: "local",
          daemon_pid: result.pid,
          status: "started",
          message: `Run started. Daemon is measuring baseline, then will run up to ${maxExp} experiments. Use get_run_status to check progress.`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Failed to start run: ${msg}`)
      }
    } else {
      // Sandbox backend (docker or modal)
      const factory = getContainerProviderFactory(backend)
      if (!factory) return errorResult(`Container provider '${backend}' is not registered.`)

      const sandboxBackend = new SandboxRunBackend((config) => factory(config ?? {}), backend)
      try {
        const handle = await sandboxBackend.spawn({
          mainRoot: root,
          programSlug: name,
          modelConfig,
          maxExperiments: maxExp,
          ideasBacklogEnabled: projectConfig.ideasBacklogEnabled,
          carryForward: carry_forward,
          source: "manual",
          maxCostUsd: programConfig.max_cost_usd,
          keepSimplifications: programConfig.keep_simplifications,
          fallbackModel: projectConfig.executionFallbackModel,
        })

        return jsonText({
          run_id: handle.runId,
          backend,
          status: "started",
          message: `Sandbox run started in ${backend} container. Daemon is measuring baseline, then will run up to ${maxExp} experiments. Use get_run_status to check progress.`,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return errorResult(`Failed to start sandbox run: ${msg}`)
      }
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: get_run_status
// ---------------------------------------------------------------------------

server.registerTool(
  "get_run_status",
  {
    title: "Get Run Status",
    description:
      "Get the status of the latest (or a specific) run: phase, metrics, progress, cost, and whether the daemon is alive.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      run_id: RunIdSchema.optional().describe("Specific run ID (default: latest)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name, run_id }) => {
    let resolved: Awaited<ReturnType<typeof resolveProgram>>
    try {
      resolved = await resolveProgram(name)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
    const { programDir, programConfig } = resolved

    let runDir: string
    let resolvedRunId: string
    try {
      const r = await resolveRunDir(programDir, run_id)
      runDir = r.runDir
      resolvedRunId = r.runId
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    let state: RunState
    let daemonAlive: boolean

    const sandbox = await connectToSandbox(runDir)
    try {
      if (sandbox) {
        const stateText = await readRunFile(runDir, "state.json", sandbox)
        if (!stateText) {
          return errorResult(`Could not read state for sandbox run "${resolvedRunId}" (container may still be starting).`)
        }
        state = JSON.parse(stateText)
        const exitCode = await sandbox.provider.poll().catch(() => 1)
        daemonAlive = exitCode === null
      } else {
        try {
          state = await readState(runDir)
        } catch {
          return errorResult(`Could not read state for run "${resolvedRunId}".`)
        }
        const active = await findActiveRun(programDir)
        daemonAlive = active?.runId === resolvedRunId && active.daemonAlive
      }
    } finally {
      sandbox?.provider.detach()
    }

    const stats = getRunStats(state, programConfig.direction)
    const isComplete = state.phase === "complete" || state.phase === "crashed"

    return jsonText({
      run_id: resolvedRunId,
      phase: state.phase,
      daemon_alive: daemonAlive,
      ...(sandbox ? { backend: "sandbox" } : {}),
      experiment_number: state.experiment_number,
      metric_field: programConfig.metric_field,
      direction: programConfig.direction,
      original_baseline: state.original_baseline,
      current_baseline: state.current_baseline,
      best_metric: state.best_metric,
      best_experiment: state.best_experiment,
      improvement: formatChangePct(state.original_baseline, state.best_metric, programConfig.direction),
      keeps: stats.total_keeps,
      discards: stats.total_discards,
      crashes: stats.total_crashes,
      keep_rate: `${(stats.keep_rate * 100).toFixed(0)}%`,
      cost_usd: state.total_cost_usd ?? 0,
      elapsed: formatRunDuration(state.started_at, isComplete ? state.updated_at : undefined),
      model: state.model ?? null,
      provider: state.provider ?? null,
      termination_reason: state.termination_reason ?? null,
      error: state.error ?? null,
    })
  },
)

// ---------------------------------------------------------------------------
// Tool: list_runs
// ---------------------------------------------------------------------------

server.registerTool(
  "list_runs",
  {
    title: "List Runs",
    description: "List all runs for a program with summary info (newest first).",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name }) => {
    let resolved: Awaited<ReturnType<typeof resolveProgram>>
    try {
      resolved = await resolveProgram(name)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
    const { programDir, programConfig } = resolved

    const runs = await listRuns(programDir)
    if (runs.length === 0) return text("No runs found.")

    const result = runs.map((r) => {
      const s = r.state
      return {
        run_id: r.run_id,
        phase: s?.phase ?? "unknown",
        experiments: s ? s.total_keeps + s.total_discards + s.total_crashes : 0,
        best_metric: s?.best_metric ?? null,
        change: s
          ? formatChangePct(s.original_baseline, s.best_metric, programConfig.direction)
          : null,
      }
    })
    return jsonText(result)
  },
)

// ---------------------------------------------------------------------------
// Tool: get_run_results
// ---------------------------------------------------------------------------

server.registerTool(
  "get_run_results",
  {
    title: "Get Run Results",
    description:
      "Get the experiment results table for a run: experiment number, status (keep/discard/crash), metric value, change %, commit, and description.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      run_id: RunIdSchema.optional().describe("Specific run ID (default: latest)"),
      limit: z.number().int().min(1).optional().describe("Return only the last N results"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name, run_id, limit }) => {
    let resolved: Awaited<ReturnType<typeof resolveProgram>>
    try {
      resolved = await resolveProgram(name)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
    const { programDir, programConfig } = resolved

    let runDir: string
    let resolvedRunId: string
    try {
      const r = await resolveRunDir(programDir, run_id)
      runDir = r.runDir
      resolvedRunId = r.runId
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    const sandbox = await connectToSandbox(runDir)
    let allResultsRaw: string | null = null
    if (sandbox) {
      try {
        allResultsRaw = await readRunFile(runDir, "results.tsv", sandbox)
      } finally {
        sandbox.provider.detach()
      }
    }
    const allResults = allResultsRaw ? parseTsvRows(allResultsRaw) : await readAllResults(runDir)

    if (allResults.length === 0) {
      return text("No results yet. Run may still be in baseline phase.")
    }

    const originalBaseline =
      allResults.find((r) => r.experiment_number === 0)?.metric_value ?? allResults[0].metric_value

    let results = allResults
    if (limit != null) {
      results = allResults.slice(-limit)
    }

    return jsonText({
      run_id: resolvedRunId,
      metric_field: programConfig.metric_field,
      direction: programConfig.direction,
      total_results: allResults.length,
      results: results.map((r) => ({
        experiment_number: r.experiment_number,
        status: r.status,
        metric_value: r.metric_value,
        change: r.experiment_number === 0
          ? null
          : formatChangePct(originalBaseline, r.metric_value, programConfig.direction),
        commit: r.commit.slice(0, 7),
        description: r.description,
        diff_stats: r.diff_stats ?? null,
        p_value: r.p_value ?? null,
        p_is_minimum: r.p_is_minimum ?? false,
      })),
    })
  },
)

// ---------------------------------------------------------------------------
// Tool: get_experiment_log
// ---------------------------------------------------------------------------

server.registerTool(
  "get_experiment_log",
  {
    title: "Get Experiment Log",
    description:
      "Get the agent's streaming output (thinking, tool use, code changes) for a specific experiment.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      experiment_number: z.union([
        z.number().int().min(0),
        z.literal("latest"),
      ]).describe("Experiment number (0 = baseline) or 'latest'"),
      run_id: RunIdSchema.optional().describe("Specific run ID (default: latest)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name, experiment_number, run_id }) => {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)

    if (!(await Bun.file(join(programDir, "config.json")).exists())) {
      return errorResult(`Program '${name}' not found.`)
    }

    let runDir: string
    try {
      const r = await resolveRunDir(programDir, run_id)
      runDir = r.runDir
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    const sandbox = await connectToSandbox(runDir)
    try {
      let expNum: number
      if (experiment_number === "latest") {
        const resultsText = await readRunFile(runDir, "results.tsv", sandbox)
        const results = resultsText ? parseTsvRows(resultsText) : await readAllResults(runDir)
        if (results.length === 0) return errorResult("No experiments yet.")
        expNum = results[results.length - 1].experiment_number
      } else {
        expNum = experiment_number
      }

      const logContent = await readRunFile(runDir, streamLogName(expNum), sandbox)
      if (logContent == null) {
        return errorResult(`No log found for experiment #${expNum}.`)
      }
      return text(logContent || "(empty log)")
    } finally {
      sandbox?.provider.detach()
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: stop_run
// ---------------------------------------------------------------------------

server.registerTool(
  "stop_run",
  {
    title: "Stop Run",
    description: [
      "Stop the active run for a program.",
      "Default: soft stop — waits for the current experiment to finish.",
      "With abort=true: hard abort — kills agent immediately, records current experiment as crash.",
    ].join(" "),
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      abort: z.boolean().default(false).describe("Hard abort (default: soft stop)"),
    }),
  },
  async ({ name, abort }) => {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)

    const active = await findActiveRun(programDir)
    if (!active) return errorResult(`No active run for '${name}'.`)

    const sandbox = await connectToSandbox(active.runDir)
    if (!active.daemonAlive && !sandbox) return errorResult("Daemon is not running. Run may have already completed.")

    if (sandbox) {
      try {
        const controlJson = JSON.stringify({ action: abort ? "abort" : "stop", timestamp: new Date().toISOString() })
        await sandbox.provider.writeFile(`${sandbox.remoteRunDir}/control.json`, controlJson)

        if (abort) {
          let alive = true
          const deadline = Date.now() + 10_000
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500))
            const exitCode = await sandbox.provider.poll().catch(() => 1)
            if (exitCode !== null) { alive = false; break }
          }
          if (alive) await sandbox.provider.terminate()

          return jsonText({
            action: "abort",
            run_id: active.runId,
            status: "aborted",
            message: "Sandbox run aborted. Current experiment recorded as crash.",
          })
        } else {
          let experimentNum = 0
          try {
            const stateText = await readRunFile(active.runDir, "state.json", sandbox)
            if (stateText) experimentNum = (JSON.parse(stateText) as RunState).experiment_number
          } catch { /* ignore */ }

          return jsonText({
            action: "stop",
            run_id: active.runId,
            status: "stopping",
            message: `Stop signal sent. Experiment #${experimentNum} will finish, then the run will stop. Use get_run_status to check when it's done.`,
          })
        }
      } finally {
        sandbox.provider.detach()
      }
    } else {
      if (abort) {
        await sendAbort(active.runDir)

        let alive = true
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500))
          const status = await getDaemonStatus(active.runDir)
          if (!status.alive) { alive = false; break }
        }
        if (alive) await forceKillDaemon(active.runDir)

        return jsonText({
          action: "abort",
          run_id: active.runId,
          status: "aborted",
          message: "Run aborted. Current experiment recorded as crash.",
        })
      } else {
        await sendStop(active.runDir)

        let experimentNum = 0
        try {
          const state = await readState(active.runDir)
          experimentNum = state.experiment_number
        } catch {}

        return jsonText({
          action: "stop",
          run_id: active.runId,
          status: "stopping",
          message: `Stop signal sent. Experiment #${experimentNum} will finish, then the run will stop. Use get_run_status to check when it's done.`,
        })
      }
    }
  },
)

// ---------------------------------------------------------------------------
// Tool: update_run_limit
// ---------------------------------------------------------------------------

server.registerTool(
  "update_run_limit",
  {
    title: "Update Run Limit",
    description:
      "Update the max experiments cap on an active run. Takes effect at the next iteration boundary.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      max_experiments: z.number().int().min(1).describe("New max experiments value"),
    }),
  },
  async ({ name, max_experiments }) => {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)

    const active = await findActiveRun(programDir)
    if (!active) return errorResult(`No active run for '${name}'.`)

    const sandbox = await connectToSandbox(active.runDir)
    if (!active.daemonAlive && !sandbox) return errorResult("Daemon is not running. Run may have already completed.")

    if (sandbox) {
      try {
        const configPath = `${sandbox.remoteRunDir}/run-config.json`
        const bytes = await sandbox.provider.readFile(configPath)
        const config = JSON.parse(_decoder.decode(bytes))
        config.max_experiments = max_experiments
        await sandbox.provider.writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
      } finally {
        sandbox.provider.detach()
      }
    } else {
      await updateMaxExperiments(active.runDir, max_experiments)
    }

    return jsonText({ run_id: active.runId, max_experiments })
  },
)

// ---------------------------------------------------------------------------
// Tool: set_guidance
// ---------------------------------------------------------------------------

server.registerTool(
  "set_guidance",
  {
    title: "Set Guidance",
    description:
      "Set human steering guidance for an active run. The experiment agent reads this at the start of each iteration and treats it as high-priority direction. Pass empty text to clear guidance.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      text: z.string().max(2000).describe("Guidance text for the experiment agent (empty string to clear, max 2000 chars)"),
    }),
  },
  async ({ name, text: guidanceText }) => {
    const root = await getProjectRoot(cwd)
    const programDir = getProgramDir(root, name)

    const active = await findActiveRun(programDir)
    if (!active) return errorResult(`No active run for '${name}'.`)

    const sandbox = await connectToSandbox(active.runDir)
    if (!active.daemonAlive && !sandbox) return errorResult("Daemon is not running. Run may have already completed.")

    if (sandbox) {
      try {
        await sandbox.provider.writeFile(`${sandbox.remoteRunDir}/guidance.md`, guidanceText.trim())
      } finally {
        sandbox.provider.detach()
      }
    } else {
      await writeGuidance(active.runDir, guidanceText)
    }

    const trimmed = guidanceText.trim()
    if (!trimmed) {
      return text(`Guidance cleared for '${name}'. The next experiment will not receive human guidance.`)
    }
    return text(`Guidance set for '${name}'. The next experiment will include this in its context.`)
  },
)

// ---------------------------------------------------------------------------
// Tool: get_guidance
// ---------------------------------------------------------------------------

server.registerTool(
  "get_guidance",
  {
    title: "Get Guidance",
    description:
      "Get the current human steering guidance for an active or completed run.",
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      run_id: RunIdSchema.optional().describe("Specific run ID (default: latest)"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ name, run_id }) => {
    let resolved: Awaited<ReturnType<typeof resolveProgram>>
    try {
      resolved = await resolveProgram(name)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    let runDir: string
    let resolvedRunId: string
    try {
      const r = await resolveRunDir(resolved.programDir, run_id)
      runDir = r.runDir
      resolvedRunId = r.runId
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    let guidance: string
    const sandbox = await connectToSandbox(runDir)
    if (sandbox) {
      const guidanceText = await readRunFile(runDir, "guidance.md", sandbox)
      sandbox.provider.detach()
      guidance = guidanceText?.trim() ?? ""
    } else {
      guidance = await readGuidance(runDir)
    }

    return jsonText({
      run_id: resolvedRunId,
      has_guidance: guidance.length > 0,
      guidance: guidance || null,
    })
  },
)

// ---------------------------------------------------------------------------
// Tool: get_run_summary
// ---------------------------------------------------------------------------

server.registerTool(
  "get_run_summary",
  {
    title: "Get Run Summary",
    description: [
      "Get a summary report for a completed run.",
      "Returns the existing summary if available, or generates a stats-based summary with generate=true.",
      "Only completed or crashed runs can have summaries generated.",
    ].join(" "),
    inputSchema: z.object({
      name: SlugSchema.describe("Program slug"),
      run_id: RunIdSchema.optional().describe("Specific run ID (default: latest)"),
      generate: z.boolean().default(false).describe("Generate stats summary if none exists (only for completed/crashed runs)"),
    }),
    annotations: { readOnlyHint: false },
  },
  async ({ name, run_id, generate }) => {
    let resolved: Awaited<ReturnType<typeof resolveProgram>>
    try {
      resolved = await resolveProgram(name)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
    const { programDir, programConfig } = resolved

    let runDir: string
    let resolvedRunId: string
    try {
      const r = await resolveRunDir(programDir, run_id)
      runDir = r.runDir
      resolvedRunId = r.runId
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    const sandbox = await connectToSandbox(runDir)
    try {
      const summaryText = await readRunFile(runDir, "summary.md", sandbox)
      const stateText = await readRunFile(runDir, "state.json", sandbox)

      if (summaryText) {
        if (!stateText) return errorResult(`Could not read state for run "${resolvedRunId}".`)
        const state = JSON.parse(stateText) as RunState
        const stats = getRunStats(state, programConfig.direction)
        return jsonText({
          run_id: resolvedRunId,
          has_summary: true,
          generated: false,
          summary: summaryText,
          stats: {
            total_experiments: stats.total_experiments,
            total_keeps: stats.total_keeps,
            improvement_pct: stats.improvement_pct,
          },
        })
      }

      if (generate) {
        if (!stateText) return errorResult(`Could not read state for run "${resolvedRunId}".`)
        const state = JSON.parse(stateText) as RunState

        if (state.phase !== "complete" && state.phase !== "crashed") {
          return errorResult("Can only generate summary for completed or crashed runs.")
        }

        const resultsText = await readRunFile(runDir, "results.tsv", sandbox)
        const results = resultsText ? parseTsvRows(resultsText) : await readAllResults(runDir)
        const generatedSummary = generateSummaryReport(state, results, programConfig, "")
        await saveFinalizeReport(runDir, generatedSummary)

        const stats = getRunStats(state, programConfig.direction)
        return jsonText({
          run_id: resolvedRunId,
          has_summary: true,
          generated: true,
          summary: generatedSummary,
          stats: {
            total_experiments: stats.total_experiments,
            total_keeps: stats.total_keeps,
            improvement_pct: stats.improvement_pct,
          },
        })
      }

      return jsonText({
        run_id: resolvedRunId,
        has_summary: false,
        generated: false,
        summary: null,
        stats: null,
        hint: "Use generate=true to create a stats summary for completed runs.",
      })
    } finally {
      sandbox?.provider.detach()
    }
  },
)

  return server
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startMcpServer() {
  const cwd = resolveCwd()
  const server = createMcpServer(cwd)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // All logging must go to stderr — stdout is the MCP protocol channel
  console.error(`AutoAuto MCP server running (cwd: ${cwd})`)
}

// Direct execution
if (import.meta.main) {
  await startMcpServer()
}
