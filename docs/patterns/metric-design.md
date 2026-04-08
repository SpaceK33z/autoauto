# Metric Design Patterns

Research-backed patterns for designing metrics, scoring approaches, variance handling, and gaming defenses. Extracted from 30+ real-world autoresearch implementations.

For the practical guide to writing `measure.sh`, see the [Measurement Guide](../measurement-guide.md). This document covers the deeper "why" behind metric design decisions.

## Choosing what to measure

- **Single unambiguous number.** One direction: lower is better or higher is better. Subjective goals cause chaos. If you can't explain how to score it in one sentence, rewrite it.
- **Measure the real objective, not the convenient proxy.** Training accuracy leads to memorization (use validation loss). CTR alone attracts cheap clicks (use CPA or revenue per visitor).
- **Fast feedback.** Best targets produce signal in seconds or minutes. Slow metrics (cold email replies, SEO traffic) become batched business experiments, not rapid loops.
- **Cheap failure.** Cost of a bad iteration should be near zero. Prefer local, synthetic, staging, benchmark, or backtest measurements.
- **Invariant to irrelevant changes.** Good metrics survive structural changes that aren't supposed to affect comparability. `val_bpb` works because validation bits per byte is independent of vocabulary size.
- **Attributable.** Each movement must be attributable to the changed variant. One change per experiment.
- **Constrained editable surface.** The metric is only interpretable if the agent has a bounded place to act — one file or one clearly scoped component.

## Binary vs. numeric scoring

- **Use binary criteria for subjective domains.** 3-6 yes/no questions. Composite score = pass rate.
- **Sliding scales invite gaming.** Agents find edge cases that inflate 1-7 scores without real improvement.
- **3-6 criteria is the sweet spot.** Below 3 creates loopholes. Above 6 leads to checklist gaming.
- **Objective domains use direct metrics.** Latency, throughput, accuracy, AUC, pass/fail.

### Reported results with binary scoring
- Landing-page skill: 41% to 92% in 4 rounds (~$0.10/cycle)
- Marketing copy: 56% to 92% pass rate overnight for ~$15
- Claude Skills: ~$0.10/cycle, 50 rounds overnight for ~$5

## Composite metrics & quality gates

Two patterns for multi-metric evaluation:

- **Weighted combination.** Combine sub-metrics when all are legitimate optimization targets: `(correctness * 0.5) + (completeness * 0.3) + (efficiency * 0.2)`, or `80% Precision@12 + 20% MRR`. Use weights to direct the agent toward the dimension with the most headroom.
- **Primary metric + guardrails.** Optimize one metric while enforcing hard limits on others. This is AutoAuto's quality gate model: `fitness = primary_metric` with gates that cause an immediate discard.

## Variance & noise

- **Repeat noisy measurements.** Run the script N times, use the median. This is baked into AutoAuto.
- **Cache deterministic components.** Hoberman cached API calls for embeddings — eval time dropped from 6 minutes to 30 seconds (12x speedup).
- **Watch for broken caches.** Cache keys must include every input that can change between experiments.
- **Re-baseline periodically.** Long runs drift. Re-measure after keeps and after consecutive discards.
- **Document target hardware.** Performance wins can be hardware-specific. Validate on deployment hardware.
- **Seed sensitivity.** Fix the seed in the locked evaluator. If the agent controls the seed, it will game it.
- **NaN/crash detection.** Treat measurement failures as discards, not as numeric results.
- **Data pipeline quality can outweigh algorithmic improvements.** A BM25 tokenization fix ("sushi." vs. "sushi") yielded more impact than 10 rounds of prompt engineering.

## Measurement stability validation

Before the experiment loop:

1. Run the measurement script several times on unmodified code (5-10 runs for cheap scripts)
2. Compute observed noise: min, max, median, stdev, CV%
3. Flag high-variance measurements and stabilize before optimizing
4. Set the improvement threshold from observed noise — a 2% improvement means nothing if variance is 5%

## Subset-first iteration

