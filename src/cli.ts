import { join } from "node:path"
import {
  listPrograms,
  loadProgramConfig,
  getProgramDir,
  getProjectRoot,
  extractGoal,
  type ProgramConfig,
} from "./lib/programs.ts"
import {
  spawnDaemon,
  getDaemonStatus,
  sendStop,
  sendAbort,
  forceKillDaemon,
  findActiveRun,
  updateMaxExperiments,
} from "./lib/daemon-client.ts"
import {
  getLatestRun,
  listRuns,
  readAllResults,
  readState,
  getRunStats,
  deleteRun,
  deleteProgram,
  isRunActive,
  type RunState,
} from "./lib/run.ts"
import {
  loadProjectConfig,
  saveProjectConfig,
  formatModelLabel,
  isEffortConfigurable,
  getEffortChoicesForSlot,
  NOTIFICATION_PRESET_IDS,
  PROVIDER_CHOICES,
  type ModelSlot,
  type EffortLevel,
  type NotificationPreset,
} from "./lib/config.ts"
import { generateSummaryReport, saveFinalizeReport } from "./lib/finalize.ts"
import { streamLogName } from "./lib/daemon-callbacks.ts"
import { closeProviders, type AgentProviderID } from "./lib/agent/index.ts"
import { registerDefaultProviders } from "./lib/agent/default-providers.ts"
import {
  assertCompatibleModelSlot,
  getDefaultModel,
  resolveCompatibleModelSlot,
} from "./lib/model-options.ts"
import { formatShellError } from "./lib/git.ts"
import { formatRunDuration, formatChangePct, formatStatusWithP } from "./lib/format.ts"
import {
  readQueue,
  appendToQueue,
  removeFromQueue,
  clearQueue,
  startNextFromQueue,
} from "./lib/queue.ts"
import { getSelfCommand } from "./lib/self-command.ts"
import { AUTOAUTO_VERSION } from "./version.ts"

// --- Arg Parsing ---

interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0]
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith("--")) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith("--")) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

function getFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key]
  return typeof val === "string" ? val : undefined
}

function hasFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return key in flags
}

// --- Output Helpers ---

function out(text: string) {
  process.stdout.write(text + "\n")
}

function outJson(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n")
}

function die(message: string, code = 1): never {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(code)
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length)
}

function formatCost(usd: number | undefined): string {
  if (usd == null) return "$0.00"
  return `$${usd.toFixed(2)}`
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const n = parseInt(value, 10)
  return n >= 1 ? n : null
}

function parseProvider(value: string | undefined): AgentProviderID | null {
  if (!value) return null
  return PROVIDER_CHOICES.includes(value as AgentProviderID) ? (value as AgentProviderID) : null
}

// --- Resolve common context ---

async function resolveRoot(flags: Record<string, string | boolean>): Promise<string> {
  const cwd = getFlag(flags, "cwd") ?? process.cwd()
  return getProjectRoot(cwd)
}

async function resolveRunDir(
  programDir: string,
  flags: Record<string, string | boolean>,
): Promise<{ runDir: string; runId: string }> {
  const runId = getFlag(flags, "run")
  if (runId) {
    const runDir = join(programDir, "runs", runId)
    try {
      await readState(runDir)
    } catch {
      die(`Run "${runId}" not found.`)
    }
    return { runDir, runId }
  }

  const latest = await getLatestRun(programDir)
  if (!latest) die(`No runs found. Start one with: autoauto start <slug>`)
  return { runDir: latest.run_dir, runId: latest.run_id }
}

/** Resolve model config from CLI flags + project config defaults. */
async function resolveModelConfig(
  root: string,
  flags: Record<string, string | boolean>,
): Promise<ModelSlot> {
  const projectConfig = await loadProjectConfig(root)

  const providerFlag = getFlag(flags, "provider")
  const parsedProvider = parseProvider(providerFlag)
  if (providerFlag && !parsedProvider) die(`Invalid --provider: "${providerFlag}". Use claude, opencode, or codex.`)

  const explicitModel = getFlag(flags, "model")
  const provider: AgentProviderID = parsedProvider ?? (explicitModel ? "claude" : projectConfig.executionModel.provider)
  if (provider === "opencode" && hasFlag(flags, "effort")) {
    die("--effort is not supported with --provider opencode yet.")
  }

  let model = explicitModel
  if (!model) {
    if (provider === projectConfig.executionModel.provider) {
      model = projectConfig.executionModel.model
    } else if (provider === "opencode") {
      model = await getDefaultModel("opencode", root) ?? undefined
      if (!model) die("No connected OpenCode models found. Run `opencode auth login` or `/connect` first.")
    } else if (provider === "codex") {
      model = await getDefaultModel("codex", root) ?? undefined
      if (!model) die("Could not resolve Codex default model.")
    } else {
      model = "sonnet"
    }
  }
  if (!model) die("Could not resolve model.")

  const slot: ModelSlot = {
    provider,
    model,
    effort: provider !== "opencode"
      ? ((getFlag(flags, "effort") as EffortLevel) ?? projectConfig.executionModel.effort)
      : projectConfig.executionModel.effort,
  }

  if (explicitModel) {
    await assertCompatibleModelSlot(slot, root)
    return slot
  }

  return await resolveCompatibleModelSlot(slot, root)
}

/** Resolve max experiments from --max-experiments flag or program config default. */
function resolveMaxExperiments(flags: Record<string, string | boolean>, programConfig: ProgramConfig): number {
  const maxExperimentsStr = getFlag(flags, "max-experiments")
  if (maxExperimentsStr == null) return programConfig.max_experiments ?? 10
  const parsed = parsePositiveInt(maxExperimentsStr)
  if (parsed == null) die(`Invalid --max-experiments: "${maxExperimentsStr}". Must be a positive integer.`)
  return parsed
}

/** Resolve ideas-backlog setting from flags or project config default. */
async function resolveIdeasBacklog(root: string, flags: Record<string, string | boolean>): Promise<boolean> {
  if (hasFlag(flags, "no-ideas-backlog")) return false
  if (hasFlag(flags, "ideas-backlog")) return true
  const projectConfig = await loadProjectConfig(root)
  return projectConfig.ideasBacklogEnabled
}

// --- Commands ---

