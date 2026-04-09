import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  AgentCost,
  AgentEvent,
  AgentModelOption,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AuthResult,
} from "./types.ts"
import { combineAgentCosts } from "./cost.ts"
import { createPushStream } from "../push-stream.ts"

type OpenCodeServer = Awaited<ReturnType<typeof createOpencode>>["server"]
type OpenCodeInstance = { client: OpencodeClient; server: OpenCodeServer }

type OpenCodeEvent = {
  type: string
  properties?: Record<string, unknown>
}

type OpenCodePart = {
  id?: string
  sessionID?: string
  messageID?: string
  type?: string
  text?: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
  }
}

type OpenCodeAssistantMessage = {
  cost?: number
  tokens?: {
    input?: number
    output?: number
  }
}

type OpenCodeSessionChild = {
  id: string
}

type OpenCodeSessionMessage = {
  info?: unknown
}

function parseModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`OpenCode model must be in provider/model form, got "${model}"`)
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function mapPermission(tool: string): string[] {
  switch (tool.toLowerCase()) {
    case "read":
      return ["read", "list"]
    case "write":
    case "edit":
      return ["edit"]
    case "bash":
      return ["bash"]
    case "glob":
      return ["glob", "list"]
    case "grep":
      return ["grep"]
    default:
      return []
  }
}

function buildPermissionRules(config: AgentSessionConfig) {
  const tools = config.allowedTools ?? config.tools ?? []
  const permissions = new Set<string>()
  for (const tool of tools) {
    for (const permission of mapPermission(tool)) {
      permissions.add(permission)
    }
  }

  return [
    ...[...permissions].toSorted().map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const,
    })),
    { permission: "external_directory", pattern: "*", action: "deny" as const },
  ]
}

function getTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts
    .flatMap((part) => {
      if (typeof part === "object" && part !== null && (part as OpenCodePart).type === "text") {
        const text = (part as OpenCodePart).text
        return typeof text === "string" ? [text] : []
      }
      return []
    })
    .join("")
}

function extractCost(
  info: unknown,
  startedAt: number,
  options?: { includeDuration?: boolean },
): AgentCost {
  const message = (typeof info === "object" && info !== null ? info : {}) as OpenCodeAssistantMessage
  const includeDuration = options?.includeDuration ?? true
  return {
    total_cost_usd: message.cost ?? 0,
    duration_ms: includeDuration ? Date.now() - startedAt : 0,
    duration_api_ms: 0,
    num_turns: 1,
    input_tokens: message.tokens?.input ?? 0,
    output_tokens: message.tokens?.output ?? 0,
  }
}

class OpenCodeSession implements AgentSession {
  private input = createPushStream<string>()
  private events = createPushStream<AgentEvent>()
  private abortController = new AbortController()
  private externalSignal?: AbortSignal
  private signalHandler?: () => void
  private closed = false
  private sessionID: string | null = null
  readonly sessionId = undefined

