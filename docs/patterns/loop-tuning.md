# Loop Tuning Patterns

Research-backed patterns for designing and tuning the experiment loop. Extracted from 30+ real-world autoresearch implementations.

## Context packet design

Each experiment agent starts with a fresh context. What you feed it determines proposal quality.

**Core packet (every iteration):**
- Current baseline metric — the number to beat
- Recent results.tsv rows — last 10-20 experiments with status, metric, description
- Recent discarded commit messages + diffs — so the agent avoids retrying failed approaches
- One-line summary of last outcome — including *why* it was discarded
- `program.md` — scope constraints, rules, off-limits files, step-by-step instructions
- Recent git log — includes reverted experiments the agent can inspect with `git show`

**What NOT to include:**
- Full git history (context overflow)
- Raw measurement output (summarize to the metric value)
- Previous agent reasoning (creates narrative momentum and drift)

**Key insight:** One experiment per agent call is deliberate — prevents context overflow, enables clean error recovery, and maintains state separation. Different agents converge on the same answers when the search landscape has real structure.

## Ideas backlog

The ideas backlog prevents agents from retrying failed approaches. One implementation called it "the killer feature."

**How it works:**
1. Each experiment agent reads the backlog before proposing
2. After each experiment, the agent appends: what it tried, the result, what to try next
3. Failed experiments include *why* they failed
4. The backlog accumulates across the entire run

**Why it matters:** One test fix went through four different approaches before finding one that held — the backlog prevented retrying the three that failed.

**The dedicated file is stronger than git history** because it captures *reasoning*, not just *outcomes*. Git history tells you what changed; the backlog tells you why it didn't work and what to try instead.

**Cross-run memory (carry forward):** When starting a new run, AutoAuto can feed the previous run's ideas backlog and kept-experiment summaries into the new run's context. This extends the backlog's anti-repetition benefit across program iterations — the agent won't retry approaches that a previous run already explored and discarded. Carry forward is adaptive: if the current run's own backlog grows large, previous ideas are dropped to stay within context limits. The framing is termination-aware: stagnation nudges the agent toward orthogonal exploration (Liu et al.'s "pivot" pattern), while max-experiments signals that unexplored directions may remain.

## Ratchet logic

The core keep/discard loop:

1. Agent makes one change, commits
2. Orchestrator measures (median of N runs)
3. If metric improved beyond noise threshold AND quality gates pass -> **keep**
4. If metric didn't improve or a gate failed -> **discard** (`git reset --hard`)
5. Loop

**Design principles:**
- **Immediate accept/revert.** No probabilistic acceptance, no batching. The codebase can only move forward.
- **Fixed evaluation budget.** Every experiment gets the same measurement budget, making results comparable.
- **One change per experiment.** Multi-file, multi-concern changes create interactions that single-metric evaluation can't capture.
- **Simpler is better at equal metric.** If two approaches produce the same metric, prefer the simpler one. AutoAuto implements this as the simplicity criterion (auto-keeps within-noise changes that reduce LOC).

**Typical throughput:** ~12 experiments/hour at 5-minute evaluation budget. Faster evaluations push this much higher.

### Three-way decision variant

Liu et al.'s pipeline uses a richer decision: **proceed** (improved >=0.5%), **iterate** (ambiguous — refine the hypothesis), or **pivot** (two consecutive degradations — revert and try a new direction). The "iterate" option lets the pipeline refine a promising idea rather than discarding it. This produced ~50 experiments in ~72 hours.

## Re-baseline strategies

The baseline drifts. Environment changes, code changes, and cache bugs create phantom improvements.

**When to re-baseline:**
- After every keep — the code changed, the old baseline is invalid
- After consecutive discards — check for environment drift (thermals, background processes, API rate limits)
- When changing upstream components — if you alter the distribution that previous optimizations assumed, restart with a fresh baseline

**What NOT to do:**
- Change the baseline mid-run without restarting — frozen baselines are the fairness guarantee
- Assume the baseline is stable over hours — it's not, especially for hardware-dependent metrics

## Stopping criteria

### Diminishing returns detection

After ~50-80 experiments, agents degrade to random seed changes, tiny parameter adjustments, and micro-optimizations. This is the creativity ceiling.

**Detection signals:**
- N consecutive discards (Langfuse used 5; AutoAuto defaults to 10)
- Proposals become trivially small (seed changes, constant tweaks)
- Improvement magnitudes shrink toward the noise floor
- Agent starts repeating ideas from the backlog

