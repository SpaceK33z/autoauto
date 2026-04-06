# autoresearch-memory config — Heap allocation optimization for Modulaser
#
# Sourced by scripts/autoresearch.sh. Defines the domain-specific commands
# and settings for this autoresearch target.

# Build command — DHAT requires the dhat-heap feature flag
BUILD_CMD="cargo build --profile profiling --features dhat-heap"

# Measurement command — must output a single JSON line to stdout
MEASURE_CMD="./scripts/measure-memory.sh"
MEASURE_REPEATS=1

# JSON field name containing the metric value
METRIC_FIELD="total_bytes"

# Secondary JSON field to log (retained memory at exit)
SECONDARY_FIELD="bytes_at_exit"

# No quality gate — measurement script exits non-zero on failures
QUALITY_GATE_FIELD=""

# No separate profile step — measure-memory.sh saves full analysis to .traces/
PROFILE_CMD=""

# Branch prefix for autoresearch runs
BRANCH_PREFIX="autoresearch/memory"
STATE_DIR=".traces/autoresearch-memory"
