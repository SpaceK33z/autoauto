# What is Karpathy's Autoresearch and how does it work?

*Source: [SoftmaxData](https://softmaxdata.com/blog/autoresearch/)*

## Overview

Andrej Karpathy's autoresearch is an open-source project that transforms an AI coding agent into an autonomous machine learning researcher. Released in early March 2026, the repository quickly accumulated over 61,000 GitHub stars by demonstrating that AI agents could conduct meaningful experiments autonomously overnight with minimal human supervision.

## Core Architecture

The system consists of three essential files:

**prepare.py** — A read-only file handling one-time setup tasks: downloading training data, training a BPE tokenizer, and providing utilities like the dataloader and evaluation function. The evaluation metric (validation bits per byte, or val_bpb) is locked to prevent gaming the benchmark.

**train.py** — The primary target for agent modifications. It contains the GPT model definition, optimizer choices (Muon + AdamW), and the complete training loop. The agent can freely modify architecture, hyperparameters, batch size, model depth, and any other training parameters.

**program.md** — Instructions written in plain Markdown that program the agent's behavior. Rather than modifying Python directly, users craft natural language documents that guide the agent's experimental approach and decision-making logic.

## How the Experimental Loop Works

The agent enters an infinite cycle:

1. Reads program.md for context and instructions
2. Examines train.py and git history to understand prior attempts
3. Formulates a hypothesis (learning rate adjustment, architectural change, etc.)
4. Edits train.py and commits the change to a git branch
5. Runs training for exactly 5 minutes of wall-clock time
6. Evaluates results against val_bpb metric
7. Keeps improvements; reverts failures via git reset
8. Loops indefinitely without human permission requests

The fixed 5-minute time budget ensures experiments remain directly comparable regardless of architectural choices. An overnight run typically produces approximately 100 experiments, accumulating more empirical data than many human researchers generate weekly.

## Key Design Principles

**Unambiguous Objectives** — Val_bpb provides a single, clear metric where lower values indicate success. No subjective evaluation exists.

**Fast Iteration Cycles** — Five-minute experiments enable rapid feedback and signal accumulation.

**Tight Scope Constraint** — Limiting agent modifications to one file prevents scope creep and metric gaming while paradoxically encouraging creative solutions.

**Perfect Memory via Git** — Every experiment becomes a commit, providing complete rollback capability without requiring external memory systems.

**Well-Crafted Instructions** — The program.md file represents masterclass prompt engineering, anticipating ambiguities and providing explicit guidance on edge cases and decision criteria.

## The Orchestration Philosophy

Autoresearch diverges fundamentally from traditional agentic frameworks like LangGraph or CrewAI. Rather than implementing orchestration through Python state machines and directed graphs, the entire coordination logic lives in a Markdown document. The agent's context window functions as the state machine; natural language instructions replace explicit tool schemas.

This represents what Karpathy terms "Software 3.0"—where shipped artifacts are natural language documents orchestrating AI behavior rather than traditional code.

## What Autoresearch Is Not

**Not Scientific Discovery** — The agent applies training-time ML knowledge within a constrained search space, functioning more like intelligent hyperparameter tuning than genuine scientific insight.

**Not General-Purpose** — The pattern operates specifically on single-GPU language model training. While transferable to other domains like A/B testing or trading strategy backtesting, the repository itself has limited scope.

**Not Distributed at Scale** — The design deliberately emphasizes single-GPU, single-agent operation with no multi-node training or parallel experiment execution.

**Not a Human Replacement** — The agent excels at grinding parameter spaces and maintaining experimental discipline but lacks human intuition about problem framing and conceptual paradigm shifts.

## When the Pattern Fails

The autoresearch approach breaks down when:

- Objective functions become ambiguous or multi-dimensional
- Search spaces exceed practical exploration limits
- Individual experiments demand hours rather than minutes
- Tasks require simultaneous modifications across multiple files or systems
- Accumulated experiment history exceeds the agent's context window capacity

## Broader Implications

The project demonstrates a fundamental skill shift: the bottleneck transitions from "can the agent execute this task?" to "can you write compelling program.md instructions?" Intellectual work increasingly involves crafting natural language documents that guide autonomous agent behavior rather than writing traditional code.

Karpathy's vision suggests future research will employ autonomous swarms conducting iterative experiments across distributed compute infrastructure, with natural language specifications replacing traditional software engineering as the primary craft.