### Ceiling mapping

One production case ran 16 iterations with zero improvements. The finding: "You can stop tuning this." Knowing a component has no headroom is a real deliverable — it tells you to invest effort elsewhere.

### Ceiling confirmation

Running multiple independent runs at convergence — if they all yield similar results, the ceiling is real, not a failure of exploration. Four independent runs at [0.791, 0.797] F1 proved a ~0.795 ceiling.

### Practical stopping strategies

| Strategy | When to use |
|----------|-------------|
| Max experiment count | Budget cap — 50-100 per overnight run |
| N consecutive failures | Quick ceiling detection — 5-10 is typical |
| Improvement below noise floor | Metric gains indistinguishable from variance |
| Time budget | Wall-clock cap for the entire run |
| Manual stop | Human reviews progress and decides |

## Escaping local optima

No implementation fully solves the creativity ceiling, but several tactics work:

### Human nudge cycle
The most documented pattern. Agent explores -> hits ceiling -> human asks probing questions -> agent continues. Concrete tactics:
- **Rubber duck debugging:** Ask the agent to walk through its reasoning. Explaining its thinking can unlock a breakthrough.
- **Research sub-agent:** Instruct the agent to spawn a research sub-agent that returns ranked ideas.

### Escalating exploration directives
AutoAuto injects progressively stronger diversity instructions based on consecutive discards / max limit:
- 30%: nudge to try a different category of approach
- 50%: go orthogonal or simplify
- 70%: try something radically different or exit without committing

The counter resets on any keep. Cheap, no architecture change, scales automatically.

### NEVER STOP instruction
The agent is instructed it cannot pause to ask for input — it must continue until terminated. Increases risk of late-session micro-adjustments; best combined with a max count.

## Crash recovery

Experiments will crash. The loop must recover automatically.

1. **Detect:** Process exits non-zero, times out, or produces invalid output
2. **Reset:** `git reset --hard` to last known-good SHA (safe — single commit on a dedicated branch)
3. **Log:** Record what crashed and why in results.tsv (prevents retrying the same approach)
4. **Continue:** Next experiment. No human intervention needed.

**Self-healing variant:** Liu et al.'s pipeline classifies errors by type and generates targeted fixes. When an embedding service returned 403 from an expired API key, the module detected authentication failure and switched to a local backend.

**Empirical data:** One 15-hour run had 157 experiments: 124 rollbacks, 20 improvements, 3 crashes — all auto-recovered.

## Model choice tradeoffs

Proposal quality dominates total cost. A slower, more accurate model saves more in wasted evaluation than it costs in API time.

### The Cerebras comparison

| | GPT-5.4 | Codex-Spark |
|---|---------|-------------|
| Proposal accept rate | **67%** | 17% |
| GPU time wasted on rejects | 20 min | **2 hours** |

Spark generated proposals faster, but 83% were rejected — wasting 2 hours of compute. GPT-5.4 was slower per proposal but its higher quality meant less wasted evaluation overall.

**Implications:**
- Use the best model you can afford for experiments. Higher proposal quality -> fewer wasted measurement cycles -> lower total cost.
- Lower throughput models are fine for setup/finalize since they run once, not hundreds of times.
- Well-constrained problems are less model-sensitive. Open-ended optimization benefits more from capable models.
- Better instructions > better model. Invest in `program.md` quality before upgrading the model.

## Empirical benchmarks

### Detailed progression: Barazany's CRM AUC run

Shows how human nudges + sub-agent research break through plateaus across 165 experiments:

| Stage | AUC | Key Change |
|-------|-----|------------|
| Baseline | 0.581 | Single XGBoost, 10 features |
| +Stacking | 0.628 | 5 models stacked with meta-learner (after rubber duck nudge) |
| +Temporal features | 0.654 | Year, quarter, month features |
| +CatBoost | 0.669 | New base model (after research sub-agent) |
| +Better CV | 0.669 | 20-fold cross-validation (no metric gain, better reliability) |
| Simplified | 0.670 | Less is more |
| Removed redundant feature | 0.6719 | Cleaner signal |
| +Temporal decay weights | 0.6747 | Older data weighted less |

Key insight: a non-data-scientist used the pattern to break through a 3-week manual plateau.
