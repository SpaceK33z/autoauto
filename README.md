# AutoAuto

A TUI tool that makes the [autoresearch](https://github.com/karpathy/autoresearch) pattern easy to set up and run on any project. Define a metric, let an AI agent iteratively optimize code, keep improvements, discard failures, loop forever.

## Quick Start

```bash
bun install
bun run src/index.tsx
```

Or install globally:

```bash
bun link
autoauto
```

Requires Claude CLI installed and authenticated, or `ANTHROPIC_API_KEY` set.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **TUI:** [OpenTUI](https://opentui.com) (React reconciler)
- **Agent:** [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)

## How It Works

AutoAuto encodes autoresearch expertise into a guided workflow:

1. **Setup** — Inspect a repo, define what to optimize, generate a measurement script, set scope constraints
2. **Execute** — Run an autonomous loop: spawn an agent, make one change, measure, keep or discard, repeat
3. **Cleanup** — Review accumulated changes, squash into clean commits, generate a summary report

The app controls the flow, agents provide the intelligence. Each agent is stateless between iterations — AutoAuto maintains all state.

## License

MIT
