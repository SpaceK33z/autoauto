import { hasProvider, setProvider } from "./index.ts"
import { ClaudeProvider } from "./claude-provider.ts"
import { OpenCodeProvider } from "./opencode-provider.ts"
import { CodexProvider } from "./codex-provider.ts"

export function registerDefaultProviders(): void {
  const factories = [
    ["claude", () => new ClaudeProvider()],
    ["opencode", () => new OpenCodeProvider()],
    ["codex", () => new CodexProvider()],
  ] as const

  for (const [id, factory] of factories) {
    if (hasProvider(id)) continue
    try {
      setProvider(id, factory())
    } catch (err) {
      if (process.env.DEV) {
        process.stderr.write(`[providers] ${id} unavailable: ${err}\n`)
      }
    }
  }
}
