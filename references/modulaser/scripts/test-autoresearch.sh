#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_file_exists() {
    local path="$1"
    [ -f "$path" ] || fail "expected file to exist: $path"
}

assert_any_match() {
    local pattern="$1"
    compgen -G "$pattern" >/dev/null || fail "expected files matching: $pattern"
}

assert_contains() {
    local path="$1" needle="$2"
    grep -F -- "$needle" "$path" >/dev/null || fail "expected '$needle' in $path"
}

assert_text_contains() {
    local text="$1" needle="$2"
    printf '%s\n' "$text" | grep -F -- "$needle" >/dev/null || fail "expected '$needle' in text"
}

assert_matches() {
    local value="$1" pattern="$2"
    [[ "$value" =~ $pattern ]] || fail "expected '$value' to match $pattern"
}

assert_json_field() {
    local json="$1" field="$2" expected="$3"
    python3 - "$json" "$field" "$expected" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
field = sys.argv[2]
expected = sys.argv[3]
value = payload[field]
actual = json.dumps(value, sort_keys=True) if isinstance(value, (dict, list, bool)) else str(value)
if actual != expected:
    raise SystemExit(f"expected {field}={expected}, got {actual}")
PY
}

setup_git_repo() {
    local repo="$1"
    mkdir -p "$repo/scripts"
    cp "$ROOT_DIR/scripts/autoresearch.sh" "$repo/scripts/autoresearch.sh"
    cp "$ROOT_DIR/scripts/autoresearch-progress.py" "$repo/scripts/autoresearch-progress.py"
    chmod +x "$repo/scripts/autoresearch.sh"
    (
        cd "$repo"
        git init -q
        git config user.name "Test User"
        git config user.email "test@example.com"
        echo base > README.md
        git add README.md
        git commit -q -m "chore(test): init"
    )
}

test_results_are_isolated_per_program() {
    local repo="$TMP_ROOT/repo-results"
    setup_git_repo "$repo"

    mkdir -p "$repo/program-a" "$repo/program-b"
    cat > "$repo/program-a/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"metric\":10}\n'"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-a"
EOF
    cat > "$repo/program-b/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"other_metric\":20}\n'"
METRIC_FIELD="other_metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-b"
EOF
    printf 'program a\n' > "$repo/program-a/program.md"
    printf 'program b\n' > "$repo/program-b/program.md"

    (
        cd "$repo"
        ./scripts/autoresearch.sh program-a --setup >/dev/null
        ./scripts/autoresearch.sh program-b --setup >/dev/null
    )

    assert_file_exists "$repo/.traces/program-a/autoresearch-results.tsv"
    assert_file_exists "$repo/.traces/program-b/autoresearch-results.tsv"
    assert_contains "$repo/.traces/program-a/autoresearch-results.tsv" $'commit\tmetric\tsecondary\tstatus\tdescription'
    assert_contains "$repo/.traces/program-b/autoresearch-results.tsv" $'commit\tother_metric\tsecondary\tstatus\tdescription'
}

test_baseline_quality_gate_must_pass() {
    local repo="$TMP_ROOT/repo-baseline-gate"
    setup_git_repo "$repo"

    mkdir -p "$repo/program-gated"
    cat > "$repo/program-gated/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"metric\":10,\"quality_gate_passed\":false}\n'"
METRIC_FIELD="metric"
QUALITY_GATE_FIELD="quality_gate_passed"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-gated"
EOF
    printf 'program gated\n' > "$repo/program-gated/program.md"

    if (
        cd "$repo"
        ./scripts/autoresearch.sh program-gated --setup >/dev/null 2>&1
    ); then
        fail "expected setup to fail when baseline quality gate fails"
    fi

    assert_file_exists "$repo/.traces/program-gated/autoresearch-results.tsv"
    if grep -Fq $'\tkeep\tbaseline' "$repo/.traces/program-gated/autoresearch-results.tsv"; then
        fail "baseline should not be recorded when quality gate fails"
    fi
}