async function cmdList(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto list")
    out("")
    out("List all programs with status, last run, and best metric.")
    out("")
    out("Flags:")
    out("  --json    Output as JSON")
    out("  --cwd     Override working directory")
    return
  }

  const root = await resolveRoot(args.flags)
  const programs = await listPrograms(root)
  const json = hasFlag(args.flags, "json")

  if (programs.length === 0) {
    if (json) {
      outJson([])
    } else {
      out("No programs found. Create one in the TUI first.")
    }
    return
  }

  const rows: Array<{
    slug: string
    status: string
    last_run_id: string | null
    best_metric: number | null
    best_metric_change: string | null
    metric_field: string
    direction: string
    goal: string
  }> = []

  for (const program of programs) {
    const programDir = getProgramDir(root, program.name)
    let config: ProgramConfig | null = null
    try {
      config = await loadProgramConfig(programDir)
    } catch {
      // Skip programs with broken config
    }

    const active = await findActiveRun(programDir)
    const latest = await getLatestRun(programDir)
    const status = active?.daemonAlive ? "running" : "idle"

    let goal = ""
    try {
      const md = await Bun.file(join(programDir, "program.md")).text()
      goal = extractGoal(md)
    } catch {}

    let best_metric: number | null = null
    let best_metric_change: string | null = null

    if (latest?.state && config) {
      best_metric = latest.state.best_metric
      const stats = getRunStats(latest.state, config.direction)
      if (stats.improvement_pct !== 0) {
        const sign = stats.improvement_pct > 0 ? "+" : ""
        best_metric_change = `${sign}${stats.improvement_pct.toFixed(1)}%`
      }
    }

    rows.push({
      slug: program.name,
      status,
      last_run_id: latest?.run_id ?? null,
      best_metric,
      best_metric_change,
      metric_field: config?.metric_field ?? "unknown",
      direction: config?.direction ?? "unknown",
      goal,
    })
  }

  if (json) {
    outJson(rows)
    return
  }

  // Human-readable table
  const metricLabel = rows.length > 0 ? `Best (${rows[0].metric_field})` : "Best"
  const header = `${padRight("Program", 20)} ${padRight("Status", 10)} ${padRight("Last Run", 18)} ${metricLabel}`
  out(header)

  for (const row of rows) {
    const metricStr =
      row.best_metric != null
        ? `${row.best_metric}${row.best_metric_change ? ` (${row.best_metric_change})` : ""}`
        : "—"
    out(
      `${padRight(row.slug, 20)} ${padRight(row.status, 10)} ${padRight(row.last_run_id ?? "—", 18)} ${metricStr}`,
    )
  }
}

async function cmdStart(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto start <program-slug>")
    out("")
    out("Start an experiment run. Spawns a background daemon that runs experiments.")
    out("")
    out("Flags:")
    out("  --provider <claude|opencode|codex>  Agent provider")
    out("  --model <name>                      Model name")
    out("  --effort <low|medium|high|max>      Effort level")
    out("  --max-experiments <n>               Max experiments to run")
    out("  --in-place                          Run without worktree isolation")
    out("  --no-carry-forward                  Don't carry forward from previous runs")
    out("  --no-ideas-backlog                  Disable ideas backlog")
    out("  --no-wait                           Don't wait for baseline to complete")
    out("  --sandbox [docker|modal]             Run in container sandbox (default: docker)")
    out("  --json                              Output as JSON")
    out("  --cwd                               Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto start <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")
  const noWait = hasFlag(args.flags, "no-wait")

  // Validate program exists
  let programConfig: ProgramConfig
  try {
    programConfig = await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found. Run \`autoauto list\` to see available programs.`)
  }

  const modelConfig = await resolveModelConfig(root, args.flags)
  const maxExperiments = resolveMaxExperiments(args.flags, programConfig)
  const ideasBacklogEnabled = await resolveIdeasBacklog(root, args.flags)
  const useWorktree = !hasFlag(args.flags, "in-place")
  const carryForward = !hasFlag(args.flags, "no-carry-forward")
  // --sandbox with no value defaults to "docker"; --sandbox docker|modal selects explicitly
  const sandboxFlag = args.flags.sandbox
  const sandboxProvider = sandboxFlag === true ? "docker" : typeof sandboxFlag === "string" ? sandboxFlag : undefined

  // Spawn daemon (local or sandbox)
  let result: { runId: string; runDir: string; worktreePath: string | null; pid: number }
  try {
    if (sandboxProvider) {
      // Validate and check auth for the chosen provider
      if (sandboxProvider === "docker") {
        const { checkDockerAuth } = await import("./lib/container-provider/docker.ts")
        const auth = await checkDockerAuth()
        if (!auth.ok) die(auth.error!)
      } else if (sandboxProvider === "modal") {
        const { checkModalAuth } = await import("./lib/container-provider/modal.ts")
        const auth = checkModalAuth()
        if (!auth.ok) die(auth.error!)
      } else {
        die(`Unknown sandbox provider: "${sandboxProvider}". Use "docker" or "modal".`)
      }

      const { getContainerProviderFactory } = await import("./lib/container-provider/index.ts")
      const factory = getContainerProviderFactory(sandboxProvider)
      if (!factory) die(`${sandboxProvider} provider not registered`)

      const { SandboxRunBackend } = await import("./lib/run-backend/sandbox.ts")
      const backend = new SandboxRunBackend((config) => factory(config ?? {}), sandboxProvider)

      if (!json) out(`Starting ${sandboxProvider} sandbox run for ${slug}...`)
      const handle = await backend.spawn({
        mainRoot: root,
        programSlug: slug,
        modelConfig,
        maxExperiments,
        ideasBacklogEnabled,
        useWorktree: false,
        carryForward,
        source: "manual",
      })
      result = { runId: handle.runId, runDir: handle.runDir, worktreePath: null, pid: 0 }
    } else {
      const projConfig = await loadProjectConfig(root)
      result = await spawnDaemon(root, slug, modelConfig, maxExperiments, ideasBacklogEnabled, useWorktree, carryForward, "manual", undefined, undefined, projConfig.executionFallbackModel)
    }
  } catch (err) {
    const msg = formatShellError(err)
    if (msg.includes("uncommitted changes")) die(msg)
    if (msg.includes("already active")) die(msg)
    die(msg, 2)
  }

  if (noWait) {
    if (json) {
      outJson({ run_id: result.runId, daemon_pid: result.pid, status: "started" })
    } else {
      out(`Started run ${result.runId} for ${slug}`)
      out(`Daemon PID: ${result.pid}`)
      out("")
      out("The daemon is running baseline measurement in the background.")
      out("")
      out("Next steps:")
      out(`  autoauto status ${slug}    # Check progress (baseline first, then experiments)`)
      out(`  autoauto results ${slug}   # View experiment results table`)
      out(`  autoauto stop ${slug}      # Stop after current experiment`)
    }
    return
  }

  // Block until baseline completes (or fails).
  // Detect baseline completion by checking results.tsv for a baseline row (experiment #0).
  // No hard timeout — baselines can be legitimately slow. Daemon death is the exit condition.
  if (!json) out(`Starting run ${result.runId} for ${slug}... waiting for baseline`)

  const pollInterval = 1000

  while (true) {
    await new Promise((r) => setTimeout(r, pollInterval))

    // Check if daemon is still alive
    const status = await getDaemonStatus(result.runDir)
    if (!status.alive && !status.starting) {
      // Daemon died — try to read state for error info
      try {
        const state = await readState(result.runDir)
        if (state.error) die(`Baseline failed: ${state.error}`, 2)
        if (state.phase === "crashed") die("Daemon crashed during baseline.", 2)
      } catch {}
      die("Daemon exited unexpectedly during baseline.", 2)
    }

    // Check for baseline row in results.tsv
    try {
      const results = await readAllResults(result.runDir)
      const baselineRow = results.find((r) => r.experiment_number === 0)
      if (baselineRow) {
        if (json) {
          outJson({
            run_id: result.runId,
            daemon_pid: result.pid,
            baseline_metric: baselineRow.metric_value,
            status: "running",
          })
        } else {
          out(`Started run ${result.runId} for ${slug}`)
          out(`Baseline ${programConfig.metric_field}: ${baselineRow.metric_value} (${programConfig.repeats} measurements)`)
          out("")
          out("Run is now executing experiments in the background.")
          out("")
          out("Next steps:")
          out(`  autoauto status ${slug}    # Check current progress`)
          out(`  autoauto results ${slug}   # View experiment results table`)
          out(`  autoauto stop ${slug}      # Stop after current experiment`)
        }
        return
      }
    } catch {
      // results.tsv not written yet or only header — keep waiting
    }

    // Check if it crashed during baseline
    try {
      const state = await readState(result.runDir)
      if (state.phase === "crashed" || state.phase === "complete") {
        if (state.error) die(`Baseline failed: ${state.error}`, 2)
        die("Run ended before completing baseline.", 2)
      }
    } catch {
      // state.json not written yet — keep waiting
    }
  }
}

