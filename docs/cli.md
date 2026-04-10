# CLI Reference

AutoAuto's headless CLI provides full programmatic control for coding agents, CI pipelines, and scripting. All commands support `--json` for machine-readable output.

## Global flags

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON to stdout |
| `--cwd <path>` | Override working directory (defaults to current directory) |
| `--help` | Show command-specific usage and flags |

## Commands

### `list`

List all programs with status, last run, and best metric.

```bash
autoauto list
autoauto list --json
```

### `show <slug>`

Show program details: configuration, goal, measurement script, and run count.

```bash
autoauto show my-program
autoauto show my-program --json
```

**JSON output:**

```json
{
  "slug": "my-program",
  "config": {
    "metric_field": "score",
    "direction": "higher",
    "noise_threshold": 0.02,
    "repeats": 3,
    "max_experiments": 25,
    "quality_gates": {}
  },
  "goal": "Improve the scoring algorithm accuracy",
  "program_md": "...",
  "measure_script": "#!/bin/bash\n...",
  "build_script": null,
  "run_count": 3
}
```

### `start <slug>`

Start an experiment run. Spawns a background daemon and waits for baseline measurement.

```bash
autoauto start my-program
autoauto start my-program --no-wait              # Don't wait for baseline
autoauto start my-program --provider codex       # Use Codex agent
autoauto start my-program --model opus --effort high
autoauto start my-program --max-experiments 50
autoauto start my-program --in-place             # No worktree isolation
autoauto start my-program --no-carry-forward     # Fresh start, ignore previous runs
```

| Flag | Description |
|------|-------------|
| `--provider <name>` | Agent provider: `claude`, `codex`, `opencode` |
| `--model <name>` | Model name: `sonnet`, `opus`, or full model ID |
| `--effort <level>` | Effort level: `low`, `medium`, `high`, `max` |
| `--max-experiments <n>` | Maximum experiments to run |
| `--in-place` | Run without git worktree isolation |
| `--no-carry-forward` | Don't carry forward context from previous runs |
| `--no-ideas-backlog` | Disable ideas backlog for this run |
| `--no-wait` | Return immediately after spawning daemon |

### `status <slug>`

Show run status: phase, baseline/best metrics, keeps/discards, cost, elapsed time.

```bash
autoauto status my-program
autoauto status my-program --all                  # Show all runs
autoauto status my-program --run 20260407-143022  # Specific run
autoauto status my-program --json
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Specific run ID (default: latest) |
| `--all` | Show all runs for this program |

### `results <slug>`

Show experiment results table with metrics, status, and descriptions.

```bash
autoauto results my-program
autoauto results my-program --limit 10            # Last 10 results
autoauto results my-program --detail 5            # Full log for experiment #5
autoauto results my-program --detail latest       # Full log for latest experiment
autoauto results my-program --json
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Specific run ID (default: latest) |
| `--detail <n\|latest>` | Show detailed log for specific experiment |
| `--limit <n>` | Show last N results |

### `logs <slug>`

Read experiment stream logs — the raw agent output during an experiment.

```bash
autoauto logs my-program                          # Latest experiment, full log
autoauto logs my-program --experiment 5           # Specific experiment
autoauto logs my-program --tail                   # Last 50 lines
autoauto logs my-program --lines 100              # Last 100 lines
autoauto logs my-program --json
```

| Flag | Description |
|------|-------------|
| `--experiment <n>` | Specific experiment number (default: latest) |
| `--run <id>` | Specific run ID (default: latest) |
| `--tail` | Show last 50 lines |
| `--lines <n>` | Show last N lines |

**JSON output includes `is_streaming: true`** when the experiment is still in progress.

### `summary <slug>`

Show or generate a run summary report.

```bash
autoauto summary my-program                       # Read existing summary
autoauto summary my-program --generate            # Generate stats summary if missing
autoauto summary my-program --run 20260407-143022
autoauto summary my-program --json
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Specific run ID (default: latest) |
| `--generate` | Generate a stats summary if no summary exists (completed/crashed runs only) |

The `--generate` flag produces a stats-only summary (overview, statistics, metric timeline, kept changes). For a full agent-reviewed finalization report, use the TUI.

### `stop <slug>`

Stop the active run. By default, waits for the current experiment to finish.

```bash
autoauto stop my-program                          # Stop after current experiment
autoauto stop my-program --abort                  # Abort immediately
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Specific run ID |
| `--abort` | Abort immediately without waiting for current experiment |

