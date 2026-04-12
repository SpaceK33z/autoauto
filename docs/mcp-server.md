# MCP Server

AutoAuto exposes a [Model Context Protocol](https://modelcontextprotocol.io/) server so coding agents can create, configure, run, and monitor autoresearch programs without using the TUI or CLI.

## Starting the server

```bash
autoauto mcp                    # uses current directory
autoauto mcp --cwd /path/to/project  # explicit project root
```

The server uses **stdio transport** — it reads/writes JSON-RPC on stdin/stdout and logs to stderr. MCP clients (Claude Code, Cursor, etc.) spawn it as a subprocess.

### Client configuration

Add to your MCP client config (e.g. `.mcp.json`, Claude Code settings, etc.):

```json
{
  "mcpServers": {
    "autoauto": {
      "command": "autoauto",
      "args": ["mcp", "--cwd", "/path/to/project"]
    }
  }
}
```

## Tools

The server exposes 25 tools organized into five categories.

### Configuration & auth

| Tool | Description |
|------|-------------|
| `get_config` | Get project config (models, providers, notifications) |
| `set_config` | Update project config fields (only provided fields change) |
| `list_models` | List available models per provider with defaults |
| `check_auth` | Check authentication status for providers |

### Program management

| Tool | Description |
|------|-------------|
| `list_programs` | List all programs with goals and run counts |
| `get_program` | Get full program details (config, program.md, scripts) |
| `get_setup_guide` | Comprehensive guide for creating programs — read before `create_program` |
| `create_program` | Create a new program with all files |
| `update_program` | Update specific files in an existing program |
| `delete_program` | Permanently delete a program and all runs (requires `confirm=true`) |

### Agent sessions

Interactive setup and update conversations powered by a support-model agent.

| Tool | Description |
|------|-------------|
| `start_setup_session` | Start a setup conversation (`direct` or `analyze` mode) |
| `start_update_session` | Start an update conversation for an existing program (auto-seeds with last run context) |
| `send_session_message` | Send a user message and get the agent's reply |
| `get_session` | Get transcript and metadata for a session |
| `list_sessions` | List all persisted sessions |
| `delete_session` | Delete a session (requires `confirm=true`) |

### Run management

| Tool | Description |
|------|-------------|
| `start_run` | Start an experiment run (spawns background daemon) |
| `get_run_status` | Check run progress: phase, metrics, cost, daemon health |
| `list_runs` | List all runs for a program (newest first) |
| `get_run_results` | Get experiment results table (status, metric, change%, commit, description) |
| `get_experiment_log` | Get agent streaming output for a specific experiment |
| `stop_run` | Stop active run — soft stop (default) or hard abort |
| `update_run_limit` | Change max experiments cap mid-run |

### Post-run analysis

| Tool | Description |
|------|-------------|
| `get_run_summary` | Get or generate a summary report for a completed run |
| `validate_measurement` | Run measurement script multiple times, report CV% and stability assessment |

## Workflows

### Creating a program

1. `get_setup_guide` — learn artifact formats and best practices
2. `list_programs` — check for duplicates
3. `create_program` — write program.md, measure.sh, config.json, and optionally build.sh
4. `validate_measurement` — verify measurement stability (aim for CV <5%)

### Running experiments

1. `start_run` — spawns a background daemon that measures baseline then runs experiments autonomously
2. `get_run_status` — poll for progress (phase, metrics, keep rate, cost)
3. `get_run_results` — inspect individual experiment outcomes
4. `get_experiment_log` — read agent output for a specific experiment
5. `stop_run` — stop when satisfied (or let it hit the max experiments cap)
6. `get_run_summary` — get the final report (use `generate=true` if none exists)

### Updating a program after a run

1. `start_update_session` — begins a conversation pre-seeded with the latest run's results
2. `send_session_message` — iterate on the program definition with the agent
3. `update_program` — apply changes to specific files
4. `validate_measurement` — re-check if you changed measure.sh or config

## Tool reference

### get_config

Returns the full project configuration.

**Input:** none

**Output:** JSON with `executionModel`, `supportModel`, `executionFallbackModel`, `ideasBacklogEnabled`, `notificationPreset`, `notificationCommand`.

---

### set_config

Update project configuration. Only provided fields are changed.

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `executionModel` | `{provider, model, effort}` | Experiment agent model slot |
| `supportModel` | `{provider, model, effort}` | Setup/finalize agent model slot |
| `executionFallbackModel` | `{provider, model, effort} \| null` | Fallback model (null to clear) |
| `ideasBacklogEnabled` | boolean | Enable/disable ideas backlog |
| `notificationPreset` | string | `off`, `macos-notification`, `macos-say`, `terminal-bell`, `custom` |
| `notificationCommand` | string \| null | Custom notification command |

---

### list_models

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string? | Filter to one provider (`claude`, `codex`, `opencode`) |
| `force_refresh` | boolean | Ask provider to refresh model data (default false) |

**Output:** Per-provider list of models with `label`, `description`, `is_default`, and the provider's `default_model`.

---

### check_auth

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string? | Filter to one provider |

**Output:** Per-provider `authenticated`, `error`, `account`.

---

### list_programs

**Input:** none

**Output:** Array of `{name, goal, totalRuns, hasActiveRun}`.

---

### get_program

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |

**Output:** `{name, config, program_md, measure_sh, build_sh}`.

---

### get_setup_guide

**Input:** none

**Output:** Markdown guide covering artifact formats, measurement requirements, quality gate design, and anti-gaming rules.

---

### create_program

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug (lowercase, numbers, hyphens) |
| `program_md` | string | Full contents of program.md |
| `measure_sh` | string | Full contents of measure.sh |
| `build_sh` | string? | Full contents of build.sh (optional) |
| `config` | object | Program config (see below) |

**Config object:**

| Field | Type | Description |
|-------|------|-------------|
| `metric_field` | string | Key in measure.sh JSON output to optimize |
| `direction` | `lower` \| `higher` | Which direction is better |
| `noise_threshold` | number | Minimum relative improvement to keep (0.02 = 2%) |
| `repeats` | integer | Measurements per experiment |
| `max_experiments` | integer | Cap per run |
| `quality_gates` | object? | `{field: {min?, max?}}` — hard pass/fail constraints |
| `secondary_metrics` | object? | `{field: {direction}}` — advisory metrics |
| `max_consecutive_discards` | integer? | Auto-stop after N consecutive non-improving experiments |
| `measurement_timeout` | integer? | Timeout in ms for measure.sh (default 60000) |
| `build_timeout` | integer? | Timeout in ms for build.sh (default 600000) |
| `max_cost_usd` | number? | Cost cap per run in USD |
| `max_turns` | integer? | Max agent turns per experiment |
| `keep_simplifications` | boolean? | Keep experiments that simplify code without improving metric |
| `finalize_risk_assessment` | boolean? | Run risk assessment during finalization |

Fails if the program slug already exists. Call `validate_measurement` after creating.

---

### update_program

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `program_md` | string? | New program.md contents |
| `measure_sh` | string? | New measure.sh contents |
| `build_sh` | string? | New build.sh contents |
| `config` | object? | New config.json contents |

Only provided fields are overwritten.

---

### delete_program

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `confirm` | `true` | Must be `true` to confirm |

Refuses to delete programs with active runs.

---

### validate_measurement

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `runs` | integer | Number of measurement runs (1-20, default 5) |

Creates a temporary git worktree, runs build.sh + measure.sh multiple times, and reports:
- **CV%** — coefficient of variation
- **Assessment** — `deterministic` (<1%), `excellent` (1-5%), `acceptable` (5-15%), `noisy` (15-30%), `unstable` (>30%)
- **Recommended config** — suggested `noise_threshold` and `repeats` values

---

### start_setup_session

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `mode` | `direct` \| `analyze` | `analyze` for ideation, `direct` when you know the target |
| `message` | string? | Optional first message (direct mode) |
| `focus` | string? | Area to focus on (analyze mode) |
| `provider` | string? | Support-model provider override |
| `model` | string? | Support-model name override |
| `effort` | string? | Support-model effort override |

**Output:** `{session_id, kind, provider, model, effort, assistant_message, tool_events, messages}`.

---

### start_update_session

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `provider` | string? | Support-model provider override |
| `model` | string? | Support-model name override |
| `effort` | string? | Support-model effort override |

Auto-seeds the agent with the latest run's context (results, summary, metrics).

---

### send_session_message

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session ID |
| `message` | string | User message |

**Output:** `{session_id, assistant_message, tool_events, messages}`.

---

### get_session

**Input:** `session_id`

**Output:** Full session metadata and message transcript.

---

### list_sessions

**Input:** none

**Output:** Array of session summaries with `session_id`, `kind`, `program_slug`, `updated_at`, `message_count`.

---

### delete_session

**Input:** `session_id`, `confirm=true`

---

### start_run

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `provider` | string? | Agent provider (default: from project config) |
| `model` | string? | Model name (default: from project config) |
| `effort` | string? | Effort level (default: from project config) |
| `max_experiments` | integer? | Override max experiments |
| `use_worktree` | boolean | Use git worktree isolation (default true) |
| `carry_forward` | boolean | Carry forward context from previous runs (default true) |

**Output:** `{run_id, daemon_pid, status}`. The daemon runs in the background — use `get_run_status` to poll.

---

### get_run_status

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `run_id` | string? | Specific run ID (default: latest) |

**Output:** `{run_id, phase, daemon_alive, experiment_number, metric_field, direction, original_baseline, current_baseline, best_metric, improvement, keeps, discards, crashes, keep_rate, cost_usd, elapsed, model, provider, termination_reason, error}`.

---

### list_runs

**Input:** `name`

**Output:** Array of `{run_id, phase, experiments, best_metric, change}` (newest first).

---

### get_run_results

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `run_id` | string? | Specific run ID (default: latest) |
| `limit` | integer? | Return only the last N results |

**Output:** `{run_id, metric_field, direction, total_results, results: [{experiment_number, status, metric_value, change, commit, description, diff_stats}]}`.

---

### get_experiment_log

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `experiment_number` | integer \| `"latest"` | Experiment number (0 = baseline) or `"latest"` |
| `run_id` | string? | Specific run ID (default: latest) |

**Output:** Raw agent streaming output (thinking, tool use, code changes).

---

### stop_run

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `abort` | boolean | Hard abort (default: false = soft stop) |

Soft stop waits for the current experiment to finish. Hard abort kills the agent immediately and records the experiment as a crash.

---

### update_run_limit

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `max_experiments` | integer | New max experiments value |

Takes effect at the next experiment boundary.

---

### get_run_summary

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Program slug |
| `run_id` | string? | Specific run ID (default: latest) |
| `generate` | boolean | Generate stats summary if none exists (default false) |

Returns the existing summary if available. With `generate=true`, creates a stats-based summary for completed or crashed runs.
