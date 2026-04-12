import { mkdir, chmod } from "node:fs/promises"
import { join } from "node:path"

// --- Measurement Locking ---

/** Files protected from agent modification during experiment runs. */
export const MEASUREMENT_FILES = ["measure.sh", "config.json", "build.sh"] as const

/** Makes measurement files read-only (chmod 444). #1 safeguard against metric gaming. */
export async function lockMeasurement(programDir: string): Promise<void> {
  await Promise.all(
    MEASUREMENT_FILES.map((f) => chmod(join(programDir, f), 0o444).catch(() => {})),
  )
}

export async function unlockMeasurement(programDir: string): Promise<void> {
  await Promise.all(
    MEASUREMENT_FILES.map((f) => chmod(join(programDir, f), 0o644).catch(() => {})),
  )
}

// --- Run Directory ---

export async function initRunDir(programDir: string, runId: string): Promise<string> {
  const runDir = join(programDir, "runs", runId)
  await mkdir(runDir, { recursive: true })

  await Bun.write(
    join(runDir, "results.tsv"),
    "experiment#\tcommit\tmetric_value\tsecondary_values\tstatus\tdescription\tmeasurement_duration_ms\tdiff_stats\tp_value\tp_min\n",
  )

  return runDir
}
