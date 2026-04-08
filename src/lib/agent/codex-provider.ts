import { $ } from "bun"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import {
  Codex,
  type ModelReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk"
import { createPushStream } from "../push-stream.ts"
import type {
  AgentCost,
  AgentEvent,
  AgentModelOption,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AuthResult,
} from "./types.ts"

const CODEX_DEFAULT_MODEL = "default"
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
}
const require = createRequire(import.meta.url)

function getCodexBinPath(): string {
  const targetTriple = getCodexTargetTriple()
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple]
  if (!platformPackage) throw new Error(`Unsupported Codex target triple: ${targetTriple}`)

  const packageJsonPath = require.resolve(`${platformPackage}/package.json`)
  const vendorRoot = join(dirname(packageJsonPath), "vendor")
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex"
  return join(vendorRoot, targetTriple, "codex", binaryName)
}

function getCodexTargetTriple(): string {
  switch (process.platform) {
    case "darwin":
      if (process.arch === "arm64") return "aarch64-apple-darwin"
      if (process.arch === "x64") return "x86_64-apple-darwin"
      break
    case "linux":
    case "android":
      if (process.arch === "arm64") return "aarch64-unknown-linux-musl"
      if (process.arch === "x64") return "x86_64-unknown-linux-musl"
      break
    case "win32":
      if (process.arch === "arm64") return "aarch64-pc-windows-msvc"
      if (process.arch === "x64") return "x86_64-pc-windows-msvc"
      break
  }

  throw new Error(`Unsupported Codex platform: ${process.platform} (${process.arch})`)
}

function normalizeModel(model: string | undefined): string | undefined {
  if (!model || model === CODEX_DEFAULT_MODEL) return undefined
  return model
}

function mapEffort(effort: string | undefined): ModelReasoningEffort | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return effort
    case "max":
      return "xhigh"
    default:
      return undefined
  }
}

function stringProviderOption<T extends string>(
  config: AgentSessionConfig,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = config.providerOptions?.[key]
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? value as T
    : undefined
}

function booleanProviderOption(config: AgentSessionConfig, key: string): boolean | undefined {
  const value = config.providerOptions?.[key]
  return typeof value === "boolean" ? value : undefined
}

function hasWriteTools(config: AgentSessionConfig): boolean {
  const tools = config.allowedTools ?? config.tools ?? []
  return tools.some((tool) => {
    const normalized = tool.toLowerCase()
    return normalized === "write" || normalized === "edit"
  })
}

function buildThreadOptions(config: AgentSessionConfig): ThreadOptions {
  const sandboxMode =
    stringProviderOption(config, "sandboxMode", ["read-only", "workspace-write", "danger-full-access"] as const)
    ?? (hasWriteTools(config) ? "danger-full-access" : "read-only")

  return {
    model: normalizeModel(config.model),
    modelReasoningEffort: mapEffort(config.effort),
    workingDirectory: config.cwd,
    approvalPolicy: stringProviderOption(config, "approvalPolicy", ["never", "on-request", "on-failure", "untrusted"] as const) ?? "never",
    sandboxMode,
    networkAccessEnabled: booleanProviderOption(config, "networkAccessEnabled") ?? true,
    skipGitRepoCheck: booleanProviderOption(config, "skipGitRepoCheck"),
  }
}

function buildPrompt(config: AgentSessionConfig, prompt: string, isFirstTurn: boolean): string {
  const systemPrompt = config.systemPrompt?.trim()
  if (!systemPrompt || !isFirstTurn) return prompt

  return [
    "System instructions:",
    systemPrompt,
    "",
    "User request:",
    prompt,
  ].join("\n")
}

function getItemText(item: ThreadItem): string | null {
  return item.type === "agent_message" ? item.text : null
}

function getToolUse(item: ThreadItem): { tool: string; input?: Record<string, unknown> } | null {
  switch (item.type) {
    case "command_execution":
      return {
        tool: "Bash",
        input: {
          command: item.command,
          status: item.status,
          exit_code: item.exit_code,
        },
      }
    case "file_change":
      return {
        tool: "Edit",
        input: {
          file_path: item.changes[0]?.path,
          changes: item.changes,
          status: item.status,
        },
      }
    case "mcp_tool_call":
      return {
        tool: `${item.server}.${item.tool}`,
        input: {
          arguments: item.arguments,
          status: item.status,
        },
      }
    case "web_search":
      return {
        tool: "WebSearch",
        input: { query: item.query },
      }
    default:
      return null
  }
}

function extractCost(usage: Usage, startedAt: number, numTurns: number): AgentCost {
  return {
    total_cost_usd: 0,
    duration_ms: Date.now() - startedAt,
    duration_api_ms: 0,
    num_turns: numTurns,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  }
}

class CodexSession implements AgentSession {
  private input = createPushStream<string>()
  private events = createPushStream<AgentEvent>()
  private abortController = new AbortController()
  private externalSignal?: AbortSignal
  private signalHandler?: () => void
  private closed = false
  private thread: Thread
  private turnCount = 0

