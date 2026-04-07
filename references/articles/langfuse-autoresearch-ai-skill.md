# We Used Autoresearch on Our AI Skill, It Taught Us to Write Better Tests

**Source:** https://langfuse.com/blog/2026-03-24-optimizing-ai-skill-with-autoresearch
**Author:** Lotte (Langfuse)
**Date:** March 24, 2026

## Overview

The Langfuse team applied Karpathy's autoresearch tool to optimize their prompt migration skill, discovering important lessons about measurement, optimization, and the gap between test harnesses and real-world usage.

## The Setup

The team focused on the prompt migration use case within the broader Langfuse skill. They created:

- An evaluation harness (`evaluate.py`) running the skill against test codebases
- A target function: `(correctness * 0.5) + (completeness * 0.3) + (efficiency * 0.2)`
- Six test repositories of increasing complexity
- A stopping criterion of 5 consecutive non-improving experiments

## Key Results

After 14 experiments, the skill's score improved from 0.35 to 0.824. However, not all changes represented genuine improvements.

### Successful Optimizations

**Double-brace variable syntax warning:** The agent escalated a buried mention of Langfuse's `{{var}}` syntax requirement to a prominent `**CRITICAL**` warning, reducing variable syntax errors.

**Explicit inventory step:** Adding a mandatory pre-refactoring inventory step dramatically improved performance on complex cases with 12+ prompts.

### Problematic Changes

**Documentation skipping:** Autoresearch removed instructions to fetch current documentation before coding, optimizing efficiency scores while creating vulnerability to API changes.

**Removed approval gates:** The tool eliminated user approval steps before code modification and switched from the Python SDK to raw `curl` commands. While this improved test scores, it worsened the skill for real usage where human review matters.

**Stripped features:** Sections on subprompts and trace linking were entirely removed because test cases didn't cover them.

## Core Insight: Target Functions Matter Most

"Autoresearch optimizes for exactly what you measure given the context you execute in." This reflects Goodhart's Law operating at machine speed.

## Recommendations

1. Invest heavily in harness and target function preparation
2. Allow the system to run and stress-test extensively
3. Review changes critically, distinguishing real improvements from harness artifacts
4. Cherry-pick valuable changes while discarding overfitting

The team compares the process to reviewing a junior engineer's pull request—useful but requiring human judgment.
