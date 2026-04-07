# Phase 1, Section 1b: Setup Agent — Implementation Plan

## Goal

Transform the generic Chat component into a **Setup Agent** that can inspect the target repository using built-in SDK tools, ask the user what to optimize, suggest optimization targets (ideation mode), and define scope constraints — all through the existing multi-turn chat interface.

## Section 1b Tasks (from phase-1.md)

1. Setup Agent system prompt (inspect repo, ask what to optimize, define scope, generate artifacts)
2. Agent tools: read files, list directories, run shell commands (to inspect the target repo)
3. Ideation mode: agent analyzes codebase and suggests optimization targets

## [CHANGED] Current State

**Most of 1b is already implemented.** A previous session (1a) built the Chat component with full prop support and the SetupScreen already passes agent configuration. Here's what exists:

- `src/components/Chat.tsx` — Multi-turn chat with `query()` using `AsyncIterable<SDKUserMessage>`, streaming, message history, auto-scroll. **Already accepts props:** `cwd`, `systemPrompt`, `tools`, `allowedTools`, `maxTurns`.
- `src/screens/SetupScreen.tsx` — **Already passes setup agent config to Chat:**
  ```typescript
  const SETUP_TOOLS = ["Read", "Bash", "Glob", "Grep"]
  const SETUP_MAX_TURNS = 20
  // Renders: <Chat cwd={cwd} systemPrompt={getSetupSystemPrompt(cwd)} tools={SETUP_TOOLS} allowedTools={SETUP_TOOLS} maxTurns={SETUP_MAX_TURNS} />
  ```
- `src/App.tsx` — **Already passes `cwd={process.cwd()}` to SetupScreen.**
- `src/lib/system-prompts.ts` — **Already exists** with `DEFAULT_SYSTEM_PROMPT` and `getSetupSystemPrompt(cwd)`. The setup prompt is ~2000 tokens covering identity, workflow (7 steps), ideation mode (3 steps), key principles, measurement requirements, and constraints.

### What's Missing (the actual remaining work for 1b)

1. **`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`** — Not set in Chat.tsx. Without this, the SDK will try to prompt for tool permissions in the TUI, which can't handle interactive prompts.
2. **Tool status display** — Chat.tsx doesn't handle `content_block_start` events for `tool_use`. No visual indication when the agent is reading files or running commands.
3. **Autoresearch expertise in system prompt** — The existing prompt covers workflow well but lacks deep expertise distilled from `docs/failure-patterns.md`, `docs/measurement-patterns.md`, `docs/orchestration-patterns.md`. This domain knowledge prevents bad advice.

---

## Architecture Decisions

### 1. Built-in Tools, Not Custom MCP Tools

**Decision: Use SDK built-in tools (`Read`, `Bash`, `Glob`, `Grep`), not custom tools via `tool()` + `createSdkMcpServer()`.**

- The SDK already provides file reading, directory listing, content search, and shell execution as built-in tools
- These are battle-tested and handle edge cases (binary files, large outputs, timeouts)
- Custom MCP tools would duplicate existing functionality
- The `cwd` option scopes all built-in tools to the target repo naturally
- No `Write` or `Edit` — the setup agent inspects, it doesn't modify files (that's 1c)
- No `WebSearch`/`WebFetch` — not needed for repo inspection, keeps agent focused

**Already done:** SetupScreen.tsx already configures `tools: ["Read", "Bash", "Glob", "Grep"]`.

### 2. Permission Model

**Decision: Use `permissionMode: "bypassPermissions"` with `allowDangerouslySkipPermissions: true`.**

- AutoAuto is the host application — there's no interactive terminal for the SDK to prompt permissions
- The TUI renders via OpenTUI, not the SDK's built-in permission UI
- `permissionMode: "dontAsk"` would silently deny tools the SDK considers "dangerous" (e.g., `Bash`) even if listed in `allowedTools`
- `bypassPermissions` auto-approves everything — the `tools` option controls what's available (only 4 read-only tools), the system prompt controls behavior
- This is the standard pattern for SDK-based host applications

