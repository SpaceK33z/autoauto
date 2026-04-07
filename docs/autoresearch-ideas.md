# Ideas

AutoAuto is **not for model training** — no training loops, datasets, or GPUs required. It applies the autoresearch pattern to software engineering: anywhere you have a measurable metric and code you can iterate on.

Below is a list of ideas extracted from real-world experience across the [reference articles](../references/articles/INDEX.md).

## Target Categories Ranked by Speed of Results

From Saladi's Builder's Playbook — ranked by how quickly you'll see value:

1. **Claude Skills / SKILL.md files** — "the killer app." Pure text, single file, measurable output, small changes compound fast. ~$0.10/cycle.
2. **System prompts** — written once, rarely tested. Optimize for specificity, formatting compliance, error handling, consistency.
3. **Content templates** — newsletters, emails, landing pages, social posts. Scored against binary rubrics.
4. **Agent workflows** — multi-step tool-calling configs. Optimize tool sequences, error recovery, output quality.
5. **Eval criteria themselves** — "the meta play." A second loop optimizes the scoring rubric used by the first loop.

**Selection heuristic:** Start with whatever frustrates you most — the prompt you re-run 3 times, the skill that fails on edge cases, the workflow that goes off the rails.

---

## Software Performance

- **JSON serialization throughput.** pi-autoresearch improved jsonista (Clojure JSON lib) by 56% ops/sec — found PersistentArrayMap for small maps, string key specialization, and unrolled duplicate key checks via switch/case for map sizes 3-4.
- **Page load time.** Ole Lehmann reduced page load from 1100ms to 67ms using the autoresearch loop on a website.
- **Template rendering speed.** Shopify ran autoresearch on Liquid rendering: 53% faster, 61% fewer memory allocations from 93 automated commits.
- **Frontend bundle size.** Works well for constrained targets — fewer knobs, clear metric (bytes), hard to game.
- **Binary size / compile time.** Any build artifact with a numeric size or speed metric as the fitness function.
- **Hotspot function latency.** Constrained loops around a benchmarked function: p50/p95 latency, throughput, memory allocations, or compression ratio. Strong fit when the agent can only edit the hot path and a verification suite catches semantic regressions.
- **GPU kernel / training optimization.** Karpathy's original run found 20 improvements including a genuine attention implementation bug. The 11% speedup transferred to larger models — not just an eval artifact. ~125 experiments over two overnight sessions, ~12 experiments/hour.
- **Self-improving coding agents.** Agent iteratively edits its own source code to improve benchmark performance.

## Test Stability

- **Fixing flaky tests.** Gumroad used autoresearch to fix 13 flaky tests: 206 commits, 94 CI runs, 13 merged PRs — zero lines of test code written manually. Binary CI pass/fail as the metric.
- **Race condition discovery.** The Gumroad agent found race conditions, browser session corruption, and test cleanup hooks leaking between tests.
- **Real bug discovery via flake symptoms.** A flaky test led the agent to a genuine production bug: file ID remapping where A→B then B→C silently corrupted references. The flake was just the symptom.
- **Persistent test fixes.** One tax input field went through four different fix approaches before the agent found one that held across CI runs — the ideas backlog prevented it from retrying failed approaches.

## Prompt & Skill Optimization

- **Langfuse prompt migration skill.** Score went from 0.35 to 0.824 in 14 experiments. Key wins: escalating a buried `{{var}}` syntax warning to a `**CRITICAL**` block, and adding a mandatory pre-refactoring inventory step.
- **Landing page copywriting prompt.** 56% to 92% pass rate overnight for ~$15 in compute. Agent added headline restrictions, banned-buzzword registries, and embedded worked examples.
- **Claude Skills / SKILL.md optimization.** Ranked as "the killer app" — ~$0.10/cycle, 50 rounds overnight for ~$5. One skill went from 41% to 92% pass rate in 4 rounds.
- **System prompt optimization.** Iteratively refine LLM system prompts against a binary eval rubric — one of the fastest-feedback autoresearch targets.
- **Content template optimization.** Email templates, report templates, proposal templates — scored against a binary rubric (3-6 yes/no criteria, not sliding scales).
- **Agent workflow tuning.** Optimize multi-step agent pipeline instructions against a measurable quality metric.
- **Meta-optimization of eval criteria.** Use one autoresearch loop to improve the scoring rubric used by another loop.

