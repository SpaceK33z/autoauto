import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentEvent,
  AuthResult,
} from "./types.ts"

/**
 * Mock provider for contract tests.
 * Emits a scripted sequence of AgentEvent values, independent of any real SDK.
 */
export class MockProvider implements AgentProvider {
  readonly name = "mock"

  constructor(
    private events: AgentEvent[] = [],
    private authResult: AuthResult = { authenticated: true, account: { email: "test@example.com" } },
  ) {}

  createSession(_config: AgentSessionConfig): AgentSession {
    return new MockSession(this.events)
  }

  runOnce(_prompt: string, config: AgentSessionConfig): AgentSession {
    const session = this.createSession(config)
    session.endInput()
    return session
  }

  async checkAuth(): Promise<AuthResult> {
    return this.authResult
  }
}

class MockSession implements AgentSession {
  private messages: string[] = []
  private ended = false
  private closed = false

  constructor(private events: AgentEvent[]) {}

  pushMessage(content: string): void {
    this.messages.push(content)
  }

  endInput(): void {
    this.ended = true
  }

  close(): void {
    this.closed = true
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (const event of this.events) {
      if (this.closed) break
      yield event
    }
  }
}