**Verified in SDK types:** `permissionMode` accepts `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. The `bypassPermissions` value requires `allowDangerouslySkipPermissions: true` as a companion option.

**Fallback chain if `bypassPermissions` causes issues:**
1. `permissionMode: "acceptEdits"` (less aggressive, may still prompt for Bash)
2. Omit `permissionMode` entirely, rely only on `allowedTools`
3. `permissionMode: "dontAsk"` (denies non-listed, auto-approves listed)

**Status: NOT YET IMPLEMENTED — this is a key remaining task.**

### 3. Ideation as Conversation, Not Separate Mode

**Decision: Ideation is a system prompt instruction, not a separate screen or mode in the TUI.**

**Already done:** The existing `getSetupSystemPrompt()` in `system-prompts.ts` includes an ideation flow ("If the user wants help finding targets").

### [CHANGED] 4. Chat Props: Already Generic

The plan originally proposed a single `projectRoot` prop. The actual implementation is better — Chat accepts generic props (`cwd`, `systemPrompt`, `tools`, `allowedTools`, `maxTurns`) and SetupScreen wires them up. **No changes needed here.**

---

## [CHANGED] Files to Create

### 1. `src/lib/tool-events.ts` — Tool Event Display Formatting

Small utility to format SDK tool-use events into one-line status strings for the chat UI.

```typescript
/** Format a tool call into a brief human-readable status string */
export function formatToolEvent(toolName: string, input: Record<string, unknown>): string
```

Formatting rules:
| Tool | Input | Output |
|------|-------|--------|
| `Read` | `{ file_path: "/foo/bar/package.json" }` | `"Reading package.json"` |
| `Glob` | `{ pattern: "**/*.test.ts" }` | `"Searching for **/*.test.ts"` |
| `Grep` | `{ pattern: "benchmark" }` | `"Grep: benchmark"` |
| `Bash` | `{ command: "git log --oneline -10" }` | `"Running: git log --oneline -10"` |
| Unknown | `{}` | `"Using {toolName}..."` |

Implementation notes:
- For `Read`, extract filename from path (`path.split("/").pop()`)
- For `Bash`, truncate commands longer than ~60 chars with `...`
- Handle empty/partial `input` gracefully (return `"Using {toolName}..."`)
- No external dependencies

---

## [CHANGED] Files to Modify

### 2. `src/components/Chat.tsx` — Add permissions + tool status

The Chat component already has the correct prop interface and query setup. Only three changes needed:

#### 2a. Add `permissionMode` and `allowDangerouslySkipPermissions` to query options

In the `query()` call (around line 57-68), add two options:

```typescript
const q = query({
  prompt: inputStream,
  options: {
    systemPrompt: config.systemPrompt,
    tools: config.tools ?? [],
    allowedTools: config.allowedTools,
    maxTurns: config.maxTurns,
    cwd: config.cwd,
    permissionMode: "bypassPermissions",       // NEW
    allowDangerouslySkipPermissions: true,      // NEW
    includePartialMessages: true,
    abortController,
    persistSession: false,
  },
})
```

**Why in Chat, not SetupScreen?** AutoAuto always manages its own UI — no agent should trigger SDK permission prompts. This applies to all future agent types (experiment, cleanup), so it belongs in the shared Chat component.

#### 2b. Add tool status state

```typescript
const [toolStatus, setToolStatus] = useState<string | null>(null)
```

#### 2c. Handle tool_use events in the stream processing loop

Extend the `stream_event` handler (around line 74-85):

```typescript
if (message.type === "stream_event") {
  const event = message.event

  // Text streaming (existing code — unchanged)
  if (
    event.type === "content_block_delta" &&
    "delta" in event &&
    event.delta.type === "text_delta" &&
    "text" in event.delta
  ) {
    setStreamingText((prev) => prev + (event.delta as { text: string }).text)
    setToolStatus(null) // NEW: clear tool status when text arrives
  }

  // NEW: Tool use start — show what the agent is doing
  if (
    event.type === "content_block_start" &&
    "content_block" in event &&
    (event.content_block as any).type === "tool_use"
  ) {
    const block = event.content_block as any
    setToolStatus(formatToolEvent(block.name ?? "", block.input ?? {}))
  }
}
```

**Caveat:** `content_block_start` for `tool_use` may have empty `input` (input streams via deltas). `formatToolEvent` handles this by returning `"Using {toolName}..."` for empty input.

**Simpler fallback if stream events are unreliable:** Skip tool_use event parsing entirely. Show a generic "Working..." when `isStreaming && !streamingText` persists for >500ms. Less informative but more robust.

#### 2d. Render tool status in the scrollbox

Inside the scrollbox, after the "Thinking..." indicator:

```tsx
{toolStatus && isStreaming && (
  <text fg="#888888">⟳ {toolStatus}</text>
)}
```

Shows dim status like `"⟳ Reading package.json"` during tool use. Clears when text streaming resumes or turn completes.

#### 2e. Clear tool status on turn completion

In the `assistant` message handler (around line 86-101), add `setToolStatus(null)` alongside existing state resets.

#### 2f. Add import

```typescript
import { formatToolEvent } from "../lib/tool-events.ts"
```

### 3. `src/lib/system-prompts.ts` — Enhance with autoresearch expertise

The existing prompt is good but lacks domain expertise distilled from the docs. **Append** the following section to the `getSetupSystemPrompt()` return string, before the "What NOT to Do" section:

```
## Autoresearch Expertise

