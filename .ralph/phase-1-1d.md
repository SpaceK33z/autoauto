# Phase 1, Section 1d: Measurement Validation — Implementation Plan

## Goal

After the setup agent generates and saves program artifacts (end of 1c), validate that `measure.sh` produces **stable, parseable results** before the user considers setup complete. Run the script multiple times, compute variance statistics, detect instability, and guide the user on noise threshold / repeats configuration. If measurements are unstable, iterate with the agent to fix the script.

## Section 1d Tasks (from phase-1.md)

1. Run `measure.sh` multiple times after generation
2. Check variance, warn if measurements are unreliable
3. Iterate with agent until measurement is stable
4. Guide user on noise threshold and repeats based on observed variance

## Current State

**Setup flow (1a + 1b + 1c) is fully implemented:**

- `src/components/Chat.tsx` — Multi-turn chat with streaming, tool status, `bypassPermissions`, Write/Edit tools
- `src/screens/SetupScreen.tsx` — Passes agent config: `tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"]`, `maxTurns=30`
- `src/lib/system-prompts.ts` — `getSetupSystemPrompt(cwd)` with 9-step conversation flow ending at "Save — write files using Write tool"
- `src/lib/programs.ts` — `getProjectRoot()`, `listPrograms()`, `ensureAutoAutoDir()`, `getProgramsDir()`
- `src/lib/tool-events.ts` — `formatToolEvent()` for Read, Write, Edit, Glob, Grep, Bash
- `src/lib/validate-measurement.ts` — does NOT exist yet
- `src/lib/measurement.ts` — does NOT exist yet

**What's missing (the work for 1d):**

1. No measurement validation logic — the setup flow ends after saving files
2. No standalone validation script that can run measure.sh multiple times and compute stats
3. System prompt doesn't include validation instructions or CV% interpretation guidance
4. No way to auto-update config.json with recommended noise_threshold / repeats
5. `maxTurns` may need increasing — validation adds ~3-5 more conversation turns

---

## Architecture Decisions

### 1. Standalone Validation Script via Bash, Not Custom MCP Tool

**Decision: Create a standalone Bun script `src/lib/validate-measurement.ts` that the agent calls via the Bash tool.**

The agent runs:
```bash
bun run <absolute_path>/validate-measurement.ts <measure_sh_path> <config_json_path> [runs]
```

**Considered alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| **A: Standalone script via Bash (chosen)** | No changes to Chat.tsx, testable independently, reliable stats computation | Agent needs absolute path, agent could modify the command |
| B: Custom MCP tool via `tool()` + `createSdkMcpServer()` | Clean tool interface, structured I/O | Requires MCP server setup in Chat.tsx, new pattern, SDK API needs verification |
| C: Agent-driven (pure system prompt) | Zero new code, simplest | LLM computes stats (unreliable), agent may not follow instructions precisely |
| D: App-level orchestration (outside agent session) | Most reliable, no LLM in the loop | No way to inject results into the conversation, breaks Chat-based architecture |

**Why standalone script wins:**

- Stats computation is deterministic TypeScript, not LLM math — median, stdev, CV% are computed correctly every time
- No changes to Chat.tsx or the query() call — the agent just uses Bash (already available)
- The script is independently testable: `bun run src/lib/validate-measurement.ts path/to/measure.sh path/to/config.json 5`
- The system prompt provides the exact command with absolute paths — the agent doesn't need to figure anything out
- The script outputs structured JSON that the agent reads and interprets for the user
- Phase 2 (execution) can reuse the measurement logic by extracting it into a shared module later

**Path resolution:** Use `import.meta.dir` in `system-prompts.ts` to compute the absolute path to `validate-measurement.ts` at runtime. This works because the system prompt is generated at runtime when the component mounts. The `import.meta.dir` Bun API returns the directory of the current file.

**MCP tool upgrade path:** If the standalone script approach proves brittle (agent modifying the command, path issues), the validation logic can be wrapped in a custom MCP tool later. The core logic in `validate-measurement.ts` would be extracted into `measurement.ts` and the MCP tool handler would call it. This is a straightforward refactor that doesn't change the validation logic itself.

### 2. CV% Thresholds for Stability Assessment

**Decision: Use industry-standard CV% thresholds for measurement stability assessment.**

Based on research across software benchmarking, analytical chemistry, and performance testing tools (Bencher, JMeter):

| CV% | Assessment | Action |
|-----|-----------|--------|
| < 5% | `excellent` | Proceed with confidence. Recommend noise_threshold = 2%, repeats = 3 |
| 5–15% | `acceptable` | Proceed with caution. Recommend noise_threshold = max(CV% * 1.5, 5%), repeats = 5 |
| 15–30% | `noisy` | Warning. Suggest fixes before proceeding. Recommend noise_threshold = max(CV% * 2, 10%), repeats = 7 |
| ≥ 30% | `unstable` | Too noisy. Strongly recommend fixing before proceeding. Don't suggest config — fix the measurement first |

**Noise threshold formula:** `noise_threshold = max(CV% * 1.5, minimum_for_tier)`. The improvement must exceed the noise floor — a 2% improvement means nothing if measurements vary by 5%. The 1.5x multiplier provides safety margin.

**Repeats formula:** More repeats reduce the effect of outliers by using medians. CV% < 5% needs only 3 repeats (measurements are tight). CV% 5-15% needs 5 (moderate noise). CV% 15-30% needs 7+ (heavy noise requires more samples to find a reliable median).

These thresholds and formulas are encoded in the validation script (deterministic) AND in the system prompt (so the agent can explain them to the user).

[CHANGED] ### 3. Validation Runs: 1 Warmup + 5 Measurement

**Decision: Run measure.sh 1+5 times by default for validation (1 warmup, 5 measured).**

