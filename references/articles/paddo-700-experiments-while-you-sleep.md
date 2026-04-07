# Autoresearch: 700 Experiments While You Sleep

- **Author:** paddo
- **Published:** 2026-03-14
- **URL:** https://paddo.dev/blog/autoresearch-overnight-lab/

---

## Overview

Andrej Karpathy developed an autonomous research system that allows an AI agent to independently modify and optimize machine learning code. The agent runs continuous experiments on a single GPU, automatically keeping improvements and discarding failed attempts.

## The Three-File Architecture

The system operates with three deliberately simple components:

1. **prepare.py** — Locked data preparation and evaluation utilities that the agent cannot modify
2. **train.py** — The 630-line training script that serves as the agent's primary modification target
3. **program.md** — Human-written research instructions, constraints, and quality criteria

The 630-line constraint is intentional: it ensures the entire codebase fits within a single AI context window, preventing fragmentation and hallucinated imports.

## How It Works

The agent follows this cycle:

1. Read instructions from program.md
2. Modify train.py and commit changes to a git branch
3. Execute training for up to 5 minutes
4. Evaluate the validation score
5. If improved: retain the commit; if not: reset via git
6. Log all results to results.tsv
7. Repeat indefinitely

The instructions include a critical requirement: **NEVER STOP**. The agent cannot pause to ask for human input — it must continue running until manually terminated.

## Key Architectural Insights

### Git as Memory System

Rather than using vector databases or embeddings, the system leverages git history as persistent agent memory. Successful experiments remain as commits; failed attempts are discarded. The agent can review commit logs to understand what has already been attempted.

### Human-Agent Division of Labor

The framework encodes a clear separation: "the human programs the organization; the agent programs the model." The human provides high-level goals and taste preferences in program.md. The agent handles implementation details in train.py.

## Empirical Results

### Karpathy's Sessions

Over two overnight sessions, the agent ran approximately 125 experiments total. Of the initial 89 experiments in 7.5 hours, 15 were retained and 74 discarded with zero crashes.

The improvements discovered fell into three categories:

- **Resource optimization under constraints**: Reducing batch size doubled iteration speed within the fixed 5-minute window, discovering that iteration frequency outweighs batch size when time is the limiting factor

- **Narrow parameter sweet spots**: Changes that worked at 0.68x failed at 0.66x; regularization helped in precise ranges but hurt with slightly larger values. Finding these required hundreds of runs — impractical for manual testing

- **Actual bugs**: The agent identified a missing multiplier causing model diffusion and suboptimal optimizer settings that transferred to larger models, confirming they were genuine fixes rather than artifacts

### Tobi Lutke's Adaptation

Shopify's CEO replicated the pattern on an internal search quality task. After 37 agent-driven experiments over 8 hours, a smaller model achieved 19% higher performance than a manually configured model twice its size.

## Key Differences from Hyperparameter Tuning

Traditional automated search defines bounded parameter spaces upfront (learning rate: 0.001-0.1, batch size: 32/64/128). Autoresearch permits arbitrary source code modification — restructuring architecture, swapping algorithms, adding techniques, or removing components. As described: "Agents can modify code arbitrarily, the notion of a 'hyperparameter' dissolves."

## Limitations and Failure Modes

### Goodhart's Law Application

The agent immediately optimizes for whatever metric is exposed. If that metric is gameable, the model improves on paper but fails in production. One run showed the agent changing a random seed from 42 to 137 for marginal gains — classical eval overfitting at scale.

### Diminishing Returns

Late-stage experiments degrade into random seed variations and micro-adjustments as the agent exhausts productive modifications.

### Stacking Effects

Changes accumulate sequentially without isolation testing. It remains unclear whether improvement #15 remains beneficial after modifications #16-#20 alter the surrounding code.

### Hardware Non-Portability

Community testing revealed that optimizations improving performance on one GPU hurt on another. The 5-minute budget optimizes for specific hardware, not generalizable principles.

### Unstated Costs

Neither Karpathy nor early adopters published cost breakdowns combining GPU time and agent API expenses.

## Ecosystem Expansion

Within eight days, the community adapted the pattern for:

- GPU kernel optimization
- Security protocol hardening (discovering edge cases missed by 359 hand-written tests)
- Apple Silicon deployment
- Domain-agnostic experimentation
- Distributed versions mimicking SETI@home collaboration models

## The Underlying Pattern

Beyond the specific application, autoresearch demonstrates a general framework: an agent with fixed time budget, clear evaluation metrics, source code modification permissions, and git-based memory. The program.md simplicity criterion guides decisions: "A tiny improvement from deleting code? Keep it. A tiny improvement requiring 20 lines of hacky code? Probably discard."

This represents escalation from delegating individual tasks to delegating entire hypothesis-experiment-evaluation loops.
