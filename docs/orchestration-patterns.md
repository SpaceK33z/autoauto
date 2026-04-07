# Orchestration Patterns

How to design and run the experiment loop. Extracted from real-world experience across the [reference articles](../references/articles/INDEX.md).

## Context Packet Design

Each experiment agent starts with a fresh context. What you feed it determines proposal quality.

**Core packet (every iteration):**
- **Current baseline metric** — the number to beat
- **Recent results.tsv rows** — last 10-20 experiments with commit, metric, status, description
- **Recent discarded commit messages + diffs** — so the agent avoids retrying failed approaches
- **One-line summary of last outcome** — including *why* it was discarded, not just that it was
- **program.md** — scope constraints, rules, off-limits files, step-by-step instructions
- **Recent git log** — includes reverted experiments the agent can inspect with `git show`

**What NOT to include:**
- Full git history (context overflow)
- Raw measurement output (too noisy — summarize to the metric value)
- Previous agent reasoning (creates narrative momentum and drift)

**Key insight:** One experiment per agent call is a deliberate choice — prevents context overflow, enables clean error recovery, and maintains state separation (Cerebras). Different agents converge on the same answers when the search landscape has real structure.

**The results.tsv is the learning mechanism.** Early experiments tend to be broad (testing different approaches), while later ones narrow in on whichever direction the data validated (DataCamp). Keep it immutable and append-only.

## Ideas Backlog

The ideas backlog is a centralized log that prevents the agent from retrying failed approaches. Piana (Gumroad flaky tests) calls it "the killer feature."

**How it works:**
1. Each experiment agent reads the backlog before proposing
2. After each experiment (keep or discard), the agent appends: what it tried, the result, and what to try next
3. Failed experiments include *why* they failed, not just that they did
4. The backlog accumulates across the entire run

**Why it matters:** Without a centralized learnings doc, agents waste cycles retrying discarded hypotheses (Cabral). One Gumroad tax input field went through four different fix approaches before the agent found one that held — the backlog prevented it from retrying failed approaches (Piana).

**Implementation options:**
- Dedicated `ideas.md` file that agents read and append to (Piana pattern)
- Structured entries in results.tsv with description + failure reason (DataCamp pattern)
- Git history as implicit memory — every commit (including reverted ones) is searchable via `git show` (SoftmaxData)

The dedicated file is stronger because it captures *reasoning*, not just *outcomes*. Git history tells you what changed; the ideas backlog tells you why it didn't work and what to try instead.

## Ratchet Logic

The core keep/discard loop. Simple immediate accept/revert is more effective than complex heuristics.

**The ratchet:**
1. Agent makes one change, commits
2. Orchestrator measures (median of N runs)
3. If metric improved beyond noise threshold AND all quality gates pass → **keep** (commit stays)
4. If metric didn't improve or a gate failed → **discard** (`git revert`, preserving history)
5. Loop

**Design principles:**
- **Immediate accept/revert.** No probabilistic acceptance, no batching, no "maybe later." The codebase can only move forward, never backward, accumulating validated improvements one at a time (DataCamp).
- **Fixed evaluation budget.** Every experiment gets the same measurement budget (e.g. 5-minute wall clock, or N measurement repeats), making results directly comparable. A faster change and a better change are evaluated on equal footing.
- **One change per experiment.** Multi-file, multi-concern changes create combinatorial interactions that single-metric evaluation can't capture. The one-file-per-round constraint prevents scope creep (SoftmaxData).
- **Simpler is better at equal metric.** If two approaches produce the same metric, prefer the simpler one. Agents will add complexity that doesn't generalize.

**Typical throughput:** ~12 experiments/hour at 5-minute evaluation budget. Faster evaluations (30-second cached evals) can push this much higher.

## Re-Baseline Strategies

The baseline drifts. Environment changes, code changes, and cache bugs all create phantom improvements.

**When to re-baseline:**
- **After every keep.** The code changed — the old baseline is no longer valid.
- **After consecutive discards.** Check for environment drift (thermals, background processes, API rate limits). If the baseline shifted, the last N discards may have been wrong.
- **When changing upstream components.** Hoberman's Round 1 tuned ranking for a specific metadata distribution. Round 2 changed the metadata prompt, which altered the distribution that Round 1 had optimized for. Every improvement for one query type degraded another. If you change upstream logic, restart with a fresh baseline.

**What NOT to do:**
- Change the baseline mid-run without restarting. Frozen baselines are the fairness guarantee — changing them invalidates all previous experiments (DataCamp).
- Assume the baseline is stable over hours. It's not, especially for hardware-dependent metrics.

