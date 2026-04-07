# Phase 2f: TUI Dashboard — Implementation Plan

## Overview

Phase 2f transforms the current minimal ExecutionScreen into the full TUI dashboard described in IDEA.md. The current ExecutionScreen (from Phase 2e) displays basic text stats and handles abort/completion flow. Phase 2f replaces the running-state display with a multi-panel dashboard layout: stats header, metric sparkline, results table, and live agent output panel.

### What's Already Done (from Phases 2a–2e)

| Concern | Status | Where |
|---------|--------|-------|
| ExecutionScreen shell (start → loop → complete) | ✅ Done | `ExecutionScreen.tsx` |
| Abort handling (q / Ctrl+C) | ✅ Done | `ExecutionScreen.tsx:useKeyboard()` line 115 |
| RunCompletePrompt (post-run UI) | ✅ Done | `RunCompletePrompt.tsx` |
| LoopCallbacks interface (all events) | ✅ Done | `experiment-loop.ts:LoopCallbacks` |
| `onAgentStream` callback (text chunks) | ✅ Done | `experiment-loop.ts` line 329 — wired but ignored in ExecutionScreen |
| `onAgentToolUse` callback (tool status) | ✅ Done | `experiment-loop.ts` line 326 — wired, displayed as phase label |
| `onExperimentEnd` callback (result rows) | ✅ Done | `experiment-loop.ts` line 313 — wired but ignored in ExecutionScreen |
| `onRebaseline` callback | ✅ Done | `experiment-loop.ts` line 321 |
| `readAllResults()` / `getMetricHistory()` | ✅ Done | `run.ts` lines 173, 187 |
| `getRunStats()` / `RunStats` | ✅ Done | `run.ts` lines 194–225 |
| `ExperimentCost` type + cost tracking | ✅ Done | `experiment.ts:ExperimentCost`, `events.ts:logExperimentCost` |
| `formatToolEvent()` | ✅ Done | `tool-events.ts` |
| Bottom status bar with keyboard hints | ✅ Done | `App.tsx` line 138 |

### What's Missing

1. **Dashboard layout** — The running-state display is a single column of text lines. IDEA.md specifies a multi-panel dashboard with distinct regions: stats, chart, results table, and agent output.

2. **Stats header panel** — Current display shows raw values inline. Need a structured header with: experiment #, keeps/discards/crashes, baseline, best metric + improvement %, cost so far.

3. **Metric sparkline** — IDEA.md says "Sparkline or bar chart of metric over time." No visualization exists. Need a text-based sparkline showing keep-only metric values.

4. **Results table** — IDEA.md says "Live results table." Currently no table — results exist in memory via `onExperimentEnd` but aren't collected or displayed.

5. **Agent output panel** — IDEA.md says "Streaming agent thinking text in a styled panel (view-only)." Currently `onAgentStream` is wired but the callback is `() => {}`. Need a scrollable panel showing live streaming text.

6. **Cost accumulation** — `ExperimentCost` is logged to events.ndjson per experiment, but not accumulated in-memory for the dashboard. The TUI has no cost display.

---

## Design Decisions

### Dashboard layout is top-to-bottom, not side-by-side

Terminal widths vary (80–200+ columns), but height is usually the limiting factor. Use a vertical stack:

```
┌─ Stats ──────────────────────────────────────────┐
│ Experiment #5  │  3 kept  1 discarded  0 crashed │
│ Baseline: 1230  Best: 980 (-20.3%)  Cost: $0.42  │
│ ▁▃▅▇█▆▅▃▁ metric over time                      │
└──────────────────────────────────────────────────┘
┌─ Results ────────────────────────────────────────┐
│ #  commit  metric  status   description          │
│ 5  a1b2c3  1050    keep     optimize image load  │
│ 4  d4e5f6  1280    discard  lazy load hero       │
│ ...                                              │
└──────────────────────────────────────────────────┘
┌─ Agent ──────────────────────────────────────────┐
│ I'll analyze the current codebase to find...     │
│ ⟳ Reading src/app/page.tsx                       │
│ The hero component loads three large images...   │
└──────────────────────────────────────────────────┘
```

