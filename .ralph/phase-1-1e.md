# Phase 1, Section 1e: Model Configuration & Auth — Implementation Plan

## Goal

Add two capabilities: (1) model configuration for the two model slots (execution and support) with model choice and effort level, persisted in `.autoauto/config.json`; (2) authentication checking on startup with a helpful error state when the user isn't authenticated.

## Section 1e Tasks (from phase-1.md)

1. Configure execution model slot (Sonnet/Opus + throughput tier)
2. Configure support model slot (Sonnet/Opus + throughput tier)
3. Auth: Check for `ANTHROPIC_API_KEY` on startup
4. Auth: Prompt user to run `claude setup-token` if missing (but only if not authenticated)

## Current State

**Setup flow (1a + 1b + 1c + 1d) is fully implemented:**

- `src/components/Chat.tsx` — Multi-turn chat with streaming, tool status, `bypassPermissions`, Write/Edit tools
- `src/screens/SetupScreen.tsx` — Passes agent config: `tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"]`, `maxTurns=40`, system prompt
- `src/lib/system-prompts.ts` — `getSetupSystemPrompt(cwd)` with full setup flow including artifact generation + measurement validation
- `src/lib/programs.ts` — `getProjectRoot()`, `listPrograms()`, `ensureAutoAutoDir()`, `getProgramsDir()`
- `src/lib/tool-events.ts` — `formatToolEvent()` for Read, Write, Edit, Glob, Grep, Bash
- `src/lib/validate-measurement.ts` — Standalone measurement validation script (1+5 runs, CV%, recommendations)
- `src/App.tsx` — Screen routing (`home` | `setup`), global keyboard handling
- `src/screens/HomeScreen.tsx` — Program list with j/k navigation, `n` to create new
- `src/index.tsx` — Entry point, creates CLI renderer

**What's missing (the work for 1e):**

1. No model configuration — the Chat component uses the SDK's default model (no `model` or `effort` options passed)
2. No project-level config (`config.json`) at `.autoauto/config.json` — only program-level `config.json` exists
3. No settings screen in the TUI — no way to configure models
4. No auth checking — the app starts the setup agent immediately, auth errors surface as generic agent errors in the Chat component
5. No auth error screen/state — if authentication fails, the user sees a cryptic error message

---

## Architecture Decisions

### 1. "Throughput Tier" Maps to SDK `effort` Level, Not a Separate Concept

**Decision: The IDEA.md's "throughput tier (low/medium/high)" maps directly to the Claude Agent SDK's `effort` option.**

The SDK has no concept of "throughput tier." What it has:

| SDK Option | Type | Description |
|-----------|------|-------------|
| `model` | `string` | Model alias (`'sonnet'`, `'opus'`, `'haiku'`) or full ID (`'claude-sonnet-4-6'`) |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | Reasoning effort level — lower = faster/cheaper, higher = deeper reasoning |
| `thinking` | `ThinkingConfig` | Adaptive (default for Opus 4.6+), fixed budget, or disabled |

The `effort` level is the closest match to what IDEA.md calls "throughput tier":
- `'low'` = minimal thinking, fastest responses (high throughput)
- `'medium'` = moderate thinking
- `'high'` = deep reasoning, default (low throughput, highest quality)
- `'max'` = maximum effort, Opus 4.6 only

**Each model slot is therefore: `{ model: string, effort: EffortLevel }`.**

We use `effort` rather than `thinking` because `effort` is the higher-level API that works with adaptive thinking (the default). Setting `thinking` directly is for advanced/legacy use cases. The SDK docs recommend `effort` for controlling reasoning depth.

**Note on `'max'` effort:** Only available on Opus 4.6. The UI should only show `'max'` when Opus is selected.

### 2. Project Config at `.autoauto/config.json`

**Decision: Store model configuration in `.autoauto/config.json`, matching the IDEA.md data model.**

IDEA.md specifies:
```
.autoauto/
  config.json                    # project-level config (default models, etc.)
```

This file stores project-level defaults. Program-level configs are separate at `.autoauto/programs/<slug>/config.json` (these already exist from 1c/1d — they store metric_field, direction, noise_threshold, etc.).

**Schema:**
```typescript
interface ModelSlot {
  model: string        // 'sonnet' | 'opus' or full model ID
  effort: EffortLevel  // 'low' | 'medium' | 'high' | 'max'
}

interface ProjectConfig {
  executionModel: ModelSlot
  supportModel: ModelSlot
}
```

**Defaults when no config.json exists:**
```json
{
  "executionModel": { "model": "sonnet", "effort": "high" },
  "supportModel": { "model": "sonnet", "effort": "high" }
}
```

