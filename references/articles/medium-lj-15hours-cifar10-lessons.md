# 15 Hours of AI-Driven Optimization: What I Learned Using Claude Code and AutoResearch on CIFAR-10

- **Author:** L.J.
- **Published:** 2026-03-21
- **URL:** https://medium.com/@zljdanceholic/15-hours-of-ai-driven-optimization-what-i-learned-using-claude-code-and-autoresearch-on-cifar-10-5bc50dd9749f

---

I recently spent 15 hours running an automated research marathon using the combination of Claude Code and Andrej Karpathy's AutoResearch tool. Here is a breakdown of the results, the unexpected "emergent behaviors" of the agent, and the cost-efficiency of running such an experiment on a standard consumer-tier plan.

## The Setup

For this run, I made a few key adjustments to the baseline configuration. Instead of the default nanoGPT, I swapped the experiment to **CIFAR-10** because it is more lightweight. I also tightened the constraints significantly: I limited the runtime for each experiment to just **one minute** rather than the usual five.

## The Results by the Numbers

Over the course of 15 hours, the agent conducted a total of **157 experiments**. The breakdown (as seen in the logs) is quite telling:

- **124** rollbacks (failed parameter tweaks).
- **20** successful validation accuracy improvements.
- **3** crashes due to OOM (Out of Memory) or compilation errors.
- **13.9% keep rate** (the percentage of changes that actually made the cut).

In terms of performance, the agent managed to push the validation accuracy from a baseline of **90.12% to 94.55%**. Looking at the tracking data, you can see a clear trajectory of "green dots" (successful keeps) rising through a sea of "gray dots" (discarded attempts).

## When the Agent Starts "Gaming" the System

One of the most fascinating takeaways was how the agent reacted to the strict one-minute time limit. It realized that since it couldn't change the time constraint, the only way to improve the metrics was to **squeeze more computation into that single minute.**

To solve the IO and compute bottleneck, the agent autonomously implemented:

- **Inplace ReLU** and **torch.compile**: This reduced memory overhead and fused kernels, resulting in a **60% increase in step velocity**.
- **GPU Data Preloading**: Moving data to the GPU ahead of time to eliminate IO stalls.
- **Mixed Precision Training**: To further accelerate throughput.

It wasn't all just low-level optimization, though. The agent also attempted various architectural changes and complex regularization techniques. Interestingly, some of these were actually rejected — not because they were bad for accuracy, but because they made the training loop slower, causing them to fail the efficiency trade-off. If I had given it a five-minute window, the architectural diversity would likely have been much higher.

## A Note on Methodology: Why Val_Acc is King

You might wonder about the test accuracy. In this context, it doesn't actually matter. When we tune models manually, we use the validation set as our North Star to avoid leaking test data into the design process. Using an agent is no different; it's essentially "outsourcing" the grind of hyperparameter tuning. The agent should only see the validation metrics to ensure the test set remains a pure, unbiased final benchmark.

## The Bottom Line: Cost and Sustainability

I ran this on the standard **$20/month Claude tier**. Looking at the usage dashboard, Claude tracks consumption in 5-hour windows and weekly totals. After 15 hours of continuous "agentic" work, I hadn't even hit the 5-hour limit, and my weekly quota was only at **16%**.

That works out to roughly **1% of your weekly quota per hour**.

While you might not be able to run a massive project 24/7 for a month on the $20 tier, you could easily let it run for five consecutive days without hitting a wall. Given how fast CIFAR-10 iterates, this feels incredibly cost-effective. Even with larger codebases where the context window grows, the increased complexity of the data would likely necessitate longer runtimes anyway, so the relative "quota-per-insight" ratio should remain fairly stable.

**Final thought:** The trade-off between 1-minute efficiency and performance gain is surprisingly robust. If you're looking to automate the "boring" parts of model architecture search, this stack is officially ready for prime time.