test_measure_memory_uses_total_duration_and_target_state_dir() {
    local repo="$TMP_ROOT/repo-memory"
    mkdir -p "$repo/scripts" "$repo/custom-state"
    cp "$ROOT_DIR/scripts/measure-memory.sh" "$repo/scripts/measure-memory.sh"
    chmod +x "$repo/scripts/measure-memory.sh"

    cat > "$repo/scripts/analyze-memory.py" <<'EOF'
#!/usr/bin/env python3
import pathlib
import sys

out_dir = pathlib.Path(sys.argv[sys.argv.index("--output-dir") + 1])
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "analysis-ran.txt").write_text("ok\n")
EOF
    chmod +x "$repo/scripts/analyze-memory.py"

    cat > "$repo/scripts/profile-replay.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${XDG_RUNTIME_DIR:-}" > replay-runtime-dir.txt
printf '%s\n' "${MODULASER_CONTROL_SOCKET:-}" > replay-socket-path.txt
exit 0
EOF
    chmod +x "$repo/scripts/profile-replay.sh"

    cat > "$repo/scripts/modulaser-ctl.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$repo/scripts/modulaser-ctl.sh"

    mkdir -p "$repo/scripts/profile-scenes"
    printf '{}\n' > "$repo/scripts/profile-scenes/default.jsonl"

    cat > "$repo/fake-modulaser.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > binary-args.txt
printf '%s\n' "${XDG_RUNTIME_DIR:-}" > binary-runtime-dir.txt
timeout_s=0
for arg in "$@"; do
    case "$arg" in
        --timeout=*) timeout_s="${arg#--timeout=}" ;;
    esac
done
sleep "${timeout_s:-0}"
cat > dhat-heap.json <<JSON
{"pps":[{"tb":100,"tbk":2,"eb":25}]}
JSON
EOF
    chmod +x "$repo/fake-modulaser.sh"

    (
        cd "$repo"
        PROFILE_BINARY="$repo/fake-modulaser.sh" \
        PROFILE_DURATION=1 \
        PROFILE_WARMUP=2 \
        AUTORESEARCH_STATE_DIR="$repo/custom-state" \
        ./scripts/measure-memory.sh >/dev/null
    )

    assert_contains "$repo/binary-args.txt" "--timeout=3"
    assert_file_exists "$repo/custom-state/analysis-ran.txt"
    assert_matches "$(cat "$repo/binary-runtime-dir.txt")" '.+/custom-state/control-runtime$'
    assert_matches "$(cat "$repo/replay-runtime-dir.txt")" '.+/custom-state/control-runtime$'
    assert_matches "$(cat "$repo/replay-socket-path.txt")" '.+/custom-state/control-runtime/modulaser/control\.sock$'
}

