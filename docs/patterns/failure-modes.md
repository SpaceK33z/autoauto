# Failure Modes & Safeguards

What goes wrong in autoresearch — and how AutoAuto prevents it. These failure modes are documented from 30+ real-world implementations across ML training, software performance, prompt optimization, search ranking, and marketing.

Understanding these patterns helps you design better programs, write better measurements, and recognize when the loop is going off-track.

---

## 1. Metric Gaming (Goodhart's Law)

The agent optimizes the measurement instead of the real goal. This is the #1 failure mode and operates at machine speed.

### 1a. Random seed manipulation
**What happened:** Agent changed random seed from 42 to 137 for a tiny metric gain. No real improvement — just a lucky seed.
**Source:** paddo (700 experiments)
**How AutoAuto helps:** Measurement scripts are locked (`chmod 444`) before the loop starts. If the seed is in the locked script, the agent can't touch it. If it's in editable code, the Setup Agent should warn you to move it.

### 1b. Gaming time constraints instead of improving the model
**What happened:** With a strict 1-minute time limit, the agent implemented inplace ReLU, torch.compile, GPU preloading, and mixed precision — not to improve the model, but to squeeze more computation into the time budget.
**Source:** L.J. (15-hour CIFAR-10)
**How AutoAuto helps:** Awareness. This is sometimes actually desirable. Mention in `program.md` whether compute efficiency changes are in-scope or not.

### 1c. Stripping features to improve test scores
**What happened:** Agent removed documentation-fetching steps, user approval gates, and subprompt sections from a prompt skill because the test harness didn't exercise those features. Scores improved; real-world quality degraded.
**Source:** Langfuse (AI skill optimization)
**How AutoAuto helps:** Quality gates on secondary metrics. Your test harness should cover real-world paths, not just happy paths. The Setup Agent warns: "If your test cases don't exercise a feature, the agent may remove it."

