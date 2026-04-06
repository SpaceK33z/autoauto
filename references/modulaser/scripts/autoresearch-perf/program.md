# Autoresearch: CPU Performance Optimization

You are one iteration of an autonomous hill-climbing loop that makes Modulaser faster. An external orchestrator handles the loop, measurement, and keep/discard decisions. Your job: analyze, implement ONE optimization, validate, and commit.

## Your Task

1. **ANALYZE**: Read the most recent profile analysis in `.traces/autoresearch-perf/` (the newest `*.txt` file) to identify the top bottleneck by self time. Read `.traces/autoresearch-perf/autoresearch-results.tsv` to see what's been tried before. Read recent git history with `git log --oneline --decorate -n 20` and inspect reverted experiment commits with `git show <commit>` so you don't repeat discarded approaches. Read `docs/performance-tradeoffs.md` for historical context.

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

Then EXIT. The orchestrator handles building, measuring, and keep/discard.

## Metric

**Average FPS** (uncapped) during a fixed 15-second measurement window with a reproducible scene. Higher = better. The app runs with `--uncapped-fps` which disables vsync and the pipeline frame rate cap, so the entire system renders as fast as possible. You don't run the measurement — the orchestrator does.

Secondary metric: **avg_cpu** (logged but not used for keep/discard).

## Scope

### Read-Only (NEVER edit these)
- `scripts/autoresearch.sh` — the orchestrator
- `scripts/autoresearch-perf/` — this program config
- `scripts/measure-cpu.sh` — the metric extraction script
- `scripts/measure-gpu.sh` — the GPU metric script
- `scripts/measure-memory.sh` — the memory metric script
- `scripts/profile.sh` — full CPU profiling
- `scripts/profile-*.sh` — all profiling support scripts
- `scripts/analyze-*.py` — all analysis scripts
- `scripts/profile-scenes/default.jsonl` — reproducible scene setup

### Mutable
- Any file under `src/` — architecture, algorithms, data structures, everything is fair game
- `Cargo.toml` — only for feature flags or dependency options (no new deps)

## Rules

- **One change per iteration.** Don't combine multiple optimizations — the orchestrator can't tell which one helped.
- **Simplicity wins.** Small improvement + ugly complexity = not worth it. Equal FPS + simpler code = definitely keep. Deletion that maintains performance = great outcome.
- **No new dependencies.** Only what's already in `Cargo.toml`.
- **Validate before exiting.** Don't leave broken code for the orchestrator to measure.
- **Read the profile.** Don't guess at bottlenecks — let the data tell you where time is spent. Optimize the hottest function first.
- **Follow CLAUDE.md.** Test-first development, conventional commits, no over-engineering. These rules still apply.

## Tips

- The "Laser Points Change Every Frame" note in CLAUDE.md is important — don't try to cache point-derived data unless inputs are actually stable
- System-level costs (malloc, memcpy, trig) in the profile trace back to app code that causes them — follow the call stacks
- When the profile shows high time in `epaint`/`egui`, the fix is usually in Modulaser's UI code (reducing what we ask egui to paint), not in egui itself