- 1 warmup run excluded from stats — handles cold-start effects (JIT compilation, cache priming, OS scheduling). Research from Criterion.rs and JMH confirms warmup is standard practice for benchmarks.
- 5 measurement runs is enough to compute meaningful CV% for typical measurement scripts
- 3 measurement runs is too few — one outlier skews everything
- 10 measurement runs is excessive for validation (this isn't the experiment loop)
- The script accepts a configurable run count argument for edge cases (affects measurement runs only; warmup always runs once)
- If the measurement script is slow (>10s), the agent should tell the user it will take a moment — total validation time is (1 warmup + 5 measured) × script duration

### 4. Extend Conversation Flow, Don't Create a New Screen

**Decision: Measurement validation is a continuation of the setup conversation, not a separate screen or mode.**

The current flow is:
```
Inspect → Clarify → Scope → Rules → Measurement → Quality Gates → Generate & Review → Iterate → Save
```

After 1d, it becomes:
```
... → Save → Validate → Assess → (Fix & Re-validate)* → Recommend → Update Config → Done
```

This keeps everything in the Chat-based architecture. The agent drives the validation, presents results, discusses fixes, and updates config.json — all within the existing conversation.

### 5. Increase maxTurns from 30 to 40

**Decision: Increase `SETUP_MAX_TURNS` from 30 to 40.**

The validation phase adds ~3-5 conversation turns:
- Agent announces validation + runs it (1 turn)
- Agent presents results + recommendations (1 turn)
- User reviews / asks questions (1 turn)
- If unstable: discuss fixes, re-validate (2-3 turns)
- Agent updates config.json (1 turn)

30 was chosen for 1c. Adding validation headroom pushes to 35-40. Use 40 for safety.

---

## Files to Create

### 1. `src/lib/validate-measurement.ts` — Standalone Measurement Validation Script

A standalone Bun script that runs `measure.sh` multiple times and outputs structured validation results as JSON to stdout.

**Usage:**
```bash
bun run src/lib/validate-measurement.ts <measure_sh_path> <config_json_path> [runs]
```

**Arguments:**
- `measure_sh_path` — absolute path to the measurement script
- `config_json_path` — absolute path to the program's config.json
- `runs` — number of validation runs (default: 5)

**Output:** Single JSON object on stdout.

#### Input Parsing

[CHANGED] ```typescript
#!/usr/bin/env bun
import { readFileSync } from "node:fs"
import { dirname } from "node:path"

const [measureShPath, configJsonPath, runsStr] = process.argv.slice(2)

if (!measureShPath || !configJsonPath) {
  console.error("Usage: validate-measurement.ts <measure_sh> <config_json> [runs]")
  process.exit(1)
}

const numRuns = parseInt(runsStr || "5", 10)
// [CHANGED] Resolve cwd from measure.sh's location — go up from .autoauto/programs/<slug>/
// to the project root. This ensures measure.sh runs in the correct directory regardless
// of where the validation script was invoked from.
const projectRoot = dirname(dirname(dirname(dirname(measureShPath))))
```

#### Config Parsing

Read and validate config.json:

```typescript
interface QualityGate {
  min?: number
  max?: number
}

interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
}

let config: ProgramConfig
try {
  config = JSON.parse(readFileSync(configJsonPath, "utf-8"))
} catch (err) {
  console.log(JSON.stringify({ success: false, error: `Failed to read config.json: ${err}` }))
  process.exit(0) // exit 0 so Bash tool doesn't report a crash — error is in the JSON
}

if (!config.metric_field || !config.direction) {
  console.log(JSON.stringify({ success: false, error: "config.json missing metric_field or direction" }))
  process.exit(0)
}
```

**Important:** The script exits 0 even on validation failures. Errors are reported in the JSON output. This prevents the Bash tool from treating validation failures as command crashes.

#### Measurement Execution

Run measure.sh N times sequentially. Each run:
1. Spawn `bash <measure_sh_path>` with 60-second timeout
2. Capture stdout and stderr
3. Check exit code
4. Parse stdout as JSON
5. Validate metric_field exists and is a finite number
6. Validate quality gate fields exist and are finite numbers
7. Record the result or the error

```typescript
interface RunResult {
  run: number
  success: boolean
  output?: Record<string, unknown>
  error?: string
  duration_ms: number
}

[CHANGED] async function runMeasurement(measureShPath: string, run: number, cwd: string): Promise<RunResult> {
  const start = performance.now()
  try {
    const proc = Bun.spawn(["bash", measureShPath], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,                          // [CHANGED] Explicitly set cwd to project root
      env: { ...process.env },
      timeout: 60_000,              // [CHANGED] Use Bun's built-in timeout (kills process + cleans up automatically)
    })

    const exitCode = await proc.exited

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const duration_ms = Math.round(performance.now() - start)

    if (exitCode !== 0) {
      return {
        run,
        success: false,
        error: `exit code ${exitCode}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
        duration_ms,
      }
    }

    // Parse JSON
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(stdout.trim())
    } catch {
      return {
        run,
        success: false,
        error: `invalid JSON on stdout: ${stdout.trim().slice(0, 200)}`,
        duration_ms,
      }
    }

    // Must be an object, not array or scalar
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        run,
        success: false,
        error: `stdout must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
        duration_ms,
      }
    }

    return { run, success: true, output: parsed, duration_ms }
  } catch (err: unknown) {
    const duration_ms = Math.round(performance.now() - start)
    return {
      run,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms,
    }
  }
}
```

[CHANGED] **Key details:**
- Inherit `process.env` so measure.sh has access to environment variables (PATH, etc.)
- Explicitly set `cwd` to the project root (passed as argument) — don't rely on cwd inheritance through the Bash tool → bun run → Bun.spawn chain
- Use Bun.spawn's built-in `timeout` option (60 seconds) — this kills the process and cleans up automatically, avoiding the resource leak and race conditions of manual `Promise.race` + `setTimeout`
- 60-second timeout per run — matches the "must complete in <60 seconds max" requirement from IDEA.md
- Parse stdout strictly — must be a JSON object, not array/scalar

#### Field Validation

After each successful run, validate the output against config.json:

```typescript
function validateOutput(
  output: Record<string, unknown>,
  config: ProgramConfig,
  run: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check metric_field
  const metricValue = output[config.metric_field]
  if (metricValue === undefined) {
    errors.push(`metric_field "${config.metric_field}" missing from output`)
  } else if (typeof metricValue !== "number" || !isFinite(metricValue)) {
    errors.push(`metric_field "${config.metric_field}" is not a finite number: ${metricValue}`)
  }

  // Check quality gate fields
  for (const field of Object.keys(config.quality_gates)) {
    const value = output[field]
    if (value === undefined) {
      errors.push(`quality gate field "${field}" missing from output`)
    } else if (typeof value !== "number" || !isFinite(value)) {
      errors.push(`quality gate field "${field}" is not a finite number: ${value}`)
    }
  }

  return { valid: errors.length === 0, errors }
}
```

#### Statistics Computation

For each numeric field (metric + quality gates), compute:

```typescript
interface FieldStats {
  field: string
  values: number[]
  median: number
  mean: number
  min: number
  max: number
  stdev: number
  cv_percent: number
}

function computeStats(field: string, values: number[]): FieldStats {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)]
  const mean = values.reduce((a, b) => a + b, 0) / n
  const min = sorted[0]
  const max = sorted[n - 1]
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1) // sample variance
  const stdev = Math.sqrt(variance)
  const cv_percent = mean !== 0 ? (stdev / Math.abs(mean)) * 100 : Infinity

  return {
    field,
    values,
    median: round(median, 4),
    mean: round(mean, 4),
    min: round(min, 4),
    max: round(max, 4),
    stdev: round(stdev, 4),
    cv_percent: round(cv_percent, 2),
  }
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(n * factor) / factor
}
```

**Sample variance** (n-1 denominator) is correct here — we're estimating population variance from a sample of runs.

#### Stability Assessment & Recommendations

```typescript
type Assessment = "excellent" | "acceptable" | "noisy" | "unstable"

function assess(cv_percent: number): Assessment {
  if (cv_percent < 5) return "excellent"
  if (cv_percent < 15) return "acceptable"
  if (cv_percent < 30) return "noisy"
  return "unstable"
}

function recommend(cv_percent: number): {
  noise_threshold: number
  repeats: number
} {
  if (cv_percent < 5) {
    return { noise_threshold: 0.02, repeats: 3 }
  }
  if (cv_percent < 15) {
    return {
      noise_threshold: round(Math.max(cv_percent * 1.5 / 100, 0.05), 2),
      repeats: 5,
    }
  }
  if (cv_percent < 30) {
    return {
      noise_threshold: round(Math.max(cv_percent * 2 / 100, 0.10), 2),
      repeats: 7,
    }
  }
  // Unstable — don't recommend config, fix the measurement first
  return { noise_threshold: -1, repeats: -1 }
}
```

#### Output Format

The script outputs a single JSON object to stdout:

```typescript
interface ValidationOutput {
  success: boolean
  total_runs: number
  valid_runs: number
  failed_runs: Array<{ run: number; error: string }>
  validation_errors: Array<{ run: number; errors: string[] }>
  metric: FieldStats | null
  quality_gates: Record<string, FieldStats>
  assessment: Assessment | null
  recommendations: {
    noise_threshold: number
    repeats: number
  } | null
  avg_duration_ms: number
}
```

**Success case:**
```json
{
  "success": true,
  "total_runs": 5,
  "valid_runs": 5,
  "failed_runs": [],
  "validation_errors": [],
  "metric": {
    "field": "lcp_ms",
    "values": [1230, 1180, 1250, 1210, 1200],
    "median": 1210,
    "mean": 1214,
    "min": 1180,
    "max": 1250,
    "stdev": 25.1,
    "cv_percent": 2.07
  },
  "quality_gates": {
    "cls": {
      "field": "cls",
      "values": [0.05, 0.04, 0.06, 0.05, 0.05],
      "median": 0.05,
      "mean": 0.05,
      "min": 0.04,
      "max": 0.06,
      "stdev": 0.007,
      "cv_percent": 14.14
    }
  },
  "assessment": "excellent",
  "recommendations": {
    "noise_threshold": 0.02,
    "repeats": 3
  },
  "avg_duration_ms": 2340
}
```

**Failure case:**
```json
{
  "success": false,
  "total_runs": 5,
  "valid_runs": 2,
  "failed_runs": [
    { "run": 1, "error": "exit code 1: npm ERR! Missing script: \"benchmark\"" },
    { "run": 3, "error": "timeout after 60s" },
    { "run": 5, "error": "invalid JSON on stdout: Listening on port 3000..." }
  ],
  "validation_errors": [],
  "metric": null,
  "quality_gates": {},
  "assessment": null,
  "recommendations": null,
  "avg_duration_ms": 15200
}
```

**Partial success (all runs pass but validation fails):**
```json
{
  "success": false,
  "total_runs": 5,
  "valid_runs": 5,
  "failed_runs": [],
  "validation_errors": [
    { "run": 1, "errors": ["quality gate field \"cls\" missing from output"] },
    { "run": 2, "errors": ["quality gate field \"cls\" missing from output"] }
  ],
  "metric": { "field": "lcp_ms", "values": [1230, 1180, 1250, 1210, 1200], "...": "..." },
  "quality_gates": {},
  "assessment": "excellent",
  "recommendations": { "noise_threshold": 0.02, "repeats": 3 },
  "avg_duration_ms": 2340
}
```

#### Main Execution Flow