Rationale for defaults:
- **Sonnet** for both: cheaper, faster, sufficient for most use cases. Users who want Opus can configure it.
- **`high` effort** for both: the default SDK behavior, best quality. Users can lower it for cost savings.

### 3. Settings Screen Accessible from Home

**Decision: Add a new "Settings" screen accessible from the Home screen via `s` key.**

**Considered alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| **A: Settings screen from Home (chosen)** | Discoverable, always accessible, clear UX | New screen to build |
| B: Configure models during setup flow | No new screen | Coupled to setup, can't change later without re-running setup |
| C: Config file only (no UI) | No UI work | Bad UX, users must manually edit JSON |
| D: CLI flags | Common pattern | Doesn't persist, must remember flags |

**Why a settings screen:**
- Model config is a project-level setting, not a per-setup decision
- Users may want to change models without re-running setup
- The Home screen already has keyboard-driven navigation — adding `s` for settings is natural
- The screen is simple: two model slots, each with model + effort selection
- OpenTUI provides the primitives needed (keyboard navigation, text rendering)

**UX flow:**
1. Home screen shows `s: settings` in the bottom bar
2. Settings screen shows two slots with current values, arrow keys to navigate, Enter/Space to cycle
3. Changes are saved immediately to `.autoauto/config.json`
4. Escape goes back to Home

### 4. Auth Check: Try `accountInfo()` on a Lightweight Query, Handle Errors Gracefully

**Decision: Start a minimal query session on app startup to check authentication, and show an auth error screen if it fails.**

**Considered alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| A: Check `ANTHROPIC_API_KEY` env var | Simple | Misses OAuth auth, incomplete |
| B: Run `claude --version` or `claude doctor` | Checks installation | Doesn't verify auth |
| **C: Start a lightweight query, call `accountInfo()` (chosen)** | Checks real auth state, works for all auth methods (API key, OAuth, cloud providers) | Requires starting a query session |
| D: Handle auth errors in Chat component | No startup cost | Bad UX — user types a message, waits, then gets cryptic error |

**How it works:**

1. On app mount, `App.tsx` starts a lightweight query session with `persistSession: false`, no tools, and immediately calls `accountInfo()`.
2. The `SDKAuthStatusMessage` events (type `'auth_status'`) during initialization indicate auth progress. If `error` is set, auth failed.
3. If auth succeeds: store `AccountInfo`, continue to Home screen as normal.
4. If auth fails: show an `AuthErrorScreen` with instructions to authenticate.

**Auth error screen content:**
```
Authentication required

AutoAuto needs access to the Anthropic API.

Run one of:
  claude login         # OAuth via Claude.ai (recommended)
  claude setup-token   # Manual API key setup

Then restart AutoAuto.

Press Escape to quit.
```

**Why `accountInfo()` over checking `ANTHROPIC_API_KEY`:**
- The user noted: "for me I didn't appear to have to set ANTHROPIC_API_KEY manually" — this means OAuth via `claude login` works without an API key.
- The SDK supports multiple auth methods: API key, OAuth (firstParty), AWS Bedrock, GCP Vertex, Azure Foundry.
- `accountInfo()` checks the actual auth state regardless of method.
- Checking only `ANTHROPIC_API_KEY` would incorrectly flag OAuth-authenticated users.

**Lightweight query approach details:**

Create a utility function `checkAuth()` in `src/lib/auth.ts` that:
1. Calls `query({ prompt: '', options: { tools: [], persistSession: false } })` — empty prompt with no tools
2. Iterates the stream looking for `auth_status` events or a `result` message
3. Calls `q.accountInfo()` once initialized
4. Returns `{ authenticated: true, account: AccountInfo }` or `{ authenticated: false, error: string }`
5. Cleans up with abort controller

**However**, this approach has a problem: `query()` with an empty string prompt may not work well. An alternative is to simply start the query and check the `initializationResult()` which includes `account: AccountInfo`.

**Revised approach:** Use `initializationResult()` which returns the full init data including account info. This is lighter than sending a message — it just initializes the session and returns metadata.

```typescript
const q = query({
  prompt: '',
  options: {
    tools: [],
    persistSession: false,
    abortController,
  },
})
const init = await q.initializationResult()
// init.account has email, org, apiProvider, etc.
// If auth failed, the stream will emit auth_status with error
q.close()
```

**Fallback approach if `initializationResult()` with empty prompt doesn't work:**
Listen to the stream for `SDKAuthStatusMessage` events. The SDK emits `{ type: 'auth_status', isAuthenticating: true/false, output: string[], error?: string }` during initialization. If `error` is set, auth failed. This doesn't require sending any prompt at all.

### 5. App Startup Flow Changes