## Stopping Criteria

Knowing when to stop is as valuable as knowing what to optimize.

### Diminishing Returns Detection

After ~50-80 experiments, agents degrade to random seed changes, tiny parameter adjustments, and micro-optimizations (paddo, DataCamp). This is the creativity ceiling.

**Root cause:** The ratchet only accepts immediate improvements, so the agent can never take a step backward to set up a larger gain. RLHF training also makes agents conservative — "cagey and scared" on open-ended problems (Karpathy).

**Detection signals:**
- N consecutive discards (Langfuse used 5 consecutive non-improving experiments)
- Proposals become trivially small (seed changes, constant tweaks)
- Improvement magnitudes shrink toward the noise floor
- Agent starts repeating ideas from the backlog

### Ceiling Mapping

Hoberman's production search: Round 1 got 3 improvements in 44 iterations (93% revert rate). Round 2 got 0 improvements in 16 iterations. The finding: "You can stop tuning this." Knowing a component has no headroom left is a real deliverable — it tells you to invest engineering effort elsewhere.

### Practical Stopping Strategies

| Strategy | When to use |
|----------|-------------|
| Max experiment count | Budget cap — 50-100 per overnight run |
| N consecutive failures | Quick ceiling detection — 5-10 is typical |
| Improvement below noise floor | Metric gains indistinguishable from variance |
| Time budget | Wall-clock cap for the entire run |
| Manual stop | Human reviews progress and decides |

### Escaping Local Optima

No article fully solves the creativity ceiling, but several tactics have proven effective:

**Human nudge cycle (Barazany, 165 experiments):**
The most documented pattern. Agent explores autonomously → hits a ceiling → human asks probing questions or suggests directions → agent continues. This repeated throughout the entire CRM AUC run. Concrete tactics:
- **Rubber duck debugging:** When the agent declared it had exhausted options at experiment 30, Barazany simply asked it to walk through its reasoning. Explaining its thinking unlocked a breakthrough (model stacking, +0.047 AUC).
- **Research sub-agent spawning:** When stuck again later, the instruction "use your agents to research the topic and come up with new ideas" caused the agent to spawn a research sub-agent that returned five ranked ideas. The agent immediately started implementing the top one (CatBoost with target encoding, +0.015 AUC).

**NEVER STOP instruction (paddo):**
The agent is instructed it cannot pause to ask for human input — it must continue running until manually terminated. This prevents premature stoppage but increases the risk of late-session micro-adjustments. Best combined with a max experiment count or diminishing returns detection.

**Other options under exploration:**
- Meta-agent rewrites program.md to push exploration in new directions (SoftmaxData)
- Periodic resets from earlier checkpoints to escape local minima
- Diversity directives that reward novelty alongside improvement

## Crash Recovery

Experiments will crash. The loop must recover automatically so overnight runs aren't interrupted.

**Recovery pattern:**
1. **Detect the crash.** Process exits non-zero, times out, or produces invalid output.
2. **Revert the experiment.** `git revert` the last commit (or `git reset --hard` to last known-good if uncommitted). Safe because experiments are single commits on a dedicated branch — blast radius is always one commit.
3. **Log the failure.** Record what crashed and why in results.tsv (status: "crashed"). This prevents the next agent from retrying the exact same approach.
4. **Continue the loop.** Move to the next experiment. No human intervention needed.

**Time limits:** Kill experiments that exceed the time budget. The program.md should instruct the agent on failure handling: fix typos and re-run, skip ideas that are broken at the root, kill anything that runs past a limit (DataCamp).

**Empirical data:** Medium's 15-hour CIFAR-10 run had 157 experiments: 124 rollbacks, 20 improvements, 3 crashes. All crashes were auto-recovered. Piana's flaky test work survived 206 commits across 94 CI runs via `/autoresearch resume`.

**All state in plain files.** No database, no socket protocol. results.tsv, state.json, git history, and PID files are enough. This makes crash recovery deterministic — just read the last known-good state from the filesystem (Piana).

## Model Choice Tradeoffs

Proposal quality dominates total cost. A slower, more accurate model saves more in wasted evaluation than it costs in API time.

### The Cerebras Comparison

| | GPT-5.4 | Codex-Spark |
|---|---------|-------------|
| Proposal accept rate | **67%** | 17% |
| GPU time wasted on rejects | 20 min | **2 hours** |
| Speed per proposal | Slower | Faster |

Spark generated proposals faster, but 83% of them were rejected — wasting 2 hours of GPU compute on experiments that didn't improve anything. GPT-5.4 was slower per proposal but its higher quality meant less wasted evaluation time overall.

