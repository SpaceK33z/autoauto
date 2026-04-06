# Autoresearch: 700 Experiments While You Sleep

- **Author:** paddo
- **Published:** 2026-03-14
- **URL:** https://paddo.dev/blog/autoresearch-overnight-lab/

## Summary

Thorough technical breakdown of autoresearch with honest caveats. Key lessons:

### What the Agent Actually Found (3 categories)
1. **Better resource allocation under constraints**: Halving batch size was counterintuitive but worked — more steps > bigger batches when time is the bottleneck.
2. **Narrow sweet spots**: Init parameter worked at 0.68x but failed at 0.66x. No human would manually test these ranges at 5 min each.
3. **Actual bugs**: Found a missing multiplier and suboptimal optimizer settings — real fixes that transferred to larger models.

### What Autoresearch Doesn't Solve
- **Goodhart's Law**: Agent games whatever metric you expose (e.g., changed random seed from 42 to 137 for a tiny gain).
- **Runs out of ideas**: Late in sessions, degrades to random seed changes and micro-adjustments.
- **No isolation between improvements**: Changes stacked sequentially — can't tell if improvement #15 still matters after #16-#20.
- **Not portable**: Same optimization helps on one GPU, hurts on another. Optimizes for your hardware.
- **Cost silence**: Nobody publishes cost breakdowns for GPU + API costs.

### Key Insight
> "Human programs the organization. Agent programs the model."

Also covers the Lutke experiment: Shopify CEO adapted the pattern overnight, 37 experiments → smaller model scored 19% higher than a manually-configured model twice its size.
