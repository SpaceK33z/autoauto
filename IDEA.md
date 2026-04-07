# AutoAuto

A TUI tool that makes the autoresearch pattern easy to set up and run on any project. Autoresearch is the autonomous experiment loop pioneered by Karpathy — define a metric, let an AI agent iteratively optimize code, keep improvements, discard failures, loop forever.

While autoresearch originated in ML model training, AutoAuto focuses on the broader set of use cases: software performance, test stability, prompt optimization, search ranking, marketing experiments, and anything else where you have code and a measurable metric — no training loops, datasets, or GPUs required. See `docs/autoresearch-ideas.md` for a full list.

AutoAuto encodes autoresearch expertise into a guided workflow so users don't need to learn the pitfalls (metric gaming, scope violations, false improvements, variance) from scratch. See `docs/failure-patterns.md` for documented failure modes, `docs/measurement-patterns.md` for metric design patterns, and `docs/orchestration-patterns.md` for loop design and context packet patterns — all extracted from real implementations.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **TUI:** OpenTUI (Zig core + TypeScript bindings)
- **Agent:** Claude Agent SDK
- **Install:** Global CLI (`autoauto`)

## Architecture

App controls flow, agents provide intelligence. AutoAuto has hardcoded workflow logic — it knows the steps, renders the TUI, and calls the Claude Agent SDK at specific points where it needs AI reasoning. The agent is a tool, not the driver.

Multiple agent roles, all via Claude Agent SDK with different system prompts:

| Role | Purpose | Lifecycle |
|------|---------|-----------|
| **Setup Agent** | Inspects repo, asks questions, generates measurement scripts, writes `program.md` | Interactive, during setup |
| **Experiment Agent** | Reads codebase, makes one optimization, commits | Short-lived, one per iteration |
| **Cleanup Agent** | Reviews accumulated diff, flags risks, produces summary | Once per run |

Two model configuration slots:
- **Execution model** — used for experiment agents (e.g. Sonnet at high effort)
- **Support model** — used for setup and cleanup agents (e.g. Opus at low effort)

Each slot configures model choice (Sonnet or Opus) and effort level (low/medium/high, plus max for Opus) via Claude Agent SDK's `effort` option.

## Auth

On first run, verify authentication via the SDK's `accountInfo()` call. This supports all SDK auth methods: API key (`ANTHROPIC_API_KEY`), OAuth, and cloud providers. If authentication fails, show an error screen with setup instructions (e.g. `claude setup-token`).

## Data Model

Three-level hierarchy: **Project** > **Program** > **Run**.

- **Project** — the target codebase (e.g. "my Next.js app")
- **Program** — a reusable optimization target with a metric, measurement script, agent instructions, and scope constraints (e.g. "homepage LCP", "API /users latency")
- **Run** — one execution session of a program in an AutoAuto-owned worktree on a dedicated branch, producing a results.tsv and experiment history

### File Structure

All state lives inside the target repo, gitignored (`.autoauto/` is added to `.gitignore` automatically on first run):

```
.autoauto/
  config.json                    # project-level config (default models, etc.)
  worktrees/
    20260407-143022/             # AutoAuto-owned git worktree for an active/completed run
  programs/
    homepage-lcp/
      program.md                 # agent instructions + scope constraints (structured)
      measure.sh                 # generated measurement script
      config.json                # metric field, direction, noise threshold, repeats, quality gates
      runs/
        20260407-143022/
          daemon.json            # daemon identity, PID, start time, heartbeat, worktree path
          state.json             # atomic checkpoint: experiment #, phase, baseline, SHAs
          control.json           # TUI stop/abort requests
          results.tsv            # durable experiment outcomes
          events.ndjson          # append-only live event stream for the TUI
          daemon.log             # daemon stderr/stdout
          summary.md
    api-latency/
      program.md
      measure.sh
      config.json
      runs/
        ...
```

### Measurement Output

`measure.sh` outputs a **single JSON object** to stdout containing multiple fields. The orchestrator extracts what it needs based on `config.json`:

```json
{
  "lcp_ms": 1230,
  "cls": 0.05,
  "tbt_ms": 180,
  "fcp_ms": 890
}
```

Strict contract:

- stdout must contain valid JSON and nothing else
- output must be a JSON object, not an array or scalar
- `metric_field` must exist and be a finite number (`NaN`, `Infinity`, `null`, strings = invalid)
- every configured quality gate field must exist and be a finite number
- nonzero exit code = crash
- timeout = crash
- invalid JSON, invalid metric shape, or missing/non-finite quality gate field = measurement failure
- finite quality gate value outside its configured threshold = discard
- repeated measurements apply to all fields, not just the primary metric; the orchestrator compares median primary metric and median quality gate values

### Program Config

`config.json` declares the primary metric, direction, and quality gates:

```json
{
  "metric_field": "lcp_ms",
  "direction": "lower",
  "noise_threshold": 0.02,
  "repeats": 3,
  "quality_gates": {
    "cls": { "max": 0.1 },
    "tbt_ms": { "max": 300 }
  }
}
```

For non-ML use cases where the metric is subjective (prompt quality, copy, templates), the setup agent should prefer binary yes/no eval criteria over sliding scales — see `docs/failure-patterns.md` section 1d for rationale.

### program.md Structure

The setup agent generates a structured `program.md` with required sections:

```markdown
# Program: Homepage LCP

## Goal
Reduce Largest Contentful Paint on the homepage.

## Scope
- Files: src/app/page.tsx, src/components/Hero/**
- Off-limits: third-party scripts, CDN config, image quality

## Rules
- Do not add lazy loading to above-the-fold content
- Do not reduce image quality below current settings

## Steps
1. ANALYZE: Read profiling data and results.tsv...
2. PLAN: Identify one specific optimization...
3. IMPLEMENT: Make the change...
4. COMMIT: git add -A && git commit -m "perf(scope): description"
```

### Results TSV

Each experiment is logged as a row:

```
experiment#	commit	metric_value	secondary_values	status	description
```

- `status`: `keep`, `discard`, `measurement_failure`, or `crash`
- `measurement_failure`: command exited successfully but output violated the measurement contract (invalid JSON, missing/non-finite primary metric, missing/non-finite quality gate field)
- `crash`: nonzero exit, timeout, OOM, killed process, or other command-level failure
- `description`: from the agent's commit message

## Measurement Templates

AutoAuto ships with built-in **measurement skills** — opinionated knowledge about how to measure specific things (Lighthouse, wall-clock time, HTTP latency, test pass rate, etc.). These aren't hardcoded templates or a menu — they're skill-provided examples the agent uses as inspiration when generating a measurement script adapted to the specific repo.

The setup agent:
1. Inspects the repo (framework, language, build system)
2. Recommends a measurement approach based on built-in skills
3. Generates a measurement script tailored to the project
4. Runs it multiple times to validate stability
5. Detects variance and warns if measurements are unreliable
6. Iterates until the measurement is stable

Measurement scripts should assume they'll run hundreds of times — keep servers/browsers warm, use incremental builds, avoid cold starts. The setup agent should generate scripts that reuse long-lived processes (e.g. keep the dev server running, reuse the browser instance across Lighthouse runs) rather than starting from scratch each iteration. See `docs/measurement-patterns.md` for variance handling, stability validation, and scoring approach guidance.

When creating a second program that reuses the same measurement type (e.g. Lighthouse for a different page), the agent recognizes the existing setup and adapts it.

## TUI Navigation

Keyboard-first, mouse-clickable. All screens use OpenTUI.

1. **Home** — list of programs (or empty state prompting setup), `n` to create new program (flows directly into setup), `s` for settings
2. **Setup** — chat-style conversation with setup agent. Agent inspects repo, asks questions, generates program.md + measure.sh, validates measurement stability, presents for review. User can iterate. Supports ideation mode ("help me find targets"). Explicit confirm to save.
3. **Settings** — model configuration for execution and support slots (model choice + effort level)
4. **Execution** — live dashboard (see below) with stats header, results table, and agent output panel. Handles run-in-progress and run-complete states (prompt to run cleanup or abandon).