  constructor(
    private provider: OpenCodeProvider,
    private config: AgentSessionConfig,
  ) {
    if (config.signal) {
      if (config.signal.aborted) {
        this.abortController.abort()
      } else {
        this.externalSignal = config.signal
        this.signalHandler = () => this.close()
        config.signal.addEventListener("abort", this.signalHandler, { once: true })
      }
    }

    this.run().catch((err: unknown) => {
      if (!this.closed) {
        this.events.push({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
          retriable: false,
        })
        this.events.push({
          type: "result",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      this.events.end()
    })
  }

  pushMessage(content: string): void {
    if (this.closed) return
    this.input.push(content)
  }

  endInput(): void {
    this.input.end()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.externalSignal && this.signalHandler) {
      this.externalSignal.removeEventListener("abort", this.signalHandler)
    }
    this.abortController.abort()
    this.input.end()
    this.events.end()
    const sessionID = this.sessionID
    if (sessionID) {
      this.provider.abortSession(sessionID, this.config.cwd).catch(() => {})
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    yield* this.events
  }

  private async run(): Promise<void> {
    const { client } = await this.provider.getInstance()
    const directory = this.config.cwd
    const created = await client.session.create({
      directory,
      title: "AutoAuto",
      permission: buildPermissionRules(this.config),
    })
    if (created.error) {
      throw new Error(`Failed to create OpenCode session: ${JSON.stringify(created.error)}`)
    }
    if (!created.data) throw new Error("Failed to create OpenCode session")

    this.sessionID = created.data.id

    const eventAbort = new AbortController()
    const subscription = await client.event.subscribe(
      { directory },
      { signal: eventAbort.signal },
    )
    const consumeEvents = this.consumeEvents(
      subscription.stream as AsyncIterable<OpenCodeEvent>,
      created.data.id,
      eventAbort.signal,
    )

    try {
      for await (const prompt of this.input) {
        if (this.closed || this.abortController.signal.aborted) break

        const model = parseModel(this.config.model)
        const startedAt = Date.now()
        const result = await client.session.prompt(
          {
            sessionID: created.data.id,
            directory,
            agent: "build",
            system: this.config.systemPrompt,
            model,
            parts: [{ type: "text", text: prompt }],
          },
          { signal: this.abortController.signal },
        )

        if (result.error) {
          const error = JSON.stringify(result.error)
          this.events.push({ type: "error", error, retriable: false })
          this.events.push({ type: "result", success: false, error })
          continue
        }

        const text = getTextFromParts(result.data?.parts)
        if (text.trim()) {
          this.events.push({ type: "assistant_complete", text })
        }
        const rootCost = extractCost(result.data?.info, startedAt)
        const childCost = await this.aggregateChildCosts(client, created.data.id, startedAt)
        this.events.push({
          type: "result",
          success: true,
          cost: combineAgentCosts(rootCost, childCost) ?? rootCost,
        })
      }
    } finally {
      eventAbort.abort()
      await consumeEvents.catch(() => {})
      this.events.end()
    }
  }

  private async aggregateChildCosts(
    client: OpencodeClient,
    sessionID: string,
    rootStartedAt: number,
  ): Promise<AgentCost | undefined> {
    try {
      return await this.collectSessionTreeCost(client, sessionID, rootStartedAt)
    } catch {
      return undefined
    }
  }

  private async collectSessionTreeCost(
    client: OpencodeClient,
    sessionID: string,
    rootStartedAt: number,
  ): Promise<AgentCost | undefined> {
    const childSessions = await client.session.children({ sessionID })
    const childCosts = await Promise.all(
      ((childSessions.data ?? []) as OpenCodeSessionChild[]).map(async (child) => {
        const [messages, descendantCost] = await Promise.all([
          client.session.messages({ sessionID: child.id }),
          this.collectSessionTreeCost(client, child.id, rootStartedAt),
        ])

        const messageCosts = ((messages.data ?? []) as OpenCodeSessionMessage[])
          .map((message) => extractCost(message.info, rootStartedAt, { includeDuration: false }))

        return combineAgentCosts(...messageCosts, descendantCost)
      }),
    )

    return combineAgentCosts(...childCosts)
  }

  private async consumeEvents(
    stream: AsyncIterable<OpenCodeEvent>,
    sessionID: string,
    signal: AbortSignal,
  ): Promise<void> {
    const textByPartID = new Map<string, string>()
    const emittedTools = new Set<string>()

    for await (const event of stream) {
      if (this.closed || signal.aborted) break
      const properties = event.properties ?? {}
      if (properties.sessionID !== sessionID) continue

      if (event.type === "message.part.updated") {
        const part = properties.part as OpenCodePart | undefined
        if (!part?.id) continue

        if (part.type === "text" && typeof part.text === "string") {
          const previous = textByPartID.get(part.id) ?? ""
          const delta = part.text.startsWith(previous)
            ? part.text.slice(previous.length)
            : part.text
          textByPartID.set(part.id, part.text)
          if (delta) this.events.push({ type: "text_delta", text: delta })
        }

        if (part.type === "tool" && part.tool) {
          const status = part.state?.status ?? "unknown"
          const key = `${part.id}:${status}`
          if (!emittedTools.has(key)) {
            emittedTools.add(key)
            const state = part.state as {
              status?: string
              input?: Record<string, unknown>
              title?: string
            } | undefined
            const input: Record<string, unknown> = { ...state?.input }
            // Forward provider-supplied title for richer tool status display
            if (state?.title) input.__title = state.title
            this.events.push({
              type: "tool_use",
              tool: part.tool,
              input,
            })
          }
        }
      }

      if (event.type === "session.error") {
        this.events.push({
          type: "error",
          error: JSON.stringify(properties.error ?? "OpenCode session error"),
          retriable: false,
        })
      }
    }
  }
}

export class OpenCodeProvider implements AgentProvider {
  readonly name = "opencode"
  private instance: Promise<OpenCodeInstance> | null = null
  private resolvedInstance: OpenCodeInstance | null = null
  private modelCache: AgentModelOption[] | null = null

  async getInstance(): Promise<OpenCodeInstance> {
    if (!this.instance) {
      this.instance = this.startInstance()
    }
    return this.instance
  }

  createSession(config: AgentSessionConfig): AgentSession {
    return new OpenCodeSession(this, config)
  }

  runOnce(prompt: string, config: AgentSessionConfig): AgentSession {
    const session = this.createSession(config)
    session.pushMessage(prompt)
    session.endInput()
    return session
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const { client } = await this.getInstance()
      const health = await client.global.health({ throwOnError: true })
      return {
        authenticated: true,
        account: {
          provider: "opencode",
          version: health.data.version,
        },
      }
    } catch (err) {
      return {
        authenticated: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async listModels(cwd?: string, forceRefresh = false): Promise<AgentModelOption[]> {
    if (this.modelCache && !forceRefresh) return this.modelCache

    const { client } = await this.getInstance()
    const response = await client.provider.list({ directory: cwd }, { throwOnError: true })
    const connected = new Set(response.data.connected)
    const defaults = response.data.default
    const options: AgentModelOption[] = []

    for (const provider of response.data.all) {
      if (!connected.has(provider.id)) continue
      const defaultModel = defaults[provider.id]
      for (const [modelID, model] of Object.entries(provider.models)) {
        const fullModel = `${provider.id}/${modelID}`
        const isDefault = defaultModel === modelID
        options.push({
          provider: "opencode",
          model: fullModel,
          label: `OpenCode / ${provider.name} / ${model.name}`,
          description: isDefault ? "Configured OpenCode default" : fullModel,
          isDefault,
        })
      }
    }

    options.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.label.localeCompare(b.label)
    })

    this.modelCache = options
    return options
  }

  async getDefaultModel(cwd?: string): Promise<string | null> {
    const options = await this.listModels(cwd)
    return options.find((option) => option.isDefault)?.model ?? options[0]?.model ?? null
  }

  async abortSession(sessionID: string, cwd?: string): Promise<void> {
    const { client } = await this.getInstance()
    await client.session.abort({ sessionID, directory: cwd }).catch(() => {})
  }

  close(): void {
    this.resolvedInstance?.server.close()
    this.resolvedInstance = null
    this.instance = null
    this.modelCache = null
  }

  private async startInstance(): Promise<OpenCodeInstance> {
    const instance = await createOpencode({
      port: await getFreePort(),
      timeout: 10_000,
      config: { autoupdate: false },
    })
    this.resolvedInstance = instance
    return instance
  }
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok")
    },
  })
  const port = server.port
  if (port == null) throw new Error("Failed to allocate local OpenCode port")
  await server.stop()
  return port
}
