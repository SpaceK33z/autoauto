#!/usr/bin/env bash
set -euo pipefail

print_final_results() {
    if [ -n "${RESULTS_FILE:-}" ] && [ -f "${RESULTS_FILE:-}" ]; then
        echo ""
        echo "========================================="
        echo "  Final Results"
        echo "========================================="
        print_results_all 2>/dev/null || true
    fi
}

cleanup_unverified() {
    if [ -n "${START_HEAD:-}" ]; then
        local current_head
        current_head=$(git rev-parse HEAD 2>/dev/null || true)
        if [ -n "$current_head" ] && [ "$current_head" != "$START_HEAD" ]; then
            echo "Reverting unverified commits from interrupted iteration..."
            git reset --hard "$START_HEAD" 2>/dev/null || true
        fi
    fi
}

trap 'echo ""; echo "Interrupted. Exiting."; cleanup_unverified; print_final_results; exit 130' INT HUP TERM

# autoresearch.sh — Generic autoresearch orchestrator.
#
# Spawns a fresh coding-agent session per iteration. The agent does the
# creative work (analyze, implement, validate, commit). This script does the
# mechanical work (build, measure, keep/discard, log, re-profile).
#
# Domain-specific config lives in a program directory containing:
#   config.sh  — shell variables (BUILD_CMD, MEASURE_CMD, METRIC_FIELD, etc.)
#   program.md — agent instructions
#
# Usage:
#   ./scripts/autoresearch.sh <program-dir>                  # run in worktree + tmux
#   ./scripts/autoresearch.sh <program-dir> --iterations 10  # run N iterations
#   ./scripts/autoresearch.sh <program-dir> --setup          # setup only
#   ./scripts/autoresearch.sh <program-dir> --no-tmux        # run without tmux
#   ./scripts/autoresearch.sh <program-dir> --no-worktree    # run in place
#   ./scripts/autoresearch.sh <program-dir> --parallel 3     # 3 workers in parallel
#
# Example:
#   ./scripts/autoresearch.sh scripts/autoresearch-perf

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# --- Parse arguments ---

PROGRAM_DIR=""
MAX_ITERATIONS=10
SETUP_ONLY=false
PROFILE_EVERY_OVERRIDE=""
AGENT_OVERRIDE=""
THINKING="medium"
USE_TMUX=true
USE_WORKTREE=true
PARALLEL=0
BRANCH_PREFIX="autoresearch"

# Auto-disable interactive wrapping when there's no TTY (CI, piped, tests)
if [ ! -t 1 ]; then
    USE_TMUX=false
    USE_WORKTREE=false
fi

if [ $# -lt 1 ]; then
    echo "Usage: $0 <program-dir> [options]" >&2
    echo "" >&2
    echo "Options:" >&2
    echo "  --iterations N, -n N   Run N iterations then stop (default: forever)" >&2
    echo "  --setup                Run setup only (baseline + first profile)" >&2
    echo "  --profile-every N      Override re-profile interval" >&2
    echo "  --agent NAME           Override agent (claude or codex)" >&2
    echo "  --thinking LEVEL       Set thinking effort (medium, high, max)" >&2
    echo "  --no-tmux              Don't wrap in a tmux session" >&2
    echo "  --no-worktree          Don't create a git worktree" >&2
    echo "  --parallel N, -j N     Run N experiments in parallel worktrees" >&2
    exit 1
fi

PROGRAM_DIR="$1"; shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        --iterations|-n) MAX_ITERATIONS="$2"; shift 2 ;;
        --setup)         SETUP_ONLY=true; shift ;;
        --profile-every) PROFILE_EVERY_OVERRIDE="$2"; shift 2 ;;
        --agent)         AGENT_OVERRIDE="$2"; shift 2 ;;
        --thinking)      THINKING="$2"; shift 2 ;;
        --no-tmux)       USE_TMUX=false; shift ;;
        --no-worktree)   USE_WORKTREE=false; shift ;;
        --parallel|-j)   PARALLEL="$2"; shift 2 ;;
        *)               echo "Unknown argument: $1" >&2; exit 1 ;;
    esac
done

# --- Worktree & launch helpers ---

is_in_worktree() {
    local git_dir git_common_dir
    git_dir="$(cd "$(git rev-parse --git-dir)" && pwd)"
    git_common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
    [ "$git_dir" != "$git_common_dir" ]
}

get_repo_root() {
    (cd "$(git rev-parse --git-common-dir)/.." && pwd)
}

