#!/usr/bin/env bash
set -euo pipefail

# measure-gpu.sh — Launch Modulaser with GPU profiling, replay setup, and measure
# steady-state per-frame GPU time after a warmup window.
# Outputs a single JSON line with avg_gpu_ms, median_gpu_ms, max_gpu_ms,
# frame_count, pass_count, quality_gate_passed, and per-pass means.
# Used by autoresearch-gpu as the keep/discard metric.
#
# Requires the binary to be built with: cargo build --profile profiling --features gpu-profile
#
# Usage: ./scripts/measure-gpu.sh [duration_seconds]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

BINARY="${PROFILE_BINARY:-target/profiling/modulaser}"
DURATION="${1:-${PROFILE_DURATION:-15}}"
WARMUP="${PROFILE_WARMUP:-3}"
MIN_FRAMES="${GPU_MIN_FRAMES:-60}"
MIN_COVERAGE_PCT="${GPU_MIN_COVERAGE_PCT:-80}"
MIN_STABLE_FRAME_PCT="${GPU_MIN_STABLE_FRAME_PCT:-80}"
SETUP_FILE="${PROFILE_SETUP_FILE:-$SCRIPT_DIR/profile-scenes/default.jsonl}"
REPLAY_SCRIPT="${PROFILE_REPLAY_SCRIPT:-$SCRIPT_DIR/profile-replay.sh}"
CTL_SCRIPT="${PROFILE_CTL_SCRIPT:-$SCRIPT_DIR/modulaser-ctl.sh}"
TRACES_DIR="${AUTORESEARCH_STATE_DIR:-.traces}"
CONTROL_RUNTIME_DIR="${MODULASER_CONTROL_RUNTIME_DIR:-$TRACES_DIR/control-runtime}"
TOTAL_DURATION=$((WARMUP + DURATION))

if [ ! -f "$SETUP_FILE" ]; then
    echo "Error: $SETUP_FILE not found." >&2
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: $BINARY not found. Run: cargo build --profile profiling --features gpu-profile" >&2
    exit 1
fi

if "$CTL_SCRIPT" '{"cmd":"GetStateSummary"}' >/dev/null 2>&1; then
    echo "Error: existing Modulaser control-socket session detected. Stop it before measuring." >&2
    exit 1
fi

mkdir -p "$CONTROL_RUNTIME_DIR/modulaser"
export XDG_RUNTIME_DIR="$CONTROL_RUNTIME_DIR"
export MODULASER_CONTROL_SOCKET="$XDG_RUNTIME_DIR/modulaser/control.sock"

rm -f gpu-trace.json

rm -f "$MODULASER_CONTROL_SOCKET"

"$BINARY" --debug-socket --timeout="$TOTAL_DURATION" > /dev/null 2>&1 &
APP_PID=$!

