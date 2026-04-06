# Exploring Andrej Karpathy's Autoresearch: AI Agents Driving Autonomous ML Experimentation

*Source: [Ken Huang's Substack](https://kenhuangus.substack.com/p/exploring-andrej-karpathys-autoresearch)*

## Project Overview

Andrej Karpathy recently unveiled "autoresearch," a system demonstrating how AI agents can independently conduct machine learning research. Built on a streamlined version of nanochat, the framework condenses roughly 630 lines of code into a single-GPU setup.

The core workflow is straightforward: humans refine high-level instructions in a Markdown file (program.md), while an external LLM agent—such as Claude or Codex—autonomously modifies the training script (train.py) to test improvements. "Each dot in the accompanying visualization represents a complete LLM training run, with the agent accumulating commits as it discovers better configurations."

The objective involves achieving the lowest possible validation bits per byte (val_bpb) within fixed 5-minute training windows, simulating rapid iteration cycles. This transforms ML experimentation into an autonomous loop where the AI proposes modifications, executes tests, evaluates outcomes, and commits successful changes via Git.

## Technical Implementation

Autoresearch employs PyTorch to train a simplified GPT-like model on datasets like TinyShakespeare or TinyStories. The system separates fixed and editable components:

**Fixed Components**: prepare.py manages data preprocessing, dataset downloading, and BPE tokenizer training with a default vocabulary of 8192. It provides dataloaders and evaluation tools while remaining unmodified by the agent.

**Editable Core**: train.py serves as the agent's workspace, defining the GPT architecture, optimizer configuration, and training loop. Key adjustable parameters include:

- DEPTH: Model layers (default 8, reducible to 4)
- vocab_size: Adjustable to 256 for byte-level fallback
- MAX_SEQ_LEN: Sequence length, often reduced for constrained hardware
- DEVICE_BATCH_SIZE and TOTAL_BATCH_SIZE: Power-of-2 values (e.g., 16K tokens for smaller GPUs)
- WINDOW_PATTERN: Attention mechanisms ("SSSL" default or simplified "L")
- Optimizer settings: Learning rates, warmup steps, and cooldowns

The project runs on single NVIDIA GPUs like the H100 and encourages community adaptations for lower-end hardware.
