# Phase 2b: Experiment Loop — Implementation Plan

## Overview

Phase 2b implements the core experiment loop: building context packets, spawning fresh Experiment Agent sessions, enforcing commit discipline, and detecting locked-file tampering. This is the inner loop that phase 2a's `startRun()` sets up and phase 2c's measurement/decision logic evaluates.

The loop runs synchronously in the main process (no daemon yet — that's Phase 4). Each iteration: build context packet → spawn agent → wait for completion → hand off to measurement (phase 2c). The agent is stateless between iterations — all memory comes from the context packet.

---

## Files to Create

### 1. `src/lib/experiment.ts` — Experiment Agent orchestration

This is the new core file. It contains the context packet builder, experiment agent spawner, commit validation, and locked-file detection.

#### Types

```typescript
import type { RunState, ExperimentResult } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"

/** Everything the experiment agent needs to know */
interface ContextPacket {
  iteration: number
  baseline_metric: number
  original_baseline: number
  best_metric: number
  best_experiment: number
  total_keeps: number
  total_discards: number
  metric_field: string
  direction: "lower" | "higher"
  program_md: string          // full contents of program.md
  recent_results: string      // last 15 rows of results.tsv (with header)
  recent_git_log: string      // last 15 commits from git log --oneline
  last_outcome: string        // one-line summary of what happened last time
  discarded_diffs: string     // recent discarded commit summaries + stat diffs
}

/** Result of running one experiment agent session */
type ExperimentOutcome =
  | { type: "committed"; sha: string; description: string; files_changed: string[] }
  | { type: "no_commit" }
  | { type: "agent_error"; error: string }

/** Result of checking whether locked files were modified */
interface LockViolation {
  violated: boolean
  files: string[]  // which locked files were touched
}
```

#### Functions

##### `buildContextPacket(projectRoot, programDir, runDir, state, config): Promise<ContextPacket>`

Assembles the context packet from disk. This is called at the start of each iteration.

Implementation:
1. Read `program.md` from `programDir` via `readFile(join(programDir, "program.md"), "utf-8")`
2. Read `results.tsv` from `runDir`, take header + last 15 data rows
3. Call `getRecentLog(projectRoot, 15)` from `git.ts`
4. Build `last_outcome` from the last row of results.tsv:
   - Parse the last TSV row to get status and description
   - Format as: `"kept: improved to {metric} ({description})"` or `"discarded: {metric} ({reason})"` or `"crashed: {description}"` or `"none yet"` for the first iteration
   - Match the format from modulaser's `last_outcome_summary()` — include both the metric value and the human-readable reason
5. Build `discarded_diffs` — get the last 3-5 discarded commits from results.tsv, call `getCommitDiff(projectRoot, sha)` for each
   - Only include diffs for `discard` and `crash` status rows
   - Cap total length to ~2000 chars to avoid context overflow
   - Format: one block per discarded commit: `"[discard] {sha} {description}\n{stat_diff}\n"`
6. Fill in metric values from `state`

**Key design choice:** The context packet is built from files on disk (results.tsv, program.md, git log), not from in-memory state. This ensures crash recovery can reconstruct the same context, and aligns with Phase 4's filesystem-based IPC.

**Why 15 rows/commits:** Matches the modulaser pattern (`recent_results_block 8` plus some buffer). Enough history for the agent to see patterns without context overflow. The agent can always `git log` or `git show` for more detail.

##### `buildExperimentPrompt(packet: ContextPacket): string`

Converts the context packet into the user message string for the agent.

Implementation:
```typescript
return `You are iteration ${packet.iteration} of an autoresearch experiment loop.

## Current State
- Baseline ${packet.metric_field}: ${packet.baseline_metric} (${packet.direction} is better)
- Original baseline: ${packet.original_baseline}
- Best achieved: ${packet.best_metric} (experiment #${packet.best_experiment})
- Total: ${packet.total_keeps} keeps, ${packet.total_discards} discards

## Last Outcome
${packet.last_outcome}

## Recent Results
\`\`\`
${packet.recent_results}
\`\`\`

## Recent Git History
\`\`\`
${packet.recent_git_log}
\`\`\`

## Recently Discarded Experiments
${packet.discarded_diffs || "(none yet)"}

Discarded experiments remain in git history. Inspect them with \`git show <sha>\` if needed.
Implement ONE change, validate, and commit. Then stop.`
```

**Why this is a user message, not a system prompt:** The system prompt contains the stable `program.md` instructions. The user message contains the per-iteration context packet. This matches the modulaser pattern where `--append-system-prompt-file program.md` is the system prompt and `build_iteration_prompt()` is the user-turn prompt. It also means the program.md gets cached by the API across iterations (prompt caching).

[CHANGED] ##### `getExperimentSystemPrompt(programMd: string): string`

Returns the system prompt for the experiment agent. This wraps `program.md` with framing instructions.

**Canonical location: `src/lib/system-prompts.ts`** (per CLAUDE.md: "System prompts live in `src/lib/system-prompts.ts`"). The implementation below goes in system-prompts.ts, and experiment.ts imports it: `import { getExperimentSystemPrompt } from "./system-prompts.ts"`.

Implementation:
```typescript
return `You are an AutoAuto Experiment Agent — one iteration of an autonomous optimization loop. An external orchestrator handles measurement, keep/discard decisions, and loop control. Your job: analyze, implement ONE optimization, validate, and commit.

${programMd}

## Critical Rules
- Make exactly ONE focused change per iteration
- Always commit your change with: git add -A && git commit -m "<type>(scope): description"
- NEVER modify files in .autoauto/ — these are locked by the orchestrator
- NEVER modify measure.sh or config.json — they are read-only (chmod 444)
- If validation fails and you cannot fix it, exit without committing
- Do NOT ask for human input — you are autonomous
- Do NOT run the measurement script — the orchestrator handles that
- Read results.tsv and git history to avoid repeating failed approaches
- Keep changes small and focused — the orchestrator can only evaluate one change at a time`
```

**Why `.autoauto/` is off-limits:** The locked evaluator (measure.sh + config.json) lives in `.autoauto/programs/<slug>/`. Rather than listing specific file paths (which could change), blanket-ban the entire `.autoauto/` directory. The chmod 444 protection is a backup — the system prompt is the first line of defense.

[CHANGED] ##### `runExperimentAgent(projectRoot, systemPrompt, userPrompt, config, modelConfig, onStreamText?, onToolStatus?, signal?): Promise<ExperimentOutcome>`

Spawns a fresh Claude Agent SDK session, sends the context packet, waits for completion. Accepts optional streaming callbacks for TUI display and an AbortSignal for cancellation.

**Canonical signature (one definition — section 6 below just adds streaming details, not a separate function):**
```typescript
export async function runExperimentAgent(
  projectRoot: string,
  systemPrompt: string,
  userPrompt: string,
  config: ProgramConfig,
  modelConfig: ModelSlot,
  onStreamText?: (text: string) => void,
  onToolStatus?: (status: string) => void,
  signal?: AbortSignal,
): Promise<ExperimentOutcome>
```

Implementation:
1. Record `HEAD` SHA before spawning: `const startSha = await getFullSha(projectRoot)`
2. Combine system prompt + user prompt into one `query()` call. The SDK supports `prompt` as a plain string for one-shot usage, but we use `PushStream` so we can pass `includePartialMessages: true` and get streaming events for the TUI.
3. Create a `PushStream<SDKUserMessage>` and an `AbortController` (link to external `signal` if provided)
4. Call `query()` with:
   ```typescript
   const q = query({
     prompt: inputStream,
     options: {
       systemPrompt: systemPrompt,
       tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
       allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
       maxTurns: 30,
       cwd: projectRoot,
       model: modelConfig.model,
       effort: modelConfig.effort,
       permissionMode: "bypassPermissions",
       allowDangerouslySkipPermissions: true,
       persistSession: false,
       includePartialMessages: true,
       abortController,
     },
   })
   ```
5. Immediately push the user message and end the stream (one-shot):
   ```typescript
   inputStream.push({
     type: "user",
     message: { role: "user", content: userPrompt },
     parent_tool_use_id: null,
   })
   inputStream.end()
   ```
6. Iterate through the query stream, collecting events:
   - `stream_event` (type: `SDKPartialAssistantMessage`) — emit for TUI display (phase 2f will consume these)
   - `assistant` (type: `SDKAssistantMessage`) — agent completed a turn
   - `result` (type: `SDKResultMessage`) — session complete
   - Store streaming text for phase 2f to display
7. Compare `HEAD` to `startSha`:
   - If HEAD changed: `{ type: "committed", sha, description, files_changed }`
   - If HEAD unchanged: `{ type: "no_commit" }`
   - If query errored: `{ type: "agent_error", error }`

**Why PushStream instead of string prompt:** The SDK supports `query({ prompt: "string" })` for simple one-shot usage, but the `PushStream` approach gives us `includePartialMessages: true` for streaming token events to the TUI. With a string prompt, streaming events are still emitted but the PushStream pattern matches the existing `Chat.tsx` code and allows us to call `inputStream.end()` immediately to signal no more messages.

**maxTurns: 30** — the experiment agent needs enough turns to read files, make changes, run tests, and commit. 30 is generous but bounded. The modulaser reference uses 200, but that includes interactive back-and-forth which we don't have.

**One-shot pattern:** Push exactly one user message, call `end()`, then iterate until `result`. The agent runs autonomously until it commits and exits (or hits maxTurns). This matches the modulaser `claude -p "$iteration_prompt"` pattern.

[CHANGED] ~~`getFilesChangedInCommit()` was defined here but is redundant with `getFilesChangedBetween()` in git.ts (section 3). Use `getFilesChangedBetween()` from git.ts instead.~~

Import: `import { getFilesChangedBetween } from "./git.ts"`

##### `checkLockViolation(filesChanged: string[], programSlug: string): LockViolation`

Checks if any changed files are in the locked `.autoauto/` directory.

Implementation:
```typescript
const lockedPatterns = [
  `.autoauto/programs/${programSlug}/measure.sh`,
  `.autoauto/programs/${programSlug}/config.json`,
  ".autoauto/",  // entire directory is off-limits
]
const violated = filesChanged.filter(f =>
  f.startsWith(".autoauto/")
)
return {
  violated: violated.length > 0,
  files: violated,
}
```

**Why check file paths instead of just relying on chmod 444:** The chmod protection prevents the agent's Write/Edit tools from modifying the files. But the agent could use Bash to `chmod 644` first, then edit. Checking the git diff catches any modification regardless of how it happened. This is the P0 safeguard from `docs/failure-patterns.md`.

##### `countCommitsBetween(cwd: string, fromSha: string, toSha: string): Promise<number>`

Returns the number of commits between two SHAs. Used to enforce single-commit discipline.

Implementation:
```typescript
const { stdout } = await execFileAsync(
  "git", ["rev-list", "--count", `${fromSha}..${toSha}`], { cwd }
)
return parseInt(stdout.trim(), 10)
```

**Single-commit enforcement:** If the agent made multiple commits, it's not a hard failure — we log a warning but still proceed to measurement. The discard mechanism reverts all commits between startSha and HEAD regardless. However, multiple commits suggest the agent is doing too much per iteration, which we should flag.

---

### 2. `src/lib/experiment-loop.ts` — The main loop orchestrator

This file contains the top-level loop that ties together experiment.ts (agent), measure.ts (measurement), run.ts (state), and git.ts (revert/keep).

#### Types

```typescript
import type { RunState } from "./run.ts"
import type { ProgramConfig } from "./programs.ts"
import type { ModelSlot } from "./config.ts"

/** Callback for the TUI to receive live updates */
interface LoopCallbacks {
  onPhaseChange: (phase: RunState["phase"], detail?: string) => void
  onExperimentStart: (experimentNumber: number) => void
  onExperimentEnd: (result: import("./run.ts").ExperimentResult) => void
  onStateUpdate: (state: RunState) => void
  onAgentStream: (text: string) => void        // streaming agent text
  onAgentToolUse: (status: string) => void      // tool status line
  onError: (error: string) => void
}

/** Options to control the experiment loop */
interface LoopOptions {
  maxExperiments?: number     // stop after N experiments (0 = unlimited)
  signal?: AbortSignal        // for external stop/abort
}
```

#### Functions

##### `runExperimentLoop(projectRoot, programSlug, runDir, config, modelConfig, callbacks, options): Promise<RunState>`

The main loop. Called after `startRun()` has established the baseline.

Implementation (pseudocode showing the full flow):

```typescript
export async function runExperimentLoop(
  projectRoot: string,
  programSlug: string,
  runDir: string,
  config: ProgramConfig,
  modelConfig: ModelSlot,
  callbacks: LoopCallbacks,
  options: LoopOptions = {},
): Promise<RunState> {
  const programDir = getProgramDir(projectRoot, programSlug)
  const measureShPath = join(programDir, "measure.sh")
  let state = await readState(runDir)
  let consecutiveDiscards = 0

  while (true) {
    // --- Check stop conditions ---
    if (options.signal?.aborted) {
      state = { ...state, phase: "stopping", updated_at: new Date().toISOString() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("stopping", "manually stopped")
      break
    }

    // [NEW] Warn on consecutive discards — agent may be stuck in a rut
    if (consecutiveDiscards >= 10) {
      callbacks.onError(`Warning: ${consecutiveDiscards} consecutive discards. Agent may be stuck — consider stopping and reviewing results.`)
    }

    if (options.maxExperiments && state.experiment_number >= options.maxExperiments) {
      state = { ...state, phase: "complete", updated_at: new Date().toISOString() }
      await writeState(runDir, state)
      callbacks.onPhaseChange("complete", `reached max experiments (${options.maxExperiments})`)
      break
    }

    // --- Start new experiment ---
    const experimentNumber = state.experiment_number + 1
    callbacks.onExperimentStart(experimentNumber)

    // Update state: agent_running
    state = {
      ...state,
      phase: "agent_running",
      experiment_number: experimentNumber,
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, state)
    callbacks.onPhaseChange("agent_running")
    callbacks.onStateUpdate(state)

    // --- Build context packet ---
    const packet = await buildContextPacket(
      projectRoot, programDir, runDir, state, config,
    )
    const systemPrompt = getExperimentSystemPrompt(packet.program_md)
    const userPrompt = buildExperimentPrompt(packet)

    // --- Spawn experiment agent ---
    const startSha = await getFullSha(projectRoot)

    const outcome = await runExperimentAgent(
      projectRoot,
      systemPrompt,
      userPrompt,
      config,
      modelConfig,
      // Pass stream callbacks for TUI display:
      (text) => callbacks.onAgentStream(text),
      (status) => callbacks.onAgentToolUse(status),
      options.signal,
    )

    // --- Handle no-commit or error ---
    if (outcome.type === "no_commit") {
      const result: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: await getShortSha(projectRoot),  // [CHANGED] was getCurrentSha — that function doesn't exist in git.ts
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: "no commit produced",
      }
      await appendResult(runDir, result)
      callbacks.onExperimentEnd(result)

      state = {
        ...state,
        total_crashes: state.total_crashes + 1,
        phase: "idle",
        updated_at: new Date().toISOString(),
      }
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    if (outcome.type === "agent_error") {
      const result: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: await getShortSha(projectRoot),  // [CHANGED] was getCurrentSha
        metric_value: 0,
        secondary_values: "",
        status: "crash",
        description: `agent error: ${outcome.error}`,
      }
      await appendResult(runDir, result)
      callbacks.onExperimentEnd(result)

      state = {
        ...state,
        total_crashes: state.total_crashes + 1,
        phase: "idle",
        updated_at: new Date().toISOString(),
      }
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    // --- Agent committed. Record candidate SHA. ---
    const candidateSha = await getFullSha(projectRoot)
    state = {
      ...state,
      candidate_sha: candidateSha,
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, state)

    // --- Check lock violation ---
    const lockCheck = checkLockViolation(outcome.files_changed, programSlug)
    if (lockCheck.violated) {
      // Immediate discard — agent tried to modify locked files
      callbacks.onPhaseChange("reverting", `lock violation: ${lockCheck.files.join(", ")}`)

      state = { ...state, phase: "reverting", updated_at: new Date().toISOString() }
      await writeState(runDir, state)

      const reverted = await revertCommits(projectRoot, startSha, candidateSha)
      if (!reverted) {
        await resetHard(projectRoot, startSha)
      }

      const result: ExperimentResult = {
        experiment_number: experimentNumber,
        commit: candidateSha.slice(0, 7),
        metric_value: 0,
        secondary_values: "",
        status: "discard",
        description: `lock violation: modified ${lockCheck.files.join(", ")} — ${outcome.description}`,
      }
      await appendResult(runDir, result)
      callbacks.onExperimentEnd(result)

      state = {
        ...state,
        total_discards: state.total_discards + 1,
        candidate_sha: null,
        phase: "idle",
        updated_at: new Date().toISOString(),
      }
      await writeState(runDir, state)
      callbacks.onStateUpdate(state)
      consecutiveDiscards++
      continue
    }

    // --- Check commit count (warn if multiple) ---
    const commitCount = await countCommitsBetween(projectRoot, startSha, candidateSha)
    if (commitCount > 1) {
      callbacks.onError(`Warning: agent made ${commitCount} commits (expected 1). Proceeding with measurement.`)
    }

    // --- Hand off to measurement (phase 2c) ---
    // Phase 2c will:
    // 1. Run measurement series
    // 2. Compare against baseline
    // 3. Check quality gates
    // 4. Keep or discard (revert)
    // 5. Update state + results.tsv
    // 6. Re-baseline if needed
    //
    // For now, this is a stub that calls into measure.ts and run.ts:
    const measurementResult = await runMeasurementAndDecide(
      projectRoot, programDir, runDir, measureShPath,
      config, state, startSha, candidateSha, outcome.description,
      callbacks,
    )

    state = measurementResult.state
    if (measurementResult.kept) {
      consecutiveDiscards = 0
    } else {
      consecutiveDiscards++
    }

    callbacks.onStateUpdate(state)
  }

  // --- Finalize ---
  await unlockEvaluator(programDir)

  const finalState = {
    ...state,
    phase: state.phase === "stopping" ? "complete" as const : state.phase,
    updated_at: new Date().toISOString(),
  }
  await writeState(runDir, finalState)
  callbacks.onStateUpdate(finalState)

  return finalState
}
```

##### `runMeasurementAndDecide(...)` — Stub for phase 2c

This function will be fully implemented in phase 2c. For phase 2b, create a stub that:
1. Updates state to `phase: "measuring"`
2. Calls `runMeasurementSeries()`
3. Calls `compareMetric()` and `checkQualityGates()`
4. Keeps or reverts
5. Updates state + results.tsv
6. Re-baselines when needed

**Why include the stub in phase 2b:** The loop needs to call _something_ after the agent commits. Implementing the full measurement+decision here (not just a placeholder) means phase 2b is actually testable end-to-end. Phase 2c can then refine the logic (re-baseline strategies, edge cases), but the basic flow works.

The stub implementation:

```typescript
async function runMeasurementAndDecide(
  projectRoot: string,
  programDir: string,
  runDir: string,
  measureShPath: string,
  config: ProgramConfig,
  state: RunState,
  startSha: string,
  candidateSha: string,
  description: string,
  callbacks: LoopCallbacks,
): Promise<{ state: RunState; kept: boolean }> {
  // 1. Measure
  callbacks.onPhaseChange("measuring")
  let newState = { ...state, phase: "measuring" as const, updated_at: new Date().toISOString() }
  await writeState(runDir, newState)

  const series = await runMeasurementSeries(measureShPath, projectRoot, config)

  // 2. Handle measurement failure
  if (!series.success) {
    callbacks.onPhaseChange("reverting", "measurement failed")
    newState = { ...newState, phase: "reverting" as const, updated_at: new Date().toISOString() }
    await writeState(runDir, newState)

    const reverted = await revertCommits(projectRoot, startSha, candidateSha)
    if (!reverted) await resetHard(projectRoot, startSha)

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: 0,
      secondary_values: "",
      status: "measurement_failure",
      description: `measurement failed: ${description}`,
    }
    await appendResult(runDir, result)
    callbacks.onExperimentEnd(result)

    newState = {
      ...newState,
      total_crashes: newState.total_crashes + 1,
      candidate_sha: null,
      phase: "idle" as const,
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, newState)
    return { state: newState, kept: false }
  }

  // 3. Check quality gates
  if (!series.quality_gates_passed) {
    callbacks.onPhaseChange("reverting", `quality gate: ${series.gate_violations.join(", ")}`)
    newState = { ...newState, phase: "reverting" as const, updated_at: new Date().toISOString() }
    await writeState(runDir, newState)

    const reverted = await revertCommits(projectRoot, startSha, candidateSha)
    if (!reverted) await resetHard(projectRoot, startSha)

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: series.median_metric,
      secondary_values: JSON.stringify(series.median_quality_gates),
      status: "discard",
      description: `quality gate failed: ${description}`,
    }
    await appendResult(runDir, result)
    callbacks.onExperimentEnd(result)

    newState = {
      ...newState,
      total_discards: newState.total_discards + 1,
      candidate_sha: null,
      phase: "idle" as const,
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, newState)
    return { state: newState, kept: false }
  }

  // 4. Compare against baseline
  const verdict = compareMetric(
    state.current_baseline,
    series.median_metric,
    config.noise_threshold,
    config.direction,
  )

  if (verdict === "improved") {
    // KEEP
    callbacks.onPhaseChange("kept", `improved: ${state.current_baseline} → ${series.median_metric}`)

    const isBest = config.direction === "lower"
      ? series.median_metric < state.best_metric
      : series.median_metric > state.best_metric

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: series.median_metric,
      secondary_values: JSON.stringify(series.median_quality_gates),
      status: "keep",
      description,
    }
    await appendResult(runDir, result)
    callbacks.onExperimentEnd(result)

    // Re-baseline after keep (code changed — old baseline is no longer valid)
    callbacks.onPhaseChange("measuring", "re-baselining after keep")
    const rebaseline = await runMeasurementSeries(measureShPath, projectRoot, config)
    const newBaseline = rebaseline.success ? rebaseline.median_metric : series.median_metric

    newState = {
      ...newState,
      total_keeps: newState.total_keeps + 1,
      current_baseline: newBaseline,
      best_metric: isBest ? series.median_metric : newState.best_metric,
      best_experiment: isBest ? state.experiment_number : newState.best_experiment,
      last_known_good_sha: candidateSha,
      candidate_sha: null,
      phase: "idle" as const,
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, newState)
    return { state: newState, kept: true }
  } else {
    // DISCARD (regressed or noise)
    const reason = verdict === "regressed" ? "regressed" : "within noise"
    callbacks.onPhaseChange("reverting", `${reason}: ${state.current_baseline} → ${series.median_metric}`)

    newState = { ...newState, phase: "reverting" as const, updated_at: new Date().toISOString() }
    await writeState(runDir, newState)

    const reverted = await revertCommits(projectRoot, startSha, candidateSha)
    if (!reverted) await resetHard(projectRoot, startSha)

    const statusDesc = verdict === "regressed" ? description : `noise: ${description}`

    const result: ExperimentResult = {
      experiment_number: state.experiment_number,
      commit: candidateSha.slice(0, 7),
      metric_value: series.median_metric,
      secondary_values: JSON.stringify(series.median_quality_gates),
      status: "discard",
      description: statusDesc,
    }
    await appendResult(runDir, result)
    callbacks.onExperimentEnd(result)

    newState = {
      ...newState,
      total_discards: newState.total_discards + 1,
      candidate_sha: null,
      phase: "idle" as const,
      updated_at: new Date().toISOString(),
    }
    await writeState(runDir, newState)
    return { state: newState, kept: false }
  }
}
```

**Note:** The `runMeasurementAndDecide` is fully implemented here because phases 2b and 2c are tightly coupled — the loop can't function without the measurement+decision step. Phase 2c's task list items (re-baseline after consecutive discards, edge cases) can be added as refinements to this function.

---

## Files to Modify

### 3. `src/lib/git.ts` — Add helper functions

Add these functions (used by experiment.ts):

##### `getFilesChangedBetween(cwd: string, fromSha: string, toSha: string): Promise<string[]>`

```typescript
export async function getFilesChangedBetween(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git", ["diff", "--name-only", fromSha, toSha], { cwd },
  )
  return stdout.trim().split("\n").filter(Boolean)
}
```

##### `countCommitsBetween(cwd: string, fromSha: string, toSha: string): Promise<number>`

```typescript
export async function countCommitsBetween(
  cwd: string,
  fromSha: string,
  toSha: string,
): Promise<number> {
  const { stdout } = await execFileAsync(
    "git", ["rev-list", "--count", `${fromSha}..${toSha}`], { cwd },
  )
  return parseInt(stdout.trim(), 10)
}
```

##### `getDiscardedDiffs(cwd: string, shas: string[], maxLength?: number): Promise<string>`

Returns formatted diff summaries for discarded commits.

```typescript
export async function getDiscardedDiffs(
  cwd: string,
  shas: string[],
  maxLength = 2000,
): Promise<string> {
  const parts: string[] = []
  let totalLength = 0

  for (const sha of shas) {
    if (totalLength >= maxLength) break
    const diff = await getCommitDiff(cwd, sha)
    const entry = `[${sha.slice(0, 7)}]\n${diff}\n`
    parts.push(entry)
    totalLength += entry.length
  }

  return parts.join("\n")
}
```

### 4. `src/lib/run.ts` — Add results.tsv reader

##### `readRecentResults(runDir: string, count?: number): Promise<string>`

Reads the results.tsv file and returns the header + last N rows as a string. Used by context packet builder.

```typescript
export async function readRecentResults(
  runDir: string,
  count = 15,
): Promise<string> {
  const raw = await readFile(join(runDir, "results.tsv"), "utf-8")
  const lines = raw.split("\n").filter(Boolean)
  if (lines.length <= 1) return lines.join("\n")

  const header = lines[0]
  const rows = lines.slice(1)
  const recent = rows.slice(-count)
  return [header, ...recent].join("\n")
}
```

##### `parseLastResult(runDir: string): Promise<ExperimentResult | null>`

Parses the last row of results.tsv into a typed object. Used for building last_outcome.

```typescript
export async function parseLastResult(
  runDir: string,
): Promise<ExperimentResult | null> {
  const raw = await readFile(join(runDir, "results.tsv"), "utf-8")
  const lines = raw.trim().split("\n")
  if (lines.length <= 1) return null // only header

  const lastLine = lines[lines.length - 1]
  const parts = lastLine.split("\t")
  if (parts.length < 6) return null

  return {
    experiment_number: parseInt(parts[0], 10),
    commit: parts[1],
    metric_value: parseFloat(parts[2]),
    secondary_values: parts[3],
    status: parts[4] as ExperimentStatus,
    description: parts[5],
  }
}
```

##### `getDiscardedCommitShas(runDir: string, count?: number): Promise<string[]>`

Returns SHAs of recent discarded/crashed experiments for the context packet.

```typescript
export async function getDiscardedCommitShas(
  runDir: string,
  count = 5,
): Promise<string[]> {
  const raw = await readFile(join(runDir, "results.tsv"), "utf-8")
  const lines = raw.trim().split("\n")
  const shas: string[] = []

  for (let i = lines.length - 1; i >= 1 && shas.length < count; i--) {
    const parts = lines[i].split("\t")
    if (parts.length >= 5) {
      const status = parts[4]
      if (status === "discard" || status === "crash" || status === "measurement_failure") {
        shas.push(parts[1]) // commit SHA
      }
    }
  }

  return shas
}
```

[CHANGED] ### 5. `src/lib/system-prompts.ts` — Add experiment agent prompt

Add `getExperimentSystemPrompt(programMd: string): string`. **This is the canonical location** — the full implementation is specified above in the experiment.ts section (under `getExperimentSystemPrompt`). Copy that implementation here and export it. Do NOT define it in experiment.ts — experiment.ts imports it:

```typescript
import { getExperimentSystemPrompt } from "./system-prompts.ts"
```

[CHANGED] ### 6. `src/lib/experiment.ts` — Streaming implementation details

The `runExperimentAgent` function signature is defined above (section 1 — canonical definition includes streaming callbacks and AbortSignal). This section specifies the streaming implementation inside the `for await` loop:
```typescript
for await (const message of q) {
  if (signal?.aborted) {
    q.close()
    break
  }

  if (message.type === "stream_event") {
    const event = message.event
    if (
      event.type === "content_block_delta" &&
      "delta" in event &&
      event.delta.type === "text_delta" &&
      "text" in event.delta
    ) {
      onStreamText?.((event.delta as { text: string }).text)
    }

    if (
      event.type === "content_block_start" &&
      "content_block" in event &&
      (event.content_block as any).type === "tool_use"
    ) {
      const block = event.content_block as any
      onToolStatus?.(formatToolEvent(block.name ?? "", block.input ?? {}))
    }
  } else if (message.type === "result") {
    const resultMsg = message as any
    if (resultMsg.subtype !== "success") {
      return {
        type: "agent_error",
        error: resultMsg.errors?.join(", ") ?? resultMsg.subtype ?? "unknown",
      }
    }
    break
  }
}
```

This reuses the same streaming pattern from `Chat.tsx` but without React state — just callbacks.

---

## Integration: How it fits with the rest of the codebase

### Call chain

```
App.tsx (user clicks "Start Run")
  → startRun() from run.ts          (creates branch, baseline, locks evaluator)
  → runExperimentLoop() from experiment-loop.ts
      → buildContextPacket()         (reads files, builds packet)
      → getExperimentSystemPrompt()  (wraps program.md)
      → buildExperimentPrompt()      (formats context packet as user message)
      → runExperimentAgent()         (spawns SDK session, waits for result)
      → checkLockViolation()         (checks git diff for locked file changes)
      → runMeasurementAndDecide()    (measure + compare + keep/discard)
      → writeState() / appendResult() (persist to disk)
      → loop
  → unlockEvaluator()               (restore write permissions)
