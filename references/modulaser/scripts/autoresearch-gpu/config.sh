# autoresearch-gpu config — GPU render pass optimization for Modulaser
#
# Sourced by scripts/autoresearch.sh. Defines the domain-specific commands
# and settings for this autoresearch target.

# Build command — gpu-profile enables wgpu-profiler timestamp queries
BUILD_CMD="cargo build --profile profiling --features gpu-profile"

# Measurement command — must output a single JSON line to stdout
MEASURE_CMD="./scripts/measure-gpu.sh"
MEASURE_REPEATS=3

# JSON field name containing the metric value
METRIC_FIELD="avg_gpu_ms"

# Secondary JSON field to log
SECONDARY_FIELD="max_gpu_ms"

# Require enough steady-state frames for a trustworthy comparison
QUALITY_GATE_FIELD="quality_gate_passed"

# No separate profile step — measure-gpu.sh saves full analysis to .traces/
PROFILE_CMD=""

# GPU timings have more variance than CPU, especially on integrated GPUs
NOISE_THRESHOLD=5.0

# Branch prefix for autoresearch runs
BRANCH_PREFIX="autoresearch/gpu"
STATE_DIR=".traces/autoresearch-gpu"
