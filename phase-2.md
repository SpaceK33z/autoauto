# Phase 2: Execution (MVP)

High-level tasks to complete the orchestrator loop described in [IDEA.md](./IDEA.md#phase-2-execution-mvp).

## 2a. Branch & Baseline

- [x] Create a dedicated experiment branch from current HEAD
- [x] Run `measure.sh` to establish baseline metric
- [x] Store baseline in `state.json`
- [x] Lock `measure.sh` and `config.json` (`chmod 444`) before loop starts

## 2b. Experiment Loop

- [x] Build context packet for each iteration (baseline, recent results.tsv rows, git log, last outcome summary, discarded diffs)
- [x] Spawn fresh Experiment Agent with context packet + `program.md` instructions
- [x] Agent tools: read files, edit files, bash (git commit, builds, web search)
- [x] Enforce single-commit-per-experiment discipline
- [x] Detect and reject agent attempts to modify locked `measure.sh` / `config.json`

## 2c. Measurement & Decision

- [x] Run `measure.sh` N times (repeats from config), take median
- [x] Compare against baseline + noise threshold
- [x] Check all quality gates pass
- [x] **Keep**: improvement beyond threshold + gates pass → update baseline, log to results.tsv
- [x] **Discard**: `git revert` the commit, log to results.tsv with reason
- [x] Re-measure baseline after keeps (code changed) and after consecutive discards (environment drift)

## 2d. Results Tracking

- [x] Append each experiment to `results.tsv` (experiment#, commit, metric_value, secondary_values, status, description)
- [x] Write/update `state.json` (current experiment #, status, baseline)

## 2e. Run Termination

- [x] Manual stop: kill current experiment immediately, revert uncommitted changes
- [x] Max experiment count: stop after current experiment finishes
- [x] Prompt user: run cleanup or abandon

## 2f. Execution Dashboard (TUI)

- [ ] Current experiment # / total keeps / discards
- [ ] Current baseline metric value
- [ ] Best metric achieved + improvement % from original baseline
- [ ] Live results table
- [ ] Streaming agent thinking text in a styled panel (view-only)
- [ ] Sparkline or bar chart of metric over time