**Decision: Add an auth check phase before showing the Home screen.**

Current flow:
```
index.tsx → App.tsx → HomeScreen/SetupScreen
```

New flow:
```
index.tsx → App.tsx → AuthCheck (loading state) → HomeScreen/SetupScreen
                                                 → AuthErrorScreen (if auth fails)
```

The app starts with a loading state ("Connecting..."), runs the auth check, then either shows the normal UI or the auth error screen. This adds a brief delay on startup but prevents users from entering the setup flow only to hit an auth error mid-conversation.

### 6. Wire Model Config into Chat Component

**Decision: Add `model` and `effort` props to the Chat component, pass them through to `query()` options.**

The Chat component already accepts `cwd`, `systemPrompt`, `tools`, `allowedTools`, `maxTurns`. Adding `model` and `effort` is the same pattern.

SetupScreen reads the project config and passes the support model's settings to Chat. Later, Phase 2's experiment screen will pass the execution model's settings.

---

## Files to Create

### 1. `src/lib/auth.ts` — Authentication checking

**Purpose:** Check authentication status on startup.

[CHANGED] **Contents:**

```typescript
import { query, type AccountInfo } from "@anthropic-ai/claude-agent-sdk"
import { createPushStream } from "./push-stream.ts"

type AuthResult = {
  authenticated: true
  account: AccountInfo
} | {
  authenticated: false
  error: string
}

/**
 * Check if the user is authenticated with the Anthropic API.
 * Starts a minimal query session (no message sent), verifies auth via accountInfo(), then closes.
 */
export async function checkAuth(): Promise<AuthResult> {
  const abortController = new AbortController()
  // Timeout: abort after 10 seconds if SDK hangs during init
  const timeout = setTimeout(() => abortController.abort(), 10_000)

  try {
    // Use a PushStream as prompt — the session initializes (spawning CLI, authenticating)
    // but never sends a message. This is the established pattern from Chat.tsx.
    // DO NOT use an empty string prompt ('') — runtime behavior is untested.
    const idleStream = createPushStream<any>()

    const q = query({
      prompt: idleStream,
      options: {
        tools: [],
        persistSession: false,
        abortController,
      },
    })

    // accountInfo() resolves once the session has initialized and auth has succeeded.
    // If auth fails, the SDK throws or emits auth_status errors before this resolves.
    const account = await q.accountInfo()
    q.close()
    idleStream.end()
    clearTimeout(timeout)

    return { authenticated: true, account }
  } catch (err) {
    clearTimeout(timeout)
    abortController.abort()
    return {
      authenticated: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
```

**Key decisions:**
- Uses `createPushStream()` (already in codebase) as the prompt — creates a session that initializes without sending a message. This is the same pattern Chat.tsx uses, proven to work.
- Calls `accountInfo()` which resolves once init completes — if auth fails, the SDK throws before this resolves.
- 10-second timeout via abort controller prevents hanging on slow/broken connections.
- Always cleans up: `q.close()`, `idleStream.end()`, `clearTimeout()`.
- No `for await` loop needed — we don't need to listen for events, just verify auth works.

### 2. `src/lib/config.ts` — Project configuration CRUD

**Purpose:** Read, write, and provide defaults for `.autoauto/config.json`.

**Contents:**

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { getProjectRoot } from "./programs.ts"

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'

export interface ModelSlot {
  model: string        // 'sonnet' | 'opus' or full model ID
  effort: EffortLevel
}

export interface ProjectConfig {
  executionModel: ModelSlot
  supportModel: ModelSlot
}

const AUTOAUTO_DIR = ".autoauto"
const CONFIG_FILE = "config.json"

export const DEFAULT_CONFIG: ProjectConfig = {
  executionModel: { model: "sonnet", effort: "high" },
  supportModel: { model: "sonnet", effort: "high" },
}

/** Model choices the user can cycle through in the settings UI */
export const MODEL_CHOICES = ["sonnet", "opus"] as const

/** Effort levels available for each model */
export const EFFORT_CHOICES: Record<string, EffortLevel[]> = {
  sonnet: ["low", "medium", "high"],
  opus: ["low", "medium", "high", "max"],
}

/** Human-readable labels */
export const MODEL_LABELS: Record<string, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
}

export const EFFORT_DESCRIPTIONS: Record<EffortLevel, string> = {
  low: "Fastest, cheapest — minimal thinking",
  medium: "Balanced speed and quality",
  high: "Deep reasoning (default)",
  max: "Maximum effort (Opus only)",
}