## Multi-Component AI Systems

- **Multimodal memory frameworks.** Liu et al. used autoresearch to build OMNI-SIMPLEMEM — a multimodal memory system for AI agents. ~50 experiments, +411% F1 on LoCoMo, +214% on Mem-Gallery. The pipeline found bug fixes (+175%), architectural changes (+44%), and prompt engineering (+188%) — each individually exceeding all hyperparameter tuning combined.
- **Retrieval pipeline optimization.** Dense/sparse search fusion, pyramid retrieval depth, knowledge graph expansion parameters, embedding model selection — all measurable via retrieval benchmarks (F1, MRR, Precision@k).
- **Agent tool configurations.** Multi-step agent systems with measurable success rates: tool selection prompts, context window management, memory retrieval strategies.
- **Why AI systems suit autoresearch.** Liu et al. identify four properties: (1) immediate scalar evaluation metrics enabling tight loops, (2) modular architecture allowing isolated component modification, (3) fast iteration cycles (1–2 hours/experiment), and (4) version-controlled code allowing clean reverts. Any AI system with these four properties is a good autoresearch target.

## Search & Ranking

- **Hybrid search ranking weights.** 60 iterations on production Cohere embeddings + keyword re-ranking (Django/PostgreSQL). Composite metric: 80% Precision@12 + 20% MRR. Baseline 0.6933 → 0.7200. Agent found query-type-specific weights (location 5x, activity 3x, general 2x) and exponential scoring formulas.
- **Scoring formula shape.** Testing exponential vs linear vs polynomial scoring for better result separation — `(1-d) * exp(boost*0.3)` outperformed linear alternatives.
- **Metadata extraction pipelines.** Tune extraction prompts, schemas, normalization, and confidence thresholds against exact match / F1. Best when co-optimized with the downstream ranker or classifier, not as a frozen second round.
- **Product categorization and intent routing.** Use a labeled eval set to tune prompt rules, category descriptions, fallback logic, and score thresholds. Works without training a model if the editable asset is the router prompt or scoring code.
- **Ceiling mapping.** After 16 iterations with zero improvements on a metadata extraction prompt, the finding was definitive: "stop tuning this." Knowing a component has no headroom left is a real deliverable.
- **Cache bug discovery.** The search ranking loop exposed a Redis cache keyed on `hash(query)` instead of `hash(query + prompt)`, producing fake improvements from stale cache entries.

## Marketing & Growth

- **Cold email reply rate.** Baseline 2-4% improved to 8-12% in 4-6 weeks via systematic subject line, opener, and CTA variations. Minimum 50+ sends per variant. Deployed via Apollo, Lemlist, or Klaviyo APIs.
- **Landing page conversion.** 15-40% conversion improvements over 8-12 weeks with 200-500+ visitors per variant per cycle.
- **Paid ad CTR.** 20-50% CTR improvements in the first month on well-targeted campaigns.
- **Full-funnel marketing metrics.** Optimize toward cost per acquisition, revenue per visitor, qualified lead rate, or click-to-conversion rate instead of CTR alone — avoids agents improving cheap clicks that do not become revenue.
- **Ad bid optimization.** Test bidding strategies, budget caps, audiences, and creative pairings against ROAS or CPA with strict spend caps and rollback rules.
- **Offer framing.** Systematically vary pricing presentation, guarantee language, bundle framing, or lead magnet positioning while keeping attribution to one changed element per cycle.
- **Autonomous ad copy loop.** Four-layer architecture: measurement (Google Ads/Meta/GA4 APIs), generation (AI copy using performance context), deployment (platform APIs), evaluation (promote/retire/continue). 1-2 new variants per nightly cycle, rollback if conversion drops 15-20%.
- **Experiment velocity.** Eric Siu (Single Grain): 36,500+ experiments/year vs. the typical marketing team's 20-30.
- **Cold outreach templates and newsletter openings.** Same loop as landing page copy — editable text asset, binary eval criteria, measurable response metric.