```

### Imports graph

```
experiment-loop.ts
  ├── experiment.ts     (agent spawning, context packets)
  ├── run.ts            (state, results, evaluator locking)
  ├── measure.ts        (runMeasurementSeries, compareMetric)
  ├── git.ts            (SHA, revert, log, diff)
  ├── programs.ts       (types, paths)
  ├── config.ts         (ModelSlot)
  └── tool-events.ts    (formatToolEvent for streaming)
```

### Event flow to TUI (phase 2f will consume)

```
LoopCallbacks:
  onPhaseChange("agent_running")     → TUI updates status bar
  onAgentStream("thinking about...")  → TUI streams to output panel
  onAgentToolUse("Reading file.ts")  → TUI shows tool status
  onPhaseChange("measuring")         → TUI updates status bar
  onExperimentEnd({ status: "keep" }) → TUI updates results table
  onStateUpdate(state)               → TUI updates stats display
```

---

## Dependencies and Stubs

### No new npm dependencies

Everything uses the Claude Agent SDK (`query()`) and existing utilities. The SDK is already installed.

### Stubs needed from other phases

None — phase 2b is self-contained. The measurement logic from phase 2c is included inline (see `runMeasurementAndDecide`), and the TUI integration (phase 2f) consumes the callback interface without needing implementation yet.

### What phase 2b provides to other phases

- **Phase 2c** can refine `runMeasurementAndDecide()` — add re-baseline after consecutive discards, smarter drift detection
- **Phase 2d** — `appendResult()` and `writeState()` are already called at every decision point
- **Phase 2e** — `options.signal` (AbortSignal) provides the stop mechanism; the loop checks it every iteration
- **Phase 2f** — `LoopCallbacks` interface provides all the data the TUI needs

---

## Implementation Order

Execute these steps in order. Each step should pass `bun lint && bun typecheck` before proceeding.

### Step 1: Add git helpers to `src/lib/git.ts`

1. Add `getFilesChangedBetween()` — returns files changed between two SHAs
2. Add `countCommitsBetween()` — returns commit count between two SHAs
3. Add `getDiscardedDiffs()` — returns formatted diff summaries for discarded commits
4. Run `bun lint && bun typecheck`

### Step 2: Add results.tsv reader to `src/lib/run.ts`

1. Add `readRecentResults()` — reads header + last N rows
2. Add `parseLastResult()` — parses last TSV row into typed object
3. Add `getDiscardedCommitShas()` — returns SHAs of recent discarded experiments
4. Run `bun lint && bun typecheck`

### Step 3: Add experiment system prompt to `src/lib/system-prompts.ts`

1. Add `getExperimentSystemPrompt(programMd: string): string` — wraps program.md with experiment agent framing
2. Export it alongside existing `getSetupSystemPrompt`
3. Run `bun lint && bun typecheck`

### Step 4: Create `src/lib/experiment.ts`

1. Define types: `ContextPacket`, `ExperimentOutcome`, `LockViolation`
2. Implement `buildContextPacket()` — assembles context from disk
3. Implement `buildExperimentPrompt()` — formats context as user message string
4. Implement `checkLockViolation()` — checks git diff against locked paths
5. Implement `runExperimentAgent()` — spawns SDK session with streaming callbacks
   - Use the same `query()` + `PushStream` pattern from `Chat.tsx`
   - But one-shot: push one message, iterate to `result`, close
   - Wire up `onStreamText` and `onToolStatus` callbacks
   - Compare HEAD before/after to detect commits
   - Return `ExperimentOutcome`
6. Run `bun lint && bun typecheck`

### Step 5: Create `src/lib/experiment-loop.ts`

1. Define types: `LoopCallbacks`, `LoopOptions`
2. Implement `runMeasurementAndDecide()` — the measurement + keep/discard logic
3. Implement `runExperimentLoop()` — the main loop
4. Wire up all the pieces: context → agent → lock check → measure → decide → state
5. Run `bun lint && bun typecheck`

### Step 6: Final verification

1. Run `bun lint && bun typecheck`
2. Review all new files have correct imports (no circular dependencies)
3. Verify the callback interface is sufficient for the TUI dashboard (phase 2f)
4. Verify the AbortSignal mechanism will work for phase 2e (run termination)

---

## Key Design Decisions

### Why two files (experiment.ts + experiment-loop.ts)?

Separation of concerns:
- `experiment.ts` — **agent interaction**: context packets, SDK spawning, lock detection
- `experiment-loop.ts` — **orchestration**: the loop, measurement, keep/discard decisions

This makes each file testable independently and keeps the loop logic readable. The experiment agent spawner doesn't need to know about the loop, and the loop doesn't need to know about SDK streaming details.

### Why one-shot agent sessions (not interactive)?

From IDEA.md: "One experiment per agent call is a deliberate choice — prevents context overflow, enables clean error recovery, and maintains state separation." Each iteration spawns a fresh `query()` session with one user message. The agent runs autonomously until completion. No interactive back-and-forth.

This matches:
- Karpathy's `program.md`: "LOOP FOREVER: [...] tune, commit, run, check, keep/discard"
- Modulaser's `run_agent_session()`: `claude -p "$iteration_prompt"` (single prompt, wait for exit)
- Cerebras finding: "Different agents converge on the same answers when the search landscape has real structure"

### Why include measurement logic in phase 2b?

Phase 2c's task list is about measurement _refinements_ (re-baseline strategies, consecutive discard handling). But the basic measure → compare → keep/discard flow is essential for the loop to function at all. Including it here means phase 2b produces a working end-to-end loop.

### Why callbacks instead of events/observables?

Simple function callbacks are the lightest-weight interface:
- No new abstractions or event emitter patterns
- Easy to wire to React state in phase 2f: `onStateUpdate: (s) => setState(s)`
- Easy to test: pass mock callbacks
- Forward-compatible: phase 4 (daemon) can replace callbacks with filesystem writes (events.ndjson)

### Why AbortSignal for stop?

AbortSignal is the standard web/Node.js pattern for cooperative cancellation:
- `options.signal` is checked at the top of each loop iteration
- The same signal can be passed to `runExperimentAgent()` → `abortController` → SDK
- Phase 2e will create the AbortController and expose stop/abort methods
- Matches the IDEA.md spec: "Manual stop kills the current experiment immediately"

### Why program.md is the system prompt (not user message)?

From the Anthropic API perspective, system prompts get prompt-cached across turns. Since `program.md` is identical across all iterations, it should be in the system prompt to benefit from caching. The per-iteration context packet (baseline, results, git log) goes in the user message because it changes every time.

This matches the modulaser pattern:
- `--append-system-prompt-file "$PROGRAM_FILE"` — system prompt
- `build_iteration_prompt()` — user message

### Why 30 maxTurns for experiment agent?

The experiment agent needs enough turns to:
1. Read program instructions (1 turn)
2. Read results.tsv and git history (1-2 turns)
3. Read source files in scope (2-4 turns)
4. Plan the change (thinking, no tool use)
5. Edit files (1-3 turns)
6. Run tests/validation (1-2 turns)
7. Commit (1 turn)

Total: ~10-15 turns typical. 30 provides headroom for complex changes without allowing runaway sessions. The modulaser reference uses 200 but includes interactive mode.

### Why `"crash"` status for no-commit?

If the agent finishes without committing, it means it couldn't find a viable change or failed validation. This is functionally a crash (the iteration produced nothing useful) and should be logged as such so subsequent agents see it in the context packet and avoid the same approach.

---

## Updates to CLAUDE.md

Add these bullets to the **Agent Conventions** section:

```markdown
- Experiment Agent is one-shot: single user message → autonomous run → commit or exit
- Experiment Agent system prompt = program.md wrapped with framing instructions (`getExperimentSystemPrompt()`)
- Context packet = per-iteration user message with baseline, recent results, git log, discarded diffs
- Experiment Agent tools: Read, Write, Edit, Bash, Glob, Grep — same as setup, auto-approved
- Lock violation detection: after agent commits, check `git diff` for any `.autoauto/` modifications → immediate discard
- Loop callbacks (`LoopCallbacks`) are the interface between orchestrator and TUI — no events/observables needed
- AbortSignal (`options.signal`) provides cooperative cancellation for stop/abort
```

Add to **Project Structure**:

```
src/
  lib/
    experiment.ts          # Experiment agent spawning, context packets, lock detection
    experiment-loop.ts     # Main experiment loop orchestrator
