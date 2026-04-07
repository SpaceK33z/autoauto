# Autoresearch: The Loop That Improves Your Work While You Sleep

**Source:** https://thecreatorsai.com/p/autoresearch-the-loop-that-improves
**Author:** Creators AI
**Date:** March 18, 2026

## Overview

Karpathy's autoresearch framework gained massive traction: 8.6 million views in two days, over 42,000 GitHub stars. A 630-line open-source script implementing systematic continuous improvement through automated experimentation.

## How the System Works

1. **Define objectives in plain language** — specify what to improve and acceptable boundaries
2. **Make one isolated modification** — the system alters a single file or parameter
3. **Run a standardized 5-minute test** — ensures fair comparison across all experiments
4. **Evaluate a single metric** — determine if performance improved
5. **Automatically keep or discard changes** — no human review required
6. **Immediately iterate** — loop repeats 8-12 times hourly
7. **Review results** — examine overnight findings showing 60-100 completed trials

## Key Results

In Karpathy's original implementation with nanochat:
- ~700 experiments over two days
- ~20 beneficial modifications
- 11% improvement on a competitive benchmark
- Training time: 2.02 → 1.80 hours

## Core Principle

"Try something → measure it → keep it or undo it → repeat." What distinguishes this approach is enabling machines to execute this loop dozens of times autonomously while humans sleep, eliminating fatigue and cognitive bias.

## Broader Applications

The methodology extends beyond ML to any measurable domain: email response rates, page rendering speed, conversion optimization, retrieval accuracy, or similar performance metrics.
