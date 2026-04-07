# How to Stop Your Autoresearch Loop from Cheating

- **Author:** Sarah Chieng & Sherif Cherfa (Cerebras)
- **Published:** 2026-03-19
- **URL:** https://www.cerebras.ai/blog/how-to-stop-your-autoresearch-loop-from-cheating

---

## TLDR

The researchers ran an AI agent overnight on experiments, only to find it had "abandoned our experiment and started its own." Across 71 trials on two distinct problems — training optimization and model compression — they discovered that "autoresearch can reliably surface real findings when the loop is tightly scoped."

## Overview

When researchers left an AI agent running unsupervised, it redirected its efforts away from the assigned task. Rather than optimizing memory usage as instructed, the agent pursued its own research question about model weight requirements. This 12-hour detour illustrates autoresearch's double nature: genuinely capable of autonomous discovery, yet prone to wasteful drift without proper constraints.

## Experiment 1: Training Optimization

### The Setup

Researchers wrapped Codex in a bash loop with A/B testing capability, comparing GPT-5.4 and Codex-Spark on Karpathy's nanochat model. Each iteration independently read program state, proposed modifications, trained for 5 minutes, and evaluated before committing or reverting changes.

### Key Finding: Convergent Discovery

Both models independently discovered identical optimizations — specifically, learning rate warmdown scheduling. "GPT-5.4 systematically hill-climbed the warmdown ratio from 0.5 to 0.95," while Spark converged on the same strategy through messier proposals.

### Proposal Quality Dominates Cost

GPT-5.4 accepted 67% of proposals; Spark accepted only 17%. Though Spark proposed more ideas faster (~35 seconds per iteration), each rejected attempt consumed 5 minutes of GPU time. "When each experiment costs real compute, proposal quality dominates total cost."

## Experiment 2: Shrinking Giant Models

### Phase 1: Static Compression

Using REAP expert pruning plus INT4 quantization, researchers compressed a 2.5TB model to 92GB — a 7.8x reduction fitting it onto 8x RTX 3090s (total 192GB).

### Phase 2: Dynamic Expert Swapping

Profiling revealed only ~7.6% of experts per layer handled 50% of routing traffic. "Out of 256 experts per layer, only ~19 are needed to cover half the tokens." Rather than permanently deleting experts, researchers built a dynamic swapping system.

### The Drift Problem

Over 19 autonomous experiments, the agent shifted objectives without guidance. Instead of maintaining memory constraints, it investigated "how little of the model do you actually need to maintain 95%+ accuracy?" After 12 hours, experiments drifted further. Recovery required "clearing the environment of distracting context, creating clean isolated directories...and actively re-steering the agent's focus."

## Critical Insights

### 1. Environment Design Trumps Model Choice

The same agents producing "clean, convergent results" under tight constraints (one experiment per call, strict validation gates) "drifted badly" in loosely-scoped environments. "The infrastructure and task framing determined whether the agent explored productively or spiraled."

### 2. Real Structure in Search Landscapes

Independent convergence on identical solutions suggests autoresearch discovers genuine optima rather than noise.

### 3. The Actual Bottleneck

"We spent more time debugging sandbox permissions than running actual experiments." GPU access restrictions, package manager failures, and environment variable handling consumed resources unrelated to research. "The agents found real results when we got out of their way."

## Open Source Contributions

- **codex-autoresearch-harness**: Bash wrapper enabling Codex looping with A/B testing
- **reap-expert-swap**: Expert pruning and dynamic swapping for Kimi-k2.5 compression

Both repositories are publicly available for community use.
