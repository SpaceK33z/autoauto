import { mkdir, readdir, unlink, rename } from "node:fs/promises"
import { join } from "node:path"
import { AUTOAUTO_DIR, getProjectRoot } from "./programs.ts"
import type { AgentProviderID } from "./agent/index.ts"
import type { EffortLevel } from "./config.ts"

// --- Types ---

export interface DraftMessage {
  role: "user" | "assistant"
  content: string
}

export interface DraftSession {
  type: "setup" | "update"
  programSlug: string | null
  createdAt: string
  provider: AgentProviderID
  model: string
  effort: EffortLevel
  sdkSessionId: string | null
  mode: "choose" | "scope" | "chat"
  initialMessage: string | null
  messages: DraftMessage[]
}

// --- Paths ---

const DRAFTS_DIR = "_drafts"

async function getDraftsDir(cwd: string): Promise<string> {
  const root = await getProjectRoot(cwd)
  return join(root, AUTOAUTO_DIR, DRAFTS_DIR)
}

async function getDraftPath(cwd: string, name: string): Promise<string> {
  return join(await getDraftsDir(cwd), `${name}.json`)
}

/** Generate a timestamp-based name for new setup drafts. */
function generateDraftName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `draft-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** Derive the draft filename: slug for updates, timestamp for new setups. */
export function draftFileName(draft: Pick<DraftSession, "type" | "programSlug">): string {
  if (draft.type === "update" && draft.programSlug) {
    return draft.programSlug
  }
  return generateDraftName()
}

// --- CRUD ---

export async function saveDraft(cwd: string, name: string, draft: DraftSession): Promise<void> {
  const dir = await getDraftsDir(cwd)
  await mkdir(dir, { recursive: true })
  const path = await getDraftPath(cwd, name)
  const tmpPath = `${path}.tmp`
  await Bun.write(tmpPath, JSON.stringify(draft, null, 2))
  await rename(tmpPath, path)
}

export async function loadDraft(cwd: string, name: string): Promise<DraftSession | null> {
  try {
    return (await Bun.file(await getDraftPath(cwd, name)).json()) as DraftSession
  } catch {
    return null
  }
}

export interface DraftEntry {
  name: string
  draft: DraftSession
}

export async function listDrafts(cwd: string): Promise<DraftEntry[]> {
  const dir = await getDraftsDir(cwd)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const names = entries.filter((e) => e.endsWith(".json")).map((e) => e.slice(0, -5))
  const results = (
    await Promise.all(
      names.map(async (name) => {
        const draft = await loadDraft(cwd, name)
        return draft ? { name, draft } : null
      }),
    )
  ).filter((r): r is DraftEntry => r !== null)

  // Most recent first
  results.sort((a, b) => b.draft.createdAt.localeCompare(a.draft.createdAt))
  return results
}

export async function deleteDraft(cwd: string, name: string): Promise<void> {
  const path = await getDraftPath(cwd, name)
  await unlink(path).catch(() => {})
}

/** Returns the single active draft, or null. Only one draft at a time. */
export async function getActiveDraft(cwd: string): Promise<DraftEntry | null> {
  const drafts = await listDrafts(cwd)
  return drafts[0] ?? null
}
