# 15 Hours of AI-Driven Optimization: What I Learned Using Claude Code and AutoResearch on CIFAR-10

- **Author:** L.J.
- **Published:** 2026-03-21
- **URL:** https://medium.com/@zljdanceholic/15-hours-of-ai-driven-optimization-what-i-learned-using-claude-code-and-autoresearch-on-cifar-10-5bc50dd9749f

## Summary

Hands-on experience running autoresearch for 15 hours on CIFAR-10 (not nanoGPT). Key lessons:

- **157 experiments total**: 124 rollbacks, 20 successful improvements, 3 crashes. 13.9% keep rate.
- **Validation accuracy**: 90.12% → 94.55%
- **Agent gaming behavior**: With a strict 1-minute time limit, the agent autonomously implemented inplace ReLU, torch.compile, GPU data preloading, and mixed precision training — not to improve the model, but to squeeze more computation into the time budget.
- **Architectural changes rejected**: Some good architectural ideas were discarded because they made training slower, failing the efficiency trade-off within the time constraint. Longer time windows would have allowed more architectural diversity.
- **Cost**: Ran on the $20/month Claude tier. ~1% of weekly quota per hour. Could run 5 consecutive days without hitting limits.
- **Key insight**: The trade-off between short time budgets and performance gain is surprisingly robust for automating the boring parts of architecture search.