test_measure_gpu_filters_warmup_and_reports_quality_gate() {
    local repo="$TMP_ROOT/repo-gpu"
    setup_git_repo "$repo"
    mkdir -p "$repo/scripts" "$repo/custom-state"
    cp "$ROOT_DIR/scripts/measure-gpu.sh" "$repo/scripts/measure-gpu.sh"
    chmod +x "$repo/scripts/measure-gpu.sh"

    cat > "$repo/scripts/analyze-gpu-trace.py" <<'EOF'
#!/usr/bin/env python3
import pathlib
import sys
pathlib.Path(sys.argv[1]).with_suffix(".txt.stub").write_text("ok\n")
print("analysis ok")
EOF
    chmod +x "$repo/scripts/analyze-gpu-trace.py"

    cat > "$repo/scripts/profile-replay.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$repo/scripts/profile-replay.sh"

    cat > "$repo/scripts/modulaser-ctl.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$repo/scripts/modulaser-ctl.sh"

    mkdir -p "$repo/scripts/profile-scenes"
    printf '{}\n' > "$repo/scripts/profile-scenes/default.jsonl"

    cat > "$repo/fake-gpu-app.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > binary-args.txt
sleep 1
cat > gpu-trace.json <<JSON
{
  "traceEvents": [
    {"name":"pass_a","ph":"X","ts":0,"dur":30000},
    {"name":"pass_b","ph":"X","ts":1000,"dur":20000},
    {"name":"pass_a","ph":"X","ts":2500000,"dur":7000},
    {"name":"pass_b","ph":"X","ts":2501000,"dur":3000},
    {"name":"pass_a","ph":"X","ts":3500000,"dur":7000},
    {"name":"pass_b","ph":"X","ts":3501000,"dur":3000},
    {"name":"pass_a","ph":"X","ts":4500000,"dur":7000},
    {"name":"pass_b","ph":"X","ts":4501000,"dur":3000}
  ]
}
JSON
EOF
    chmod +x "$repo/fake-gpu-app.sh"

    local output
    output="$(
        cd "$repo"
        PROFILE_BINARY="$repo/fake-gpu-app.sh" \
        PROFILE_DURATION=3 \
        PROFILE_WARMUP=2 \
        GPU_MIN_FRAMES=3 \
        GPU_MIN_COVERAGE_PCT=60 \
        AUTORESEARCH_STATE_DIR="$repo/custom-state" \
        ./scripts/measure-gpu.sh
    )"

    assert_contains "$repo/binary-args.txt" "--timeout=5"
    assert_json_field "$output" "avg_gpu_ms" "10.0"
    assert_json_field "$output" "quality_gate_passed" "true"
    assert_json_field "$output" "frame_count" "3"
    assert_json_field "$output" "filtered_duration_s" "2.007"
    assert_any_match "$repo/custom-state/*-gpu.txt"
    assert_any_match "$repo/custom-state/*-gpu.json"
}

test_measure_gpu_fails_quality_gate_when_too_few_frames() {
    local repo="$TMP_ROOT/repo-gpu-gate"
    setup_git_repo "$repo"
    mkdir -p "$repo/scripts"
    cp "$ROOT_DIR/scripts/measure-gpu.sh" "$repo/scripts/measure-gpu.sh"
    chmod +x "$repo/scripts/measure-gpu.sh"

    cat > "$repo/scripts/analyze-gpu-trace.py" <<'EOF'
#!/usr/bin/env python3
print("analysis ok")
EOF
    chmod +x "$repo/scripts/analyze-gpu-trace.py"

    cat > "$repo/scripts/profile-replay.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$repo/scripts/profile-replay.sh"

    cat > "$repo/scripts/modulaser-ctl.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$repo/scripts/modulaser-ctl.sh"

    mkdir -p "$repo/scripts/profile-scenes"
    printf '{}\n' > "$repo/scripts/profile-scenes/default.jsonl"

    cat > "$repo/fake-gpu-app.sh" <<'EOF'
#!/usr/bin/env bash
sleep 1
cat > gpu-trace.json <<JSON
{
  "traceEvents": [
    {"name":"pass_a","ph":"X","ts":0,"dur":20000},
    {"name":"pass_b","ph":"X","ts":1000,"dur":5000},
    {"name":"pass_a","ph":"X","ts":2100000,"dur":8000},
    {"name":"pass_b","ph":"X","ts":2101000,"dur":2000}
  ]
}
JSON
EOF
    chmod +x "$repo/fake-gpu-app.sh"

    local output
    output="$(
        cd "$repo"
        PROFILE_BINARY="$repo/fake-gpu-app.sh" \
        PROFILE_DURATION=3 \
        PROFILE_WARMUP=2 \
        GPU_MIN_FRAMES=2 \
        ./scripts/measure-gpu.sh
    )"

    assert_json_field "$output" "quality_gate_passed" "false"
    assert_json_field "$output" "frame_count" "1"
}