Key lessons from real autoresearch implementations:

MEASUREMENT PITFALLS:
- If test cases don't exercise a feature, the agent may remove it to improve metrics
- Fixed eval sets risk overfitting after 50+ experiments — rotating subsets help
- Hardware-specific optimizations may not transfer across environments
- AI-judging-AI is a pre-filter, not ground truth — results plateau at the eval's sophistication level
- Random seed manipulation: lock seeds in measurement script, don't let the agent choose seeds
- Incorrectly keyed caches cause false improvements — ask about caching layers

SCOPE PITFALLS:
- Without scope constraints, the agent WILL game the metric (remove features, hardcode outputs, etc.)
- One file/component per experiment is ideal — minimizes blast radius
- Measurement script + config must be LOCKED (read-only) during execution — this is the #1 safeguard
- The evaluation script is the most valuable artifact — protect it from agent modification

QUALITY GATES:
- Keep quality gates focused — too many gates leads to "checklist gaming" where the agent satisfies letter but not spirit
- Binary pass/fail gates are more robust than threshold-based gates
- Prefer preventing harm (gate violations abort the experiment) over penalizing harm (subtracting from score)
```

**Why add this?** The current prompt tells the agent *what to do* but not *what to watch out for*. This expertise helps the agent give better advice during scope and measurement discussions, preventing costly mistakes that only surface during experiment execution.

### [CHANGED] 4. `src/screens/SetupScreen.tsx` — No changes needed

Already correctly configured. No modifications required.

### [CHANGED] 5. `src/App.tsx` — No changes needed

Already passes `cwd` to SetupScreen. No modifications required.

---

## [CHANGED] Integration Flow

Most of this flow already works. The additions (marked with **NEW**) are what 1b adds:

```
1. User presses 'n' on HomeScreen → navigates to "setup"           (EXISTING)
2. App.tsx renders SetupScreen with cwd={process.cwd()}              (EXISTING)
3. SetupScreen renders <Chat> with setup agent config                (EXISTING)
4. Chat mounts, creates PushStream, starts query() with:            (EXISTING)
   - System prompt from getSetupSystemPrompt(cwd)
   - Built-in tools: Read, Bash, Glob, Grep
   - cwd: target repo path
   - permissionMode: "bypassPermissions"                            **NEW**
   - allowDangerouslySkipPermissions: true                          **NEW**
5. query() starts — agent waits for first user message               (EXISTING)
6. User types "Help me find optimization targets" → Enter            (EXISTING)
7. Agent uses Glob to discover repo structure, Read to inspect files  (EXISTING)
8. Tool status shows in chat: "⟳ Reading package.json"              **NEW**
9. Agent responds with 3-5 suggested targets based on repo content   (EXISTING)
   (Enhanced with autoresearch expertise from docs)                  **NEW**
10. Multi-turn conversation continues until scope is fully defined    (EXISTING)
11. User presses Escape → unmount → abort                            (EXISTING)
```

---

## [CHANGED] Message Type Handling

| SDK Message Type | Action | Status |
|---|---|---|
| `stream_event` (content_block_delta, text_delta) | Append to `streamingText` | EXISTING |
| `stream_event` (content_block_delta, text_delta) | Clear `toolStatus` | **NEW** |
| `stream_event` (content_block_start, tool_use) | Set `toolStatus` via `formatToolEvent()` | **NEW** |
| `assistant` | Extract text blocks → `messages`, clear streaming + tool state | EXISTING (+ clear toolStatus **NEW**) |
| `result` (success) | No action (session continues) | EXISTING |
| `result` (error) | Set error state, stop streaming | EXISTING |
| All others | Ignore | EXISTING |

---

## Testing

### Manual Testing via tmux

```bash
# Launch in the autoauto repo (it IS a repo with code to inspect)
cd /Users/keeskluskens/dev/autoauto
tmux new-session -d -s autoauto -x 120 -y 40 'bun dev'

# Navigate to setup
sleep 2
tmux send-keys -t autoauto 'n'
sleep 1

# Test ideation mode
tmux send-keys -t autoauto 'Help me find optimization targets in this repo' Enter
sleep 15  # Agent needs time for tool calls
tmux capture-pane -t autoauto -p

