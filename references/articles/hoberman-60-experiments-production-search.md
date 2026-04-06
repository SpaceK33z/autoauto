# Autoresearch on a Production Search Algorithm

- **Author:** PJ Hoberman
- **Published:** 2026-03-24
- **URL:** https://blog.pjhoberman.com/autoresearch-60-experiments-production-search

## Summary

PJ Hoberman ran 60 autoresearch iterations on a real production hybrid search system (Cohere embeddings + keyword re-ranking in Django/PostgreSQL). Two rounds: the first improved ranking, the second found nothing — but both were valuable.

### Setup
- **Constrained file:** `utils.py` — ranking logic only
- **Metric:** 80% Precision@12 + 20% MRR (MRR already at 0.975, so room to improve was in top-12 precision)
- **Test set:** 20 queries across 3 types (location, activity, general) with hand-labeled results
- **Eval caching trick:** Cached Bedrock API calls (embeddings + metadata) since only ranking changes between iterations — eval went from 6 min to 30 sec

### Round 1: 44 iterations, 3 kept (93% reverted)
Baseline: 0.6933 → Final: 0.7200 composite

1. **Bigger base weights scaled by query type** — location 5x, activity 3x, general 2x. System was under-weighting keyword signals.
2. **Exponential scoring formula** — `(1-d) * exp(boost*0.3)` gave better separation. Fixed the one imperfect MRR query.
3. **Higher general weights** — pushed 5x on general query type, improved one query from P@12 0.667 to 0.750.

### What Didn't Work
- **Bigger candidate pools:** Expected articles were already in top 100 by vector distance. Problem was ranking, not recall.
- **Title matching:** Too many irrelevant articles also have query terms in titles. Net negative.
- **Disabling adaptive weighting:** The correlation shrinkage actually works.
- **Keyword density scoring:** Shorter articles aren't more relevant.
- **Body keyword damping:** Formula shape barely matters.

### Round 2: 16 iterations, 0 improvements
Targeted the Haiku metadata extraction prompt. Two critical findings:

- **The Redis trap:** Cache keyed on `hash(query)` not `hash(query + prompt)` — first iterations showed fake improvements from stale cache.
- **The co-optimization ceiling:** Round 1 tuned ranking to work with the specific metadata distribution. Changing the prompt changes that distribution, and frozen ranking can't adapt. Every prompt improvement for one query type degraded another.

### Key Insight
> Sequential rounds have a structural ceiling. Round 1 overfits to frozen components. Round 2 can't improve those without undoing Round 1's gains. Co-optimize both components in one round, or accept diminishing returns.

### Conclusion
The +0.03 score gain was marginal, but the knowledge was invaluable: ranking logic was near-optimal, adaptive weighting works, keywords are decorative (embeddings do the real work), Redis cache doesn't key on prompt changes, and next improvement must come from the embedding layer.

> "The autoresearch pattern works best not when it finds big wins, but when it maps the ceiling of a system. 'You can stop tuning this' is an underrated finding."
