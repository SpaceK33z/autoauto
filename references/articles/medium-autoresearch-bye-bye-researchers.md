# Andrej Karpathy's AutoResearch: Bye Bye Researchers

*Source: [Medium - Data Science in Your Pocket](https://medium.com/data-science-in-your-pocket/andrej-karpathys-autoresearch-bye-bye-researchers-76319a719630)*

## How to use Andrej Karpathy's autoresearch for free?

AI research has traditionally followed a very human workflow. A researcher writes code, runs an experiment, checks the results, modifies the model, and then repeats the process. This loop can take hours or even days, and progress often depends on how many experiments a human can manually run.

Andrej Karpathy recently introduced an interesting idea through the project karpathy/autoresearch called **AutoResearch**.

The idea is simple but powerful: allow an AI agent to run the research loop automatically. Instead of a human constantly editing training code, the AI agent performs experiments, evaluates the results, and decides what to try next.

In other words, the agent behaves like a junior researcher who continuously modifies the model, tests it, and keeps improvements. You can start the system at night and wake up to a log of experiments that the agent has already completed.

## The Core Idea Behind AutoResearch

The main goal of AutoResearch is to automate the repetitive parts of machine learning experimentation.

Normally, improving a model involves many small changes to architecture, hyperparameters, or training settings. Researchers try these changes one by one and measure their effect on model performance.

> AutoResearch turns this process into an automated loop.

The AI agent edits the training code, runs a short experiment, evaluates the results, and decides whether the change should be kept or discarded. If the model improves, the change becomes part of the new baseline. If it performs worse, the modification is rejected.

Over time, this repeated cycle helps the system explore many potential improvements without human involvement. The agent effectively performs trial-and-error research at machine speed.

**Typical AutoResearch loop:**

- Modify the model or hyperparameters
- Train the model briefly
- Measure validation performance
- Keep or discard the change
- Repeat the process

## How the Repository Is Structured

One of the most interesting aspects of AutoResearch is how minimal the repository is. Instead of having a large codebase with complex configurations, the project is intentionally designed with only a few core files. This simplicity makes it easier for AI agents to understand and modify the system.

The repository mainly revolves around three files. Each file has a specific role in the autonomous research workflow.

- The **prepare.py** file handles one-time setup tasks. It downloads the dataset, trains the tokenizer, and provides runtime utilities such as the dataloader and evaluation functions. This file is intentionally kept fixed so that the agent does not accidentally break the infrastructure.

- The **train.py** file is where all the experimentation happens. It contains the full GPT model, the optimizer configuration, and the training loop. The AI agent is allowed to modify anything inside this file. For example, it may experiment with different architectures, learning rates, batch sizes, or optimizer settings.

- The third important file is **program.md**. This file acts as the instruction manual for the AI agent. Instead of directly editing Python code, the human researcher provides guidance through this Markdown file. It describes how the agent should run experiments and what types of changes it should explore.

**Key repository components:**

- `prepare.py` – dataset preparation and utilities (not modified)
- `train.py` – model architecture and training loop (modified by the agent)
- `program.md` – instructions guiding the AI research agent

## The 5-Minute Experiment Design

> A major design decision in AutoResearch is the fixed experiment duration. Every training run is limited to exactly **five minutes** of training time.

This constraint may seem small, but it enables rapid experimentation.

Because each experiment runs for a short time, the system can test many ideas quickly. In a typical setup, the agent can run around twelve experiments per hour. Over the course of a full night, this can easily exceed one hundred experiments.

This approach also ensures fairness when comparing results. Since each experiment gets the same time budget, performance differences are more likely to come from meaningful changes rather than longer training times.

The system therefore focuses on discovering improvements that work efficiently within the available compute budget.

## How the Model Is Evaluated

> For evaluating experiments, AutoResearch uses a metric called **validation bits per byte (val_bpb)**.

This metric measures how well the model predicts text data, with lower values indicating better performance.

An important advantage of this metric is that it does not depend on vocabulary size. This allows the agent to freely experiment with architectural changes without breaking the evaluation process. As a result, the system can explore a wider range of modifications while still maintaining fair comparisons between experiments.

## Running AutoResearch

Setting up the system is intentionally simple. The project requires only a single GPU and a few dependencies. After installing the required packages and preparing the dataset, the user can manually run a training experiment to verify that everything works correctly.

Once the environment is ready, an AI coding agent can be launched inside the repository. The agent reads the **program.md** instructions, modifies the training code, and begins running experiments automatically.

**Basic setup workflow:**

- Install dependencies using the `uv` package manager
- Run `prepare.py` to download data and train the tokenizer
- Test a single experiment with `train.py`
- Launch an AI coding agent to start autonomous experiments

## Why AutoResearch Matters

AutoResearch demonstrates a shift in how AI research could be conducted in the future. Instead of manually testing ideas, researchers might focus on designing better experiment strategies and letting AI agents execute them.

Even though the repository is intentionally minimal, it illustrates how autonomous experimentation could significantly accelerate progress. Machines can run experiments continuously, evaluate results instantly, and explore many possibilities faster than humans.

The project also highlights a new role for researchers. Rather than writing every line of experimental code, they may increasingly focus on defining goals, constraints, and high-level strategies for AI systems to explore.

### Conclusion

AutoResearch may look like a small experimental project today, but it hints at a future where AI systems are not only tools for research, they may become active participants in the research process itself.
