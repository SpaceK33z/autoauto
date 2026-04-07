# Phase 1, Section 1c: Program Generation — Implementation Plan

## Goal

Enable the setup agent to generate the three program artifacts (`program.md`, `measure.sh`, `config.json`), write them to `.autoauto/programs/<slug>/`, and provide a conversational review & confirm step before saving. This transitions the setup flow from "inspect only" (1b) to "inspect, generate, and save" (1c).

## Section 1c Tasks (from phase-1.md)

1. Agent generates `program.md` (goal, scope, rules, steps)
2. Agent generates `measure.sh` (measurement script tailored to repo)
3. Agent generates `config.json` (metric field, direction, noise threshold, repeats, quality gates)
4. Save generated files to `.autoauto/programs/<name>/`
5. User review & confirm step before saving

## Current State

**Setup flow (1a + 1b) is fully implemented:**

- `src/components/Chat.tsx` — Multi-turn chat with streaming, tool status display, `bypassPermissions`, auto-scroll
- `src/screens/SetupScreen.tsx` — Passes agent config to Chat: `tools=["Read", "Bash", "Glob", "Grep"]`, `maxTurns=20`, system prompt with autoresearch expertise
- `src/lib/system-prompts.ts` — `getSetupSystemPrompt(cwd)` with 7-step conversation flow (inspect → clarify → scope → rules → measurement → quality gates → summary)
- `src/lib/programs.ts` — `getProjectRoot()`, `listPrograms()`, `ensureAutoAutoDir()`
- `src/lib/tool-events.ts` — `formatToolEvent()` for Read, Glob, Grep, Bash
- `src/App.tsx` — Screen routing (`home` | `setup`), passes `cwd=process.cwd()` to SetupScreen

**What's missing (the work for 1c):**

1. The agent has no `Write` or `Edit` tools — it can't generate files
2. The system prompt doesn't include artifact generation instructions (formats, paths, file templates)
3. `tool-events.ts` doesn't handle Write/Edit events
4. SetupScreen doesn't resolve `projectRoot` from `cwd` (matters when user runs from a subdirectory)
5. No types for the program config schema
6. No helper functions for program directory paths
7. `maxTurns` is 20 — may need to increase since artifact generation adds ~5-10 more agent turns

---

## Architecture Decisions

### 1. Agent Writes Files Using the Built-in `Write` Tool

**Decision: Give the setup agent the `Write` and `Edit` tools. The agent writes files to disk using the SDK's built-in Write tool.**

The Claude Agent SDK provides built-in `Write` and `Edit` tools (confirmed in SDK type definitions at `sdk.d.ts:960`: `tools?: string[]` accepts `['Bash', 'Read', 'Edit']`). These are the same tools Claude Code uses for file operations.

**Considered alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| **A: Write tool (chosen)** | Simple, reliable, natural for the agent | Files hit disk before explicit UI confirm |
| B: Parse text output | Content visible before disk write | Fragile text parsing, agent formatting varies |
| C: PreToolUse hook to intercept writes | Content captured before disk write | Complex, hook API adds indirection |
| D: Custom MCP tool `propose_program` | Clean separation | SDK `tools` option only accepts built-in names, MCP setup is heavy |

**Why Write tool wins:** The files land in `.autoauto/` which is gitignored — zero risk to the user's repo. The system prompt instructs the agent to present files for review BEFORE writing them. If the agent writes early (ignoring the prompt), the worst case is gitignored files that the user can delete. This matches the architecture philosophy: "App controls flow, agents provide intelligence." The app controls WHERE files go (via system prompt paths); the agent provides the CONTENT.

**Why also include Edit:** After the first draft, the user may ask for refinements ("change the noise threshold to 0.05", "add a rule about not modifying tests"). Edit is more efficient than rewriting entire files. The agent already knows how to use Edit.

### 2. Conversational Review (No Separate Review Screen)

**Decision: The review & confirm step happens IN the conversation, not in a dedicated TUI screen.**

The system prompt instructs the agent to:
1. Present all three files as code blocks in conversation text
2. Ask the user to review
3. Wait for user confirmation before writing

This is the simplest approach that satisfies "user review & confirm step before saving":
- No new screens to build
- Leverages the existing chat UI
- User can ask for changes naturally ("change X", "add Y")
- Agent iterates until user says "looks good" / "save it" / "confirm"
- Agent then uses Write tool to save files

**Why not a dedicated review screen:**
- Adds significant UI complexity (tab-select, syntax highlighting, multi-pane layout)
- The chat already displays code blocks readably
- The conversational review is actually better UX — user can discuss and iterate
- Can always add a formal review screen later

### 3. Resolve Project Root in SetupScreen

**Decision: SetupScreen resolves `projectRoot` from `cwd` using `getProjectRoot()` and passes it everywhere.**

Current code passes `process.cwd()` as `cwd` to both the Chat component and system prompt. This works if the user runs from the repo root, but breaks if they run from a subdirectory. The system prompt needs the correct absolute path so the agent writes files to the right location.

