import { mkdir, readdir, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getProvider, type AgentProviderID } from "./agent/index.ts"
import { loadProjectConfig, type EffortLevel, type ModelSlot } from "./config.ts"
import type { DraftMessage } from "./drafts.ts"
import { formatToolEvent } from "./tool-events.ts"
import { getSetupSystemPrompt } from "./system-prompts/index.ts"
import { getUpdateSystemPrompt } from "./system-prompts/update.ts"
import { buildUpdateRunContext } from "./run-context.ts"
import { AUTOAUTO_DIR, getProgramDir, getProjectRoot, loadProgramSummaries } from "./programs.ts"

const MCP_SESSION_DIR = "_mcp_sessions"
const SESSION_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]

export type McpConversationKind = "setup" | "update"
export type McpSetupMode = "direct" | "analyze"

export interface McpConversationSession {
  id: string
  kind: McpConversationKind
  programSlug: string | null
  createdAt: string
  updatedAt: string
  provider: AgentProviderID
  model: string
  effort: EffortLevel
  systemPrompt: string
  messages: DraftMessage[]
  sdkSessionId: string | null
}

export interface McpConversationTurnResult {
  assistantMessage: string
  toolEvents: string[]
  messages: DraftMessage[]
  sessionId: string
}

interface SessionModelOverrides {
  provider?: AgentProviderID
  model?: string
  effort?: EffortLevel
}

async function getSessionDir(cwd: string): Promise<string> {
  const root = await getProjectRoot(cwd)
  return join(root, AUTOAUTO_DIR, MCP_SESSION_DIR)
}

async function getSessionPath(cwd: string, sessionId: string): Promise<string> {
  return join(await getSessionDir(cwd), `${sessionId}.json`)
}

async function saveSession(cwd: string, session: McpConversationSession): Promise<void> {
  const dir = await getSessionDir(cwd)
  await mkdir(dir, { recursive: true })
  const path = await getSessionPath(cwd, session.id)
  const tmpPath = `${path}.tmp`
  await Bun.write(tmpPath, JSON.stringify(session, null, 2) + "\n")
  await rename(tmpPath, path)
}

export async function loadSession(cwd: string, sessionId: string): Promise<McpConversationSession | null> {
  try {
    return await Bun.file(await getSessionPath(cwd, sessionId)).json() as McpConversationSession
  } catch {
    return null
  }
}

export async function listSessions(cwd: string): Promise<McpConversationSession[]> {
  const dir = await getSessionDir(cwd)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const sessions = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => loadSession(cwd, entry.slice(0, -5))),
    )
  ).filter((session): session is McpConversationSession => session !== null)

  return sessions.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function deleteSession(cwd: string, sessionId: string): Promise<void> {
  await unlink(await getSessionPath(cwd, sessionId)).catch(() => {})
}

function buildTranscriptSystemPrompt(systemPrompt: string, messages: DraftMessage[]): string {
  if (messages.length === 0) return systemPrompt

  const transcript = messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n")

  return [
    systemPrompt,
    "",
    "---",
    "Here is the conversation so far from a previous session. Continue from where we left off:",
    "",
    transcript,
    "---",
  ].join("\n")
}

async function resolveSupportModel(cwd: string, overrides: SessionModelOverrides): Promise<ModelSlot> {
  const root = await getProjectRoot(cwd)
  const projectConfig = await loadProjectConfig(root)
  const supportModel = projectConfig.supportModel
  return {
    provider: overrides.provider ?? supportModel.provider,
    model: overrides.model ?? supportModel.model,
    effort: overrides.effort ?? supportModel.effort,
  }
}

async function ensureReferenceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, content)
}

