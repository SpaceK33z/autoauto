# Omni-SimpleMem: Autoresearch-Guided Discovery of Lifelong Multimodal Agent Memory

- **Authors:** Jiaqi Liu, Zipeng Ling, Shi Qiu, Yanqing Liu, Siwei Han, Peng Xia, Haoqin Tu, Zeyu Zheng, Cihang Xie, Charles Fleming, Mingyu Ding, Huaxiu Yao
- **Published:** 2026-04-02
- **URL:** https://arxiv.org/abs/2604.01007
- **Code:** https://github.com/aiming-lab/SimpleMem

---

## TLDR

Deployed AUTORESEARCHCLAW (a 23-stage autonomous research pipeline) to discover OMNI-SIMPLEMEM, a unified multimodal memory framework for lifelong AI agents. Starting from a naïve baseline (F1=0.117), the pipeline autonomously ran ~50 experiments in ~72 hours, achieving F1 improvements of +411% on LoCoMo and +214% on Mem-Gallery. The most impactful discoveries were bug fixes (+175%), architectural changes (+44%), and prompt engineering (+188%) — not hyperparameter tuning — demonstrating capabilities beyond traditional AutoML.

## Key Findings

### Bug Fixes Dominate

The single most impactful discovery (Iteration 1, +175% F1) was identifying that the API call lacked a `response_format` parameter — a one-line bug causing 9x verbosity that destroyed F1 precision. This is the kind of fix traditional AutoML cannot make.

### Architecture Discovery via Autoresearch

The pipeline converged on three architectural principles:

1. **Selective Ingestion**: Lightweight perceptual encoders measure information novelty of incoming signals (CLIP for vision, VAD for audio, Jaccard overlap for text) and discard redundant content before storage.
2. **Progressive (Pyramid) Retrieval**: Rather than loading all retrieved content at once, information expands in three stages — summaries → full text → raw content — each gated by a token budget. Hybrid dense-sparse search uses set-union merging (a pipeline discovery) instead of score-based re-ranking.
3. **Knowledge Graph Augmentation**: Entity extraction builds a typed graph (7 entity types, 7 relation types) with entity resolution via hybrid cosine + Jaro-Winkler similarity. At query time, bounded h-hop neighborhood expansion surfaces relationally connected evidence.

### Set-Union Merging > Score-Based Fusion

A key autonomous discovery: when merging FAISS (dense) and BM25 (sparse) results, keeping the dense ordering intact and simply appending BM25-only results outperforms the standard approach of score-based re-ranking. Confirmed by ablation (−14% F1 when BM25 hybrid removed).

### Counter-Intuitive Findings

- Returning **full original dialogue text** instead of LLM-generated summaries improved F1 by +53% on Mem-Gallery — counter-intuitive since summaries are traditionally preferred for efficiency.
- **Prompt constraint positioning** (before vs. after the question) matters more than constraint content, with one category improving +188% from repositioning alone.
- A simple **BM25 tokenization fix** (stripping punctuation: "sushi." → "sushi") yielded +0.018 F1 — more than 10 rounds of prompt engineering.

### Timestamp Corruption Recovery

In Iteration 5 on LoCoMo, the pipeline discovered that all 4,277 MAU timestamps had been corrupted to the ingestion date. It autonomously generated a keyword-matching script that corrected 99.98% of timestamps without re-ingestion.

## Optimization Trajectories

### LoCoMo (9 iterations, F1: 0.117→0.598)

| Iter | Key Discovery | F1 | Δ | Type |
|------|--------------|-----|------|------|
| 0 | Naïve baseline | 0.117 | — | — |
| 1 | JSON response_format missing | 0.322 | +175% | Bug fix |
| 2 | BM25 hybrid | 0.464 | +44% | Architecture |
| 3 | Anti-hallucination prompting | 0.516 | +11% | Prompt |
| 4b | Evaluation format alignment | 0.543 | +5% | Format |
| 5 | MAU timestamp correction | 0.580 | +7% | Data repair |
| 6 | top-k=30 + temporal hints | 0.577 | −0.5% | Hyperparam |
| 7b | Adaptive top-k + metadata | 0.583 | +0.5% | Hyperparam |
| 8 | Forced exact-word copying | 0.551 | −5.5% | Reverted |
| 9 | Increased BM25 results | 0.575 | −1.4% | Reverted |

### Mem-Gallery (39 experiments, 7 phases, F1: 0.254→0.797)

| Phase | Focus | F1 Range | Δ | Key Discovery |
|-------|-------|----------|------|---------------|
| 1 | Environment setup | 0.254→0.353 | +39% | LLM upgrade + local embedding |
| 2 | Architecture | 0.353→0.690 | +96% | Full-text retrieval + image BM25 |
| 3 | Fine-tuning | 0.690→0.717 | +4% | Constraint position sensitivity |
| 4 | Scale validation | 0.717→0.726 | +1% | Data completeness > algorithms |
| 5 | Exact citation | 0.726→0.771 | +6% | BM25 tokenization fix (+0.018) |
| 6 | Visual reasoning | 0.771→0.789 | +2% | Image catalog + context |
| 7 | Plateau exploration | 0.789→0.793 | +1% | Performance ceiling confirmed |

## Ablation Results

Component ablation on LoCoMo (mean ΔF1×100 across 4 backbones):

| Component Removed | ΔF1 | Relative |
|-------------------|------|----------|
| w/o Pyramid Expansion | −10.2 | −17% |
| w/o BM25 Hybrid | −8.5 | −14% |
| w/o LLM Summarization | −7.3 | −12% |
| Reduced top-k (5 vs 20) | −4.2 | −7% |
| w/o Metadata Context | −1.4 | −2% |

