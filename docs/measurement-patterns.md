# Measurement Patterns

How to design metrics, measurement scripts, and evaluation harnesses for autoresearch. Extracted from real-world experience across the [reference articles](../references/articles/INDEX.md), with AutoAuto-specific safeguards called out where they are derived from multiple sources rather than stated directly by one article.

## Choosing What to Measure

- **Single unambiguous number.** The metric must have one direction: lower is better or higher is better. Subjective goals like "readability" or "warmth" cause the loop to descend into chaos. If you can't explain how to score it in one sentence, rewrite it. (Cabral, Saladi)
- **Measure the real objective, not the convenient proxy.** BSWEN's example optimized training accuracy and got memorization instead of generalization; the fix was validation loss plus constraints. MindStudio gives the business version: CTR alone can improve cheap clicks without improving lead quality or revenue.
- **Fast feedback.** Best targets produce signal in seconds or minutes. Slow metrics like cold email replies, SEO traffic, and conversion rate can still work, but they become batched business experiments, not overnight rapid loops. Use explicit wait periods and sample-size rules. (Cabral, Monkfrom, MindStudio)
- **Cheap failure.** The cost of a bad iteration should be near zero. Prefer local, synthetic, staging, benchmark, or backtest measurements. If live traffic is unavoidable, cap the blast radius with rate limits, spend limits, approval windows, and rollback triggers. (Cabral, MindStudio)
- **Invariant to irrelevant changes.** `val_bpb` works in the original autoresearch because validation bits per byte is independent of vocabulary size. Good metrics survive structural changes that are not supposed to affect comparability. (DataCamp, Jangwook, Medium)
- **Attributable.** Each movement must be attributable to the changed variant. Testing multiple elements at once obscures causation and burns experiment budget. MindStudio recommends identifying the 2-3 highest-impact variables, then changing only one per cycle.
- **Constrained editable surface.** The metric is only interpretable if the agent has a bounded place to act. The article pattern is one editable file or one clearly scoped component: `train.py`, `utils.py`, a prompt, a skill, or a benchmarked hot path. (DataCamp, SoftmaxData, Hoberman, Saladi, Piana)

## Binary vs Numeric Scoring

- **Use binary criteria for subjective domains.** For prompts, skills, copy, and templates, use 3-6 yes/no questions such as "includes a call to action: yes/no." The composite score is the pass rate across binary questions. (Saladi, Monkfrom)
- **Sliding scales invite gaming.** Agents find edge cases that inflate 1-7 scores without improving real quality. Binary criteria leave less room for score inflation. (Saladi)
- **3-6 criteria is the sweet spot.** Below 3 creates loopholes. Above 6 leads to checklist gaming where the agent optimizes for surface compliance rather than real quality. (Saladi, Monkfrom)
- **Objective domains use direct metrics.** For ML use `val_bpb`, validation loss, accuracy, or AUC. For performance use latency, throughput, ops/sec, allocation count, or bundle size. For flaky tests and CI, a pass/fail metric is robust because the outcome is binary. (Barazany, Koskinen, Piana)
- **Reported examples.** Ole Lehmann's marketing optimization used a 3-6 question checklist and went from 56% to 92% pass rate overnight for about $15. Aakash Gupta reports a landing-page skill improved from 41% to 92% in 4 rounds; Saladi gives the approximate skill/prompt-loop cost as about $0.10 per cycle.

## Composite Metrics & Quality Gates

Two article-backed patterns for multi-metric evaluation:

- **Weighted combination.** Combine sub-metrics into one number when all dimensions are legitimate optimization targets: `(correctness * 0.5) + (completeness * 0.3) + (efficiency * 0.2)` (Langfuse), or `80% Precision@12 + 20% MRR` (Hoberman). Use weights to direct the agent toward the dimension with the most headroom.
- **Primary metric + guardrails.** Optimize one metric while enforcing hard limits on others. BSWEN gives the shape `fitness = latency + 1000 * safety_violations`; MindStudio uses compliance filters, deployment rate limits, approval windows, and rollback if conversion drops 15-20%.
- **Guardrail count matters.** Keep guardrails focused. Too few leave loopholes; too many create checklist gaming or make it unclear why a change passed.

