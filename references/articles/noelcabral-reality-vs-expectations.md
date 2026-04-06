# Karpathy Autoresearch: Reality vs. Expectations

- **Author:** Noel Cabral
- **Published:** 2026-03-15
- **URL:** https://noelcabral.com/karpathy-autoresearch-reality-vs-expectations

## Summary

Comprehensive analysis synthesizing dozens of real implementations and post-mortems. Core lessons:

### Common Failure Points
1. **No objective, frozen metric**: Subjective goals like "readability" or "warmth" cause the loop to descend into chaos. The metric must be a single unambiguous number.
2. **Slow feedback loops**: If experiments take hours/days (SEO traffic, cold email replies), you lose the statistical advantage of hundreds of rapid iterations.
3. **High cost of failure**: Attaching the loop to real-world assets (live trading) means every failed hypothesis costs real money. The cost of a bad iteration must be ~zero.
4. **Agent amnesia**: Without a centralized learnings doc, agents waste cycles retrying discarded hypotheses.

### What Consistently Works
- **Ruthless time constraints** create a level playing field — forces efficient solutions over bloated ones.
- **Strict separation of concerns**: locked prep file, sandboxed training file, human-written strategy doc.
- **Micro-optimizations over paradigm shifts**: 10-20% gains from hyperparameter tuning, not inventing new architectures.

### Recommendations
1. Spend 90% of time designing the evaluation metric — agents will exploit any loophole.
2. Do a "dry run" phase — babysit the first 10 iterations before letting it run overnight.
3. Strictly limit scope to closed-loop, text-based problems with instant local verification.

### Key Quote
> "You are no longer the researcher; you become the architect of the laboratory."
