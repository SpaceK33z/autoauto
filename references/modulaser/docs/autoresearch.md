# Autoresearch

Autonomous performance optimization using AI coding agents. A generic orchestrator (`scripts/autoresearch.sh`) spawns a fresh agent session per iteration. The agent analyzes profiling data, implements one change, validates, and commits. The orchestrator then builds, measures, and keeps or discards the change based on the metric.

## Files

```
scripts/
  autoresearch.sh                  # Generic orchestrator (the loop)
  autoresearch-perf/
    config.sh                      # CPU program config
    program.md                     # CPU agent instructions
  autoresearch-memory/
    config.sh                      # Memory program config
    program.md                     # Memory agent instructions
  autoresearch-gpu/
    config.sh                      # GPU program config
    program.md                     # GPU agent instructions
  autoresearch-egui/
    config.sh                      # egui UI program config
    program.md                     # egui UI agent instructions
  autoresearch-throughput/
    config.sh                      # pipeline throughput program config
    program.md                     # throughput agent instructions
  measure-cpu.sh                   # Launch app, sample CPU%, output JSON
  measure-memory.sh                # Launch app with DHAT, output JSON
  measure-gpu.sh                   # Launch app with gpu-profile, output JSON
  measure-throughput.sh            # Run standalone pipeline throughput binary, output JSON
  profile-throughput.sh            # Write stage breakdown analysis for throughput runs
  test-autoresearch.sh             # Integration tests
  profile-scenes/default.jsonl     # Reproducible scene (control socket commands)
```

The measurement scripts are also used by the standalone profiling tools (`profile.sh`, `profile-gpu.sh`, `profile-memory.sh`).

## Programs

Five optimization targets, each with its own measurement script and agent instructions:

| Program | Metric | Direction | Measurement | Repeats | State |
|---------|--------|-----------|-------------|---------|-------|
| `autoresearch-perf` | avg CPU % | lower | `measure-cpu.sh` | `3` | `.traces/autoresearch-perf/` |
| `autoresearch-memory` | total heap bytes | lower | `measure-memory.sh` | `1` | `.traces/autoresearch-memory/` |
| `autoresearch-gpu` | avg GPU ms/frame | lower | `measure-gpu.sh` | `3` | `.traces/autoresearch-gpu/` |
| `autoresearch-egui` | avg egui render_panels μs | lower | `measure-cpu.sh` | `3` | `.traces/autoresearch-egui/` |
| `autoresearch-throughput` | points/sec | higher | `measure-throughput.sh` | `5` | `.traces/autoresearch-throughput/` |

### Prerequisites

- A reproducible scene setup file at `scripts/profile-scenes/default.jsonl` (control socket commands replayed after launch). If you already have `.traces/profile-setup.jsonl` from `/profile`, copy it there or set `PROFILE_SETUP_FILE`.
- No running Modulaser instance (the measurement scripts check for this).

### Running

```bash
# Run one program (loops forever until Ctrl-C):
./scripts/autoresearch.sh scripts/autoresearch-perf
./scripts/autoresearch.sh scripts/autoresearch-memory
./scripts/autoresearch.sh scripts/autoresearch-gpu
./scripts/autoresearch.sh scripts/autoresearch-throughput

# Run N iterations then stop:
./scripts/autoresearch.sh scripts/autoresearch-perf --iterations 10

# Setup only (baseline measurement + initial profile, no agent):
./scripts/autoresearch.sh scripts/autoresearch-gpu --setup

# Use Codex instead of Claude:
./scripts/autoresearch.sh scripts/autoresearch-perf --agent codex
```

### Running multiple programs in parallel

Run each program in its own worktree. Inside that worktree, the orchestrator auto-switches to a unique program branch (`autoresearch/perf-*`, `autoresearch/memory-*`, `autoresearch/gpu-*`) and writes traces to a program-specific state directory:

```bash
# Terminal 1 (worktree for CPU)
./scripts/autoresearch.sh scripts/autoresearch-perf

# Terminal 2 (worktree for memory)
./scripts/autoresearch.sh scripts/autoresearch-memory

# Terminal 3 (worktree for GPU)
./scripts/autoresearch.sh scripts/autoresearch-gpu

# Terminal 4 (worktree for egui UI)
./scripts/autoresearch.sh scripts/autoresearch-egui

# Terminal 5 (worktree for throughput)
./scripts/autoresearch.sh scripts/autoresearch-throughput
```