async function cmdStatus(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto status <program-slug>")
    out("")
    out("Show run status: phase, metrics, keeps/discards, cost, elapsed time.")
    out("")
    out("Flags:")
    out("  --run <id>   Specific run (default: latest)")
    out("  --all        Show all runs")
    out("  --json       Output as JSON")
    out("  --cwd        Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto status <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")
  const showAll = hasFlag(args.flags, "all")

  // Validate program exists
  let programConfig: ProgramConfig
  try {
    programConfig = await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found.`)
  }

  if (showAll) {
    const runs = await listRuns(programDir)
    if (runs.length === 0) die(`No runs found for "${slug}". Start one with: autoauto start ${slug}`)

    if (json) {
      outJson(
        runs.map((r) => ({
          run_id: r.run_id,
          status: r.state?.phase ?? "unknown",
          experiment_number: r.state?.experiment_number ?? 0,
          best_metric: r.state?.best_metric ?? null,
          best_metric_change:
            r.state
              ? formatChangePct(r.state.original_baseline, r.state.best_metric, programConfig.direction)
              : null,
        })),
      )
      return
    }

    const header = `${padRight("Run", 18)} ${padRight("Status", 12)} ${padRight("Experiments", 13)} Best (${programConfig.metric_field})`
    out(header)
    for (const r of runs) {
      const s = r.state
      const statusStr = s?.phase ?? "unknown"
      const experiments = s ? String(s.total_keeps + s.total_discards + s.total_crashes) : "0"
      const best =
        s && s.best_metric !== 0
          ? `${s.best_metric} (${formatChangePct(s.original_baseline, s.best_metric, programConfig.direction)})`
          : "—"
      out(`${padRight(r.run_id, 18)} ${padRight(statusStr, 12)} ${padRight(experiments, 13)} ${best}`)
    }
    return
  }

  const { runDir, runId } = await resolveRunDir(programDir, args.flags)
  let state: RunState
  try {
    state = await readState(runDir)
  } catch {
    die(`Could not read state for run "${runId}".`)
  }

  const stats = getRunStats(state, programConfig.direction)
  const active = await findActiveRun(programDir)
  const daemonAlive = active?.runId === runId && active.daemonAlive
  const isComplete = state.phase === "complete" || state.phase === "crashed"

  if (json) {
    outJson({
      ...state,
      daemon_alive: daemonAlive,
      elapsed: formatRunDuration(state.started_at, isComplete ? state.updated_at : undefined),
      improvement_pct: stats.improvement_pct,
      keep_rate: stats.keep_rate,
      metric_field: programConfig.metric_field,
      direction: programConfig.direction,
    })
    return
  }

  const dirLabel = programConfig.direction === "lower" ? "lower is better" : "higher is better"
  out(`Program: ${slug} (${programConfig.metric_field}, ${dirLabel})`)
  out(`Run: ${runId}`)

  if (isComplete) {
    const reason =
      state.termination_reason === "aborted"
        ? "aborted"
        : state.termination_reason === "max_experiments"
          ? `reached max experiments (${state.experiment_number})`
          : state.termination_reason === "stagnation"
            ? `stagnation (${state.total_discards} consecutive discards)`
            : state.termination_reason === "budget_exceeded"
              ? `budget exceeded ($${(state.total_cost_usd ?? 0).toFixed(2)})`
              : state.termination_reason === "quota_exhausted"
                ? "provider quota exhausted"
                : state.termination_reason === "stopped"
                ? "stopped by user"
                : state.phase === "crashed"
                  ? "crashed"
                  : "finished"
    out(`Status: ${state.phase} (${reason})`)
    out(
      `Baseline: ${state.original_baseline} → Final best: ${state.best_metric} (${formatChangePct(state.original_baseline, state.best_metric, programConfig.direction)})`,
    )
    out(`Keeps: ${stats.total_keeps} | Discards: ${stats.total_discards} | Crashes: ${stats.total_crashes}`)
    out(`Cost: ${formatCost(state.total_cost_usd)} | Duration: ${formatRunDuration(state.started_at, state.updated_at)}`)
    if (state.error) out(`Error: ${state.error}`)
  } else {
    const phaseDetail =
      state.phase === "agent_running" || state.phase === "measuring"
        ? ` (experiment #${state.experiment_number})`
        : ""
    out(`Status: ${daemonAlive ? "running" : "stale"} ${state.phase}${phaseDetail}`)
    out(
      `Baseline: ${state.original_baseline} → Current best: ${state.best_metric} (${formatChangePct(state.original_baseline, state.best_metric, programConfig.direction)})`,
    )
    out(`Keeps: ${stats.total_keeps} | Discards: ${stats.total_discards} | Crashes: ${stats.total_crashes}`)
    out(`Cost: ${formatCost(state.total_cost_usd)} | Elapsed: ${formatRunDuration(state.started_at)}`)
  }
}

async function cmdResults(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto results <program-slug>")
    out("")
    out("Show experiment results table.")
    out("")
    out("Flags:")
    out("  --run <id>       Specific run (default: latest)")
    out("  --detail <n>     Show detailed log for experiment N (or 'latest')")
    out("  --limit <n>      Show last N results")
    out("  --json           Output as JSON")
    out("  --cwd            Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto results <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")
  const detail = getFlag(args.flags, "detail")
  const limit = getFlag(args.flags, "limit")

  let programConfig: ProgramConfig
  try {
    programConfig = await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found.`)
  }

  const { runDir, runId } = await resolveRunDir(programDir, args.flags)
  const allResults = await readAllResults(runDir)

  if (allResults.length === 0) {
    die("No result rows yet. Run may still be in baseline phase.")
  }

  // Always compute baseline from full results before any slicing
  const originalBaseline = allResults.find((r) => r.experiment_number === 0)?.metric_value ?? allResults[0].metric_value

  // Handle --detail
  if (detail != null) {
    let expNum: number
    if (detail === "latest") {
      expNum = allResults[allResults.length - 1].experiment_number
    } else {
      expNum = parseInt(detail, 10)
      if (isNaN(expNum)) die(`Invalid experiment number: "${detail}"`)
    }

    const result = allResults.find((r) => r.experiment_number === expNum)
    if (!result) die(`Experiment #${expNum} not found in run ${runId}.`)

    const logFile = join(runDir, streamLogName(expNum))
    let logContent = ""
    try {
      logContent = await Bun.file(logFile).text()
    } catch {
      logContent = "(no stream log found)"
    }

    if (json) {
      outJson({
        experiment_number: result.experiment_number,
        status: result.status,
        metric_value: result.metric_value,
        change_pct: result.experiment_number === 0
          ? null
          : formatChangePct(originalBaseline, result.metric_value, programConfig.direction),
        description: result.description,
        log: logContent,
      })
    } else {
      out(logContent)
    }
    return
  }

  // Apply --limit (after baseline computation)
  let results = allResults
  if (limit != null) {
    const n = parsePositiveInt(limit)
    if (n == null) die(`Invalid limit: "${limit}"`)
    results = allResults.slice(-n)
  }

  if (json) {
    outJson(
      results.map((r) => ({
        ...r,
        change_pct:
          r.experiment_number === 0
            ? null
            : formatChangePct(originalBaseline, r.metric_value, programConfig.direction),
      })),
    )
    return
  }

  // Human-readable table
  const metricField = programConfig.metric_field
  const header = `${padRight("#", 5)} ${padRight("Status", 22)} ${padRight(metricField, 14)} ${padRight("Change", 10)} ${padRight("Commit", 10)} Description`
  out(header)

  for (const r of results) {
    const change =
      r.experiment_number === 0
        ? "—"
        : formatChangePct(originalBaseline, r.metric_value, programConfig.direction)
    const num = String(r.experiment_number)
    out(
      `${padRight(num, 5)} ${padRight(formatStatusWithP(r.status, r.p_value, r.p_is_minimum), 22)} ${padRight(String(r.metric_value), 14)} ${padRight(change, 10)} ${padRight(r.commit.slice(0, 7), 10)} ${r.description}`,
    )
  }
}

async function cmdStop(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto stop <program-slug>")
    out("")
    out("Stop the active run. By default, waits for the current experiment to finish.")
    out("")
    out("Flags:")
    out("  --run <id>   Specific run (default: active run)")
    out("  --abort      Abort immediately (don't wait for current experiment)")
    out("  --json       Output as JSON")
    out("  --cwd        Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto stop <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")
  const abort = hasFlag(args.flags, "abort")

  // Find active run (lock-based)
  const runIdOverride = getFlag(args.flags, "run")
  let runDir: string
  let runId: string

  if (runIdOverride) {
    runDir = join(programDir, "runs", runIdOverride)
    runId = runIdOverride
    const status = await getDaemonStatus(runDir)
    if (!status.alive) die("Daemon is not running. Run may have already completed.")
  } else {
    const active = await findActiveRun(programDir)
    if (!active) die(`No active run for "${slug}".`)
    if (!active.daemonAlive) die("Daemon is not running. Run may have already completed.")
    runDir = active.runDir
    runId = active.runId
  }

  if (abort) {
    await sendAbort(runDir)

    // Wait briefly for daemon to exit
    const timeout = 10_000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 500))
      const status = await getDaemonStatus(runDir)
      if (!status.alive) break
    }

    // Force kill if still alive
    const finalStatus = await getDaemonStatus(runDir)
    if (finalStatus.alive) {
      await forceKillDaemon(runDir)
    }

    if (json) {
      outJson({ action: "abort", run_id: runId, status: "aborted" })
    } else {
      out(`Aborting ${slug} run ${runId}...`)
      out("Run aborted. Current experiment recorded as crash.")
    }
  } else {
    await sendStop(runDir)

    let experimentNum = 0
    try {
      const state = await readState(runDir)
      experimentNum = state.experiment_number
    } catch {}

    if (json) {
      outJson({ action: "stop", run_id: runId, status: "stopping" })
    } else {
      out(`Stopping ${slug} run ${runId}...`)
      out(`The current experiment (#${experimentNum}) will finish, then the run will stop.`)
      out(`Use \`autoauto status ${slug}\` to check when it's done.`)
    }
  }
}

