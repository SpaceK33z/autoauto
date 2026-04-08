# AutoAuto

A TUI tool that makes the autoresearch pattern easy to set up and run on any project. Autoresearch is the autonomous experiment loop pioneered by Karpathy — define a metric, let an AI agent iteratively optimize code, keep improvements, discard failures, loop forever.

While autoresearch originated in ML model training, AutoAuto focuses on the broader set of use cases: software performance, test stability, prompt optimization, search ranking, marketing experiments, and anything else where you have code and a measurable metric — no training loops, datasets, or GPUs required. See `docs/autoresearch-ideas.md` for a full list.

AutoAuto encodes autoresearch expertise into a guided workflow so users don't need to learn the pitfalls (metric gaming, scope violations, false improvements, variance) from scratch. See `docs/failure-patterns.md` for documented failure modes, `docs/measurement-patterns.md` for metric design patterns, and `docs/orchestration-patterns.md` for loop design and context packet patterns — all extracted from real implementations.

## How It Works

App controls flow, agents provide intelligence. AutoAuto has hardcoded workflow logic — it knows the steps, renders the TUI, and calls the Claude Agent SDK at specific points where it needs AI reasoning. The agent is a tool, not the driver.

### 1. Setup

Interactive, agent-guided chat to configure an optimization program. The Setup Agent inspects the repo, asks what to optimize (or suggests targets), helps define scope constraints, generates and validates a measurement script, and writes a structured `program.md` with agent instructions.

### 2. Execution

The orchestrator loop. Establishes a baseline, then spawns a fresh Experiment Agent per iteration with a compact context packet (baseline, recent results, discarded diffs). Agent makes one change and commits. AutoAuto measures (median of N runs), keeps improvements beyond noise threshold (with quality gates), discards failures via `git reset --hard`, and loops. Runs in a background daemon inside an AutoAuto-owned git worktree, surviving terminal close.

### 3. Finalize

Review and package results: the Finalize Agent reviews the accumulated diff, groups changes into independent branches (or squashes as fallback), and produces a summary.

## Key Safeguards

- **Locked evaluator** — `measure.sh` + `config.json` are `chmod 444` before the loop starts. The agent cannot modify the measurement.
- **Scope constraints** — `program.md` defines what's in scope and off-limits, preventing metric gaming and drift.
- **One experiment per agent** — fresh context each iteration prevents narrative momentum and enables clean recovery.
- **Re-baselining** — fresh baseline after keeps and after consecutive discards to detect environment drift.
- **Stagnation detection** — auto-stops after `max_consecutive_discards` (default 10) consecutive non-improving experiments, with a warning at ~2/3 of the limit.

See `docs/failure-patterns.md` for the full catalog of failure modes and mitigations.

## Documentation

| Doc | Contents |
|-----|----------|
| `docs/architecture.md` | System architecture, data model, file structure, component details, daemon design |
| `docs/orchestration-patterns.md` | Loop design, context packets, ratchet logic, stopping criteria, model choice tradeoffs |
| `docs/measurement-patterns.md` | Metric design, scoring approaches, variance handling, gaming defenses |
| `docs/failure-patterns.md` | Documented failure modes, anti-patterns, and safeguards from real implementations |
| `docs/autoresearch-ideas.md` | Non-ML autoresearch ideas extracted from reference articles |
| `docs/glossary.md` | Term definitions |

## Future Ideas

- **Configurable agent output detail** — toggle between thinking-only, thinking + tool calls, or full raw output during execution
- **Parallel experiments** — run multiple programs simultaneously via git worktrees, with deduplication to prevent the same idea being tried in parallel
- **Quota fallback** — switch to a different CLI/agent when API quota is reached
- **Rich visualizations** — detailed charts and tables for completed runs
- **Re-profiling** — separate profiling step (e.g. flame graphs, trace analysis) that feeds structured data to the experiment agent
- **Creativity ceiling / local optima** — after ~50-80 experiments agents tend to get stuck in local search. Explore meta-prompt optimization: a second agent reviews results and rewrites `program.md` to push exploration in new directions. Also consider diversity directives and periodic resets from earlier checkpoints.
- **Human nudges** — during a run, nudge the agent to explore something else

## References

- `references/autoresearch/` — Karpathy's original autoresearch repository and program.md
- `references/modulaser/` — manual autoresearch implementation with bash orchestrator, multiple optimization programs, measurement scripts, noise thresholds, quality gates, and re-profiling
- `references/articles/` — collected articles about autoresearch