Each run writes results to its own `.traces/autoresearch-*/autoresearch-results.tsv`.

The loops are still not fully independent on one machine: each run now uses its own control-socket runtime directory, but CPU/GPU/memory measurements still interfere with each other through shared machine load. Don't trust concurrent measurements on the same machine unless you intentionally accept that noise.

## How it works

1. **Setup**: Creates a branch, builds, runs the configured number of baseline measurements, takes the median metric, checks quality gates, saves to `autoresearch-results.tsv`
2. **Profile**: Runs the profile command (if configured) to generate analysis for the agent
3. **Agent session**: Spawns Claude/Codex with the program instructions plus a compact context packet: current baseline, recent `results.tsv` rows, recent git experiment history, and a one-line summary of the last outcome. Agent reads profiling data, implements one change, validates, commits.
4. **Build + Measure**: Orchestrator builds and runs the measurement script `MEASURE_REPEATS` times
5. **Keep/Discard**: Compares the median measured metric to the current median baseline. Improved beyond noise threshold → keep. Regressed or within noise → `git revert` the experiment commits so the code returns to the last winning state while preserving history.
6. **Re-profile**: After every keep (fresh profile of the new baseline) and after consecutive discards (give the agent fresh data).
7. **Repeat**: Loop continues until `--iterations N` is reached or Ctrl-C.

### Keep/discard logic

The orchestrator computes the relative change between the baseline median and measured median. If the improvement exceeds `NOISE_THRESHOLD` (a percentage), the commit is kept. If it regresses beyond the threshold, it's discarded. Changes within the noise band are also discarded — the optimization must be clearly measurable to survive.

A `QUALITY_GATE_FIELD` (optional) provides a binary pass/fail check independent of the metric. When repeats are enabled, every repeated measurement must pass the quality gate. For CPU, the quality gate requires FPS to stay above a threshold ratio of the target FPS — this catches optimizations that reduce CPU% by dropping frames. For GPU, it requires enough steady-state frames for a trustworthy comparison.

### Results file

Tab-separated, 5 columns, stored in `$STATE_DIR/autoresearch-results.tsv`:

```
commit    <metric>    <secondary>    status       description
a1b2c3d   45.2        60.0           keep         baseline
b2c3d4e   43.1        60.0           keep         perf(beam-view): precompute divergence
c3d4e5f   44.8        60.0           discard      noise: perf(ui): skip redundant layout
d4e5f6g   0           0              crash        build failed: perf(pipeline): bad refactor
```

Status values: `keep`, `discard`, `skip` (no commit produced), `crash` (build or measurement failed).

Discarded or crashed experiments stay in git history as the original experiment commit plus one or more auto-generated revert commits. This keeps the branch at the current best code while preserving failed ideas for later inspection with `git log` and `git show`.

### Iteration prompt context

Each iteration prompt now includes:

- current baseline metric
- the most recent rows from `autoresearch-results.tsv`
- recent git history (`git log --oneline --decorate`)
- a one-line summary of the latest outcome, such as a regression or noise discard

This keeps the agent aware of recent failures without replacing the source-of-truth files. The prompt is only a summary; deeper investigation still happens via `results.tsv`, git history, and the latest analysis files.

## Measurement scripts

All three scripts share the same pattern: launch the binary, replay the scene setup via `profile-replay.sh`, run for a fixed duration, and output a single JSON line to stdout.

| Script | Binary flags | Warmup handling | Output |
|--------|-------------|-----------------|--------|
| `measure-cpu.sh` | `--debug-socket` (no timeout, killed after sampling) | Explicit sleep, then samples CPU% for DURATION | `{"avg_cpu", "avg_fps", "avg_egui_update_us", "avg_egui_render_us", "quality_gate_passed", ...}` |
| `measure-memory.sh` | `--debug-socket --timeout=WARMUP+DURATION` | Sleep for WARMUP, then wait for auto-exit | `{"total_bytes", "bytes_at_exit", ...}` |
| `measure-gpu.sh` | `--debug-socket --timeout=WARMUP+DURATION` | Post-processing filters warmup frames by timestamp | `{"avg_gpu_ms", "max_gpu_ms", "quality_gate_passed", ...}` |
| `measure-throughput.sh` | `target/profiling/throughput_measure --frames N --warmup-frames M` | Warmup run discarded, measured run emits fixed-corpus throughput | `{"points_per_second", "ns_per_output_point", "quality_gate_passed", ...}` |

