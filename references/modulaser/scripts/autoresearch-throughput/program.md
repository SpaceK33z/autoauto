# Autoresearch: Pipeline Throughput

You are one iteration of an autonomous hill-climbing loop that makes Modulaser's rendering + safety pipeline process more laser points per second. An external orchestrator handles measurement, keep/discard, and rollback. Your job: analyze, implement ONE optimization, validate, and commit.

## Your Task

1. **ANALYZE**: Read the newest throughput analysis in `.traces/autoresearch-throughput/`. Read `.traces/autoresearch-throughput/autoresearch-results.tsv`. Read recent git history with `git log --oneline --decorate -n 20`. Inspect reverted experiment commits with `git show <commit>` before retrying an idea.

2. **PLAN**: Pick ONE optimization in the rendering/safety path. State it in one sentence. Expected targets: path conversion, blanking transitions, drawability, motion safety, energy safety, invariants, allocations, SIMD-friendly loops.

3. **IMPLEMENT**: Edit source code. One change only. Follow repo rules: root-cause fixes, no benchmark gaming, no safety bypasses, no mutable benchmark harness.

4. **VALIDATE**: Run:
   ```bash
   cargo check --all-targets && cargo test --quiet && cargo clippy --all-targets -- -D warnings
   ```
   Fix failures before exiting.

5. **COMMIT**: Stage and commit:
   ```bash
   git add -A && git commit -m "perf(scope): description"
   ```

Then EXIT. The orchestrator handles measurement and keep/discard.

## Metric

**Points per second through the output conversion + safety pipeline. Higher = better.**

The harness feeds a fixed synthetic corpus through:

1. `convert_frame_graph_for_laser`
2. `apply_motion_safety_pipeline`
3. `apply_energy_safety`
4. `repair_points_in_place`

The loop rejects changes if the fixed-output digest or exact point counts change.

## Read-Only

Do not edit these files:

- `src/throughput.rs`
- `src/bin/throughput_measure.rs`
- `benches/pipeline_throughput.rs`
- `scripts/measure-throughput.sh`
- `scripts/profile-throughput.sh`
- `scripts/autoresearch-throughput/`

These define the metric and quality gate. Changing them is benchmark tampering.

## Mutable

- `src/pipeline/`
- `src/engine/`
- `src/dac/`
- `src/laser*.rs`
- `Cargo.toml` only for compile flags or dependency options already present

## Rules

- One optimization per iteration.
- Keep output identical for the fixed corpus.
- No safety weakening. Motion, energy, invariants stay semantically equivalent.
- Prefer simpler code when throughput is equal.
- No new dependencies.
- Validate before exit.

## Hints

- `docs/ofxlaser-point-optimization-analysis.md` documents known point-optimization opportunities.
- `docs/pipeline/safety.md` describes the required safety order and state continuity.
- Allocation cuts, branch cuts, tighter loops, and avoiding unnecessary intermediate vectors are all in scope.