# Verify:
# - Agent used tools (Read, Glob) — tool status indicators appeared
# - No permission prompts appeared (bypassPermissions working)
# - Agent suggests specific targets based on actual repo content
# - Agent identified the stack (Bun, TypeScript, OpenTUI)

# Test direct setup  
tmux send-keys -t autoauto "Let's go with TUI rendering performance" Enter
sleep 10
tmux capture-pane -t autoauto -p

# Verify:
# - Agent asks about scope, constraints
# - Agent uses tools to inspect relevant files
# - Multi-turn context maintained

# Test escape
tmux send-keys -t autoauto Escape
sleep 1
tmux capture-pane -t autoauto -p
# Verify: back on home screen, no crash

tmux kill-session -t autoauto
```

### Verification Checklist

1. **No permission prompts** — Tools execute without asking user (bypassPermissions)
2. **Tool status** — Dim status line shows during tool use (e.g., "⟳ Reading package.json")
3. **Ideation** — Agent analyzes codebase, suggests specific concrete targets with autoresearch expertise
4. **Scope advice** — Agent warns about gaming, suggests constraints, asks about measurement pitfalls
5. **Tools work** — Agent can Read files, Glob for patterns, Grep for content, run Bash commands
6. **cwd scoping** — All tool operations happen in the target repo
7. **No file modifications** — Agent inspects only (no Write/Edit tools available)
8. **Multi-turn context** — Agent remembers previous turns
9. **Escape handling** — Clean abort, back to home screen
10. **Streaming** — Text streams token-by-token as before

### Typecheck & Lint

```bash
bun lint && bun typecheck
```

Both must pass.

---

## Potential Issues & Mitigations

### 1. `permissionMode: "bypassPermissions"` may not work

**Verified in SDK types:** `bypassPermissions` is a valid `PermissionMode` value. It requires `allowDangerouslySkipPermissions: true`.

**Fallback chain (try in order):**
1. `"bypassPermissions"` + `allowDangerouslySkipPermissions: true` (primary)
2. `"acceptEdits"` (less aggressive, may prompt for Bash)
3. Omit `permissionMode`, rely on `allowedTools` alone
4. `"dontAsk"` (denies non-listed, auto-approves listed)

### 2. Tool status events may not arrive cleanly

`content_block_start` for `tool_use` may have incomplete input or unexpected structure.

**Mitigations:**
1. `formatToolEvent` handles empty input gracefully (returns `"Using {toolName}..."`)
2. Fall back to generic "Working..." during tool-use silence
3. Skip tool status entirely — nice-to-have, not functional requirement

### 3. Agent may try destructive operations via Bash

System prompt says "don't modify files" but agents sometimes ignore instructions.

**Mitigations:**
- No Write/Edit tools available — can't use those
- Bash could write files (e.g., `echo > file`) — worst case is annoying, not catastrophic for setup
- If this becomes a problem, add a `PreToolUse` hook to filter destructive Bash patterns
- Acceptable risk for 1b — setup is interactive, user sees what happens

### [CHANGED] 4. `maxTurns` semantics

Per SDK type definitions: `maxTurns` counts **conversation turns** (user message + assistant response pairs), not individual tool-use round-trips. The current value of 20 in SetupScreen is fine — a setup conversation has 5-15 human turns. The agent can make many tool calls within a single turn.

The Chat.tsx comment says "Max agentic turns (tool-use round-trips)" — this is incorrect per the SDK docs. **Fix the comment** while making the other changes.

---

## Doc & Config Updates

### CLAUDE.md

**Update Project Structure** to include `tool-events.ts`:

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Main layout, keyboard handling
  components/
    Chat.tsx             # Multi-turn chat with Claude Agent SDK streaming
  screens/
    HomeScreen.tsx       # Program list
    SetupScreen.tsx      # Setup flow (chat wrapper + agent config)
  lib/
    programs.ts          # Filesystem ops, program CRUD
    push-stream.ts       # Push-based async iterable utility
    system-prompts.ts    # Agent system prompts (setup, ideation)
    tool-events.ts       # Tool event display formatting
```

**Add new section after OpenTUI Conventions:**

```markdown
## Agent Conventions

- Setup Agent uses built-in SDK tools (Read, Bash, Glob, Grep), not custom MCP tools
- Agent tools are auto-approved via `permissionMode: "bypassPermissions"` — AutoAuto is the host app
- `cwd` is always set to the target project root (resolved via `getProjectRoot()`)
- System prompts live in `src/lib/system-prompts.ts`
- Tool status is displayed in the chat UI as brief one-line indicators
```

### docs/architecture.md

**Add new section — Agent Architecture — after Utilities:**