async function runTurn(cwd: string, session: McpConversationSession, userMessage: string): Promise<McpConversationTurnResult> {
  const message = userMessage.trim()
  if (!message) throw new Error("Message cannot be empty.")

  session.messages.push({ role: "user", content: message })
  session.updatedAt = new Date().toISOString()
  await saveSession(cwd, session)

  const canResumeClaude = session.provider === "claude" && Boolean(session.sdkSessionId)
  const provider = getProvider(session.provider)
  const agentSession = provider.createSession({
    systemPrompt: canResumeClaude
      ? session.systemPrompt
      : buildTranscriptSystemPrompt(session.systemPrompt, session.messages.slice(0, -1)),
    tools: SESSION_TOOLS,
    allowedTools: SESSION_TOOLS,
    cwd,
    model: session.model,
    effort: session.effort,
    resumeSessionId: canResumeClaude ? session.sdkSessionId ?? undefined : undefined,
  })

  const toolEvents: string[] = []
  let assistantMessage = ""
  let turnError: string | null = null

  try {
    agentSession.pushMessage(message)
    agentSession.endInput()

    for await (const event of agentSession) {
      if (agentSession.sessionId) session.sdkSessionId = agentSession.sessionId

      switch (event.type) {
        case "text_delta":
          assistantMessage += event.text
          break
        case "tool_use":
          toolEvents.push(formatToolEvent(event.tool, event.input ?? {}))
          break
        case "assistant_complete":
          assistantMessage = event.text
          break
        case "error":
          turnError = event.error
          break
        case "result":
          if (!event.success) {
            turnError = event.error ?? "Agent turn failed."
          }
          break
      }
    }
  } finally {
    agentSession.close()
  }

  if (agentSession.sessionId) session.sdkSessionId = agentSession.sessionId

  if (turnError) {
    session.updatedAt = new Date().toISOString()
    await saveSession(cwd, session)
    throw new Error(turnError)
  }

  const finalAssistantMessage = assistantMessage.trim()
  if (finalAssistantMessage) {
    session.messages.push({ role: "assistant", content: finalAssistantMessage })
  }
  session.updatedAt = new Date().toISOString()
  await saveSession(cwd, session)

  return {
    assistantMessage: finalAssistantMessage,
    toolEvents,
    messages: session.messages,
    sessionId: session.id,
  }
}

export async function startSetupSession(
  cwd: string,
  options: SessionModelOverrides & { mode: McpSetupMode; message?: string; focus?: string },
): Promise<{
  session: McpConversationSession
  firstTurn: McpConversationTurnResult | null
}> {
  const root = await getProjectRoot(cwd)
  const existingPrograms = await loadProgramSummaries(root)
  const prompt = getSetupSystemPrompt(root, existingPrograms)
  await ensureReferenceFile(prompt.referencePath, prompt.referenceContent)

  const model = await resolveSupportModel(root, options)
  const now = new Date().toISOString()
  const session: McpConversationSession = {
    id: crypto.randomUUID(),
    kind: "setup",
    programSlug: null,
    createdAt: now,
    updatedAt: now,
    provider: model.provider,
    model: model.model,
    effort: model.effort,
    systemPrompt: prompt.systemPrompt,
    messages: [],
    sdkSessionId: null,
  }
  await saveSession(root, session)

  const firstMessage = options.mode === "analyze"
    ? (options.focus?.trim()
        ? `What could I optimize in this codebase, focusing on ${options.focus.trim()}?`
        : "What could I optimize in this codebase?")
    : options.message?.trim() ?? ""

  return {
    session,
    firstTurn: firstMessage ? await runTurn(root, session, firstMessage) : null,
  }
}

export async function startUpdateSession(
  cwd: string,
  programSlug: string,
  options: SessionModelOverrides = {},
): Promise<{
  session: McpConversationSession
  firstTurn: McpConversationTurnResult
}> {
  const root = await getProjectRoot(cwd)
  const programDir = getProgramDir(root, programSlug)
  const prompt = await getUpdateSystemPrompt(root, programSlug, programDir)
  await ensureReferenceFile(prompt.referencePath, prompt.referenceContent)

  const model = await resolveSupportModel(root, options)
  const now = new Date().toISOString()
  const session: McpConversationSession = {
    id: crypto.randomUUID(),
    kind: "update",
    programSlug,
    createdAt: now,
    updatedAt: now,
    provider: model.provider,
    model: model.model,
    effort: model.effort,
    systemPrompt: prompt.systemPrompt,
    messages: [],
    sdkSessionId: null,
  }
  await saveSession(root, session)

  const initialContext = await buildUpdateRunContext(programDir)

  return {
    session,
    firstTurn: await runTurn(root, session, initialContext),
  }
}

export async function sendSessionMessage(
  cwd: string,
  sessionId: string,
  message: string,
): Promise<McpConversationTurnResult> {
  const root = await getProjectRoot(cwd)
  const session = await loadSession(root, sessionId)
  if (!session) throw new Error(`Session "${sessionId}" not found.`)
  return runTurn(root, session, message)
}
