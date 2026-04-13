# Measurement Guide

Writing a good `measure.sh` is the most important thing you'll do with AutoAuto. The measurement script is what the entire loop optimizes against — get it right and the agent will find real improvements; get it wrong and you'll get noise or gaming.

AutoAuto's Setup Agent generates `measure.sh` for you, but understanding the principles helps you validate what it produces and debug when things don't work.

## The output contract

Your `measure.sh` must output a **single JSON object** to stdout:

```json
{
  "lcp_ms": 1230,
  "cls": 0.05,
  "tbt_ms": 180
}
```

Rules:
- stdout must contain valid JSON and nothing else (stderr is ignored)
- The primary metric field must exist and be a finite number
- All quality gate fields must exist and be finite numbers
- Nonzero exit code = crash (experiment discarded)
- Invalid JSON or missing fields = measurement failure

## Choosing your metric

### One number, one direction

The metric must be a single unambiguous number that goes in one direction: lower is better (latency, bundle size, error rate) or higher is better (throughput, accuracy, pass rate). If you can't express your goal as a single number, simplify until you can.

Subjective goals like "readability" or "warmth" don't work as direct metrics. Convert them to binary pass/fail criteria (see below).

### Fast feedback

The best targets produce signal in seconds or minutes. If your measurement takes hours (SEO traffic, email reply rates), the rapid iteration advantage is lost. For slow metrics, consider proxy metrics that correlate with the real target — e.g., Lighthouse scores instead of real user LCP data.

### Cheap failure

The cost of a bad experiment should be near zero. Prefer local, synthetic, or staging measurements. If you must use live traffic, cap the blast radius with rate limits and rollback triggers.

### Measure the real objective

Optimizing the convenient proxy instead of the real goal is the most common mistake. Training accuracy leads to memorization instead of generalization. CTR leads to cheap clicks instead of conversions. Ask: "If this metric improves but nothing else changes, would I be happy?"

## Binary vs. numeric scoring

For **objective domains** (performance, test pass/fail, ML metrics), use direct numeric metrics — latency, throughput, accuracy, pass rate.

For **subjective domains** (prompts, copy, templates, skills), use **binary criteria**. Instead of "rate persuasiveness 1-7" (which agents trivially game), use 3-6 yes/no questions:

```
1. Includes a specific call to action: yes/no
2. Stays under 150 words: yes/no
3. No banned buzzwords (synergy, leverage, etc.): yes/no
4. A stranger could understand the offer: yes/no
```

The composite score is the pass rate across criteria. Binary criteria are harder to game than sliding scales because there's less ambiguity to exploit.

**Sweet spot: 3-6 criteria.** Below 3 leaves loopholes. Above 6 leads to checklist gaming.

### Example templates

**For prompt/skill optimization:**
1. Steps are actionable (not vague advice)
2. Formatting is correct (headers, lists, code blocks)
3. Edge cases are handled
4. Content is complete (covers the task end-to-end)
5. A new user could follow without extra context

**For system prompts:**
1. Output matches the required structure
2. No hallucinated facts or links
3. Response stays within length constraints
4. Instructions are specific (not generic filler)
5. Tone is consistent throughout

## Quality gates

Quality gates are secondary metrics with hard thresholds. They prevent the agent from improving one thing by breaking another.

```json
{
  "metric_field": "lcp_ms",
  "direction": "lower",
  "quality_gates": {
    "cls": { "max": 0.1 },
    "tbt_ms": { "max": 300 }
  }
}
```

An experiment that improves LCP but pushes CLS above 0.1 is discarded. Quality gates are checked on every experiment — they're non-negotiable.

Use quality gates for anything that must not regress: test pass rate while optimizing speed, bundle size while optimizing performance, safety checks while optimizing throughput.

## Variance and noise

A "3% improvement" is meaningless if your measurement varies by 5% between runs. AutoAuto handles this in several ways:

**During setup:** The Setup Agent runs your measurement script multiple times on unchanged code, computes the coefficient of variation (CV%), and recommends a noise threshold and repeat count:

