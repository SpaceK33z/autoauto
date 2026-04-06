#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

BINARY="${THROUGHPUT_BINARY:-target/profiling/throughput_measure}"
FRAMES="${THROUGHPUT_FRAMES:-900}"
WARMUP_FRAMES="${THROUGHPUT_WARMUP_FRAMES:-180}"
EXPECTED_DIGEST="${THROUGHPUT_EXPECTED_DIGEST:-7845763381779401653}"
EXPECTED_INPUT_POINTS="${THROUGHPUT_EXPECTED_INPUT_POINTS:-2515200}"
EXPECTED_RENDERED_POINTS="${THROUGHPUT_EXPECTED_RENDERED_POINTS:-2649900}"
EXPECTED_OUTPUT_POINTS="${THROUGHPUT_EXPECTED_OUTPUT_POINTS:-2649900}"

if [ ! -f "$BINARY" ]; then
    echo "Error: $BINARY not found. Run: cargo build --profile profiling --bin throughput_measure" >&2
    exit 1
fi

# On macOS, the binary links libndi/libShowNet but never calls them.
# Their load-time constructors start mDNS which triggers macOS permission
# dialogs that block unattended runs. Redirect to empty stubs instead.
if [ "$(uname)" = "Darwin" ]; then
    STUBS_DIR="$PROJECT_DIR/target/stubs"
    mkdir -p "$STUBS_DIR"
    for lib in libndi.dylib libShowNet.dylib; do
        if [ ! -f "$STUBS_DIR/$lib" ]; then
            echo '' | cc -shared -o "$STUBS_DIR/$lib" -x c - 2>/dev/null || true
        fi
    done
    export DYLD_LIBRARY_PATH="$STUBS_DIR${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi

RESULT="$("$BINARY" --frames "$FRAMES" --warmup-frames "$WARMUP_FRAMES")"

python3 - "$RESULT" "$EXPECTED_DIGEST" "$EXPECTED_INPUT_POINTS" "$EXPECTED_RENDERED_POINTS" "$EXPECTED_OUTPUT_POINTS" <<'PY'
import json
import sys

result = json.loads(sys.argv[1])
expected_digest = int(sys.argv[2])
expected_input = int(sys.argv[3])
expected_rendered = int(sys.argv[4])
expected_output = int(sys.argv[5])

quality_gate_passed = True
if expected_digest:
    quality_gate_passed = quality_gate_passed and result["output_digest"] == expected_digest
if expected_input:
    quality_gate_passed = quality_gate_passed and result["input_points"] == expected_input
if expected_rendered:
    quality_gate_passed = quality_gate_passed and result["rendered_points"] == expected_rendered
if expected_output:
    quality_gate_passed = quality_gate_passed and result["output_points"] == expected_output

payload = {
    "points_per_second": round(result["output_points_per_second"], 1),
    "rendered_points_per_second": round(result["rendered_points_per_second"], 1),
    "ns_per_output_point": round(result["ns_per_output_point"], 3),
    "input_points": result["input_points"],
    "rendered_points": result["rendered_points"],
    "output_points": result["output_points"],
    "output_digest": result["output_digest"],
    "quality_gate_passed": quality_gate_passed,
}
print(json.dumps(payload))
PY
