#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { registerDefaultProviders } from "./lib/agent/default-providers.ts"
import { registerDefaultContainerProviders } from "./lib/container-provider/index.ts"
import { App } from "./App.tsx"

registerDefaultProviders()
registerDefaultContainerProviders()

const renderer = await createCliRenderer({ exitOnCtrlC: false })

// Copy-on-select: when the user finishes a mouse selection, copy to clipboard via OSC 52
renderer.on("selection", (selection: { getSelectedText(): string }) => {
  const text = selection.getSelectedText()
  if (text) renderer.copyToClipboardOSC52(text)
})

createRoot(renderer).render(<App />)
