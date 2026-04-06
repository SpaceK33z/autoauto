# Andrej Karpathy Open-Sources 'Autoresearch': A 630-Line Python Tool Letting AI Agents Run Autonomous ML Experiments on Single GPUs

*Source: [Marktechpost](https://www.marktechpost.com/2026/03/08/andrej-karpathy-open-sources-autoresearch-a-630-line-python-tool-letting-ai-agents-run-autonomous-ml-experiments-on-single-gpus/)*

Andrej Karpathy released autoresearch, a minimalist Python tool designed to enable AI agents to autonomously conduct machine learning experiments. The project is a stripped-down version of the nanochat LLM training core, condensed into a single-file repository of approximately ~630 lines of code. It is optimized for execution on a single NVIDIA GPU.

### The Autonomous Iteration Loop

The framework establishes a specific division of labor between the human researcher and the AI agent. The system operates on a continuous feedback loop where progress is tracked via git commits on a feature branch.

| Component | Responsibility | File Format |
| --- | --- | --- |
| Human | Iterates on high-level research instructions and constraints. | `.md`(Markdown) |
| AI Agent | Proposes and implements modifications to the training script. | `.py`(Python) |
| Execution | Conducts a fixed-length training run to evaluate the changes. | Shell/Python |

The agent reads the human-provided instructions, modifies the training code—adjusting neural network architecture, optimizers, or hyperparameters—and executes a training run that lasts exactly five minutes.

### Evaluation Metrics and Validation

To ensure the agent only retains beneficial changes, the system uses bits-per-byte (BPB) as the primary validation metric. BPB measures the compression efficiency of the model on a validation dataset; a lower score indicates a more accurate model.

- Validation Protocol: The agent only commits code changes to the git branch if the final BPB score is lower than the previous best.
- Observed Performance: In initial runs, Karpathy demonstrated the agent successfully reducing validation loss from 1.0 to 0.97 BPB through autonomous code iteration.
- Granularity: Every completed 5-minute training run is represented as a data point, allowing researchers to compare the effectiveness of different prompts or agent configurations over time.

### Case Study: Implementation by Shopify’s Tobi Lutke

Following the release, Shopify CEO Tobi Lutke adapted the`autoresearch` framework for an internal project. By allowing the agent to iterate on a smaller model architecture, Lutke reported a 19% improvement in validation scores. Notably, the agent-optimized smaller model eventually outperformed a larger model that had been configured through standard manual methods.

OK this thing is totally insane. Before going to bed I…* used try to make a new qmdresearcher directory* told my pi to read this github repo and make a version of that for the qmd query-expansion model with the goal of highest quality score and speed. Get training data from… https://t.co/hbCfD62ElJ

> — tobi lutke (@tobi) March 8, 2026

Karpathy noted that the specific code tweaks discovered by the agent were later integrated back into his broader nanochat framework, demonstrating that the tool can discover optimizations applicable to larger-scale production systems.

I packaged up the "autoresearch" project into a new self-contained minimal repo if people would like to play over the weekend. It's basically nanochat LLM training core stripped down to a single-GPU, one file version of ~630 lines of code, then:– the human iterates on the… pic.twitter.com/3tyOq2P9c6

> — Andrej Karpathy (@karpathy) March 7, 2026

### Technical Significance for Devs

For Devs,`autoresearch` represents a shift toward ‘agentic’ workflows in model development. Rather than manually tuning hyperparameters, the engineering task shifts to prompt engineering the agent to navigate the search space more effectively. The ~630-line constraint ensures that the entire codebase fits within the context window of modern LLMs, minimizing errors in code generation and allowing the agent to maintain a ‘holistic’ understanding of the training script.

### Key Takeaways

- Autonomous Research Loop: The framework enables AI agents to autonomously iterate on ML experiments by reading a human-provided Markdown (.md) instruction file and modifying a Python (.py) training script without manual intervention.
- ~630-Line Core: By stripping the nanochat LLM training core down to a single-file, ~630-line repository, the codebase is small enough to fit entirely within an LLM’s context window, reducing code generation errors.
- Efficiency-Driven Metrics: The agent runs fixed 5-minute training sprints on a single NVIDIA GPU and only commits code changes to a git feature branch if they result in a lower bits-per-byte (BPB) validation score.
- Proven Performance Gains: In a real-world test (as mentioned on a tweet), Shopify CEO Tobi Lutke used the tool to achieve a 19% improvement in model scores, resulting in a smaller, agent-optimized model that outperformed a larger, manually configured one.
- Shift in Engineering Focus: The project moves the developer’s role from manual hyperparameter tuning to agent engineering, where the goal is to optimize the prompts that direct the AI to find the most efficient neural architectures and training settings.

---
