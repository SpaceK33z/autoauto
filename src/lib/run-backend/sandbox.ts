/**
 * SandboxRunBackend — orchestrates runs in remote containers using a ContainerProvider.
 *
 * The daemon, agent, and measurement all run inside the remote container.
 * The TUI polls container files via ContainerProvider for state updates.
 */

import type { RunBackend, RunHandle, SpawnRunInput, ActiveRun, ReconstructedState } from "./types.ts"
import type { ContainerProvider } from "../container-provider/types.ts"
import type { WatchCallbacks, DaemonWatcher } from "../daemon-watcher.ts"
import type { DaemonStatus } from "../daemon-status.ts"
import type { RunState } from "../run.ts"
import type { ProgramConfig } from "../programs.ts"
import { watchSandboxRunDir } from "../sandbox-watcher.ts"
import { bundleUnbundle } from "../git.ts"
import { initRunDir } from "../run-setup.ts"
import { generateRunId, parseTsvRows, getMetricHistory } from "../run.ts"
import { getProgramDir } from "../programs.ts"
import { streamLogName } from "../daemon-callbacks.ts"
import { join } from "node:path"

const REMOTE_WORKSPACE = "/workspace"
const HEARTBEAT_STALE_MS = 30_000

const decoder = new TextDecoder()

/** Use forward slashes for remote (Linux) paths */
function remotePath(...segments: string[]): string {
  return segments.join("/")
}

