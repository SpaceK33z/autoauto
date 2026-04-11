# AutoAuto

TUI tool for autoresearch — autonomous experiment loops on any codebase.

## Key Docs

- `docs/concepts.md` — How AutoAuto works: programs, runs, experiments, measurement, agents
- `docs/glossary.md` — Quick definitions for core AutoAuto terms
- `docs/measurement-guide.md` — Writing good measurement scripts, choosing metrics, pitfalls
- `docs/use-cases.md` — Use case ideas across performance, prompts, marketing, and more
- `docs/architecture.md` — Internal architecture for contributors
- `docs/patterns/metric-design.md` — Metric design, scoring approaches, variance handling, gaming defenses
- `docs/patterns/failure-modes.md` — Failure modes, anti-patterns & safeguards from real implementations
- `docs/patterns/loop-tuning.md` — Loop design, context packets, stopping criteria, model choice
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

## Releasing

- **release-please** manages versions and changelogs automatically via conventional commits
- Merging to `main` creates/updates a Release PR; merging that PR triggers the release
- Release workflow builds cross-platform binaries (darwin-arm64, darwin-x64, linux-x64, linux-arm64) and publishes to npm via OIDC trusted publishing (no tokens)
- npm package: `@spacek33z/autoauto`
- The `autorelease:` labels must exist in the repo for release-please to work — do NOT re-add `skip-labeling: true`

## Before Committing

Always run both checks before considering work done:

```bash
bun lint && bun typecheck
```

## Testing

Follow **Red-Green-Refactor** (TDD cycle) when adding or fixing features:

1. **Red** — Write a failing test first that captures the expected behavior
2. **Green** — Write the minimal code to make the test pass
3. **Refactor** — Clean up the code while keeping tests green

E2E tests live in `src/e2e/` and use OpenTUI's test renderer (`@opentui/react/test-utils`):

- `fixture.ts` — `createTestFixture()` creates an isolated temp git repo with `.autoauto` structure
- `helpers.ts` — `renderTui()` returns a `TuiHarness` with `frame()`, `press()`, `enter()`, `escape()`, `type()`, `waitForText()`, etc.
- `mock-provider.ts` — `MockProvider` emits scripted `AgentEvent` sequences without any real SDK

```bash
bun test src/e2e/          # Run all E2E tests
bun test src/e2e/foo.e2e.test.tsx  # Run one test file
```

**Known limitation:** `<scrollbox flexGrow={1}>` causes text overlap in `captureCharFrame()`. Assert content above the scrollbox or test keyboard callbacks (which work regardless).

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
  index.tsx              # Entry point dispatcher (CLI args → cli.ts, else → tui.tsx)
  tui.tsx                # TUI entry: creates renderer, registers providers, mounts <App />
  cli.ts                 # Headless CLI: list/run/stop/attach without TUI
  App.tsx                # Screen routing, global keys, config check
  daemon.ts              # Background daemon entry point (detached process)
  components/
    Chat.tsx             # Agent streaming chat (multi-turn)
    ResultsTable.tsx     # Navigable experiment results table (Tab to focus, j/k/arrows to browse, Enter to inspect)
    RunsTable.tsx        # Runs table for HomeScreen
    StatsHeader.tsx      # Run stats + metric sparkline
    AgentPanel.tsx       # Live agent streaming output OR experiment detail view
    RunCompletePrompt.tsx # Post-run prompt (finalize, update, or abandon)
    PostUpdatePrompt.tsx # Post-update prompt (start run or go home)
    CycleField.tsx       # Reusable cycle-through field component
    ModelPicker.tsx      # Model selection UI with provider-specific lists
    RunSettingsOverlay.tsx # Inline max-experiments editor overlay
  screens/
    FirstSetupScreen.tsx # First-time setup (provider/model + auth check)
    HomeScreen.tsx       # Two-panel: programs list + runs table
    SetupScreen.tsx      # Setup flow + update mode (chat wrapper + agent config)
    PreRunScreen.tsx     # Pre-run config (model/effort/max/worktree/carry-forward overrides)
    ExecutionScreen.tsx  # Three-panel experiment dashboard
    SettingsScreen.tsx   # Model configuration (execution + support slots)
    AuthErrorScreen.tsx  # Auth error display with setup instructions
  lib/
    agent/               # Agent provider abstraction layer
      types.ts           # AgentEvent, AgentSession, AgentProvider interfaces
      index.ts           # Provider registry (setProvider/getProvider)
      claude-provider.ts # Claude Agent SDK provider
      codex-provider.ts  # Codex CLI provider
      opencode-provider.ts # OpenCode provider
      default-providers.ts # Registers all available providers at startup
      mock-provider.ts   # Mock provider for testing
    auth.ts              # Authentication checking via agent provider
    config.ts            # Project config CRUD (.autoauto/config.json)
    git.ts               # Git operations (branch, revert, log, SHA, diff stats)
    measure.ts           # Measurement execution, validation, comparison
    programs.ts          # Filesystem ops, program CRUD, config types
    push-stream.ts       # Push-based async iterable utility
    queue.ts               # Sequential run queue: persistence, manipulation, daemon chaining
    run.ts               # Run state persistence, types, results I/O, previous run context
    run-setup.ts         # Run bootstrap: directory init, measurement locking
    system-prompts/      # Agent system prompts
      index.ts           # Re-exports prompt builders
      setup.ts           # Setup agent prompt
      update.ts          # Update agent prompt
      experiment.ts      # Experiment agent prompt
      finalize.ts        # Finalize agent prompt
    tool-events.ts       # Tool event display formatting
    validate-measurement.ts  # Standalone measurement validation script
    experiment.ts          # Experiment agent spawning, context packets, lock detection
    experiment-loop.ts     # Main experiment loop orchestrator
    ideas-backlog.ts       # Ideas backlog: append/read per-experiment notes (ideas.md)
    model-options.ts       # Model picker option loading from providers
    format.ts              # Table formatting utilities (padRight, truncate, column allocation)
    syntax-theme.ts        # Tokyo Night syntax highlighting theme for code display
    worktree.ts            # Git worktree create/remove for run isolation
    finalize.ts            # Post-run finalize: context building, report generation, completion detection
    daemon-callbacks.ts    # FileCallbacks: LoopCallbacks impl for daemon (per-experiment stream log writes)
    daemon-lifecycle.ts    # Daemon identity, heartbeat, signals, crash recovery, locking
    run-context.ts         # Build update agent context from previous run data
    daemon-client.ts       # Barrel re-export for daemon-spawn, daemon-watcher, daemon-status
    daemon-spawn.ts        # TUI-side: prepare environment and spawn detached daemon process
    daemon-watcher.ts      # TUI-side: file watching with delta reads, debouncing, heartbeat
    daemon-status.ts       # TUI-side: daemon status, state reconstruction, control, config
