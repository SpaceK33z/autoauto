#!/usr/bin/env bash
set -euo pipefail

# measure-memory.sh — Launch Modulaser with DHAT, replay setup, and measure
# heap allocations across the full reproducible run.
# Outputs a single JSON line with total_bytes, bytes_at_exit, total_blocks, allocation_points.
# Used by autoresearch-memory as the keep/discard metric.
#
# Requires the binary to be built with: cargo build --profile profiling --features dhat-heap
#
# Usage: ./scripts/measure-memory.sh [duration_seconds]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

BINARY="${PROFILE_BINARY:-target/profiling/modulaser}"
DURATION="${1:-${PROFILE_DURATION:-15}}"
WARMUP="${PROFILE_WARMUP:-3}"
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
    echo "Error: $BINARY not found. Run: cargo build --profile profiling --features dhat-heap" >&2
    exit 1
fi

if "$CTL_SCRIPT" '{"cmd":"GetStateSummary"}' >/dev/null 2>&1; then
    echo "Error: existing Modulaser control-socket session detected. Stop it before measuring." >&2
    exit 1
fi

mkdir -p "$CONTROL_RUNTIME_DIR/modulaser"
export XDG_RUNTIME_DIR="$CONTROL_RUNTIME_DIR"
export MODULASER_CONTROL_SOCKET="$XDG_RUNTIME_DIR/modulaser/control.sock"

# Clean up previous DHAT output
rm -f dhat-heap.json

rm -f "$MODULASER_CONTROL_SOCKET"

# Launch app (DHAT writes dhat-heap.json on exit)
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

# Replay scene setup for reproducibility
"$REPLAY_SCRIPT" "$SETUP_FILE" > /dev/null 2>&1

# Warmup — let allocations stabilize
sleep "$WARMUP"
if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Error: App exited during warmup" >&2
    exit 1
fi

# Wait for app auto-quit to trigger DHAT write
wait "$APP_PID" 2>/dev/null || true
trap - EXIT

if [ ! -f "dhat-heap.json" ]; then
    echo "Error: dhat-heap.json not found. Did the app exit cleanly?" >&2
    exit 1
fi

# Save full analysis to .traces/ for Claude to read (analyze-memory.py saves
# timestamped .json and .txt files to the output dir)
mkdir -p "$TRACES_DIR"
python3 "$SCRIPT_DIR/analyze-memory.py" dhat-heap.json --output-dir "$TRACES_DIR" \
    > /dev/null

# Extract metrics and output JSON line
python3 - <<'PY'
import json

with open("dhat-heap.json") as f:
    data = json.load(f)

pps = data.get("pps", [])
total_bytes = sum(pp.get("tb", 0) for pp in pps)
total_blocks = sum(pp.get("tbk", 0) for pp in pps)
bytes_at_exit = sum(pp.get("eb", 0) for pp in pps)

result = {
    "total_bytes": total_bytes,
    "total_blocks": total_blocks,
    "bytes_at_exit": bytes_at_exit,
    "allocation_points": len(pps),
}
print(json.dumps(result))
PY
