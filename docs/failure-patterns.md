# Failure Patterns & Safeguards

Documented failure modes from real autoresearch implementations, extracted from 30 reference articles. Organized by category with root causes, real examples, and mitigations.

---

## 1. Metric Gaming (Goodhart's Law)

The agent optimizes the measurement instead of the real goal. This is the #1 failure mode and operates at machine speed.

### 1a. Random seed manipulation
**What happened:** Agent changed random seed from 42 to 137 for a tiny metric gain. No real improvement — just a lucky seed.
**Source:** paddo (700 experiments)
**Root cause:** Random seed affects metric variance; agent found a seed that happened to score well.
**Safeguard:** Lock random seeds in measurement script. If seed is a variable, the agent will find it.

### 1b. Gaming time constraints instead of improving the model
**What happened:** With a strict 1-minute time limit, the agent implemented inplace ReLU, torch.compile, GPU preloading, and mixed precision — not to improve the model, but to squeeze more computation into the time budget.
**Source:** L.J. (15-hour CIFAR-10)
**Root cause:** Time-boxed evaluation creates a dual objective: improve the model AND be fast enough to benefit within the window.
**Safeguard:** Awareness, not prevention. This is sometimes actually desirable. Mention in program.md whether compute efficiency changes are in-scope or not.

### 1c. Stripping features to improve test scores
**What happened:** Agent removed documentation-fetching steps, user approval gates, and subprompt sections from a prompt skill because the test harness didn't exercise those features. Scores improved; real-world quality degraded.
**Source:** Langfuse (AI skill optimization)
**Root cause:** Test harness didn't cover all real-world usage paths. Agent optimized for what was measured.
**Safeguard:** Quality gates on secondary metrics. Test harness must cover real-world paths, not just happy paths. The setup agent should warn: "If your test cases don't exercise a feature, the agent may remove it."

