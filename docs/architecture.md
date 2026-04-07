# Architecture

## Overview

Bun + TypeScript TUI app using OpenTUI React for rendering and Claude Agent SDK for AI interactions. App controls flow, agents provide intelligence.

## Entry Point

`src/index.tsx` — creates an OpenTUI CLI renderer and mounts the React root with `<App />`.

## Screen Navigation

`App.tsx` manages a simple `Screen` state (`"home" | "setup"`) and renders the active screen. Global keyboard handling (Escape to quit from home).

### Screens

- **HomeScreen** — lists existing programs from `.autoauto/programs/`, supports j/k navigation, `n` to create new
- **SetupScreen** — wraps the `Chat` component, Escape to go back

## Components

- **Chat** (`src/components/Chat.tsx`) — Multi-turn conversational interface. Maintains a long-lived `query()` session using a push-based `AsyncIterable<SDKUserMessage>` prompt. Renders full message history (user + assistant) in an auto-scrolling scrollbox. Streams assistant responses token-by-token via `includePartialMessages`.

## Utilities

- **PushStream** (`src/lib/push-stream.ts`) — Generic push-based async iterable. Bridges imperative push (React event handlers) with pull-based async iteration (SDK query loop). Used by Chat to feed user messages into the agent session.

## Data Layer

`src/lib/programs.ts` — filesystem operations against `.autoauto/` in the git repo root:

- `getProjectRoot()` — resolves through git worktrees to find the main repo root (cached)
- `listPrograms()` — reads program directories from `.autoauto/programs/`
- `ensureAutoAutoDir()` — creates `.autoauto/` and adds it to `.gitignore`

## File Structure

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Screen routing, global keys
  components/
    Chat.tsx             # Claude Agent SDK streaming chat
  screens/
    HomeScreen.tsx       # Program list
    SetupScreen.tsx      # Setup flow (chat wrapper + agent config)
  lib/
    programs.ts          # Filesystem ops, program CRUD
    push-stream.ts       # Push-based async iterable utility
    system-prompts.ts    # Agent system prompts (setup, ideation)
```

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

## Current State

Phase 1 (Setup) is in progress. The TUI shell, screen navigation, program listing, and multi-turn Claude Agent SDK chat are wired up. The chat foundation supports full conversation history with auto-scrolling and streaming. The setup agent has a system prompt for guided repo inspection, scope definition, and ideation mode, with Read/Bash/Glob/Grep tools auto-allowed for repo analysis. Program artifact generation (program.md, measure.sh, config.json) is not yet implemented.