The stats header is fixed-height (5–6 lines). Results table and agent panel split the remaining vertical space. Results gets `flexGrow={1}` (shows all history, scrollable), agent panel gets a fixed height or equal split.

### Sparkline uses Unicode block characters

Use the standard Unicode sparkline characters (`▁▂▃▄▅▆▇█`) mapped to metric values from `getMetricHistory()`. This is a single `<text>` line inside the stats header — no charting library needed. The sparkline shows keep-only metrics (the progression of improvements), not every experiment.

### Results table is a simple TSV-style display

Each result row is one `<text>` line with columns separated by spaces/padding. Color-coded by status: green for keep, red for discard/crash, yellow for measurement_failure. The table auto-scrolls to show the most recent experiments. Use a `<scrollbox>` with `stickyScroll` + `stickyStart="bottom"`.

### Agent output panel shows streaming text + tool status

The agent output panel is a `<scrollbox>` that accumulates streaming text from `onAgentStream`. Tool use events from `onAgentToolUse` are shown inline as dim status lines (like the existing Chat component pattern: `⟳ Reading src/app/page.tsx`). The panel resets on each new experiment.

### Cost is accumulated in-memory, not read from events.ndjson

Reading events.ndjson on every render would be wasteful. Instead, add a `totalCost` state variable to ExecutionScreen that accumulates from `ExperimentCost` data passed via a new `onExperimentCost` callback. This is lightweight and matches the existing in-memory callback pattern.

### Dashboard components are extracted into `src/components/`

Three new components:
- `StatsHeader` — fixed-height panel with stats + sparkline
- `ResultsTable` — scrollable table of experiment outcomes
- `AgentPanel` — streaming text + tool status

This keeps ExecutionScreen as the orchestrator (state management + callbacks) while the components handle pure rendering.

### `onExperimentEnd` callback already exists — just accumulate results

The `LoopCallbacks.onExperimentEnd` fires with an `ExperimentResult` after each experiment. ExecutionScreen currently ignores it (`onExperimentEnd: () => {}`). Phase 2f wires it to append results to a state array. No new callback needed.

### Agent output resets between experiments

When `onExperimentStart` fires, the agent panel text clears. This prevents the panel from showing stale text from the previous experiment and keeps memory bounded.

---

## Files to Create

### 1. `src/components/StatsHeader.tsx` — Stats + sparkline panel

A fixed-height panel showing run statistics and a metric sparkline.

#### Props

```typescript
interface StatsHeaderProps {
  experimentNumber: number
  totalKeeps: number
  totalDiscards: number
  totalCrashes: number
  currentBaseline: number
  originalBaseline: number
  bestMetric: number
  bestExperiment: number
  direction: "lower" | "higher"
  metricField: string
  totalCostUsd: number
  metricHistory: number[]  // keep-only metric values for sparkline
  currentPhaseLabel: string
}
```

#### Rendering