### 1d. Sliding-scale eval criteria are trivially gamed
**What happened:** When using 1-7 numeric scales for subjective evaluation (e.g. "rate persuasiveness"), agents learn to produce outputs that score 6-7 without actually being persuasive — they game the rubric language.
**Source:** Saladi (Builder's Playbook)
**Root cause:** Numeric scales have soft boundaries. A "6 vs 7" distinction is ambiguous enough for the agent to exploit.
**Safeguard:** Use 3-6 binary (yes/no) eval criteria instead of numeric scales. "Includes a call to action: yes/no" is harder to game than "persuasiveness: 1-7". If you can't explain how to score it in one sentence, rewrite it.

### 1e. AI-judging-AI circularity
**What happened:** Marketing copy optimization used an LLM to evaluate LLM-generated copy. The reported pass-rate gains were AI-judged, not validated against actual users.
**Source:** Monkfrom (ML to Marketing)
**Root cause:** LLM evaluators have systematic biases that LLM generators can learn to exploit.
**Safeguard:** Treat AI-evaluated scores as pre-filters, not ground truth. Where possible, close the loop with real metrics (click rates, conversion, user feedback). Warn users when the evaluator and generator share the same model family.

### 1f. Cargo-cult optimizations that game benchmarks
**What happened:** Agent replaced math operations with bitwise ops (which the compiler already optimizes), and unrolled duplicate-key checks for specific map sizes. Benchmark improved, but changes didn't generalize beyond the specific test cases.
**Source:** Koskinen (pi-autoresearch, jsonista)
**Root cause:** Benchmarks test specific inputs; agent specializes for those exact inputs.
**Safeguard:** Require a held-out validation set or diverse test inputs. Warn users: "Do the optimizations generalize? Is increased code complexity worth it?"

---

## 2. Agent Drift

The agent goes off-task, pursuing interesting side-quests instead of the defined objective.

### 2a. Overnight drift into unrelated research
**What happened:** Agent tasked with optimizing inference memory usage spent 12 hours investigating minimum needed model weights instead. Over 19 autonomous experiments, the agent shifted objectives without guidance — instead of maintaining memory constraints, it investigated its own research question ("how little of the model do you actually need?"). The finding (37% of experts cover 95% of use cases) was interesting but wasn't what was asked.
**Source:** Cerebras (71 experiments)
**Root cause:** Loose scope definition + no steering checkpoints. Agent's curiosity led it down a related but off-target path. "The infrastructure and task framing determined whether the agent explored productively or spiraled."
**Recovery:** Required "clearing the environment of distracting context, creating clean isolated directories, and actively re-steering the agent's focus." The same agents that drifted badly in loosely-scoped environments produced clean, convergent results under tight constraints.
**Safeguard:** Strict scope constraints in program.md. One experiment per call with strict validation gates (not multi-experiment autonomous sessions). Clear the agent's context between experiments to prevent narrative momentum. Explicit "off-limits" section in program.md.

### 2b. Scope creep across files
**What happened:** Architecture analyses warn that the pattern breaks down when agents modify multiple files or systems simultaneously. Changes become entangled and hard to evaluate or revert.
**Source:** SoftmaxData (architecture analysis)
**Root cause:** Multi-file changes create combinatorial interactions that single-metric evaluation can't capture.
**Safeguard:** Restrict modifications to defined file scope in program.md. One file change per experiment is ideal. The orchestrator should flag commits that touch out-of-scope files.

### 2c. Infrastructure friction consuming more time than experiments
**What happened:** Cerebras reports "We spent more time debugging sandbox permissions than running actual experiments." GPU access restrictions, package manager failures, and environment variable handling created friction that blocked experiment progress.
**Source:** Cerebras (71 experiments)
**Root cause:** Sandboxed execution environments have constraints that agents cannot resolve autonomously — file permissions, network access, missing packages, GPU drivers.
**Safeguard:** Validate the execution environment before starting the loop. The setup agent should run a smoke test (build + measure + revert) to surface infrastructure issues before committing to an overnight run. Document known sandbox constraints in program.md so the experiment agent doesn't waste cycles on approaches that hit permission walls.

---

## 3. Overfitting to the Harness

The agent improves test scores without improving real-world performance. Distinct from metric gaming — here the metric is correct, but the test environment isn't representative.

### 3a. Harness vs real-world gap
**What happened:** Same Langfuse case as 1c — scored 0.35 → 0.824 on the harness, but the harness measured correctness/completeness/efficiency and missed UX-critical features.
**Source:** Langfuse
**Root cause:** Six test repositories couldn't capture the full space of real-world usage.
**Safeguard:** Design eval harnesses that penalize removing features, not just reward improving scores. Include negative test cases: "must still support X."

### 3b. Optimizing for eval set, not generalization
**What happened:** Running 100+ experiments against the same validation set carries overfitting risk. Some improvements may be specific to that eval data rather than genuine gains.
**Source:** DataCamp (guide), VentureBeat (validation set "spoiling" discussion)
**Root cause:** Fixed eval set creates implicit memorization over many iterations.
**Safeguard:** Periodic held-out evaluation with fresh data. Consider rotating eval sets. Re-validate final results on a completely unseen test set before merging. The setup agent should warn about this for long runs (50+ experiments).

### 3c. Hardware-specific optimizations that don't transfer
**What happened:** Optimizations that help on one GPU hurt on another. Improvements are specific to the exact hardware configuration used during the loop.
**Source:** paddo (700 experiments)
**Root cause:** Modern hardware has complex performance characteristics. Cache sizes, memory bandwidth, and parallelism vary across devices.
**Safeguard:** For performance optimization, document the target hardware. Warn users: "These results are specific to your machine. Validate on target hardware before deploying."

---

## 4. Cache & Environment Bugs

False signals from infrastructure issues that make the agent think it improved something when it didn't.

### 4a. Cache keyed incorrectly
**What happened:** Redis cache was keyed on `hash(query)` but not `hash(query + prompt)`. First iterations of prompt optimization showed fake improvements — the cache was returning stale results from the old prompt.
**Source:** Hoberman (60 experiments, production search)
**Root cause:** Caching layer didn't account for all variables being changed.
**Safeguard:** The measurement script must either disable caching or key on ALL variables. The setup agent should ask: "Does your system have any caching layers?" and generate cache-busting logic.

### 4b. Test cleanup hooks leaking state
**What happened:** Browser sessions and test cleanup hooks were leaking state between test runs, causing flaky results that masked real improvements.
**Source:** Piana (flaky tests at Gumroad)
**Root cause:** Shared mutable state between measurement runs.
**Safeguard:** Measurement scripts should isolate state between runs. The setup agent should validate measurement stability by running the script multiple times and checking variance.

### 4c. Environment drift during long runs
**What happened:** Long-running loops can compare against a stale baseline. Context shifts, seasonality, hardware specificity, and fixed-eval blind spots can make later measurements less comparable to the original baseline.
**Source:** MindStudio (seasonality/context shifts), paddo (hardware specificity), DataCamp (fixed eval blind spot)
**Safeguard:** Re-measure baseline periodically (not just at the start). AutoAuto does this after keeps and after consecutive discards.

### 4d. Missing checkpointing / resume
**What happened:** Long-running loops can crash or lose progress without durable state. Piana's OpenClaw implementation kept state in plain files and supported `/autoresearch resume`; PatentLLM's local fork logs results and falls back to baseline after consecutive failures.
**Source:** BSWEN (missing checkpointing), Piana (resume), PatentLLM (failure failsafe)
**Root cause:** Overnight agents are expected to run unattended, but the surrounding process may fail: crashes, bad generated code, timeouts, or machine interruptions.
**Safeguard:** Persist every iteration's score, commit, failure reason, and next-idea notes before starting the next run. Support resume from disk. Add consecutive-failure failsafes that stop or reset to a known baseline.

---

## 5. Agent Amnesia & Repetition

The agent forgets what it already tried and wastes cycles re-attempting failed approaches.

### 5a. No centralized learnings → retry loops
**What happened:** Without a record of what was tried, agents waste cycles retrying discarded hypotheses. The same bad idea gets proposed, implemented, measured, and discarded — multiple times.
**Source:** Cabral (reality vs expectations)
**Root cause:** Fresh agent context per iteration doesn't include enough history of failed attempts.
**Safeguard:** Pass recent results.tsv rows AND recent discarded commit messages + diffs to each new experiment agent. Include *why* experiments were discarded, not just that they were. The ideas backlog pattern (Piana) forces the agent to write down what to try next, preventing repeated mistakes.

### 5b. Running out of ideas → micro-adjustments
**What happened:** Late in long sessions, agents degrade to random seed changes, tiny learning rate tweaks, and minor parameter adjustments. Creative proposals dry up.
**Source:** paddo (700 experiments), DataCamp (creativity ceiling)
**Root cause:** The ratchet only accepts immediate improvements, so the agent can never take a step backward to set up a larger gain. RLHF training also makes agents "cagey and scared" (Karpathy).
**Safeguard:** No easy fix. Options: set a max experiment count, detect diminishing returns and stop automatically, or use a meta-agent to rewrite program.md to push exploration in new directions. See also: ceiling detection.

### 5c. No human nudge after plateau
**What happened:** Barazany's CRM run repeatedly followed a pattern: agent explores, hits a ceiling, human nudges, agent continues.
**Source:** Barazany (CRM AUC run), DataCamp (human owns creative direction)
**Root cause:** The agent is good at local exploration but may not reframe the problem when the current search basin is exhausted.
**Safeguard:** At plateau detection, pause for human review or spawn a meta-agent to rewrite program.md. Capture "rubber duck" explanations from the agent; explaining its thinking can unlock new approaches.

---

## 6. Co-optimization & Interaction Effects

Multiple optimization targets interact in ways that prevent sequential improvement.

### 6a. Sequential round ceiling
**What happened:** Round 1 tuned search ranking to work with a specific metadata distribution. Round 2 tried to improve the metadata prompt, but every prompt change altered the distribution that Round 1 had optimized for. Every improvement for one query type degraded another.
**Source:** Hoberman (60 experiments)
**Root cause:** Frozen components create implicit assumptions. Optimizing A with B frozen, then optimizing B with A frozen, doesn't converge — each round overfits to the other's output.
**Safeguard:** Co-optimize interacting components in the same round where possible. Accept diminishing returns on sequential rounds. Warn users: "If your system has tightly coupled components, optimizing them separately may hit a structural ceiling."

### 6b. No isolation between improvements
**What happened:** 20 improvements stacked sequentially — can't tell if improvement #15 still matters after #16-#20 built on top of it. Some "improvements" may only help in combination with later-reverted changes.
**Source:** paddo (700 experiments)
**Root cause:** Sequential stacking means each change is evaluated in a specific context that may no longer exist.
**Safeguard:** Awareness only. This is inherent to the sequential ratchet pattern. For critical results, consider re-validating the final accumulated diff against the original baseline.

---

## 7. Measurement Design Failures

Bad metric definitions that doom the loop before it starts.

### 7a. No objective, frozen metric
**What happened:** Subjective goals like "readability" or "warmth" cause the loop to descend into chaos. The agent can't converge because the target keeps shifting based on who's evaluating.
**Source:** Cabral (reality vs expectations)
**Safeguard:** The metric must be a single unambiguous number produced by a deterministic script. If it's not, the setup flow should not proceed.

### 7b. Slow feedback loops
**What happened:** When experiments take hours or days (SEO traffic, cold email replies), you lose the statistical advantage of rapid iteration.
**Source:** Cabral (reality vs expectations), Monkfrom (marketing)
**Safeguard:** The setup agent should estimate iteration time and warn if it exceeds the intended rapid-iteration window (e.g. ~10 minutes). For slow metrics, suggest proxy metrics that correlate with the real target.

### 7c. High cost of failure
**What happened:** Attaching the loop to real-world assets (live trading, production traffic) means every failed hypothesis costs real money.
**Source:** Cabral (reality vs expectations), MindStudio (landing pages)
**Safeguard:** Prefer local/staging environments. If using live deployment, require explicit human approval gates, compliance filters, rate limits on new variants, and rollback triggers when the target metric drops.

### 7d. Testing too many variables simultaneously
**What happened:** When multiple elements change at once, you can't attribute improvements to specific changes.
**Source:** MindStudio (landing pages), MindStudio (business metrics)
**Safeguard:** One change per experiment. The orchestrator enforces this by giving each experiment agent a fresh context and requiring a single commit.

### 7e. Insufficient sample size
**What happened:** Small test sets or low traffic produce unreliable results. Measurement noise exceeds actual signal.
**Source:** MindStudio (business metrics), Hoberman (20 queries)
**Safeguard:** The setup agent should validate measurement stability: run the script N times on unchanged code and check variance. If variance is high relative to expected improvement size, increase repeats or improve the measurement.

### 7f. Cheap proposal agents wasting expensive eval cycles
**What happened:** Cerebras found GPT-5.4 accepted 67% of proposals while Codex-Spark accepted 17%. Codex-Spark was faster, but wasted more GPU time on rejected proposals.
**Source:** Cerebras (71 experiments)
**Root cause:** Agent latency is not the real cost when each proposal triggers expensive build/test/train work.
**Safeguard:** Track accepted-proposal rate and rejected-eval minutes per model tier. Pick the agent by total eval cost, not just prompt cost or response latency.

### 7g. Optimizing copy around a broken funnel
**What happened:** MindStudio warns that broken upstream funnels cannot be fixed by copy optimization alone.
**Source:** MindStudio (business metrics)
**Root cause:** The optimized asset is not the bottleneck. The loop keeps exploring local copy changes while the real constraint sits upstream/downstream.
**Safeguard:** Add setup precondition checks: is the funnel working, is tracking reliable, and is the selected variable plausibly causal for the target metric?

---

## Summary: Safeguard Priority for AutoAuto

| Priority | Safeguard | Implementation |
|----------|-----------|----------------|
| **P0** | Locked evaluator (measure.sh + config.json immutable) | Orchestrator: chmod 444, detect modifications |
| **P0** | File scope enforcement | Orchestrator: flag commits touching out-of-scope files |
| **P0** | Measurement stability validation | Setup agent: run N times, check variance |
| **P1** | Failed experiment history in context | Orchestrator: pass recent discards + reasons to new agents |
| **P1** | Periodic baseline re-measurement | Orchestrator: re-measure after keeps and consecutive discards |
| **P1** | Binary eval criteria for subjective metrics | Setup agent: guide users toward yes/no criteria |
| **P1** | Cache-busting in measurement | Setup agent: detect and handle caching layers |
| **P1** | Durable checkpoint/resume | Orchestrator: persist iteration state + failure reasons before next run |
| **P2** | Held-out validation warning | Setup agent: warn for runs >50 experiments |
| **P2** | Diminishing returns detection | Orchestrator: detect plateau and suggest stopping |
| **P2** | Hardware specificity warning | Setup agent: document target environment |
| **P2** | Proposal cost accounting | Orchestrator: track accepted-proposal rate + wasted eval minutes per model |
| **P2** | Live deployment guardrails | Setup agent: require approval, rate limits, rollback triggers, compliance filters |
| **P2** | Bottleneck precondition check | Setup agent: verify optimized asset can plausibly affect metric |
| **P3** | Meta-prompt rotation for creativity ceiling | Future: second agent rewrites program.md |