test_measure_gpu_groups_repeated_pass_names_by_timestamp_gap() {
    local repo="$TMP_ROOT/repo-gpu-repeated-pass"
    setup_git_repo "$repo"
    mkdir -p "$repo/scripts"
    cp "$ROOT_DIR/scripts/measure-gpu.sh" "$repo/scripts/measure-gpu.sh"
    chmod +x "$repo/scripts/measure-gpu.sh"

    cat > "$repo/scripts/analyze-gpu-trace.py" <<'EOF'
#!/usr/bin/env python3
print("analysis ok")
EOF
    chmod +x "$repo/scripts/analyze-gpu-trace.py"

    cat > "$repo/scripts/profile-replay.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$repo/scripts/profile-replay.sh"

    cat > "$repo/scripts/modulaser-ctl.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$repo/scripts/modulaser-ctl.sh"

    mkdir -p "$repo/scripts/profile-scenes"
    printf '{}\n' > "$repo/scripts/profile-scenes/default.jsonl"

    cat > "$repo/fake-gpu-app.sh" <<'EOF'
#!/usr/bin/env bash
sleep 1
cat > gpu-trace.json <<JSON
{
  "traceEvents": [
    {"name":"warmup","ph":"X","ts":0,"dur":1000},
    {"name":"beam_bloom_blur","ph":"X","ts":2000000,"dur":3000},
    {"name":"beam_bloom_blur","ph":"X","ts":2004000,"dur":2000},
    {"name":"beam_bloom_blur","ph":"X","ts":2007000,"dur":1000},
    {"name":"beam_bloom_blur","ph":"X","ts":4000000,"dur":3000},
    {"name":"beam_bloom_blur","ph":"X","ts":4004000,"dur":2000},
    {"name":"beam_bloom_blur","ph":"X","ts":4007000,"dur":1000}
  ]
}
JSON
EOF
    chmod +x "$repo/fake-gpu-app.sh"

    local output
    output="$(
        cd "$repo"
        PROFILE_BINARY="$repo/fake-gpu-app.sh" \
        PROFILE_DURATION=3 \
        PROFILE_WARMUP=1 \
        GPU_MIN_FRAMES=2 \
        GPU_MIN_COVERAGE_PCT=60 \
        ./scripts/measure-gpu.sh
    )"

    assert_json_field "$output" "frame_count" "2"
    assert_json_field "$output" "avg_gpu_ms" "6.0"
    assert_json_field "$output" "quality_gate_passed" "true"
}

test_measure_gpu_fails_quality_gate_for_unstable_frame_layout() {
    local repo="$TMP_ROOT/repo-gpu-unstable-layout"
    setup_git_repo "$repo"
    mkdir -p "$repo/scripts"
    cp "$ROOT_DIR/scripts/measure-gpu.sh" "$repo/scripts/measure-gpu.sh"
    chmod +x "$repo/scripts/measure-gpu.sh"

    cat > "$repo/scripts/analyze-gpu-trace.py" <<'EOF'
#!/usr/bin/env python3
print("analysis ok")
EOF
    chmod +x "$repo/scripts/analyze-gpu-trace.py"

    cat > "$repo/scripts/profile-replay.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$repo/scripts/profile-replay.sh"

    cat > "$repo/scripts/modulaser-ctl.sh" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$repo/scripts/modulaser-ctl.sh"

    mkdir -p "$repo/scripts/profile-scenes"
    printf '{}\n' > "$repo/scripts/profile-scenes/default.jsonl"

    cat > "$repo/fake-gpu-app.sh" <<'EOF'
#!/usr/bin/env bash
sleep 1
cat > gpu-trace.json <<JSON
{
  "traceEvents": [
    {"name":"warmup","ph":"X","ts":0,"dur":1000},
    {"name":"pass_a","ph":"X","ts":2000000,"dur":3000},
    {"name":"pass_b","ph":"X","ts":2005000,"dur":2000},
    {"name":"pass_a","ph":"X","ts":4000000,"dur":3000},
    {"name":"pass_a","ph":"X","ts":6000000,"dur":3000},
    {"name":"pass_b","ph":"X","ts":6005000,"dur":2000}
  ]
}
JSON
EOF
    chmod +x "$repo/fake-gpu-app.sh"

    local output
    output="$(
        cd "$repo"
        PROFILE_BINARY="$repo/fake-gpu-app.sh" \
        PROFILE_DURATION=5 \
        PROFILE_WARMUP=1 \
        GPU_MIN_FRAMES=3 \
        ./scripts/measure-gpu.sh
    )"

    assert_json_field "$output" "frame_count" "3"
    assert_json_field "$output" "quality_gate_passed" "false"
}

