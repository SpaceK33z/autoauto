# Glossary

Quick reference for the core AutoAuto terms.

| Term | Definition |
|------|------------|
| **Autoresearch** | Autonomous experiment loop: define a metric, let an agent change code, measure, keep improvements, discard failures, repeat. |
| **Program** | Reusable optimization target in `.autoauto/programs/<slug>/` with `program.md`, `measure.sh`, and `config.json`. |
| **Run** | One execution of a program. Has its own branch, run dir, state, and results log. |
| **Experiment** | One loop iteration: fresh agent, one change, one commit, one keep/discard/crash decision. |
| **Baseline** | Current metric value to beat. Re-measured after keeps and periodically after discards. |
| **Original baseline** | Metric value at experiment 0. Used for overall improvement reporting. |
| **Keep** | Accepted experiment: improved beyond noise threshold (or statistically significant improvement via Mann-Whitney U, p < 0.05) and passed all quality gates. |
| **Discard** | Rejected experiment: regressed, stayed within noise, or failed a quality gate. Reverted in the worktree with `git reset --hard`. |
| **Crash** | Failed experiment: agent error, timeout, invalid output, lock violation, or measurement failure. |
| **Metric field** | Primary numeric output being optimized, e.g. `lcp_ms`. |
| **Direction** | Whether the metric is `"lower"`-is-better or `"higher"`-is-better. |
| **Noise threshold** | Minimum relative improvement required to count as real signal. Can be overridden by Mann-Whitney U statistical significance (p < 0.05). |
| **p-value** | Two-sided Mann-Whitney U p-value comparing baseline vs experiment samples. Shown as `p≤` when at the minimum for the sample size. |
| **Quality gate** | Secondary metric with a hard min/max threshold that must not be violated. |
| **Secondary metric** | Informational tracked metric shown to the agent but not used as a hard gate. |
| **Repeats** | Number of measurement runs per experiment. AutoAuto compares medians. |
| **CV%** | Coefficient of variation. Setup-time stability grade for a measurement. |
| **Context packet** | One-shot experiment input: baseline, recent results, discarded diffs, git history, backlog notes. |
| **Ideas backlog** | Optional `ideas.md` file with what was tried, why it worked or failed, and what to try next. |
| **Carry forward** | Cross-run memory: previous run results and ideas fed into new experiments. Enabled by default; disable with `--no-carry-forward`. |
| **Previous run context** | Kept experiment summaries + ideas backlog from earlier completed runs of the same program. |
| **Simplicity criterion** | Within-noise experiments with net-negative LOC can be auto-kept. |
| **Worktree** | AutoAuto-owned git worktree used for isolated experiment execution. |
| **In-place mode** | Optional mode that skips worktree isolation and runs directly in the main checkout. |
| **Measurement locking** | `chmod 444` on measurement files before the loop to prevent evaluator tampering. |
| **Lock violation** | Experiment touched protected `.autoauto/` files. Immediate discard. |
| **Results TSV** | Append-only `results.tsv` log of experiment outcomes. |
| **Diff stats** | Added/removed line counts recorded per experiment. |
| **Daemon** | Background process that runs the loop detached from the TUI. |
| **Queue** | Sequential list of pending runs in `.autoauto/queue.json`. Drains automatically via daemon chaining. |
| **Queue chaining** | Completing daemon pops the next queue entry and spawns a new daemon for it. |
| **Program exclusivity** | A program is either queue-managed or manually run, never both at the same time. |
| **Budget cap** | Optional `max_cost_usd` limit that stops a run when cumulative agent cost exceeds the threshold. |
| **Budget exceeded** | Termination reason when a run's cumulative cost hits the budget cap. |
| **Finalize Agent** | Post-run reviewer that summarizes the run and can group changed files into reviewable branches. |
| **Finalized run** | A completed run that has been packaged onto a branch. Tracked via `finalized_at` (timestamp) and `finalized_branch` (target branch) in `state.json`. |
| **Support slot** | Model config used for conversational agents (Setup, Update, Finalize). Defaults to Opus / high effort. |
| **Execution slot** | Model config used for the Experiment agent. Defaults to Sonnet / high effort. |
| **caffeinate** | macOS utility spawned alongside the daemon to prevent idle sleep during runs. Auto-exits when the daemon stops. |