[CHANGED] ### 4. Increase maxTurns for Artifact Generation

**Decision: Increase `SETUP_MAX_TURNS` from 20 to 30.**

Per SDK docs, `maxTurns` counts conversation turns (user message + assistant response pairs), NOT individual tool calls. Tool calls within a single assistant response don't consume a turn. A typical setup flow has: ideation (3-5 user messages), scoping (3-5), review iterations (2-3), save confirmation (1) = ~15 user messages. 20 is likely fine, but 30 adds headroom for verbose multi-iteration reviews without being wasteful. 50 is unnecessarily high given the semantics.

---

## Files to Create

**None.** All changes modify existing files. No new files needed for 1c.

---

## Files to Modify

### 1. `src/screens/SetupScreen.tsx` — Add Write/Edit tools + resolve project root

#### 1a. Add Write and Edit to tool list

```typescript
const SETUP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
```

**Why this order:** Read/Write/Edit are file operations (grouped), Bash is shell, Glob/Grep are search. The order doesn't affect behavior but aids readability.

[CHANGED] #### 1b. Increase maxTurns

```typescript
const SETUP_MAX_TURNS = 30
```

#### 1c. Resolve project root asynchronously

Add a `useEffect` + `useState` to resolve the project root before rendering the Chat:

```typescript
import { useState, useEffect } from "react"
import { getProjectRoot } from "../lib/programs.ts"

// Inside SetupScreen component:
const [projectRoot, setProjectRoot] = useState<string | null>(null)

useEffect(() => {
  getProjectRoot(cwd).then(setProjectRoot).catch(() => setProjectRoot(cwd))
}, [cwd])
```

The fallback `setProjectRoot(cwd)` ensures the chat still works even if git resolution fails.

#### 1d. Pass resolved root to Chat and system prompt

```tsx
if (!projectRoot) {
  return (
    <box flexGrow={1} justifyContent="center" alignItems="center">
      <text fg="#888888">Resolving project root...</text>
    </box>
  )
}

return (
  <Chat
    cwd={projectRoot}
    systemPrompt={getSetupSystemPrompt(projectRoot)}
    tools={SETUP_TOOLS}
    allowedTools={SETUP_TOOLS}
    maxTurns={SETUP_MAX_TURNS}
  />
)
```

**Key change:** `cwd` prop is now `projectRoot` (resolved), not raw `cwd`. This ensures the agent's built-in tools (including Write) operate from the correct directory, and the system prompt includes the correct absolute paths.

#### Complete SetupScreen after changes

```typescript
import { useState, useEffect } from "react"
import { useKeyboard } from "@opentui/react"
import { Chat } from "../components/Chat.tsx"
import { getSetupSystemPrompt } from "../lib/system-prompts.ts"
import { getProjectRoot, type Screen } from "../lib/programs.ts"

const SETUP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
const SETUP_MAX_TURNS = 50

interface SetupScreenProps {
  cwd: string
  navigate: (screen: Screen) => void
}

export function SetupScreen({ cwd, navigate }: SetupScreenProps) {
  const [projectRoot, setProjectRoot] = useState<string | null>(null)

  useEffect(() => {
    getProjectRoot(cwd).then(setProjectRoot).catch(() => setProjectRoot(cwd))
  }, [cwd])

  useKeyboard((key) => {
    if (key.name === "escape") {
      navigate("home")
    }
  })

  if (!projectRoot) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg="#888888">Resolving project root...</text>
      </box>
    )
  }

  return (
    <Chat
      cwd={projectRoot}
      systemPrompt={getSetupSystemPrompt(projectRoot)}
      tools={SETUP_TOOLS}
      allowedTools={SETUP_TOOLS}
      maxTurns={SETUP_MAX_TURNS}  // [CHANGED] 30 (was 50)
    />
  )
}
```

---

### 2. `src/lib/system-prompts.ts` — Add artifact generation instructions

**This is the most important change in 1c.** The system prompt must guide the agent through generating correctly-formatted artifacts and writing them to the right location.

#### 2a. Update the function signature

The function signature stays the same: `getSetupSystemPrompt(cwd: string): string`. The `cwd` parameter is now the resolved project root (from SetupScreen).

#### 2b. Compute the programs directory path

At the top of the function, compute the absolute path:

```typescript
import { join } from "node:path"

export function getSetupSystemPrompt(cwd: string): string {
  const programsDir = join(cwd, ".autoauto", "programs")
  // ... rest of prompt
}
```

[CHANGED] #### 2c. Replace the conversation flow section

The current 7-step flow ends at "Summary — Present the complete program configuration for review before saving." Extend it to include artifact generation and saving.

**How to apply:** In the `getSetupSystemPrompt()` return string in `system-prompts.ts`, find the `## Conversation Flow` section (starts with `### If the user knows what to optimize:`) and replace the entire section — from `## Conversation Flow` up to (but not including) `## Key Principles` — with:

```
## Conversation Flow

### If the user knows what to optimize:
1. **Inspect** — Read package.json/Cargo.toml/pyproject.toml, check the framework, build system, test setup, and existing scripts. Do this immediately, before asking questions.
2. **Clarify** — Ask what metric to optimize (e.g., "reduce homepage LCP", "improve API latency", "increase test pass rate"). Ask about direction (lower/higher is better).
3. **Scope** — Help define what files/directories the experiment agent can touch, and what's off-limits. This is critical — an unbounded agent will game the metric.
4. **Rules** — Establish constraints (e.g., "don't reduce image quality", "don't remove features", "don't modify test fixtures").
5. **Measurement** — Discuss how to measure the metric. Suggest a measurement approach based on what you found in the repo. The measurement script must output a single JSON object to stdout.
6. **Quality Gates** — Identify secondary metrics that must not regress (e.g., CLS while optimizing LCP, test pass rate while optimizing speed).
7. **Generate & Review** — Present ALL THREE artifacts as code blocks for the user to review:
   - program.md
   - measure.sh
   - config.json
   Ask: "Would you like me to save these files, or would you like to make changes?"
8. **Iterate** — If the user asks for changes, update the artifacts and present again. Repeat until the user confirms.
9. **Save** — Once the user confirms, write the files using the Write tool (see exact paths and instructions below).

### If the user wants help finding targets (ideation mode):
1. **Deep inspection** — Thoroughly analyze the codebase: read key files, check the build system, look at package.json scripts, examine the project structure, check for existing benchmarks or tests.
2. **Suggest targets** — Present 3-5 concrete optimization opportunities with:
   - What to optimize (specific metric)
   - Why it's a good target (measurable, bounded scope, meaningful impact)
   - How to measure it (specific approach)
   - Estimated difficulty (easy/medium/hard)
3. **Let the user pick** — When they choose a target, transition into the regular setup flow above (starting at step 2).
```

#### 2d. Add the Artifact Generation section

Add a new section after the conversation flow:

```
## Artifact Generation

When you reach step 7, generate all three artifacts. Follow these formats exactly.

### Program Name (slug)

Choose a short, descriptive slug for the program:
- Lowercase letters and hyphens only
- 2-4 words, descriptive of the target
- Examples: "homepage-lcp", "api-latency", "test-stability", "bundle-size", "search-ranking"

### program.md Format

\`\`\`markdown
# Program: <Human-Readable Name>

## Goal
<One clear sentence describing what to optimize and in what direction.>

## Scope
- Files: <specific files or glob patterns the experiment agent may modify>
- Off-limits: <files, directories, or systems the agent must NOT touch>

## Rules
<Numbered list of constraints. Be specific. Examples:>
1. Do not remove features or functionality
2. Do not modify test fixtures or test data
3. Do not change the public API surface
4. <domain-specific constraints from the conversation>

## Steps
1. ANALYZE: Read the codebase within scope, review results.tsv for past experiments, and identify optimization opportunities
2. PLAN: Choose ONE specific, targeted change (not multiple changes at once)
3. IMPLEMENT: Make the change, keeping the diff small and focused
4. TEST: Verify the change doesn't break anything (run existing tests if available)
5. COMMIT: Stage and commit with message format: "<type>(scope): description"
\`\`\`

### measure.sh Format

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

# <Brief description of what this measures>
# Output: JSON object with metric fields

<measurement logic>

# Output MUST be a single JSON object on stdout, nothing else
echo '{"<metric_field>": <value>}'
\`\`\`

Requirements:
- Shebang: \`#!/usr/bin/env bash\`
- \`set -euo pipefail\` for strict error handling
- stdout: exactly ONE JSON object, nothing else (no logs, no progress, no debug)
- stderr: OK for logs/debug output (won't interfere with JSON parsing)
- Exit 0 on success, nonzero on failure
- Must complete in <30 seconds ideally, <60 seconds max
- Must be deterministic: lock random seeds, avoid network calls if possible
- Reuse long-lived processes: keep dev servers running, reuse browser instances
- The metric field name MUST match \`metric_field\` in config.json
- All quality gate fields MUST be present in the JSON output as finite numbers

### config.json Format

\`\`\`json
{
  "metric_field": "<key from measure.sh JSON output>",
  "direction": "<lower|higher>",
  "noise_threshold": <decimal, e.g. 0.02 for 2%>,
  "repeats": <integer, typically 3-5>,
  "quality_gates": {
    "<field_name>": { "max": <number> },
    "<field_name>": { "min": <number> }
  }
}
\`\`\`

Guidelines:
- \`noise_threshold\`: Start with 0.02 (2%) for stable metrics. Use 0.05 (5%) for noisier metrics. Discuss with the user based on the measurement type.
- \`repeats\`: Use 3 for fast, stable metrics. Use 5 for noisy ones. More repeats = more reliable but slower iterations.
- \`quality_gates\`: Only include gates for metrics that could realistically regress. Don't add gates for things that won't change. Use \`max\` for metrics that should stay below a threshold, \`min\` for metrics that should stay above.
- If there are no meaningful quality gates, use an empty object: \`"quality_gates": {}\`
```

#### 2e. Add the Save Instructions section

