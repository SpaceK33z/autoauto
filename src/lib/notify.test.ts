import { afterEach, describe, expect, test } from "bun:test"
import { interpolateTemplate, sendNotification } from "./notify.ts"
import type { RunState } from "./run.ts"

const TEST_STATE: RunState = {
  run_id: "20260408-120000",
  program_slug: "example-program",
  phase: "complete",
  experiment_number: 12,
  original_baseline: 100,
  current_baseline: 115,
  best_metric: 115,
  best_experiment: 8,
  total_keeps: 5,
  total_discards: 6,
  total_crashes: 1,
  branch_name: "autoauto-example-20260408",
  original_baseline_sha: "abc1234",
  last_known_good_sha: "def5678",
  candidate_sha: null,
  started_at: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  updated_at: new Date().toISOString(),
  termination_reason: "max_experiments",
  error: null,
  error_phase: null,
}

const originalStderrWrite = process.stderr.write.bind(process.stderr)
let stderrOutput = ""

afterEach(() => {
  stderrOutput = ""
  process.stderr.write = originalStderrWrite
})

describe("interpolateTemplate", () => {
  test("escapes values inside single-quoted shell strings", () => {
    expect(interpolateTemplate(
      `osascript -e 'display notification "{{program}}" with title "AutoAuto"'`,
      { program: `O'Reilly $(touch /tmp/pwned)` },
    )).toBe(
      `osascript -e 'display notification "O'\\''Reilly $(touch /tmp/pwned)" with title "AutoAuto"'`,
    )
  })

  test("escapes values inside double-quoted shell strings", () => {
    expect(interpolateTemplate(
      `printf "%s" "{{program}}"`,
      { program: String.raw`"$HOME" \`whoami\`` },
    )).toBe(
      String.raw`printf "%s" "\"\$HOME\" \\\`whoami\\\`"`,
    )
  })
})

describe("sendNotification", () => {
  test("returns true on success", async () => {
    expect(await sendNotification(`printf "%s" "{{program}}" >/dev/null`, TEST_STATE)).toBe(true)
  })

  test("returns false and logs stderr on command failure", async () => {
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      return true
    }) as typeof process.stderr.write

    expect(await sendNotification(`echo boom >&2; exit 7`, TEST_STATE)).toBe(false)
    expect(stderrOutput).toContain("[notify] Command failed (7): boom")
  })
})
