# AutoAuto

![AutoAuto diagram](assets/autoauto_diagram.gif)

A TUI tool that makes the [autoresearch](https://github.com/karpathy/autoresearch) pattern easy to set up and run on any codebase. Define a metric, let an AI agent iteratively optimize your code, keep improvements, discard failures, loop overnight.

While autoresearch originated in ML training, AutoAuto applies it to everything: software performance, test stability, prompt optimization, search ranking, marketing copy — anything where you have code and a measurable metric. No training loops, datasets, or GPUs required.

Don't understand autoresearch or don't know what to apply it on? No problem! This tool will scan your codebase, guide you step by step to create it.

This tool takes care of everything:

* Finding autoresearch opportunities in your codebase
* Defining metrics, creating scripts
* Defining the best settings
* Running the experiments (supports Claude, Codex and OpenCode)
* Using best practices

## What it does

AutoAuto wraps the full autoresearch workflow — from defining what to optimize, to running hundreds of autonomous experiments, to packaging the results — into a terminal UI that handles all the tricky parts for you.

```
┌─ Setup ────────────────────────────────────────────────────────────┐
│ An AI agent inspects your repo, helps you define what to optimize, │
│ generates a measurement script, and validates it's stable.         │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ Execute ──────────────────────────────────────────────────────────┐
│ Autonomous loop in a background daemon:                            │
│   1. Spawn a fresh agent with context from previous experiments    │
│   2. Agent makes one change and commits                            │
│   3. Measure (median of N runs)                                    │
│   4. Keep if improved beyond noise threshold, discard otherwise    │
│   5. Repeat                                                        │
│ Runs in a git worktree — your main checkout stays clean.           │
│ Survives terminal close. Prevents macOS sleep automatically.       │
└────────────────────────────────────────────────────────────────────┘
                              ↓
┌─ Finalize ─────────────────────────────────────────────────────────┐
│ Review the accumulated diff, group changes into independent        │
│ branches, and produce a summary.                                   │
└────────────────────────────────────────────────────────────────────┘
```

## Why use this instead of a script

Autoresearch looks simple — "just loop an agent and measure" — but real implementations fail in predictable ways. AutoAuto encodes lessons from 30+ real-world implementations so you don't have to learn the hard way:

- **Metric gaming** — Agents optimize the measurement instead of the real goal (random seed manipulation, stripping untested features, benchmark-specific hacks). AutoAuto locks measurement files, enforces scope constraints, and supports quality gates.
- **Variance** — A "3% improvement" means nothing if your measurement has 5% noise. AutoAuto validates measurement stability during setup, runs median-of-N measurements, and uses a noise threshold to filter false improvements.
- **Agent drift** — Without constraints, agents rewrite your architecture or add dependencies you never wanted. AutoAuto's `program.md` defines exactly what's in scope and off-limits.
- **Narrative momentum** — Long-running agents convince themselves their approach is working and resist changing direction. AutoAuto spawns a fresh agent per experiment with no memory except a structured context packet.
- **Context loss** — A fresh agent per experiment solves momentum but creates the opposite problem: forgetting what was already tried. AutoAuto builds a structured context packet for each experiment — current baseline, recent results, diffs from discarded attempts, and an ideas backlog — so agents learn from history without inheriting bias.
- **Stagnation** — auto-stops after consecutive non-improving experiments, and as the discard count climbs it injects escalating directives pushing the agent to try radically different approaches before giving up.
- **Fault tolerance** — The daemon can crash, get killed, or lose power mid-experiment. On restart it detects the interrupted phase, rolls back to the last known good commit, and resumes. Every experiment resets cleanly on failure with post-reset verification. State is checkpointed atomically so a crash never corrupts it.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) runtime
- One of the supported AI providers:
  - **Claude** — [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated, or `ANTHROPIC_API_KEY` set
  - **Codex** — [Codex CLI](https://github.com/openai/codex) installed
  - **OpenCode** — [OpenCode](https://opencode.ai) installed

### Install and run

**With Bun (recommended):**

```bash
bun install -g @spacek33z/autoauto
autoauto
```

**Compiled binary (no runtime needed):**

```bash
curl -fsSL https://raw.githubusercontent.com/SpaceK33z/autoauto/main/install.sh | bash
autoauto
```

**From source:**

```bash
git clone https://github.com/SpaceK33z/autoauto.git
cd autoauto
bun install
bun dev
```

### Headless CLI

AutoAuto has a full headless CLI for coding agents, CI, or scripting. All commands support `--json` for machine-readable output.

```bash
autoauto list                        # List programs
autoauto show <program>              # Show program details, config, goal
autoauto start <program>             # Start an experiment run
autoauto status <program>            # Check run progress
autoauto results <program>           # View experiment results table
autoauto logs <program>              # Read experiment agent logs
autoauto summary <program>           # Show or generate run summary
autoauto stop <program>              # Stop after current experiment
autoauto validate <program>          # Validate measurement stability
autoauto config                      # Show/update project configuration
autoauto delete <program> --confirm  # Delete a program or run
autoauto queue add <program>         # Enqueue a run
```

See [CLI Reference](docs/cli.md) for full documentation of all commands and flags.

### MCP Server

AutoAuto also ships as an [MCP server](https://modelcontextprotocol.io/), letting you use it from any coding agent (Claude Code, Cursor, Windsurf, etc.) that supports MCP. The TUI is recommended for the best experience, but the MCP server gives your agent full access to create programs, start runs, monitor progress, and read results.

```bash
autoauto mcp  # stdio transport, spawned by your MCP client
```

See [MCP Server](docs/mcp-server.md) for setup and the full tool reference.

## How it works

### 1. Setup — define what to optimize

The Setup Agent inspects your repo and walks you through an interactive chat to configure an optimization **program**:

- **Goal** — What are you optimizing? (e.g., "reduce homepage LCP", "fix flaky test suite", "improve prompt pass rate")
- **Measurement script** — A `measure.sh` that outputs a JSON object with your metric. AutoAuto validates it runs cleanly and measures variance across multiple runs.
- **Scope constraints** — Which files the agent can touch, what's off-limits, and rules it must follow.
- **Quality gates** — Secondary metrics that must stay within bounds (e.g., "CLS must remain below 0.1" while optimizing LCP).

The result is a reusable program stored in `.autoauto/programs/<name>/` — you can run it repeatedly.

### 2. Execute — the autonomous loop

Hit run and AutoAuto:

1. Creates a git worktree (your main checkout stays untouched)
2. Spawns a background daemon that survives terminal close
3. Establishes a baseline measurement
4. Loops: spawn agent → one change → commit → measure → keep or discard → repeat

Each experiment agent gets a **context packet** — not the full chat history, but a structured summary: current baseline, recent results, git log of kept changes, diffs from recently discarded attempts, and an ideas backlog of what's been tried. This prevents repeating failed approaches while keeping context small.

The live TUI dashboard shows:

- **Stats header** — experiment count, keeps/discards, baseline vs best with improvement %, cost, and a sparkline
- **Results table** — color-coded experiment outcomes (green = kept, red = discarded)
- **Agent panel** — live streaming output from the current experiment

### 3. Finalize — package the results

After the loop completes (or you stop it), a Finalize Agent reviews the accumulated diff and groups changes into independent branches for clean review and merge, with per-group risk assessment. Falls back to a summary-only report if changes are too intertwined.

## Key safeguards

| Safeguard | What it prevents |
|-----------|-----------------|
| **Locked evaluator** — `measure.sh` + `config.json` are `chmod 444` during runs | Agent modifying the measurement to fake improvements |
| **Scope constraints** — `program.md` defines allowed files and off-limits areas | Agent drifting into unrelated code or risky changes |
| **Quality gates** — secondary metrics with hard thresholds | Agent improving one metric by degrading another |
| **Noise threshold** — improvements must exceed measured variance | False positives from measurement noise |
| **Median-of-N** — repeated measurements with median aggregation | Outlier measurements causing bad decisions |
| **One agent per experiment** — fresh context each iteration | Narrative momentum and compounding errors |
| **Git worktree isolation** — experiments run in a separate checkout | Corrupting your working directory |
| **Lock violation detection** — discards any experiment that touches `.autoauto/` | Agent tampering with its own config |
| **Re-baselining** — fresh baseline after keeps and after consecutive discards | Environment drift causing phantom improvements |
| **Stagnation detection** — auto-stops after 10 consecutive non-improving experiments | Burning money when the agent is stuck |
| **Simplicity criterion** — auto-keeps within-noise changes that reduce LOC | Rewarding code simplification even without metric gain |
| **Sleep prevention** — `caffeinate` keeps macOS awake during runs | System sleeping mid-experiment during overnight runs |

## Data model

```
.autoauto/                            # All state, gitignored automatically
  config.json                         # Project config (models, provider)
  programs/
    homepage-lcp/
      program.md                      # Agent instructions + scope constraints
      measure.sh                      # Measurement script
      config.json                     # Metric, direction, noise, quality gates
      build.sh                        # Optional build step before measurement
      runs/
        20260407-143022/
          state.json                  # Run state checkpoint
          results.tsv                 # Append-only experiment outcomes
          ideas.md                    # Ideas backlog (optional)
          stream-001.log              # Per-experiment agent output
          ...
  worktrees/
    20260407-143022/                   # Git worktree for active run
```

## Configuration

AutoAuto supports two model slots:

- **Execution model** — powers the experiment agents (default: Sonnet)
- **Support model** — powers setup, update, and finalize agents (default: Sonnet)

Both are configurable per-provider with effort level (low/medium/high). Override per-run from the pre-run config screen.

Supported providers: **Claude** (Agent SDK), **Codex** (CLI), **OpenCode**.

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Language:** TypeScript (strict mode)
- **TUI:** [OpenTUI](https://opentui.com) (React reconciler for the terminal)
- **Agent:** [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), with pluggable provider support

## Documentation

| Doc | Contents |
|-----|----------|
| [CLI Reference](docs/cli.md) | Full headless CLI documentation — all commands, flags, JSON output |
| [MCP Server](docs/mcp-server.md) | MCP server setup, tools, and workflows for coding agent integration |
| [Concepts](docs/concepts.md) | How AutoAuto works: programs, runs, experiments, measurement, agents |
| [Glossary](docs/glossary.md) | Quick definitions for AutoAuto terms and run mechanics |
| [Measurement Guide](docs/measurement-guide.md) | Writing good measurement scripts, choosing metrics, avoiding pitfalls |
| [Use Cases](docs/use-cases.md) | Ideas and inspiration across performance, prompts, marketing, and more |
| [Architecture](docs/architecture.md) | Internal architecture for contributors |

### Patterns from 30+ implementations

| Doc | Contents |
|-----|----------|
| [Metric Design](docs/patterns/metric-design.md) | Choosing metrics, scoring approaches, variance handling, gaming defenses |
| [Failure Modes](docs/patterns/failure-modes.md) | What goes wrong in autoresearch and how AutoAuto prevents it |
| [Loop Tuning](docs/patterns/loop-tuning.md) | Context packets, stopping criteria, model choice, crash recovery |

## License

MIT