[CHANGED] ```tsx
export function StatsHeader(props: StatsHeaderProps) {
  const stats = computeDisplayStats(props)

  return (
    <box flexDirection="column" border borderStyle="rounded" title={`Experiment #${props.experimentNumber}`}>
      <box flexDirection="column" padding={1}>
        {/* Multi-color inline text: use <box flexDirection="row"> with sibling <text> elements.
            <span> does NOT exist in OpenTUI. <text> cannot be nested inside <text>. */}
        <box flexDirection="row">
          <text fg="#9ece6a"><strong>{props.totalKeeps} kept</strong></text>
          <text>{"  "}</text>
          <text fg="#ff5555">{props.totalDiscards} discarded</text>
          <text>{"  "}</text>
          <text fg="#888888">{props.totalCrashes} crashed</text>
        </box>
        <text>
          Baseline: {props.currentBaseline}  Best: {props.bestMetric}
          {stats.improvementStr}
        </text>
        <text fg="#888888">
          Cost: ${props.totalCostUsd.toFixed(2)}  •  {props.currentPhaseLabel}
        </text>
      </box>
      {props.metricHistory.length > 1 && (
        <box padding={1}>
          <text fg="#7aa2f7">{renderSparkline(props.metricHistory, props.direction)}</text>
        </box>
      )}
    </box>
  )
}
```

#### `renderSparkline(values: number[], direction: "lower" | "higher"): string`

Pure function that converts an array of numbers into a sparkline string.

Implementation:
1. Define the sparkline characters: `const BLOCKS = "▁▂▃▄▅▆▇█"`
2. Find min/max of values
3. If min === max, return a flat line of middle blocks
4. For each value, map to a block index: `Math.round(((value - min) / (max - min)) * 7)`
5. If `direction === "lower"`, invert so improvements (lower values) render as higher blocks
6. Cap sparkline to terminal width minus padding (take last N values if too many)
7. Return the concatenated block characters

#### `computeDisplayStats(props): { improvementStr: string }`

Pure helper to compute display-ready strings:
- `improvementStr`: `" (-20.3%)"` or `" (+5.1%)"` computed as `((bestMetric - originalBaseline) / |originalBaseline|) * 100`
- Uses direction to determine sign convention (for "lower" direction, negative % = improvement)

---

### 2. `src/components/ResultsTable.tsx` — Scrollable results table

A scrollable table displaying experiment outcomes with color-coded status.

#### Props

```typescript
interface ResultsTableProps {
  results: ExperimentResult[]
  metricField: string
}
```

#### Rendering

```tsx
export function ResultsTable({ results, metricField }: ResultsTableProps) {
  // Skip the baseline row (#0) — it's in the stats header
  const experiments = results.filter(r => r.experiment_number > 0)

  return (
    <box flexDirection="column" flexGrow={1} border borderStyle="rounded" title="Results">
      {/* Header row */}
      [CHANGED] <box padding={1}>
        <text fg="#888888">
          {padRight("#", 4)}{padRight("commit", 9)}{padRight(metricField, 12)}{padRight("status", 12)}description
        </text>
      </box>
      {/* Data rows in scrollbox */}
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {experiments.length === 0 ? (
          <box padding={1}>
            <text fg="#888888">No experiments yet...</text>
          </box>
        ) : (
          experiments.map((r) => (
            <box key={r.experiment_number} padding={1}>
              <text fg={statusColor(r.status)}>
                {padRight(String(r.experiment_number), 4)}
                {padRight(r.commit, 9)}
                {padRight(r.metric_value ? String(r.metric_value) : "—", 12)}
                {padRight(r.status, 12)}
                {truncate(r.description, 40)}
              </text>
            </box>
          ))
        )}
      </scrollbox>
    </box>
  )
}
```

#### `statusColor(status: ExperimentStatus): string`

```typescript
function statusColor(status: ExperimentStatus): string {
  switch (status) {
    case "keep": return "#9ece6a"             // green
    case "discard": return "#ff5555"           // red
    case "crash": return "#ff5555"             // red
    case "measurement_failure": return "#e0af68" // yellow
  }
}
```

#### `padRight(str: string, width: number): string`

```typescript
function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length)
}
```

#### `truncate(str: string, maxLen: number): string`

```typescript
function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str
}
```

---

### 3. `src/components/AgentPanel.tsx` — Streaming agent output

A scrollable panel showing the agent's streaming text output and tool use status.

#### Props

```typescript
interface AgentPanelProps {
  streamingText: string
  toolStatus: string | null
  isRunning: boolean
}
```

#### Rendering

[CHANGED] ```tsx
export function AgentPanel({ streamingText, toolStatus, isRunning }: AgentPanelProps) {
  return (
    <box flexDirection="column" height={12} border borderStyle="rounded" title="Agent">
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">
        {!streamingText && !toolStatus && isRunning && (
          <box padding={1}>
            <text fg="#888888">Waiting for agent...</text>
          </box>
        )}
        {streamingText && (
          <box padding={1} flexDirection="column">
            <text>{streamingText}</text>
          </box>
        )}
      </scrollbox>
      {toolStatus && isRunning && (
        <box padding={1}>
          <text fg="#888888">⟳ {toolStatus}</text>
        </box>
      )}
    </box>
  )
}
```

**Note:** `paddingLeft` and `paddingBottom` are NOT valid OpenTUI props (zero usage in codebase). Use uniform `padding={1}` instead.

**Key details:**
- Fixed height of 12 lines — enough to see context without stealing from the results table
- `stickyScroll` + `stickyStart="bottom"` — auto-scrolls to latest text
- `toolStatus` is shown below the scrollbox as a status bar within the border, separate from the streaming text
- When the agent produces text, it replaces the "Waiting for agent..." placeholder
- The `streamingText` prop is the full accumulated text for the current experiment (not just the latest chunk)

---

## Files to Modify

### 4. `src/screens/ExecutionScreen.tsx` — Full dashboard rewrite

The ExecutionScreen is the main file that changes. It keeps its existing lifecycle logic (useEffect for starting the run, abort handling) but replaces the inline rendering with the three new components.

#### New state variables

Add to the existing state declarations:

```typescript
// Existing (keep as-is)
const [phase, setPhase] = useState<ExecutionPhase>("starting")
const [runState, setRunState] = useState<RunState | null>(null)
const [currentPhaseLabel, setCurrentPhaseLabel] = useState("Initializing...")
const [experimentNumber, setExperimentNumber] = useState(0)
const [lastError, setLastError] = useState<string | null>(null)
const [terminationReason, setTerminationReason] = useState<TerminationReason | null>(null)
const [originalBranch, setOriginalBranch] = useState<string | null>(null)
const abortControllerRef = useRef<AbortController>(null!)

