# AutoAgent (kevinrgu)

- **URL**: https://github.com/kevinrgu/autoagent
- **Stars**: 3,769 | **Created**: 2026-04-02
- **Form factor**: Repo template / convention — no CLI, TUI, or web UI

## What it is

A "convention over code" approach. There's no orchestrator — your existing coding agent (Claude Code, Cursor, etc.) reads `program.md` and *is* the orchestrator. The entire runtime is just `agent.py` (the thing being optimized) + Harbor benchmark infra. Two commits total. The insight is that `program.md` itself is the product — the human programs the loop by editing natural language, not code.

## Good ideas we don't have

### 1. Failure root-cause grouping before choosing next experiment

`program.md` prescribes: read task-level results → diagnose failed tasks from trajectories → **group failures by root cause** → pick one general improvement targeting a class of failures.

We currently just pass recent results + discarded diffs as context. We don't ask the agent to explicitly categorize failures before choosing what to try next. This structured diagnosis step could improve experiment quality — especially after 10+ iterations when the easy wins are gone.

**Actionable:** Add a "failure analysis" section to the experiment context packet or system prompt that instructs the agent to group recent discards by root cause before proposing a change.

### 2. Simplicity criterion as a keep reason

If the metric is equal but the code is *simpler*, that's a keep. They explicitly define what "simpler" means: fewer components, less brittle logic, less special-case handling, simpler prompts, cleaner interfaces, less code for the same outcome.

We only keep on metric improvement. Refactoring that maintains the metric but simplifies code gets discarded. This means the codebase accumulates cruft over long runs.

**Actionable:** Add an optional "simplicity keep" mode — if metric is within noise threshold and the diff is a net reduction in complexity (lines removed > added, or similar heuristic), keep it. Could be a config flag per program.

### 3. Overfitting test

*"If this exact task disappeared, would this still be a worthwhile improvement?"* — explicit anti-gaming instruction baked into the loop rules.

Our `program.md` has scope constraints, but we don't have this specific litmus test framed as a question the agent should ask itself.

**Actionable:** Add this overfitting test to `getExperimentSystemPrompt()` as a standard instruction.

### 4. Editable vs fixed boundary markers in target code

`agent.py` has an explicit `FIXED ADAPTER BOUNDARY` comment. The meta-agent knows exactly what it can and cannot touch — marked inside the file itself, not just in external instructions.

Our `program.md` defines scope constraints externally. This pattern of marking boundaries *inside the target files* is interesting for projects where the optimization target is a specific file.

**Actionable:** Could suggest this as a best practice during setup — have the Setup Agent recommend users add boundary markers in their code if the optimization target is a specific file.

### 5. Decomposable metrics with per-case visibility

Their Harbor benchmarks give per-task granularity for free — the agent sees "task 14 regressed, task 27 improved" not just "score went from 0.72 to 0.74." This is what makes failure root-cause grouping (#1) actually work: the agent can read individual task trajectories, see *why* specific tasks failed, and group them by category.

This is only possible because their repo is locked to one specific thing (agent engineering against Harbor benchmarks). But the underlying idea generalizes: many real use cases have decomposable metrics — test suites (per-test pass/fail), Lighthouse (per-audit scores), benchmark suites (per-benchmark timings).

**Actionable:** Support optional structured sub-metric output from `measure.sh`. Right now we output a single number. If `measure.sh` could optionally emit per-case results (e.g. a TSV or `metric:name=value` lines), the context packet could tell the agent "these 3 tests regressed, these 2 improved" instead of just "metric went down." Way richer signal for the agent to reason about, and it enables structured failure diagnosis.

## What they don't have (our advantages)

- No variance analysis / noise thresholds — single-run measurements, keep/discard based on a single noisy run
- No measurement locking — agent could edit the benchmark
- No re-baselining for drift detection
- No TUI / any UI at all
- No daemon / background execution
- No cost tracking
- No quality gates
- No git worktree isolation (relies on Docker instead)