```

## Bun-Native API Conventions

Prefer Bun built-in APIs over Node.js equivalents. Do NOT use `node:child_process`, `node:util`, or `node:fs/promises` for things Bun handles natively.

**Shell commands (`Bun.$`)** — use for all subprocess calls (git, ps, etc.):
```ts
import { $ } from "bun"
const sha = (await $`git rev-parse HEAD`.cwd(cwd).text()).trim()
await $`git reset --hard ${sha}`.cwd(cwd).quiet()                   // no output needed
const ok = (await $`git show-ref ...`.cwd(cwd).nothrow().quiet()).exitCode === 0  // may fail
```

**File reads (`Bun.file()`)** — use instead of `readFile`:
```ts
const text = await Bun.file(path).text()     // string
const data = await Bun.file(path).json()     // parsed JSON
const exists = await Bun.file(path).exists()  // instead of access()
const size = Bun.file(path).size              // sync, no stat() needed
const slice = await Bun.file(path).slice(start, end).text()  // byte-range read
```

**File writes (`Bun.write()`)** — use instead of `writeFile`:
```ts
await Bun.write(path, content)  // simple write
// For atomic writes, still use Bun.write + rename:
await Bun.write(tmpPath, content)
await rename(tmpPath, finalPath)  // from node:fs/promises
```

**Streaming appends (`FileSink`)** — use for high-frequency log appending:
```ts
const writer = Bun.file(path).writer()
writer.write(chunk)
writer.flush()  // explicit flush for visibility
writer.end()    // close when done
```

**Exception: `node:child_process` spawn** — still required when `detached: true` is needed (daemon spawning, process-group killing via `process.kill(-pid)`). Do NOT replace these with `Bun.spawn`.

**Exception: `node:fs/promises`** — still needed for: `mkdir`, `chmod`, `readdir`, `rename`, `unlink`, `appendFile`, `open` with O_EXCL flags.

## Implementation Rules

See `docs/concepts.md` for how the system works and `docs/architecture.md` for internal details. These are the hard rules to follow when modifying the codebase:

- Shared types (`ProgramConfig`, `QualityGate`) live in `src/lib/programs.ts` — import from there, not from `validate-measurement.ts`
- `results.tsv` is append-only — use `appendResult()`, never rewrite
- Measurement locking (`chmod 444`) is the #1 safeguard — always lock before experiment loop, unlock on completion
- `git reset --hard` only inside worktree, never main checkout
- Two-root path model: `cwd` (worktree for git/agent ops) vs `programDir` (main root for config/state) — easy to confuse, always check which root you need
- Run state: atomic writes via temp-file + rename (`writeState()` in `run.ts`)
- Model config: two slots (`executionModel`, `supportModel`) in `.autoauto/config.json`; defaults: Sonnet + high effort

## Testing the TUI Interactively

Use tmux to launch and interact with the TUI app:

```bash
tmux new-session -d -s autoauto -x 80 -y 24 'bun dev'  # Launch in background
tmux send-keys -t autoauto 'n'                           # Send keystrokes
tmux capture-pane -t autoauto -p                         # Read the screen
tmux kill-session -t autoauto                            # Clean up
```

## Knowledge Base

A curated knowledge base about autoresearch is available via the `qmd` MCP server. Use it to look up concepts, patterns, case studies, and prior art when making design decisions:

- `qmd query "how to detect metric gaming"` — semantic search across all pages
- `qmd search "ratchet mechanism"` — keyword search

For deeper reading, the full knowledge base is at `knowledge-base/` (symlinked to an Obsidian vault, gitignored). Read pages directly when `qmd` results aren't enough:

- `knowledge-base/wiki/` — generated markdown pages (concepts, entities, patterns, case-studies, sources)
- `knowledge-base/wiki/index.md` — content catalog organized by category
- `knowledge-base/raw/articles/` — immutable raw source documents
- `knowledge-base/AGENTS.md` — schema and operating procedures for wiki maintenance

If the index is stale after wiki edits, run `qmd update && qmd embed` to re-index.

## Commits

Use Conventional Commits: `feat|fix|refactor|build|ci|chore|docs|style|perf|test`.
