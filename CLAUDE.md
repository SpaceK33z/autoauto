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
  daemon.ts              # Background daemon entry point (detached process)
  components/
    Chat.tsx             # Multi-turn chat with Claude Agent SDK streaming
    RunCompletePrompt.tsx # Post-run prompt (cleanup or abandon)
    StatsHeader.tsx      # Run stats + metric sparkline
    ResultsTable.tsx     # Navigable experiment results table (Tab to focus, j/k/arrows to browse, Enter to inspect)
    AgentPanel.tsx       # Live agent streaming output OR experiment detail view
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
    worktree.ts            # Git worktree create/remove for run isolation
    daemon-callbacks.ts    # FileCallbacks: LoopCallbacks impl for daemon (per-experiment stream log writes)
    daemon-lifecycle.ts    # Daemon identity, heartbeat, signals, crash recovery, locking
    daemon-client.ts       # TUI-side: spawn daemon, watch files, send control, reconnect
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

## Agent Conventions

- Setup Agent uses built-in SDK tools (Read, Write, Edit, Bash, Glob, Grep)
- Agent tools are auto-approved via `permissionMode: "bypassPermissions"` — AutoAuto is the host app
- `cwd` is always set to the target project root (resolved via `getProjectRoot()`)
- System prompts live in `src/lib/system-prompts.ts`
- Tool status is displayed in the chat UI as brief one-line indicators
- Setup Agent writes program artifacts to `.autoauto/programs/<slug>/` only after user confirmation
- Setup Agent validates measurement stability after saving program files
- Measurement validation uses a standalone script (`src/lib/validate-measurement.ts`) called via Bash
- The validation script runs optional `build.sh` once first when present
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
- Measurement locking (`chmod 444`) is the #1 safeguard — always lock before experiment loop, unlock on completion
- Git operations in `src/lib/git.ts` — use `git reset --hard` to discard failed experiments (standard autoresearch pattern)
- Measurement series returns median of N runs — use `runMeasurementSeries()` for all metric comparisons
- `compareMetric()` uses relative change as a decimal fraction compared against `noise_threshold`
- Experiment Agent is one-shot: single user message → autonomous run → commit or exit
- Experiment Agent system prompt = program.md wrapped with framing instructions (`getExperimentSystemPrompt()`)
- Context packet = per-experiment user message with baseline, recent results, git log, discarded diffs
- Experiment Agent tools: Read, Write, Edit, Bash, Glob, Grep — same as setup, auto-approved
- Lock violation detection: after agent commits, check `git diff` for any `.autoauto/` modifications → immediate discard
- Loop callbacks (`LoopCallbacks`) are the interface between orchestrator and display layer
- In daemon mode, `FileCallbacks` (daemon-callbacks.ts) implements LoopCallbacks by writing per-experiment stream logs (`stream-001.log`, etc.); all other state persistence is handled by the loop itself
- `LoopOptions.stopRequested` provides soft stop (checked at iteration boundary); `signal` is for hard abort only
- Two-root path model: `cwd` (worktree for git/agent ops) vs `programDir` (mainRoot for config/state) — `runExperimentLoop` takes explicit params, not a single `projectRoot`
- Re-baseline after keeps: `runMeasurementAndDecide()` runs a fresh measurement series after each keep; falls back to candidate measurement if re-baseline fails
- Re-baseline after consecutive discards: `maybeRebaseline()` runs drift detection every `REBASELINE_AFTER_DISCARDS` (5) non-keep outcomes; updates baseline if drift exceeds noise threshold
- Results reading: `readAllResults()` returns typed `ExperimentResult[]` from results.tsv; `getMetricHistory()` extracts keep-only metric values for charts
- Run listing: `listRuns()` enumerates runs for a program with their states; `getLatestRun()` returns the most recent
- Cost tracking: `ExperimentCost` on `ExperimentOutcome` captures SDK cost/usage data per experiment
- Dashboard components are mostly pure rendering — all primary state lives in ExecutionScreen (ResultsTable has local highlight index for keyboard nav)
- Sparkline uses keep-only metric values via `getMetricHistory()` pattern
- Results table color-codes by status: green=keep, red=discard/crash, yellow=measurement_failure
- ExecutionScreen supports two modes: spawn new daemon (`spawnDaemon`) or attach to existing (`attachRunId` prop)
- TUI watches run dir via `fs.watch` (daemon-client.ts) for near-instant updates; falls back to polling
- Stop/abort escalation: q → confirmation → stop-after-current; Ctrl+C → abort; second Ctrl+C → SIGKILL
- Daemon runs in AutoAuto-owned git worktree — `git reset --hard` only allowed inside worktree, never main checkout
- Per-program locking at `.autoauto/programs/<slug>/run.lock` — multiple programs can run concurrently
- RunState includes `total_cost_usd`, `termination_reason`, `original_branch`, `worktree_path`, `error`, `error_phase` for daemon reconnection
- Cleanup runs in-process in the TUI (not in daemon) — reads `worktree_path` from state.json

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
