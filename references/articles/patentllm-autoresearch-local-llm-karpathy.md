# Running Karpathy's autoresearch with Local LLM — Zero API Cost Autonomous AI Research

**Source:** https://media.patentllm.org/blog/ai/autoresearch-local-llm-karpathy
**Author:** soy-tuber
**Date:** March 22, 2026

## Introduction

Andrej Karpathy released an experimental system where "an LLM autonomously modifies a GPT training script, runs 5-minute experiments, keeps what improves val_bpb, and discards what doesn't." A community fork replaces the cloud-based Claude Code with Qwen 3.5 9B running locally through ollama, eliminating API costs while maintaining full autonomy on a single GPU.

## Architecture: LLM + Training on One GPU

The innovation centers on running both the language model agent and GPT training simultaneously on shared hardware:

```
GPU (48GB VRAM)
├── Qwen 3.5 9B via ollama (~12GB)
└── GPT training via train.py (~35GB)
```

Hardware constraints required parameter adjustments from the original design:

| Component | Original | This Fork |
|-----------|----------|-----------|
| Depth | 8 layers | 4 layers |
| Device batch size | 128 | 64 |
| Total batch tokens | 524K | 65K |
| Window pattern | SSSL | L |

## The Autonomous Research Loop

### Step 1: LLM Proposes Modification
The agent sends current training code and experimental history to Qwen 3.5, requesting specific modifications to reduce validation bits-per-byte. Constraints include read-only preparation scripts, no new dependencies, and fixed 5-minute execution budgets.

### Step 2: Syntax Validation + Git Commit
Proposed code undergoes validation using Python's `ast.parse()`. Valid modifications overwrite the training script and are committed to version control.

### Step 3: Run 5-Minute Experiment
Training executes with a 10-minute timeout, typically completing within 5 minutes.

### Step 4: Keep or Discard
- **Improved results** → branch advances
- **No improvement or regression** → discarded via git reset
- **Crashes** → logged for LLM remediation
- **Three consecutive failures** → failsafe returns to baseline

## agent.py Design

The agent implementation spans approximately 250 lines:

- Ollama API integration via simple HTTP requests
- Git operations (commit, reset, revision checking)
- Experiment execution and log analysis
- Results logged to TSV format
- Code extraction from model responses

The code extraction uses regex to identify Python blocks, validates syntax, and only executes valid modifications:

```python
def extract_code_from_response(response):
    blocks = re.findall(r"```(?:python)?\s*\n(.*?)\n```", response, re.DOTALL)
    if blocks:
        return max(blocks, key=len)  # Take the longest code block
```

## Cost Comparison

| Setup | Cost per experiment | 100 experiments |
|-------|-------------------|-----------------|
| Original (Claude Code API) | ~$0.05-0.20 | $5-20 |
| Fork (Nosana Pro 6000) | $0.08 | ~$8 |
| Fork (own GPU) | $0 | $0 |

## program.md — The Research Philosophy

The original framework emphasizes:

- **Continuous execution** — "NEVER STOP" represents indefinite operation until manual intervention
- **Code elegance** — Minimal improvements requiring excessive complexity warrant rejection; simplifications with equivalent results merit retention
- **Asynchronous research** — At 12 experiments per hour, approximately 100 experiments complete during typical sleep periods

## Why Local LLM Matters

This implementation demonstrates that smaller models can sustain autonomous research workflows without cloud infrastructure dependency, API rate limitations, or ongoing expenses. A 24GB+ GPU enables infinite experimental cycles.

## Setup

```bash
# Install ollama and pull the model
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull qwen3.5:9b

# Clone and setup
git clone https://github.com/SohniSwatantra/autoresearch-local-llm.git
cd autoresearch-local-llm
pip install uv && uv sync

# Run
bash run_pipeline.sh
```

Minimum requirements: 24GB VRAM (48GB recommended)

## References

- Fork: [SohniSwatantra/autoresearch-local-llm](https://github.com/SohniSwatantra/autoresearch-local-llm)
- Original: [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
