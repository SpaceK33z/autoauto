# Your MacBook Can Do Autonomous AI Research Now

- **Author:** Naman Goyal
- **Published:** 2026-03
- **URL:** https://namangoyal.com/blog/2026/autoresearch-mlx/

## Summary

Naman Goyal ported Karpathy's autoresearch to Apple Silicon using MLX, enabling the full autonomous research loop on a MacBook with no cloud GPU needed.

### Results (M1 Pro 16GB, single 5-min run)
- Starting train loss: 9.012 → Final: 6.762
- val_bpb: 2.371 (55 steps, 3.6M tokens, 11.0 GB peak memory)
- M4 Max community results: 1.808 BPB single run, 1.295 BPB after overnight loop
- H100 reference: ~1.0 BPB (96x faster, but that's not the point)

### Model Architecture (11.5M params)
- **Value Embeddings (ResFormer):** Every other layer gets its own value embedding table with gated linear projection
- **Sliding Window Attention:** 3 short-range + 1 long-range layer pattern. Additive masks on MLX instead of Flash Attention
- **RoPE with QK-Norm**, **Softcap at 15.0** (from Gemma 2), **Squared ReLU** activation, **Per-layer residual scaling**

### Optimizer: AdamW with 6 Parameter Groups
Embedding LR 150x higher than unembedding. Only transformer matrices get weight decay. No warmup, linear warmdown in second half. Weight decay schedule `WEIGHT_DECAY * (1 - progress)` — missed in reference fork, yields 2-5% BPB improvement.

### Data Pipeline
- ClimbMix 400B dataset, BPE tokenizer with 8,192 vocab
- BOS-aligned best-fit packing, ~100% token utilization
- Unified memory advantage on Apple Silicon (no CPU→GPU transfer)

### Improvements Over Reference Fork
NaN loss detection, `FINAL_EVAL_BATCH_SIZE=16` for 16GB Macs, weight decay schedule fix, FLOP estimation, MFU calculation, config logging, phase timing.

### Key Takeaway
You don't need an H100 to experiment with autonomous AI research. ~12 experiments/hour on a MacBook, ~100 overnight. Good enough for learning, prototyping, and iterating on architecture ideas before touching cloud GPUs.
