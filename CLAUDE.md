# AutoAuto

TUI tool for autoresearch — autonomous experiment loops on any codebase.

## Stack

- **Runtime:** Bun (not Node)
- **Language:** TypeScript (strict mode)
- **TUI:** OpenTUI React (`@opentui/react`, `@opentui/core`)
- **Agent:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

## Commands

```bash
bun dev                  # Run the app
bun lint                 # Lint with oxlint
bun typecheck            # Type-check with tsc
```

## Before Committing

Always run both checks before considering work done:

```bash
bun lint && bun typecheck
```

## OpenTUI Conventions

- Layout props are **direct props**, not style objects: `<box flexDirection="column">` not `<box style={{...}}>`
- Intrinsic elements are lowercase: `<box>`, `<text>`, `<input>`, `<scrollbox>`
- Text modifiers are nested tags: `<text><strong>Bold</strong></text>`
- `<input>` requires `focused` prop to receive keystrokes
- Never call `process.exit()` — use `renderer.destroy()` via `useRenderer()` hook
- Run with `bun run`, never `npm` or `node`

## Project Structure

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Main layout, keyboard handling
  components/
    Chat.tsx             # Chat interface with Claude Agent SDK streaming
```

## Commits

Use Conventional Commits: `feat|fix|refactor|build|ci|chore|docs|style|perf|test`.
