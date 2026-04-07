# Phase 1, Section 1a: Chat Foundation — Implementation Plan

## Goal

Transform the single-turn `Chat` component into a multi-turn conversational interface with message history, auto-scrolling, and persistent Claude Agent SDK sessions across turns.

## Current State

- `src/components/Chat.tsx` — single-turn: one user input → one streamed response, no history
- Uses `query()` from `@anthropic-ai/claude-agent-sdk` with a string `prompt`
- `scrollbox` wraps the response text (no auto-scroll, no message list)
- `input` component fires `onSubmit`, no clearing after submit
- No conversation state management

## Target State

- Full multi-turn chat: user messages and assistant responses rendered as a scrollable conversation
- Auto-scroll to bottom on new messages/streaming content
- Single long-lived `query()` session using `AsyncIterable<SDKUserMessage>` prompt for multi-turn
- Input clears after submit, disabled during streaming
- Clean session lifecycle (start on mount, abort on unmount)

---

## Files to Create

### 1. `src/lib/push-stream.ts` — Push-based async iterable

A reusable utility that creates an `AsyncIterable` you can push values into imperatively. This bridges React's event-driven model (user clicks submit) with the SDK's pull-based async iteration model.

```typescript
// Types
interface PushStream<T> extends AsyncIterable<T> {
  push(value: T): void
  end(): void
}

// Factory
function createPushStream<T>(): PushStream<T>
```

**Implementation details:**

- Internal queue (`T[]`) buffers values pushed before they're consumed
- A pending `resolve` callback is stored when the consumer is waiting and the queue is empty
- `push(value)` either resolves the pending callback immediately or enqueues the value
- `end()` signals completion — returns `{ done: true }` from `next()`
- The `[Symbol.asyncIterator]()` method returns an object with a `next()` that:
  - Returns from queue if non-empty
  - Returns `{ done: true }` if ended
  - Otherwise creates a new `Promise` and stores its `resolve` for `push()` to call later

```typescript
export interface PushStream<T> extends AsyncIterable<T> {
  push(value: T): void
  end(): void
}

export function createPushStream<T>(): PushStream<T> {
  const queue: T[] = []
  let waiting: ((result: IteratorResult<T>) => void) | null = null
  let done = false

  return {
    push(value: T) {
      if (done) return
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value, done: false })
      } else {
        queue.push(value)
      }
    },

    end() {
      done = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined as never, done: true })
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
      }
    },
  }
}
```

**Why a separate file:** This utility will be reused by other agent session types in later phases (experiment agent, cleanup agent). It has no dependencies and is independently testable.

[NEW] **Why not `async function*`?** The official SDK examples use `async function*` generators for streaming input. However, generators are pull-based — the consumer calls `next()` and the generator yields. In React, user input arrives via event handlers (`onSubmit`), which are push-based. You can't `yield` from inside an event handler callback. The PushStream bridges this gap: React event handlers call `push()`, and the SDK pulls via `[Symbol.asyncIterator]`. This is the correct pattern for React; do not refactor to `async function*` generators.

---

## Files to Modify

### 2. `src/components/Chat.tsx` — Complete rewrite

This is the main work item. The component transforms from a single-turn request/response to a full multi-turn conversation.

#### Imports

```typescript
import { useState, useEffect, useRef, useCallback } from "react"
import { query, type SDKUserMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { MessageParam } from "@anthropic-ai/sdk/resources"
import { createPushStream, type PushStream } from "../lib/push-stream.ts"
```

> **Note on imports:** `SDKUserMessage` and `SDKMessage` are exported from `@anthropic-ai/claude-agent-sdk` (confirmed in `sdk.d.ts`). `MessageParam` is from `@anthropic-ai/sdk/resources` (the underlying Anthropic SDK, installed as a dependency of the agent SDK). If `SDKUserMessage` is not directly importable from the top-level, import from `@anthropic-ai/claude-agent-sdk/sdk.js` or construct the type manually:
> ```typescript
> type UserMessage = {
>   type: 'user'
>   message: { role: 'user'; content: string }
>   parent_tool_use_id: null
> }
> ```

