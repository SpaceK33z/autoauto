# pi-autoresearch

- **URL**: https://github.com/davebcn87/pi-autoresearch
- **Stars**: 3,438 | **Created**: 2026-03-11
- **Form factor**: Plugin/extension for the **pi** terminal agent (by Mario Zechner)

## What it is

The dominant player in the autoresearch space by traction and real-world usage. It's a TypeScript extension (~2800 LoC) for the pi coding agent that exposes 3 MCP-style tools (`init_experiment`, `run_experiment`, `log_experiment`) and lets the host agent drive the loop autonomously. The agent — not the orchestrator — decides keep/discard; confidence scores are advisory only.

State lives in two files: `autoresearch.jsonl` (append-only structured log of every result) and `autoresearch.md` (human-written living document with objective, constraints, scope, and history). Any fresh agent session can resume from these files alone — no memory required.

The architecture splits into: **extension** (domain-agnostic tools + inline/fullscreen dashboard UI), **skills** (session setup wizard + finalize workflow), and **files** (6 repo-root files for persistent state). The loop itself is simple: `init_experiment` writes a config header to jsonl → agent edits code → `run_experiment` executes benchmark + optional checks → `log_experiment` records result, auto-commits or auto-reverts, computes MAD confidence. After the loop, a separate **finalize skill** groups kept experiments into logical changesets on independent branches for clean PRs.

### Key technical details

**MAD confidence scoring**: After 3+ data points in a segment, computes Median Absolute Deviation of all metric values, then `confidence = |best_kept - baseline| / MAD`. Scores >=2.0 are "likely real," 1.0-2.0 are "marginal," <1.0 are "within noise." Advisory only — never auto-discards.

**Structured metrics**: Benchmark scripts output `METRIC name=value` lines. Primary metric drives keep/discard; secondary metrics are tracked, auto-registered with unit detection from name suffixes (`_µs`, `_ms`, `_kb`), and enforced as consistent across all experiments in a segment.

**Actionable Side Information (ASI)**: Free-form `asi` dict on every log_experiment call — agents record hypothesis, rollback reason, observations. Persisted in jsonl for future agents to learn from.

**Context window management**: Tracks tokens per iteration via `iterationTokens`, estimates if next iteration fits using `max(mean, median) * 1.2`, aborts gracefully when context is exhausted.

**Checks system**: Optional `autoresearch.checks.sh` runs automatically after each successful benchmark. If checks fail, status becomes `checks_failed` (distinct from crash/discard). Cannot `keep` if checks failed — hard gate.

**Live dashboard**: Built-in HTTP server with SSE for real-time updates. Inline widget (Ctrl+X), fullscreen overlay (Ctrl+Shift+X), and browser export. Shows runs, kept/discarded/crashed counts, confidence, baseline, secondary metrics.

**Finalize skill** (`finalize.sh`, ~440 lines bash): Takes a `groups.json` mapping experiments to logical changesets. Preflight validates no file overlaps between groups. Creates independent branches from merge-base, cherry-picks files per group, verifies union matches original HEAD. Each branch is independently mergeable. Session artifacts (`autoresearch.*`) are excluded from all branches.

## Good ideas we don't have

### 1. Finalize workflow — grouping experiments into clean PRs

