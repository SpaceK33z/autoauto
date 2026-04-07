# AutoAuto

TUI tool for autoresearch — autonomous experiment loops on any codebase.

## Key Docs

- `IDEA.md` — Design choices and overall idea
- `docs/architecture.md` — System architecture (Bun + OpenTUI + Claude Agent SDK)
- `docs/autoresearch-ideas.md` — Non-ML autoresearch ideas extracted from reference articles
- `docs/failure-patterns.md` — Documented failure modes, anti-patterns & safeguards from real implementations
- `docs/measurement-patterns.md` — Metric design, scoring approaches, variance handling, gaming defenses
- `docs/orchestration-patterns.md` — Loop design, context packets, ideas backlog, stopping criteria, model choice
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
- Use `stickyScroll` + `stickyStart="bottom"` on `<scrollbox>` for auto-scroll-to-bottom behavior
- Clear `<input>` after submit via key remount (`<input key={inputKey} />` where `inputKey` increments)
- Never call `process.exit()` — use `renderer.destroy()` via `useRenderer()` hook
- Run with `bun run`, never `npm` or `node`

## Project Structure

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
    git.ts               # Git operations (branch, revert, log, SHA)
    measure.ts           # Measurement execution, validation, comparison
    programs.ts          # Filesystem ops, program CRUD, config types
    push-stream.ts       # Push-based async iterable utility
    run.ts               # Run lifecycle (branch, baseline, state, locking)
    system-prompts.ts    # Agent system prompts (setup, ideation)
    tool-events.ts       # Tool event display formatting
    validate-measurement.ts  # Standalone measurement validation script
    experiment.ts          # Experiment agent spawning, context packets, lock detection
    experiment-loop.ts     # Main experiment loop orchestrator
```

## Agent Conventions

- Setup Agent uses built-in SDK tools (Read, Write, Edit, Bash, Glob, Grep)
- Agent tools are auto-approved via `permissionMode: "bypassPermissions"` — AutoAuto is the host app
- `cwd` is always set to the target project root (resolved via `getProjectRoot()`)
- System prompts live in `src/lib/system-prompts.ts`
- Tool status is displayed in the chat UI as brief one-line indicators
- Setup Agent writes program artifacts to `.autoauto/programs/<slug>/` only after user confirmation
- Setup Agent validates measurement stability after saving program files
- Measurement validation uses a standalone script (`src/lib/validate-measurement.ts`) called via Bash
- The validation script runs measure.sh multiple times and computes variance statistics (CV%)
- Config recommendations (noise_threshold, repeats) are based on observed CV%
- Model configuration (model alias + effort level) stored in `.autoauto/config.json`
- Two model slots: `executionModel` (for experiment agents) and `supportModel` (for setup/cleanup)
- Defaults: Sonnet + high effort for both slots
- Model/effort passed to `query()` via `model` and `effort` options
- Auth checked on startup via SDK `accountInfo()` — supports API key, OAuth, and cloud providers
- Shared types (`ProgramConfig`, `QualityGate`) live in `src/lib/programs.ts` — import from there, not from `validate-measurement.ts`
- Run state persisted atomically via temp-file + rename (`writeState()` in `src/lib/run.ts`)
- Results.tsv is append-only — use `appendResult()`, never rewrite
- Evaluator locking (`chmod 444`) is the #1 safeguard — always lock before experiment loop, unlock on completion
- Git operations in `src/lib/git.ts` — prefer `git revert` over `git reset` to preserve history
- Measurement series returns median of N runs — use `runMeasurementSeries()` for all metric comparisons
- `compareMetric()` uses relative change as a decimal fraction compared against `noise_threshold`
- Experiment Agent is one-shot: single user message → autonomous run → commit or exit
- Experiment Agent system prompt = program.md wrapped with framing instructions (`getExperimentSystemPrompt()`)
- Context packet = per-iteration user message with baseline, recent results, git log, discarded diffs
- Experiment Agent tools: Read, Write, Edit, Bash, Glob, Grep — same as setup, auto-approved
- Lock violation detection: after agent commits, check `git diff` for any `.autoauto/` modifications → immediate discard
- Loop callbacks (`LoopCallbacks`) are the interface between orchestrator and TUI — no events/observables needed
- AbortSignal (`options.signal`) provides cooperative cancellation for stop/abort

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
