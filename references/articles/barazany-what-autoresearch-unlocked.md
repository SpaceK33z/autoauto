# What Karpathy's Autoresearch Unlocked for Me

- **Author:** Jonathan Barazany (Chief AI at Nayax)
- **Published:** 2026-03-15
- **URL:** https://barazany.dev/blog/what-karpathys-autoresearch-unlocked-for-me

## Summary

Non-data-scientist applies autoresearch to a real business problem (predicting outcomes from CRM data + call recordings). Key lessons:

- **Stuck at AUC 0.581 for 3 weeks** — more features kept making it worse. Completely out of ideas.
- **The method, not the model, was the insight**: Adapted the autoresearch loop to his tabular classification problem (not nanoGPT).
- **165 experiments** took AUC from 0.581 → 0.6747 (+15.6%)
- **Human-in-the-loop pattern**: Agent explores → hits ceiling → human nudges → agent continues. This repeated throughout.
- **Agent discovered stacking** (a technique the author didn't know existed): running multiple models in parallel with a meta-learner, jumping from 0.581 to 0.628.
- **Rubber duck effect**: Simply asking the agent to explain its thinking unlocked new approaches.
- **Progressive improvements**: stacking → temporal features → CatBoost → better cross-validation → feature pruning → temporal decay weights.
- **Key mindset shift**: "I no longer feel like I'm out of ideas. That's new."

Great example of a non-ML-expert using autoresearch on a real business problem, not just toy benchmarks.
