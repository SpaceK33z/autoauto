import { setProvider } from "./index.ts"
import { ClaudeProvider } from "./claude-provider.ts"
import { OpenCodeProvider } from "./opencode-provider.ts"
import { CodexProvider } from "./codex-provider.ts"

export function registerDefaultProviders(): void {
  setProvider("claude", new ClaudeProvider())
  setProvider("opencode", new OpenCodeProvider())
  setProvider("codex", new CodexProvider())
}