export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  const root = await getProjectRoot(cwd)
  const configPath = join(root, AUTOAUTO_DIR, CONFIG_FILE)
  try {
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<ProjectConfig>
    // Merge with defaults to handle missing/new fields
    return {
      executionModel: { ...DEFAULT_CONFIG.executionModel, ...parsed.executionModel },
      supportModel: { ...DEFAULT_CONFIG.supportModel, ...parsed.supportModel },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function saveProjectConfig(cwd: string, config: ProjectConfig): Promise<void> {
  const root = await getProjectRoot(cwd)
  const dir = join(root, AUTOAUTO_DIR)
  await mkdir(dir, { recursive: true })
  const configPath = join(dir, CONFIG_FILE)
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
}
```

**Key decisions:**
- `AUTOAUTO_DIR` constant duplicated from `programs.ts` — small duplication, avoids circular deps. Could extract to a shared constants file but not worth the abstraction for two files.
- `loadProjectConfig` merges with defaults so new fields added later don't break existing configs.
- `MODEL_CHOICES` and `EFFORT_CHOICES` are the source of truth for the settings UI — adding a new model or effort level only requires updating these arrays.
- `EFFORT_CHOICES` maps model → available efforts. `'max'` only available for `'opus'`.
- `saveProjectConfig` ensures the `.autoauto/` directory exists before writing.

### 3. `src/screens/SettingsScreen.tsx` — Model configuration UI

**Purpose:** Allow the user to configure the two model slots.

**Layout:**
```
┌─ Settings ────────────────────────────┐
│                                        │
│  Execution Model (experiment agents)   │
│    Model:  ▸ Sonnet ◂                  │
│    Effort: ▸ High   ◂                  │
│    Fastest, cheapest — minimal thinking│
│                                        │
│  Support Model (setup & cleanup)       │
│    Model:    Opus                       │
│    Effort:   Medium                     │
│                                        │
└────────────────────────────────────────┘
 ↑↓: navigate | ←→: change | Escape: back
```

**Keyboard interaction:**
- `↑/↓` (or `k/j`): Navigate between the 4 fields (exec model, exec effort, support model, support effort)
- `←/→` (or `h/l`): Cycle the selected field's value
- `Escape`: Save and go back to Home

**Implementation approach:**
- State: `selected` index (0-3), current `config: ProjectConfig`
- On mount: `loadProjectConfig(cwd)` to populate initial state
- On each value change: `saveProjectConfig(cwd, config)` — immediate save, no explicit "save" button
- The 4 fields form a flat list. Each field maps to a slot + property:
  - 0: executionModel.model
  - 1: executionModel.effort
  - 2: supportModel.model
  - 3: supportModel.effort
- When model changes (e.g., from opus to sonnet), clamp effort if it's invalid (e.g., `'max'` is only valid for opus → reset to `'high'`)

**Props:**
```typescript
interface SettingsScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
}
```

**Component structure:**
```tsx
export function SettingsScreen({ cwd, navigate }: SettingsScreenProps) {
[CHANGED]   const [config, setConfig] = useState<ProjectConfig>(DEFAULT_CONFIG)
  const [selected, setSelected] = useState(0)
  const [dirty, setDirty] = useState(false)  // [CHANGED] tracks user mutations, not load state

  // Load config on mount
  useEffect(() => {
    loadProjectConfig(cwd).then(setConfig)
  }, [cwd])

  // Save only when the user has actually mutated the config (not on initial load)
  useEffect(() => {
    if (dirty) {
      saveProjectConfig(cwd, config)
      setDirty(false)
    }
  }, [config, dirty, cwd])

  // Helper: update config and mark as dirty (use this instead of raw setConfig)
  const updateConfig = (updater: (prev: ProjectConfig) => ProjectConfig) => {
    setConfig(updater)
    setDirty(true)
  }

  useKeyboard((key) => {
    if (key.name === 'escape') navigate('home')
    if (key.name === 'up' || key.name === 'k') setSelected(s => Math.max(0, s - 1))
    if (key.name === 'down' || key.name === 'j') setSelected(s => Math.min(3, s + 1))
    if (key.name === 'left' || key.name === 'h') cycleValue(-1)
    if (key.name === 'right' || key.name === 'l') cycleValue(1)
  })

[CHANGED]   // cycleValue: update the selected field by cycling through available choices
  function cycleValue(direction: -1 | 1) {
    updateConfig((prev) => {
      const slotKey = selected < 2 ? "executionModel" : "supportModel"
      const propKey = selected % 2 === 0 ? "model" : "effort"
      const slot = { ...prev[slotKey] }

      if (propKey === "model") {
        const idx = MODEL_CHOICES.indexOf(slot.model as any)
        const next = MODEL_CHOICES[(idx + direction + MODEL_CHOICES.length) % MODEL_CHOICES.length]
        slot.model = next
        // Clamp effort if switching away from opus
        const validEfforts = EFFORT_CHOICES[next] ?? EFFORT_CHOICES.sonnet
        if (!validEfforts.includes(slot.effort)) {
          slot.effort = "high"
        }
      } else {
        const validEfforts = EFFORT_CHOICES[slot.model] ?? EFFORT_CHOICES.sonnet
        const idx = validEfforts.indexOf(slot.effort)
        slot.effort = validEfforts[(idx + direction + validEfforts.length) % validEfforts.length]
      }

      return { ...prev, [slotKey]: slot }
    })
  }

  // Render helper for a single field row
  function renderField(index: number, label: string, value: string, description?: string) {
    const isFocused = selected === index
    return (
      <box flexDirection="column">
        <text>
          {isFocused ? <strong fg="#7aa2f7">{`  ${label}: ◂ ${value} ▸`}</strong> : `  ${label}: ${value}`}
        </text>
        {isFocused && description && <text fg="#888888">{`  ${description}`}</text>}
      </box>
    )
  }

  const execSlot = config.executionModel
  const supportSlot = config.supportModel

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Settings">
      <text>{""}</text>
      <text><strong>  Execution Model</strong> <text fg="#888888">(experiment agents)</text></text>
      {renderField(0, "Model", MODEL_LABELS[execSlot.model] ?? execSlot.model)}
      {renderField(1, "Effort", EFFORT_LABELS[execSlot.effort], EFFORT_DESCRIPTIONS[execSlot.effort])}
      <text>{""}</text>
      <text><strong>  Support Model</strong> <text fg="#888888">(setup & cleanup)</text></text>
      {renderField(2, "Model", MODEL_LABELS[supportSlot.model] ?? supportSlot.model)}
      {renderField(3, "Effort", EFFORT_LABELS[supportSlot.effort], EFFORT_DESCRIPTIONS[supportSlot.effort])}
    </box>
  )
}
```

### 4. `src/screens/AuthErrorScreen.tsx` — Auth error display

**Purpose:** Show when authentication fails on startup.

**Layout:**
```
┌─ AutoAuto ────────────────────────────┐
│                                        │
│         Authentication required         │
│                                        │
│  AutoAuto needs access to the          │
│  Anthropic API to run.                 │
│                                        │
│  Run one of:                           │
│    claude login         (recommended)  │
│    claude setup-token   (API key)      │
│                                        │
│  Then restart AutoAuto.                │
│                                        │
│  Error: <specific error message>       │
│                                        │
└────────────────────────────────────────┘
 Escape: quit