```typescript
async function main() {
  // 1. Parse args and config (see above)
  // [CHANGED] 2. Warmup run — excluded from stats (cold-start effects inflate CV%)
  process.stderr.write(`Warmup run...`)
  const warmup = await runMeasurement(measureShPath, 0, projectRoot)
  process.stderr.write(` ${warmup.success ? "OK" : "FAIL"} (${warmup.duration_ms}ms)\n`)

  // 3. Run measure.sh N times sequentially (measurement runs)
  const results: RunResult[] = []
  for (let i = 0; i < numRuns; i++) {
    // Print progress to stderr (agent sees this in Bash stderr)
    process.stderr.write(`Run ${i + 1}/${numRuns}...`)
    const result = await runMeasurement(measureShPath, i + 1, projectRoot)
    process.stderr.write(` ${result.success ? "OK" : "FAIL"} (${result.duration_ms}ms)\n`)
    results.push(result)
  }

  // 4. Separate successful and failed runs
  const successfulRuns = results.filter((r) => r.success && r.output)
  const failedRuns = results.filter((r) => !r.success).map((r) => ({ run: r.run, error: r.error! }))

  // 5. Validate outputs against config
  const validationErrors: Array<{ run: number; errors: string[] }> = []
  const validOutputs: Array<{ run: number; output: Record<string, unknown> }> = []
  for (const r of successfulRuns) {
    const validation = validateOutput(r.output!, config, r.run)
    if (validation.valid) {
      validOutputs.push({ run: r.run, output: r.output! })
    } else {
      validationErrors.push({ run: r.run, errors: validation.errors })
    }
  }

  // 6. Compute stats if we have enough valid runs (>= 2)
  let metric: FieldStats | null = null
  const qualityGateStats: Record<string, FieldStats> = {}
  let assessment: Assessment | null = null
  let recommendations: { noise_threshold: number; repeats: number } | null = null

  if (validOutputs.length >= 2) {
    // Metric stats
    const metricValues = validOutputs.map((r) => r.output[config.metric_field] as number)
    metric = computeStats(config.metric_field, metricValues)
    assessment = assess(metric.cv_percent)
    const rec = recommend(metric.cv_percent)
    recommendations = rec.noise_threshold >= 0 ? rec : null

    // Quality gate stats
    for (const field of Object.keys(config.quality_gates)) {
      const values = validOutputs
        .map((r) => r.output[field])
        .filter((v): v is number => typeof v === "number" && isFinite(v))
      if (values.length >= 2) {
        qualityGateStats[field] = computeStats(field, values)
      }
    }
  }

  // 7. Output result
  const avgDuration = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.duration_ms, 0) / results.length)
    : 0

  const output: ValidationOutput = {
    success: failedRuns.length === 0 && validationErrors.length === 0 && validOutputs.length >= 2,
    total_runs: numRuns,
    valid_runs: validOutputs.length,
    failed_runs: failedRuns,
    validation_errors: validationErrors,
    metric,
    quality_gates: qualityGateStats,
    assessment,
    recommendations,
    avg_duration_ms: avgDuration,
  }

  console.log(JSON.stringify(output, null, 2))
}

main().catch((err) => {
  console.log(JSON.stringify({ success: false, error: String(err) }))
})
```

