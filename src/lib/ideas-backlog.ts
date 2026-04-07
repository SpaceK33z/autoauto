import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExperimentResult } from "./run.ts"

export interface ExperimentNotes {
  hypothesis?: string
  why?: string
  next?: string[]
  avoid?: string[]
}

const BACKLOG_FILE = "ideas.md"
const MAX_FIELD_LENGTH = 500
const MAX_ITEMS = 5

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  return normalized.slice(0, MAX_FIELD_LENGTH)
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .map(cleanText)
    .filter((item): item is string => item != null)
    .slice(0, MAX_ITEMS)
  return items.length > 0 ? items : undefined
}

export function parseExperimentNotes(text: string): ExperimentNotes | undefined {
  const match = text.match(/<autoauto_notes>\s*([\s\S]*?)\s*<\/autoauto_notes>/)
  if (!match) return undefined

  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>
    const notes: ExperimentNotes = {
      hypothesis: cleanText(raw.hypothesis),
      why: cleanText(raw.why),
      next: cleanList(raw.next),
      avoid: cleanList(raw.avoid),
    }
    return Object.values(notes).some((value) => value != null) ? notes : undefined
  } catch {
    return undefined
  }
}

function listLines(items: string[] | undefined, fallback: string): string[] {
  if (!items || items.length === 0) return [`  - ${fallback}`]
  return items.map((item) => `  - ${item}`)
}

function formatEntry(result: ExperimentResult, notes?: ExperimentNotes): string {
  const tried = notes?.hypothesis ?? result.description
  const agentNote = notes?.why ?? "No agent note captured."

  return [
    `## Experiment #${result.experiment_number} - ${result.status}`,
    `- Commit: ${result.commit}`,
    `- Metric: ${result.metric_value}`,
    `- Result: ${result.description}`,
    `- Tried: ${tried}`,
    `- Agent note: ${agentNote}`,
    "- Avoid:",
    ...listLines(notes?.avoid, "No specific avoid note captured."),
    "- Try next:",
    ...listLines(notes?.next, "No specific next idea captured."),
    "",
  ].join("\n")
}

async function ensureHeader(runDir: string): Promise<void> {
  const path = join(runDir, BACKLOG_FILE)
  if (await Bun.file(path).exists()) return
  await appendFile(
      path,
      [
        "# Ideas Backlog",
        "",
        "Append-only experiment memory. Captures what was tried, why it worked or failed, and what to try next.",
        "",
      ].join("\n"),
    )
}

export async function appendIdeasBacklog(
  runDir: string,
  result: ExperimentResult,
  notes?: ExperimentNotes,
): Promise<void> {
  if (result.experiment_number === 0) return
  await ensureHeader(runDir)
  await appendFile(join(runDir, BACKLOG_FILE), formatEntry(result, notes))
}

export async function readIdeasBacklogSummary(runDir: string, maxChars = 4000): Promise<string> {
  try {
    const raw = await Bun.file(join(runDir, BACKLOG_FILE)).text()
    if (raw.length <= maxChars) return raw.trim()

    const tail = raw.slice(-maxChars)
    const firstEntry = tail.indexOf("\n## ")
    return (firstEntry >= 0 ? tail.slice(firstEntry + 1) : tail).trim()
  } catch {
    return ""
  }
}