#### Types

```typescript
interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
}
```

- `id` — unique key for React list rendering. Use `crypto.randomUUID()` (available in Bun globally).
- `role` — determines rendering style (alignment, color)
- `content` — full text content

#### State

```typescript
const [messages, setMessages] = useState<ChatMessage[]>([])       // Completed messages
const [streamingText, setStreamingText] = useState("")             // Current partial assistant response
const [isStreaming, setIsStreaming] = useState(false)               // Whether agent is responding
const [error, setError] = useState<string | null>(null)            // Session-level errors
const inputStreamRef = useRef<PushStream<SDKUserMessage> | null>(null)  // Ref to push stream
const inputRef = useRef<any>(null)                                 // Ref to input element for clearing
```

#### Agent Session Lifecycle (useEffect)

On mount, create the push stream and start a `query()` session. On unmount, clean up.

```typescript
useEffect(() => {
  const abortController = new AbortController()
  const inputStream = createPushStream<SDKUserMessage>()
  inputStreamRef.current = inputStream

  // Background processing loop
  ;(async () => {
    try {
      const q = query({
        prompt: inputStream,
        options: {
          systemPrompt: "You are AutoAuto, an autoresearch assistant. Be concise.",
          // [CHANGED] maxTurns removed — it counts tool-use turns only (per SDK docs).
          // With allowedTools: [], there are zero tool-use turns, making maxTurns a no-op
          // at best and a query-termination risk at worst. Omit entirely.
          allowedTools: [],
          includePartialMessages: true,
          abortController,
          persistSession: false,
        },
      })

      for await (const message of q) {
        if (abortController.signal.aborted) break

        if (message.type === "stream_event") {
          const event = message.event
          if (
            event.type === "content_block_delta" &&
            "delta" in event &&
            event.delta.type === "text_delta" &&
            "text" in event.delta
          ) {
            setStreamingText((prev) => prev + (event.delta as { text: string }).text)
          }
        } else if (message.type === "assistant") {
          // Turn complete — extract full text and move to messages
          const fullText = message.message.content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("")

          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", content: fullText },
          ])
          setStreamingText("")
          setIsStreaming(false)
        } else if (message.type === "result") {
          // Session ended (success or error)
          if (message.subtype !== "success") {
            setError(`Agent error: ${(message as any).errors?.join(", ") ?? "unknown"}`)
          }
          setIsStreaming(false)
        }
      }
    } catch (err: unknown) {
      if (!abortController.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err))
        setIsStreaming(false)
      }
    }
  })()

  return () => {
    abortController.abort()
    inputStream.end()
    inputStreamRef.current = null
  }
}, [])
```

**Key design decisions:**

1. **`AsyncIterable` prompt, not `streamInput()`** — Using the `prompt: inputStream` pattern means the query pulls messages as we push them. The `for await` loop blocks between turns (when the SDK is waiting for the next user message), and resumes when `inputStream.push()` delivers one. This is the recommended "Streaming Input Mode" per the official SDK docs. It is simpler than calling `streamInput()` separately.

2. **`persistSession: false`** — Prevents the SDK from writing session files to disk. AutoAuto manages its own state via `.autoauto/`. Context is still maintained in-memory within the single `query()` call — this only controls disk persistence.

3. **`abortController`** — Enables clean cancellation on unmount (e.g., user presses Escape to leave setup).

4. [CHANGED] **No `maxTurns`** — `maxTurns` counts tool-use turns only (per official SDK docs: "counts tool-use turns only"). With `allowedTools: []`, there are zero tool-use turns, so `maxTurns` is meaningless. Omitting it avoids any risk of the SDK misinterpreting it as a conversation turn limit. Phase 1b will add `maxTurns` when tools are introduced.

5. **`allowedTools: []`** — No tools for now. Phase 1b adds repo inspection tools.