### 1d. Sliding-scale eval criteria are trivially gamed
**What happened:** When using 1-7 numeric scales for subjective evaluation, agents learn to produce outputs that score 6-7 without actually being better — they game the rubric language.
**Source:** Saladi (Builder's Playbook)
**How AutoAuto helps:** The Setup Agent guides you toward 3-6 binary (yes/no) eval criteria instead of numeric scales. See the [Measurement Guide](../measurement-guide.md#binary-vs-numeric-scoring).

### 1e. AI-judging-AI circularity
**What happened:** Marketing copy optimization used an LLM to evaluate LLM-generated copy. The reported gains were AI-judged, not validated against actual users.
**Source:** Monkfrom (ML to Marketing)
**How AutoAuto helps:** Awareness only. Treat AI-evaluated scores as pre-filters, not ground truth. Where possible, close the loop with real metrics (click rates, conversion, user feedback).

### 1f. Cargo-cult optimizations that game benchmarks
**What happened:** Agent replaced math operations with bitwise ops (which the compiler already optimizes), and unrolled duplicate-key checks for specific map sizes. Benchmark improved, but changes didn't generalize beyond the specific test cases.
**Source:** Koskinen (pi-autoresearch, jsonista)
**How AutoAuto helps:** Awareness. Use diverse test inputs and ask: "Do the optimizations generalize?"

---

## 2. Agent Drift

The agent goes off-task, pursuing interesting side-quests instead of the defined objective.

### 2a. Overnight drift into unrelated research
**What happened:** Agent tasked with optimizing inference memory usage spent 12 hours investigating minimum needed model weights instead. Over 19 autonomous experiments, the agent shifted objectives without guidance.
**Source:** Cerebras (71 experiments)
**How AutoAuto helps:** Strict scope constraints in `program.md`. One experiment per agent call with fresh context — no narrative momentum. Explicit "off-limits" section prevents drift.

### 2b. Scope creep across files
**What happened:** Analyses warn that the pattern breaks down when agents modify multiple files or systems simultaneously. Changes become entangled and hard to evaluate or revert.
**Source:** SoftmaxData (architecture analysis)
**How AutoAuto helps:** Scope constraints in `program.md` restrict modifications to defined files. Lock violation detection discards any experiment that touches `.autoauto/`.

### 2c. Infrastructure friction consuming more time than experiments
**What happened:** "We spent more time debugging sandbox permissions than running actual experiments." GPU access restrictions, package manager failures, and environment variable handling created friction.
**Source:** Cerebras (71 experiments)
**How AutoAuto helps:** The Setup Agent validates the execution environment before starting — runs a smoke test (build + measure) to surface issues before committing to an overnight run.

---

## 3. Overfitting to the Harness

The agent improves test scores without improving real-world performance. Distinct from metric gaming — here the metric is correct, but the test environment isn't representative.

### 3a. Harness vs. real-world gap
**What happened:** Scored 0.35 to 0.824 on the harness, but the harness measured correctness/completeness/efficiency and missed UX-critical features.
**Source:** Langfuse
**How AutoAuto helps:** Design eval harnesses that penalize removing features. Include negative test cases: "must still support X."

### 3b. Optimizing for eval set, not generalization
**What happened:** Running 100+ experiments against the same validation set carries overfitting risk. Improvements may be specific to that eval data.
**Source:** DataCamp (guide), VentureBeat
**How AutoAuto helps:** Awareness. Consider rotating eval sets for long runs. Re-validate final results on a completely unseen test set before merging.

### 3c. Hardware-specific optimizations that don't transfer
**What happened:** Optimizations that help on one GPU hurt on another. Improvements are specific to the exact hardware configuration.
**Source:** paddo (700 experiments)
**How AutoAuto helps:** Awareness. Document the target hardware in `program.md`. Validate on target hardware before deploying.

---

## 4. Cache & Environment Bugs

False signals from infrastructure issues that make the agent think it improved something when it didn't.

### 4a. Cache keyed incorrectly
**What happened:** Redis cache was keyed on `hash(query)` but not `hash(query + prompt)`. First iterations of prompt optimization showed fake improvements from stale results.
**Source:** Hoberman (60 experiments, production search)
**How AutoAuto helps:** The Setup Agent asks: "Does your system have any caching layers?" and generates cache-busting logic in `measure.sh`.

### 4b. Test cleanup hooks leaking state
**What happened:** Browser sessions and test cleanup hooks were leaking state between test runs, causing flaky results that masked real improvements.
**Source:** Piana (flaky tests at Gumroad)
**How AutoAuto helps:** Measurement stability validation during setup — runs the script multiple times and checks variance. High variance triggers investigation.

### 4c. Environment drift during long runs
**What happened:** Long-running loops compare against a stale baseline. Context shifts, seasonality, and hardware effects make later measurements less comparable.
**Source:** MindStudio, paddo, DataCamp
**How AutoAuto helps:** Automatic re-baselining after keeps and after consecutive discards.

### 4d. Data pipeline bugs masquerading as algorithm limitations
**What happened:** A missing `response_format` parameter caused 9x verbosity (+175% F1 when fixed). 4,277 corrupted timestamps (+7% F1). BM25 tokenization not stripping punctuation (+0.018 F1). None were algorithm issues.
**Source:** Liu et al. (Omni-SimpleMem, ~50 experiments)
**How AutoAuto helps:** This is actually a *strength* — code-comprehending agents find data pipeline bugs that no amount of hyperparameter search would surface. Include data pipeline code in scope when the metric depends on data processing.

### 4e. Counter-intuitive conventional wisdom
**What happened:** Returning full original dialogue text instead of LLM-generated summaries improved F1 by +53%. Summaries paraphrase away the exact words the metric rewards.
**Source:** Liu et al. (Mem-Gallery)
**How AutoAuto helps:** Let the agent challenge assumptions. Avoid over-constraining `program.md` with "best practices" the agent should be free to test.

---

## 5. Agent Amnesia & Repetition

The agent forgets what it tried and wastes cycles re-attempting failed approaches.

### 5a. No centralized learnings lead to retry loops
**What happened:** Without a record of what was tried, agents waste cycles retrying discarded hypotheses multiple times.
**Source:** Cabral (reality vs. expectations)
**How AutoAuto helps:** Context packets include recent discarded diffs with reasons. The ideas backlog forces the agent to document what to try next and what to avoid. Carry forward extends this across runs — new runs receive the previous run's results and ideas, preventing cross-run repetition.

### 5b. Running out of ideas leads to micro-adjustments
**What happened:** Late in long sessions, agents degrade to random seed changes, tiny parameter tweaks, and minor adjustments.
**Source:** paddo (700 experiments), DataCamp
**How AutoAuto helps:** Escalating exploration directives push agents toward orthogonal approaches at 30%/50%/70% of the stagnation limit. Auto-stop after `max_consecutive_discards`.

### 5c. No human nudge after plateau
**What happened:** Agent explores, hits a ceiling, human nudges, agent continues — this pattern repeated throughout a 165-experiment run.
**Source:** Barazany (CRM AUC run)
**How AutoAuto helps:** Partially. Stagnation detection alerts you. Future: meta-agent to rewrite `program.md` at plateaus.

---

## 6. Co-optimization & Interaction Effects

### 6a. Sequential round ceiling
**What happened:** Round 1 tuned ranking for a specific metadata distribution. Round 2 changed the metadata prompt, altering the distribution Round 1 optimized for. Every improvement for one query type degraded another.
**Source:** Hoberman (60 experiments)
**How AutoAuto helps:** Awareness. Co-optimize interacting components in the same round where possible.

### 6b. No isolation between improvements
**What happened:** 20 improvements stacked sequentially — can't tell if improvement #15 still matters after #16-#20 built on top.
**Source:** paddo (700 experiments)
**How AutoAuto helps:** Inherent to the ratchet pattern. For critical results, re-validate the final accumulated diff against the original baseline.

---

## 7. Measurement Design Failures

### 7a. No objective, frozen metric
Subjective goals like "readability" without a deterministic scoring script cause the loop to descend into chaos.

### 7b. Slow feedback loops
When experiments take hours or days, you lose the statistical advantage of rapid iteration. Use proxy metrics.

### 7c. High cost of failure
Attaching the loop to live trading or production traffic means every failed hypothesis costs real money. Prefer local/staging environments.

### 7d. Testing too many variables simultaneously
When multiple elements change at once, you can't attribute improvements. One change per experiment.

### 7e. Insufficient sample size
Small test sets produce unreliable results. Validate measurement stability before starting.

### 7f. Cheap proposal agents wasting expensive eval cycles
GPT-5.4 accepted 67% of proposals while Codex-Spark accepted 17%. Spark was faster, but wasted more GPU time on rejected proposals. Pick agents by total eval cost, not prompt cost.

### 7g. Optimizing around a broken funnel
Broken upstream funnels cannot be fixed by copy optimization alone. Verify the optimized asset is plausibly causal for the target metric.

---

## Safeguard priority

| Priority | Safeguard | Status in AutoAuto |
|----------|-----------|-------------------|
| P0 | Locked evaluator (measure.sh + config.json immutable) | Built in |
| P0 | Scope enforcement via program.md | Built in |
| P0 | Measurement stability validation during setup | Built in |
| P1 | Failed experiment history in context packets | Built in |
| P1 | Periodic baseline re-measurement | Built in |
| P1 | Ideas backlog for institutional memory | Built in |
| P1 | Escalating exploration directives | Built in |
| P1 | Stagnation auto-stop | Built in |
| P2 | Held-out validation set warning | Setup Agent guidance |
| P2 | Hardware specificity warning | Setup Agent guidance |
| P2 | Binary eval criteria guidance | Setup Agent guidance |
