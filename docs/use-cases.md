# Use Cases

AutoAuto is not just for ML training. It works anywhere you have code and a measurable metric. Below are ideas extracted from 30+ real-world autoresearch implementations, organized by how quickly you'll see results.

## Quick wins

These targets have fast feedback loops, clear metrics, and small editable surfaces — ideal for a first run.

### Prompts and skills

The "killer app" for autoresearch. Pure text, single file, measurable output, small changes compound fast. ~$0.10/cycle, 50 rounds overnight for ~$5.

- **System prompts** — optimize for specificity, formatting compliance, error handling, consistency
- **Claude Skills / SKILL.md files** — one skill went from 41% to 92% pass rate in 4 rounds
- **Content templates** — newsletters, emails, landing pages, social posts scored against binary rubrics
- **Agent workflows** — multi-step tool-calling configs, optimizing tool sequences, error recovery, output quality

*Selection heuristic:* Start with whatever frustrates you most — the prompt you re-run 3 times, the skill that fails on edge cases.

### Software performance

Clear numeric metrics, deterministic measurement, and constrained optimization surfaces.

- **Page load time** — Ole Lehmann reduced page load from 1100ms to 67ms
- **Template rendering** — Shopify's Liquid rendering: 53% faster, 61% fewer memory allocations from 93 automated commits
- **Serialization throughput** — jsonista (Clojure JSON lib) improved 56% ops/sec
- **Frontend bundle size** — fewer knobs, clear metric (bytes), hard to game
- **Hotspot function latency** — p50/p95 latency, throughput, memory allocations, compression ratio
- **Binary size / compile time** — any build artifact with a numeric size or speed metric

### Test stability

Binary pass/fail metrics are the most robust targets — no variance, no gaming.

- **Fixing flaky tests** — Gumroad: 206 commits, 94 CI runs, 13 merged PRs, zero lines of test code written manually
- **Race condition discovery** — the agent found browser session corruption and test cleanup hooks leaking between tests
- **Real bug discovery** — a flaky test led the agent to a genuine production bug: file ID remapping where A->B then B->C silently corrupted references

## Medium complexity

These need more careful measurement setup but deliver strong results.

### Search and ranking

- **Hybrid search ranking weights** — 60 iterations on production search: baseline 0.6933 to 0.7200. Agent found query-type-specific weights and exponential scoring formulas
- **Scoring formula shape** — testing exponential vs. linear vs. polynomial for result separation
- **Product categorization and intent routing** — tune prompt rules, category descriptions, fallback logic against a labeled eval set
- **Metadata extraction pipelines** — tune extraction prompts, schemas, normalization against exact match / F1

### Multi-component AI systems

AI systems are natural autoresearch targets because they have: (1) immediate scalar evaluation metrics, (2) modular architecture, (3) fast iteration cycles, and (4) version-controlled code.

- **Multimodal memory frameworks** — +411% F1 on LoCoMo, +214% on Mem-Gallery from ~50 experiments
- **Retrieval pipeline optimization** — embedding selection, search fusion, retrieval depth
- **Agent tool configurations** — tool selection prompts, context window management, memory retrieval

### Meta-optimization

- **Eval criteria themselves** — "the meta play." A second loop optimizes the scoring rubric used by a first loop
- **Co-optimizing coupled components** — if two components shape each other's output, tune them in one loop instead of sequential rounds

## Longer feedback loops

These work but need larger sample sizes and patience.

### Marketing and growth

- **Cold email reply rate** — baseline 2-4% improved to 8-12% with 50+ sends per variant
- **Landing page conversion** — 15-40% improvements over 8-12 weeks with 200-500+ visitors per variant
- **Paid ad CTR** — 20-50% CTR improvements in the first month
- **Ad copy generation** — nightly loop: measure, generate, deploy, evaluate. Rollback if conversion drops 15-20%

*Important:* Optimize full-funnel metrics (CPA, revenue per visitor) instead of CTR alone. Otherwise agents attract cheap clicks that don't convert.

### Product and UX

- **Feature flag experiments** — copy, default settings, onboarding steps measured by activation, retention, task completion
- **Form and funnel completion** — checkout, signup flows with measurable completion rates (guard against removing required fields)
- **Support automation quality** — tune help-center retrieval and triage prompts against deflection rate + review pass/fail

### Finance

- **Trading strategy backtesting** — Sharpe ratio as fitness function on historical data
- **Portfolio rebalancing** — test factor weightings, rebalancing frequency, risk models

*Note: live trading is a bad fit — cost of a bad iteration must be near zero. Paper trading / backtesting only.*

### Games

- **NPC behavior optimization** — iterate on decision-making strategies, measure win/loss rates or engagement
- **Game balancing** — damage values, spawn rates, difficulty curves with measurable balance metrics

## Notable results from the field

| Source | Metric | Before | After | Improvement | Experiments |
|--------|--------|--------|-------|-------------|-------------|
| Karpathy | nanoGPT training speed | baseline | +11% | +11% | ~125 |
| Shopify | Liquid rendering | baseline | +53% speed | -61% allocations | 93 |
| Shopify (Lutke) | Search quality | 1.6B model | 0.8B +19% | smaller model wins | 37 |
| Lehmann | Page load | 1100ms | 67ms | -94% | -- |
| Hoberman | Search precision | 0.6933 | 0.7200 | +3.9% | 44 |
| Langfuse | Prompt skill score | 0.35 | 0.824 | +135% | 14 |
| Barazany | Tabular AUC | 0.581 | 0.675 | +15.6% | 165 |
| Piana | Flaky tests fixed | 0 | 13 | 13 tests | 206 commits |
| Liu et al. | LoCoMo F1 | 0.117 | 0.598 | +411% | ~50 |
| Liu et al. | Mem-Gallery F1 | 0.254 | 0.797 | +214% | ~50 |
| Aakash | Landing page skill | 41% | 92% | +124% | 4 rounds |

## Three prerequisites

All three must be present for autoresearch to work:

1. **A clear numerical metric** — single number, clear direction
2. **An unattended evaluation tool** — a script that produces the number without human input
3. **A bounded editable surface** — the agent needs a constrained place to act

Missing any one breaks the loop. "All three true? The loop works. Any one missing? It won't."

## Patterns we've learned

For deeper insights from studying 30+ implementations, see:

- [Metric Design](patterns/metric-design.md) — choosing metrics, scoring approaches, variance handling, gaming defenses
- [Failure Modes](patterns/failure-modes.md) — what goes wrong and how AutoAuto prevents it
- [Loop Tuning](patterns/loop-tuning.md) — context packets, stopping criteria, model choice, crash recovery