```

**Implementation:**
- Simple static screen, no state management
- Shows the specific error from the auth check for debugging
- `Escape` quits the app via `renderer.destroy()`
- No retry mechanism — just quit and restart (auth setup requires running CLI commands outside the app)

**Props:**
```typescript
interface AuthErrorScreenProps {
  error: string
}
```

---

## Files to Modify

### 1. `src/lib/programs.ts` — Add `Screen` type for `"settings"`

**Change:** Update the `Screen` type to include the new settings screen.

```typescript
// Before:
export type Screen = "home" | "setup"

// After:
export type Screen = "home" | "setup" | "settings"
```

### 2. `src/App.tsx` — Add auth check, settings screen routing, pass model config

**Changes:**

1. **Add auth check state:** New states for auth checking phase (`authState: 'checking' | 'authenticated' | 'error'`, `authError: string`).

2. **Run auth check on mount:** Call `checkAuth()` in a `useEffect`. While checking, show a "Connecting..." loading state. On success, set `authState = 'authenticated'`. On failure, set `authState = 'error'` and `authError = errorMessage`.

3. **Add settings screen routing:** Render `SettingsScreen` when `screen === 'settings'`.

4. **Load project config for SetupScreen:** Add state for `projectConfig` loaded from `.autoauto/config.json`. Pass `config.supportModel` to `SetupScreen` so it can use the configured model/effort for the setup agent.

5. **Update status bar:** Add `s: settings` to the home screen status bar.

6. **Render AuthErrorScreen when auth fails.**

**Updated component structure (pseudocode):**
```tsx
export function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [screen, setScreen] = useState<Screen>("home")
  const [projectRoot, setProjectRoot] = useState(cwd)
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'error'>('checking')
  const [authError, setAuthError] = useState('')
  const [projectConfig, setProjectConfig] = useState<ProjectConfig>(DEFAULT_CONFIG)

  // Auth check on mount
  useEffect(() => {
    checkAuth().then((result) => {
      if (result.authenticated) {
        setAuthState('authenticated')
      } else {
        setAuthState('error')
        setAuthError(result.error)
      }
    })
  }, [])

  // Load project config after auth succeeds
  useEffect(() => {
    if (authState === 'authenticated') {
      loadProjectConfig(cwd).then(setProjectConfig)
    }
  }, [authState])

  // Reload config when returning to home (settings may have changed)
  useEffect(() => {
    if (screen === 'home' && authState === 'authenticated') {
      loadProjectConfig(cwd).then(setProjectConfig)
    }
  }, [screen])

  useKeyboard((key) => {
    if (key.name === 'escape') {
      if (screen === 'home' || authState === 'error') renderer.destroy()
    }
  })

  // Loading state
  if (authState === 'checking') {
    return <box ...><text fg="#888888">Connecting...</text></box>
  }

  // Auth error
  if (authState === 'error') {
    return <AuthErrorScreen error={authError} />
  }

  // Normal app
  return (
    <box flexDirection="column" width={width} height={height}>
      <box height={3} border borderStyle="rounded" ...>
        <text><strong>AutoAuto</strong></text>
      </box>

      {screen === "home" && <HomeScreen cwd={cwd} navigate={setScreen} />}
      {screen === "setup" && (
        <SetupScreen
          cwd={projectRoot}
          navigate={setScreen}
          modelConfig={projectConfig.supportModel}
        />
      )}
      {screen === "settings" && <SettingsScreen cwd={cwd} navigate={setScreen} />}

      <text fg="#888888">
        {screen === "home"
          ? " n: new program | s: settings | Escape: quit"
          : " Escape: back"}
      </text>
    </box>
  )
}
```

### 3. `src/screens/HomeScreen.tsx` — Add `s` keyboard shortcut

**Change:** Add keyboard handler for `s` to navigate to settings.

```typescript
// In useKeyboard callback:
if (key.name === "s") {
  navigate("settings")
}
```

### 4. `src/screens/SetupScreen.tsx` — Accept and pass model config

**Changes:**

1. Accept a `modelConfig` prop of type `ModelSlot`.
2. Pass `model` and `effort` to the `Chat` component.

```typescript
// Before:
interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
}

