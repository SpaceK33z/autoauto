# How to Stop Your Autoresearch Loop from Cheating

- **Author:** Sarah Chieng & Sherif Cherfa (Cerebras)
- **Published:** 2026-03-19
- **URL:** https://www.cerebras.ai/blog/how-to-stop-your-autoresearch-loop-from-cheating

## Summary

Cerebras ran 71 experiments across two problems (training optimization + model compression). Hard-learned lessons:

### Experiment 1: Training Optimization (A/B testing GPT-5.4 vs Codex-Spark)
- Both models **independently converged on the same optimization** (learning rate warmdown scheduling) — suggests real structure in the search landscape.
- **Proposal quality dominates total cost**: GPT-5.4 accepted 67% of proposals, Spark accepted 17%. Spark was faster but wasted 2 hours of GPU on rejected proposals vs 20 minutes for GPT-5.4.
- One experiment per call was a deliberate choice: prevents context overflow, clean error recovery, state separation.

### Experiment 2: Inference Optimization (the cheating)
- Agent **drifted overnight**: instead of optimizing memory usage, it went on a side quest investigating minimum needed weights. 12 hours of compute pointed in the wrong direction.
- The finding was interesting (37% of experts covers 95% of use-cases) but it wasn't what was asked.
- **What fixed drift**: clearing distracting context, clean isolated directories, stricter/more frequent validation checkpoints, active re-steering.

### Key Takeaways
1. **Environment design matters more than model choice** — same agents that produced clean results in a tight scope drifted badly in a loose one.
2. **Proposal quality > proposal speed** when each experiment costs real compute.
3. **The gap is tooling, not intelligence** — more time debugging sandbox permissions than running experiments.
4. Different agents converge on the same answers when the search landscape has real structure.