The two most impactful components (pyramid expansion and hybrid search) received the most optimization iterations, suggesting the pipeline correctly allocated its search budget.

## Efficiency

OMNI-SIMPLEMEM achieves 5.81 queries/sec with 8 parallel workers (3.5x faster than the fastest baseline), enabled by read-only FAISS and BM25 indices supporting concurrent lookup. All baselines are bottlenecked by sequential LLM generation (85–97% of per-query time).

## The AUTORESEARCHCLAW Pipeline

23 stages organized in 8 phases:

1. **Research Scoping** (Stages 1–2): SMART goals, hardware detection
2. **Literature Discovery** (Stages 3–6): OpenAlex, Semantic Scholar, arXiv queries with relevance screening
3. **Knowledge Synthesis** (Stages 7–8): Clustering findings, generating hypotheses via multi-agent debate
4. **Experiment Design** (Stages 9–11): Protocol design with AST validation, hardware-aware code generation
5. **Experiment Execution** (Stages 12–13): Sandboxed execution with self-healing (up to 10 retries)
6. **Analysis & Decision** (Stages 14–15): Statistical analysis (t-tests, bootstrap CI), PROCEED/PIVOT/ITERATE decision
7. **Documentation** (Stages 16–19): Draft generation, simulated peer review, revision
8. **Finalization** (Stages 20–23): Quality gate, LaTeX export, 4-layer citation verification

Decision logic at each iteration: proceed (metric improved ≥0.5%), iterate (ambiguous, refine hypothesis), or pivot (two consecutive degradations, revert and try new direction).

## Taxonomy of Discovery Types

Six categories of autonomous discoveries:

1. **Bug fixes** — Code-level errors (e.g., missing `response_format` parameter) — highest individual impact (+175%)
2. **Architectural changes** — System design modifications (e.g., BM25 hybrid search) — +44%
3. **Prompt engineering** — Instruction optimization (e.g., constraint positioning) — +188% on specific categories
4. **Data repair** — Pipeline data quality fixes (e.g., timestamp corruption) — +7%
5. **Format alignment** — Output format matching evaluation metrics — +5%
6. **Hyperparameter tuning** — Traditional parameter optimization — smallest cumulative impact

## Why Multimodal Memory Suits Autoresearch

Four properties identified:

1. **Immediate scalar evaluation metrics** — F1 enables tight optimization loops
2. **Modular architecture** — Components can be modified in isolation
3. **Fast iteration cycles** — 1–2 hours per experiment supports dozens of hypotheses within days
4. **Version-controlled code** — Failed experiments can be cleanly reverted

## Technical Details

### Multimodal Atomic Units (MAUs)

M = ⟨s, e, p, τ, m, ℓ⟩ where:
- s = text summary
- e = embedding vector
- p = pointer to raw content in cold storage
- τ = timestamp
- m = modality
- ℓ = structural links to other MAUs

Two-tier storage: hot storage (summaries, embeddings, metadata) for fast retrieval; cold storage (raw images, audio, video) accessed lazily.

### Hybrid Search

Given query q:
- Dense retrieval via FAISS yields semantically similar candidates D(q)
- BM25 over MAU summaries yields keyword-matched candidates K(q)
- Set-union merging: R(q) = D(q) ∪ (K(q) \ D(q))

### Pyramid Retrieval

- Level 1: Summaries (~10 tokens each) for top-k candidates
- Level 2: Full text/detailed captions for candidates exceeding similarity threshold θ
- Level 3: Raw content from cold storage under token budget B, expanded greedily in decreasing similarity-per-token order

### Knowledge Graph

- 7 entity types: Person, Location, Object, Event, Concept, Time, Organization
- 7 relation types: located_in, part_of, interacts_with, owns, attended, created_by, related_to
- Entity resolution merges entities via hybrid cosine + Jaro-Winkler similarity
- Query-time: seed entities → h-hop expansion → distance-decayed relevance scoring

### Default Configuration

- Embedding: all-MiniLM-L6-v2 (384d)
- top-k: 20
- Auto-expand threshold θ: 0.4
- Token budget B: 6,000
- BM25 parameters: k1=1.5, b=0.75
- Graph decay β: 0.7
- Expansion hops h: 2

## Main Results

OMNI-SIMPLEMEM achieves highest overall F1 across all tested backbones (GPT-4o, GPT-4o-mini, GPT-4.1-nano, GPT-5.1, GPT-5-nano) on both LoCoMo (0.492–0.613) and Mem-Gallery (0.749–0.810), substantially outperforming the next best baseline (SimpleMem at 0.342–0.432 on LoCoMo and up to 0.538 on Mem-Gallery).

## Relevance to AutoAuto

- Validates that autoresearch can produce SOTA results on complex multi-component AI systems, not just traditional ML tasks
- Bug fixes and architectural changes dominate hyperparameter tuning — supports AutoAuto's agent-driven approach over grid search
- The pipeline's decision logic (proceed/iterate/pivot based on metric improvement ≥0.5%) is directly comparable to AutoAuto's keep/discard threshold
- Performance ceiling detection (4 independent runs yielding stable F1) as a stopping criterion
- Two-phase optimization strategy (fast iteration on subset → full evaluation) could inform AutoAuto's measurement approach
- Demonstrates the importance of data pipeline quality (timestamp corruption, BM25 tokenization) — things only a code-comprehending agent can fix
- ~72 hours wall-clock time for ~50 experiments aligns with practical autoresearch timelines
