# PM's Guide to Karpathy's Autoresearch

- **Author:** Aakash Gupta
- **Published:** 2026-03-20
- **URL:** https://www.news.aakashg.com/p/autoresearch-guide-for-pms
- **Note:** Partially paywalled — detailed sections (6 use cases, setup, toolkit) not available

## Introduction

You've built a skill or prompt that works 70% of the time. You tweak it to reach 80%, then move on due to time constraints.

Andrej Karpathy created a system automating hundreds of iterations overnight. He named it autoresearch, and it has garnered 42,000 GitHub stars. Fortune dubbed it "The Karpathy Loop." When Shopify CEO Tobi Lutke applied it to Shopify's templating engine, he achieved 53% faster rendering through 93 autonomous commits.

Most people dismiss autoresearch as an ML researcher's tool. However, the underlying pattern applies broadly: it works on anything you can measure numerically.

## What Autoresearch Actually Does

Karpathy, an ML researcher, faced the traditional research bottleneck: modify training code, execute experiments, wait for results, assess improvement, decide whether to retain changes, then repeat. A productive day might yield 8-10 iterations.

His system automates this entire cycle using three essential files:

1. **train.py** — the training script and sole file the agent may modify
2. **prepare.py** — the evaluation harness that scores results; the agent cannot alter this
3. **program.md** — instruction guidance for agent behavior, experimentation strategy, and decision criteria

The loop functions as follows: the agent reads code, hypothesizes improvements, modifies train.py, runs a brief training experiment, and checks the metric. Successful improvements are committed to git and become the new baseline. Failed attempts are instantly reverted via git reset.

This pattern yields approximately 12 experiments hourly, or roughly 100 overnight runs.

Karpathy ran the system for two days and discovered 20 improvements on previously hand-tuned code, including an overlooked bug in attention implementation. These 20 stacked improvements yielded an 11% speedup when transferred to larger models.

Shopify applied the same pattern to Liquid, its templating engine. Overnight experiments produced a 0.8B parameter model outperforming hand-tuned 1.6B models — half the parameters with superior results. The subsequent 93 automated commits delivered 53% faster rendering and 61% fewer memory allocations.

## Why This Matters for Product Managers

A landing page skill improved from 41% to 92% in four rounds, with three changes retained and one automatically reverted.

The pattern works because it eliminates a core PM constraint: knowing a prompt could improve, yet never manually running fifty iterations.

Three requirements make this work:

**1. Clear Numerical Metric**
Score output as a number, not subjective judgment. "Is this good?" fails; "Does the headline contain a specific number?" succeeds. Sum yes/no responses across test runs to create a measurable target.

**2. Unattended Evaluation Tool**
Use Claude Code to build evaluation scripts generating outputs, scoring against criteria, and printing results programmatically. No human involvement — the loop runs overnight.

**3. Single Editable File**
The agent modifies only one file per round: your skill markdown, system prompt, or email template. Everything else remains read-only.

All three present equals success. Missing any single element breaks the system.

## Paywalled Sections (not available)

- 3-step setup instructions
- 6 high-value use cases with copy-paste prompts and evaluation criteria
- Experiment log walkthrough
- Downloadable toolkit with skill improver, evaluation templates, and results analyzer
- Karpathy's future research direction

## Key Takeaway

Autoresearch democratizes optimization for any measurable improvement target — whether ML models, code performance, or PM workflows. The pattern requires only numerical scoring capability and autonomous evaluation infrastructure, making it broadly applicable beyond machine learning contexts.