cleanup() {
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 0.5
if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Error: App failed to start" >&2
    exit 1
fi

"$REPLAY_SCRIPT" "$SETUP_FILE" > /dev/null 2>&1

wait "$APP_PID" 2>/dev/null || true
trap - EXIT

if [ ! -f "gpu-trace.json" ]; then
    echo "Error: gpu-trace.json not found. Is the binary built with --features gpu-profile?" >&2
    exit 1
fi

COMMIT_HASH=$(git rev-parse --short HEAD)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$TRACES_DIR"
TRACE_NAME="${TIMESTAMP}-${COMMIT_HASH}-gpu"
TRACE_JSON="${TRACES_DIR}/${TRACE_NAME}.json"
ANALYSIS="${TRACES_DIR}/${TRACE_NAME}.txt"

python3 - "gpu-trace.json" "$TRACE_JSON" "$WARMUP" "$DURATION" "$MIN_FRAMES" "$MIN_COVERAGE_PCT" "$MIN_STABLE_FRAME_PCT" <<'PY'
from collections import Counter
import json
import statistics
import sys

input_path, output_path = sys.argv[1], sys.argv[2]
warmup_s = float(sys.argv[3])
measurement_s = float(sys.argv[4])
min_frames = int(sys.argv[5])
min_coverage_pct = float(sys.argv[6])
min_stable_frame_pct = float(sys.argv[7])


def estimate_frame_gap_us(events: list[dict]) -> float | None:
    if len(events) < 2:
        return None

    gaps = [curr["ts"] - prev["ts"] for prev, curr in zip(events, events[1:]) if curr["ts"] > prev["ts"]]
    if not gaps:
        return None

    sorted_gaps = sorted(gaps)
    best_pair = None
    best_ratio = 1.0
    for prev_gap, next_gap in zip(sorted_gaps, sorted_gaps[1:]):
        if prev_gap <= 0:
            continue
        ratio = next_gap / prev_gap
        if ratio > best_ratio:
            best_ratio = ratio
            best_pair = (prev_gap, next_gap)

    if best_pair and best_ratio >= 3.0:
        return (best_pair[0] + best_pair[1]) / 2.0

    return max(statistics.median(sorted_gaps) * 4.0, 1000.0)


def group_frames(events: list[dict]) -> tuple[list[list[dict]], float | None]:
    if not events:
        return [], None

    frame_gap_us = estimate_frame_gap_us(events)
    frames = [[events[0]]]
    for prev, curr in zip(events, events[1:]):
        if frame_gap_us is not None and (curr["ts"] - prev["ts"]) >= frame_gap_us:
            frames.append([])
        frames[-1].append(curr)
    return frames, frame_gap_us


def frame_signature(frame: list[dict]) -> tuple[str, ...]:
    return tuple(event["name"] for event in frame)

with open(input_path) as f:
    data = json.load(f)

trace_events = data.get("traceEvents", [])
events = [
    e for e in trace_events
    if e.get("ph") == "X" and e.get("dur", 0) > 0
]
if not events:
    print('{"error": "no GPU events"}', file=sys.stderr)
    sys.exit(1)

events.sort(key=lambda e: e["ts"])
cutoff_ts = events[0]["ts"] + int(warmup_s * 1_000_000)
filtered_trace_events = [
    e for e in trace_events
    if e.get("ph") != "X" or (e.get("dur", 0) > 0 and e.get("ts", cutoff_ts) >= cutoff_ts)
]
filtered_events = [
    e for e in events
    if e["ts"] >= cutoff_ts
]
if not filtered_events:
    print('{"error": "no GPU events after warmup"}', file=sys.stderr)
    sys.exit(1)

filtered_data = dict(data)
filtered_data["traceEvents"] = filtered_trace_events
with open(output_path, "w") as f:
    json.dump(filtered_data, f)

frames, frame_gap_us = group_frames(filtered_events)

frame_totals = [sum(e["dur"] / 1000.0 for e in frame) for frame in frames]

passes = {}
for e in filtered_events:
    passes.setdefault(e["name"], []).append(e["dur"] / 1000.0)

pass_stats = {}
for name, durs in sorted(passes.items(), key=lambda x: -statistics.mean(x[1])):
    pass_stats[name] = round(statistics.mean(durs), 3)

filtered_duration_s = (
    max(e["ts"] + e["dur"] for e in filtered_events) - min(e["ts"] for e in filtered_events)
) / 1_000_000.0
coverage_ok = filtered_duration_s >= measurement_s * (min_coverage_pct / 100.0)

signatures = [frame_signature(frame) for frame in frames if frame]
stable_frame_pct = 100.0
if signatures:
    _, dominant_count = Counter(signatures).most_common(1)[0]
    stable_frame_pct = dominant_count / len(signatures) * 100.0

layout_ok = stable_frame_pct >= min_stable_frame_pct
quality_gate_passed = len(frames) >= min_frames and coverage_ok and layout_ok

result = {
    "avg_gpu_ms": round(statistics.mean(frame_totals), 3),
    "median_gpu_ms": round(statistics.median(frame_totals), 3),
    "max_gpu_ms": round(max(frame_totals), 3),
    "frame_count": len(frames),
    "pass_count": len(passes),
    "filtered_duration_s": round(filtered_duration_s, 3),
    "frame_gap_us": None if frame_gap_us is None else round(frame_gap_us, 3),
    "stable_frame_pct": round(stable_frame_pct, 3),
    "layout_gate_passed": layout_ok,
    "quality_gate_passed": quality_gate_passed,
    "passes": pass_stats,
}
print(json.dumps(result))
PY

python3 "$SCRIPT_DIR/analyze-gpu-trace.py" "$TRACE_JSON" > "$ANALYSIS"