When full evaluation is expensive, iterate on a representative subset and validate on the full benchmark only at convergence. Liu et al. ran experiments in minutes on subsets vs. hours on full benchmarks, enabling dozens of hypotheses within days. The final configuration was evaluated on the complete benchmark only after convergence.

**Risk:** The subset must be representative. If it doesn't cover the distribution, improvements may not transfer.

## Sample size & live metrics

- Cold email needs 50+ sends minimum per variant
- Landing pages need 200-500+ visitors per variant per cycle
- Ad loops need full-funnel metrics (CPA, revenue per visitor), not just CTR
- Deploy slowly — one to two variants per nightly cycle with rollback triggers
- AI-evaluated scores are screening, not ground truth

## Harness vs. real-world gaps

The locked evaluator is both the central safeguard and the central blind spot:

- Agents strip what is not measured (features, safety checks, documentation steps)
- Harness optimization is not production improvement (benchmark-specific code unrolling)
- Frozen components create blind spots (optimizing A with B frozen, then B with A frozen, doesn't converge)
- Treat output like a junior engineer's PR — cherry-pick the good, require human review before merging

## Gaming defenses

- **Lock the evaluator.** `chmod 444` on measurement files before the loop.
- **Prefer binary criteria.** Less room for rubric-language gaming.
- **Enforce scope constraints.** Define what's off-limits in `program.md`.
- **Use quality gates.** Primary metric improves but a guardrail fails = discard.
- **Protect validation sets.** Rotate evals for long runs.
- **Detect seed manipulation.** Control the seed in the locked evaluator.
- **Keep an experiment memory.** Log what was tried, why it failed, what not to repeat.

## Stopping & plateau signals

- N consecutive non-improvements can be a stop rule (Langfuse used 5)
- Zero-improvement rounds can still be useful — they map the ceiling
- Late-session micro-adjustments signal exhaustion
- High revert rates are normal near the ceiling (93% in one production case)
- Confirm ceilings with independent runs (4 runs at [0.791, 0.797] F1 proved the ceiling was real)

## Cost of measurement

| Component | Typical Cost |
|-----------|-------------|
| API per experiment | ~$0.05-0.20 (Claude) |
| 50 experiments overnight | ~$5 |
| 100 experiments overnight | ~$10-25 |
| Claude $20/mo tier | ~100 experiments/day capacity |
| Local (ollama) | $0 API cost |

Eval caching can cut per-iteration time dramatically: 6 minutes to 30 seconds (12x) by caching embeddings.

## Empirical benchmarks

### Keep rates

| Source | Domain | Experiments | Kept | Keep Rate |
|--------|--------|-------------|------|-----------|
| Hoberman Round 1 | Search ranking | 44 | 3 | 6.8% |
| Hoberman Round 2 | Search ranking | 16 | 0 | 0% |
| Medium (L.J.) | CIFAR-10 training | 157 | 20 | 13% |
| DataCamp (typical) | ML training | 80-100 | 15-20 | ~18% |

A 5-25% keep rate is normal. High revert rates aren't waste — they're the cost of finding the ceiling.

### Discovery type taxonomy

Bug fixes, architecture changes, and prompt engineering *each individually* exceeded the cumulative contribution of all hyperparameter tuning (Liu et al., ~50 experiments). This is why code-comprehending agents exceed traditional AutoML.

| Discovery Type | Example | Impact |
|---------------|---------|--------|
| Bug fix | Missing `response_format` parameter | +175% F1 |
| Architecture | BM25 hybrid search | +44% F1 |
| Prompt engineering | Constraint positioning | +188% on specific categories |
| Data repair | Timestamp corruption recovery | +7% F1 |
| Hyperparameter tuning | top-k, token budget adjustments | Smallest cumulative impact |

### Transferability

Not all improvements are eval-specific. Karpathy's 11% speedup transferred to larger models. Shopify's 0.8B model outperformed a hand-tuned 1.6B model. Well-constrained autoresearch finds transferable improvements.