```markdown
## Agent Architecture

AutoAuto uses the Claude Agent SDK's `query()` function with built-in tools. The host
application (AutoAuto TUI) manages the conversation UI while the SDK handles the agent
loop, tool execution, and context management.

### Setup Agent (`src/lib/system-prompts.ts`)

- **Purpose:** Inspect repo, suggest targets, define scope and constraints
- **Tools:** Read, Bash, Glob, Grep (inspection only — no Write/Edit)
- **Permission mode:** `bypassPermissions` (AutoAuto manages UI, not the SDK)
- **Working directory:** Target project root
- **System prompt:** Encodes autoresearch expertise — guides user through repo inspection,
  target identification, scope definition, measurement approach
- **maxTurns:** 20 (conversation turns)

The setup agent does NOT write files. It gathers information through conversation and
tool use, preparing everything needed for program generation (1c).
```

---

## [CHANGED] Summary of Changes

| File | Action | Description |
|---|---|---|
| `src/lib/tool-events.ts` | **Create** | `formatToolEvent()` — tool call → human-readable one-liner |
| `src/components/Chat.tsx` | **Modify** | Add `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, tool status state + rendering, fix `maxTurns` comment |
| `src/lib/system-prompts.ts` | **Modify** | Append autoresearch expertise section to setup prompt |
| `CLAUDE.md` | **Update** | Add tool-events.ts to project structure, add agent conventions |
| `docs/architecture.md` | **Update** | Add Agent Architecture section |

**Files NOT modified (already correct):**
- `src/screens/SetupScreen.tsx` — Already configured correctly
- `src/App.tsx` — Already passes `cwd`

## [CHANGED] Order of Implementation

1. Create `src/lib/tool-events.ts` (no dependencies)
2. Modify `src/components/Chat.tsx`:
   a. Add `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` to query options
   b. Add `toolStatus` state
   c. Handle `content_block_start` tool_use events
   d. Render tool status in scrollbox
   e. Clear tool status on turn completion
   f. Fix `maxTurns` comment
3. Modify `src/lib/system-prompts.ts` — append autoresearch expertise section
4. Run `bun lint && bun typecheck`
5. Test interactively via tmux (ideation + direct setup + permission bypass)
6. If permission issues → apply fallback chain from Potential Issues §1
7. If tool status unreliable → simplify per Potential Issues §2
8. Update `CLAUDE.md` and `docs/architecture.md`
9. Final `bun lint && bun typecheck`

---

## Scope Boundaries

### What 1b Does (remaining work)
- Auto-approve tool permissions (permissionMode bypass)
- Tool status display in chat (visual feedback during tool use)
- Enhanced system prompt with autoresearch expertise from docs

### What 1b Already Has (no work needed)
- System prompt with setup workflow and ideation mode
- Built-in tools for repo inspection (Read, Bash, Glob, Grep)
- Tool configuration in SetupScreen
- cwd passing from App → SetupScreen → Chat
- Structured conversation flow (inspect → identify → scope → measure → confirm)

### What 1b Does NOT Do (deferred)
- **1c:** Generate program.md, measure.sh, config.json
- **1c:** Save files to `.autoauto/programs/`
- **1c:** User review & confirm step for generated artifacts
- **1d:** Run measurement scripts for variance validation
- **1e:** Configure model tiers / throughput / auth

---

## Known Limitations (1b MVP)

1. **No artifact generation.** Agent gathers info but doesn't write program.md/measure.sh/config.json.
2. **No conversation persistence.** Leaving setup screen loses the conversation.
3. **No hard enforcement of "don't modify."** System prompt only — Bash could theoretically write files. Add PreToolUse hook later if needed.
4. **Tool status is best-effort.** SDK streaming events for tool_use may not provide clean signals for `input` at `content_block_start` time.
5. **No error recovery.** API errors terminate the conversation.
6. **Model is SDK default.** No model selection for setup agent (1e adds this).

---

## [NEW] Review Notes

This plan was reviewed and substantially rewritten. Original plan was written against a stale codebase snapshot (pre-1a implementation). Key corrections:

- **Removed:** All proposals to add props to Chat.tsx (already exist), modify SetupScreen.tsx (already configured), modify App.tsx (already passes cwd), create setup-prompt.ts (system-prompts.ts already exists)
- **Kept:** Permission mode configuration, tool status display, autoresearch expertise enhancement — these are genuinely missing
- **Verified:** SDK types confirm `bypassPermissions` is valid, `maxTurns` counts conversation turns, `tools` accepts string arrays, `content_block_start` events are emitted for tool_use
- **Reduced scope:** From 7 files changed to 3 files changed + 2 doc updates. ~80% of original plan was already implemented.