// After:
interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
  modelConfig: ModelSlot
}

export function SetupScreen({ cwd, navigate, modelConfig }: SetupScreenProps) {
  // ...
  return (
    <Chat
      cwd={cwd}
      systemPrompt={systemPrompt}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      maxTurns={SETUP_MAX_TURNS}
      model={modelConfig.model}
      effort={modelConfig.effort}
    />
  )
}
```

### 5. `src/components/Chat.tsx` — Accept and use `model` and `effort` options

**Changes:**

1. Add `model` and `effort` props to `ChatProps`.
2. Pass them through to the `query()` options.

[CHANGED] ```typescript
import type { EffortLevel } from "../lib/config.ts"

// Add to ChatProps interface:
interface ChatProps {
  cwd?: string
  systemPrompt?: string
  tools?: string[]
  allowedTools?: string[]
  maxTurns?: number
  model?: string           // NEW — 'sonnet', 'opus', or full model ID
  effort?: EffortLevel     // NEW — 'low' | 'medium' | 'high' | 'max'
}

// In the query() call inside useEffect:
const q = query({
  prompt: inputStream,
  options: {
    systemPrompt: config.systemPrompt,
    tools: config.tools ?? [],
    allowedTools: config.allowedTools,
    maxTurns: config.maxTurns,
    cwd: config.cwd,
    model: config.model,           // NEW
    effort: config.effort,         // NEW — EffortLevel matches SDK's type directly
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    abortController,
    persistSession: false,
  },
})
```

**Important:** The `configRef` already captures props at mount time. Add `model` and `effort` to the ref's type. The `EffortLevel` type from `config.ts` matches the SDK's `EffortLevel` exactly (`'low' | 'medium' | 'high' | 'max'`), so no `as any` cast is needed.

### 6. `src/lib/system-prompts.ts` — No changes needed

The system prompt doesn't need to know about model configuration. The model/effort are passed directly to the SDK via `query()` options.

---

## Implementation Order

Follow this order to keep the codebase working at each step:

### Step 1: Create `src/lib/config.ts`
- Define types (`ModelSlot`, `ProjectConfig`, `EffortLevel`)
- Implement `loadProjectConfig()`, `saveProjectConfig()`
- Define defaults and choice constants
- **Verify:** `bun typecheck` passes

### Step 2: Create `src/lib/auth.ts`
- Implement `checkAuth()` function
- Test manually: import and call from a scratch script, verify it returns auth status
- **Verify:** `bun typecheck` passes

### Step 3: Update `src/lib/programs.ts`
- Add `"settings"` to the `Screen` type union
- **Verify:** `bun typecheck` passes (will temporarily have unused type — that's fine)

### Step 4: Update `src/components/Chat.tsx`
- Add `model` and `effort` to `ChatProps`
- Pass them to `query()` options
- Update `configRef` type
- **Verify:** `bun lint && bun typecheck` passes

### Step 5: Update `src/screens/SetupScreen.tsx`
- Add `modelConfig` prop
- Pass `model` and `effort` to Chat
- **Verify:** `bun typecheck` — will have type error in App.tsx since we haven't updated it yet. That's fine, continue.

### Step 6: Create `src/screens/SettingsScreen.tsx`
- Build the settings UI with keyboard navigation
- Wire up `loadProjectConfig` / `saveProjectConfig`
- Test cycling through model/effort values
- **Verify:** `bun typecheck` passes for this file in isolation

### Step 7: Create `src/screens/AuthErrorScreen.tsx`
- Simple static screen with instructions
- **Verify:** `bun typecheck` passes

### Step 8: Update `src/App.tsx`
- Add auth check state and loading screen
- Add settings screen routing
- Load project config, pass to SetupScreen
- Update status bar text
- Wire up AuthErrorScreen
- **Verify:** `bun lint && bun typecheck` passes

### Step 9: Update `src/screens/HomeScreen.tsx`
- Add `s` keyboard shortcut for settings
- **Verify:** `bun lint && bun typecheck` passes

### Step 10: Test the full flow
- Launch with `bun dev` in tmux
- Verify auth check shows "Connecting..." briefly then Home
- Press `s` → verify Settings screen renders with defaults
- Change model/effort → verify changes persist (check `.autoauto/config.json`)
- Press Escape → back to Home
- Press `n` → verify SetupScreen starts with configured model
- Test auth failure: temporarily break auth (e.g., set invalid API key) → verify AuthErrorScreen appears

---

## Edge Cases & Error Handling

### Auth check timeout
The auth check should have a reasonable timeout (10 seconds). If the SDK hangs during initialization, abort and show an error. Pass a timeout to the abort controller:

```typescript
setTimeout(() => abortController.abort(), 10_000)
```

### Missing Claude Code installation
If Claude Code isn't installed, the SDK will fail to spawn the process. The error message from `checkAuth()` should be informative enough. The `AuthErrorScreen` should mention both `claude login` and that Claude Code must be installed.

### Settings screen and concurrent agent sessions
If the user changes model config in settings while a setup agent is running in another terminal, the running agent won't pick up the change (it captured config at mount time via `configRef`). This is correct behavior — in-flight sessions use the config they started with.

### `'max'` effort on non-Opus models
When the user switches from Opus to Sonnet, if effort was `'max'`, automatically clamp to `'high'`. The `SettingsScreen` handles this in its `cycleValue` logic.

### Config file corruption
`loadProjectConfig()` catches parse errors and returns defaults. This handles corrupted JSON gracefully.

---

## Documentation Updates

### Update `CLAUDE.md` — Project Structure section

Add new files to the project structure:

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Main layout, keyboard handling, auth check
  components/
    Chat.tsx             # Multi-turn chat with Claude Agent SDK streaming
  screens/
    HomeScreen.tsx       # Program list
    SetupScreen.tsx      # Setup flow (chat wrapper + agent config)
    SettingsScreen.tsx   # Model configuration (execution + support slots)
    AuthErrorScreen.tsx  # Auth error display with setup instructions
  lib/
    auth.ts              # Authentication checking via SDK
    config.ts            # Project config CRUD (.autoauto/config.json)
    programs.ts          # Filesystem ops, program CRUD, config types
    push-stream.ts       # Push-based async iterable utility
    system-prompts.ts    # Agent system prompts (setup, ideation)
    tool-events.ts       # Tool event display formatting
    validate-measurement.ts  # Standalone measurement validation script
```