create_worktree() {
    local name="$1" repo_root="$2" branch_prefix="${3:-autoresearch}"
    local wt_path="$repo_root/.worktrees/$name"

    if [ -d "$wt_path" ]; then
        echo "Re-using existing worktree: $wt_path" >&2
    else
        local branch="${branch_prefix}-$(date +%Y%m%d-%H%M%S)"
        echo "Creating worktree: $wt_path (branch: $branch)" >&2
        git worktree add -b "$branch" "$wt_path" >&2
        if [ -f "$repo_root/scripts/setup-worktree.sh" ]; then
            ROOT_WORKTREE_PATH="$repo_root" bash "$repo_root/scripts/setup-worktree.sh" "$wt_path" >&2
        fi
    fi
    echo "$wt_path"
}

# Rebuild args for re-exec (caller appends exclusion flags like --no-worktree)
build_reexec_args() {
    REEXEC_ARGS=("$PROGRAM_DIR")
    [ "$MAX_ITERATIONS" != "10" ] && REEXEC_ARGS+=(--iterations "$MAX_ITERATIONS")
    [ "$SETUP_ONLY" = true ] && REEXEC_ARGS+=(--setup)
    [ -n "$PROFILE_EVERY_OVERRIDE" ] && REEXEC_ARGS+=(--profile-every "$PROFILE_EVERY_OVERRIDE")
    [ -n "$AGENT_OVERRIDE" ] && REEXEC_ARGS+=(--agent "$AGENT_OVERRIDE")
    [ -n "$THINKING" ] && REEXEC_ARGS+=(--thinking "$THINKING")
    [ "$USE_TMUX" = false ] && REEXEC_ARGS+=(--no-tmux)
    [ "$USE_WORKTREE" = false ] && REEXEC_ARGS+=(--no-worktree)
    return 0
}

# Shell-quote an array of args into a single string (for tmux commands)
quote_args() {
    local quoted=""
    for arg in "$@"; do
        quoted+=" $(printf '%q' "$arg")"
    done
    echo "${quoted# }"
}

# --- Parallel mode ---
# Launch N independent workers, each in its own worktree

if [ "$PARALLEL" -gt 1 ]; then
    REPO_ROOT="$(get_repo_root)"
    BASE_NAME="$(basename "$PROGRAM_DIR")"

    build_reexec_args
    WORKER_ARGS=("${REEXEC_ARGS[@]}" --no-worktree --no-tmux)

    # Create worktrees
    WT_PATHS=()
    for i in $(seq 1 "$PARALLEL"); do
        WT_PATH="$(create_worktree "${BASE_NAME}-${i}" "$REPO_ROOT" "$BRANCH_PREFIX")"
        WT_PATHS+=("$WT_PATH")
    done

    # Print summary of all workers' results
    print_parallel_summary() {
        echo ""
        echo "========================================="
        echo "  Parallel Results Summary"
        echo "========================================="
        for i in $(seq 0 $((PARALLEL - 1))); do
            local wt="${WT_PATHS[$i]}"
            local branch
            branch="$(git -C "$wt" branch --show-current 2>/dev/null || echo "unknown")"
            local keeps=0
            # Find the results file wherever the config put it
            local results
            results="$(find "$wt/.traces" -name 'autoresearch-results.tsv' 2>/dev/null | head -1)"
            if [ -n "$results" ] && [ -f "$results" ]; then
                keeps=$(awk -F'\t' '$4 == "keep" && $5 != "baseline"' "$results" | wc -l | tr -d ' ')
            fi
            echo "  Worker $((i + 1)): $keeps improvements (branch: $branch)"
        done
        echo ""
        echo "Worktrees:"
        for wt in "${WT_PATHS[@]}"; do
            echo "  $wt"
        done
        echo ""
        echo "To clean up: scripts/manage-worktree.sh remove <name>"
    }

    if [ "$USE_TMUX" = true ]; then
        if ! command -v tmux >/dev/null 2>&1; then
            echo "Error: tmux required for parallel mode (install tmux or use --no-tmux)" >&2
            exit 1
        fi

        SESSION_NAME="$BASE_NAME"
        tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

        # First worker creates the session
        CMD="cd $(printf '%q' "${WT_PATHS[0]}") && ./scripts/autoresearch.sh $(quote_args "${WORKER_ARGS[@]}")"
        tmux new-session -d -s "$SESSION_NAME" -n "worker-1" "bash -c $(printf '%q' "$CMD")"

        # Remaining workers get their own windows
        for i in $(seq 2 "$PARALLEL"); do
            idx=$((i - 1))
            CMD="cd $(printf '%q' "${WT_PATHS[$idx]}") && ./scripts/autoresearch.sh $(quote_args "${WORKER_ARGS[@]}")"
            tmux new-window -t "$SESSION_NAME" -n "worker-$i" "bash -c $(printf '%q' "$CMD")"
        done

        echo "Launched $PARALLEL workers in tmux session: $SESSION_NAME"
        echo "Attach with: tmux attach -t $SESSION_NAME"
        exec tmux attach -t "$SESSION_NAME"
    else
        # No tmux: launch background processes with log files
        PIDS=()
        for i in $(seq 0 $((PARALLEL - 1))); do
            WORKER_NUM=$((i + 1))
            WT_PATH="${WT_PATHS[$i]}"
            LOG_FILE="${WT_PATH}/autoresearch-worker.log"
            echo "Launching worker $WORKER_NUM in $WT_PATH (log: $LOG_FILE)"
            (cd "$WT_PATH" && ./scripts/autoresearch.sh "${WORKER_ARGS[@]}" > "$LOG_FILE" 2>&1) &
            PIDS+=($!)
        done

        echo ""
        echo "Launched $PARALLEL workers in background."
        echo "PIDs: ${PIDS[*]}"
        echo "Follow with: tail -f <worktree>/autoresearch-worker.log"
        wait "${PIDS[@]}" || true

        print_parallel_summary
    fi
    exit 0
