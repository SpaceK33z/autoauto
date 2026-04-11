import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  appendIdeasBacklog,
  extractExperimentIdeas,
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

describe("extractExperimentIdeas", () => {
  const SAMPLE_IDEAS = [
    "# Ideas Backlog",
    "",
    "Append-only experiment memory.",
    "",
    "## Experiment #1 - keep",
    "- Commit: abc1111",
    "- Metric: 95",
    "- Result: Optimize hot path",
    "- Tried: cache hot path",
    "- Agent note: within noise",
    "- Avoid:",
    "  - global cache",
    "- Try next:",
    "  - try local memo",
    "",
    "## Experiment #2 - discard",
    "- Commit: abc2222",
    "- Metric: 110",
    "- Result: Try caching",
    "- Tried: add redis",
    "- Agent note: too slow",
    "- Avoid:",
    "  - external deps",
    "- Try next:",
    "  - in-memory LRU",
    "",
    "## Experiment #3 - keep",
    "- Commit: abc3333",
    "- Metric: 88",
    "- Result: Reduce allocations",
    "- Tried: pool buffers",
    "- Agent note: 7% improvement",
    "- Avoid:",
    "  - No specific avoid note captured.",
    "- Try next:",
    "  - No specific next idea captured.",
    "",
  ].join("\n")

  test("extracts a middle experiment section", () => {
    const result = extractExperimentIdeas(SAMPLE_IDEAS, 2)
    expect(result).toContain("## Experiment #2 - discard")
    expect(result).toContain("add redis")
    expect(result).toContain("in-memory LRU")
    // Should NOT contain other experiments
    expect(result).not.toContain("## Experiment #1")
    expect(result).not.toContain("## Experiment #3")
  })

  test("extracts the first experiment section", () => {
    const result = extractExperimentIdeas(SAMPLE_IDEAS, 1)
    expect(result).toContain("## Experiment #1 - keep")
    expect(result).toContain("cache hot path")
    expect(result).not.toContain("## Experiment #2")
  })

  test("extracts the last experiment section", () => {
    const result = extractExperimentIdeas(SAMPLE_IDEAS, 3)
    expect(result).toContain("## Experiment #3 - keep")
    expect(result).toContain("pool buffers")
    expect(result).not.toContain("## Experiment #2")
  })

  test("returns empty string for non-existent experiment", () => {
    expect(extractExperimentIdeas(SAMPLE_IDEAS, 99)).toBe("")
  })

  test("returns empty string for empty input", () => {
    expect(extractExperimentIdeas("", 1)).toBe("")
  })

  test("handles single-experiment file", () => {
    const single = "# Ideas\n\n## Experiment #1 - keep\n- Tried: something\n"
    const result = extractExperimentIdeas(single, 1)
    expect(result).toContain("## Experiment #1 - keep")
    expect(result).toContain("something")
  })
})
