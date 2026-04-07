# Phase 2: Execution (MVP)

High-level tasks to complete the orchestrator loop described in [IDEA.md](./IDEA.md#phase-2-execution-mvp).

## 2a. Branch & Baseline

- [x] Create a dedicated experiment branch from current HEAD
- [x] Run `measure.sh` to establish baseline metric
- [x] Store baseline in `state.json`
- [x] Lock `measure.sh` and `config.json` (`chmod 444`) before loop starts

## 2b. Experiment Loop

- [ ] Build context packet for each iteration (baseline, recent results.tsv rows, git log, last outcome summary, discarded diffs)
- [ ] Spawn fresh Experiment Agent with context packet + `program.md` instructions
- [ ] Agent tools: read files, edit files, bash (git commit, builds, web search)
- [ ] Enforce single-commit-per-experiment discipline
- [ ] Detect and reject agent attempts to modify locked `measure.sh` / `config.json`

## 2c. Measurement & Decision

- [ ] Run `measure.sh` N times (repeats from config), take median
- [ ] Compare against baseline + noise threshold
- [ ] Check all quality gates pass
- [ ] **Keep**: improvement beyond threshold + gates pass → update baseline, log to results.tsv
- [ ] **Discard**: `git revert` the commit, log to results.tsv with reason
- [ ] Re-measure baseline after keeps (code changed) and after consecutive discards (environment drift)

## 2d. Results Tracking

- [ ] Append each experiment to `results.tsv` (experiment#, commit, metric_value, secondary_values, status, description)
- [ ] Write/update `state.json` (current experiment #, status, baseline)

## 2e. Run Termination

- [ ] Manual stop: kill current experiment immediately, revert uncommitted changes
- [ ] Max experiment count: stop after current experiment finishes
- [ ] Prompt user: run cleanup or abandon

## 2f. Execution Dashboard (TUI)

- [ ] Current experiment # / total keeps / discards
- [ ] Current baseline metric value
- [ ] Best metric achieved + improvement % from original baseline
- [ ] Live results table
- [ ] Streaming agent thinking text in a styled panel (view-only)
- [ ] Sparkline or bar chart of metric over time