// New for Phase 2f
const [results, setResults] = useState<ExperimentResult[]>([])
const [metricHistory, setMetricHistory] = useState<number[]>([])
const [agentStreamText, setAgentStreamText] = useState("")
const [toolStatus, setToolStatus] = useState<string | null>(null)
const [totalCostUsd, setTotalCostUsd] = useState(0)
const [programConfig, setProgramConfig] = useState<ProgramConfig | null>(null)
```

#### Updated callbacks

Replace the current callbacks object inside the useEffect:

```typescript
const callbacks: LoopCallbacks = {
  onPhaseChange: (p, detail) => {
    if (!cancelled) setCurrentPhaseLabel(detail ? `${p}: ${detail}` : p)
  },
  onExperimentStart: (num) => {
    if (!cancelled) {
      setExperimentNumber(num)
      setAgentStreamText("")   // Reset agent panel for new experiment
      setToolStatus(null)
    }
  },
  onExperimentEnd: (result) => {
    if (!cancelled) {
      setResults(prev => [...prev, result])
      if (result.status === "keep") {
        setMetricHistory(prev => [...prev, result.metric_value])
      }
    }
  },
  onStateUpdate: (s) => {
    if (!cancelled) setRunState(s)
  },
  onAgentStream: (text) => {
    if (!cancelled) setAgentStreamText(prev => prev + text)
  },
  onAgentToolUse: (status) => {
    if (!cancelled) setToolStatus(status)
  },
  onError: (msg) => {
    if (!cancelled) setLastError(msg)
  },
  onLoopComplete: (_state, reason) => {
    if (!cancelled) setTerminationReason(reason)
  },
}
```

#### `onExperimentCost` — Cost accumulation via LoopCallbacks extension

The existing `LoopCallbacks` interface doesn't have a cost callback. Cost data is available on `ExperimentOutcome.cost` and logged via `eventLogger.logExperimentCost()`. Two options:

**Option A (preferred): Add `onExperimentCost` to LoopCallbacks.**

Add to the `LoopCallbacks` interface in `experiment-loop.ts`:

```typescript
export interface LoopCallbacks {
  // ... existing callbacks ...
  onExperimentCost?: (cost: ExperimentCost) => void
}
```

And emit it in the loop body (after the existing `eventLogger.logExperimentCost(outcome.cost)` call, around line 388):

```typescript
if (outcome.cost) {
  void eventLogger.logExperimentCost(outcome.cost)
  wrappedCallbacks.onExperimentCost?.(outcome.cost)
}
```

Then in ExecutionScreen's callbacks:

```typescript
onExperimentCost: (cost) => {
  if (!cancelled) setTotalCostUsd(prev => prev + cost.total_cost_usd)
},
```

#### Store programConfig for display

After loading the config (line 49 of current ExecutionScreen), save it to state:

```typescript
const config = await loadProgramConfig(programDir)
if (!cancelled) setProgramConfig(config)
```

This provides `metricField` and `direction` to the dashboard components.

#### Updated render — running state

Replace the current `(phase === "starting" || phase === "running")` block:

```tsx
{(phase === "starting" || phase === "running") && (
  <box flexDirection="column" flexGrow={1}>
    {/* Stats Header */}
    <StatsHeader
      experimentNumber={experimentNumber}
      totalKeeps={runState?.total_keeps ?? 0}
      totalDiscards={runState?.total_discards ?? 0}
      totalCrashes={runState?.total_crashes ?? 0}
      currentBaseline={runState?.current_baseline ?? 0}
      originalBaseline={runState?.original_baseline ?? 0}
      bestMetric={runState?.best_metric ?? 0}
      bestExperiment={runState?.best_experiment ?? 0}
      direction={programConfig?.direction ?? "lower"}
      metricField={programConfig?.metric_field ?? "metric"}
      totalCostUsd={totalCostUsd}
      metricHistory={metricHistory}
      currentPhaseLabel={currentPhaseLabel}
    />

    {/* Results Table */}
    <ResultsTable
      results={results}
      metricField={programConfig?.metric_field ?? "metric"}
    />

    {/* Agent Output Panel */}
    <AgentPanel
      streamingText={agentStreamText}
      toolStatus={toolStatus}
      isRunning={phase === "running"}
    />

    {/* Error display */}
    {lastError && (
      <box paddingLeft={1}>
        <text fg="#ff5555">{lastError}</text>
      </box>
    )}
  </box>
)}
```

#### "Starting" phase display

When `phase === "starting"`, the dashboard renders but with default/empty values. The `currentPhaseLabel` shows "Establishing baseline..." (already set on line 39). The StatsHeader shows zeros, the ResultsTable shows "No experiments yet...", and the AgentPanel shows "Waiting for agent...". This is intentional — the user sees the dashboard layout immediately while baseline measurement runs.

#### Seed metricHistory with baseline

After `startRun()` succeeds (line 43-44 of current code), seed the metric history with the baseline:

```typescript
setRunState(runResult.state)
setMetricHistory([runResult.state.original_baseline])  // Baseline is first point in sparkline
```

---

### 5. `src/lib/experiment-loop.ts` — Add `onExperimentCost` callback

#### Changes

1. **Add `onExperimentCost` to `LoopCallbacks` interface** (after line 48):

   ```typescript
   onExperimentCost?: (cost: ExperimentCost) => void
   ```

2. **Add import for `ExperimentCost`** (update the import from `./experiment.ts`):

   ```typescript
   import {
     buildContextPacket,
     buildExperimentPrompt,
     runExperimentAgent,
     checkLockViolation,
     type ExperimentCost,  // add this
   } from "./experiment.ts"
   ```

3. **Emit the callback in the loop body** — After the existing `eventLogger.logExperimentCost(outcome.cost)` call (around line 388), add:

   ```typescript
   if (outcome.cost) {
     void eventLogger.logExperimentCost(outcome.cost)
     wrappedCallbacks.onExperimentCost?.(outcome.cost)  // add this line
   }
   ```

4. **Wrap the cost callback with event logging** — In the `wrappedCallbacks` object (around line 303), add:

   ```typescript
   onExperimentCost: (cost) => {
     callbacks.onExperimentCost?.(cost)
     // Event already logged above, no need to double-log
   },
   ```

   Note: Actually, looking at the current code more carefully, the cost callback is emitted *outside* the wrapped callbacks section (directly after `outcome.cost` check at line 387). So the wrapping approach doesn't apply. Just emit the callback directly:

   ```typescript
   if (outcome.cost) {
     void eventLogger.logExperimentCost(outcome.cost)
     callbacks.onExperimentCost?.(outcome.cost)
   }
   ```

---

### 6. `src/lib/experiment-loop.ts` — Add `onAgentStream` to event logger wrapping

Currently, `onAgentStream` is passed through unwrapped (line 329):
```typescript
onAgentStream: callbacks.onAgentStream,
```

This is correct — streaming text should NOT be persisted to events.ndjson (it's too voluminous). Keep this as-is.

---

## Integration Notes

### Import updates in ExecutionScreen.tsx

```typescript
// Add these imports
import { StatsHeader } from "../components/StatsHeader.tsx"
import { ResultsTable } from "../components/ResultsTable.tsx"
import { AgentPanel } from "../components/AgentPanel.tsx"
import type { ExperimentResult } from "../lib/run.ts"
import type { ProgramConfig } from "../lib/programs.ts"
import type { ExperimentCost } from "../lib/experiment.ts"
```

### No changes needed to these files

- `src/components/RunCompletePrompt.tsx` — Already works, renders in the `complete`/`error` phase
- `src/App.tsx` — Status bar text already shows `q: abort run | Escape: back (after completion)`, which is correct
- `src/lib/run.ts` — All read-side functions already exist
- `src/lib/events.ts` — Event logging already handles cost events
- `src/lib/experiment.ts` — ExperimentCost already exported and populated
- `src/lib/measure.ts` — No changes
- `src/lib/git.ts` — No changes

### Terminal width considerations

The sparkline and results table should handle narrow terminals gracefully:
- Sparkline: cap at `Math.min(values.length, 50)` characters, show only the most recent values
- Results table: truncate the description column based on available width (hard-code reasonable column widths for the structured columns, give description the remainder)
- Agent panel: text wraps naturally in OpenTUI `<text>` elements

### Memory considerations

- `agentStreamText` accumulates per experiment and resets on `onExperimentStart`. A single experiment's streaming text is typically 2-10KB — no concern.
- `results` array grows by one entry per experiment. Even at 1000 experiments, this is negligible.
- `metricHistory` grows by one entry per keep. Same — negligible.

---

## Implementation Order

1. **`src/components/StatsHeader.tsx`** — Create the component with `renderSparkline()` helper. Can be tested visually in isolation with mock data.

2. **`src/components/ResultsTable.tsx`** — Create the component with `statusColor()`, `padRight()`, `truncate()` helpers.

3. **`src/components/AgentPanel.tsx`** — Create the component. Simplest of the three.

4. **`src/lib/experiment-loop.ts`** — Add `onExperimentCost` to `LoopCallbacks`, emit it in the loop. Small change.

5. **`src/screens/ExecutionScreen.tsx`** — Wire everything together: new state, updated callbacks, new render layout. This is the main integration file.

6. **Verify** — Run `bun lint && bun typecheck` to confirm everything compiles.

---

## Updates to CLAUDE.md

Add under **Project Structure** `components/` section:

```
  components/
    Chat.tsx             # Multi-turn chat with Claude Agent SDK streaming
    RunCompletePrompt.tsx # Post-run prompt (cleanup or abandon)
    StatsHeader.tsx      # Run stats + metric sparkline
    ResultsTable.tsx     # Color-coded experiment results table
    AgentPanel.tsx       # Live agent streaming output panel