DURATION always means the measurement window (after warmup) across all scripts. DHAT captures cumulative allocations over the entire run, so memory warmup serves to let the app reach steady state before the timeout expires.

All scripts clean stale control sockets before launching (worktree-aware) and check that no existing Modulaser instance is running.

## Config variables

Variables set in `config.sh`, sourced by the orchestrator:

| Variable | Required | Description |
|----------|----------|-------------|
| `MEASURE_CMD` | yes | Command that outputs a JSON line to stdout |
| `METRIC_FIELD` | yes | JSON field name for the primary metric |
| `METRIC_DIRECTION` | yes | `"lower"` or `"higher"` — which direction is better |
| `BUILD_CMD` | no | Build command run before each measurement |
| `MEASURE_REPEATS` | no | Number of repeated measurements per baseline/iteration; orchestrator uses the median metric (default: 1) |
| `SECONDARY_FIELD` | no | Additional JSON field to log (not used for keep/discard) |
| `QUALITY_GATE_FIELD` | no | JSON boolean field; `false` → discard regardless of metric |
| `PROFILE_CMD` | no | Command to generate profiling analysis for the agent |
| `NOISE_THRESHOLD` | no | Relative change % below which results are treated as noise (default: 2.0) |
| `MAX_CONSECUTIVE_DISCARDS` | no | Re-profile after this many consecutive discards (default: 5) |
| `MAX_DISCARDS_WITHOUT_KEEP` | no | Stop the loop after this many total non-keeps without any improvement (default: 5). Set to 0 to disable. |
| `PROFILE_EVERY` | no | Re-profile every N iterations even without discards (default: 3) |
| `BRANCH_PREFIX` | no | Git branch prefix (default: `autoresearch`) |
| `STATE_DIR` | no | Directory for results and analysis files (default: `.traces/$PROGRAM_NAME`) |
| `MAX_TURNS` | no | Max agent turns per iteration (default: 200) |
| `AGENT` | no | `claude` or `codex` (default: `claude`) |
| `CLAUDE_ARGS` | no | Extra args passed to `claude` CLI |
| `CODEX_ARGS` | no | Extra args passed to `codex exec` |

## Environment variables

Override behavior without editing config files:

| Variable | Used by | Description |
|----------|---------|-------------|
| `AUTORESEARCH_AGENT` | orchestrator | Override agent (`claude` or `codex`) |
| `AUTORESEARCH_MAX_TURNS` | orchestrator | Override max turns |
| `AUTORESEARCH_PROGRAM_NAME` | orchestrator | Override program name |
| `AUTORESEARCH_STATE_DIR` | orchestrator, measure scripts | Override state/traces directory |
| `PROFILE_BINARY` | measure scripts | Override binary path (default: `target/profiling/modulaser`) |
| `PROFILE_DURATION` | measure scripts | Override measurement duration in seconds (default: 15) |
| `PROFILE_WARMUP` | measure scripts | Override warmup duration in seconds (default: 3) |
| `PROFILE_SETUP_FILE` | measure scripts, `profile.sh` | Override scene setup file path |

## Creating a new program

Create a directory under `scripts/` with two files:

- `config.sh` — shell variables sourced by the orchestrator (see table above)
- `program.md` — agent instructions appended as a system prompt

The program.md should tell the agent: where to find analysis data, what to optimize, what files are read-only vs mutable, and the validation/commit workflow. See `scripts/autoresearch-perf/program.md` for a well-documented example.

---

## Background: Karpathy's Autoresearch

Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) — give an AI coding agent a small LLM training setup and let it experiment autonomously. It edits `train.py`, runs a 5-min training experiment, checks validation loss, keeps improvements, discards failures, loops forever.

## How It Works (The Loop)

The repo is deliberately tiny — three files that matter:

- **`prepare.py`** — read-only. Data prep, tokenizer, dataloader, evaluation function. Agent cannot touch this. This is a key design decision: the entire evaluation pipeline is frozen (data shards, token count, metric computation), which prevents the agent from gaming the metric instead of actually improving the model. Without this immutability, the agent would inevitably learn to optimize the eval rather than the training.
- **`train.py`** — the _only_ file the agent edits. Model architecture, optimizer, hyperparams, training loop — everything is fair game.
- **`program.md`** — instructions for the agent. The human edits this, not the code.