```

---

## Updates to `docs/architecture.md`

Add a new section after "Measurement":

### Experiment Loop (`src/lib/experiment-loop.ts`)

The core orchestrator loop that drives the autoresearch pattern:

- `runExperimentLoop()` — main loop: context → agent → measure → decide → repeat
- `LoopCallbacks` — callback interface for TUI integration (phase change, streaming, results)
- `LoopOptions` — control knobs: max experiments, abort signal
- Calls `runMeasurementAndDecide()` for each iteration (includes measurement + keep/discard)
- Re-baselines after every keep (code changed, old baseline invalid)
- Checks stop conditions at the top of each iteration (signal, max experiments)
- Unlocks evaluator on completion

### Experiment Agent (`src/lib/experiment.ts`)

Manages per-iteration experiment agent sessions:

- `buildContextPacket()` — assembles baseline, results, git log, discarded diffs from disk
- `buildExperimentPrompt()` — formats context packet as user message
- `getExperimentSystemPrompt()` — wraps program.md with experiment agent framing
- `runExperimentAgent()` — one-shot SDK session with streaming callbacks
- `checkLockViolation()` — detects modifications to `.autoauto/` files via git diff
- Agent is stateless between iterations — all memory comes from the context packet

### Agent Architecture (updated)

| Role | System Prompt | User Message | Session | File |
|------|---------------|--------------|---------|------|
| Setup Agent | `getSetupSystemPrompt()` | Interactive multi-turn | Long-lived | `system-prompts.ts` |
| Experiment Agent | `getExperimentSystemPrompt()` | Context packet (one-shot) | Per-iteration | `experiment.ts` |

---

## Updates to README.md

Add to the "How It Works" section:

```markdown
2. **Execute** — Run an autonomous loop: spawn a fresh agent each iteration with a context packet (baseline metric, recent results, git history), make one change, measure, keep or discard, repeat. The agent is stateless between iterations — AutoAuto maintains all state in `results.tsv` and `state.json`.
```

---

## What This Phase Does NOT Include

- **Re-baseline after consecutive discards** → Phase 2c refinement (basic re-baseline after keeps is included)
- **Sophisticated drift detection** → Phase 2c
- **TUI screens** (execution dashboard, streaming panel) → Phase 2f
- **Run termination UI** (stop button, abort handling) → Phase 2e
- **Results display** → Phase 2f
- **Worktree isolation** → Phase 4 (daemon)
- **Daemon / IPC** → Phase 4
- **Events.ndjson streaming** → Phase 4

---

## Risks and Mitigations

### Risk: Agent modifies locked files via Bash chmod

**Mitigation:** The `checkLockViolation()` function checks git diff _after_ the agent finishes. Any modification to `.autoauto/` files results in immediate discard + revert. The chmod 444 is the first defense; the git diff check is the second.

### Risk: Agent makes multiple commits

**Mitigation:** Not a hard failure. The revert mechanism (`revertCommits`) handles multiple commits between `startSha` and `HEAD`. We log a warning for the TUI but proceed with measurement. The context packet's `last_outcome` will note "N commits" so subsequent agents see the pattern.

### Risk: Agent hangs indefinitely

**Mitigation:** `maxTurns: 30` limits the conversation length. The SDK's `abortController` provides hard cancellation. Phase 2e will add a timeout mechanism on top.

### Risk: Context packet too large

**Mitigation:** Capped at 15 results rows, 15 git log entries, and ~2000 chars of discarded diffs. The program.md is in the system prompt (cached). Total context packet is well under 10k tokens.

### Risk: Re-baseline measurement fails after keep

**Mitigation:** If the re-baseline `runMeasurementSeries()` fails, we fall back to the experiment's measurement as the new baseline. The state is always consistent — we never lose track of the current metric value.

---

## [NEW] Review Notes

This plan was reviewed against the Claude Agent SDK, current codebase state, and git behavior. Key corrections:

- **Fixed (YELLOW):** `getCurrentSha()` doesn't exist in git.ts — the codebase has `getShortSha()`. Updated all references.
- **Fixed (YELLOW):** Removed duplicate `getFilesChangedInCommit()` from experiment.ts — `getFilesChangedBetween()` in git.ts does the same thing. Import from git.ts.
- **Fixed (YELLOW):** Consolidated `runExperimentAgent` into one canonical signature with streaming callbacks + AbortSignal. Section 6 now references the definition in section 1 instead of redefining it.
- **Fixed (YELLOW):** Clarified `getExperimentSystemPrompt` canonical location is `system-prompts.ts` (per CLAUDE.md convention), not experiment.ts. Added explicit import directive.
- **Fixed (YELLOW):** Added consecutive discard warning at 10+ discards. The loop was tracking the counter but never acting on it — the agent could spin indefinitely making the same mistakes.
- **Verified:** One-shot PushStream pattern (push → end → iterate to result) works correctly with the SDK. AbortSignal integration works. All phase 2a infrastructure (run.ts, measure.ts, git.ts) is in place with correct exports.
- **Noted (GREEN):** Re-baseline after every keep doubles measurement time but is defensible for correctness. Agent self-revert edge case wastes one cycle but is handled gracefully (noise → discard).