function decodeBytes(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

class SandboxRunHandle implements RunHandle {
  readonly runId: string
  readonly runDir: string
  private provider: ContainerProvider
  private remoteRunDir: string

  constructor(runId: string, runDir: string, provider: ContainerProvider, remoteRunDir: string) {
    this.runId = runId
    this.runDir = runDir
    this.provider = provider
    this.remoteRunDir = remoteRunDir
  }

  async watch(callbacks: WatchCallbacks, options?: { startAtEnd?: boolean }): Promise<DaemonWatcher> {
    return watchSandboxRunDir(this.provider, this.remoteRunDir, callbacks, {
      startAtEnd: options?.startAtEnd,
    })
  }

  async getStatus(): Promise<DaemonStatus> {
    const exitCode = await this.provider.poll().catch(() => 1)
    if (exitCode !== null) {
      return { alive: false, starting: false, daemonJson: null }
    }

    try {
      const bytes = await this.provider.readFile(remotePath(this.remoteRunDir, "daemon.json"))
      const daemonJson = JSON.parse(decodeBytes(bytes))

      if (!daemonJson.daemon_id) {
        return { alive: true, starting: true, daemonJson }
      }

      if (daemonJson.heartbeat_at) {
        const heartbeatAge = Date.now() - new Date(daemonJson.heartbeat_at).getTime()
        if (heartbeatAge > HEARTBEAT_STALE_MS) {
          return { alive: false, starting: false, daemonJson }
        }
      }

      return { alive: true, starting: false, daemonJson }
    } catch {
      return { alive: exitCode === null, starting: exitCode === null, daemonJson: null }
    }
  }

  async sendControl(action: "stop" | "abort"): Promise<void> {
    const controlJson = JSON.stringify({ action, timestamp: new Date().toISOString() })
    await this.provider.writeFile(
      remotePath(this.remoteRunDir, "control.json"),
      controlJson,
    )
  }

  async terminate(): Promise<void> {
    await this.provider.terminate()
  }

  async updateMaxExperiments(value: number): Promise<void> {
    await this.updateRunConfig((config) => { config.max_experiments = value })
  }

  async updateMaxCostUsd(value: number | undefined): Promise<void> {
    await this.updateRunConfig((config) => { config.max_cost_usd = value })
  }

  private async updateRunConfig(mutate: (config: Record<string, unknown>) => void): Promise<void> {
    const configPath = remotePath(this.remoteRunDir, "run-config.json")
    try {
      const bytes = await this.provider.readFile(configPath)
      const config = JSON.parse(decodeBytes(bytes))
      mutate(config)
      await this.provider.writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
    } catch {
      // Config may not exist yet during early startup
    }
  }

  async materializeArtifacts(): Promise<void> {
    await this.downloadIndividualFiles()

    // Download git bundle from container (best-effort)
    try {
      const bundleRemotePath = remotePath(this.remoteRunDir, ".results.bundle")
      const createResult = await this.provider.exec([
        "git", "bundle", "create", bundleRemotePath, "--all",
      ], { cwd: REMOTE_WORKSPACE })

      if (createResult.exitCode === 0) {
        const bundleBytes = await this.provider.readFile(bundleRemotePath)
        const localBundlePath = join(this.runDir, "results.bundle")
        await Bun.write(localBundlePath, bundleBytes)

        let applied = false
        try {
          const state = await Bun.file(join(this.runDir, "state.json")).json() as RunState
          if (state.worktree_path) {
            await bundleUnbundle(state.worktree_path, localBundlePath)
            applied = true
          }
        } catch { /* state may not be materialized yet — bundle will be applied during finalization */ }

        if (applied) {
          const { unlink } = await import("node:fs/promises")
          await unlink(localBundlePath).catch(() => {})
        }
      }
    } catch {
      // Git bundle is best-effort — run artifacts are the priority
    }
  }

  private async downloadIndividualFiles(): Promise<void> {
    const files = ["state.json", "results.tsv", "run-config.json", "daemon.json", "ideas.md", "summary.md", "quota.json"]

    // Download known files in parallel
    await Promise.allSettled(
      files.map((file) =>
        this.provider.readFile(remotePath(this.remoteRunDir, file))
          .then((bytes) => Bun.write(join(this.runDir, file), bytes)),
      ),
    )

    // Download stream logs — bound by experiment count from state
    let maxExperiment = 0
    try {
      const state = await Bun.file(join(this.runDir, "state.json")).json() as RunState
      maxExperiment = state.experiment_number ?? 0
    } catch { /* state download may have failed */ }

    for (let i = 0; i <= maxExperiment; i++) {
      const name = streamLogName(i)
      try {
        const bytes = await this.provider.readFile(remotePath(this.remoteRunDir, name))
        await Bun.write(join(this.runDir, name), bytes)
      } catch {
        break
      }
    }
  }

  async reconstructState(_programDir: string): Promise<ReconstructedState> {
    // Derive remote program dir from remoteRunDir (strip trailing /runs/<id>)
    const remoteProgramDir = this.remoteRunDir.split("/").slice(0, -2).join("/")
    const [stateBytes, resultsBytes, configBytes] = await Promise.all([
      this.provider.readFile(remotePath(this.remoteRunDir, "state.json")),
      this.provider.readFile(remotePath(this.remoteRunDir, "results.tsv")).catch(() => new Uint8Array()),
      this.provider.readFile(remotePath(remoteProgramDir, "config.json")).catch(() => new Uint8Array()),
    ])

    const state = JSON.parse(decodeBytes(stateBytes)) as RunState
    const results = parseTsvRows(decodeBytes(resultsBytes))
    const programConfig = configBytes.length > 0 ? JSON.parse(decodeBytes(configBytes)) as ProgramConfig : {} as ProgramConfig

    const [streamBytes, ideasBytes, summaryBytes] = await Promise.all([
      this.readStreamTail(state.experiment_number),
      this.provider.readFile(remotePath(this.remoteRunDir, "ideas.md")).catch(() => new Uint8Array()),
      this.provider.readFile(remotePath(this.remoteRunDir, "summary.md")).catch(() => new Uint8Array()),
    ])

    const streamText = decodeBytes(streamBytes)
    return {
      state,
      results,
      metricHistory: getMetricHistory(results),
      programConfig,
      streamText: streamText.length > 8000 ? streamText.slice(-6000) : streamText,
      ideasText: decodeBytes(ideasBytes),
      summaryText: decodeBytes(summaryBytes),
    }
  }

  private async readStreamTail(experimentNumber: number): Promise<Uint8Array> {
    try {
      const filename = streamLogName(experimentNumber)
      return await this.provider.readFile(remotePath(this.remoteRunDir, filename))
    } catch {
      return new Uint8Array()
    }
  }
}

export class SandboxRunBackend implements RunBackend {
  private providerFactory: (config?: Record<string, unknown>) => Promise<ContainerProvider>
  private providerName: string

  constructor(providerFactory: (config?: Record<string, unknown>) => Promise<ContainerProvider>, providerName?: string) {
    this.providerFactory = providerFactory
    this.providerName = providerName ?? "sandbox"
  }

  async spawn(input: SpawnRunInput): Promise<RunHandle> {
    const runId = generateRunId()
    const programDir = getProgramDir(input.mainRoot, input.programSlug)
    const runDir = await initRunDir(programDir, runId)

    const provider = await this.providerFactory({
      programSlug: input.programSlug,
      runId,
    })

    await provider.setMetadata({
      run_id: runId,
      program_slug: input.programSlug,
    })

    await provider.uploadRepo(input.mainRoot, REMOTE_WORKSPACE)

    // --- Provisioning: install project dependencies ---
    // Check if a package.json/bun.lock exists before running install
    const hasPackageJson = await provider.exec(
      ["test", "-f", "package.json"],
      { cwd: REMOTE_WORKSPACE },
    )
    if (hasPackageJson.exitCode === 0) {
      const installResult = await provider.exec(
        ["bash", "-c", "export PATH=$HOME/.bun/bin:$PATH && bun install --frozen-lockfile 2>&1 || bun install 2>&1"],
        { cwd: REMOTE_WORKSPACE, timeout: 180_000 },
      )
      if (installResult.exitCode !== 0) {
        const stderr = decodeBytes(installResult.stderr.length > 0 ? installResult.stderr : installResult.stdout)
        await provider.terminate()
        throw new Error(`Sandbox provisioning failed (bun install exit ${installResult.exitCode}): ${stderr.slice(0, 500)}`)
      }
    }

    // --- Pre-flight: verify measure script produces valid JSON (best-effort) ---
    const remoteMeasureSh = remotePath(".autoauto", "programs", input.programSlug, "measure.sh")
    const remoteMeasureNoExt = remotePath(".autoauto", "programs", input.programSlug, "measure")
    const shExists = await provider.exec(["test", "-f", remoteMeasureSh], { cwd: REMOTE_WORKSPACE })
    const remoteMeasurePath = shExists.exitCode === 0
      ? remoteMeasureSh
      : remoteMeasureNoExt
    const measureExists = shExists.exitCode === 0
      ? shExists
      : await provider.exec(["test", "-f", remoteMeasureNoExt], { cwd: REMOTE_WORKSPACE })
    if (measureExists.exitCode === 0) {
      await provider.exec(["chmod", "+x", remoteMeasurePath], { cwd: REMOTE_WORKSPACE })
      const preflight = await provider.exec(
        ["bash", remoteMeasurePath],
        { cwd: REMOTE_WORKSPACE, timeout: 120_000 },
      )
      if (preflight.exitCode !== 0) {
        const stderr = decodeBytes(preflight.stderr.length > 0 ? preflight.stderr : preflight.stdout)
        await provider.terminate()
        throw new Error(`Sandbox pre-flight failed (measure.sh exit ${preflight.exitCode}): ${stderr.slice(0, 500)}`)
      }
      const measureOutput = decodeBytes(preflight.stdout).trim()
      try { JSON.parse(measureOutput) } catch {
        await provider.terminate()
        throw new Error(`Sandbox pre-flight: measure.sh output is not valid JSON: ${measureOutput.slice(0, 200)}`)
      }
    }

    const remoteRunDir = remotePath(REMOTE_WORKSPACE, ".autoauto", "programs", input.programSlug, "runs", runId)
    await provider.exec(["mkdir", "-p", remoteRunDir])

    const runConfig = {
      provider: input.modelConfig.provider,
      model: input.modelConfig.model,
      effort: input.modelConfig.effort,
      max_experiments: input.maxExperiments,
      max_cost_usd: input.maxCostUsd,
      ideas_backlog_enabled: input.ideasBacklogEnabled ?? true,
      carry_forward: input.carryForward ?? true,
      keep_simplifications: input.keepSimplifications,
      source: input.source ?? "manual",
      ...(input.fallbackModel ? {
        fallback_provider: input.fallbackModel.provider,
        fallback_model: input.fallbackModel.model,
        fallback_effort: input.fallbackModel.effort,
      } : {}),
    }

    // Write config and results header in parallel
    await Promise.all([
      provider.writeFile(
        remotePath(remoteRunDir, "run-config.json"),
        JSON.stringify(runConfig, null, 2) + "\n",
      ),
      provider.writeFile(
        remotePath(remoteRunDir, "results.tsv"),
        "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\n",
      ),
    ])

    const daemonId = crypto.randomUUID()
    const daemonArgs = [
      "bun", "run", "src/index.tsx", "__daemon",
      "--program", input.programSlug,
      "--run-id", runId,
      "--main-root", REMOTE_WORKSPACE,
      "--worktree", REMOTE_WORKSPACE,
      "--daemon-id", daemonId,
      "--in-place",
    ]
    const daemonProcess = await provider.execStreaming(daemonArgs, { cwd: REMOTE_WORKSPACE })
    daemonProcess.exitCode.catch(() => {}) // prevent unhandled rejection if container crashes during startup

    const initialDaemon = {
      run_id: runId,
      pid: 0,
      started_at: new Date().toISOString(),
      worktree_path: REMOTE_WORKSPACE,
      daemon_id: daemonId,
    }
    await provider.writeFile(
      remotePath(remoteRunDir, "daemon.json"),
      JSON.stringify(initialDaemon, null, 2) + "\n",
    )

    // Persist sandbox identity for reconnection after TUI disconnect
    const sandboxInfo = {
      provider: this.providerName,
      program_slug: input.programSlug,
      run_id: runId,
      created_at: new Date().toISOString(),
    }
    await Bun.write(join(runDir, "sandbox.json"), JSON.stringify(sandboxInfo, null, 2) + "\n")

    return new SandboxRunHandle(runId, runDir, provider, remoteRunDir)
  }

  async findActiveRun(programDir: string): Promise<ActiveRun | null> {
    try {
      const lockPath = join(programDir, "run.lock")
      const lockData = await Bun.file(lockPath).json() as { run_id: string }
      if (!lockData?.run_id) return null

      const runDir = join(programDir, "runs", lockData.run_id)

      try {
        const sandboxInfo = await Bun.file(join(runDir, "sandbox.json")).json() as { provider?: string; program_slug?: string; run_id?: string }
        const { lookupContainerByInfo } = await import("../container-provider/index.ts")
        const handle = await lookupContainerByInfo({
          provider: sandboxInfo.provider,
          run_id: sandboxInfo.run_id ?? lockData.run_id,
          program_slug: sandboxInfo.program_slug ?? "",
        })

        return {
          runId: lockData.run_id,
          runDir,
          daemonAlive: handle !== null,
        }
      } catch {
        // Not a sandbox run or lookup failed
      }

      return {
        runId: lockData.run_id,
        runDir,
        daemonAlive: false,
      }
    } catch {
      return null
    }
  }
}