async function cmdLimit(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto limit <program-slug> <n>")
    out("")
    out("Update the max experiments cap on an active run.")
    out("")
    out("Flags:")
    out("  --json    Output as JSON")
    out("  --cwd     Override working directory")
    return
  }

  const slug = args.positional[0]
  const valueStr = args.positional[1]
  if (!slug || valueStr == null) die("Usage: autoauto limit <program-slug> <n>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")

  const active = await findActiveRun(programDir)
  if (!active) die(`No active run for "${slug}".`)
  if (!active.daemonAlive) die("Daemon is not running. Run may have already completed.")

  const parsed = parsePositiveInt(valueStr)
  if (parsed == null) die(`Invalid value: "${valueStr}". Must be a positive integer.`)
  const maxExperiments = parsed

  await updateMaxExperiments(active.runDir, maxExperiments)

  if (json) {
    outJson({ run_id: active.runId, max_experiments: maxExperiments })
  } else {
    out(`Updated ${slug} run ${active.runId}: max experiments set to ${maxExperiments}.`)
  }
}

async function cmdQueue(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto queue [list|add|remove|clear]")
    out("")
    out("Manage the run queue.")
    out("")
    out("Subcommands:")
    out("  queue [list]        Show pending queue entries")
    out("  queue add <slug>    Enqueue a run")
    out("  queue remove <id>   Remove a queue entry")
    out("  queue clear         Clear all pending entries")
    out("")
    out("Flags for 'add':")
    out("  --provider <claude|opencode|codex>  Agent provider")
    out("  --model <name>                      Model name")
    out("  --effort <low|medium|high|max>      Effort level")
    out("  --max-experiments <n>               Max experiments")
    out("  --in-place                          Run without worktree isolation")
    out("")
    out("Flags:")
    out("  --json    Output as JSON")
    out("  --cwd     Override working directory")
    return
  }

  const sub = args.positional[0]
  const root = await resolveRoot(args.flags)
  const json = hasFlag(args.flags, "json")

  if (sub === "list" || sub === undefined) {
    const queue = await readQueue(root)

    if (queue.entries.length === 0) {
      if (json) {
        outJson([])
      } else {
        out("Queue is empty.")
      }
      return
    }

    if (json) {
      outJson(queue.entries)
      return
    }

    const header = `${padRight("ID", 5)} ${padRight("Program", 20)} ${padRight("Model", 25)} ${padRight("Max", 6)} ${padRight("Added", 20)} Retries`
    out(header)
    for (const e of queue.entries) {
      const model = `${e.modelConfig.provider}/${e.modelConfig.model}`
      const added = new Date(e.addedAt).toLocaleString()
      out(
        `${padRight(String(e.id), 5)} ${padRight(e.programSlug, 20)} ${padRight(model, 25)} ${padRight(String(e.maxExperiments), 6)} ${padRight(added, 20)} ${e.retryCount}`,
      )
    }
    return
  }

  if (sub === "add") {
    const slug = args.positional[1]
    if (!slug) die("Usage: autoauto queue add <program-slug>")

    const programDir = getProgramDir(root, slug)

    // Validate program exists
    let programConfig: ProgramConfig
    try {
      programConfig = await loadProgramConfig(programDir)
    } catch {
      die(`Program "${slug}" not found. Run \`autoauto list\` to see available programs.`)
    }

    const modelConfig = await resolveModelConfig(root, args.flags)
    const maxExperiments = resolveMaxExperiments(args.flags, programConfig)
    const useWorktree = !hasFlag(args.flags, "in-place")

    const { entry, wasEmpty } = await appendToQueue(root, {
      programSlug: slug,
      modelConfig,
      maxExperiments,
      useWorktree,
    })

    // If queue was empty, kick off the first run
    if (wasEmpty) {
      const ideasBacklogEnabled = await resolveIdeasBacklog(root, args.flags)
      await startNextFromQueue(root, ideasBacklogEnabled)
    }

    if (json) {
      outJson(entry)
    } else {
      out(`Queued ${slug} as #${entry.id} (${modelConfig.provider}/${modelConfig.model}, max ${maxExperiments} experiments)`)
      if (wasEmpty) out("Queue was empty — starting immediately.")
    }
    return
  }

  if (sub === "remove") {
    const idStr = args.positional[1]
    if (!idStr) die("Usage: autoauto queue remove <id>")

    const id = parsePositiveInt(idStr)
    if (id == null) die(`Invalid ID: "${idStr}". Must be a positive integer.`)

    const removed = await removeFromQueue(root, id)
    if (!removed) die(`Queue entry #${id} not found.`)

    if (json) {
      outJson(removed)
    } else {
      out(`Removed #${removed.id} (${removed.programSlug}) from queue.`)
    }
    return
  }

  if (sub === "clear") {
    const cleared = await clearQueue(root)

    if (json) {
      outJson({ cleared: cleared.length })
    } else {
      if (cleared.length === 0) {
        out("Queue was already empty.")
      } else {
        out(`Cleared ${cleared.length} entr${cleared.length === 1 ? "y" : "ies"} from queue.`)
      }
    }
    return
  }

  die(`Unknown queue subcommand: "${sub}". Use: list, add, remove, clear`)
}