fi

# --- Worktree wrapping ---
# Create a worktree unless --no-worktree or already in one

if [ "$USE_WORKTREE" = true ] && ! is_in_worktree; then
    REPO_ROOT="$(get_repo_root)"
    WT_NAME="$(basename "$PROGRAM_DIR")"
    WT_PATH="$(create_worktree "$WT_NAME" "$REPO_ROOT" "$BRANCH_PREFIX")"

    build_reexec_args
    REEXEC_ARGS+=(--no-worktree)

    echo "Re-launching from worktree..."
    exec "$WT_PATH/scripts/autoresearch.sh" "${REEXEC_ARGS[@]}"
fi

# --- Tmux wrapping ---
# Re-exec inside tmux unless --no-tmux or already in tmux

if [ "$USE_TMUX" = true ] && [ -z "${TMUX:-}" ]; then
    if ! command -v tmux >/dev/null 2>&1; then
        echo "Warning: tmux not found, running without it" >&2
    else
        SESSION_NAME="autoresearch-$(basename "$PROGRAM_DIR")"
        build_reexec_args
        REEXEC_ARGS+=(--no-tmux)

        tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
        echo "Launching in tmux session: $SESSION_NAME"
        echo "Attach with: tmux attach -t $SESSION_NAME"
        exec tmux new-session -d -s "$SESSION_NAME" "$SCRIPT_DIR/autoresearch.sh" "${REEXEC_ARGS[@]}" \; attach -t "$SESSION_NAME"
    fi
fi

# --- Load config ---

CONFIG_FILE="$PROGRAM_DIR/config.sh"
PROGRAM_FILE="$PROGRAM_DIR/program.md"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: $CONFIG_FILE not found" >&2
    exit 1
fi
if [ ! -f "$PROGRAM_FILE" ]; then
    echo "Error: $PROGRAM_FILE not found" >&2
    exit 1
fi

# Defaults (config.sh can override these)
BUILD_CMD=""
MEASURE_CMD=""
METRIC_FIELD="metric"
METRIC_DIRECTION="lower"
SECONDARY_FIELD=""
QUALITY_GATE_FIELD=""
PROFILE_CMD=""
NOISE_THRESHOLD=2.0
MEASURE_REPEATS=1
MAX_CONSECUTIVE_DISCARDS=5
MAX_DISCARDS_WITHOUT_KEEP=5
PROFILE_EVERY=3
MAX_TURNS=200
STATE_DIR=""
AGENT="claude"
CLAUDE_ARGS=()
CODEX_ARGS=()
CODEX_SANDBOX="workspace-write"
CODEX_APPROVAL="never"

# shellcheck source=/dev/null
source "$CONFIG_FILE"

# CLI overrides
if [ -n "$PROFILE_EVERY_OVERRIDE" ]; then
    PROFILE_EVERY="$PROFILE_EVERY_OVERRIDE"
fi
if [ -n "${AUTORESEARCH_AGENT:-}" ]; then
    AGENT="$AUTORESEARCH_AGENT"
fi
if [ -n "$AGENT_OVERRIDE" ]; then
    AGENT="$AGENT_OVERRIDE"
fi
MAX_TURNS="${AUTORESEARCH_MAX_TURNS:-$MAX_TURNS}"
PROGRAM_NAME="${AUTORESEARCH_PROGRAM_NAME:-$(basename "$PROGRAM_DIR")}"
if [ -z "$STATE_DIR" ]; then
    STATE_DIR=".traces/$PROGRAM_NAME"
fi
STATE_DIR="${AUTORESEARCH_STATE_DIR:-$STATE_DIR}"

RESULTS_FILE="$STATE_DIR/autoresearch-results.tsv"

