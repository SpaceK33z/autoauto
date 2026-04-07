# Karpathy's Autoresearch GitHub Explained: How 630 Lines of Code Does ML Research Overnight

**Source:** https://datasciencedojo.com/blog/karpathy-autoresearch-explained/
**Author:** Data Science Dojo Staff
**Date:** March 13, 2026

## Overview

Karpathy's autoresearch project automates the ML research cycle by delegating repetitive experimentation tasks to an AI agent. The GitHub repository garnered 26,000 stars within a week. Notably, Karpathy discovered a bug in his own nanochat codebase that had gone undetected for months—found by the agent running systematic experiments.

## Key Results

**Karpathy's Run:** ~700 experiments over two days, 11% speedup (2.02 → 1.80 hours), 20 genuine improvements including a missing scalar multiplier in QK-Norm.

**Shopify CEO Tobi Lütke's Run:** Overnight session produced a 0.8B parameter model scoring 19% higher than a manually-tuned 1.6B baseline.

## How It Works

Three core files:
- **prepare.py:** Locked after initialization; handles data processing and evaluation metrics
- **train.py:** The only file the agent modifies
- **program.md:** Human-written research instructions in Markdown

The experimental loop:
1. Agent reads context from both files
2. Forms and implements a hypothesis by editing `train.py`
3. Executes a 5-minute training session
4. Extracts validation score and memory metrics
5. Commits improvements or reverts failures via git
6. Handles errors with targeted debugging attempts
7. Repeats continuously

## Significance

**Startups:** Overnight GPU time becomes an equalizer, enabling small teams to run systematic experiments without large research staff.

**Founders with domain-specific models:** The agent discovers optimal configurations for their particular hardware and data.

**Research teams:** Removes execution bottlenecks for short training runs, freeing human researchers for deeper analytical work.

The shift toward smaller, specialized models (SLMs) makes this particularly relevant, as such models benefit significantly from task-specific optimization.
