import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  appendIdeasBacklog,
  parseExperimentNotes,
  readIdeasBacklogSummary,
} from "./ideas-backlog.ts"

describe("ideas backlog", () => {
  test("parses orchestrator notes block", () => {
    const notes = parseExperimentNotes(`
done
<autoauto_notes>
{"hypothesis":"cache hot path","why":"avoids repeated work","avoid":["global cache"],"next":["try local memo"]}
</autoauto_notes>
`)

    expect(notes).toEqual({
      hypothesis: "cache hot path",
      why: "avoids repeated work",
      avoid: ["global cache"],
      next: ["try local memo"],
    })
  })

  test("writes readable experiment entries", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "autoauto-ideas-"))
    try {
      await appendIdeasBacklog(runDir, {
        experiment_number: 1,
        commit: "abc1234",
        metric_value: 42,
        secondary_values: "",
        status: "discard",
        description: "noise: cache hot path",
        measurement_duration_ms: 100,
      }, {
        hypothesis: "cache hot path",
        why: "within noise",
        avoid: ["global cache"],
        next: ["try local memo"],
      })

      const raw = await readFile(join(runDir, "ideas.md"), "utf-8")
      expect(raw).toContain("# Ideas Backlog")
      expect(raw).toContain("## Experiment #1 - discard")
      expect(await readIdeasBacklogSummary(runDir)).toContain("try local memo")
    } finally {
      await rm(runDir, { recursive: true, force: true })
    }
  })
})