### Update `CLAUDE.md` — Agent Conventions section

Add:

```markdown
- Model configuration (model alias + effort level) stored in `.autoauto/config.json`
- Two model slots: `executionModel` (for experiment agents) and `supportModel` (for setup/cleanup)
- Defaults: Sonnet + high effort for both slots
- Model/effort passed to `query()` via `model` and `effort` options
- Auth checked on startup via SDK `accountInfo()` — supports API key, OAuth, and cloud providers
```

### Update `docs/architecture.md`

Add sections:

**After "Data Layer":**

```markdown
## Configuration

`src/lib/config.ts` — project-level configuration at `.autoauto/config.json`:

- `ModelSlot` — model alias + effort level
- `ProjectConfig` — two slots: `executionModel` and `supportModel`
- `loadProjectConfig()` — reads config, merges with defaults for forward compatibility
- `saveProjectConfig()` — writes config as formatted JSON

Default: Sonnet + high effort for both slots.
```

**After "Agent Architecture":**

```markdown
## Authentication

`src/lib/auth.ts` — checks auth on startup:

- Uses SDK `accountInfo()` to verify authentication works
- Supports all SDK auth methods (API key, OAuth, cloud providers)
- Returns account info on success, error message on failure
- App shows `AuthErrorScreen` on failure with remediation instructions
```