### Setup

1. Create a fresh branch: `git checkout -b autoresearch/<tag>` (e.g. `autoresearch/mar5`)
2. Run the baseline (unmodified `train.py`) to establish starting `val_bpb`
3. Initialize `results.tsv` (untracked by git) with the header row

### The Experiment Loop (runs forever)

```
LOOP FOREVER:
1. Check current git state (branch/commit)
2. Edit train.py with an experimental idea
3. git commit the change
4. Run: uv run train.py > run.log 2>&1
5. Extract results: grep "^val_bpb:\|^peak_vram_mb:" run.log
6. If empty → crash. Read tail -n 50 run.log, try to fix
7. Log results to results.tsv (never committed to git)
8. If val_bpb IMPROVED (lower) → KEEP the commit, advance the branch
9. If val_bpb equal or worse → git reset back to previous commit (DISCARD)
```

Failure handling is core to the loop, not incidental. Crashes are signals about invalid regions of the search space — OOMs tell the agent about memory boundaries, syntax errors about malformed ideas. Timeouts (>10 min) are treated as failures and killed. The agent is expected to self-repair by reading the logs and adjusting. This makes it autonomous debugging + research, not just optimization.

### Git as Memory

This is the clever part — **git IS the state machine**:

- Every experiment is a commit on a dedicated branch
- Improvements advance the branch forward (kept commits)
- Failures get `git reset` back — the branch only ever contains winning changes
- `results.tsv` stays untracked and logs everything (keeps, discards, crashes) as the full experiment history
- The branch tip always represents the current best `train.py`

### Constraints & Rules

- **Fixed 5-min time budget** per experiment (wall clock training time, excluding startup/compilation) — makes all experiments directly comparable regardless of what the agent changed
- **Single metric**: `val_bpb` (validation bits per byte) — lower is better. Crucially vocab-size-independent, which means the agent can freely change the tokenizer, vocab size, sequence length, and still get directly comparable scores. This is what makes the search space genuinely open-ended rather than just hyperparameter tuning — architectural changes are fair game.
- **Simplicity criterion**: small improvement + ugly complexity = not worth it. Equal results + simpler code = definitely keep. Deletion that maintains performance = great outcome.
- **VRAM** is a soft constraint — some increase OK for meaningful gains, but shouldn't blow up
- **Timeout**: if a run exceeds 10 minutes, kill it and treat as failure
- **Never stop**: the agent runs indefinitely until manually interrupted. No asking "should I continue?" — the human might be asleep
- **No new dependencies** — only what's in `pyproject.toml`
- **Fits in context window** — the entire repo is ~630 lines across 3 files, deliberately small enough that the agent can hold the whole system in-context at once. This reduces hallucinated edits and broken code — the agent always "sees" everything, never works from partial understanding.

### Results Logging (results.tsv)

Tab-separated, 5 columns:

```
commit    val_bpb    memory_gb    status       description
a1b2c3d   0.997900   44.0         keep         baseline
b2c3d4e   0.993200   44.2         keep         increase LR to 0.04
c3d4e5f   1.005000   44.0         discard      switch to GeLU activation
d4e5f6g   0.000000   0.0          crash        double model width (OOM)
```

## Key Results

- Karpathy's first overnight run: **700 experiments in 2 days**, found ~20 improvements → **11% reduction** in time-to-GPT-2
- SkyPilot scaled it to 16 GPUs: **910 experiments in 8 hours**, reached same results **9x faster** than sequential

## It's a Hill-Climber (and That's the Limitation)

The core loop is greedy local search: try a change, keep if better, discard if not. There's no inherent mechanism for exploration vs exploitation, no way to revisit discarded ideas that might combine well with later changes, and no global search strategy. The agent can only see the current branch tip — it has no memory of what it already tried beyond results.tsv (which it reads but doesn't systematically mine).

This is why diminishing returns hit fast: the agent quickly finds the local hilltop and then grinds for marginal gains. It's also why the variants exist — SkyPilot's parallelism adds implicit exploration (multiple directions at once), autoresearch-engram adds persistent memory so the agent learns across runs, and people are experimenting with bandit strategies and population-based approaches to escape local optima.

## Diminishing Returns

Clear pattern of diminishing returns per phase — the SkyPilot blog quantified it nicely:

