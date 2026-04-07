# Karpathy's AutoResearch: How an ML Tool Became a Marketing Optimizer

**Source:** https://monkfrom.earth/blogs/karpathy-autoresearch-explained-ml-to-marketing
**Author:** Sameer Khan
**Date:** April 1, 2026

## What is AutoResearch?

Open-source initiative from Karpathy, released March 7, 2026. ~630 lines of Python, 21,000 GitHub stars. Three foundational elements ("the loop"):

1. **One File** — a solitary editable training script
2. **One Metric** — a single quantitative value (validation bits per byte)
3. **One Time-Boxed Cycle** — each experiment executes for exactly five minutes

~12 iterations per hour, ~100 experiments nightly on single GPU.

## Results

- **Karpathy:** 700 experiments over two days, 20 optimizations, 11% training acceleration
- **Lütke (Shopify):** 37 experiments overnight, 19% performance gains

## Marketing Adaptation

Ole Lehmann directed AutoResearch toward landing page copywriting:
- Editable asset = a prompt (instead of training script)
- Scoring = 3-6 question checklist (instead of ML metrics)
- Result: **56% to 92% pass rate overnight, ~$15 compute cost**

Agent modifications: added headline restrictions, created banned-buzzword registries, embedded worked examples, attempted tighter word counts before reverting when they degraded CTA effectiveness.

Further applications: website speed optimization (1100ms → 67ms), cold outreach templates, newsletter openings.

## Limitations

- Marketing adaptation uses AI-judging-AI — LLM evaluates outputs rather than actual users
- ML generates feedback in 5 minutes; marketing demands human behavior (hours/days)
- "Think of it as a pre-filter, not an A/B test replacement" (Holmberg)

## Applicable Pattern

1. One editable asset
2. One measurable metric
3. A compressed feedback loop

Constraints supersede complexity.
