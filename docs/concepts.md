# Concepts

How AutoAuto works, from first setup to finished results. For quick term definitions, see the [Glossary](glossary.md).

## The autoresearch pattern

Autoresearch is an autonomous experiment loop: define a metric, let an AI agent iteratively change your code, measure the result, keep improvements, discard failures, repeat. The pattern was pioneered by [Karpathy](https://github.com/karpathy/autoresearch) for ML training, but it works anywhere you have code and a measurable metric.

AutoAuto wraps this pattern into a tool that handles the tricky parts — measurement validation, scope enforcement, crash recovery, and result packaging — so you can focus on defining what to optimize.

## Programs

A **program** is a reusable optimization target. It defines what to optimize, how to measure it, and what the agent is allowed to do. Programs live in `.autoauto/programs/<name>/` and contain:

| File | Purpose |
|------|---------|
| `program.md` | Agent instructions: goal, scope constraints, rules, step-by-step approach |
| `measure.sh` | Measurement script that outputs a JSON object with your metric |
| `config.json` | Metric field, direction (lower/higher), noise threshold, repeats, quality gates |
| `build.sh` | Optional one-time build step before measurement |

You create programs through the Setup Agent — an interactive chat that inspects your repo, helps you define what to optimize, generates all the artifacts, and validates that the measurement is stable before you can start.

Programs are reusable. You can run the same program multiple times, and you can **update** a program after a run to refine the approach based on what the previous run found.

## Runs

A **run** is one execution of a program — a session of autonomous experiments. Each run:

- Gets its own git branch (`autoauto-<program>-<timestamp>`)
- Runs in an isolated git worktree (your main checkout stays clean)
- Produces a `results.tsv` log, per-experiment agent output, and a final summary
- Runs as a background daemon that survives terminal close

Run state is persisted atomically to `state.json`, so runs can recover from crashes.

## Queue

The **queue** lets you schedule multiple runs to execute sequentially — ideal for overnight optimization. Queue entries are stored in `.autoauto/queue.json` and drain automatically:

- Add runs to the queue from the PreRunScreen (`a` key) with per-run configuration
- The first item starts immediately; each completing daemon spawns the next
- A compact Queue panel appears at the bottom of the HomeScreen when items are pending
- **Program exclusivity** — a program is either queue-managed or manual, never both
- Failed entries retry up to 2 times before being skipped
- If the TUI is closed and reopened, stalled queues resume automatically

Stop an active queued run to advance to the next, or clear the entire queue.

## Experiments

An **experiment** is a single iteration of the loop:

1. A fresh agent receives a **context packet** — baseline metric, recent results, diffs from failed attempts, and an ideas backlog
2. The agent makes one change and commits
3. AutoAuto measures the result (median of N runs of `measure.sh`)
4. Decision:
   - **Keep** — metric improved beyond the noise threshold and all quality gates passed
   - **Discard** — metric regressed, was within noise, or a quality gate failed (reverted via `git reset --hard`)
   - **Crash** — agent error, timeout, or invalid output

Each experiment uses a fresh agent with no memory beyond the context packet. This prevents narrative momentum — where an agent becomes attached to a failing approach — and enables clean recovery from any failure.

## Measurement

The measurement system is the heart of AutoAuto. Your `measure.sh` script outputs a JSON object:

```json
{
  "lcp_ms": 1230,
  "cls": 0.05,
  "tbt_ms": 180
}
```

### Key measurement concepts

**Metric field and direction.** One field is the primary metric to optimize. It has a direction: `"lower"` (e.g., latency) or `"higher"` (e.g., accuracy).

**Noise threshold.** The minimum relative improvement (as a decimal fraction, e.g., 0.02 = 2%) to accept a change. Improvements below this are considered noise and discarded. AutoAuto helps you set this during setup by measuring your script's variance.

**Repeats.** How many times `measure.sh` runs per experiment (typically 3-5). AutoAuto uses the median value for comparison, filtering out outliers.

**Quality gates.** Secondary metrics with hard thresholds that must not be violated. For example, while optimizing LCP, you might require CLS to stay below 0.1. An experiment that improves LCP but breaks CLS is discarded.

**Simplicity criterion.** Experiments that are within noise but reduce lines of code are auto-kept. This rewards code simplification even without a metric gain. Note: simplification keeps do not reset the consecutive-discard counter — they don't count as real progress for stagnation detection. This behavior can be disabled by setting `"keep_simplifications": false` in `config.json` — useful for prompt/template optimization where LOC is meaningless, or when the measurement harness has known coverage gaps.

**Re-baselining.** After every kept experiment, AutoAuto re-measures the baseline on the new code. It also re-measures after consecutive discards to detect environment drift.

**Budget cap.** An optional `max_cost_usd` limit stops the run when cumulative agent cost exceeds the threshold. Checked at each iteration boundary — the last experiment that pushes cost over the limit completes normally before stopping. Set it per-program in `config.json` or override it per-run in the PreRun screen. When no cap is set, cost is tracked but unlimited.

## Context packets

Each experiment agent starts fresh. Instead of chat history, it gets a structured **context packet**:

- Current baseline metric value
- Recent experiment results (status, metric, description)
- Diffs from recently discarded experiments (so it doesn't retry failed ideas)
- Git log of kept changes
- Human guidance (if set — takes priority over ideas backlog)
- The ideas backlog
- Previous run context (if carry-forward is enabled)

This design keeps context small, prevents agents from building up false narratives, and ensures every experiment is evaluated independently.

## Ideas backlog

An optional `ideas.md` file that accumulates notes across experiments:

- What the agent tried and why
- Whether it worked or failed
- What to try next
- What to avoid

This is the agent's institutional memory. Without it, agents waste cycles retrying discarded approaches — one real-world case saw a test fix go through four different approaches before finding one that held, and the backlog prevented retrying the three that failed.

## Human guidance

While the experiment loop is fully autonomous, you can **steer it mid-run** by providing human guidance. Press `g` in the TUI (or use the `set_guidance` MCP tool) to write a direction for the experiment agent.

Guidance is stored as `guidance.md` in the run directory. The daemon reads it at the start of each experiment iteration and injects it into the context packet as a high-priority `## Human Guidance` section — above the ideas backlog. The agent treats it as steering direction that takes precedence over its own ideas.

This is most useful at **performance plateaus** (multiple consecutive discards), when the agent is **drifting** into unproductive directions, or when you have domain knowledge about what to try next. Inspired by the [guidance.md pattern](https://github.com/karpathy/autoresearch/issues/239) from the autoresearch community.

Guidance is non-blocking — it takes effect on the next experiment without pausing the current one. It persists across TUI detach/reattach and can be cleared at any time.

## Carry forward (cross-run memory)

When you run a program multiple times, each new run can **carry forward** context from previous completed runs:

- **Previous results** — kept experiment summaries from earlier runs (what worked, how much it improved)
- **Previous ideas** — the ideas backlog from the most recent completed run (what was tried, what failed, what to try next)

This gives the agent institutional memory across runs, not just within a single run. It's especially useful after an **Update** — the revised program benefits from knowing what the previous run already explored.

Carry forward is termination-aware: when the previous run ended via stagnation, the agent is nudged toward orthogonal approaches rather than refining the exhausted direction (based on Liu et al.'s "pivot" pattern). When the previous run hit the max-experiments limit, the agent is told that unexplored directions may remain. Stopped or aborted runs carry neutral framing.

Carry forward is enabled by default. You can disable it in the PreRun screen ("Previous Run Context" toggle) or via CLI (`--no-carry-forward`). It's automatically skipped when no previous runs exist.

**Important:** Previous run code changes are NOT merged into the working tree. The agent is told to treat previous results as guidance, not as existing code.


## Agents

AutoAuto uses AI agents at specific points in the workflow. The app controls flow; agents provide intelligence.

| Agent | Role | Session type |
|-------|------|-------------|
| **Setup Agent** | Inspect repo, define program, generate and validate measurement | Multi-turn chat |
| **Update Agent** | Review previous run results and revise program artifacts | Multi-turn chat |
| **Experiment Agent** | Make one code change and commit | One-shot (fresh per experiment) |
| **Finalize Agent** | Review results, assess risk, handle exclusions, package code | Multi-turn chat |

AutoAuto supports multiple agent providers: **Claude** (Agent SDK), **Codex** (CLI), and **OpenCode**. You configure two model slots during first-time setup:

- **Support slot** — used by Setup, Update, and Finalize agents (conversational work). Defaults to Opus / high effort.
- **Execution slot** — used by the Experiment agent (autonomous code changes). Defaults to Sonnet / high effort.

This lets you use a more capable model for design and review while using a faster/cheaper model for the high-volume experiment loop.

## Worktree isolation

Experiments run in an AutoAuto-owned git worktree, not your main checkout. This means:

- Your working directory is never touched
- `git reset --hard` (used to discard failed experiments) is safe — it only affects the worktree
- The `.autoauto/` directory doesn't exist in the worktree (it's gitignored), preventing agents from tampering with their own config

An optional in-place mode skips worktree creation for simpler setups.

## Daemon mode

The experiment loop runs as a background daemon, detached from the TUI. This means:

- Runs survive terminal close — you can quit the TUI and come back later
- On macOS, `caffeinate` prevents idle sleep while the daemon is running (auto-exits when the daemon stops)
- The TUI watches the run directory for updates and renders the dashboard in real time
- Stop/abort is graceful: `q` stops after the current experiment finishes; `Ctrl+C` aborts immediately

All communication between the TUI and daemon happens through the filesystem (state files, stream logs, control files) — no sockets, no IPC.

## Finalize

When a run completes, you have three options:

- **Finalize** — a conversational Finalize Agent reviews your results, assesses risk per experiment, helps you exclude risky or unwanted experiments, and packages the final code onto a branch of your choice
- **Update** — revise `program.md` and run again with an updated approach
- **Done** — skip finalize and leave the run branch as-is for manual review

The finalize flow is a multi-turn chat. The agent:

1. Shows all experiment results (kept and discarded) with metrics
2. Provides per-experiment risk assessment for kept experiments (can be disabled via `finalize_risk_assessment: false` in config.json)
3. Lets you exclude specific experiments by number (e.g., "exclude 3, 7")
4. Flags dependency issues if excluding an experiment would affect later ones, and resolves conflicts
5. Asks where to put the final code: the autoauto run branch, the original branch, or a new branch
6. Packages the code and confirms completion

On finalization, `finalized_at` and `finalized_branch` are written to `state.json`. The HomeScreen shows finalized runs with a checkmark and the target branch name.

## Data model

All AutoAuto state lives in `.autoauto/` inside your project, which is automatically added to `.gitignore`:

```
.autoauto/
  config.json                     # Project config (models, provider)
  worktrees/
    20260407-143022/              # Git worktree for an active run
  programs/
    homepage-lcp/
      program.md                  # Agent instructions + scope
      measure.sh                  # Measurement script
      config.json                 # Metric config
      build.sh                    # Optional build step
      runs/
        20260407-143022/
          state.json              # Run checkpoint
          results.tsv             # Experiment outcomes (append-only)
          ideas.md                # Ideas backlog
          guidance.md             # Human steering (written by TUI/MCP)
          stream-001.log          # Per-experiment agent output
          summary.md              # Final report (after finalize)
```
