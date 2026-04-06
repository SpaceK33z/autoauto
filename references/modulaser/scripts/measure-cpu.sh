#!/usr/bin/env bash
set -euo pipefail

# measure-cpu.sh — Launch Modulaser, replay setup, measure average CPU% over a fixed window.
# Outputs a single JSON line with avg_cpu, min_cpu, max_cpu, avg_fps, sample_count.
# Used by autoresearch-perf as the keep/discard metric.
#
# Usage: ./scripts/measure-cpu.sh [duration_seconds]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

BINARY="${PROFILE_BINARY:-target/profiling/modulaser}"
DURATION="${1:-${PROFILE_DURATION:-15}}"
WARMUP="${PROFILE_WARMUP:-3}"
INTERVAL="${PROFILE_INTERVAL:-0.5}"
SETUP_FILE="${PROFILE_SETUP_FILE:-$SCRIPT_DIR/profile-scenes/default.jsonl}"
REPLAY_SCRIPT="${PROFILE_REPLAY_SCRIPT:-$SCRIPT_DIR/profile-replay.sh}"
CTL_SCRIPT="${PROFILE_CTL_SCRIPT:-$SCRIPT_DIR/modulaser-ctl.sh}"
CONTROL_RUNTIME_DIR="${MODULASER_CONTROL_RUNTIME_DIR:-${AUTORESEARCH_STATE_DIR:-.traces}/control-runtime}"

if [ ! -f "$SETUP_FILE" ]; then
    echo "Error: $SETUP_FILE not found." >&2
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: $BINARY not found. Run: cargo build --profile profiling" >&2
    exit 1
fi

if "$CTL_SCRIPT" '{"cmd":"GetStateSummary"}' >/dev/null 2>&1; then
    echo "Error: existing Modulaser control-socket session detected. Stop it before measuring." >&2
    exit 1
fi

mkdir -p "$CONTROL_RUNTIME_DIR/modulaser"
export XDG_RUNTIME_DIR="$CONTROL_RUNTIME_DIR"
export MODULASER_CONTROL_SOCKET="$XDG_RUNTIME_DIR/modulaser/control.sock"

sample_count() {
    python3 - "$1" "$2" <<'PY'
import math
import sys

duration = float(sys.argv[1])
interval = float(sys.argv[2])
print(max(1, math.ceil(duration / interval)))
PY
}

cpu_seconds() {
    local raw
    raw=$(ps -p "$1" -o time= 2>/dev/null | tr -d '[:space:]' || true)
    if [ -z "$raw" ]; then
        echo ""
        return
    fi

    python3 - "$raw" <<'PY'
import sys

raw = sys.argv[1]
parts = raw.split('-')
days = 0
clock = raw
if len(parts) == 2:
    days = int(parts[0])
    clock = parts[1]

clock_parts = [float(part) for part in clock.split(':')]
seconds = 0.0
for value in clock_parts:
    seconds = seconds * 60.0 + value
seconds += days * 86400.0
print(f"{seconds:.6f}")
PY
}

cpu_window_pct() {
    python3 - "$1" "$2" "$3" <<'PY'
import sys

cpu_prev = float(sys.argv[1])
cpu_now = float(sys.argv[2])
elapsed = float(sys.argv[3])
if elapsed <= 0:
    print("0.0")
else:
    print(f"{((cpu_now - cpu_prev) / elapsed) * 100.0:.6f}")
PY
}

state_fields() {
    python3 -c '
import json
import sys

payload = json.load(sys.stdin)
data = payload.get("data", {})

def value(name):
    field = data.get(name)
    return "" if field is None else str(field)

print("\t".join([value("fps"), value("measured_fps"), value("frame_count"), value("ui_update_us"), value("ui_render_panels_us")]))
'
}