## Phases

### Phase 1: Setup (MVP)

Interactive, agent-guided chat to configure an autoresearch program:

- Inspect the repository (language, framework, build system, existing scripts)
- Ask the user what to optimize (or suggest targets via ideation — agent analyzes codebase and suggests optimization opportunities, then flows into setup when user picks one)
- Help define what's **out of scope** — critical for preventing the agent from gaming the metric
- Generate and validate the measurement script (run multiple times, check variance, iterate until stable)
- Guide the user on noise threshold and measurement repeats based on observed variance
- Write the structured `program.md` with clear instructions, constraints, and scope boundaries
- Configure quality gates (e.g. "CLS must stay below 0.1" while optimizing LCP)
- Configure model tier and throughput for execution

### Phase 2: Execution (MVP)

The orchestrator loop. AutoAuto controls the loop, the agent is stateless between iterations:

1. Establish baseline (run measurement on unmodified code)
2. Spawn a fresh **Experiment Agent** with a compact context packet:
   - Current baseline metric
   - Recent results.tsv rows
   - Recent git log (includes reverted experiments — agent can inspect with `git show`)
   - One-line summary of last outcome (including *why* it was discarded, not just that it was)
   - Recent discarded commit messages + diffs (so the agent avoids retrying failed approaches)
3. Agent makes one change, commits
4. AutoAuto builds and measures (median of N runs, configurable per program)
5. **Keep** (improvement beyond noise threshold, all quality gates pass) or **Discard** (`git revert`, preserving history so agent can learn from failures)
6. Re-measure baseline after keeps (code changed) and after consecutive discards (check for environment drift)
7. Loop until manually stopped or max experiment count reached

**Locked evaluator:** `measure.sh` and `config.json` are made read-only (`chmod 444`) before the experiment loop starts. The Experiment Agent must never modify the measurement script or metric config — this is the #1 safeguard against metric gaming. If the agent attempts to edit these files, the orchestrator treats it as a discard.

**Agent tools:** Read, Write, Edit, Bash, Glob, Grep. No directory scoping — trust the system prompt and scope constraints in program.md. Failures are safely reverted.

**Run termination:** Manual stop kills the current experiment immediately. Max experiment count stops after the current experiment finishes. Both prompt: run cleanup or abandon.

**TUI Dashboard during execution:**
- Current experiment # / total keeps / discards
- Current baseline metric value
- Best metric achieved + improvement % from original baseline
- Live results table
- Streaming agent thinking text in a styled panel (view-only)
- Sparkline or bar chart of metric over time

### Phase 3: Cleanup

Review and package the results:

- Run a **Cleanup Agent** (support model) over the accumulated diff from baseline to branch tip
- Preserve the raw experiment branch as the audit trail (`results.tsv` + git history remain intact)
- Create a separate PR branch from the run baseline and apply the selected net diff there
- Squash/package the PR branch into clean commit(s) ready for review
- Generate a markdown summary report per run with:
  - Total experiments, keeps, discards
  - Metric improvement timeline
  - Description of each kept change
  - Callouts for risky or user-facing changes
- Flag changes that warrant manual review

## Constraints

- **Locked evaluator** — see Phase 2 for details
- One run at a time per project (MVP, architecture supports multiple)
- No Fix Agent for MVP — measurement failure or quality gate failure → discard and move on

### Phase 4: Background Daemon

Decouple the orchestrator from the TUI so runs survive terminal close/quit.

**Architecture:** Client-server split. The orchestrator runs as a detached Bun daemon process inside an AutoAuto-owned git worktree. The TUI is a client that reads state and displays it.