### `limit <slug> <n>`

Update the maximum experiments cap on an active run.

```bash
autoauto limit my-program 50
```

### `validate <slug>`

Validate measurement script stability. Creates a temporary git worktree, runs the measurement multiple times, and reports statistical analysis.

```bash
autoauto validate my-program                      # 5 validation runs (default)
autoauto validate my-program --runs 10            # 10 validation runs
autoauto validate my-program --json
```

| Flag | Description |
|------|-------------|
| `--runs <n>` | Number of validation runs (default: 5) |

**Assessment levels:** deterministic (CV <1%), excellent (1-5%), acceptable (5-15%), noisy (15-30%), unstable (>30%).

**Human output:**

```
Build:          OK (1200ms)
Runs:           5/5 valid
Assessment:     excellent (CV 2.3%)
Metric:         score median=87.5 mean=87.2
Recommendations:
  noise_threshold: 0.02
  repeats: 3
Avg duration:   1.2s
```

### `delete <slug>`

Delete a program or a specific run. Requires `--confirm` for actual deletion.

```bash
autoauto delete my-program                        # Dry run: shows what would be deleted
autoauto delete my-program --confirm              # Delete program + all runs
autoauto delete my-program --run 20260407-143022 --confirm  # Delete specific run
```

| Flag | Description |
|------|-------------|
| `--run <id>` | Delete a specific run instead of entire program |
| `--confirm` | Confirm deletion (required) |

Without `--confirm`, shows what would be deleted and exits with code 1. Refuses to delete active runs.

### `config`

Show or update project configuration.

```bash
autoauto config                                   # Show all settings
autoauto config get execution-model               # Get specific value
autoauto config set execution-provider claude     # Set provider
autoauto config set execution-model opus          # Set model
autoauto config set execution-effort high         # Set effort
autoauto config set ideas-backlog false            # Disable ideas backlog
autoauto config set notification-preset macos-notification
autoauto config --json
```

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| *(none)* | Show all settings |
| `get <key>` | Get a specific value |
| `set <key> <value>` | Set a specific value |

**Keys:**

| Key | Values | Description |
|-----|--------|-------------|
| `execution-provider` | `claude`, `codex`, `opencode` | Experiment agent provider |
| `execution-model` | `sonnet`, `opus`, or full model ID | Experiment model |
| `execution-effort` | `low`, `medium`, `high`, `max` | Experiment effort level |
| `support-provider` | `claude`, `codex`, `opencode` | Setup/finalize agent provider |
| `support-model` | `sonnet`, `opus`, or full model ID | Setup/finalize model |
| `support-effort` | `low`, `medium`, `high`, `max` | Setup/finalize effort level |
| `ideas-backlog` | `true`, `false` | Enable/disable ideas backlog |
| `notification-preset` | `off`, `macos-notification`, `macos-say`, `terminal-bell`, `custom` | Notification type |
| `notification-command` | any string | Custom notification command |

### `queue`

Manage the run queue. Runs execute sequentially — when one finishes, the next starts automatically.

```bash
autoauto queue                                    # Show queue
autoauto queue list                               # Same as above
autoauto queue add my-program                     # Enqueue a run
autoauto queue add my-program --max-experiments 50 --provider codex
autoauto queue remove 3                           # Remove entry #3
autoauto queue clear                              # Clear all entries
```

## Agent workflow example

A typical coding agent workflow using the CLI:

```bash
# 1. Discover available programs
autoauto list --json

# 2. Understand what a program does
autoauto show my-program --json

# 3. Validate measurement is stable
autoauto validate my-program --json

# 4. Start a run
autoauto start my-program --json

# 5. Monitor progress
autoauto status my-program --json
autoauto results my-program --json

# 6. Check what the agent is doing
autoauto logs my-program --tail --json

# 7. When complete, read the summary
autoauto summary my-program --json
# Or generate one if it doesn't exist
autoauto summary my-program --generate --json

# 8. Clean up old runs
autoauto delete my-program --run 20260401-120000 --confirm --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | User error (invalid args, missing program, validation failure) |
| 2 | System error (daemon crash, shell command failure) |