test_autoresearch_creates_program_branch_from_worktree_branch() {
    local repo="$TMP_ROOT/repo-worktree-branch"
    setup_git_repo "$repo"

    mkdir -p "$repo/program"
    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"metric\":10}\n'"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-branch"
EOF
    printf 'program\n' > "$repo/program/program.md"

    local branch
    branch="$(
        cd "$repo"
        git checkout -q -b worktree-sandbox
        ./scripts/autoresearch.sh program --setup >/dev/null
        git branch --show-current
    )"

    assert_matches "$branch" '^autoresearch/test-branch-'
}

test_autoresearch_uses_unique_branch_names_across_same_day_reruns() {
    local repo="$TMP_ROOT/repo-unique-branches"
    setup_git_repo "$repo"

    mkdir -p "$repo/program"
    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"metric\":10}\n'"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-unique"
EOF
    printf 'program\n' > "$repo/program/program.md"

    local branches
    branches="$(
        cd "$repo"
        ./scripts/autoresearch.sh program --setup >/dev/null
        first=$(git branch --show-current)
        git checkout -q master
        rm -rf .traces/program
        ./scripts/autoresearch.sh program --setup >/dev/null
        second=$(git branch --show-current)
        printf '%s\n%s\n' "$first" "$second"
    )"

    local first second
    first="$(printf '%s\n' "$branches" | sed -n '1p')"
    second="$(printf '%s\n' "$branches" | sed -n '2p')"
    [ "$first" != "$second" ] || fail "expected unique branch names across reruns"
}

test_autoresearch_relaunches_from_created_worktree() {
    local repo="$TMP_ROOT/repo-worktree-relaunch"
    setup_git_repo "$repo"

    mkdir -p "$repo/program"
    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"metric\":10}\n'"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-relaunch"
EOF
    printf 'program\n' > "$repo/program/program.md"
    (
        cd "$repo"
        git add scripts/autoresearch.sh program
        git commit -q -m "test(autoresearch): track relaunch fixtures"
    )

    (
        cd "$repo"
        script -q /dev/null ./scripts/autoresearch.sh program --setup --no-tmux >/dev/null 2>&1
    )

    assert_file_exists "$repo/.worktrees/program/.traces/program/autoresearch-results.tsv"
    assert_contains "$repo/.worktrees/program/.traces/program/autoresearch-results.tsv" $'\tkeep\tbaseline'
}

test_autoresearch_logs_invalid_measurement_as_crash() {
    local repo="$TMP_ROOT/repo-invalid-measurement"
    setup_git_repo "$repo"
    mkdir -p "$repo/program" "$repo/bin"

    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="./measure.sh"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-invalid"
EOF
    printf 'program\n' > "$repo/program/program.md"

    cat > "$repo/measure.sh" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f .measure-count ]; then
    count=$(cat .measure-count)
fi
count=$((count + 1))
printf '%s\n' "$count" > .measure-count
if [ "$count" -eq 1 ]; then
    printf '{"metric":10}\n'
else
    printf '{"not_metric":5}\n'
fi
EOF
    chmod +x "$repo/measure.sh"

    cat > "$repo/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'agent change\n' >> README.md
git add README.md
git commit -q -m "perf(test): change"
EOF
    chmod +x "$repo/bin/claude"

    (
        cd "$repo"
        PATH="$repo/bin:$PATH" ./scripts/autoresearch.sh program --iterations 1 >/dev/null
    )

    assert_contains "$repo/.traces/program/autoresearch-results.tsv" $'\tcrash\tmeasurement missing metric: perf(test): change'
}