After the autoresearch loop produces a messy branch of interleaved keep/discard commits, a separate finalize step groups the kept experiments into logical changesets and creates independent branches, each with a clean commit message including metric deltas. Preflight validates no file overlaps (so branches don't conflict on merge). A union verification ensures the combined result matches the original HEAD.

This is the biggest gap. Our loop produces a linear chain of kept commits, but there's no workflow for turning that into reviewable, independently-mergeable PRs. Users have to manually cherry-pick and group changes.

**Actionable:** Build a cleanup/finalize phase (phase 3 in IDEA.md mentions this). Could be agent-driven: after the loop, a cleanup agent reads the experiment log + git history, proposes groupings, and creates branches. The finalize.sh approach of validating no file overlaps and verifying union = HEAD is a solid algorithm we could adapt.

### 2. Session resumability via plain files

Two files (`autoresearch.jsonl` + `autoresearch.md`) contain everything a fresh agent needs to resume. No daemon reconnection, no state.json parsing — just read the files and continue. The jsonl is replayed line-by-line to reconstruct state on startup.

Our daemon model handles reconnection well, but if the daemon dies or the TUI crashes, recovery is more complex (read state.json, check worktree, verify daemon liveness). The pi-autoresearch approach is simpler and more robust — any tool that can read files can continue.

**Actionable:** Not a direct port (our daemon architecture is fundamentally different), but we should ensure our state files are self-sufficient for recovery. Consider writing a `results.jsonl` (richer than our current `results.tsv`) that contains enough context for any recovery tool to reconstruct the full run state.

### 3. Actionable Side Information (ASI) per experiment

Every `log_experiment` call can include a free-form `asi` dict — hypothesis tested, rollback reason, observations, diagnostics. This is persisted in the jsonl and available to future agents.

Our context packets include recent results and discarded diffs, but we don't have structured per-experiment metadata about *why* something was tried and *why* it failed. The discarded diff shows *what* changed, not the reasoning.

**Actionable:** Add optional structured metadata to `ExperimentOutcome` — `hypothesis`, `rollback_reason`, `observations`. Include these in the context packet for subsequent experiments. This gives the next agent richer signal than just "this diff was discarded."

### 4. Distinct `checks_failed` status with hard keep gate

Benchmark passing and correctness checks are separated into two stages. A benchmark can succeed (metric captured) but checks can fail (tests broken, types broken, lint errors). The `checks_failed` status is distinct from `crash` or `discard`, and there's a hard gate: you cannot `keep` if checks failed.

We run measurement and that's it. If the agent broke tests, we'd only catch it if the measurement script itself includes test runs. There's no separate correctness verification step.

**Actionable:** Add an optional `checks.sh` to program config (alongside `measure.sh` and `build.sh`). Run it after successful measurement. If it fails, mark the experiment as `checks_failed` instead of proceeding to keep/discard decision. This separates "did the metric improve?" from "is the code correct?" — catches experiments that improve the metric by breaking something else.

### 5. Context window exhaustion detection

Tracks tokens consumed per iteration, maintains a rolling history, and before each experiment estimates whether the next iteration will fit in the remaining context window. If not, gracefully aborts with "start a new session — all progress is saved."

We use one-shot experiment agents (fresh agent per iteration), so context exhaustion isn't a direct problem for individual experiments. But our setup agent and cleanup workflows do run in long-lived sessions. More importantly, this is a useful pattern if we ever support multi-turn experiment agents or long setup conversations.

**Actionable:** Low priority for now (one-shot agents avoid this), but worth noting for future multi-turn agent modes. Could add token tracking to the setup chat to warn when context is getting large.

### 6. Secondary metrics with consistency enforcement

Beyond the primary metric, benchmark scripts can output multiple `METRIC name=value` lines. Secondary metrics are auto-registered on first appearance, units are auto-detected from name suffixes, and once registered, all subsequent experiments must report all known secondary metrics (hard error if missing). New metrics can be added mid-loop with a `force` flag.

We only track a single primary metric. If a user wants to monitor compilation time alongside runtime performance, or memory usage alongside throughput, they'd need to bake it into their single metric or ignore the secondary signal.

**Actionable:** Support optional secondary metrics in `measure.sh` output (e.g., `METRIC name=value` lines in addition to the primary metric). Track them in results.tsv/state. Display them in the TUI. Don't use them for keep/discard decisions (primary metric is king), but surface them so users can catch experiments that improve the primary metric at the cost of degrading something else.

### 7. Per-segment architecture (multi-objective in one session)

`init_experiment` can be called multiple times in a session, each time starting a new "segment" with its own baseline, metric name, and direction. This allows pivoting to a different optimization target without starting a new session — all history is preserved.

Our programs are single-objective. If a user optimizes compilation time and then wants to optimize runtime with the same setup, they'd need a new program or a new run.

**Actionable:** Low priority, but interesting for long-running optimization sessions. Could support a "re-target" operation that starts a new segment within the same run — same worktree, same git branch, new baseline and metric target.

## What they don't have (our advantages)

- **No variance analysis / noise calibration** — MAD confidence is advisory and computed post-hoc; no upfront noise threshold calibration, no CV% analysis, no configurable repeats
- **No measurement locking** — agent could edit `autoresearch.sh` at any time (pi-autoresearch trusts the agent)
- **No re-baselining for drift detection** — baseline is set once per segment, never updated for environmental drift
- **No programmatic keep/discard** — agent decides (can be wrong, influenced by narrative momentum); our programmatic comparison against noise threshold is more reliable
- **No worktree isolation** — runs in the main checkout, risking working tree conflicts
- **No daemon / background execution** — requires an active pi session; can't detach and reconnect
- **No build step** — no equivalent to our `build.sh` (one-time build before measurement loop)
- **No cost tracking** — no per-experiment or total cost visibility
- **No quality gates** — no upfront measurement validation (CV% check, stability verification)
- **No multi-run variance** — each benchmark is a single run; our median-of-N with CV% is more reliable for noisy metrics
- **No TUI dashboard** — has an inline widget and browser export, but no persistent TUI with keyboard navigation, results table, agent panel, etc.
- **Fresh agent per iteration** — we isolate experiments with one-shot agents, preventing narrative momentum; pi-autoresearch runs one long agent session where earlier failures can bias later decisions