## Variance & Noise

- **Repeat noisy measurements.** Piana's flaky-test case needed enough CI runs to trust the flake was fixed, not just hidden. AutoAuto should repeat noisy measurement scripts during setup, summarize variance, and choose a repeat count before the loop starts.
- **Cache deterministic components.** Hoberman cached Bedrock API calls for embeddings and metadata because only ranking logic changed between iterations. Eval time dropped from 6 minutes to 30 seconds, enabling more iterations in the same budget.
- **Watch for broken caches.** Hoberman's Redis cache was keyed on `hash(query)` instead of `hash(query + prompt)`. Early prompt iterations showed fake improvements from stale cached results. Cache keys must include every input that can change.
- **Re-baseline periodically.** Re-measure the current baseline after keeps and after repeated discards. Long runs can drift because of context shifts, seasonality, hardware effects, fixed-eval blind spots, or flaky infrastructure. (MindStudio, paddo, DataCamp)
- **Document target hardware and environment.** Performance wins can be hardware-specific; paddo reports optimizations that helped on one GPU and hurt on another. Validate on the deployment machine before treating a performance metric as portable.
- **Seed sensitivity.** Agents will change random seeds for tiny gains; paddo observed a change from 42 to 137. If the metric is seed-dependent, either fix the seed in the locked evaluator or measure across multiple seeds.
- **NaN/crash detection.** Detect measurement failures such as NaN loss, OOM, process crashes, timeouts, and invalid generated code. Treat them as discards or remediation events, not as numeric results. (Goyal, PatentLLM, L.J., DataCamp)

## Measurement Stability Validation

AutoAuto setup heuristic, derived from the flaky-test, cache, sample-size, and environment-drift reports:

- **Run the measurement script several times** on unmodified code before the experiment loop. Use 5-10 runs for cheap scripts; use fewer for expensive scripts and report lower confidence.
- **Compute observed noise.** Record min, max, median, standard deviation, and coefficient of variation when numeric values make sense. For binary metrics, record pass rate and consecutive-pass behavior.
- **Flag high-variance measurements.** Common causes: cold starts, flaky infrastructure, nondeterministic APIs, stale caches, background process interference, insufficient sample size, or live-traffic seasonality.
- **Stabilize before optimizing.** Add warm-up runs, increase sample size, pin or average random seeds, isolate test state, cache deterministic API calls, or move from live traffic to a proxy harness.
- **Set the improvement threshold from observed noise.** A 2% improvement means little if repeated measurements vary by 5%.

## Sample Size & Live Metrics

- **Cold email needs enough sends.** MindStudio calls out 50+ sends minimum for cold email. Reply-rate metrics often need 4-6 weeks, so they are not overnight loops.
- **Landing pages need traffic.** MindStudio reports landing-page loops over 8-12 weeks and recommends 200-500+ visitors per variant per cycle.
- **Ad and conversion loops need guardrails.** Optimize full-funnel metrics like CPA, revenue per visitor, qualified lead rate, or click-to-conversion rate instead of CTR alone. Otherwise the agent can win by attracting cheap, low-quality clicks.
- **Deploy slowly.** For live marketing loops, MindStudio's nightly pattern deploys one to two variants, logs decisions, sends a morning summary, and uses compliance filters plus rollback triggers.
- **Synthetic eval is a pre-filter.** Monkfrom warns that AI-judged marketing copy is not a replacement for human behavior. Treat LLM-evaluated pass rates as screening, then validate with real users when the cost is acceptable.

## Harness vs Real-World Gaps

The locked evaluator is both the central safeguard and the central blind spot. What you measure is what you get.