**Update "Screens" section to include:**

```markdown
- **SettingsScreen** — model configuration for execution and support slots, keyboard-driven value cycling
- **AuthErrorScreen** — displayed when authentication fails, shows setup instructions
```

**Update "Current State" to:**

```markdown
Phase 1 (Setup) is complete. The TUI shell, screen navigation, program listing, multi-turn
Claude Agent SDK chat, setup agent (repo inspection, scope definition, artifact generation,
measurement validation), and model configuration are all implemented. Authentication is
checked on startup with a helpful error screen if not configured.
```

### Update `phase-1.md`

Mark all 1e tasks as done:

```markdown
## 1e. Model Configuration

- [x] Configure execution model slot (Sonnet/Opus + throughput tier)
- [x] Configure support model slot (Sonnet/Opus + throughput tier)
- [x] Auth (slightly unrelated but basic): Check for `ANTHROPIC_API_KEY` on startup
- [x] Auth: Prompt user to run `claude setup-token` if missing
```

---

## Testing Checklist

1. **Auth success:** App starts, shows "Connecting..." briefly, then Home screen
2. **Auth failure:** With broken auth, app shows AuthErrorScreen with instructions
3. **Auth error escape:** Pressing Escape on AuthErrorScreen quits the app
4. **Settings navigation:** `s` from Home → Settings screen, Escape → back to Home
5. **Model cycling:** Left/right arrows cycle through Sonnet/Opus
6. **Effort cycling:** Left/right arrows cycle through effort levels
7. **Max effort clamping:** Select Opus + Max, switch to Sonnet → effort resets to High
8. **Config persistence:** Change settings, quit, restart → settings preserved
9. **Config defaults:** Delete `.autoauto/config.json`, restart → defaults (Sonnet + High)
10. **Setup uses config:** Change support model to Opus, start setup → verify agent uses Opus
11. **Lint/typecheck:** `bun lint && bun typecheck` passes after all changes
12. **Interactive test via tmux:**
    ```bash
    tmux new-session -d -s autoauto -x 80 -y 24 'bun dev'
    tmux capture-pane -t autoauto -p  # Should show "Connecting..." then Home
    tmux send-keys -t autoauto 's'     # Navigate to Settings
    tmux capture-pane -t autoauto -p  # Should show Settings with model slots
    tmux send-keys -t autoauto Right   # Cycle model
    tmux send-keys -t autoauto Escape  # Back to Home
    tmux kill-session -t autoauto
    ```

---

## [NEW] Review Notes

This plan was reviewed against the Claude Agent SDK type definitions (sdk.d.ts) and the current codebase state. Key corrections:

- **Changed:** Auth check now uses `createPushStream()` (from existing `push-stream.ts`) as the prompt instead of an empty string `''`. The empty string approach has untested runtime behavior — it might send an empty API request, error, or hang. The PushStream approach is the established pattern from Chat.tsx: creates a session that initializes without sending a message. `accountInfo()` resolves once init completes. No `for await` loop needed.
- **Changed:** SettingsScreen save logic now uses a `dirty` flag to distinguish user mutations from initial load. The original `useEffect` on `[config, loaded, cwd]` fired immediately after `loadProjectConfig` resolved, unnecessarily writing defaults to disk. The new approach: `updateConfig()` sets `dirty=true`, the save effect only fires when `dirty` is true.
- **Changed:** `effort` prop in ChatProps now typed as `EffortLevel` (imported from config.ts) instead of `string` with `as any` cast. The `EffortLevel` type matches the SDK's type exactly — no cast needed.
- **Changed:** SettingsScreen now includes full render JSX with `cycleValue()` implementation, `renderField()` helper, focused-state highlighting, and effort descriptions. The original placeholder (`{/* Execution Model section */}`) was not specific enough for an implementer.
- **Verified:** All SDK API claims confirmed — `model`, `effort`, `AccountInfo`, `accountInfo()`, `initializationResult()`, `auth_status` events, `close()` all exist with documented types. `model` accepts aliases (`'sonnet'`, `'opus'`). `effort` accepts `'low' | 'medium' | 'high' | 'max'`.
