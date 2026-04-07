import { join } from "node:path"
import {
  listPrograms,
  loadProgramConfig,
  getProgramDir,
  getProjectRoot,
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
  type RunState,
} from "./lib/run.ts"
import { loadProjectConfig, type ModelSlot, type EffortLevel } from "./lib/config.ts"
import { streamLogName } from "./lib/daemon-callbacks.ts"
import { closeProviders, type AgentProviderID } from "./lib/agent/index.ts"
import { registerDefaultProviders } from "./lib/agent/default-providers.ts"
import { getCodexDefaultModel, getOpenCodeDefaultModel } from "./lib/model-options.ts"

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

function formatElapsed(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime()
  const end = endedAt ? new Date(endedAt).getTime() : Date.now()
  const ms = end - start
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours}h ${remainingMins}m`
}

function formatCost(usd: number | undefined): string {
  if (usd == null) return "$0.00"
  return `$${usd.toFixed(2)}`
}

function formatChangePct(
  original: number,
  current: number,
  direction: ProgramConfig["direction"],
): string {
  if (original === 0) return "—"
  const pct =
    direction === "lower"
      ? ((original - current) / Math.abs(original)) * 100
      : ((current - original) / Math.abs(original)) * 100
  const sign = pct > 0 ? "+" : ""
  return `${sign}${pct.toFixed(1)}%`
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const n = parseInt(value, 10)
  return n >= 1 ? n : null
}

function parseProvider(value: string | undefined): AgentProviderID | null {
  if (value === "claude" || value === "opencode" || value === "codex") return value
  return null
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

// --- Commands ---

async function cmdList(args: ParsedArgs) {
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
      const match = md.match(/## Goal\n+([\s\S]*?)(?:\n##|\n*$)/)
      if (match) goal = match[1].trim()
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

  // Load project config for defaults
  const projectConfig = await loadProjectConfig(root)

  // Build model config from flags or defaults
  const providerFlag = getFlag(args.flags, "provider")
  const parsedProvider = parseProvider(providerFlag)
  if (providerFlag && !parsedProvider) die(`Invalid --provider: "${providerFlag}". Use claude, opencode, or codex.`)

  const explicitModel = getFlag(args.flags, "model")
  const provider: AgentProviderID = parsedProvider ?? (explicitModel ? "claude" : projectConfig.executionModel.provider)
  if (provider === "opencode" && hasFlag(args.flags, "effort")) {
    die("--effort is not supported with --provider opencode yet.")
  }

  let model = explicitModel
  if (!model) {
    if (provider === projectConfig.executionModel.provider) {
      model = projectConfig.executionModel.model
    } else if (provider === "opencode") {
      model = await getOpenCodeDefaultModel(root) ?? undefined
      if (!model) die("No connected OpenCode models found. Run `opencode auth login` or `/connect` first.")
    } else if (provider === "codex") {
      model = await getCodexDefaultModel(root) ?? undefined
      if (!model) die("Could not resolve Codex default model.")
    } else {
      model = "sonnet"
    }
  }
  if (!model) die("Could not resolve model.")

  const modelConfig: ModelSlot = {
    provider,
    model,
    effort: provider !== "opencode"
      ? ((getFlag(args.flags, "effort") as EffortLevel) ?? projectConfig.executionModel.effort)
      : projectConfig.executionModel.effort,
  }

  const maxExperimentsStr = getFlag(args.flags, "max-experiments")
  let maxExperiments: number | undefined = programConfig.max_experiments
  if (maxExperimentsStr != null) {
    const parsed = parsePositiveInt(maxExperimentsStr)
    if (parsed == null) die(`Invalid --max-experiments: "${maxExperimentsStr}". Must be a positive integer.`)
    maxExperiments = parsed
  }

  const ideasBacklogEnabled = hasFlag(args.flags, "no-ideas-backlog")
    ? false
    : hasFlag(args.flags, "ideas-backlog")
      ? true
      : projectConfig.ideasBacklogEnabled

  const useWorktree = !hasFlag(args.flags, "in-place")

  // Spawn daemon
  let result: { runId: string; runDir: string; worktreePath: string | null; pid: number }
  try {
    result = await spawnDaemon(root, slug, modelConfig, maxExperiments, ideasBacklogEnabled, useWorktree)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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
      elapsed: formatElapsed(state.started_at, isComplete ? state.updated_at : undefined),
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
    out(`Cost: ${formatCost(state.total_cost_usd)} | Duration: ${formatElapsed(state.started_at, state.updated_at)}`)
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
    out(`Cost: ${formatCost(state.total_cost_usd)} | Elapsed: ${formatElapsed(state.started_at)}`)
  }
}

async function cmdResults(args: ParsedArgs) {
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
      `${padRight(num, 5)} ${padRight(r.status, 22)} ${padRight(String(r.metric_value), 14)} ${padRight(change, 10)} ${padRight(r.commit.slice(0, 7), 10)} ${r.description}`,
    )
  }
}

async function cmdStop(args: ParsedArgs) {
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
  const slug = args.positional[0]
  const valueStr = args.positional[1]
  if (!slug || valueStr == null) die("Usage: autoauto limit <program-slug> <n|none>")

  const root = await resolveRoot(args.flags)
  const programDir = getProgramDir(root, slug)
  const json = hasFlag(args.flags, "json")

  const active = await findActiveRun(programDir)
  if (!active) die(`No active run for "${slug}".`)
  if (!active.daemonAlive) die("Daemon is not running. Run may have already completed.")

  let maxExperiments: number | undefined
  if (valueStr === "none") {
    maxExperiments = undefined
  } else {
    const parsed = parsePositiveInt(valueStr)
    if (parsed == null) die(`Invalid value: "${valueStr}". Use a positive integer or "none".`)
    maxExperiments = parsed
  }

  await updateMaxExperiments(active.runDir, maxExperiments)

  if (json) {
    outJson({ run_id: active.runId, max_experiments: maxExperiments ?? null })
  } else {
    if (maxExperiments != null) {
      out(`Updated ${slug} run ${active.runId}: max experiments set to ${maxExperiments}.`)
    } else {
      out(`Updated ${slug} run ${active.runId}: experiment cap removed.`)
    }
  }
}

// --- Main Router ---

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
  list: cmdList,
  start: cmdStart,
  status: cmdStatus,
  results: cmdResults,
  stop: cmdStop,
  limit: cmdLimit,
}

export async function run(argv: string[]) {
  registerDefaultProviders()
  const args = parseArgs(argv)
  const handler = COMMANDS[args.command]

  if (!handler) {
    out("Usage: autoauto <command> [options]")
    out("")
    out("Commands:")
    out("  list                         List all programs")
    out("  start <slug>                 Start an experiment run")
    out("  status <slug>                Show run status")
    out("  results <slug>               Show experiment results")
    out("  stop <slug>                  Stop the active run")
    out("  limit <slug> <n|none>        Update experiment cap on active run")
    out("")
    out("Global flags:")
    out("  --json                       Output as JSON")
    out("  --cwd <path>                 Override working directory")
    out("  --provider <claude|opencode|codex> Agent provider for start")
    process.exit(1)
  }

  try {
    await handler(args)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    die(msg, 2)
  } finally {
    await closeProviders()
  }
}