mkdir -p "$STATE_DIR"

export AUTORESEARCH_PROGRAM_NAME="$PROGRAM_NAME"
export AUTORESEARCH_PROGRAM_DIR="$PROGRAM_DIR"
export AUTORESEARCH_STATE_DIR="$STATE_DIR"
export AUTORESEARCH_RESULTS_FILE="$RESULTS_FILE"

# --- Helpers ---

log_result() {
    local commit="$1" metric="$2" secondary="$3" status="$4" description="$5"
    printf '%s\t%s\t%s\t%s\t%s\n' "$commit" "$metric" "$secondary" "$status" "$description" >> "$RESULTS_FILE"
}

get_baseline_metric() {
    if [ ! -f "$RESULTS_FILE" ]; then
        echo ""
        return
    fi
    awk -F'\t' '$4 == "keep" { metric = $2 } END { print metric }' "$RESULTS_FILE"
}

latest_commit_description() {
    git log -1 --format='%s' 2>/dev/null || echo "unknown"
}

extract_optional_json_field() {
    python3 - "$1" "$2" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
value = payload.get(sys.argv[2], "")
print("" if value is None else value)
PY
}

extract_required_json_field() {
    python3 - "$1" "$2" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
field = sys.argv[2]
if field not in payload:
    raise SystemExit(f"missing field: {field}")
value = payload[field]
print("" if value is None else value)
PY
}

extract_required_numeric_field() {
    python3 - "$1" "$2" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
field = sys.argv[2]
if field not in payload:
    raise SystemExit(f"missing field: {field}")
value = payload[field]
try:
    number = float(value)
except (TypeError, ValueError):
    raise SystemExit(f"non-numeric field: {field}")
print(number)
PY
}