capture_state() {
    if RESP=$("$CTL_SCRIPT" '{"cmd":"GetStateSummary"}' 2>/dev/null); then
        IFS=$'\t' read -r fps measured frame_count ui_update ui_render <<<"$(printf '%s\n' "$RESP" | state_fields)"
        if [ -n "$fps" ]; then
            TARGET_FPS="$fps"
        fi
        if [ -n "$measured" ]; then
            FPS_SAMPLES+=("$measured")
        fi
        if [ -n "$frame_count" ]; then
            if [ -z "$FIRST_FRAME" ]; then
                FIRST_FRAME="$frame_count"
            fi
            LAST_FRAME="$frame_count"
        fi
        if [ -n "$ui_update" ]; then
            UI_UPDATE_SAMPLES+=("$ui_update")
        fi
        if [ -n "$ui_render" ]; then
            UI_RENDER_SAMPLES+=("$ui_render")
        fi
    fi
}

rm -f "$MODULASER_CONTROL_SOCKET"

"$BINARY" --debug-socket --uncapped-fps > /dev/null 2>&1 &
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

sleep "$WARMUP"
if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Error: App exited during warmup" >&2
    exit 1
fi

CPU_SAMPLES=()
FPS_SAMPLES=()
UI_UPDATE_SAMPLES=()
UI_RENDER_SAMPLES=()
TARGET_FPS=""
FIRST_FRAME=""
LAST_FRAME=""
CPU_START=$(cpu_seconds "$APP_PID")
CPU_PREV="$CPU_START"
capture_state

for _ in $(seq 1 "$(sample_count "$DURATION" "$INTERVAL")"); do
    sleep "$INTERVAL"

    if ! kill -0 "$APP_PID" 2>/dev/null; then
        echo "Error: App exited during measurement" >&2
        exit 1
    fi

    CPU_NOW=$(cpu_seconds "$APP_PID")
    if [ -n "$CPU_NOW" ]; then
        CPU_SAMPLES+=("$(cpu_window_pct "$CPU_PREV" "$CPU_NOW" "$INTERVAL")")
        CPU_PREV="$CPU_NOW"
    fi

    capture_state
done

if [ ${#CPU_SAMPLES[@]} -eq 0 ]; then
    echo "Error: No CPU samples collected" >&2
    exit 1
fi

CPU_END="$CPU_PREV"

python3 -c "
import json, statistics
cpu = [float(x) for x in '''${CPU_SAMPLES[*]}'''.split()]
fps = [float(x) for x in '''${FPS_SAMPLES[*]:-}'''.split()] if '''${FPS_SAMPLES[*]:-}'''.strip() else []
ui_update = [float(x) for x in '''${UI_UPDATE_SAMPLES[*]:-}'''.split()] if '''${UI_UPDATE_SAMPLES[*]:-}'''.strip() else []
ui_render = [float(x) for x in '''${UI_RENDER_SAMPLES[*]:-}'''.split()] if '''${UI_RENDER_SAMPLES[*]:-}'''.strip() else []
first_frame = int('''${FIRST_FRAME:-0}''') if '''${FIRST_FRAME:-}'''.strip() else None
last_frame = int('''${LAST_FRAME:-0}''') if '''${LAST_FRAME:-}'''.strip() else None
frame_delta = last_frame - first_frame if first_frame is not None and last_frame is not None else None
duration = float('''${DURATION}''')
avg_cpu = ((float('''${CPU_END}''') - float('''${CPU_START}''')) / duration * 100.0) if duration > 0 else statistics.fmean(cpu)
avg_fps = round(statistics.fmean(fps), 1) if fps else None
min_fps = round(min(fps), 1) if fps else None
avg_egui_update_us = round(statistics.fmean(ui_update), 1) if ui_update else None
avg_egui_render_us = round(statistics.fmean(ui_render), 1) if ui_render else None
# Quality gate: valid FPS data collected and frame count is reasonable
quality_gate_passed = (
    avg_fps is not None
    and avg_fps > 0
    and len(fps) >= 3
    and frame_delta is not None
    and frame_delta > 0
)
result = {
    'avg_cpu': round(avg_cpu, 1),
    'min_cpu': round(min(cpu), 1),
    'max_cpu': round(max(cpu), 1),
    'avg_fps': avg_fps,
    'min_fps': min_fps,
    'avg_egui_update_us': avg_egui_update_us,
    'avg_egui_render_us': avg_egui_render_us,
    'frame_count_delta': frame_delta,
    'quality_gate_passed': quality_gate_passed,
    'sample_count': len(cpu),
}
print(json.dumps(result))
"
