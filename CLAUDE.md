# AutoAuto

TUI tool for autoresearch — autonomous experiment loops on any codebase.

## Key Docs

- `IDEA.md` — Design choices and overall idea
- `docs/architecture.md` — System architecture (Bun + OpenTUI + Claude Agent SDK)
- `docs/autoresearch-ideas.md` — Non-ML autoresearch ideas extracted from reference articles
- `docs/failure-patterns.md` — Documented failure modes, anti-patterns & safeguards from real implementations
- `references/articles/INDEX.md` — 30 indexed autoresearch articles for inspiration

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
- For more details see `/opentui` skill
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

## Testing the TUI Interactively

Use tmux to launch and interact with the TUI app:

```bash
tmux new-session -d -s autoauto -x 80 -y 24 'bun dev'  # Launch in background
tmux send-keys -t autoauto 'n'                           # Send keystrokes
tmux capture-pane -t autoauto -p                         # Read the screen
tmux kill-session -t autoauto                            # Clean up
```

## Commits

Use Conventional Commits: `feat|fix|refactor|build|ci|chore|docs|style|perf|test`.