test_autoresearch_uses_median_of_repeated_measurements() {
    local repo="$TMP_ROOT/repo-measure-repeats"
    setup_git_repo "$repo"
    mkdir -p "$repo/program" "$repo/bin"

    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="./measure.sh"
MEASURE_REPEATS=3
METRIC_FIELD="metric"
SECONDARY_FIELD="secondary"
QUALITY_GATE_FIELD="quality_gate_passed"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-repeats"
EOF
    printf 'program\n' > "$repo/program/program.md"

    cat > "$repo/measure.sh" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f .measure-count ]; then
    count=$(cat .measure-count)
fi
count=$((count + 1))
printf '%s\n' "$count" > .measure-count
case "$count" in
    1) printf '{"metric":100,"secondary":1000,"quality_gate_passed":true}\n' ;;
    2) printf '{"metric":120,"secondary":1200,"quality_gate_passed":true}\n' ;;
    3) printf '{"metric":90,"secondary":900,"quality_gate_passed":true}\n' ;;
    4) printf '{"metric":80,"secondary":800,"quality_gate_passed":true}\n' ;;
    5) printf '{"metric":100,"secondary":1000,"quality_gate_passed":true}\n' ;;
    6) printf '{"metric":95,"secondary":950,"quality_gate_passed":true}\n' ;;
    *) exit 1 ;;
esac
EOF
    chmod +x "$repo/measure.sh"

    cat > "$repo/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'agent change\n' >> README.md
git add README.md
git commit -q -m "perf(test): repeated median"
EOF
    chmod +x "$repo/bin/claude"

    (
        cd "$repo"
        PATH="$repo/bin:$PATH" ./scripts/autoresearch.sh program --iterations 1 >/dev/null
    )

    assert_contains "$repo/.traces/program/autoresearch-results.tsv" $'\t100.0\t1000.0\tkeep\tbaseline'
    assert_contains "$repo/.traces/program/autoresearch-results.tsv" $'\t95.0\t950.0\tkeep\tperf(test): repeated median'
}

test_autoresearch_repeated_measurements_require_all_quality_gates() {
    local repo="$TMP_ROOT/repo-repeat-quality-gate"
    setup_git_repo "$repo"
    mkdir -p "$repo/program" "$repo/bin"

    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="./measure.sh"
MEASURE_REPEATS=3
METRIC_FIELD="metric"
QUALITY_GATE_FIELD="quality_gate_passed"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-repeat-gate"
EOF
    printf 'program\n' > "$repo/program/program.md"

    cat > "$repo/measure.sh" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f .measure-count ]; then
    count=$(cat .measure-count)
fi
count=$((count + 1))
printf '%s\n' "$count" > .measure-count
case "$count" in
    1|2|3) printf '{"metric":100,"quality_gate_passed":true}\n' ;;
    4) printf '{"metric":80,"quality_gate_passed":true}\n' ;;
    5) printf '{"metric":70,"quality_gate_passed":false}\n' ;;
    6) printf '{"metric":60,"quality_gate_passed":true}\n' ;;
    *) exit 1 ;;
esac
EOF
    chmod +x "$repo/measure.sh"

    cat > "$repo/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'agent change\n' >> README.md
git add README.md
git commit -q -m "perf(test): quality gate"
EOF
    chmod +x "$repo/bin/claude"

    (
        cd "$repo"
        PATH="$repo/bin:$PATH" ./scripts/autoresearch.sh program --iterations 1 >/dev/null
    )

    assert_contains "$repo/.traces/program/autoresearch-results.tsv" $'\tdiscard\tquality gate failed: perf(test): quality gate'
}

test_program_measure_repeat_defaults() {
    assert_contains "$ROOT_DIR/scripts/autoresearch-perf/config.sh" 'MEASURE_REPEATS=3'
    assert_contains "$ROOT_DIR/scripts/autoresearch-gpu/config.sh" 'MEASURE_REPEATS=3'
    assert_contains "$ROOT_DIR/scripts/autoresearch-memory/config.sh" 'MEASURE_REPEATS=1'
}

