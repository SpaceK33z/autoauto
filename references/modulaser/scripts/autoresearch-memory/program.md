# Autoresearch: Heap Memory Optimization

You are one iteration of an autonomous hill-climbing loop that reduces Modulaser's heap allocations. An external orchestrator handles the loop, measurement, and keep/discard decisions. Your job: analyze, implement ONE optimization, validate, and commit.

## Your Task

1. **ANALYZE**: Read the most recent memory analysis in `.traces/autoresearch-memory/` (the newest `*.txt` file) to identify the top allocation hotspot. Read `.traces/autoresearch-memory/autoresearch-results.tsv` to see what's been tried before. Read recent git history with `git log --oneline --decorate -n 20` and inspect reverted experiment commits with `git show <commit>` so you don't repeat discarded approaches.

2. **PLAN**: Pick ONE concrete optimization target. Describe it in one sentence. Think about what files need to change and the expected effect.

3. **IMPLEMENT**: Edit source code. Keep changes minimal and focused — one optimization per iteration. Follow all rules in CLAUDE.md (test-first for non-UI changes, no over-engineering, code style).

4. **VALIDATE**: Run:
   ```bash
   cargo check --all-targets && cargo test --quiet && cargo clippy --all-targets -- -D warnings
   ```
   If this fails, fix the issue. Do NOT skip validation. Do NOT discard changes yourself — if you can't fix validation, just exit without committing and the orchestrator will handle cleanup.

5. **COMMIT**: Stage and commit:
   ```bash
   git add -A && git commit -m "perf(scope): description"
   ```

Then EXIT. The orchestrator handles building with DHAT, measuring, and keep/discard.

## Metric

**Total heap bytes allocated** across a reproducible DHAT run that replays the scene setup, warms up, then runs for a fixed steady-state interval. Lower = better. This captures both allocation frequency and allocation size — fewer or smaller allocations both help.

Secondary metric: **bytes at exit** (retained memory). Tracked but not used for keep/discard.

You don't run the measurement — the orchestrator does. The binary is built with `--features dhat-heap` which enables DHAT heap profiling. Every allocation is tracked.

## What to Optimize

### High-Impact Patterns

- **Allocation churn**: Hot loops that allocate and free every frame. Fix: reuse buffers, pre-allocate Vec capacity, use `SmallVec` for small collections.
- **Large transient allocations**: Big buffers created and dropped repeatedly. Fix: hoist allocation out of the loop, reuse across frames.
- **Dominant allocators**: A single call site responsible for >20% of all bytes. Focus here first.
- **String formatting in hot paths**: `format!()`, `to_string()` in per-frame code. Fix: avoid or cache.
- **Unnecessary clones**: `.clone()` on large data where a reference suffices.
- **Vec growth patterns**: Vecs that grow by doubling when final size is predictable. Fix: `Vec::with_capacity()`.

### Lower-Impact (Still Valid)

- **Container right-sizing**: HashMap/HashSet with known size — use `with_capacity()`.
- **Enum size reduction**: Large enums where one variant bloats the whole type. Fix: box the large variant.
- **Redundant intermediate collections**: `.collect::<Vec<_>>()` followed by iteration. Fix: chain iterators.

## Scope

### Read-Only (NEVER edit these)
- `scripts/autoresearch.sh` — the orchestrator
- `scripts/autoresearch-memory/` — this program config
- `scripts/measure-memory.sh` — the metric extraction script
- `scripts/measure-cpu.sh` — the CPU metric script
- `scripts/measure-gpu.sh` — the GPU metric script
- `scripts/profile*.sh` — all profiling scripts
- `scripts/analyze-*.py` — all analysis scripts
- `scripts/profile-scenes/default.jsonl` — reproducible scene setup

### Mutable
- Any file under `src/` — architecture, algorithms, data structures, everything is fair game
- `Cargo.toml` — only for feature flags or dependency options (no new deps)

## Rules

- **One change per iteration.** Don't combine multiple optimizations — the orchestrator can't tell which one helped.
- **Correctness first.** Never sacrifice correctness for fewer allocations. If a buffer reuse changes behavior, don't do it.
- **No new dependencies.** Only what's already in `Cargo.toml`.
- **Validate before exiting.** Don't leave broken code for the orchestrator to measure.
- **Read the analysis.** Don't guess at hotspots — let the DHAT data tell you where allocations happen. Optimize the hottest site first.
- **Follow CLAUDE.md.** Test-first development, conventional commits, no over-engineering. These rules still apply.

## Tips

- The "Laser Points Change Every Frame" note in CLAUDE.md is important — point data changes every frame, so per-frame allocation for point buffers is expected. But you CAN reuse the buffer itself (clear + refill vs drop + reallocate).
- System allocator functions (`alloc::`, `hashbrown::`) in the analysis trace back to app code. Follow the call site column to find the actual Modulaser code responsible.
- Module breakdown shows which subsystems allocate most. Start with the biggest module.
- `bytes_at_exit` tracks retained memory. High retained memory that grows over time suggests unbounded caches.