async function cmdShow(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto show <program-slug>")
    out("")
    out("Show program details: config, goal, measurement script, run count.")
    out("")
    out("Flags:")
    out("  --json    Output as JSON")
    out("  --cwd     Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto show <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")

  let programConfig: ProgramConfig
  try {
    programConfig = await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found. Run \`autoauto list\` to see available programs.`)
  }

  const [programMdResult, measureResult, buildResult, runs] = await Promise.all([
    Bun.file(join(programDir, "program.md")).text().catch(() => ""),
    Bun.file(join(programDir, "measure.sh")).text()
      .catch(() => Bun.file(join(programDir, "measure")).text())
      .catch(() => ""),
    Bun.file(join(programDir, "build.sh")).text().catch(() => null as string | null),
    listRuns(programDir),
  ])

  const programMd = programMdResult
  const goal = extractGoal(programMd)
  const measureScript = measureResult
  const buildScript = buildResult

  if (json) {
    outJson({
      slug,
      config: programConfig,
      goal,
      program_md: programMd,
      measure_script: measureScript,
      build_script: buildScript,
      run_count: runs.length,
    })
    return
  }

  out(`Program: ${slug}`)
  out("")
  out(`Metric:          ${programConfig.metric_field} (${programConfig.direction} is better)`)
  out(`Noise threshold: ${programConfig.noise_threshold}`)
  out(`Repeats:         ${programConfig.repeats}`)
  out(`Max experiments: ${programConfig.max_experiments}`)

  const gateNames = Object.keys(programConfig.quality_gates)
  if (gateNames.length > 0) {
    out(`Quality gates:   ${gateNames.map((g) => {
      const gate = programConfig.quality_gates[g]
      const parts: string[] = []
      if (gate.min != null) parts.push(`min=${gate.min}`)
      if (gate.max != null) parts.push(`max=${gate.max}`)
      return `${g} (${parts.join(", ")})`
    }).join(", ")}`)
  }

  if (programConfig.measurement_timeout) out(`Measure timeout: ${programConfig.measurement_timeout}ms`)
  if (programConfig.max_cost_usd) out(`Max cost:        $${programConfig.max_cost_usd}`)

  out(`Runs:            ${runs.length}`)

  if (goal) {
    out("")
    out("Goal:")
    out(goal)
  }

  if (measureScript) {
    out("")
    out("Measure script:")
    out(measureScript.trimEnd())
  }

  if (buildScript) {
    out("")
    out("Build script:")
    out(buildScript.trimEnd())
  }
}

async function cmdConfig(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto config [get|set] [key] [value]")
    out("")
    out("Show or update project configuration.")
    out("")
    out("Subcommands:")
    out("  config                       Show all settings")
    out("  config get <key>             Get a specific value")
    out("  config set <key> <value>     Set a specific value")
    out("")
    out("Keys:")
    out("  execution-provider           Agent provider (claude, codex, opencode)")
    out("  execution-model              Model name (sonnet, opus, or full ID)")
    out("  execution-effort             Effort level (low, medium, high, max)")
    out("  support-provider             Support agent provider")
    out("  support-model                Support model name")
    out("  support-effort               Support effort level")
    out("  ideas-backlog                Ideas backlog (true, false)")
    out("  notification-preset          Notification preset (off, macos-notification, macos-say, terminal-bell, custom)")
    out("  notification-command         Custom notification command")
    out("")
    out("Flags:")
    out("  --json    Output as JSON")
    out("  --cwd     Override working directory")
    return
  }

  const sub = args.positional[0]
  const root = await resolveRoot(args.flags)
  const json = hasFlag(args.flags, "json")

  const config = await loadProjectConfig(root)

  // Show all
  if (sub == null) {
    if (json) {
      outJson(config)
      return
    }
    const execLabel = formatModelLabel(config.executionModel)
    const supportLabel = formatModelLabel(config.supportModel)
    out(`Execution:      ${execLabel}`)
    out(`Support:        ${supportLabel}`)
    out(`Ideas backlog:  ${config.ideasBacklogEnabled ? "enabled" : "disabled"}`)
    out(`Notifications:  ${config.notificationPreset}${config.notificationPreset === "custom" && config.notificationCommand ? ` (${config.notificationCommand})` : ""}`)
    return
  }

  const CONFIG_KEYS: Record<string, {
    get: () => string | boolean
    set: (value: string) => void
  }> = {
    "execution-provider": {
      get: () => config.executionModel.provider,
      set: (v) => {
        if (!PROVIDER_CHOICES.includes(v as typeof PROVIDER_CHOICES[number])) {
          die(`Invalid provider: "${v}". Use: ${PROVIDER_CHOICES.join(", ")}`)
        }
        config.executionModel.provider = v as typeof PROVIDER_CHOICES[number]
      },
    },
    "execution-model": {
      get: () => config.executionModel.model,
      set: (v) => { config.executionModel.model = v },
    },
    "execution-effort": {
      get: () => config.executionModel.effort,
      set: (v) => {
        if (!isEffortConfigurable(config.executionModel)) {
          die(`Effort is not configurable for provider "${config.executionModel.provider}".`)
        }
        const choices = getEffortChoicesForSlot(config.executionModel)
        if (!choices.includes(v as EffortLevel)) {
          die(`Invalid effort: "${v}". Use: ${choices.join(", ")}`)
        }
        config.executionModel.effort = v as EffortLevel
      },
    },
    "support-provider": {
      get: () => config.supportModel.provider,
      set: (v) => {
        if (!PROVIDER_CHOICES.includes(v as typeof PROVIDER_CHOICES[number])) {
          die(`Invalid provider: "${v}". Use: ${PROVIDER_CHOICES.join(", ")}`)
        }
        config.supportModel.provider = v as typeof PROVIDER_CHOICES[number]
      },
    },
    "support-model": {
      get: () => config.supportModel.model,
      set: (v) => { config.supportModel.model = v },
    },
    "support-effort": {
      get: () => config.supportModel.effort,
      set: (v) => {
        if (!isEffortConfigurable(config.supportModel)) {
          die(`Effort is not configurable for provider "${config.supportModel.provider}".`)
        }
        const choices = getEffortChoicesForSlot(config.supportModel)
        if (!choices.includes(v as EffortLevel)) {
          die(`Invalid effort: "${v}". Use: ${choices.join(", ")}`)
        }
        config.supportModel.effort = v as EffortLevel
      },
    },
    "ideas-backlog": {
      get: () => config.ideasBacklogEnabled,
      set: (v) => {
        if (v !== "true" && v !== "false") die(`Invalid value: "${v}". Use: true, false`)
        config.ideasBacklogEnabled = v === "true"
      },
    },
    "notification-preset": {
      get: () => config.notificationPreset,
      set: (v) => {
        if (!NOTIFICATION_PRESET_IDS.includes(v as NotificationPreset)) {
          die(`Invalid preset: "${v}". Use: ${NOTIFICATION_PRESET_IDS.join(", ")}`)
        }
        config.notificationPreset = v as NotificationPreset
      },
    },
    "notification-command": {
      get: () => config.notificationCommand ?? "",
      set: (v) => { config.notificationCommand = v || null },
    },
  }

  if (sub === "get") {
    const key = args.positional[1]
    if (!key) die("Usage: autoauto config get <key>")
    const entry = CONFIG_KEYS[key]
    if (!entry) die(`Unknown config key: "${key}". Keys: ${Object.keys(CONFIG_KEYS).join(", ")}`)
    const value = entry.get()
    if (json) {
      outJson({ key, value })
    } else {
      out(String(value))
    }
    return
  }

  if (sub === "set") {
    const key = args.positional[1]
    const value = args.positional[2]
    if (!key || value == null) die("Usage: autoauto config set <key> <value>")
    const entry = CONFIG_KEYS[key]
    if (!entry) die(`Unknown config key: "${key}". Keys: ${Object.keys(CONFIG_KEYS).join(", ")}`)
    entry.set(value)
    await saveProjectConfig(root, config)
    if (json) {
      outJson({ key, value: entry.get() })
    } else {
      out(`Set ${key} = ${entry.get()}`)
    }
    return
  }

  die(`Unknown config subcommand: "${sub}". Use: get, set (or no subcommand to show all)`)
}

