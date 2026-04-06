# autoresearch-perf config — CPU performance optimization for Modulaser
#
# Sourced by scripts/autoresearch.sh. Defines the domain-specific commands
# and settings for this autoresearch target.

# Build command run before each measurement
BUILD_CMD="cargo build --profile profiling"

# Measurement command — must output a single JSON line to stdout
MEASURE_CMD="./scripts/measure-cpu.sh"
MEASURE_REPEATS=3

# JSON field name containing the metric value (higher = better with uncapped FPS)
METRIC_FIELD="avg_fps"
METRIC_DIRECTION="higher"

# Secondary JSON field to log
SECONDARY_FIELD="avg_cpu"

# JSON field for quality gate (optional, must be "True"/"False")
QUALITY_GATE_FIELD="quality_gate_passed"

# Profile command — run to generate bottleneck analysis for Claude
PROFILE_CMD="./scripts/profile.sh"

# Branch prefix for autoresearch runs
BRANCH_PREFIX="autoresearch/perf"
STATE_DIR=".traces/autoresearch-perf"