- Phase 1 (hyperparams): 1.003 → 0.981 (Δ = 0.022)
- Phase 2 (architecture): 0.981 → 0.977 (Δ = 0.004)
- Phase 3 (fine-tuning): 0.977 → 0.975 (Δ = 0.002)
- Phase 4+: returns dropped below 0.0001 per experiment

After phase 4, the improvement curve basically flatlines. The easy wins get found fast, then it's grinding for crumbs.

## Claude Code Adaptations

People are generalizing the autoresearch loop beyond ML training to work with Claude Code:

- [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch) — Claude Code skill that applies the pattern to **any domain** (code, content, marketing, DevOps). Core principle: one metric + constrained scope + fast verification + automatic rollback + git as memory.
- [drivelineresearch/autoresearch-claude-code](https://github.com/drivelineresearch/autoresearch-claude-code) — port as a pure skill (no MCP server), just instructions Claude Code follows with built-in tools.
- [r/ClaudeCode thread](https://www.reddit.com/r/ClaudeCode/comments/1rsur5s/i_built_a_claude_code_skill_that_applies/) — discussion on applying it to non-ML tasks
- MindStudio wrote guides on pairing Claude Code + autoresearch for self-improving AI skills with eval assertions and pass rate tracking

The key insight: **constraint + mechanical metric + autonomous iteration = compounding gains**. Works anywhere you have a number you can measure.

## Codex / Other Agents

- The original autoresearch is agent-agnostic — Karpathy used Claude Code (via `program.md` instructions)
- SkyPilot's scaling experiment also used Claude Code as the agent
- [autoresearch-anything](https://github.com/zkarimi22/autoresearch-anything) — fork to generalize beyond nanochat
- [autoresearch-engram](https://github.com/tonitangpotato/autoresearch-engram) — adds persistent memory so the agent learns which approaches worked across runs
- Someone on Medium applied it to prompt optimization: 14 runs, went from 24/40 → **40/40** (66.7% improvement)

## What People Are Using It For

- **ML training optimization** — the original use case. Hyperparams, architecture tweaks, optimizer settings
- **Prompt engineering** — iteratively improving system prompts with eval assertions (24/40 → 40/40 in one example)
- **Code performance** — optimizing algorithms, reducing latency, improving benchmarks
- **Content/copy optimization** — A/B testing marketing copy, sales emails against engagement metrics
- **DevOps configs** — tuning infrastructure settings against performance/cost metrics
- **Claude Code skills** — self-improving agent skills with pass rate tracking
- **Research paper reproduction** — running variations on published results autonomously

The pattern works anywhere you have: a measurable metric + a file to mutate + a fast feedback loop.

## Links

- [GitHub repo](https://github.com/karpathy/autoresearch)
- [eCLIP Autoresearch — Yogesh Kumar](https://ykumar.me/blog/eclip-autoresearch/) — blogpost about trying it, noted diminishing returns after phase 4
- [SkyPilot: Scaling Autoresearch](https://blog.skypilot.co/scaling-autoresearch/) — 16 GPU cluster experiment
- [VentureBeat article](https://venturebeat.com/technology/andrej-karpathys-new-open-source-autoresearch-lets-you-run-hundreds-of-ai)
- [Fortune: 'The Karpathy Loop'](https://fortune.com/2026/03/17/andrej-karpathy-loop-autonomous-ai-agents-future/)

## Not Hyperparameter Tuning — Program Synthesis

Important distinction: tools like Optuna search a fixed parameter space (learning rate, batch size, etc.). Autoresearch is fundamentally different — the agent edits arbitrary code. The search space is "everything expressible in train.py": new architectures, different optimizers, custom schedulers, novel attention patterns, entirely new training techniques. That's not tuning — it's program synthesis with a fitness function.

## The Real Bottleneck: program.md

The quality of the entire system depends on program.md — how you phrase goals, constrain exploration, and encode heuristics. This is where the human's leverage is highest. A vague program.md produces random walks; a well-crafted one produces directed search. People are already converging on "prompt engineering for research policies" as its own emerging discipline. Karpathy's default program.md is intentionally bare-bones — iterating on it to find the "research org code" that achieves the fastest progress is itself an open problem.

## Meta Takeaway

The role of the human shifts from "experimenter" to "experimental designer." The bottleneck isn't coding anymore — it's defining the right constraints and metrics for the search.