async function cmdLogs(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto logs <program-slug>")
    out("")
    out("Show experiment stream logs.")
    out("")
    out("Flags:")
    out("  --experiment <n>  Specific experiment number (default: latest)")
    out("  --run <id>        Specific run (default: latest)")
    out("  --tail            Show last 50 lines")
    out("  --lines <n>       Show last N lines")
    out("  --json            Output as JSON")
    out("  --cwd             Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto logs <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")

  // Validate program exists
  try {
    await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found.`)
  }

  const { runDir, runId } = await resolveRunDir(programDir, args.flags)
  const state = await readState(runDir)

  // Determine experiment number
  let experimentNumber: number
  const expFlag = getFlag(args.flags, "experiment")
  if (expFlag != null) {
    const parsed = parseInt(expFlag, 10)
    if (isNaN(parsed) || parsed < 0) die(`Invalid experiment number: "${expFlag}"`)
    experimentNumber = parsed
  } else {
    experimentNumber = state.experiment_number
  }

  const logFile = join(runDir, streamLogName(experimentNumber))
  const file = Bun.file(logFile)
  if (!(await file.exists())) {
    die(`No log found for experiment #${experimentNumber} in run ${runId}.`)
  }

  const daemonStatus = await getDaemonStatus(runDir)
  const isStreaming = daemonStatus.alive && experimentNumber === state.experiment_number

  // Determine how many lines to show
  const tailLines = hasFlag(args.flags, "tail") ? 50 : null
  const linesFlagStr = getFlag(args.flags, "lines")
  if (linesFlagStr != null && parsePositiveInt(linesFlagStr) == null) {
    die(`Invalid --lines value: "${linesFlagStr}"`)
  }
  const requestedLines = tailLines ?? (linesFlagStr != null ? parsePositiveInt(linesFlagStr)! : null)

  let logOutput: string
  let totalLines: number

  if (requestedLines != null) {
    // Chunked tail read — avoid loading entire file for last N lines
    const fileSize = file.size
    const chunkSize = Math.min(fileSize, requestedLines * 1024)
    const chunk = await file.slice(-chunkSize).text()
    const lines = chunk.split("\n")
    if (json) {
      const fullContent = chunkSize >= fileSize ? chunk : await file.text()
      totalLines = fullContent.split("\n").length
    } else {
      totalLines = lines.length
    }
    logOutput = lines.slice(-requestedLines).join("\n")
  } else {
    const fullContent = await file.text()
    const allLines = fullContent.split("\n")
    totalLines = allLines.length
    logOutput = fullContent
  }

  if (json) {
    outJson({
      run_id: runId,
      experiment_number: experimentNumber,
      log: logOutput,
      lines_total: totalLines,
      is_streaming: isStreaming,
    })
    return
  }

  out(logOutput)
  if (isStreaming) {
    out("(in progress...)")
  }
}