```
## Saving Files

IMPORTANT: Only save files AFTER the user explicitly confirms. Never write files before getting confirmation.

[CHANGED] When the user confirms, save files in this exact order:

1. Create the program directory first (Write tool may not create parent directories):
   \`\`\`bash
   mkdir -p ${programsDir}/<slug>
   \`\`\`

2. Write all three files:
   - Write program.md to: ${programsDir}/<slug>/program.md
   - Write measure.sh to: ${programsDir}/<slug>/measure.sh
   - Write config.json to: ${programsDir}/<slug>/config.json

3. Make measure.sh executable:
   \`\`\`bash
   chmod +x ${programsDir}/<slug>/measure.sh
   \`\`\`

4. Confirm to the user:
   "Program '<name>' saved to .autoauto/programs/<slug>/. Press Escape to go back to the program list."

### File paths must be ABSOLUTE. Use these exact base paths:
- Programs directory: ${programsDir}
- Example full path: ${programsDir}/homepage-lcp/program.md

### If the user wants to iterate after saving:
You can use the Edit tool to modify individual files, or Write to replace them entirely. Always show the user what changed.
```

#### 2f. Update the "What NOT to Do" section

Add these items to the existing "What NOT to Do" section:

```
- Don't write program files before the user confirms — always present for review first
- Don't write files outside of .autoauto/programs/ — only write to the program directory
- Don't forget to chmod +x measure.sh after writing it
- Don't include anything other than JSON in measure.sh's stdout — logs go to stderr
- Don't use sliding scales (1-7) for subjective metrics — use binary yes/no criteria instead
```

#### 2g. Full system prompt structure after changes

The complete system prompt will have these sections in order:
1. Identity + Role
2. Context (working directory)
3. Capabilities (now includes Write and Edit)
4. Conversation Flow (updated with steps 7-9 for generation/review/save)
5. Artifact Generation (NEW — format specs for all 3 files)
6. Saving Files (NEW — exact paths and instructions)
7. Key Principles (unchanged)
8. Measurement Script Requirements (unchanged)
9. Autoresearch Expertise (unchanged from 1b)
10. What NOT to Do (updated with generation-specific constraints)

**Update the Capabilities section** to mention Write and Edit:
```
## Capabilities

You can read files, search the codebase, list directories, run shell commands, write files, and edit files. Use read/search tools freely to understand the project before asking questions. Use write/edit tools ONLY when saving confirmed program artifacts to .autoauto/programs/.
```

---

### 3. `src/lib/tool-events.ts` — Add Write and Edit formatting

Add two new cases to the `switch` statement in `formatToolEvent()`:

```typescript
case "Write": {
  const filePath = input.file_path
  if (typeof filePath === "string") {
    const fileName = basename(filePath)
    return `Writing ${fileName}`
  }
  return "Writing file..."
}
case "Edit": {
  const filePath = input.file_path
  if (typeof filePath === "string") {
    const fileName = basename(filePath)
    return `Editing ${fileName}`
  }
  return "Editing file..."
}
```

These go before the `default` case. The tool status will show "⟳ Writing program.md", "⟳ Editing config.json", etc.

**Note:** At `content_block_start` time, `input` may be empty (input streams via deltas). The fallback strings "Writing file..." and "Editing file..." handle this gracefully.

---

### 4. `src/lib/programs.ts` — Add program config type and path helpers

#### 4a. Add ProgramConfig type

This type mirrors the config.json schema from IDEA.md. Not strictly needed for 1c (the agent writes the JSON), but it establishes the contract for later phases (execution, validation).

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

#### 4b. Add path helpers

```typescript
const PROGRAMS_DIR = "programs"

/** Returns the absolute path to the programs directory */
export function getProgramsDir(cwd: string): string {
  // Note: cwd should already be the resolved project root
  return join(cwd, AUTOAUTO_DIR, PROGRAMS_DIR)
}

/** Returns the absolute path to a specific program's directory */
export function getProgramDir(cwd: string, slug: string): string {
  return join(cwd, AUTOAUTO_DIR, PROGRAMS_DIR, slug)
}
```

These helpers are used by `getSetupSystemPrompt()` for computing the programs dir path. The `cwd` parameter is expected to be the resolved project root (from `getProjectRoot()`).

[CHANGED] ~~4c. `deleteProgram()` and 4d. enriched `Program` interface have been REMOVED.~~

Per project convention: "Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements." `deleteProgram()` is not used in 1c and `slug`/`dir` fields on `Program` are not consumed by any 1c code. Add these when a consumer actually needs them.

---

### 5. `src/components/Chat.tsx` — No changes needed