```

Add under **Agent Conventions**:

```
- Dashboard components are pure rendering — all state lives in ExecutionScreen
- `onExperimentCost` callback on `LoopCallbacks` provides per-experiment cost data to the TUI
- Agent streaming text resets on each `onExperimentStart` — never accumulates across experiments
- Sparkline uses keep-only metric values via `getMetricHistory()` pattern
- Results table color-codes by status: green=keep, red=discard/crash, yellow=measurement_failure
```

Update the **Current State** paragraph in `docs/architecture.md` to mention Phase 2f:

```
Phase 2f (TUI Dashboard) adds the full execution dashboard: stats header with sparkline,
color-coded results table, and live agent output panel. The dashboard is composed of three
rendering components (StatsHeader, ResultsTable, AgentPanel) orchestrated by ExecutionScreen.
```

---

## Updates to docs/architecture.md

Add a new section after "Experiment Agent":

### Execution Dashboard (`src/screens/ExecutionScreen.tsx`)

Three-panel dashboard for live experiment monitoring:

- **StatsHeader** — Fixed-height panel: experiment count, keeps/discards/crashes, baseline vs best metric with improvement %, cumulative cost, and a Unicode sparkline of keep-only metric values
- **ResultsTable** — Scrollable table of experiment outcomes, color-coded by status (green=keep, red=discard/crash, yellow=measurement_failure), auto-scrolls to latest
- **AgentPanel** — Fixed-height scrollable panel showing streaming agent text output and current tool use status, resets between experiments

State management: ExecutionScreen owns all dashboard state (results array, metric history, streaming text, cost accumulator). Components receive props — no component-local data fetching. LoopCallbacks drive all updates.

---

[CHANGED] ## Updates to README.md

README.md already exists at the project root. No changes needed for Phase 2f — the dashboard is an internal implementation detail, not a user-facing feature change.

---

## Verification Checklist

After implementation, verify:

1. `bun lint && bun typecheck` passes
2. Dashboard renders during "starting" phase (baseline measurement) with empty/default values
3. StatsHeader updates live as experiments complete
4. Sparkline grows with each kept experiment
5. Results table shows each experiment with correct color coding
6. Agent panel streams text in real-time, resets between experiments
7. Tool status shows current agent action (Reading, Writing, Running, etc.)
8. Cost accumulates across experiments
9. Abort (q / Ctrl+C) still works — dashboard transitions to RunCompletePrompt
10. RunCompletePrompt still renders correctly after completion
11. Error display still works
12. No memory leaks from unbounded state growth (verify resets work)

---

## [NEW] Review Notes

This plan was reviewed against the OpenTUI API (as used in the existing codebase) and current codebase state. Key corrections:

- **Fixed (RED):** `<span>` is NOT a valid OpenTUI intrinsic element. Zero occurrences in the codebase. OpenTUI only has `box`, `text`, `input`, `scrollbox` (per CLAUDE.md). The StatsHeader used `<span fg="...">` for inline colored text — replaced with `<box flexDirection="row">` containing sibling `<text fg="...">` elements, which is the correct pattern for multi-color text on one line.
- **Fixed (YELLOW):** `paddingLeft` and `paddingBottom` are not used anywhere in the codebase — only uniform `padding={N}` is used. Replaced all directional padding with `padding={1}` in StatsHeader, ResultsTable, and AgentPanel.
- **Fixed (YELLOW):** README.md already exists (caught in 2a review). Updated the reference.
- **Verified:** `<scrollbox stickyScroll stickyStart="bottom">` is correct (confirmed in Chat.tsx). `<strong>` inside `<text>` is the correct bold pattern. `onExperimentCost` callback addition is cleanly designed.
