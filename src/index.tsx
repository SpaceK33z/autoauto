#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { setProvider } from "./lib/agent/index.ts"
import { ClaudeProvider } from "./lib/agent/claude-provider.ts"
import { App } from "./App.tsx"

setProvider(new ClaudeProvider())

const renderer = await createCliRenderer({ exitOnCtrlC: false })
createRoot(renderer).render(<App />)
