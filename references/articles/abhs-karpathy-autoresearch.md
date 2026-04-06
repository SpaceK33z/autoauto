# Andrej Karpathy's 630-Line Python Script That Does AI Research Itself

*Source: [Abhs](https://www.abhs.in/blog/andrej-karpathy-autoresearch-autonomous-ai-ml-experiments-2026)*

*Abhishek Gautam, March 9, 2026, 7 min read*

**Quick summary**

Karpathy released AutoResearch: 630 lines of Python where AI agents design, run, and interpret ML experiments with no human in the loop.

Read next

- What is OpenClaw (Clawdbot)? The AI Assistant the Internet Cannot Stop Talking About
- Alibaba's Qwen 3.5 Speaks 201 Languages. For Developers Outside the US, That Is a Bigger Deal Than Any Benchmark.

More on AI →

Andrej Karpathy does not waste words. The former Tesla AI head, OpenAI founding member, and creator of nanoGPT, makemore, and llm.c posted a single sentence alongside his new release: "The goal is to engineer your agents to make faster research progress indefinitely and without any of your own involvement."

The tool is called AutoResearch. It is 630 lines of Python. It runs on a single GPU. And it is designed to do something that has been a goal of AI labs since the field began: conduct machine learning research autonomously.

## What Is AutoResearch?

AutoResearch is an agentic research framework where an AI agent — powered by an LLM — takes a research question, designs experiments to investigate it, writes the code to run those experiments, executes them on a GPU, analyses the results, forms conclusions, and then designs follow-up experiments based on what it found. The loop continues until a stopping condition is met or the agent determines it has answered the question.

The key components in Karpathy's implementation:

| Component | What it does |
| --- | --- |
| Research planner | LLM generates a hypothesis and experimental design |
| Code generator | Writes Python/PyTorch code for the experiment |
| Execution engine | Runs the experiment on GPU, captures stdout/stderr/metrics |
| Result analyser | LLM reads outputs, interprets results, updates hypothesis |
| Loop controller | Decides whether to run follow-up experiments or terminate |
| Report generator | Summarises findings in readable form |

The entire system is 630 lines. No custom frameworks, no complex orchestration libraries — just Python, an LLM API call, and a GPU. Karpathy's philosophy of minimal dependencies runs through everything he builds.

## Why Karpathy's Work Gets Noticed

Karpathy is not a random developer releasing a research tool. His background matters for understanding why AutoResearch is significant:

He was a founding member of OpenAI and led AI research before leaving to run Tesla's Autopilot AI programme for five years. At Tesla, he built one of the most demanding real-world AI deployment pipelines on earth. After leaving Tesla in 2022, he returned to OpenAI briefly, then went independent — releasing a series of educational and research tools that have become widely used in the ML community.

His nanoGPT (a minimal GPT implementation in ~300 lines) became the most widely read tutorial code for understanding transformers. His llm.c project showed how to train GPT-2 in pure C with no Python dependency. The pattern is consistent: take a complex AI concept, strip it to its minimum viable implementation, and publish it openly. AutoResearch follows the same philosophy applied to autonomous research agents.

When Karpathy says the goal is research progress "without any of your own involvement," he means it technically. The system is designed to run overnight or over a weekend and return a research report.

## How Autonomous ML Research Actually Works

The hardest part of building an autonomous research agent is not the LLM prompting — it is the execution environment. ML experiments fail in dozens of ways that are not model failures:

- CUDA out of memory errors
- Shape mismatches in tensor operations
- NaN losses from bad learning rates
- Infinite training loops
- Dependency version conflicts

AutoResearch handles these through an execution harness that catches errors, feeds them back to the LLM as context ("the experiment failed with this error: ..."), and asks the LLM to revise the code. This retry loop is the engineering insight that makes the system usable rather than theoretical.

The research loop looks like this:

1. Receive research question ("Does batch norm help in this architecture?")

2. Generate experiment design (2 variants: with and without BN)

3. Write training code for both variants

4. Execute on GPU, capture metrics (loss curves, final accuracy)

5. LLM analyses results: "BatchNorm improved convergence speed by 23% but final accuracy was equivalent"

6. Generate follow-up: "Test with different learning rates to isolate the effect"

7. Repeat until stopping condition

8. Write final report

The stopping condition can be a fixed number of iterations, a time budget, a GPU cost budget, or a convergence criterion that the LLM evaluates qualitatively.

## What AutoResearch Can and Cannot Do Right Now

What it does well:

- Ablation studies on small to medium models (fits on a single GPU)
- Hyperparameter sensitivity analysis
- Architecture comparisons on standard benchmarks
- Reproducing and extending existing paper results
- Generating preliminary results to inform larger-scale experiments

What it cannot do:

- Large-scale experiments requiring multi-GPU or multi-node setups
- Novel mathematical derivations (it can test hypotheses but cannot derive new theory)
- Experiments that require custom data collection or real-world interaction
- Research requiring domain expertise that the base LLM lacks (highly specialised fields)
- Replace the intuition of an experienced researcher about which questions are worth asking

The single-GPU constraint is a practical limitation for 2026 frontier model research. Training runs for state-of-the-art language or vision models require clusters. AutoResearch is well-suited for research on smaller models, efficiency techniques, architecture choices in constrained settings, and reproducing findings at reduced scale.

## The Bigger Picture: AI Doing AI Research

AutoResearch is a concrete implementation of a concept that AI safety researchers have discussed for years: AI systems that accelerate their own development. If an AI agent can run ML experiments faster and more cheaply than a human researcher, and can do so 24 hours a day, the rate of AI research progress could increase substantially.

This is not hypothetical. The economics are straightforward: a researcher who can delegate exploratory experiments to an agent can focus their time on higher-level hypothesis generation and experimental design. A single researcher with AutoResearch running overnight could cover the ground that previously required a small team running manual experiments.

At scale — multiple agents, multiple GPUs, running in parallel across a research organisation — the acceleration becomes significant. Anthropic, DeepMind, OpenAI, and Google all have internal automated experiment infrastructure that does similar things at much larger scale. Karpathy's contribution is making a functional version of this available to individual researchers and small teams with a single GPU.

## How to Use AutoResearch

AutoResearch is open source on Karpathy's GitHub. Requirements:

- Python 3.10+
- PyTorch with CUDA
- Any LLM API (OpenAI, Anthropic Claude, or a local model via Ollama)
- A single GPU (NVIDIA recommended; 8GB+ VRAM for most experiments)

Basic usage (Python):

from autoresearch import AutoResearch

agent = AutoResearch(

llm="claude-opus-4-6",

gpu_budget_hours=4,

max_iterations=10

)

report = agent.run(

question="Does residual connection placement affect training stability in small transformers?",

dataset="wikitext-103-small"

)

print(report.summary)

The LLM choice matters significantly. Karpathy's testing used Claude Opus 4.6 and GPT-5 for the planning and analysis steps. Smaller or local models work but produce lower-quality experimental designs and analyses.

## What This Means for Indian ML Researchers

India has a large and growing ML research community — IIT, IISc, TIFR, CMI, and a wave of AI research labs within Indian tech companies. The historical constraint for Indian academic researchers has been compute: access to multi-GPU clusters is expensive and often limited through institutional allocations.

AutoResearch changes the calculus for exploratory research. A researcher with a single RTX 4090 (available for under ₹1,50,000 in India) can now run overnight research campaigns that would have required booking cluster time or running manual experiments across weeks. The LLM API cost per experiment is a few rupees at Claude or GPT-5 pricing.

For MSc and PhD students doing ML research, AutoResearch is potentially the most significant productivity tool released this year.

## Key Takeaways

- Karpathy released AutoResearch: 630 lines of Python, single GPU, fully autonomous ML experiment loop
- The system designs experiments, writes code, runs them, analyses results, and iterates without human involvement
- Key engineering: error-handling retry loop that feeds GPU errors back to the LLM for code revision
- Best suited for ablation studies, architecture comparisons, hyperparameter sensitivity on small-to-medium models
- Cannot replace researcher intuition for hypothesis generation or large-scale frontier experiments
- Open source, works with Claude, GPT-5, or local LLMs via Ollama
- For Indian ML researchers: a single GPU + AutoResearch now covers exploratory research that previously required cluster access
- Jensen Huang later gifted Karpathy the first NVIDIA DGX Station GB300— 748GB unified memory — specifically to run AutoResearch-style agent loops at frontier scale