  constructor(
    codex: Codex,
    private config: AgentSessionConfig,
  ) {
    this.thread = codex.startThread(buildThreadOptions(config))

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
        const error = err instanceof Error ? err.message : String(err)
        this.events.push({ type: "error", error, retriable: false })
        this.events.push({ type: "result", success: false, error })
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
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    yield* this.events
  }

  private async run(): Promise<void> {
    for await (const rawPrompt of this.input) {
      if (this.closed || this.abortController.signal.aborted) break

      if (this.config.maxTurns != null && this.turnCount >= this.config.maxTurns) {
        const error = `Codex session exceeded maxTurns (${this.config.maxTurns})`
        this.events.push({ type: "error", error, retriable: false })
        this.events.push({ type: "result", success: false, error })
        break
      }

      const prompt = buildPrompt(this.config, rawPrompt, this.turnCount === 0)
      await this.runTurn(prompt)
    }

    this.events.end()
  }

  private async runTurn(prompt: string): Promise<void> {
    const startedAt = Date.now()
    this.turnCount += 1
    const textByItemID = new Map<string, string>()
    const emittedTools = new Set<string>()

    try {
      const { events } = await this.thread.runStreamed(prompt, {
        signal: this.abortController.signal,
      })

      for await (const event of events) {
        if (this.closed || this.abortController.signal.aborted) break
        this.handleEvent(event, textByItemID, emittedTools, startedAt)
      }
    } catch (err: unknown) {
      if (!this.closed && !this.abortController.signal.aborted) {
        const error = err instanceof Error ? err.message : String(err)
        this.events.push({ type: "error", error, retriable: false })
        this.events.push({ type: "result", success: false, error })
      }
    }
  }

  private handleEvent(
    event: ThreadEvent,
    textByItemID: Map<string, string>,
    emittedTools: Set<string>,
    startedAt: number,
  ): void {
    switch (event.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.handleItem(event.item, event.type, textByItemID, emittedTools)
        break
      case "turn.completed":
        this.events.push({
          type: "result",
          success: true,
          cost: extractCost(event.usage, startedAt, this.turnCount),
        })
        break
      case "turn.failed":
        this.events.push({ type: "error", error: event.error.message, retriable: false })
        this.events.push({ type: "result", success: false, error: event.error.message })
        break
      case "error":
        this.events.push({ type: "error", error: event.message, retriable: false })
        this.events.push({ type: "result", success: false, error: event.message })
        break
    }
  }

  private handleItem(
    item: ThreadItem,
    eventType: "item.started" | "item.updated" | "item.completed",
    textByItemID: Map<string, string>,
    emittedTools: Set<string>,
  ): void {
    const text = getItemText(item)
    if (text != null) {
      const previous = textByItemID.get(item.id) ?? ""
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text
      textByItemID.set(item.id, text)
      if (delta) this.events.push({ type: "text_delta", text: delta })
      if (eventType === "item.completed" && text.trim()) {
        this.events.push({ type: "assistant_complete", text })
      }
      return
    }

    if (item.type === "error") {
      this.events.push({ type: "error", error: item.message, retriable: false })
      return
    }

    const toolUse = getToolUse(item)
    if (!toolUse) return

    const status = "status" in item ? item.status : eventType
    const key = `${item.id}:${item.type}:${status}`
    if (emittedTools.has(key)) return
    emittedTools.add(key)
    this.events.push({ type: "tool_use", ...toolUse })
  }
}

export class CodexProvider implements AgentProvider {
  readonly name = "codex"
  private codex = new Codex()

  async listModels(): Promise<AgentModelOption[]> {
    return [
      {
        provider: "codex",
        model: CODEX_DEFAULT_MODEL,
        label: "Codex / Default",
        description: "Configured Codex CLI default model",
        isDefault: true,
      },
    ]
  }

  async getDefaultModel(): Promise<string> {
    return CODEX_DEFAULT_MODEL
  }

  createSession(config: AgentSessionConfig): AgentSession {
    return new CodexSession(this.codex, config)
  }

  runOnce(prompt: string, config: AgentSessionConfig): AgentSession {
    const session = this.createSession(config)
    session.pushMessage(prompt)
    session.endInput()
    return session
  }

  async checkAuth(): Promise<AuthResult> {
    const codexBinPath = getCodexBinPath()
    const [statusResult, versionResult] = await Promise.all([
      $`${codexBinPath} login status`.nothrow().quiet(),
      $`${codexBinPath} --version`.nothrow().quiet(),
    ])

    const status = `${statusResult.stdout.toString()}${statusResult.stderr.toString()}`.trim()
    const version = `${versionResult.stdout.toString()}${versionResult.stderr.toString()}`.trim()

    if (statusResult.exitCode === 0) {
      return {
        authenticated: true,
        account: {
          provider: "codex",
          status,
          version,
        },
      }
    }

    return {
      authenticated: false,
      error: status || `Codex login status exited with code ${statusResult.exitCode}`,
    }
  }
}