test_autoresearch_prompt_includes_recent_context() {
    local repo="$TMP_ROOT/repo-prompt-context"
    setup_git_repo "$repo"
    mkdir -p "$repo/program" "$repo/bin"

    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="./measure.sh"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-prompt"
EOF
    printf 'program\n' > "$repo/program/program.md"

    cat > "$repo/measure.sh" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f .measure-count ]; then
    count=$(cat .measure-count)
fi
count=$((count + 1))
printf '%s\n' "$count" > .measure-count
if [ "$count" -eq 1 ]; then
    printf '{"metric":10}\n'
else
    printf '{"metric":15}\n'
fi
EOF
    chmod +x "$repo/measure.sh"

    cat > "$repo/bin/claude" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f .agent-count ]; then
    count=$(cat .agent-count)
fi
count=$((count + 1))
printf '%s\n' "$count" > .agent-count

prompt=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "-p" ]; then
        prompt="$arg"
        break
    fi
    prev="$arg"
done

if [ "$count" -eq 1 ]; then
    printf 'agent change\n' >> README.md
    git add README.md
    git commit -q -m "perf(test): batch vertex pushes"
else
    printf '%s\n' "$prompt" > prompt.txt
fi
EOF
    chmod +x "$repo/bin/claude"

    (
        cd "$repo"
        PATH="$repo/bin:$PATH" ./scripts/autoresearch.sh program --iterations 2 >/dev/null
    )

    assert_contains "$repo/prompt.txt" 'Recent results:'
    assert_contains "$repo/prompt.txt" $'keep\tbaseline'
    assert_contains "$repo/prompt.txt" $'discard\tperf(test): batch vertex pushes'
    assert_contains "$repo/prompt.txt" 'Recent experiment history:'
    assert_contains "$repo/prompt.txt" 'Revert "perf(test): batch vertex pushes"'
    assert_contains "$repo/prompt.txt" 'perf(test): batch vertex pushes'
    assert_contains "$repo/prompt.txt" 'Last outcome:'
    assert_contains "$repo/prompt.txt" 'discarded: regressed from 10 to 15 (perf(test): batch vertex pushes)'
}

test_autoresearch_preserves_discarded_experiments_in_git_history() {
    local repo="$TMP_ROOT/repo-git-memory"
    setup_git_repo "$repo"
    mkdir -p "$repo/program" "$repo/bin"

    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="./measure.sh"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-git-memory"
EOF
    printf 'program\n' > "$repo/program/program.md"

    cat > "$repo/measure.sh" <<'EOF'
#!/usr/bin/env bash
count=0
if [ -f .measure-count ]; then
    count=$(cat .measure-count)
fi
count=$((count + 1))
printf '%s\n' "$count" > .measure-count
printf '{"metric":10}\n'
EOF
    chmod +x "$repo/measure.sh"

    cat > "$repo/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'agent change\n' >> README.md
git add README.md
git commit -q -m "perf(test): git memory"
EOF
    chmod +x "$repo/bin/claude"

    local history
    history="$(
        cd "$repo"
        PATH="$repo/bin:$PATH" ./scripts/autoresearch.sh program --iterations 1 >/dev/null
        git log --oneline -4
    )"

    assert_contains "$repo/.traces/program/autoresearch-results.tsv" $'\tdiscard\tnoise: perf(test): git memory'
    assert_text_contains "$history" 'perf(test): git memory'
    assert_text_contains "$history" 'Revert "perf(test): git memory"'
    assert_matches "$(cat "$repo/README.md")" '^base$'
}

test_programs_reference_git_history_memory() {
    assert_contains "$ROOT_DIR/scripts/autoresearch-perf/program.md" 'git log'
    assert_contains "$ROOT_DIR/scripts/autoresearch-memory/program.md" 'git log'
    assert_contains "$ROOT_DIR/scripts/autoresearch-gpu/program.md" 'git log'
}

