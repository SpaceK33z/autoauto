# autoresearch-throughput config — pipeline throughput optimization

BUILD_CMD="cargo build --profile profiling --bin throughput_measure"

MEASURE_CMD="./scripts/measure-throughput.sh"
MEASURE_REPEATS=5

METRIC_FIELD="points_per_second"
METRIC_DIRECTION="higher"
SECONDARY_FIELD="ns_per_output_point"
QUALITY_GATE_FIELD="quality_gate_passed"

PROFILE_CMD="./scripts/profile-throughput.sh"

BRANCH_PREFIX="autoresearch/throughput"
STATE_DIR=".traces/autoresearch-throughput"
NOISE_THRESHOLD=1.0