async function cmdSummary(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto summary <program-slug>")
    out("")
    out("Show or generate a run summary report.")
    out("")
    out("Flags:")
    out("  --run <id>       Specific run (default: latest)")
    out("  --generate       Generate stats summary if missing (completed/crashed runs only)")
    out("  --json           Output as JSON")
    out("  --cwd            Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto summary <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")
  const generate = hasFlag(args.flags, "generate")

  let programConfig: ProgramConfig
  try {
    programConfig = await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found.`)
  }

  const { runDir, runId } = await resolveRunDir(programDir, args.flags)
  const summaryPath = join(runDir, "summary.md")
  const hasSummary = await Bun.file(summaryPath).exists()

  if (hasSummary) {
    const summaryText = await Bun.file(summaryPath).text()
    if (json) {
      const state = await readState(runDir)
      const stats = getRunStats(state, programConfig.direction)
      outJson({
        run_id: runId,
        has_summary: true,
        summary_text: summaryText,
        generated: false,
        stats: {
          total_experiments: stats.total_experiments,
          total_keeps: stats.total_keeps,
          improvement_pct: stats.improvement_pct,
        },
      })
    } else {
      out(summaryText)
    }
    return
  }

  if (generate) {
    const state = await readState(runDir)
    if (state.phase !== "complete" && state.phase !== "crashed") {
      die("Can only generate summary for completed or crashed runs.")
    }

    const results = await readAllResults(runDir)
    const summaryText = generateSummaryReport(state, results, programConfig, "")
    await saveFinalizeReport(runDir, summaryText)

    if (json) {
      const stats = getRunStats(state, programConfig.direction)
      outJson({
        run_id: runId,
        has_summary: true,
        summary_text: summaryText,
        generated: true,
        stats: {
          total_experiments: stats.total_experiments,
          total_keeps: stats.total_keeps,
          improvement_pct: stats.improvement_pct,
        },
      })
    } else {
      out("Generated stats summary (use TUI for full agent-reviewed finalization).")
      out("")
      out(summaryText)
    }
    return
  }

  // No summary and no --generate
  if (json) {
    outJson({ run_id: runId, has_summary: false, summary_text: null, generated: false, stats: null })
  } else {
    out(`No summary found for run ${runId}.`)
    out(`Use --generate to create a stats summary.`)
  }
}

async function cmdDelete(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto delete <program-slug>")
    out("")
    out("Delete a program or a specific run.")
    out("")
    out("Flags:")
    out("  --run <id>       Delete a specific run (default: delete entire program)")
    out("  --confirm        Confirm deletion (required)")
    out("  --json           Output as JSON")
    out("  --cwd            Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto delete <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")
  const confirm = hasFlag(args.flags, "confirm")
  const runIdFlag = getFlag(args.flags, "run")

  // Validate program exists
  try {
    await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found.`)
  }

  if (runIdFlag) {
    // Delete specific run
    const runDir = join(programDir, "runs", runIdFlag)
    let state: RunState
    try {
      state = await readState(runDir)
    } catch {
      die(`Run "${runIdFlag}" not found.`)
    }

    if (isRunActive({ run_id: runIdFlag, run_dir: runDir, state })) {
      const active = await findActiveRun(programDir)
      if (active?.runId === runIdFlag && active.daemonAlive) {
        die("Cannot delete an active run. Stop it first with `autoauto stop`.")
      }
    }

    if (!confirm) {
      if (json) {
        outJson({ action: "dry_run", would_delete: { slug, run_id: runIdFlag } })
      } else {
        out(`Would delete run ${runIdFlag} from program "${slug}".`)
        out(`Add --confirm to delete.`)
      }
      return
    }

    await deleteRun(root, { run_id: runIdFlag, run_dir: runDir, state })
    if (json) {
      outJson({ action: "deleted", slug, run_id: runIdFlag })
    } else {
      out(`Deleted run ${runIdFlag} from program "${slug}".`)
    }
    return
  }

  // Delete entire program
  const active = await findActiveRun(programDir)
  if (active?.daemonAlive) {
    die("Cannot delete a program with an active run. Stop it first with `autoauto stop`.")
  }

  const runs = await listRuns(programDir)

  if (!confirm) {
    if (json) {
      outJson({
        action: "dry_run",
        would_delete: { slug, runs: runs.length, run_ids: runs.map((r) => r.run_id) },
      })
    } else {
      out(`Would delete program "${slug}" with ${runs.length} run${runs.length !== 1 ? "s" : ""}.`)
      if (runs.length > 0) {
        out(`Runs: ${runs.map((r) => r.run_id).join(", ")}`)
      }
      out(`Add --confirm to delete.`)
    }
    return
  }

  // Clean up queue entries for this program
  const queue = await readQueue(root)
  const queueIds = queue.entries.filter((e) => e.programSlug === slug).map((e) => e.id)
  for (const id of queueIds) {
    await removeFromQueue(root, id)
  }

  await deleteProgram(root, slug)
  if (json) {
    outJson({ action: "deleted", slug, runs_deleted: runs.length })
  } else {
    out(`Deleted program "${slug}" and ${runs.length} run${runs.length !== 1 ? "s" : ""}.`)
  }
}

async function cmdValidate(args: ParsedArgs) {
  if (hasFlag(args.flags, "help")) {
    out("Usage: autoauto validate <program-slug>")
    out("")
    out("Validate measurement script stability. Creates a temporary worktree,")
    out("runs the measurement multiple times, and reports CV% and assessment.")
    out("")
    out("Flags:")
    out("  --runs <n>   Number of validation runs (default: 5)")
    out("  --json       Output as JSON")
    out("  --cwd        Override working directory")
    return
  }

  const slug = args.positional[0]
  if (!slug) die("Usage: autoauto validate <program-slug>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")

  // Validate program exists
  try {
    await loadProgramConfig(programDir)
  } catch {
    die(`Program "${slug}" not found.`)
  }

  const runsStr = getFlag(args.flags, "runs") ?? "5"
  const numRuns = parsePositiveInt(runsStr)
  if (numRuns == null) die(`Invalid --runs value: "${runsStr}". Must be a positive integer.`)

  let measurePath = join(programDir, "measure.sh")
  const configPath = join(programDir, "config.json")

  // Check measure script exists (fall back to extensionless "measure")
  if (!(await Bun.file(measurePath).exists())) {
    const fallback = join(programDir, "measure")
    if (!(await Bun.file(fallback).exists())) {
      die(`Measurement script not found at ${measurePath} or ${fallback}`)
    }
    measurePath = fallback
  }

  const validator = getSelfCommand("__validate_measurement")
  const proc = Bun.spawn([validator.command, ...validator.args, measurePath, configPath, String(numRuns)], {
    stdout: "pipe",
    stderr: "inherit",
  })

  // Signal handling for clean subprocess termination
  const cleanup = () => { proc.kill() }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  let stdout: string
  try {
    stdout = await new Response(proc.stdout).text()
    await proc.exited
  } finally {
    process.off("SIGINT", cleanup)
    process.off("SIGTERM", cleanup)
  }

  if (proc.exitCode !== 0) {
    die("Validation subprocess failed.", 2)
  }

  let result: Record<string, unknown>
  try {
    result = JSON.parse(stdout)
  } catch {
    die("Failed to parse validation output.")
  }

  // Handle minimal error payload (top-level catch in validate-measurement.ts)
  if (
    typeof result.error === "string" &&
    (typeof result.build !== "object" || result.build == null)
  ) {
    if (json) {
      outJson(result)
      return
    }
    die(result.error as string, 2)
  }

  if (json) {
    outJson(result)
    return
  }

  // Human-readable formatting
  const r = result as {
    success: boolean
    total_runs: number
    valid_runs: number
    failed_runs: Array<{ run: number; error: string }>
    validation_errors: Array<{ run: number; errors: string[] }>
    metric: { field: string; median: number; mean: number; cv_percent: number } | null
    quality_gates: Record<string, { field: string; median: number; cv_percent: number }>
    secondary_metrics: Record<string, { field: string; median: number; cv_percent: number }>
    assessment: string | null
    recommendations: { noise_threshold: number; repeats: number } | null
    avg_duration_ms: number
    recommended_timeout: number | null
    build: { ran: boolean; success: boolean; duration_ms: number; error?: string }
  }

  // Build
  if (r.build.ran) {
    out(`Build:          ${r.build.success ? "OK" : "FAIL"} (${r.build.duration_ms}ms)`)
    if (r.build.error) out(`  Error: ${r.build.error}`)
  }

  out(`Runs:           ${r.valid_runs}/${r.total_runs} valid`)

  if (r.failed_runs.length > 0) {
    for (const f of r.failed_runs) {
      out(`  Run ${f.run} failed: ${f.error}`)
    }
  }

  if (r.validation_errors.length > 0) {
    for (const v of r.validation_errors) {
      out(`  Run ${v.run} validation: ${v.errors.join("; ")}`)
    }
  }

  if (r.metric) {
    out(`Assessment:     ${r.assessment ?? "unknown"} (CV ${r.metric.cv_percent}%)`)
    out(`Metric:         ${r.metric.field} median=${r.metric.median} mean=${r.metric.mean}`)
  }

  const gateNames = Object.keys(r.quality_gates)
  if (gateNames.length > 0) {
    out("Quality gates:")
    for (const name of gateNames) {
      const g = r.quality_gates[name]
      out(`  ${g.field}: median=${g.median} (CV ${g.cv_percent}%)`)
    }
  }

  const secondaryNames = Object.keys(r.secondary_metrics)
  if (secondaryNames.length > 0) {
    out("Secondary metrics:")
    for (const name of secondaryNames) {
      const s = r.secondary_metrics[name]
      out(`  ${s.field}: median=${s.median} (CV ${s.cv_percent}%)`)
    }
  }

  if (r.recommendations) {
    out("Recommendations:")
    out(`  noise_threshold: ${r.recommendations.noise_threshold}`)
    out(`  repeats: ${r.recommendations.repeats}`)
  }

  out(`Avg duration:   ${(r.avg_duration_ms / 1000).toFixed(1)}s`)
  if (r.recommended_timeout) {
    out(`Rec. timeout:   ${(r.recommended_timeout / 1000).toFixed(0)}s`)
  }

  if (!r.success) {
    process.exit(1)
  }
}