| CV% | Assessment | Action |
|-----|-----------|--------|
| <5% | Excellent | Low noise threshold, few repeats |
| 5-15% | Acceptable | Moderate noise threshold, 3-5 repeats |
| 15-30% | Noisy | Higher threshold, more repeats, investigate causes |
| 30%+ | Unstable | Fix the measurement before proceeding |

**During execution:** Each experiment is measured N times (configurable `repeats`), and AutoAuto uses the median. This filters outliers.

**Statistical significance.** With 2+ repeats, AutoAuto runs a Mann-Whitney U test (non-parametric, no normality assumption) on the raw baseline and experiment samples. The p-value is shown in the results table alongside each experiment's status.

The p-value can override the noise threshold in both directions: if a change falls within the threshold but Mann-Whitney shows the difference is statistically significant (p < 0.05), the experiment is kept (if improved) or discarded as regressed (if worsened). This prevents discarding small-but-real improvements that the threshold would otherwise filter out.

Minimum achievable p-value depends on your repeat count: 0.1 at 3 repeats, ~0.029 at 4 repeats, ~0.008 at 5 repeats. With 3 repeats, the p-value override can never trigger (minimum p=0.10 > 0.05), so you need **4+ repeats** for statistical significance to influence decisions. Use 5+ repeats for strong statistical power. When the p-value hits the floor for the sample size, it's displayed as `p≤0.10` instead of `p=0.10` to indicate this is the strongest possible signal, not a weak one.

**Common causes of high variance:**
- Cold starts (add warm-up runs)
- Background processes (close other apps, use a dedicated machine)
- Nondeterministic APIs (cache responses or mock them)
- Insufficient sample size (increase the workload in measure.sh)
- Flaky infrastructure (fix the flakiness first)

## Common pitfalls

### Cache bugs

If your system has a caching layer, make sure cache keys include **everything that changes between experiments**. A real production case: Redis cache was keyed on `hash(query)` but not `hash(query + prompt)`. Early prompt optimization showed fake improvements from stale cached results.

The Setup Agent should detect caching layers and generate cache-busting logic, but verify this yourself.

### Seed manipulation

If your measurement involves randomness, lock the random seed in `measure.sh`, not in the code the agent can edit. If the seed is a variable in editable code, the agent will eventually find it and change it for a tiny metric gain that isn't a real improvement.

### AI-judging-AI circularity

When an LLM evaluates LLM-generated output, the generator can learn to exploit the evaluator's biases. Treat AI-evaluated scores as pre-filters, not ground truth. Where possible, close the loop with real metrics (click rates, conversion, user feedback).

### Harness gaps

Agents optimize for what's measured. If your test harness doesn't exercise a feature, the agent may remove it to improve scores. Make sure your measurement covers real-world usage paths, not just happy paths. Include negative test cases: "must still support X."

### Slow feedback loops

If each experiment takes more than ~10 minutes to measure, you'll get far fewer experiments per session. Consider:
- Caching expensive fixed inputs (embeddings, API calls)
- Using a representative subset instead of the full benchmark
- Measuring a proxy metric that correlates with the real one

## Measurement file structure

The complete measurement config in `config.json`:

```json
{
  "metric_field": "lcp_ms",
  "direction": "lower",
  "noise_threshold": 0.02,
  "repeats": 3,
  "quality_gates": {
    "cls": { "max": 0.1 },
    "tbt_ms": { "max": 300 }
  },
  "secondary_metrics": {
    "fcp_ms": { "direction": "lower" }
  },
  "max_consecutive_discards": 10,
  "max_cost_usd": 20
}
```

**Secondary metrics** are tracked alongside quality gates but without hard thresholds — they appear in context packets so the agent can see them, but they don't cause discards.

**max_consecutive_discards** controls when AutoAuto auto-stops if the agent is stuck (default: 10).

**max_cost_usd** sets a budget cap — the run stops when cumulative agent cost exceeds this amount. Optional; when omitted, cost is tracked but unlimited. Can also be set or overridden per-run in the PreRun screen.
