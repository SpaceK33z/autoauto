# Autoresearch: GPU Render Pass Optimization

You are one iteration of an autonomous hill-climbing loop that reduces Modulaser's GPU render time. An external orchestrator handles the loop, measurement, and keep/discard decisions. Your job: analyze, implement ONE optimization, validate, and commit.

## Your Task

1. **ANALYZE**: Read the most recent GPU analysis in `.traces/autoresearch-gpu/` (the newest `*.txt` file) to identify the slowest render pass by mean duration and % of frame. Read `.traces/autoresearch-gpu/autoresearch-results.tsv` to see what's been tried before. Read recent git history with `git log --oneline --decorate -n 20` and inspect reverted experiment commits with `git show <commit>` so you don't repeat discarded approaches. Read `docs/performance-tradeoffs.md` for historical context.

2. **PLAN**: Pick ONE concrete optimization target. Describe it in one sentence. Think about what files need to change and the expected effect.

3. **IMPLEMENT**: Edit source code. Keep changes minimal and focused — one optimization per iteration. Follow all rules in CLAUDE.md (test-first for non-UI changes, no over-engineering, code style).

4. **VALIDATE**: Run:
   ```bash
   cargo check --all-targets && cargo test --quiet && cargo clippy --all-targets -- -D warnings
   ```
   If this fails, fix the issue. Do NOT skip validation. Do NOT discard changes yourself — if you can't fix validation, just exit without committing and the orchestrator will handle cleanup.

5. **COMMIT**: Stage and commit:
   ```bash
   git add -A && git reset HEAD gpu-trace.json 2>/dev/null; git commit -m "perf(scope): description"
   ```

Then EXIT. The orchestrator handles building with gpu-profile, measuring, and keep/discard.

## Metric

**Average GPU time per frame** (in milliseconds) measured via wgpu-profiler timestamp queries during a fixed steady-state measurement window with a reproducible scene, after a warmup period. Lower = better. This captures the total time the GPU spends on instrumented render passes each frame.

Secondary metric: **max GPU time per frame** (worst-case spikes). Tracked but not used for keep/discard.

You don't run the measurement — the orchestrator does. The binary is built with `--features gpu-profile` which enables wgpu-profiler timestamp queries on all render passes.
The measurement script also rejects traces with too few steady-state frames, so don't optimize for startup-only behavior.

## What to Optimize

### High-Impact Patterns

- **Expensive blur passes**: Multi-pass Gaussian blur at full resolution. Fix: downsample before blur, reduce iteration count, use separable passes if not already.
- **Overdraw in compositing**: Fullscreen passes that blend multiple layers. Fix: skip passes when input is empty, combine passes, reduce blend complexity.
- **Unnecessary render passes**: Passes that run even when their output isn't visible. Fix: skip when the feature is disabled or has no visible effect.
- **Large render targets**: Bloom/afterglow rendering at full resolution when half-res would be visually indistinguishable. Fix: render at reduced resolution.
- **Shader complexity**: Complex per-pixel math in fragment shaders. Fix: precompute values, simplify math, use lookup textures.
- **Excessive geometry**: Too many vertices/triangles for the visual effect. Fix: reduce tessellation, simplify geometry generation.

### Lower-Impact (Still Valid)

- **Redundant GPU state changes**: Switching pipelines/bind groups unnecessarily. Fix: batch draws with same state.
- **Suboptimal texture formats**: Using higher precision than needed. Fix: use R8/RG8 where full RGBA isn't needed.
- **Vertex data size**: Passing more per-vertex data than the shader uses. Fix: trim vertex attributes.

## Understanding the GPU Profile

The analysis file shows per-pass timing statistics:
- **Pass Name**: The render pass label (e.g., "bloom_blur_h", "afterglow_fade", "beam_view_scene")
- **Mean/Median/Min/Max**: Timing distribution across frames
- **% of Frame**: How much of total GPU time this pass consumes

Focus on passes with the highest % of frame — these are where optimization has the most impact.

The comparison section (if present) shows how the current trace compares to the previous one, with per-pass delta percentages.

## Scope

### Read-Only (NEVER edit these)
- `scripts/autoresearch.sh` — the orchestrator
- `scripts/autoresearch-gpu/` — this program config
- `scripts/measure-gpu.sh` — the metric extraction script
- `scripts/measure-cpu.sh` — the CPU metric script
- `scripts/measure-memory.sh` — the memory metric script
- `scripts/profile*.sh` — all profiling scripts
- `scripts/analyze-*.py` — all analysis scripts
- `scripts/profile-scenes/default.jsonl` — reproducible scene setup

### Mutable
- Any file under `src/` — shaders, render passes, geometry, pipeline setup, everything is fair game
- `Cargo.toml` — only for feature flags or dependency options (no new deps)

## Rules

- **One change per iteration.** Don't combine multiple optimizations — the orchestrator can't tell which one helped.
- **Visual fidelity matters.** Don't degrade visual quality for speed. Reducing resolution is OK only when the difference is imperceptible (e.g., bloom blur at half-res). If in doubt, preserve quality.
- **Hard quality floors — never touch these:**
  - MSAA sample count (4x is the minimum — aliasing on laser lines is immediately visible)
  - Output/viewport resolution
  - Color depth or precision of final output
  - Number of blend/composite passes that affect visual correctness
  - Any change that makes edges, lines, or geometry visibly rougher
- **No new dependencies.** Only what's already in `Cargo.toml`.
- **Validate before exiting.** Don't leave broken code for the orchestrator to measure.
- **Read the analysis.** Don't guess at bottlenecks — let the GPU timing data tell you where time is spent. Optimize the hottest pass first.
- **Follow CLAUDE.md.** Test-first development, conventional commits, no over-engineering. These rules still apply.

## Tips

- GPU render passes are defined in `src/ui/preview/` (bloom, afterglow, composite) and `src/beam_view/` (scene, beams). Check `src/gpu_profiler.rs` to understand how profiling scopes wrap passes.
- Shader source files are in `src/ui/preview/shaders/` and `src/beam_view/shaders/`. WGSL is the shader language.
- When a pass shows high time but does simple work, the bottleneck is likely fillrate (large render target) or memory bandwidth (large textures). Reducing resolution is often more effective than shader simplification.
- The beam view renders the same scene twice (board mini + floating window) with independent cameras. If beam view passes dominate, check whether the second view can be skipped when not visible.
- Bloom and afterglow use multi-pass blur chains. Each blur iteration doubles the GPU cost — reducing iterations by 1 can cut blur time nearly in half.