- **Run isolation:** "Start Run" creates a dedicated git worktree and branch for the run. The daemon never runs experiments in the user's active checkout. Destructive cleanup (`git reset --hard` for uncommitted experiment changes, worktree removal after abandon) is only allowed inside this owned worktree.
- **Daemon lifecycle:** "Start Run" spawns a detached child process with stdio redirected to `daemon.log`, then calls `unref()` so the TUI can exit independently. Daemon writes `daemon.json` with `run_id`, `daemon_id`, `pid`, `started_at`, `heartbeat_at`, and `worktree_path`. TUI uses `kill(pid, 0)` only as a hint; it also checks `daemon_id` and heartbeat age to avoid PID-reuse/stale-pid mistakes.
- **IPC:** Filesystem-based. Daemon atomically rewrites `state.json` via temp-file + rename, appends durable experiment outcomes to `results.tsv`, and appends live display events/agent output to `events.ndjson`. TUI watches/polls these files and tolerates a partial trailing NDJSON/TSV line. No socket protocol needed for MVP.
- **Checkpoint state:** `state.json` is the recovery source of truth, not git-history inference. It records `phase` (`idle`, `agent_running`, `measuring`, `reverting`, `kept`, `stopping`, `complete`, `crashed`), `experiment_id`, `last_known_good_sha`, `candidate_sha`, `baseline`, stop mode, and last committed result row.
- **Stop semantics:** TUI writes `control.json` and sends `SIGTERM`. Default stop is `stop-after-current` (finish current experiment, then exit). Explicit abort is `abort-current` (terminate child process group, revert/reset to `last_known_good_sha`, log a `crash` row with description `aborted`). If the daemon ignores TERM, TUI may escalate to SIGKILL after a timeout and recovery handles it on restart.
- **Child process cleanup:** Daemon tracks spawned experiment agents, measurements, and their process groups. On abort/crash, it kills the whole child process group before reverting/resetting the worktree so no orphan process keeps editing files.
- **Crash recovery:** On daemon startup/resume, read `state.json`. If phase indicates an in-flight experiment, kill any leftover child process group, restore the owned worktree to `last_known_good_sha` (`git revert` committed candidate or `git reset --hard` for uncommitted changes), append a `crash` row to `results.tsv` if not already recorded, write final recovery state, then continue or exit depending on stop mode. Safe because recovery only touches the AutoAuto-owned worktree and the checkpoint names the exact known-good SHA.
- **Locking:** MVP enforces one active run per project with an atomic lock (`mkdir`/`O_EXCL` style), storing `run_id` and `daemon_id`. Stale locks require dead PID + expired heartbeat before takeover. Multi-daemon support later means one lock/worktree per run; separate run directories alone are not sufficient.

## Future Ideas

- **Fix Agent** — on crash, spawn a focused agent with error output + the diff, 1-2 fix attempts before discarding
- **Configurable agent output detail** — toggle between thinking-only, thinking + tool calls, or full raw output during execution
- **Parallel experiments** — run multiple programs simultaneously via git worktrees, with deduplication to prevent the same idea being tried in parallel
- **Codex / OpenCode agent support** — alternative agent backends beyond Claude
- **Quota fallback** — switch to a different CLI/agent when API quota is reached
- **Rich visualizations** — detailed charts and tables for completed runs
- **Re-profiling** — separate profiling step (e.g. flame graphs, trace analysis) that feeds structured data to the experiment agent
- **Learnings persistence** — explore a `learnings.md` that accumulates qualitative insights across iterations (why things failed, not just that they did), to complement the results.tsv + git history approach
- **Creativity ceiling / local optima** — after ~50-80 experiments agents tend to get stuck in local search (random seed changes, micro-adjustments). Explore meta-prompt optimization: a second agent reviews results and rewrites `program.md` to push exploration in new directions. Also consider diversity directives that reward novelty alongside improvement, or periodic resets from earlier checkpoints.

## References

- `references/autoresearch/` — Karpathy's original autoresearch repository and program.md
- `references/modulaser/` — manual autoresearch implementation with bash orchestrator, multiple optimization programs, measurement scripts, noise thresholds, quality gates, and re-profiling
- `references/articles/` — collected articles about autoresearch
