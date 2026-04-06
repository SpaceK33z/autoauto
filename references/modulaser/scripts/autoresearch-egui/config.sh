# autoresearch-egui config — egui UI performance optimization for Modulaser
#
# Sourced by scripts/autoresearch.sh. Defines the domain-specific commands
# and settings for this autoresearch target.
#
# Focuses specifically on egui rendering efficiency. Uses render_panels()
# wall-clock time (microseconds) as the primary metric — this measures only
# the egui widget building phase, isolating it from GPU/pipeline noise.

# Build command run before each measurement
BUILD_CMD="cargo build --profile profiling"

# Measurement command — must output a single JSON line to stdout
MEASURE_CMD="./scripts/measure-cpu.sh"
MEASURE_REPEATS=3

# JSON field name containing the metric value (lower = better, microseconds)
METRIC_FIELD="avg_egui_render_us"
METRIC_DIRECTION="lower"

# Secondary JSON field to log
SECONDARY_FIELD="avg_egui_update_us"

# JSON field for quality gate (optional, must be "True"/"False")
QUALITY_GATE_FIELD="quality_gate_passed"

# Profile command — run to generate bottleneck analysis for Claude
PROFILE_CMD="./scripts/profile.sh"

# Branch prefix for autoresearch runs
BRANCH_PREFIX="autoresearch/egui"
STATE_DIR=".traces/autoresearch-egui"