6. **Extracting text from assistant messages** — `message.message.content` is an array of `ContentBlock` objects (text blocks, tool use blocks, etc.). Filter for `type === "text"` and concatenate.

#### Submit Handler

```typescript
const handleSubmit = useCallback(
  (value: string) => {
    const text = value.trim()
    if (!text || isStreaming || !inputStreamRef.current) return

    // Add user message to history
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: text },
    ])

    // [CHANGED] Push to agent session — use `as const` on type/role fields to match
    // official SDK examples. parent_tool_use_id is required by the SDK type definition
    // but omitted in official docs examples; include it for type safety.
    inputStreamRef.current.push({
      type: "user" as const,
      message: { role: "user" as const, content: text },
      parent_tool_use_id: null,
    })

    setIsStreaming(true)
    setStreamingText("")
    setError(null)

    // Clear input
    if (inputRef.current) {
      inputRef.current.value = ""
    }
  },
  [isStreaming],
)
```

**Input clearing:** Use a ref to imperatively set `value = ""` on the OpenTUI input renderable. This is more reliable than controlled state with OpenTUI's React reconciler. If the ref approach doesn't work (reconciler doesn't forward refs for intrinsic elements), fall back to a key-based remount:

```tsx
const [inputKey, setInputKey] = useState(0)
// In handleSubmit: setInputKey(k => k + 1)
// In JSX: <input key={inputKey} ... />
```

#### Render

```tsx
return (
  <box flexDirection="column" flexGrow={1}>
    {/* Conversation area */}
    <scrollbox
      focused={isStreaming}
      flexGrow={1}
      border
      borderStyle="rounded"
      stickyScroll
      stickyStart="bottom"
    >
      {messages.length === 0 && !streamingText ? (
        <text fg="#888888">
          Type a message below and press Enter to start a conversation.
        </text>
      ) : (
        <box flexDirection="column">
          {messages.map((msg) => (
            <box key={msg.id} flexDirection="column">
              <text fg={msg.role === "user" ? "#7aa2f7" : "#9ece6a"}>
                <strong>{msg.role === "user" ? "You" : "AutoAuto"}</strong>
              </text>
              <text>{msg.content}</text>
              <text>{""}</text>
            </box>
          ))}

          {streamingText && (
            <box flexDirection="column">
              <text fg="#9ece6a">
                <strong>AutoAuto</strong>
              </text>
              <text>{streamingText}</text>
            </box>
          )}

          {isStreaming && !streamingText && (
            <box flexDirection="column">
              <text fg="#9ece6a">
                <strong>AutoAuto</strong>
              </text>
              <text fg="#888888">Thinking...</text>
            </box>
          )}

          {error && (
            <text fg="#ff5555">Error: {error}</text>
          )}
        </box>
      )}
    </scrollbox>

    {/* Input area */}
    <box border borderStyle="rounded" height={3} title="Message">
      <input
        ref={inputRef}
        placeholder={isStreaming ? "Waiting for response..." : "Ask something..."}
        focused={!isStreaming}
        onSubmit={((value: string) => { handleSubmit(value) }) as any}
      />
    </box>
  </box>
)
```

**Rendering decisions:**

1. **`stickyScroll` + `stickyStart="bottom"`** — Auto-scrolls to bottom as new content arrives. When the user manually scrolls up, sticky behavior breaks (OpenTUI tracks this internally). Scrolling back to bottom re-engages sticky scroll.

2. **Message styling** — User messages in blue (`#7aa2f7`), assistant in green (`#9ece6a`). Role label on its own line, content below. Empty `<text>` for spacing between messages.

3. **Three streaming states rendered:**
   - `isStreaming && !streamingText` → "Thinking..." placeholder (before first token arrives)
   - `streamingText` non-empty → partial response being built up
   - Neither → idle, waiting for user input

4. **`focused` toggling** — Scrollbox gets focus during streaming (so user can scroll through conversation). Input gets focus when idle (so user can type). Only one element should be focused at a time in OpenTUI.

5. **Status bar removed** — The parent `SetupScreen`/`App` already shows contextual hints. The `Chat` component no longer renders its own status text (that was only needed when it was self-contained).

#### Removed from Chat

- The `loading` status text at the bottom (moved to parent already in current code via App.tsx's bottom bar)
- The single `response` state — replaced by `messages[]` + `streamingText`

### 3. `src/screens/SetupScreen.tsx` — Minor update

No changes needed if `Chat` maintains its current interface (no props). The component already wraps `<Chat />` and handles Escape navigation.

If Chat needs props in the future (e.g., `cwd`, `onComplete`), add them here. For 1a, no props needed.

### 4. `src/App.tsx` — No changes

The bottom status bar already shows contextual help text. No modifications needed.

---

## Integration Details

### How the multi-turn flow works end-to-end

```
1. User navigates to Setup screen (presses 'n' on HomeScreen)
2. SetupScreen mounts → Chat mounts
3. Chat's useEffect fires:
   a. Creates PushStream<SDKUserMessage>
   b. Calls query({ prompt: pushStream, options: { ... } })
   c. Starts for-await loop on the query (blocks waiting for first push)
4. User types "optimize my homepage LCP" → presses Enter
5. handleSubmit fires:
   a. Appends { role: 'user', content: '...' } to messages state
   b. Pushes SDKUserMessage to pushStream
   c. Sets isStreaming = true
   d. Clears input
6. query() pulls the message from pushStream → sends to Claude API
7. Stream events flow back:
   a. content_block_delta events → append to streamingText
   b. UI re-renders showing partial response with auto-scroll
8. Assistant message completes:
   a. 'assistant' message received → extract text → append to messages
   b. Clear streamingText, set isStreaming = false
9. for-await loop blocks again, waiting for next push
10. User types follow-up → repeat from step 5
11. User presses Escape → SetupScreen unmounts → Chat unmounts
12. Cleanup: abortController.abort(), pushStream.end()
```

### SDK message type handling

| SDK Message Type | What to do |
|---|---|
| `stream_event` (content_block_delta, text_delta) | Append text to `streamingText` |
| `stream_event` (other delta types) | Ignore for now (tool use, thinking blocks come later) |
| `assistant` | Extract text blocks, append full message to `messages`, clear streaming state |
| `result` (success) | No action needed (session continues) |
| `result` (error) | Set error state, stop streaming |
| `system` | Ignore (compact boundaries, retries, etc.) |
| `status` | Ignore (internal SDK state) |
| All others | Ignore silently |

[CHANGED] ### Note: `maxTurns` omitted deliberately

`maxTurns` is omitted from the options for 1a. Per the official SDK docs, `maxTurns` "counts tool-use turns only" — it limits how many times the agent can call tools in a loop, not how many conversation turns occur. With `allowedTools: []`, there are zero tool-use turns per user message, so `maxTurns` would be meaningless.

In phase 1b, when tools are added (Read, Glob, Bash), `maxTurns` should be set (e.g., 10-30) to prevent runaway tool loops during the setup agent's repo inspection.

---

## Testing Approach

### Manual testing via tmux

```bash
# Launch the app
tmux new-session -d -s autoauto -x 120 -y 30 'bun dev'

# Wait for render, then navigate to setup
sleep 1
tmux send-keys -t autoauto 'n'
sleep 1

# Type a message
tmux send-keys -t autoauto 'Hello, what can you help me with?' Enter

# Wait for response, check the screen
sleep 5
tmux capture-pane -t autoauto -p

# Send a follow-up to test multi-turn
tmux send-keys -t autoauto 'Tell me more about that' Enter
sleep 5
tmux capture-pane -t autoauto -p

# Verify: both user messages and both assistant responses should be visible
# Verify: scrollbox auto-scrolled to show latest content
# Verify: input is cleared after each submit

# Test escape back to home
tmux send-keys -t autoauto Escape
sleep 1
tmux capture-pane -t autoauto -p
# Verify: back on home screen, no crash

# Clean up
tmux kill-session -t autoauto
```

### What to verify

1. **Multi-turn history** — After 2+ exchanges, all user and assistant messages are visible in the scrollbox
2. **Auto-scroll** — When new streaming content arrives, view scrolls to bottom
3. **Manual scroll** — User can scroll up during streaming; scrolling to bottom re-engages auto-scroll
4. **Input clearing** — Input field clears after submit
5. **Input disabled during streaming** — Typing during streaming should not work (input loses focus)
6. **Escape navigation** — Pressing Escape during idle goes back to home; during streaming, the abort fires cleanly
7. **Error handling** — If `ANTHROPIC_API_KEY` is not set, error message appears in chat
8. **No session files** — No `.claude/` session files created in the project directory

---

## Potential Issues & Mitigations

[CHANGED] ### 1. `query()` with AsyncIterable might not work as expected

The official SDK docs confirm that `AsyncIterable<SDKUserMessage>` is the recommended "Streaming Input Mode" — the SDK pulls messages on demand and the session stays alive between turns. This is verified in the SDK type definitions and documentation. However, if runtime behavior diverges from docs, fallbacks are:
- **Option A:** Use `streamInput()` on the Query object. Start with the first message as a string, then call `q.streamInput()` for each follow-up.
- **Option B:** Use `continue: true` — call `query()` fresh each turn with `continue: true` to resume the session (the "Single Message Input" pattern from the SDK docs).
- **Option C:** Use the V2 preview API — `unstable_v2_createSession()` with `session.send()` + `session.stream()`. Simpler but unstable/preview.

### 2. Input ref might not work with OpenTUI React

OpenTUI's React reconciler may not forward refs for intrinsic elements (`<input>`). If so:
- **Fallback:** Use a key-based remount to force the input to reset: `<input key={inputKey} ... />` where `inputKey` increments after each submit.

### 3. `stickyScroll` prop might not work as a direct prop

OpenTUI React might expect `stickyScroll` inside a `style` object rather than as a direct prop. The convention in this codebase is direct props (see CLAUDE.md: "Layout props are direct props, not style objects"). If it doesn't work as a direct prop:
- Try: `<scrollbox style={{ stickyScroll: true, stickyStart: "bottom" }}>`

### 4. Content blocks type casting

The `message.message.content` from `SDKAssistantMessage` is typed as `ContentBlock[]` from the Anthropic SDK. The text extraction needs type-safe access:
```typescript
// Safe extraction
const textContent = message.message.content
  .filter((block): block is { type: "text"; text: string } => block.type === "text")
  .map((block) => block.text)
  .join("")
```

If the type narrowing doesn't work cleanly, use explicit casting or access `(block as any).text`.

---

## Dependencies

- No new npm packages needed
- `crypto.randomUUID()` — available globally in Bun runtime
- `@anthropic-ai/claude-agent-sdk` — already installed, using `query`, `SDKUserMessage`, `SDKMessage` types
- `@anthropic-ai/sdk/resources` — transitive dependency, `MessageParam` type

---

## Doc & Config Updates

### CLAUDE.md

Add to the **Project Structure** section:

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Main layout, keyboard handling
  components/
    Chat.tsx             # Multi-turn chat with Claude Agent SDK streaming
  screens/
    HomeScreen.tsx       # Program list
    SetupScreen.tsx      # Setup flow (chat wrapper)
  lib/
    programs.ts          # Filesystem ops, program CRUD
    push-stream.ts       # Push-based async iterable utility
```

Add to **OpenTUI Conventions**:

```
- Use `stickyScroll` + `stickyStart="bottom"` on `<scrollbox>` for auto-scroll-to-bottom behavior
- Clear `<input>` after submit via ref (`inputRef.current.value = ""`) or key remount
```

### docs/architecture.md

Update the **Components** section:

```markdown
## Components

- **Chat** (`src/components/Chat.tsx`) — Multi-turn conversational interface. Maintains a
  long-lived `query()` session using a push-based `AsyncIterable<SDKUserMessage>` prompt.
  Renders full message history (user + assistant) in an auto-scrolling scrollbox.
  Streams assistant responses token-by-token via `includePartialMessages`.

## Utilities

- **PushStream** (`src/lib/push-stream.ts`) — Generic push-based async iterable. Bridges
  imperative push (React event handlers) with pull-based async iteration (SDK query loop).
  Used by Chat to feed user messages into the agent session.
```

Update the **Current State** section:

```markdown
## Current State

Phase 1 (Setup) is in progress. The TUI shell, screen navigation, program listing, and
multi-turn Claude Agent SDK chat are wired up. The chat foundation supports full conversation
history with auto-scrolling and streaming. The setup agent's guided workflow (repo inspection,
measurement script generation, program.md creation) is not yet implemented.
```

---

## Summary of Changes

| File | Action | Description |
|---|---|---|
| `src/lib/push-stream.ts` | **Create** | Push-based async iterable utility |
| `src/components/Chat.tsx` | **Rewrite** | Multi-turn chat with message history, auto-scroll, long-lived SDK session |
| `CLAUDE.md` | **Update** | Add push-stream.ts to project structure, add scrollbox conventions |
| `docs/architecture.md` | **Update** | Document Chat multi-turn architecture and PushStream utility |

## Order of Implementation

1. Create `src/lib/push-stream.ts` (no dependencies, can be written first)
2. Rewrite `src/components/Chat.tsx` (depends on push-stream)
3. Run `bun lint && bun typecheck` to verify
4. Test interactively via tmux
5. [CHANGED] If AsyncIterable prompt causes issues, apply mitigation from "Potential Issues" section (maxTurns is no longer a concern — it's been removed)
6. If input clearing doesn't work via ref, apply key-remount fallback
7. Update `CLAUDE.md` and `docs/architecture.md`
8. Final `bun lint && bun typecheck` pass

---

[NEW] ## Known Limitations (MVP)

Documented gaps accepted for phase 1a, to be addressed in later phases:

1. **No error recovery.** A transient API error (rate limit, network timeout, 500) terminates the `for await` loop and kills the entire conversation. The user must restart the setup flow and re-enter all context. For a setup chat this is acceptable — conversations are short and the cost of restarting is low. Phase 1b should consider wrapping the loop in retry logic or session resumption via `continue: true`.

2. **Conversation lost on navigation.** Pressing Escape to leave the Setup screen unmounts Chat, which aborts the query and destroys all conversation history. There is no session persistence or "back to chat" flow. This is acceptable for MVP — the Setup screen is the only consumer.

3. **No context window management.** Long conversations will accumulate context until the SDK auto-compacts. The plan relies on the SDK's built-in compaction (which emits `SDKCompactBoundaryMessage`). No custom compaction handling is implemented. For setup conversations (typically <20 turns), this is unlikely to matter.

4. **V2 SDK not used.** The Claude Agent SDK has a V2 preview (`unstable_v2_createSession()` with `send()/stream()`) that simplifies multi-turn. It's not used here because it's unstable/preview. Revisit when V2 stabilizes — it would eliminate the need for PushStream entirely.

---

[NEW] ## Review Notes

This plan was reviewed against the official Claude Agent SDK documentation (streaming input mode, agent loop, sessions) and OpenTUI type definitions. Key research findings that informed changes:

- **SDK streaming input docs confirm** `AsyncIterable<SDKUserMessage>` is the recommended multi-turn pattern. The session stays alive and pulls messages on demand.
- **`maxTurns` counts tool-use turns only** (official docs: "counts tool-use turns only"). Removed from options since `allowedTools: []` means zero tool-use turns.
- **Official examples use `async function*` generators**, but PushStream is the correct choice for React (event handlers can't yield into generators). Rationale documented in push-stream.ts section.
- **OpenTUI APIs confirmed**: `stickyScroll`, `stickyStart="bottom"`, input `ref` support, `onSubmit` — all verified in type definitions.