The Chat component already:
- Accepts `tools` prop (SetupScreen will pass the updated list)
- Handles tool_use events via `formatToolEvent()` (which we're updating)
- Uses `bypassPermissions` (Write/Edit will be auto-approved)
- Streams assistant text (agent's review presentation will render naturally)

No modifications required for 1c.

---

### 6. `src/App.tsx` — No changes needed

App already:
- Resolves `cwd` via `process.cwd()` (SetupScreen now resolves projectRoot from this)
- Calls `ensureAutoAutoDir()` on mount (creates `.autoauto/` and `.gitignore` entry)
- Routes between home and setup screens

No modifications required for 1c.

---

### 7. `src/screens/HomeScreen.tsx` — Minor update for enriched Program type

If the `Program` type is enriched (step 4d), HomeScreen already works because it only uses `program.name` for display. The `slug` and `dir` fields are additive. No changes needed unless we want to show more info in the program list.

**Optional enhancement:** Show a brief description from config.json next to each program name. But this is NOT part of 1c — defer to the program detail screen.

---

## Integration Flow

```
1.  User presses 'n' on HomeScreen → navigates to "setup"          (EXISTING)
2.  SetupScreen mounts, resolves projectRoot from cwd               (NEW)
3.  SetupScreen renders Chat with:                                   (MODIFIED)
    - cwd: projectRoot (resolved, not raw)
    - tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]     (NEW: Write, Edit)
    - systemPrompt: includes artifact generation instructions        (NEW)
    - maxTurns: 30                                                   [CHANGED] (was 20)
4.  Chat mounts, starts query() session                              (EXISTING)
5.  User converses with agent:                                       (EXISTING)
    - Agent inspects repo using Read, Bash, Glob, Grep
    - Agent asks about metric, scope, rules, measurement, gates
6.  Agent reaches step 7 — generates artifacts:                      (NEW)
    a. Agent presents program.md as markdown code block
    b. Agent presents measure.sh as bash code block
    c. Agent presents config.json as json code block
    d. Agent asks: "Would you like me to save these, or make changes?"
7.  User reviews artifacts in chat:                                  (NEW)
    - If changes needed: user describes changes → agent updates → repeat from 6
    - If approved: user says "save it" / "looks good" / "confirm"
8.  Agent saves files using Write tool:                              (NEW)
    a. Writes program.md to <root>/.autoauto/programs/<slug>/program.md
    b. Writes measure.sh to <root>/.autoauto/programs/<slug>/measure.sh
    c. Writes config.json to <root>/.autoauto/programs/<slug>/config.json
    d. Runs chmod +x on measure.sh via Bash
    e. Tool status shows: "⟳ Writing program.md", "⟳ Writing measure.sh", etc.
    f. Agent confirms: "Program saved! Press Escape to go back."
9.  User presses Escape → navigates to "home"                       (EXISTING)
10. HomeScreen loads programs from disk                              (EXISTING)
    - New program appears in the list                                (EXISTING — listPrograms already works)
```

---

## Message Type Handling

No new message types. The existing Chat.tsx handlers cover all 1c scenarios:

| SDK Event | What Happens | Status |
|---|---|---|
| `content_block_start` (tool_use, name="Write") | `setToolStatus("Writing program.md")` | **NEW** (via tool-events.ts update) |
| `content_block_start` (tool_use, name="Edit") | `setToolStatus("Editing config.json")` | **NEW** (via tool-events.ts update) |
| `content_block_delta` (text_delta) | Append text, clear tool status | EXISTING |
| `assistant` message | Extract text, add to messages | EXISTING |
| All other events | Existing handlers | EXISTING |

---

## Testing

### Manual Testing via tmux

```bash
# Launch in a real repo (e.g., autoauto itself)
cd /Users/keeskluskens/dev/autoauto
tmux new-session -d -s autoauto -x 120 -y 40 'bun dev'

# Navigate to setup
sleep 2
tmux send-keys -t autoauto 'n'
sleep 1

# Test full setup flow — ideation → setup → generate → review → save
tmux send-keys -t autoauto 'Help me find optimization targets' Enter
sleep 15
tmux capture-pane -t autoauto -p

# Pick a target (agent should suggest some based on repo)
tmux send-keys -t autoauto "Let's optimize the TUI rendering startup time" Enter
sleep 10
tmux capture-pane -t autoauto -p

# Answer agent questions about scope, rules, etc.
# (multiple turns of conversation)
# Eventually the agent should present program.md, measure.sh, config.json

# Verify artifacts are presented as code blocks
tmux capture-pane -t autoauto -p -S -100  # capture scrollback

# Confirm to save
tmux send-keys -t autoauto 'Looks good, save it' Enter
sleep 10
tmux capture-pane -t autoauto -p

# Verify:
# 1. Tool status showed "⟳ Writing program.md" etc.
# 2. Agent confirmed files were saved
# 3. Files exist on disk:
ls -la .autoauto/programs/*/
cat .autoauto/programs/*/program.md
cat .autoauto/programs/*/measure.sh
cat .autoauto/programs/*/config.json

# Verify measure.sh is executable:
file .autoauto/programs/*/measure.sh  # should show "executable"

# Go back to home and verify program appears
tmux send-keys -t autoauto Escape
sleep 1
tmux capture-pane -t autoauto -p
# Should see the new program in the list

tmux kill-session -t autoauto
```

### Test iteration flow

```bash
# After agent presents artifacts, ask for changes instead of confirming:
tmux send-keys -t autoauto 'Change the noise threshold to 0.05 and add a rule about not modifying tests' Enter
sleep 10
tmux capture-pane -t autoauto -p
# Agent should present updated artifacts
# Then confirm to save
```

### Test from subdirectory

```bash
cd /Users/keeskluskens/dev/autoauto/src
tmux new-session -d -s autoauto -x 120 -y 40 'bun dev'
# Verify: projectRoot should resolve to /Users/keeskluskens/dev/autoauto
# Files should be written to /Users/keeskluskens/dev/autoauto/.autoauto/programs/
```

### Verification Checklist

1. **Artifact presentation** — Agent presents program.md, measure.sh, config.json as code blocks before saving
2. **User review** — Agent waits for user confirmation before writing files
3. **File writing** — All three files written to `.autoauto/programs/<slug>/`
4. **measure.sh executable** — Has shebang, is chmod +x'd
5. **config.json valid** — Valid JSON with required fields (metric_field, direction, noise_threshold, repeats, quality_gates)
6. **program.md structure** — Has Goal, Scope, Rules, Steps sections
7. **Tool status** — Shows "⟳ Writing program.md" etc. during file writes
8. **Iteration** — User can ask for changes, agent updates, re-presents
9. **Home screen** — New program appears in list after saving + navigating back
10. **Project root resolution** — Works from subdirectories
11. **Agent stays in scope** — Doesn't write files outside `.autoauto/programs/`

### Typecheck & Lint

```bash
bun lint && bun typecheck
```

Both must pass.

---

## Potential Issues & Mitigations

### 1. Agent writes files before user confirms

**Risk:** The system prompt says "wait for confirmation," but agents sometimes ignore instructions and write files eagerly.

**Impact:** Low — files are in gitignored `.autoauto/` directory. No repo damage.

**Mitigations:**
1. System prompt is very explicit: "IMPORTANT: Only save files AFTER the user explicitly confirms."
2. Even if files are written early, the user can iterate (agent uses Edit to modify)
3. If this becomes a persistent problem in practice, add a `PreToolUse` hook on Write that checks a confirmation flag before allowing writes:
   ```typescript
   hooks: {
     PreToolUse: [{
       matcher: "Write|Edit",
       hooks: [async (input) => ({
         hookSpecificOutput: {
           hookEventName: 'PreToolUse',
           permissionDecision: confirmed ? 'allow' : 'deny',
           additionalContext: confirmed ? undefined : 'User has not confirmed yet. Present artifacts for review first.'
         }
       })]
     }]
   }
   ```

### 2. Agent writes to wrong paths

**Risk:** Agent writes files outside `.autoauto/programs/` (e.g., modifying source code).

**Impact:** Medium — could modify repo files during setup.

**Mitigations:**
1. System prompt explicitly says: "Don't write files outside of .autoauto/programs/"
2. Write/Edit tools respect the `cwd` option but don't restrict paths
3. If this becomes a problem, add a PreToolUse hook to validate paths:
   ```typescript
   hooks: {
     PreToolUse: [{
       matcher: "Write|Edit",
       hooks: [async (input) => {
         const filePath = (input as any).tool_input?.file_path ?? ""
         if (!filePath.includes(".autoauto/programs/")) {
           return {
             hookSpecificOutput: {
               hookEventName: 'PreToolUse',
               permissionDecision: 'deny',
               additionalContext: 'Can only write to .autoauto/programs/ during setup.'
             }
           }
         }
         return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
       }]
     }]
   }
   ```

[CHANGED] ### 3. Write tool may not create parent directories

**Risk:** If the SDK's Write tool doesn't create intermediate directories, the first Write call fails.

**Mitigation:** The system prompt MUST instruct the agent to create the directory first using Bash before any Write calls:
```bash
mkdir -p <programsDir>/<slug>
```

Claude Code's Write tool likely creates parent directories, but this is not guaranteed by the SDK type definitions. The `mkdir -p` step in the "Saving Files" prompt section is **mandatory, not optional** — the agent must always run it first. This is already included in section 2e's save instructions ("Create the program directory and write files") but the ordering must be explicit: mkdir first, then Write.

### 4. measure.sh stdout contamination

**Risk:** Agent generates a measure.sh that prints debug output to stdout, contaminating the JSON.

**Impact:** Measurement failures in phase 2 (execution).

**Mitigations:**
1. System prompt is very explicit: "stdout must contain exactly ONE JSON object, nothing else"
2. System prompt says: "stderr is OK for logs/debug output"
3. Phase 1d (measurement validation) will catch this by running the script
4. Include a common pattern in the prompt: `echo '{"metric": value}' # ONLY JSON on stdout`

[CHANGED] ### 5. maxTurns exhaustion

**Risk:** Complex setups with lots of iteration could exhaust 30 turns.

**Impact:** Agent stops responding mid-conversation.

**Mitigation:** 30 conversation turns is generous — most setups complete in 10-15 user messages (each counting as one turn). Tool calls within a single assistant response don't consume turns. If exhaustion becomes common, increase to 50.

### 6. Agent generates invalid config.json

**Risk:** Agent produces malformed JSON or wrong field types.

**Impact:** Execution phase fails to parse config.

**Mitigations:**
1. System prompt includes exact JSON format with field types
2. Phase 1d validation will catch this (running measure.sh validates the contract)
3. The agent can self-validate by reading the file back after writing
4. For MVP, trust the agent — it's very reliable at generating JSON

### 7. Program slug collision

**Risk:** Agent picks a slug that already exists (e.g., "homepage-lcp" when one already exists).

**Impact:** Overwrites existing program files.

**Mitigations:**
1. Agent can check existing programs with `ls .autoauto/programs/` via Bash
2. Add a note to the system prompt: "Check if the chosen slug already exists. If it does, pick a different name or ask the user."
3. For later: add a `programExists()` function to programs.ts and validate in the app

---

## Doc & Config Updates

### CLAUDE.md

**Update Project Structure** to reflect enriched programs.ts:

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
```

**Update Agent Conventions** to mention Write/Edit:

```markdown
## Agent Conventions

- Setup Agent uses built-in SDK tools (Read, Write, Edit, Bash, Glob, Grep)
- Agent tools are auto-approved via `permissionMode: "bypassPermissions"` — AutoAuto is the host app
- `cwd` is always set to the target project root (resolved via `getProjectRoot()`)
- System prompts live in `src/lib/system-prompts.ts`
- Tool status is displayed in the chat UI as brief one-line indicators
- Setup Agent writes program artifacts to `.autoauto/programs/<slug>/` only after user confirmation
- The Write tool creates parent directories automatically
```

### docs/architecture.md

**Update the Setup Agent section** to include artifact generation:

```markdown
### Setup Agent (`src/lib/system-prompts.ts`)

- **Purpose:** Inspect repo, suggest targets, define scope, generate program artifacts
- **Tools:** Read, Write, Edit, Bash, Glob, Grep
- **Permission mode:** `bypassPermissions` (AutoAuto manages UI, not the SDK)
- **Working directory:** Target project root (resolved via `getProjectRoot()`)
- **System prompt:** Encodes autoresearch expertise — guides user through repo inspection,
  target identification, scope definition, measurement approach, artifact generation
- **maxTurns:** 30 (conversation turns, including review iterations)
- **Artifacts generated:**
  - `program.md` — Goal, scope, rules, steps for the experiment agent
  - `measure.sh` — Measurement script tailored to the repo (must output JSON to stdout)
  - `config.json` — Metric field, direction, noise threshold, repeats, quality gates
- **Review flow:** Agent presents artifacts as code blocks for review before writing to disk
```

**Update the Data Layer section** to include config types:

```markdown
## Data Layer

`src/lib/programs.ts` — filesystem operations and types for `.autoauto/` in the git repo root:

- `getProjectRoot()` — resolves through git worktrees to find the main repo root (cached)
- `listPrograms()` — reads program directories from `.autoauto/programs/`
- `ensureAutoAutoDir()` — creates `.autoauto/` and adds it to `.gitignore`
- `getProgramsDir()` — returns absolute path to `.autoauto/programs/`
- `getProgramDir()` — returns absolute path to a specific program's directory
- `ProgramConfig` — TypeScript interface for `config.json` schema
- `QualityGate` — TypeScript interface for quality gate entries
```

**Update the Current State section:**

```markdown
## Current State

Phase 1 (Setup) is in progress. The TUI shell, screen navigation, program listing, and
multi-turn Claude Agent SDK chat are wired up. The setup agent can inspect the target repo,
suggest optimization targets, guide the user through scope and measurement design, generate
program artifacts (program.md, measure.sh, config.json), and save them after user review.
Measurement validation (running the generated script to check variance) is not yet implemented.
```

### README.md

**Update the "How It Works" section:**

```markdown
## How It Works

AutoAuto encodes autoresearch expertise into a guided workflow:

1. **Setup** — Chat with an AI agent that inspects your repo, helps you define what to optimize, generates a measurement script and program config, and saves everything after your review
2. **Execute** — Run an autonomous loop: spawn an agent, make one change, measure, keep or discard, repeat
3. **Cleanup** — Review accumulated changes, squash into clean commits, generate a summary report
```

No other README changes needed for 1c.

---

## Summary of Changes

| File | Action | Description |
|---|---|---|
| `src/screens/SetupScreen.tsx` | **Modify** | Add Write/Edit to tools, resolve projectRoot, increase maxTurns to 50 |
| `src/lib/system-prompts.ts` | **Modify** | Add artifact generation instructions, file format specs, save paths, slug guidance |
| `src/lib/tool-events.ts` | **Modify** | Add Write and Edit cases to `formatToolEvent()` |
| `src/lib/programs.ts` | **Modify** | [CHANGED] Add `ProgramConfig`/`QualityGate` types, `getProgramsDir()`, `getProgramDir()` helpers |
| `CLAUDE.md` | **Update** | Update agent conventions (Write/Edit), update project structure description |
| `docs/architecture.md` | **Update** | Update setup agent section, data layer section, current state |
| `README.md` | **Update** | Refine "How It Works" step 1 to mention artifact generation |

**Files NOT modified:**
- `src/components/Chat.tsx` — Already handles all needed message types
- `src/App.tsx` — Already routes and passes cwd correctly
- `src/screens/HomeScreen.tsx` — Already works with enriched Program type

---

## Order of Implementation

1. **Modify `src/lib/programs.ts`** — Add types and helpers (no dependencies, foundation for other changes)
2. **Modify `src/lib/tool-events.ts`** — Add Write/Edit cases (no dependencies)
3. **Modify `src/lib/system-prompts.ts`** — Add artifact generation instructions (depends on path helpers from programs.ts for the import, but could also inline `path.join`)
4. **Modify `src/screens/SetupScreen.tsx`** — Add tools, resolve projectRoot, increase maxTurns
5. **Run `bun lint && bun typecheck`** — Verify all changes compile
6. **Test interactively via tmux** — Full flow: ideation → setup → generate → review → save
7. **Verify file outputs** — Check all 3 artifacts on disk, measure.sh executable, valid JSON
8. **Test iteration** — Ask for changes, verify agent updates artifacts
9. **Test from subdirectory** — Verify projectRoot resolution
10. **If agent writes before confirm → add note to prompt or consider PreToolUse hook**
11. **If agent writes to wrong paths → add path validation note to prompt**
12. **Update `CLAUDE.md`** — Agent conventions, project structure
13. **Update `docs/architecture.md`** — Setup agent, data layer, current state
14. **Update `README.md`** — How It Works section
15. **Final `bun lint && bun typecheck`**

---

## Scope Boundaries

### What 1c Does
- Agent generates program.md, measure.sh, config.json with correct formats
- Agent writes files to `.autoauto/programs/<slug>/` using Write tool
- User reviews artifacts in conversation before agent saves
- User can iterate (ask for changes) before confirming
- Tool status shows Write/Edit operations
- SetupScreen resolves projectRoot for correct paths
- Program config TypeScript types defined

### What 1c Does NOT Do (deferred)
- **1d:** Run measure.sh to validate measurement stability
- **1d:** Check variance, warn about unreliable measurements
- **1d:** Guide user on noise threshold based on observed variance
- **1e:** Configure model tiers / throughput / auth
- **Future:** Dedicated review screen with syntax highlighting and tab navigation
- **Future:** PreToolUse hook to restrict Write paths to `.autoauto/programs/`
- **Future:** Programmatic detection of "setup complete" (agent just tells the user in text)
- **Future:** Program detail screen showing config, past runs, etc.

---

## Known Limitations (1c MVP)

1. **No enforced write path restriction.** System prompt tells the agent to only write to `.autoauto/programs/`, but this is not enforced. The agent could theoretically write to source code files. Acceptable for MVP — setup is interactive, user watches.
2. **No validation of generated artifacts.** The app doesn't check that program.md has required sections, measure.sh has a shebang, or config.json has required fields. The agent is reliable enough for MVP; phase 1d catches measure.sh issues by running it.
3. **Review is conversational, not structural.** There's no dedicated review UI with syntax highlighting, side-by-side comparison, or explicit approve/reject buttons. The chat suffices for MVP.
4. **No slug collision detection.** If the agent picks a slug that already exists, files are overwritten. The system prompt says to check, but it's not enforced.
5. **measure.sh is not validated for execution.** The script is written but never run in 1c — that's 1d.
6. **No undo after save.** Once files are written, there's no "undo save" in the UI. The user can delete the program directory manually or via a future UI.
7. **Agent may present artifacts in a different order or format.** The system prompt is specific, but agents have latitude. The user reviews in chat regardless.

---

## [NEW] Review Notes

This plan was reviewed against the Claude Agent SDK type definitions and the current codebase state. Key findings and corrections:

- **Confirmed:** `Write` IS a valid built-in SDK tool name. `FileWriteInput`/`FileWriteOutput` are in the tool type unions, and SDK hooks docs explicitly reference `"Write"` as a tool name example (sdk.d.ts:2990).
- **Confirmed:** `maxTurns` counts conversation turns (user + assistant pairs), NOT tool calls. Multiple tool calls in one assistant response = 1 turn.
- **Confirmed:** Plan's "Current State" is accurate — Chat.tsx already has `bypassPermissions`, tool status display, and `formatToolEvent`. 1b changes were applied.
- **Removed:** `deleteProgram()` and enriched `Program` interface (YAGNI — not consumed by any 1c code).
- **Changed:** `maxTurns` from 50 → 30. 50 was based on wrong mental model (thinking tool calls consumed turns). 30 is generous for ~15 actual user messages.
- **Changed:** Made `mkdir -p` explicit as a mandatory first step before Write calls, not a "safety net."
- **Changed:** Added anchor points for system prompt replacement so implementer knows exactly where new content goes.
- **Verified:** PreToolUse hook API shape matches SDK types (`permissionDecision`, `additionalContext` fields).
