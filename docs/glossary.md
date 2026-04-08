# Glossary

| Term | Definition |
|---|---|
| **Autoresearch** | Autonomous experiment loop: AI agent iterates changes, measures results, keeps improvements, discards failures. |
| **Project** | The target codebase being optimized. AutoAuto state lives in `.autoauto/`. |
| **Program** | A reusable optimization target with metric, measurement script, agent instructions, and scope constraints. Lives in `.autoauto/programs/<slug>/`. |
| **Run** | One execution session of a program. Isolated on a dedicated git branch (`autoauto-<slug>-<timestamp>`). |
| **Experiment** | A single loop iteration: agent proposes a change, commits it, orchestrator measures, then keeps or discards. |
| **Baseline** | The current metric value to beat. Re-measured after keeps and after consecutive discards (drift detection). |
| **Original baseline** | Metric value at experiment 0. Frozen for the run; used to compute overall improvement %. |
| **Candidate** | A committed change not yet measured. Becomes a keep or discard after measurement. |
| **Keep** | Accepted experiment — improvement exceeded noise threshold and all quality gates passed. |
| **Discard** | Rejected experiment — regressed, within noise, or failed a quality gate. Reverted via `git revert`. |
| **Crash** | Experiment that failed due to agent error, lock violation, no commit, or measurement failure. |
| **Metric field** | The primary numeric output being optimized (e.g. `lcp_ms`). Must be a finite number in measure.sh output. |
| **Direction** | Whether the metric optimizes `"lower"` or `"higher"`. |
| **Noise threshold** | Minimum relative improvement (decimal fraction, e.g. 0.02 = 2%) to accept a change. Below = noise. |
| **Quality gate** | Secondary metric that must not regress (e.g. CLS while optimizing LCP). Has min/max thresholds. |
| **Measurement series** | N repeated runs of measure.sh, returning median values for robust comparison. |
| **Repeats** | How many times measure.sh runs per experiment (typically 3–5). |
| **CV%** | Coefficient of variation — measurement stability grade. <5% excellent, 5–15% acceptable, 15–30% noisy, 30%+ unstable. |
| **Re-baseline** | Fresh baseline measurement after keeps or after 5 consecutive discards to detect environment drift. |
| **Context packet** | One-shot message to the Experiment Agent: baseline, recent results, git log, discarded diffs, program.md. |
| **Experiment Agent** | Short-lived one-shot Claude session. Receives context packet, makes one change, commits, exits. |
| **Setup Agent** | Multi-turn Claude session that inspects the repo, generates program artifacts, and validates measurement stability. |
| **Update Agent** | Multi-turn Claude session that reviews previous run results and updates program artifacts (program.md, measure.sh, config.json) for re-optimization. |
| **Finalize Agent** | Reviews accumulated diff, groups changes into independent branches (or squashes as fallback), and produces a summary. |
| **Model slot** | Provider + model + effort config. Two slots: `executionModel` (experiments) and `supportModel` (setup/finalize). |
| **Measurement locking** | `chmod 444` on measure.sh/config.json before the loop. Prevents agent from gaming the metric. |
| **Lock violation** | Agent modified `.autoauto/` files — immediate discard. |
| **Verdict** | Comparison result: `"keep"`, `"regressed"`, or `"noise"`. |
| **Sparkline** | Unicode bar chart of keep-only metric values (▁▂▃▄▅▆▇█). |
| **Discarded diffs** | Recent reverted diffs included in context packet so the agent learns from failures. |
| **Experiment cost** | Per-experiment SDK usage: cost USD, duration, tokens in/out, turns. |
| **Results TSV** | Append-only log of experiment outcomes (one row per experiment). |
| **Ideas backlog** | Optional `ideas.md` file that accumulates per-experiment notes (hypothesis, failure reason, next ideas, things to avoid). Prevents the agent from retrying failed approaches. |
| **Secondary metric** | A tracked metric (with direction) that appears in context packets but has no hard threshold — informational, not a gate. |
| **Agent provider** | Pluggable backend that implements `AgentProvider` (create sessions, check auth, list models). Three built-in: Claude, Codex, OpenCode. |
| **Simplification** | An experiment within noise that has net-negative LOC (more lines removed than added). Auto-kept by the simplicity criterion. |
| **In-place mode** | Optional run mode that skips worktree isolation — experiments run directly in the main checkout. |
| **Diff stats** | Lines added/removed per experiment, used by the simplicity criterion and stored in results.tsv. |
| **State (state.json)** | Atomic checkpoint: run phase, experiment number, baselines, SHAs, timestamps. |
| **Consecutive discards** | Counter of non-keep outcomes in a row. Triggers re-baselining every 5. |
| **Scope constraints** | program.md rules defining what files/systems the agent may modify. |
| **Build script** | Optional `build.sh` — runs once before the measurement series. |
| **Worktree** | AutoAuto-owned git worktree (`.autoauto/worktrees/<runId>/`) used as the agent's isolated working directory during a run. |
| **Daemon** | Background process (`src/daemon.ts`) that runs the experiment loop detached from the TUI, surviving terminal close. Communicates via filesystem IPC. |
| **Measure script** | `measure.sh` — outputs a single JSON object with the metric and quality gate values. |