[CHANGED] **Key implementation details:**
- 1 warmup run + N measurement runs, all sequential — warmup handles cold-start effects (JIT, cache priming)
- Runs are sequential (not parallel) — parallel runs could interfere with each other (port conflicts, CPU contention, shared state)
- Progress printed to stderr — the agent sees this during the Bash call and can relay to the user
- Minimum 2 valid measurement runs needed for stats (can't compute stdev with 1 value)
- `JSON.stringify(output, null, 2)` — pretty-printed for readability in the agent's Bash output
- `cwd` explicitly passed to Bun.spawn — don't rely on inheritance through Bash → bun run chain
- Top-level `.catch()` ensures errors produce valid JSON, not stack traces

#### File Size Estimate

~150-180 lines of TypeScript. Single file, no imports beyond `node:fs` and Bun globals.

---

## Files to Modify

### 2. `src/lib/system-prompts.ts` — Add Measurement Validation Flow

This is the main integration point. The system prompt must guide the agent through the validation flow after saving files.

#### 2a. Compute the validation script path

At the top of `getSetupSystemPrompt()`, add:

```typescript
import { join } from "node:path"

export function getSetupSystemPrompt(cwd: string): string {
  const programsDir = getProgramsDir(cwd)
  const validateScript = join(import.meta.dir, "validate-measurement.ts")
  // ... rest of prompt
}
```

`import.meta.dir` returns the directory of `system-prompts.ts`, which is `src/lib/`. The validation script lives in the same directory.

#### 2b. Extend the Conversation Flow section

Replace step 9 (Save) and add steps 10-13. Find the current step 9:

```
9. **Save** — Once the user confirms, write the files using the Write tool (see exact paths and instructions below).
```

Replace with:

```
9. **Save** — Once the user confirms, write the files using the Write tool (see exact paths and instructions below).
10. **Validate** — After saving, validate measurement stability. Run the validation script (see Measurement Validation below). Tell the user: "Now let's validate that your measurement script produces stable results. I'll run it 5 times."
11. **Assess** — Present the validation results to the user. Explain what CV% means for their specific metric. If the measurement is stable, recommend noise_threshold and repeats.
12. **Fix & Re-validate** — If the measurement is noisy or unstable, discuss causes and fixes with the user. Edit measure.sh to address issues, then re-run validation. Repeat until stable or the user accepts the risk.
13. **Update Config** — Once the user is satisfied with measurement stability, update config.json with the recommended noise_threshold and repeats (use the Edit tool). Confirm completion: "Setup complete! Your program is ready. Press Escape to go back."
```

#### 2c. Add a new "Measurement Validation" section

Add this section after "Saving Files" and before "Key Principles":

```
## Measurement Validation

After saving program files, validate measurement stability before setup is complete.

### Running Validation

Run this exact command via Bash (substituting the actual slug):
\`\`\`bash
bun run ${validateScript} ${programsDir}/<slug>/measure.sh ${programsDir}/<slug>/config.json 5
\`\`\`

[CHANGED] This runs 1 warmup run (excluded from stats) + 5 measurement runs, validates each output against config.json, and computes variance statistics. The output is a JSON object with the results.

### Interpreting Results

The validation script computes the **coefficient of variation (CV%)** — the ratio of standard deviation to mean, expressed as a percentage. Lower CV% = more stable measurements.

| CV% | Assessment | What to tell the user |
|-----|-----------|----------------------|
| < 5% | Excellent | "Your measurement is very stable. Noise threshold of 2% and 3 repeats per experiment should work well." |
| 5–15% | Acceptable | "Measurements have moderate variance. I recommend a noise threshold of X% and 5 repeats per experiment to ensure reliable results." |
| 15–30% | Noisy | "Measurements show significant variance (CV% = X%). This means small improvements will be hard to detect. Let's try to reduce the noise before proceeding." |
| ≥ 30% | Unstable | "Measurements are too noisy to run reliable experiments (CV% = X%). We need to fix this before proceeding." |

### Common Noise Causes & Fixes

If measurements are noisy, diagnose and fix. Common causes:

1. **Cold starts** — First run is slower than subsequent runs. Fix: add a warmup run at the start of measure.sh that's excluded from the measurement.
2. **Background processes** — CPU/memory contention from other processes. Fix: close resource-heavy apps, or measure relative to a fixed baseline.
3. **Network calls** — External API latency varies. Fix: mock external calls, use local servers, or cache API responses.
4. **Non-deterministic code** — Random seeds, shuffled data, concurrent operations. Fix: lock random seeds, fix ordering, isolate test state.
5. **Caching** — First run populates caches, subsequent runs are faster. Fix: either always warm the cache first, or always clear it.
6. **Shared state between runs** — Previous run affects the next. Fix: clean up state between runs in the measurement script.
7. **Short measurement duration** — Timer resolution issues. Fix: increase sample size or measurement duration.

After fixing, re-run validation with the same command.

### Updating Config

When the user accepts the measurement stability, update config.json with the recommended noise_threshold and repeats using the Edit tool. The validation script's "recommendations" field provides the suggested values.

If the validation suggests noise_threshold of 0.02 and repeats of 3, but the user's config.json currently has 0.05 and 5, update it:
\`\`\`json
{
  "noise_threshold": 0.02,
  "repeats": 3
}
\`\`\`

Always confirm with the user before updating: "Based on the validation results, I recommend a noise threshold of 2% and 3 repeats. Should I update config.json?"
```

#### 2d. Update the "What NOT to Do" section

Add to the existing "What NOT to Do" list:

```
- Don't skip measurement validation — always validate after saving program files
- Don't let the user proceed with CV% > 30% without an explicit acknowledgment of the risk
- Don't recommend noise_threshold lower than the observed CV% — the threshold must exceed the noise floor
```

#### 2e. Full system prompt section order after changes

1. Identity + Role
2. Context (working directory)
3. Capabilities
4. Conversation Flow (updated: steps 9-13 for save + validate + assess + fix + update)
5. Artifact Generation (from 1c)
6. Saving Files (from 1c)
7. **Measurement Validation (NEW)**
8. Key Principles (unchanged)
9. Measurement Script Requirements (unchanged)
10. Autoresearch Expertise (unchanged)
11. What NOT to Do (updated)

### 3. `src/screens/SetupScreen.tsx` — Increase maxTurns

Change:

```typescript
const SETUP_MAX_TURNS = 30
```

To:

```typescript
const SETUP_MAX_TURNS = 40
```

This is the only change to SetupScreen.tsx.

### 4. `src/lib/programs.ts` — Add readProgramConfig helper

Add a function to read and parse a program's config.json. This is used by the validation script and will be useful for Phase 2.

```typescript
export interface QualityGate {
  min?: number
  max?: number
}

export interface ProgramConfig {
  metric_field: string
  direction: "lower" | "higher"
  noise_threshold: number
  repeats: number
  quality_gates: Record<string, QualityGate>
}
```

[CHANGED] **Note:** Add `QualityGate` and `ProgramConfig` types to programs.ts unconditionally. The 1c plan intended to add them, but the implementer may not have done so (the 1c plan was revised and these types were at risk of being skipped). Check first — if they already exist, skip this step.

The validation script (`validate-measurement.ts`) defines its own interface inline rather than importing from programs.ts, because it's a standalone script and we want to minimize import dependencies. When Phase 2 arrives, we can extract a shared types file.

### 5. No Changes to `src/components/Chat.tsx`

The Chat component already handles all the tools needed for 1d:
- Bash tool: used to run the validation script
- Edit tool: used to update config.json and measure.sh
- Streaming: agent's validation commentary streams normally
- Tool status: "⟳ Running: bun run validate-measurement.ts..." shows during validation

No modifications required.

### 6. No Changes to `src/lib/tool-events.ts`

The agent calls the validation script via the Bash tool. `formatToolEvent("Bash", { command: "bun run ..." })` already produces `"Running: bun run validate-measurement.ts ..."` (truncated at 60 chars). No new formatting needed.

---

## Integration Flow

```
1.  [1c complete] Agent saves program.md, measure.sh, config.json          (EXISTING)
2.  Agent says: "Files saved. Now let's validate measurement stability."    (NEW)
3.  Agent runs validation script via Bash:                                  (NEW)
    bun run <path>/validate-measurement.ts <measure_sh> <config_json> 5
4.  Tool status shows: "⟳ Running: bun run validate-measurement.ts..."     (EXISTING — Bash formatting)
5.  Validation script runs measure.sh 5 times, outputs JSON to stdout       (NEW)
6.  Agent receives JSON result from Bash tool output                        (EXISTING)
7.  Agent interprets the result:                                            (NEW)
    a. If assessment = "excellent" or "acceptable":
       - Present stats (CV%, median, range)
       - Recommend noise_threshold and repeats
       - Ask: "Should I update config.json with these settings?"
       - On user confirmation: Edit config.json with recommended values
       - Say: "Setup complete! Your program is ready. Press Escape to go back."
    b. If assessment = "noisy":
       - Present stats with warning
       - Diagnose likely causes (based on measure.sh content + stats)
       - Suggest specific fixes
       - If user wants to fix: Edit measure.sh, re-run validation (back to step 3)
       - If user accepts risk: recommend conservative noise_threshold + repeats
    c. If assessment = "unstable":
       - Present stats with strong warning
       - Explain why this is too noisy for reliable experiments
       - Diagnose causes, suggest fixes
       - Re-run validation after fixes (back to step 3)
    d. If success = false (runs crashed / invalid output):
       - Present specific errors from failed_runs / validation_errors
       - Diagnose the issue (e.g., missing dependency, stdout pollution, missing field)
       - Fix measure.sh or config.json, re-run validation (back to step 3)
8.  User presses Escape → navigates to "home"                              (EXISTING)
9.  Program appears in list with validated measurement config                (EXISTING)
```

---

## Testing

### Unit Testing the Validation Script

The validation script can be tested independently without the TUI:

```bash
# Create a test measurement script
mkdir -p /tmp/test-program
cat > /tmp/test-program/measure.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Simulate a measurement with slight noise
value=$((RANDOM % 10 + 95))
echo "{\"score\": $value, \"latency_ms\": $((RANDOM % 5 + 10))}"
EOF
chmod +x /tmp/test-program/measure.sh

cat > /tmp/test-program/config.json << 'EOF'
{
  "metric_field": "score",
  "direction": "higher",
  "noise_threshold": 0.05,
  "repeats": 3,
  "quality_gates": {
    "latency_ms": { "max": 50 }
  }
}
EOF

# Run validation
cd /tmp
bun run /path/to/autoauto/src/lib/validate-measurement.ts \
  /tmp/test-program/measure.sh \
  /tmp/test-program/config.json \
  5
```

Expected: JSON output with stats, assessment, and recommendations.

### Test cases

1. **Stable measurement** — consistent results, low CV%. Expect: assessment = "excellent" or "acceptable"
2. **Noisy measurement** — high variance. Expect: assessment = "noisy" or "unstable"
3. **Crashing measurement** — script exits non-zero. Expect: success = false, error details
4. **Invalid JSON output** — script prints non-JSON. Expect: success = false, parse error
5. **Missing metric_field** — JSON doesn't contain the configured field. Expect: validation_errors
6. **Missing quality gate field** — JSON lacks a quality gate field. Expect: validation_errors
7. **Timeout** — script hangs. Expect: timeout error after 60s
8. **Partial failures** — some runs succeed, some fail. Expect: stats from successful runs + error list
9. **All runs fail** — expect: success = false, no stats
10. **Single valid run** — only 1 of 5 succeeds. Expect: success = false (need >= 2 for stats)

### Manual TUI Testing via tmux

```bash
# First, create a program via the setup flow (1c must work)
# Then verify the validation flow continues after save

cd /Users/keeskluskens/dev/autoauto
tmux new-session -d -s autoauto -x 120 -y 40 'bun dev'

# Navigate to setup
sleep 2
tmux send-keys -t autoauto 'n'
sleep 1

# Quick setup — ask agent to create a simple test program
tmux send-keys -t autoauto "Create a simple program that measures how long 'bun typecheck' takes in this repo" Enter
sleep 15

# Follow agent's questions about scope, rules, etc.
# Eventually: review artifacts, confirm save
# After save: agent should automatically start measurement validation

# Watch for:
# 1. Agent announces validation
# 2. Tool status shows "⟳ Running: bun run validate-measurement.ts..."
# 3. Agent presents stats + assessment
# 4. Agent recommends noise_threshold + repeats
# 5. Agent offers to update config.json

tmux capture-pane -t autoauto -p -S -200  # capture scrollback

# If the measurement is noisy, the agent should discuss fixes
# If stable, accept the recommendation
tmux send-keys -t autoauto "Yes, update the config" Enter
sleep 10
tmux capture-pane -t autoauto -p

# Verify config.json was updated
cat .autoauto/programs/*/config.json

# Verify the agent says "Setup complete!"
tmux capture-pane -t autoauto -p

tmux kill-session -t autoauto
```

### Testing the iteration flow

```bash
# Create a deliberately noisy measurement to test the fix-and-retry flow
# E.g., a measure.sh that includes random sleep or uses RANDOM for the metric

# Agent should:
# 1. Detect high CV%
# 2. Warn the user
# 3. Suggest fixes (e.g., "the script uses $RANDOM which is non-deterministic")
# 4. Edit measure.sh to fix
# 5. Re-run validation
# 6. Present improved stats
```

### Verification Checklist

1. **Validation runs** — Script executes measure.sh 5 times successfully
2. **Stats computation** — Median, stdev, CV% are correct (verify manually for a known dataset)
3. **Assessment** — CV% < 5% → excellent, 5-15% → acceptable, 15-30% → noisy, ≥30% → unstable
4. **Recommendations** — noise_threshold and repeats match the assessment tier
5. **Error handling** — Crashed runs, invalid JSON, missing fields all reported cleanly
6. **Iteration** — Agent can fix measure.sh and re-run validation
7. **Config update** — Agent updates config.json with Edit tool after user confirms
8. **Flow continuity** — Validation is part of the conversation, not a separate screen
9. **Tool status** — Shows "Running: bun run validate-measurement.ts..." during execution
10. **No orphan processes** — Measure.sh processes are killed on timeout
11. **Escape still works** — User can press Escape at any point to go back to home

### Typecheck & Lint

```bash
bun lint && bun typecheck
```

Both must pass.

---

## Potential Issues & Mitigations

### 1. `import.meta.dir` may not resolve correctly

**Risk:** When autoauto is installed globally (`bun link`), `import.meta.dir` might resolve to a symlinked path or an unexpected location.

**Mitigation:** Test with both `bun dev` and `bun link` + global `autoauto` invocation. If the path doesn't resolve, fall back to:
```typescript
const validateScript = new URL("./validate-measurement.ts", import.meta.url).pathname
```
This uses `import.meta.url` (file:// URL) which handles symlinks correctly in Bun.

### 2. measure.sh might pollute stdout

**Risk:** The measurement script prints debug output, progress bars, or warnings to stdout alongside the JSON. The validation script will fail to parse the JSON.

**Mitigation:**
- The validation script reports the specific parse error in the output JSON
- The agent sees the error and can diagnose: "Your measure.sh is printing non-JSON to stdout. Move debug output to stderr."
- The agent can fix measure.sh (redirect with `>&2`, suppress verbose output)

This is actually a **feature** — validating that stdout is clean JSON is part of the measurement contract. Better to catch this during setup than during experiment execution.

### 3. measure.sh might be slow

**Risk:** A slow measurement script (>10 seconds) means 5 validation runs take >50 seconds. The Bash tool might appear hung.

**Mitigation:**
- The validation script prints progress to stderr (`Run 1/5... OK (2340ms)`) — the agent can relay this
- The 60-second per-run timeout prevents infinite hangs
- The system prompt tells the agent: "If measure.sh takes >10 seconds per run, warn the user that validation will take a moment"
- If the script is extremely slow, the agent can suggest reducing validation runs: `bun run validate-measurement.ts ... 3`

### 4. Agent might skip validation

**Risk:** The system prompt says to validate after saving, but the agent might skip it or forget.

**Impact:** Low — the user can still run experiments without validation. Validation is a quality improvement, not a hard gate.

**Mitigation:**
- The system prompt is explicit: "After saving, ALWAYS validate measurement stability before telling the user setup is complete"
- The conversation flow lists validation as step 10 (mandatory, not optional)
- If the agent skips it, the user can ask: "Can you validate the measurement script?"

### 5. Agent might not interpret validation results correctly

**Risk:** The agent receives JSON stats but misinterprets CV% or gives bad advice.

**Mitigation:**
- The system prompt includes a clear interpretation table (CV% → assessment → what to tell the user)
- The validation script includes the `assessment` field and `recommendations` — the agent doesn't need to compute anything, just read the pre-computed assessment
- The recommendations include specific values for noise_threshold and repeats — the agent just relays them

[CHANGED] ### 6. measure.sh cwd might be wrong

**Risk:** The validation script runs measure.sh, but the working directory might not be the target project root.

**Mitigation:** The validation script explicitly derives the project root from the measure.sh path (going up from `.autoauto/programs/<slug>/measure.sh` to the repo root) and passes it as `cwd` to `Bun.spawn()`. This eliminates dependency on cwd inheritance through the Bash tool → bun run chain.

### 7. Validation script itself might have bugs

**Risk:** Since the validation script is new code, it might have edge case bugs (NaN handling, empty arrays, etc.)

**Mitigation:**
- Defensive coding: check array lengths before computing stats, handle NaN/Infinity
- The script always outputs valid JSON (even on internal errors, via top-level `.catch()`)
- The standalone testing approach (section above) allows thorough testing before TUI integration
- Edge cases (all runs fail, single valid run, zero values) are explicitly handled

---

## Doc & Config Updates

### CLAUDE.md

**Update Project Structure** to include `validate-measurement.ts`:

```
src/
  index.tsx              # Entry point, creates renderer
  App.tsx                # Main layout, keyboard handling
  components/
    Chat.tsx             # Multi-turn chat with Claude Agent SDK streaming
  screens/
    HomeScreen.tsx       # Program list
    SetupScreen.tsx      # Setup flow (chat wrapper + agent config)
  lib/
    programs.ts          # Filesystem ops, program CRUD, config types
    push-stream.ts       # Push-based async iterable utility
    system-prompts.ts    # Agent system prompts (setup, ideation)
    tool-events.ts       # Tool event display formatting
    validate-measurement.ts  # Standalone measurement validation script
```

**Add to Agent Conventions** section:

```markdown
- Setup Agent validates measurement stability after saving program files
- Measurement validation uses a standalone script (`src/lib/validate-measurement.ts`) called via Bash
- The validation script runs measure.sh multiple times and computes variance statistics (CV%)
- Config recommendations (noise_threshold, repeats) are based on observed CV%
```

### docs/architecture.md

**Update the Setup Agent section** to mention validation:

Replace:
```
- **Artifacts generated:**
  - `program.md` — Goal, scope, rules, steps for the experiment agent
  - `measure.sh` — Measurement script tailored to the repo (must output JSON to stdout)
  - `config.json` — Metric field, direction, noise threshold, repeats, quality gates
- **Review flow:** Agent presents artifacts as code blocks for review before writing to disk
```

With:
```
- **Artifacts generated:**
  - `program.md` — Goal, scope, rules, steps for the experiment agent
  - `measure.sh` — Measurement script tailored to the repo (must output JSON to stdout)
  - `config.json` — Metric field, direction, noise threshold, repeats, quality gates
- **Review flow:** Agent presents artifacts as code blocks for review before writing to disk
- **Measurement validation:** After saving, the agent runs a standalone validation script
  (`src/lib/validate-measurement.ts`) that executes measure.sh 5 times, computes variance
  statistics (CV%), and recommends noise_threshold + repeats. If measurements are unstable,
  the agent helps fix the script and re-validates.
```

**Update the Current State** to reflect 1d:

Replace:
```
Measurement validation (running the generated script to check variance) is not yet implemented.
```

With:
```
Measurement validation runs the generated script multiple times to check variance and
recommends noise/repeats configuration. Model configuration is not yet implemented.
```

**Add a new Utilities subsection:**

```markdown
### Measurement Validation (`src/lib/validate-measurement.ts`)

Standalone Bun script that validates measurement script stability:

- **Input:** Paths to measure.sh + config.json, number of runs
- **Execution:** Runs measure.sh N times sequentially, parses JSON output, validates fields
- **Stats:** Computes median, mean, min, max, stdev, CV% for primary metric and quality gates
- **Assessment:** excellent (<5% CV), acceptable (5-15%), noisy (15-30%), unstable (≥30%)
- **Output:** Single JSON object to stdout with stats, assessment, and config recommendations
- **Called by:** Setup agent via Bash tool
- **Used for:** Pre-experiment validation during setup (Phase 1) — ensures measurement is stable before entering the optimization loop
```

### README.md

**Update the "How It Works" section** — step 1 should mention validation:

Replace:
```
1. **Setup** — Inspect a repo, define what to optimize, generate a measurement script, set scope constraints
```

With:
```
1. **Setup** — Inspect a repo, define what to optimize, generate a measurement script, validate measurement stability, set scope constraints
```

---

## Summary of Changes

| File | Action | Description |
|---|---|---|
| `src/lib/validate-measurement.ts` | **Create** | Standalone Bun script: runs measure.sh N times, validates output, computes stats, outputs JSON |
| `src/lib/system-prompts.ts` | **Modify** | Add validation flow (steps 10-13), Measurement Validation section (commands, interpretation table, fix guidance), update "What NOT to Do" |
| `src/screens/SetupScreen.tsx` | **Modify** | Increase `SETUP_MAX_TURNS` from 30 to 40 |
| `src/lib/programs.ts` | **Verify** | Ensure `ProgramConfig` and `QualityGate` types exist (may already exist from 1c) |
| `CLAUDE.md` | **Update** | Add validate-measurement.ts to project structure, add validation to agent conventions |
| `docs/architecture.md` | **Update** | Add measurement validation to setup agent docs, add utilities section, update current state |
| `README.md` | **Update** | Mention measurement validation in setup step |

**Files NOT modified:**
- `src/components/Chat.tsx` — no changes needed (Bash tool handles everything)
- `src/lib/tool-events.ts` — no changes needed (Bash formatting works)
- `src/App.tsx` — no changes needed
- `src/screens/HomeScreen.tsx` — no changes needed

## Order of Implementation

1. **Verify prerequisites:** Ensure 1c is fully implemented (program files can be saved via the setup flow). If `ProgramConfig`/`QualityGate` types exist in programs.ts, note their exact shape.
2. **Create `src/lib/validate-measurement.ts`:**
   a. Input parsing (args, config.json)
   b. Measurement execution (Bun.spawn, timeout, stdout/stderr capture)
   c. Output validation (metric_field, quality gate fields)
   d. Stats computation (median, mean, stdev, CV%)
   e. Assessment + recommendations
   f. JSON output formatting
   g. Error handling (crashes, timeouts, invalid JSON, top-level catch)
3. **Test the validation script standalone** with a dummy measure.sh (see Testing section above)
4. **Modify `src/lib/system-prompts.ts`:**
   a. Add `validateScript` path computation via `import.meta.dir`
   b. Extend conversation flow (steps 10-13)
   c. Add Measurement Validation section
   d. Update "What NOT to Do"
5. **Modify `src/screens/SetupScreen.tsx`** — change `SETUP_MAX_TURNS` from 30 to 40
6. **Run `bun lint && bun typecheck`** — fix any issues
7. **Test the full flow via tmux** — create a program, verify validation runs, check agent interpretation
8. **Test error cases** — noisy measurement, crashing script, missing fields
9. **Test iteration flow** — verify the agent can fix measure.sh and re-validate
10. **Update `CLAUDE.md`**, **`docs/architecture.md`**, **`README.md`**
11. **Final `bun lint && bun typecheck`**

---

## Known Limitations (1d MVP)

1. **No hard gate.** Validation is advisory — the agent warns the user but can't prevent them from proceeding with unstable measurements. A hard gate (refuse to complete setup unless CV% < threshold) would require app-level enforcement outside the agent.
2. **Sequential validation only.** Runs execute one at a time. For slow measurement scripts, this can take several minutes. Parallel runs would be faster but risk interference.
[CHANGED] 3. **Warmup is single-run.** The validation script runs one warmup run (excluded from stats) before the N measurement runs. This handles basic cold-start effects (JIT, cache priming) but may not be sufficient for scripts with multi-stage warmup (e.g., dev server + browser launch). For such scripts, the user should add warmup logic inside measure.sh itself.
4. **No persistent validation history.** Validation results aren't saved to disk. If the user re-enters setup, they'd need to re-validate. Phase 2 will re-validate as part of experiment loop startup.
5. **CV% may not apply to all metrics.** For binary metrics (pass/fail), CV% is less meaningful. The assessment thresholds assume continuous numeric metrics. Binary metrics should use pass rate + consecutive-pass behavior instead. This is acceptable for MVP — most initial use cases will have continuous metrics.
6. **Agent interprets results.** Stats computation is deterministic (in the script), but the agent's interpretation and advice are LLM-generated. The system prompt constrains this heavily (interpretation table, explicit thresholds), but the agent could still give suboptimal advice.
7. **No environment noise pre-check.** Bencher's `bencher noise` concept (measure compute/cache/IO jitter before benchmarking) is not implemented. The validation script only measures the script's output variance, not the underlying environment noise. This is a Phase 2+ improvement.

---

## [NEW] Review Notes

This plan was reviewed against Bun runtime documentation, benchmarking best practices (Criterion.rs, JMH, Bencher), and the current codebase state. Key corrections:

- **Changed:** Manual `Promise.race` + `setTimeout` timeout replaced with Bun.spawn's built-in `timeout` option. The manual approach had: (a) lingering setTimeout after normal process exit, (b) potential read-after-kill on stdout/stderr, (c) unnecessary complexity. Bun's native timeout handles process cleanup automatically.
- **Changed:** Added warmup run (excluded from stats). Research from Criterion.rs and JMH confirms cold-start effects (JIT compilation, cache priming, OS scheduling) significantly inflate first-run measurements. With only 5 runs, one cold outlier can shift CV% by several percentage points, potentially misclassifying a stable script as "noisy."
- **Changed:** Added explicit `cwd` to Bun.spawn (derived from measure.sh path). The original plan relied on cwd inheritance through Bash tool → bun run → Bun.spawn, which is fragile if any step in the chain changes directory.
- **Changed:** ProgramConfig/QualityGate types: made explicit that these should be added unconditionally (not "check if 1c added them") since the 1c plan was revised and might not include them.
- **Verified:** CV% thresholds align with industry practice (Criterion.rs uses 2% as noise threshold). Sample variance (n-1 denominator) is correct for 5 runs. `import.meta.dir` is stable in Bun.