## Product & UX

- **Feature flag experiments.** Agent proposes copy, default settings, onboarding steps, or small feature variants; product analytics decide keep/revert via activation, retention, task completion, or support-ticket deltas.
- **Form and funnel completion.** Checkout, signup, import, or setup flows with measurable completion and error rates. Needs guardrails so the agent cannot simply remove required fields or validation.
- **Support automation quality.** Tune help-center retrieval rules, support macros, or triage prompts against deflection rate plus human review pass/fail, with escalation accuracy as a hard constraint.

## Finance

- **Trading strategy backtesting.** Sharpe ratio as fitness function on historical data. Agents test entry/exit thresholds, position sizing, risk parameters.
- **Portfolio rebalancing strategies.** Test factor weightings, rebalancing frequency, and risk models against historical performance.
- *Note: live trading is a bad fit — cost of a bad iteration must be near zero. Paper trading / backtesting only.*

## Games

- **NPC behavior optimization.** Iterate on NPC decision-making strategies; measure win/loss rates or player engagement metrics against the NPC.
- **Game balancing.** Damage values, spawn rates, difficulty curves — any tunable parameter with a measurable balance metric.

## AI Safety

- **Adversarial input generation.** Systematically generate inputs that break voice AI or other systems — pass/fail robustness as the fitness metric.
- **Automated red-teaming.** AI agents that probe other AI systems for vulnerabilities, using failure rate as the metric.

## Meta Patterns

- **Any binary pass/fail metric.** CI green/red, test pass/fail, format compliance — the easiest and most robust targets.
- **Any single numeric fitness function.** The constraint isn't the domain — it's whether you can produce an unambiguous number automatically.
- **Binary eval criteria prevent gaming.** Every criterion must be yes/no, not a sliding scale (1-7). 3-6 binary criteria is the sweet spot — below 3 leaves loopholes, above 6 leads to checklist gaming.
- **Eval caching.** Cache expensive fixed inputs — embeddings, metadata, API calls — so each round measures only the changed component. Include the changed prompt/schema/version in cache keys to avoid fake wins.
- **Co-optimization over sequential tuning.** If two components shape each other's distribution, tune them in one loop. Sequential rounds can overfit the first component and leave the second unable to improve without undoing earlier gains.
- **Safety penalties in the score.** For latency, cost, or conversion loops, include hard penalties for broken correctness, compliance, safety, spend, or data quality. Otherwise agents learn to win by deleting safeguards.
- **Ideas backlog as institutional memory.** Every failed experiment forces the agent to document what it tried, preventing repeated mistakes across sessions and crash recovery.
- **Single-context-window constraint.** The 630-line editable file is deliberate (paddo): keeping the entire codebase in one context window prevents hallucinated imports and fragmentation. When expanding to larger targets, consider splitting into independently measurable components rather than one large file.
- **Human-in-the-loop acceleration.** Agent explores → hits ceiling → human nudges direction → agent continues. Repeatably outperforms pure manual or pure autonomous iteration. Barazany's 165-experiment run used this pattern repeatedly: rubber duck debugging at experiment 30, research sub-agent spawning mid-run, targeted direction suggestions at each plateau.
- **Three prerequisites filter.** All three must be present: (1) a clear numerical metric, (2) an unattended evaluation tool, and (3) a single editable file. Missing any one breaks the loop. "All three true? The loop works. Any one missing? It won't." (Aakash, Saladi)
- **Bug fixes outperform hyperparameter tuning.** Liu et al. (Omni-SimpleMem) categorized ~50 experiments by discovery type: bug fixes (+175%), architecture (+44%), prompt engineering (+188%) each individually exceeded *all* hyperparameter tuning combined. This validates code-comprehending autoresearch over traditional AutoML — the biggest wins come from fixing things AutoML can't even see.
- **Subset-first iteration.** Iterate on a small representative subset of the evaluation data, then validate on the full benchmark only at convergence. Liu et al. ran experiments in minutes on subsets vs. hours on full benchmarks, enabling dozens of hypotheses within days.