- **Agents strip what is not measured.** Langfuse's agent removed documentation-fetching instructions, user approval steps, and sections on subprompts/trace linking. Scores improved; real-world usage degraded.
- **Harness optimization is not production improvement.** Langfuse saw SDK calls replaced with raw `curl` because it scored better in the harness. Koskinen saw benchmark-specific code unrolling in jsonista. Faster in tests can be worse in practice.
- **The time-budget trap is real.** L.J. observed `torch.compile`, mixed precision, GPU data preloading, and in-place ReLU under a strict 1-minute limit. Those changes optimized for doing more work inside the budget, not necessarily for a better model.
- **Frozen components create blind spots.** Hoberman's round 1 tuned ranking for a specific metadata distribution; round 2 prompt changes shifted the distribution and could not improve without undoing round 1. Co-optimize tightly coupled components when possible.
- **Treat output like a junior engineer's PR.** Cherry-pick the good, discard overfitting, and require human review before merging. Langfuse and Koskinen both frame the loop as a pre-filter, not a replacement for judgment.

## Metric Gaming Defenses

- **Lock the evaluator.** `measure.sh`, `config.json`, `prepare.py`, and equivalent evaluation files should be read-only or otherwise protected before the loop starts. The experiment agent must not modify the measurement.
- **Prefer binary criteria over sliding scales.** Less room for rubric-language gaming.
- **Enforce scope constraints in `program.md`.** Define what is off-limits. Without scope constraints, agents can delete safety checks, remove features, optimize infrastructure instead of the target, or drift into side quests. (Cerebras, Langfuse, SoftmaxData)
- **Use quality gates for side effects.** Primary metric improves but a guardrail fails means discard.
- **Protect validation sets.** Running 100+ experiments against the same validation set risks overfitting to the eval. DataCamp and VentureBeat both flag validation-set "spoiling"; use held-out or rotating evals for long runs.
- **Detect seed manipulation.** If the locked evaluator controls the random seed, the agent cannot game it. If the agent controls the seed, it will eventually try.
- **Keep an experiment memory.** Piana's ideas backlog and Cabral's agent-amnesia warning both point to the same safeguard: log what was tried, why it failed, and what not to repeat.

## Stopping & Plateau Signals

- **Consecutive non-improvement can be a stop rule.** Langfuse used 5 consecutive non-improving experiments as a stopping criterion.
- **Zero-improvement rounds can be useful.** Hoberman's second round ran 16 iterations with no improvements and still delivered a clear finding: the component had little headroom under the frozen ranking setup.
- **Late-session micro-adjustments signal exhaustion.** paddo observed random seed changes and micro-tweaks after ideas ran out; DataCamp describes the ratchet's creativity ceiling. Consider stopping, rotating eval sets, or asking for a human/meta-agent nudge.
- **High revert rates are normal near the ceiling.** Hoberman kept 3 of 44 experiments, a 93% revert rate. That is not automatically waste; it can mean the loop is mapping the ceiling. It becomes waste when proposal quality is poor or eval cycles are expensive.

## Cost of Measurement

- **Proposal quality dominates total cost when eval is expensive.** Cerebras found GPT-5.4 accepted 67% of proposals while Codex-Spark accepted 17%. Spark was faster per proposal but wasted 2 hours of GPU on rejected experiments versus 20 minutes for GPT-5.4.
- **Cache to cut per-iteration cost.** Hoberman's eval caching gave a 12x speedup, from 6 minutes to 30 seconds.
- **Typical API costs.** PatentLLM cites about $0.05-0.20 per experiment for the original Claude API setup; Saladi gives about $0.10 per cycle for skill/prompt loops, about $5 for 50 rounds and $10-25 for 100 rounds. Running locally with ollama can eliminate API costs if you own the hardware.
- **Budget for long runs.** A single overnight run is usually manageable. Multi-day runs need explicit max experiment counts, spend caps, and stop rules.
- **Track wasted eval minutes.** For each proposer/model tier, record accepted proposal rate and rejected-eval minutes. Pick by total loop cost, not by response latency alone.
