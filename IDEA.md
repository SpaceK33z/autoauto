# AutoAuto

A TUI tool that makes the autoresearch pattern easy to set up and run on any project. Autoresearch is the autonomous experiment loop pioneered by Karpathy — define a metric, let an AI agent iteratively optimize code, keep improvements, discard failures, loop forever.

While autoresearch originated in ML model training, AutoAuto focuses on the broader set of use cases: software performance, test stability, prompt optimization, search ranking, marketing experiments, and anything else where you have code and a measurable metric — no training loops, datasets, or GPUs required. See `docs/autoresearch-ideas.md` for a full list.

AutoAuto encodes autoresearch expertise into a guided workflow so users don't need to learn the pitfalls (metric gaming, scope violations, false improvements, variance) from scratch. See `docs/failure-patterns.md` for documented failure modes, `docs/measurement-patterns.md` for metric design patterns, and `docs/orchestration-patterns.md` for loop design and context packet patterns — all extracted from real implementations.

## How It Works

App controls flow, agents provide intelligence. AutoAuto has hardcoded workflow logic — it knows the steps, renders the TUI, and calls the Claude Agent SDK at specific points where it needs AI reasoning. The agent is a tool, not the driver.

### 1. Setup

Interactive, agent-guided chat to configure an optimization program. The Setup Agent inspects the repo, asks what to optimize (or suggests targets), helps define scope constraints, generates and validates a measurement script, and writes a structured `program.md` with agent instructions.

- Agent uses SDK tools (Read, Write, Edit, Bash, Glob, Grep), auto-approved via `permissionMode: "bypassPermissions"`
- `cwd` set to target project root (resolved via `getProjectRoot()`)
- Writes program artifacts to `.autoauto/programs/<slug>/` only after user confirmation
- Validates measurement stability: standalone script (`validate-measurement.ts`) runs `build.sh` once + `measure.sh` N times, computes CV%, recommends `noise_threshold`/`repeats`/`max_consecutive_discards`
- System prompts live in `src/lib/system-prompts.ts`; tool status displayed in chat UI as brief one-line indicators

### 2. Execution

The orchestrator loop. Establishes a baseline, then spawns a fresh Experiment Agent per iteration with a compact context packet (baseline, recent results, discarded diffs, ideas backlog). Agent makes one change and commits. AutoAuto measures (median of N runs via `runMeasurementSeries()`), keeps improvements beyond noise threshold (with quality gates), discards failures via `git reset --hard`, and loops. Runs in a background daemon inside an AutoAuto-owned git worktree, surviving terminal close.

- **Experiment Agent** is one-shot: single user message → autonomous run → commit or exit. System prompt = `program.md` wrapped with framing instructions (`getExperimentSystemPrompt()`). Same tools as setup, auto-approved.
- **Context packet** = per-experiment user message with baseline, recent results, git log, discarded diffs, ideas backlog. Built by `buildContextPacket()` in `experiment.ts`.
- **Metric comparison** — `compareMetric()` uses relative change as a decimal fraction compared against `noise_threshold`. Simplification bonus: net-negative LOC changes auto-kept if metric doesn't regress.
- **Lock violation detection** — after agent commits, check `git diff` for `.autoauto/` modifications → immediate discard.
- **Re-baselining** — fresh measurement after every keep; drift detection every 5 consecutive discards via `maybeRebaseline()`.
- **Stagnation detection** — auto-stops after `max_consecutive_discards` (default 10) consecutive non-improving experiments; warns at ~2/3 of the limit; counter resets on any keep; termination reason = `"stagnation"`.
- **Exploration directives** — escalating diversity prompts injected into the experiment user message based on `consecutiveDiscards / maxConsecutiveDiscards` ratio: mild nudge at 30%, orthogonal push at 50%, critical/exit-if-stuck at 70%. Implemented in `getExplorationDirective()` in `experiment.ts`.
- **Ideas backlog** — append-only `ideas.md` capturing per-experiment hypothesis, outcome, what to avoid, what to try next. Fed back into each agent's context packet.
- **Loop control** — `LoopOptions.stopRequested` for soft stop (checked at iteration boundary); `signal` for hard abort. `LoopCallbacks` interface between orchestrator and display layer.
- **Daemon mode** — `FileCallbacks` (`daemon-callbacks.ts`) implements `LoopCallbacks` by writing per-experiment stream logs (`stream-001.log`, etc.); all other state persistence handled by the loop itself.
- **TUI** — watches run dir via `fs.watch` (`daemon-client.ts`) for near-instant updates. Stop/abort escalation: q → confirmation → stop-after-current; Ctrl+C → abort; second Ctrl+C → SIGKILL.
- **Cost tracking** — `ExperimentCost` on `ExperimentOutcome` captures SDK cost/usage data per experiment; `total_cost_usd` accumulated in `RunState`.

### 3. Finalize

Review and package results: the Finalize Agent reviews the accumulated diff, groups changes into independent branches (or squashes as fallback), and produces a summary. Runs in-process in the TUI (not in the daemon) — reads `worktree_path` from `state.json`.

## Key Safeguards

- **Locked evaluator** — `measure.sh` + `config.json` are `chmod 444` before the loop starts. The agent cannot modify the measurement. This is the #1 safeguard.
- **Scope constraints** — `program.md` defines what's in scope and off-limits, preventing metric gaming and drift.
- **One experiment per agent** — fresh context each iteration prevents narrative momentum and enables clean recovery.
- **Worktree isolation** — daemon runs in an AutoAuto-owned git worktree. `git reset --hard` only allowed inside the worktree, never the main checkout.
- **Per-program locking** — `.autoauto/programs/<slug>/run.lock` prevents concurrent runs of the same program; multiple programs can run concurrently.
- **Atomic state** — run state persisted via temp-file + rename (`writeState()` in `run.ts`). `results.tsv` is append-only.
- **Two-root path model** — `cwd` (worktree for git/agent ops) vs `programDir` (main root for config/state). `runExperimentLoop` takes explicit params, not a single `projectRoot`.

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
- **Creativity ceiling / local optima** — escalating exploration directives (implemented) push agents toward orthogonal approaches as they get stuck. Next steps: meta-prompt optimization (a second agent reviews results and rewrites `program.md` to push exploration in new directions) and periodic resets from earlier checkpoints.
- **Human nudges** — during a run, nudge the agent to explore something else

## References

- `references/autoresearch/` — Karpathy's original autoresearch repository and program.md
- `references/articles/` — collected articles about autoresearch