test_autoresearch_stops_on_plateau() {
    local repo="$TMP_ROOT/repo-plateau"
    setup_git_repo "$repo"
    mkdir -p "$repo/program" "$repo/bin"

    cat > "$repo/program/config.sh" <<'EOF'
BUILD_CMD=""
MEASURE_CMD="printf '{\"metric\":10}\n'"
METRIC_FIELD="metric"
PROFILE_CMD=""
BRANCH_PREFIX="autoresearch/test-plateau"
MAX_DISCARDS_WITHOUT_KEEP=3
EOF
    printf 'program\n' > "$repo/program/program.md"

    # Agent always commits, but metric never improves → always noise discard
    cat > "$repo/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'agent change\n' >> README.md
git add README.md
git commit -q -m "perf(test): plateau attempt"
EOF
    chmod +x "$repo/bin/claude"

    local output
    output="$(
        cd "$repo"
        PATH="$repo/bin:$PATH" ./scripts/autoresearch.sh program --iterations 20 2>&1
    )"

    # Should have stopped after 3 discards, not run all 20 iterations
    assert_text_contains "$output" "Plateau reached"

    # Count non-baseline entries in results (should be exactly 3 discards)
    local discard_count
    discard_count=$(awk -F'\t' '$4 == "discard"' "$repo/.traces/program/autoresearch-results.tsv" | wc -l | tr -d ' ')
    [ "$discard_count" -eq 3 ] || fail "expected 3 discards before plateau stop, got $discard_count"
}

test_profile_replay_fails_when_project_never_loads() {
    local repo="$TMP_ROOT/repo-profile-replay"
    mkdir -p "$repo/scripts" "$repo/bin" "$repo/runtime/modulaser"
    cp "$ROOT_DIR/scripts/profile-replay.sh" "$repo/scripts/profile-replay.sh"
    chmod +x "$repo/scripts/profile-replay.sh"
    printf '{"cmd":"GetStateSummary"}\n' > "$repo/setup.jsonl"

    cat > "$repo/bin/nc" <<'EOF'
#!/usr/bin/env bash
printf '{"status":"ok","data":{"clip_count":0}}\n'
EOF
    chmod +x "$repo/bin/nc"

    cat > "$repo/bin/seq" <<'EOF'
#!/usr/bin/env bash
printf '1\n'
EOF
    chmod +x "$repo/bin/seq"

    cat > "$repo/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$repo/bin/sleep"

    python3 - "$repo/runtime/modulaser/control.sock" <<'PY' &
import socket
import sys
import time

path = sys.argv[1]
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(path)
sock.listen(1)
time.sleep(5)
sock.close()
PY
    local server_pid=$!

    if (
        cd "$repo"
        PATH="$repo/bin:$PATH" XDG_RUNTIME_DIR="$repo/runtime" ./scripts/profile-replay.sh "$repo/setup.jsonl" >/dev/null 2>&1
    ); then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
        fail "expected profile replay to fail when the project never loads"
    fi

    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
}

test_results_are_isolated_per_program
test_baseline_quality_gate_must_pass
test_measure_memory_uses_total_duration_and_target_state_dir
test_measure_gpu_filters_warmup_and_reports_quality_gate
test_measure_gpu_fails_quality_gate_when_too_few_frames
test_measure_gpu_groups_repeated_pass_names_by_timestamp_gap
test_measure_gpu_fails_quality_gate_for_unstable_frame_layout
test_autoresearch_creates_program_branch_from_worktree_branch
test_autoresearch_uses_unique_branch_names_across_same_day_reruns
test_autoresearch_relaunches_from_created_worktree
test_autoresearch_logs_invalid_measurement_as_crash
test_autoresearch_uses_median_of_repeated_measurements
test_autoresearch_repeated_measurements_require_all_quality_gates
test_program_measure_repeat_defaults
test_autoresearch_prompt_includes_recent_context
test_autoresearch_preserves_discarded_experiments_in_git_history
test_programs_reference_git_history_memory
test_autoresearch_stops_on_plateau
test_profile_replay_fails_when_project_never_loads

echo "ok"