median_numeric_values() {
    python3 - "$@" <<'PY'
import sys

values = sorted((float(value), index) for index, value in enumerate(sys.argv[1:]))
print(values[len(values) // 2][0])
PY
}

median_value_index() {
    python3 - "$@" <<'PY'
import sys

values = sorted((float(value), index) for index, value in enumerate(sys.argv[1:]))
print(values[len(values) // 2][1])
PY
}

is_numeric_value() {
    python3 - "$1" <<'PY'
import sys

try:
    float(sys.argv[1])
except ValueError:
    raise SystemExit(1)
PY
}

run_measurement_series() {
    local series_label="$1"
    local attempt json metric secondary quality_gate median_index secondary_all_numeric=true
    local -a metrics=()
    local -a secondaries=()
    local -a quality_gates=()

    for attempt in $(seq 1 "$MEASURE_REPEATS"); do
        if [ "$MEASURE_REPEATS" -gt 1 ]; then
            echo "${series_label} measurement ${attempt}/${MEASURE_REPEATS}"
        fi

        if ! json=$(eval "$MEASURE_CMD"); then
            return 1
        fi
        echo "$json"

        if ! metric=$(extract_required_numeric_field "$json" "$METRIC_FIELD" 2>/dev/null); then
            return 2
        fi
        metrics+=("$metric")

        if [ -n "$SECONDARY_FIELD" ]; then
            if ! secondary=$(extract_optional_json_field "$json" "$SECONDARY_FIELD" 2>/dev/null); then
                return 3
            fi
            secondaries+=("$secondary")
            if [ -n "$secondary" ] && ! is_numeric_value "$secondary" 2>/dev/null; then
                secondary_all_numeric=false
            fi
        fi

        if [ -n "$QUALITY_GATE_FIELD" ]; then
            if ! quality_gate=$(extract_required_json_field "$json" "$QUALITY_GATE_FIELD" 2>/dev/null); then
                return 4
            fi
            quality_gates+=("$quality_gate")
        fi
    done

    SERIES_METRIC="$(median_numeric_values "${metrics[@]}")"
    SERIES_SECONDARY=""
    SERIES_QUALITY_GATE="True"

    if [ -n "$SECONDARY_FIELD" ] && [ ${#secondaries[@]} -gt 0 ]; then
        if [ "$secondary_all_numeric" = true ]; then
            SERIES_SECONDARY="$(median_numeric_values "${secondaries[@]}")"
        else
            median_index="$(median_value_index "${metrics[@]}")"
            SERIES_SECONDARY="${secondaries[$median_index]}"
        fi
    fi

    if [ -n "$QUALITY_GATE_FIELD" ]; then
        local gate
        for gate in "${quality_gates[@]}"; do
            if [ "$gate" = "False" ]; then
                SERIES_QUALITY_GATE="False"
                break
            fi
        done
    fi
}

revert_experiment_commits() {
    local start_head="$1" end_head="$2"
    local -a commits=()
    local commit

    while IFS= read -r commit; do
        [ -n "$commit" ] && commits+=("$commit")
    done < <(git rev-list "${start_head}..${end_head}")

    if [ ${#commits[@]} -eq 0 ]; then
        return 0
    fi

    if git revert --no-edit "${commits[@]}"; then
        return 0
    fi

    git revert --abort >/dev/null 2>&1 || true
    return 1
}

make_unique_branch_name() {
    local base candidate suffix
    base="${BRANCH_PREFIX}-$(date +%Y%m%d-%H%M%S)"
    candidate="$base"
    suffix=2
    while git show-ref --verify --quiet "refs/heads/$candidate"; do
        candidate="${base}-${suffix}"
        suffix=$((suffix + 1))
    done
    echo "$candidate"
}

print_results_tail() {
    if command -v column >/dev/null 2>&1; then
        column -t -s $'\t' "$RESULTS_FILE" | tail -10
    else
        tail -10 "$RESULTS_FILE"
    fi
}

print_results_all() {
    if command -v column >/dev/null 2>&1; then
        column -t -s $'\t' "$RESULTS_FILE"
    else
        cat "$RESULTS_FILE"
    fi
}

recent_results_block() {
    local count="${1:-8}"
    if [ ! -f "$RESULTS_FILE" ]; then
        echo "(no results yet)"
        return
    fi
    python3 - "$RESULTS_FILE" "$count" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
count = int(sys.argv[2])
lines = path.read_text().splitlines()
if not lines:
    print("(no results yet)")
    raise SystemExit

header = lines[0]
rows = lines[1:]
if not rows:
    print(header)
    raise SystemExit

print(header)
for row in rows[-count:]:
    print(row)
PY
}

recent_git_history_block() {
    local count="${1:-10}"
    git log --oneline --decorate -n "$count" 2>/dev/null || echo "(no git history)"
}

last_outcome_summary() {
    python3 - "$RESULTS_FILE" <<'PY'
from pathlib import Path
import csv
import sys

path = Path(sys.argv[1])
if not path.exists():
    print("none yet")
    raise SystemExit

with path.open() as fh:
    rows = list(csv.reader(fh, delimiter="\t"))

if len(rows) <= 1:
    print("none yet")
    raise SystemExit

baseline = None
last_summary = "none yet"

def fmt(value: str | None) -> str:
    if value in (None, ""):
        return "unknown"
    try:
        number = float(value)
    except ValueError:
        return value
    if number.is_integer():
        return str(int(number))
    return str(number)

for row in rows[1:]:
    if len(row) < 5:
        continue
    _, metric, _, status, description = row
    if status == "keep":
        if description == "baseline":
            baseline = metric
            continue
        if baseline is None:
            baseline = metric
            continue
        last_summary = f"kept: improved from {fmt(baseline)} to {fmt(metric)} ({description})"
        baseline = metric
        continue
    if status == "discard":
        if description.startswith("noise: "):
            detail = description[len("noise: "):]
            last_summary = f"discarded: within noise from {fmt(baseline)} to {fmt(metric)} ({detail})"
        elif description.startswith("quality gate failed: "):
            detail = description[len("quality gate failed: "):]
            last_summary = f"discarded: quality gate failed at {fmt(metric)} ({detail})"
        else:
            last_summary = f"discarded: regressed from {fmt(baseline)} to {fmt(metric)} ({description})"
        continue
    if status == "crash":
        last_summary = f"crashed: {description}"
        continue
    if status == "skip":
        last_summary = f"skipped: {description}"

print(last_summary)
PY
}

compare_metric() {
    local baseline="$1" measured="$2" noise="$3" direction="$4"
    python3 - "$baseline" "$measured" "$noise" "$direction" <<'PY'
import sys

baseline = float(sys.argv[1])
measured = float(sys.argv[2])
noise_pct = float(sys.argv[3])
direction = sys.argv[4]  # "lower" or "higher"

if baseline <= 0:
    print("unknown")
    sys.exit()

if direction == "lower":
    # Lower is better: positive relative_change = improvement
    relative_change = ((baseline - measured) / baseline) * 100.0
else:
    # Higher is better: positive relative_change = improvement
    relative_change = ((measured - baseline) / baseline) * 100.0

if relative_change > noise_pct:
    print("improved")
elif relative_change < -noise_pct:
    print("regressed")
else:
    print("noise")
PY
}

run_profile() {
    if [ -n "$PROFILE_CMD" ]; then
        echo ""
        echo "=== Profiling ==="
        eval "$PROFILE_CMD"
    fi
}

build_iteration_prompt() {
    local iteration="$1" baseline="$2"
    local recent_results recent_history last_outcome
    recent_results="$(recent_results_block 8)"
    recent_history="$(recent_git_history_block 10)"
    last_outcome="$(last_outcome_summary)"
    cat <<EOF
You are iteration $iteration of an autoresearch loop.
Current baseline ${METRIC_FIELD} is ${baseline}.
Read your program instructions carefully.
Per-program state directory: ${STATE_DIR}
Experiment history file: ${RESULTS_FILE}
Recent results:
${recent_results}

Recent experiment history:
${recent_history}

Last outcome:
${last_outcome}

Discarded experiments remain in git history. Inspect relevant commits with git show if needed.
Implement ONE change, validate, and commit. Then exit.
EOF
}

run_agent_session() {
    local iteration="$1" baseline="$2"
    local agent_exit=0
    local iteration_prompt
    iteration_prompt="$(build_iteration_prompt "$iteration" "$baseline")"

    case "$AGENT" in
        claude)
            claude -p "$iteration_prompt" \
                --append-system-prompt-file "$PROGRAM_FILE" \
                --tools "Bash,Read,Edit,Write,Grep,Glob" \
                --allowedTools "Bash,Read,Edit,Write,Grep,Glob" \
                --permission-mode default \
                --no-session-persistence \
                --max-turns "$MAX_TURNS" \
                --output-format stream-json \
                ${THINKING:+--effort "$THINKING"} \
                ${CLAUDE_ARGS[@]+"${CLAUDE_ARGS[@]}"} \
                | python3 "$SCRIPT_DIR/autoresearch-progress.py" \
                || agent_exit=$?
            ;;
        codex)
            {
                cat "$PROGRAM_FILE"
                printf '\n\n%s\n' "$iteration_prompt"
            } | codex exec \
                -C "$PROJECT_DIR" \
                -a "$CODEX_APPROVAL" \
                -s "$CODEX_SANDBOX" \
                --ephemeral \
                --json \
                ${CODEX_ARGS[@]+"${CODEX_ARGS[@]}"} \
                - \
                | python3 "$SCRIPT_DIR/autoresearch-progress.py" \
                || agent_exit=$?
            ;;
        *)
            echo "Error: unsupported agent '$AGENT' (expected claude or codex)" >&2
            exit 1
            ;;
    esac

    return "$agent_exit"
}

# --- Setup phase ---

echo "========================================="
echo "  Autoresearch: $(basename "$PROGRAM_DIR")"
echo "========================================="
echo ""

# Ensure we're on an appropriate branch
BRANCH=$(git branch --show-current)
if [[ ! "$BRANCH" =~ ^${BRANCH_PREFIX} ]]; then
    BRANCH_NAME="$(make_unique_branch_name)"
    echo "Creating branch: $BRANCH_NAME"
    git checkout -b "$BRANCH_NAME"
    BRANCH="$BRANCH_NAME"
fi
echo "Branch: $BRANCH"

# Build
if [ -n "$BUILD_CMD" ]; then
    echo ""
    echo "=== Building ==="
    eval "$BUILD_CMD"
fi

# Initialize results file — re-run baseline if file is missing or has no "keep" entry
NEEDS_BASELINE=false
if [ ! -f "$RESULTS_FILE" ]; then
    printf 'commit\t%s\t%s\tstatus\tdescription\n' "$METRIC_FIELD" "${SECONDARY_FIELD:-secondary}" > "$RESULTS_FILE"
    NEEDS_BASELINE=true
elif [ -z "$(get_baseline_metric)" ]; then
    echo "Results file exists but has no baseline metric. Re-measuring."
    NEEDS_BASELINE=true
fi

if [ "$NEEDS_BASELINE" = true ]; then
    echo ""
    echo "=== Running baseline measurement ==="
    if run_measurement_series "Baseline"; then
        :
    else
        status=$?
        echo "Baseline measurement failed (stage $status). Aborting setup." >&2
        exit 1
    fi
    BASELINE_METRIC="$SERIES_METRIC"
    BASELINE_SECONDARY="$SERIES_SECONDARY"
    BASELINE_QUALITY_GATE="$SERIES_QUALITY_GATE"

    if [ -z "$BASELINE_METRIC" ]; then
        echo "Baseline measurement missing numeric field '${METRIC_FIELD}'. Aborting setup." >&2
        exit 1
    fi
    if [ -n "$QUALITY_GATE_FIELD" ]; then
        if [ "$BASELINE_QUALITY_GATE" = "False" ]; then
            echo "Baseline quality gate FAILED. Aborting setup." >&2
            exit 1
        fi
    fi
    COMMIT=$(git rev-parse --short HEAD)
    log_result "$COMMIT" "$BASELINE_METRIC" "$BASELINE_SECONDARY" "keep" "baseline"

    echo ""
    echo "Baseline: ${METRIC_FIELD}=${BASELINE_METRIC}"
fi

# Initial profile
LATEST_ANALYSIS=$(ls -t "$STATE_DIR"/*.txt 2>/dev/null | head -1 || true)
if [ -z "$LATEST_ANALYSIS" ]; then
    run_profile
fi

if [ "$SETUP_ONLY" = true ]; then
    echo ""
    echo "Setup complete. Run without --setup to start the loop."
    exit 0
fi

# --- The Loop ---

ITERATION=0
CONSECUTIVE_DISCARDS=0
DISCARDS_WITHOUT_KEEP=0

while true; do
    ITERATION=$((ITERATION + 1))

    if [ "$MAX_ITERATIONS" -gt 0 ] && [ "$ITERATION" -gt "$MAX_ITERATIONS" ]; then
        echo ""
        echo "=== Reached max iterations ($MAX_ITERATIONS). Stopping. ==="
        break
    fi

    if [ "$MAX_DISCARDS_WITHOUT_KEEP" -gt 0 ] && [ "$DISCARDS_WITHOUT_KEEP" -ge "$MAX_DISCARDS_WITHOUT_KEEP" ]; then
        echo ""
        echo "=== $DISCARDS_WITHOUT_KEEP consecutive non-keeps without any improvement. Plateau reached. ==="
        break
    fi

    CURRENT_METRIC=$(get_baseline_metric)
    echo ""
    echo "========================================="
    if [ "$MAX_ITERATIONS" -gt 0 ]; then
        echo "  Iteration $ITERATION/$MAX_ITERATIONS (baseline: ${CURRENT_METRIC} ${METRIC_FIELD})"
    else
        echo "  Iteration $ITERATION (baseline: ${CURRENT_METRIC} ${METRIC_FIELD})"
    fi
    echo "========================================="

    # Record HEAD before spawning so we can safely roll back to this exact point
    START_HEAD=$(git rev-parse HEAD)
    START_HEAD_SHORT=$(git rev-parse --short HEAD)

    # Spawn fresh agent session
    echo ""
    echo "=== Spawning $AGENT session ==="
    AGENT_EXIT=0
    run_agent_session "$ITERATION" "$CURRENT_METRIC" || AGENT_EXIT=$?

    if [ "$AGENT_EXIT" -ne 0 ]; then
        echo "WARNING: $AGENT session exited with code $AGENT_EXIT"
    fi

    # Check if Claude committed something new
    HEAD_NOW=$(git rev-parse --short HEAD)
    DESCRIPTION=$(latest_commit_description)

    if [ "$HEAD_NOW" = "$START_HEAD_SHORT" ]; then
        echo "No new commit. Skipping measurement."
        log_result "$HEAD_NOW" "$CURRENT_METRIC" "" "skip" "no commit produced"
        CONSECUTIVE_DISCARDS=$((CONSECUTIVE_DISCARDS + 1))
        DISCARDS_WITHOUT_KEEP=$((DISCARDS_WITHOUT_KEEP + 1))

        if [ "$CONSECUTIVE_DISCARDS" -ge "$MAX_CONSECUTIVE_DISCARDS" ]; then
            echo "=== $MAX_CONSECUTIVE_DISCARDS consecutive non-improvements. Re-profiling. ==="
            run_profile
            CONSECUTIVE_DISCARDS=0
        fi
        continue
    fi

    # Build
    if [ -n "$BUILD_CMD" ]; then
        echo ""
        echo "=== Building ==="
        if ! eval "$BUILD_CMD"; then
            echo "Build failed. Discarding."
            if ! revert_experiment_commits "$START_HEAD" "$HEAD_NOW"; then
                echo "Failed to revert discarded experiment history." >&2
                exit 1
            fi
            log_result "$HEAD_NOW" "0" "" "crash" "build failed: $DESCRIPTION"
            CONSECUTIVE_DISCARDS=$((CONSECUTIVE_DISCARDS + 1))
            DISCARDS_WITHOUT_KEEP=$((DISCARDS_WITHOUT_KEEP + 1))
            continue
        fi
    fi

    # Measure
    echo ""
    echo "=== Measuring ==="
    if run_measurement_series "Iteration"; then
        :
    else
        status=$?
        echo "Measurement failed. Discarding."
        if ! revert_experiment_commits "$START_HEAD" "$HEAD_NOW"; then
            echo "Failed to revert discarded experiment history." >&2
            exit 1
        fi
        case "$status" in
            2)
                log_result "$HEAD_NOW" "0" "" "crash" "measurement missing metric: $DESCRIPTION"
                ;;
            3)
                log_result "$HEAD_NOW" "0" "" "crash" "measurement parse failed: $DESCRIPTION"
                ;;
            4)
                log_result "$HEAD_NOW" "0" "" "crash" "measurement missing quality gate: $DESCRIPTION"
                ;;
            *)
                log_result "$HEAD_NOW" "0" "" "crash" "measurement failed: $DESCRIPTION"
                ;;
        esac
        CONSECUTIVE_DISCARDS=$((CONSECUTIVE_DISCARDS + 1))
        DISCARDS_WITHOUT_KEEP=$((DISCARDS_WITHOUT_KEEP + 1))
        continue
    fi

    MEASURED_METRIC="$SERIES_METRIC"
    MEASURED_SECONDARY="$SERIES_SECONDARY"
    QUALITY_GATE="$SERIES_QUALITY_GATE"

    # Quality gate check (optional)
    if [ -n "$QUALITY_GATE_FIELD" ]; then
        if [ "$QUALITY_GATE" = "False" ]; then
            echo "Quality gate FAILED. Discarding."
            if ! revert_experiment_commits "$START_HEAD" "$HEAD_NOW"; then
                echo "Failed to revert discarded experiment history." >&2
                exit 1
            fi
            log_result "$HEAD_NOW" "$MEASURED_METRIC" "$MEASURED_SECONDARY" "discard" "quality gate failed: $DESCRIPTION"
            CONSECUTIVE_DISCARDS=$((CONSECUTIVE_DISCARDS + 1))
            DISCARDS_WITHOUT_KEEP=$((DISCARDS_WITHOUT_KEEP + 1))
            continue
        fi
    fi

    # Keep or discard
    VERDICT=$(compare_metric "$CURRENT_METRIC" "$MEASURED_METRIC" "$NOISE_THRESHOLD" "$METRIC_DIRECTION")

    case "$VERDICT" in
        improved)
            echo ""
            echo "=== KEEP: ${CURRENT_METRIC} -> ${MEASURED_METRIC} (improved) ==="
            log_result "$HEAD_NOW" "$MEASURED_METRIC" "$MEASURED_SECONDARY" "keep" "$DESCRIPTION"
            CONSECUTIVE_DISCARDS=0
            DISCARDS_WITHOUT_KEEP=0
            run_profile
            ;;
        regressed)
            echo ""
            echo "=== DISCARD: ${CURRENT_METRIC} -> ${MEASURED_METRIC} (regressed) ==="
            if ! revert_experiment_commits "$START_HEAD" "$HEAD_NOW"; then
                echo "Failed to revert discarded experiment history." >&2
                exit 1
            fi
            log_result "$HEAD_NOW" "$MEASURED_METRIC" "$MEASURED_SECONDARY" "discard" "$DESCRIPTION"
            CONSECUTIVE_DISCARDS=$((CONSECUTIVE_DISCARDS + 1))
            DISCARDS_WITHOUT_KEEP=$((DISCARDS_WITHOUT_KEEP + 1))
            ;;
        noise)
            echo ""
            echo "=== DISCARD: ${CURRENT_METRIC} -> ${MEASURED_METRIC} (within noise) ==="
            if ! revert_experiment_commits "$START_HEAD" "$HEAD_NOW"; then
                echo "Failed to revert discarded experiment history." >&2
                exit 1
            fi
            log_result "$HEAD_NOW" "$MEASURED_METRIC" "$MEASURED_SECONDARY" "discard" "noise: $DESCRIPTION"
            CONSECUTIVE_DISCARDS=$((CONSECUTIVE_DISCARDS + 1))
            DISCARDS_WITHOUT_KEEP=$((DISCARDS_WITHOUT_KEEP + 1))
            ;;
        *)
            echo ""
            echo "=== KEEP (no baseline to compare): ${MEASURED_METRIC} ==="
            log_result "$HEAD_NOW" "$MEASURED_METRIC" "$MEASURED_SECONDARY" "keep" "$DESCRIPTION"
            CONSECUTIVE_DISCARDS=0
            DISCARDS_WITHOUT_KEEP=0
            ;;
    esac

    # Periodic re-profile
    if [ "$CONSECUTIVE_DISCARDS" -ge "$MAX_CONSECUTIVE_DISCARDS" ]; then
        echo "=== $MAX_CONSECUTIVE_DISCARDS consecutive discards. Re-profiling. ==="
        run_profile
        CONSECUTIVE_DISCARDS=0
    elif [ $((ITERATION % PROFILE_EVERY)) -eq 0 ] && [ "$VERDICT" != "improved" ]; then
        echo "=== Periodic re-profile (every $PROFILE_EVERY iterations) ==="
        run_profile
    fi

    echo ""
    echo "--- Results so far ---"
    print_results_tail
done

print_final_results
