/**
 * E2E test fixture: creates an isolated temporary git repo with .autoauto structure.
 * Each test gets a fresh directory that looks like a real autoauto project.
 */

import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

export interface TestFixture {
  /** Root directory of the temp git repo */
  cwd: string
  /** Create a program with config */
  createProgram: (slug: string, config: ProgramFixtureConfig) => Promise<string>
  /** Create a fake run directory with state */
  createRun: (slug: string, run: RunFixtureConfig) => Promise<string>
  /** Write the project config */
  writeProjectConfig: (config: ProjectConfigFixture) => Promise<void>
  /** Clean up the temp directory */
  cleanup: () => Promise<void>
}

export interface ProgramFixtureConfig {
  metric_field?: string
  direction?: "lower" | "higher"
  noise_threshold?: number
  repeats?: number
  max_experiments?: number
  quality_gates?: Record<string, { min?: number; max?: number }>
  measureScript?: string
}

export interface ResultFixture {
  experiment_number: number
  commit: string
  metric_value: number
  status: "keep" | "discard" | "crash"
  description: string
  measurement_duration_ms?: number
}

export interface RunFixtureConfig {
  run_id: string
  phase?: string
  experiment_number?: number
  best_metric?: number
  best_experiment?: number
  total_keeps?: number
  total_discards?: number
  total_crashes?: number
  started_at?: string
  termination_reason?: string | null
  results?: ResultFixture[]
}

export interface ProjectConfigFixture {
  executionModel?: { provider: string; model: string; effort: string }
  supportModel?: { provider: string; model: string; effort: string }
  ideasBacklogEnabled?: boolean
  notificationCommand?: string | null
}

const DEFAULT_PROGRAM_CONFIG: ProgramFixtureConfig = {
  metric_field: "score",
  direction: "lower",
  noise_threshold: 0.02,
  repeats: 1,
  max_experiments: 10,
  quality_gates: {},
}

const DEFAULT_PROJECT_CONFIG: ProjectConfigFixture = {
  executionModel: { provider: "claude", model: "sonnet", effort: "high" },
  supportModel: { provider: "claude", model: "sonnet", effort: "high" },
  ideasBacklogEnabled: true,
  notificationCommand: null,
}

export async function createTestFixture(): Promise<TestFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "autoauto-e2e-"))

  // Initialize a git repo with an initial commit
  await $`git init`.cwd(cwd).quiet()
  await $`git config user.email "test@test.com"`.cwd(cwd).quiet()
  await $`git config user.name "Test User"`.cwd(cwd).quiet()
  await Bun.write(join(cwd, "README.md"), "# test repo\n")
  await $`git add -A`.cwd(cwd).quiet()
  await $`git commit -m "init"`.cwd(cwd).quiet()

  // Create .autoauto directory
  const autoautoDir = join(cwd, ".autoauto")
  await mkdir(autoautoDir, { recursive: true })
  await mkdir(join(autoautoDir, "programs"), { recursive: true })

  // Write default project config
  await Bun.write(
    join(autoautoDir, "config.json"),
    JSON.stringify(DEFAULT_PROJECT_CONFIG, null, 2),
  )

  async function createProgram(slug: string, config: ProgramFixtureConfig): Promise<string> {
    const merged = { ...DEFAULT_PROGRAM_CONFIG, ...config }
    const programDir = join(autoautoDir, "programs", slug)
    await mkdir(programDir, { recursive: true })
    await Bun.write(
      join(programDir, "config.json"),
      JSON.stringify({
        metric_field: merged.metric_field,
        direction: merged.direction,
        noise_threshold: merged.noise_threshold,
        repeats: merged.repeats,
        max_experiments: merged.max_experiments,
        quality_gates: merged.quality_gates,
      }, null, 2),
    )
    // Write a minimal measure script
    const measureScript = merged.measureScript ?? `#!/bin/bash\necho '{"score": 42}'`
    await Bun.write(join(programDir, "measure"), measureScript)
    const { chmod } = await import("node:fs/promises")
    await chmod(join(programDir, "measure"), 0o755)

    return programDir
  }

  async function createRun(slug: string, run: RunFixtureConfig): Promise<string> {
    const programDir = join(autoautoDir, "programs", slug)
    const runDir = join(programDir, "runs", run.run_id)
    await mkdir(runDir, { recursive: true })

    const state = {
      run_id: run.run_id,
      program_slug: slug,
      phase: run.phase ?? "complete",
      experiment_number: run.experiment_number ?? 0,
      original_baseline: 100,
      current_baseline: 100,
      best_metric: run.best_metric ?? 100,
      best_experiment: run.best_experiment ?? 0,
      total_keeps: run.total_keeps ?? 0,
      total_discards: run.total_discards ?? 0,
      total_crashes: run.total_crashes ?? 0,
      branch_name: `autoauto-${slug}-${run.run_id}`,
      original_baseline_sha: "0000000000000000",
      last_known_good_sha: "0000000000000000",
      candidate_sha: null,
      started_at: run.started_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      termination_reason: run.termination_reason ?? null,
    }

    await Bun.write(join(runDir, "state.json"), JSON.stringify(state, null, 2))

    // Write results.tsv with proper header matching parseTsvRow expectations
    const header = "experiment\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats"
    const rows = (run.results ?? []).map((r) =>
      `${r.experiment_number}\t${r.commit}\t${r.metric_value}\t\t${r.status}\t${r.description}\t${r.measurement_duration_ms ?? 5000}\t`,
    )
    await Bun.write(join(runDir, "results.tsv"), [header, ...rows, ""].join("\n"))

    return runDir
  }

  async function writeProjectConfig(config: ProjectConfigFixture): Promise<void> {
    const merged = { ...DEFAULT_PROJECT_CONFIG, ...config }
    await Bun.write(
      join(autoautoDir, "config.json"),
      JSON.stringify(merged, null, 2),
    )
  }

  async function cleanup(): Promise<void> {
    await rm(cwd, { recursive: true, force: true })
  }

  return { cwd, createProgram, createRun, writeProjectConfig, cleanup }
}