**Implication for AutoAuto's two-model design:**
- **Execution model** (experiment agents): Use the best model you can afford. Higher proposal quality → fewer wasted measurement cycles → lower total cost.
- **Support model** (setup, cleanup): Lower throughput is fine since these run once, not hundreds of times.

**When the problem has structure:** Different agents converge on the same optimizations when the search landscape has real structure (DataCamp). Both GPT-5.4 and Codex-Spark independently converged on learning rate warmdown. This suggests that well-constrained problems are less model-sensitive, while open-ended optimization benefits more from capable models.

**Better instructions > better model:** Well-crafted program.md with tight constraints, explicit failure handling, and clear step-by-step instructions can compensate for model capability (SoftmaxData). Invest in prompt engineering before upgrading the model.

## Empirical Benchmarks

What to expect from real autoresearch runs.

### Keep Rates

| Source | Domain | Experiments | Kept | Keep Rate |
|--------|--------|-------------|------|-----------|
| Hoberman Round 1 | Search ranking | 44 | 3 | 6.8% |
| Hoberman Round 2 | Search ranking | 16 | 0 | 0% |
| Medium (L.J.) | CIFAR-10 training | 157 | 20 | 13% |
| DataCamp (typical) | ML training | 80-100 | 15-20 | ~18% |
| Barazany | Tabular ML | 165 | — | — |
| Langfuse | Prompt skill | 14 | — | — |

A 5-25% keep rate is normal. High revert rates aren't waste — they're the cost of finding the ceiling (Hoberman). But bad proposal quality makes them wasteful (Cerebras).

### Detailed Progression: Barazany's CRM AUC Run

Shows how human nudges + sub-agent research break through plateaus across 165 experiments:

| Stage | AUC | Key Change |
|-------|-----|------------|
| Baseline | 0.581 | Single XGBoost, 10 features |
| +Stacking | 0.628 | 5 models stacked with meta-learner (after rubber duck nudge) |
| +Temporal features | 0.654 | Year, quarter, month features |
| +CatBoost | 0.669 | New base model with target encoding (after research sub-agent) |
| +Better CV | 0.669 | 20-fold cross-validation (no metric gain, better reliability) |
| Simplified meta-features | 0.670 | Less is more |
| Removed redundant feature | 0.6719 | Cleaner signal |
| +Temporal decay weights | 0.6747 | Older data weighted less |

Key insight: a non-data-scientist used the pattern to break through a 3-week manual plateau. "I no longer feel like I'm out of ideas. That's new."

### Cost

| Component | Typical Cost |
|-----------|-------------|
| API per experiment | ~$0.05-0.20 (Claude) |
| 50 experiments overnight | ~$5 |
| 100 experiments overnight | ~$10-25 |
| Claude $20/mo tier | ~100 experiments/day capacity |
| Local (ollama) | $0 API cost |

Eval caching can drastically cut per-iteration time: Hoberman reduced eval from 6 minutes to 30 seconds by caching embeddings (12x speedup), enabling far more iterations in the same budget.

### Notable Results

| Source | Metric | Before | After | Improvement | Experiments |
|--------|--------|--------|-------|-------------|-------------|
| Medium (L.J.) | CIFAR-10 val accuracy | 90.12% | 94.55% | +4.4pp | 157 |
| Hoberman | Search precision composite | 0.6933 | 0.7200 | +3.9% | 44 |
| Langfuse | Prompt skill score | 0.35 | 0.824 | +135% | 14 |
| Barazany | Tabular AUC | 0.581 | 0.675 | +15.6% | 165 |
| Piana | Flaky tests fixed | 0 | 13 | 13 tests | 206 commits |
| Koskinen | JSON ops/sec | baseline | +56% | +56% | — |
| Lehmann | Page load | 1100ms | 67ms | -94% | — |
| Karpathy | nanoGPT training speed | baseline | +11% | +11% | ~125 |
| Shopify (Lutke) | Search quality | 1.6B manual | 0.8B +19% | smaller model wins | 37 |
| Shopify | Liquid rendering | baseline | +53% speed | -61% allocations | 93 commits |
| Aakash | Landing page skill | 41% | 92% | +124% | 4 rounds |

### Transferability of Findings

Not all improvements are hardware- or eval-specific. Karpathy's overnight run produced 20 stacked improvements including a genuine bug in the attention implementation. The 11% speedup transferred to larger models, demonstrating that well-constrained autoresearch can find transferable improvements, not just eval-specific ones. Shopify's result — a 0.8B model outperforming a hand-tuned 1.6B model — similarly shows the pattern finding improvements that generalize.