// --- Main Router ---

async function cmdSandbox(args: ParsedArgs) {
  const sub = args.positional[0]

  if (hasFlag(args.flags, "help") || !sub) {
    out("Usage: autoauto sandbox test --program <slug>")
    out("")
    out("Test sandbox provisioning for a program.")
    out("Creates a Modal sandbox, uploads the repo, installs deps,")
    out("and runs measure.sh to verify everything works.")
    out("")
    out("Flags:")
    out("  --program <slug>  Program to test (required)")
    out("  --cwd             Override working directory")
    return
  }

  if (sub !== "test") die(`Unknown sandbox subcommand: ${sub}`)

  const slug = getFlag(args.flags, "program")
  if (!slug) die("--program <slug> is required")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)

  try { await loadProgramConfig(programDir) }
  catch { die(`Program "${slug}" not found.`) }

  const { checkModalAuth } = await import("./lib/container-provider/modal.ts")
  const auth = checkModalAuth()
  if (!auth.ok) die(auth.error!)

  const { getContainerProviderFactory, MODAL_PROVIDER_ID } = await import("./lib/container-provider/index.ts")
  const factory = getContainerProviderFactory(MODAL_PROVIDER_ID)
  if (!factory) die("Modal provider not registered")

  out("Creating Modal sandbox...")
  const provider = await factory({})
  out("Sandbox created")

  try {
    out("Uploading repository...")
    await provider.uploadRepo(root, "/workspace")
    out("Upload complete")

    out("Installing dependencies...")
    const installResult = await provider.exec(
      ["bash", "-c", "export PATH=$HOME/.bun/bin:$PATH && cd /workspace && bun install --frozen-lockfile 2>&1 || bun install 2>&1"],
      { timeout: 180_000 },
    )
    if (installResult.exitCode === 0) {
      out("Dependencies installed")
    } else {
      out(`Install failed (exit ${installResult.exitCode})`)
      out(new TextDecoder().decode(installResult.stdout.length > 0 ? installResult.stdout : installResult.stderr))
      throw new Error(`bun install failed (exit ${installResult.exitCode})`)
    }

    out("Running measure script...")
    // Support both measure.sh and extensionless measure
    const measureSh = `/workspace/.autoauto/programs/${slug}/measure.sh`
    const measureNoExt = `/workspace/.autoauto/programs/${slug}/measure`
    const shCheck = await provider.exec(["test", "-f", measureSh])
    const measurePath = shCheck.exitCode === 0 ? measureSh : measureNoExt
    await provider.exec(["chmod", "+x", measurePath])
    const result = await provider.exec(
      ["bash", measurePath],
      { cwd: "/workspace", timeout: 120_000 },
    )
    if (result.exitCode === 0) {
      out("measure.sh OK (exit 0)")
      out(new TextDecoder().decode(result.stdout))
    } else {
      out(`measure.sh FAILED (exit ${result.exitCode})`)
      out(new TextDecoder().decode(result.stderr))
    }
  } finally {
    out("Terminating sandbox...")
    await provider.terminate()
    out("Done")
  }
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  list: cmdList,
  show: cmdShow,
  start: cmdStart,
  status: cmdStatus,
  results: cmdResults,
  logs: cmdLogs,
  summary: cmdSummary,
  stop: cmdStop,
  limit: cmdLimit,
  validate: cmdValidate,
  delete: cmdDelete,
  config: cmdConfig,
  queue: cmdQueue,
  sandbox: cmdSandbox,
}

export async function run(argv: string[]) {
  if (argv[0] === "__daemon") {
    const { startDaemon } = await import("./daemon.ts")
    await startDaemon(argv.slice(1))
    return
  }

  if (argv[0] === "__validate_measurement") {
    const { startValidateMeasurement } = await import("./lib/validate-measurement.ts")
    await startValidateMeasurement(argv.slice(1))
    return
  }

  if (argv[0] === "_sandbox-helper") {
    const { runSandboxHelper } = await import("./lib/sandbox-helper.ts")
    await runSandboxHelper(argv.slice(1))
    return
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    out(AUTOAUTO_VERSION)
    return
  }

  // MCP server mode — bypass normal CLI dispatch
  if (argv[0] === "mcp") {
    const { startMcpServer } = await import("./mcp.ts")
    await startMcpServer()
    return
  }

  registerDefaultProviders()

  const { registerDefaultContainerProviders } = await import("./lib/container-provider/index.ts")
  registerDefaultContainerProviders()

  const args = parseArgs(argv)
  const handler = COMMANDS[args.command]

  if (!handler) {
    out("Usage: autoauto <command> [options]")
    out("")
    out("Commands:")
    out("  list                          List all programs")
    out("  show <slug>                   Show program details")
    out("  start <slug>                  Start an experiment run")
    out("  status <slug>                 Show run status")
    out("  results <slug>                Show experiment results")
    out("  logs <slug>                   Show experiment stream logs")
    out("  summary <slug>                Show or generate run summary")
    out("  stop <slug>                   Stop the active run")
    out("  limit <slug> <n>              Update experiment cap on active run")
    out("  validate <slug>               Validate measurement script")
    out("  delete <slug>                 Delete a program or run")
    out("  config                        Show/update project configuration")
    out("  queue [list|add|remove|clear] Manage run queue")
    out("  sandbox test --program <slug> Test sandbox provisioning")
    out("  mcp                           Start MCP server (stdio transport)")
    out("")
    out("Global flags:")
    out("  --json                        Output as JSON")
    out("  --cwd <path>                  Override working directory")
    out("  --help                        Show command help")
    out("")
    out("Run `autoauto <command> --help` for command-specific flags.")
    process.exit(1)
  }

  try {
    await handler(args)
  } catch (err) {
    die(formatShellError(err), 2)
  } finally {
    await closeProviders()
  }
}
