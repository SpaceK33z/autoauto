# Plan: Modal Sandbox Support

> **Issue:** [#18](https://github.com/SpaceK33z/autoauto/issues/18)
> **Status:** Design complete, ready for implementation
> **Date:** 2026-04-09

## Motivation

Run experiments inside Modal Sandboxes so that:

- You don't have to keep your computer running (overnight batch runs)
- Benchmarking is more consistent (isolated, reproducible hardware)

## Architecture Overview

```
LOCAL (user's machine)              |  MODAL SANDBOX (remote)
                                    |
+---------------------+            |  +----------------------------+
| TUI (OpenTUI)       |            |  | Bare Ubuntu container      |
|                     |  Modal SDK  |  |                            |
| +------------------+|  ---------> |  | Setup agent installs:      |
| | Setup Agent      ||  exec/fs   |  |  - Bun, git, autoauto      |
| | (local, proxied  ||            |  |  - Project deps            |
| |  tools only)     ||            |  |  - Verifies measure.sh     |
| +------------------+|            |  |                            |
|                     |  exec()    |  | Then daemon starts:        |
| +------------------+|  ---------> |  |  bun autoauto daemon ...   |
| | Polling watcher  ||  readFile  |  |                            |
| | (state.json,     || <--------- |  |  +----------------------+  |
| |  results.tsv,    ||            |  |  | Experiment loop      |  |
| |  stream logs)    ||            |  |  |  - Agent sessions     |  |
| +------------------+|            |  |  |  - measure.sh         |  |
|                     |  writeFile |  |  |  - git reset/commit   |  |
| +------------------+|  ---------> |  |  +----------------------+  |
| | Control          || control.json|  |                            |
| | (stop/abort)     ||            |  | On completion:             |
| +------------------+|            |  |  git bundle create ...     |
|                     |  readFile  |  |                            |
| +------------------+| <--------- |  +----------------------------+
| | Bundle download  ||  .bundle   |
| | + local apply    ||            |
| +------------------+|            |
+---------------------+            |
```

## Decisions

### Scope: everything in sandbox

The daemon, agent, and measurement all run inside the Modal Sandbox. The user's laptop is completely free during the run. Only the TUI (for monitoring) and the setup agent run locally.

### TUI <-> daemon communication

- **Daemon -> TUI:** Modal SDK file polling. The daemon writes the same files it does today (`state.json`, `results.tsv`, `stream-*.log`). The TUI reads them via `sandbox.open(path, "r")` on a polling interval instead of local `fs.watch`.
- **TUI -> daemon (graceful stop):** Write `control.json` into the sandbox via Modal SDK. Daemon checks it between experiments (same as today).
- **TUI -> daemon (hard kill):** `sandbox.terminate()` via Modal SDK.

### Codebase transfer

Full repo upload (including `.git`) to the sandbox at run start. This ensures full git history is available for context packets, git log, etc.

### Runtime provisioning

A **setup agent** runs at the start of each sandbox run as a provisioning phase. It starts from a bare Ubuntu image and installs everything:

- Bun + git
- autoauto (via bash install script)
- Project-specific dependencies (inspected from the repo: package.json, requirements.txt, Cargo.toml, etc.)
- Verifies `measure.sh` works (dry run)

**No caching between runs** -- fresh provisioning each time. Avoids invalidation complexity.

### Setup agent mechanics

- Runs **locally** with tools **proxied into the sandbox**
- Tools: `SandboxExec`, `SandboxReadFile`, `SandboxWriteFile` only -- no local `Bash` tool
- Clear system prompt that explains it's setting up a remote sandbox environment
- Iterates until `measure.sh` produces valid JSON output
- Also available as a standalone CLI command: `autoauto sandbox test --program <slug>`

### API secrets in sandbox

Use **Modal Secrets** (configured in Modal dashboard, referenced by name). The sandbox gets `ANTHROPIC_API_KEY` etc. via Modal's native secrets mechanism -- no secrets stored in config files.

### No worktrees inside sandbox

The sandbox itself is the isolation boundary. The daemon runs in "in-place" mode directly on the uploaded repo. `git reset --hard` reverts failed experiments.

### Results sync via git bundle

When the daemon finishes:
1. Creates a git bundle of the experiment branch
2. TUI downloads the bundle via Modal filesystem API
3. TUI applies the bundle locally (`git bundle unbundle`)
4. If the local repo has diverged from the base commit, warn the user

### Finalization happens locally

After pulling the git bundle back, the user does finalization through the normal TUI flow (review experiment results, group branches, etc.). This preserves the existing interactive UX.

### 24h timeout is acceptable

Modal Sandboxes support up to 24h. No checkpoint/resume mechanism needed.

### Per-run toggle in PreRunScreen

Sandbox mode is a per-run choice in PreRunScreen (alongside model, effort, max experiments, worktree). Users can do some runs local, some sandboxed.

### Modal auth

Checked when user first toggles sandbox mode in PreRunScreen. If `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` are missing, show inline instructions with a link to the Modal dashboard. Don't proceed until auth works.

### SandboxProvider abstraction from day one

Define a `SandboxProvider` interface. Modal is the first implementation. This allows adding E2B, Fly.io Machines, etc. later.

```typescript
interface SandboxProvider {
  create(image: string): Promise<Sandbox>
  // ... per-sandbox methods on the Sandbox object:
}

interface Sandbox {
  exec(cmd: string[]): Promise<{ stdout: string; exitCode: number }>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  uploadDir(localPath: string, remotePath: string): Promise<void>
  downloadFile(remotePath: string, localPath: string): Promise<void>
  terminate(): Promise<void>
  poll(): Promise<number | null> // exit code or null if running
}
```

### Queue interaction

Queue-wide setting: when queuing runs, all entries in the batch are either all-local or all-sandbox.

### TUI display

- **Sandbox indicator badge** in the ExecutionScreen header
- **Provisioning phase UI** showing the setup agent's progress before transitioning to the normal 3-panel execution view

### Reconnect after TUI disconnect

Tag each sandbox with `{ program: slug, runId: id }` via Modal's tagging API. When TUI reopens, query Modal for active sandboxes matching the tags. Works from any machine.

### Dependency management

Ship `modal` npm package in the binary build. Lazy-load the code paths so it only activates when sandbox mode is used.

### Divergence handling

Apply the git bundle as-is (experiment branch is based on the original commit). Warn the user if the local repo has diverged from the base commit since the run started.

## Execution Flow

1. User toggles "Sandbox" in PreRunScreen, starts run
2. TUI checks Modal auth (`MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`) -- guides if missing
3. TUI creates Modal sandbox (bare Ubuntu image)
4. TUI uploads full repo (including `.git`) to sandbox
5. **Provisioning phase** (visible in TUI):
   - Setup agent (local) inspects repo via proxied sandbox tools
   - Installs Bun, git, autoauto, project dependencies
   - Runs `measure.sh` to verify -- iterates if it fails
6. TUI starts daemon inside sandbox: `sandbox.exec(["bun", "autoauto", "daemon", ...])`
7. **Execution phase** (normal ExecutionScreen + sandbox badge):
   - Daemon runs experiment loop inside sandbox
   - TUI polls sandbox files for state/results/stream updates
   - User can gracefully stop (control.json) or hard-kill (terminate)
   - User can close TUI -- sandbox keeps running
8. **Completion**:
   - Daemon creates git bundle of experiment branch
   - TUI downloads bundle via Modal filesystem API
   - TUI applies bundle locally, warns if base diverged
   - Sandbox is terminated
9. **Finalization**: Normal local TUI flow (review, group branches, etc.)

## New Components

| File | Purpose |
|------|---------|
| `src/lib/sandbox/types.ts` | `SandboxProvider` and `Sandbox` interfaces |
| `src/lib/sandbox/modal-provider.ts` | Modal implementation of `SandboxProvider` |
| `src/lib/sandbox/index.ts` | Provider registry (get/set sandbox provider) |
| `src/lib/system-prompts/sandbox-setup.ts` | Setup agent system prompt |
| `src/lib/sandbox-setup.ts` | Setup agent orchestration (local agent + proxied tools) |
| `src/lib/sandbox-watcher.ts` | Remote file polling (replaces local fs.watch for sandbox runs) |
| `src/components/ProvisioningPhase.tsx` | Provisioning progress UI component |

## Modified Components

| File | Change |
|------|--------|
| `src/components/RunSettingsOverlay.tsx` / `PreRunScreen.tsx` | Add sandbox toggle + Modal auth check |
| `src/screens/ExecutionScreen.tsx` | Sandbox badge, provisioning phase before execution |
| `src/lib/daemon-spawn.ts` | Sandbox path: create sandbox + upload repo instead of local worktree |
| `src/lib/daemon-watcher.ts` | Abstract file reading to support remote polling via sandbox provider |
| `src/lib/daemon-status.ts` | Support sandbox-based health checking (Modal tags + sandbox poll) |
| `src/lib/queue.ts` | Queue-wide sandbox setting, sandbox-aware chaining |
| `src/cli.ts` | Add `autoauto sandbox test --program <slug>` command |
| `src/lib/finalize.ts` | Handle bundle-based branch (applied locally before finalize) |

## Open Implementation Questions

1. **Setup agent tool definitions**: Spike the exact Claude Agent SDK API for custom tools (`SandboxExec`, `SandboxRead`, `SandboxWrite`). Can we define custom tool handlers, or do we need a wrapper approach?
2. **Polling intervals**: What frequency for Modal filesystem reads? Balance latency vs. API cost. Likely 1-2s for stream logs, 5-10s for state/results.
3. **Sandbox compute size**: Default CPU/memory for the sandbox. Should be configurable per-program in `config.json`.
4. **Modal app naming**: Convention for the Modal app name (e.g., `autoauto-{program-slug}` or a single `autoauto` app for all sandboxes).

## Modal JS SDK Reference

```typescript
import { ModalClient } from "modal"

const modal = new ModalClient()
const app = await modal.apps.fromName("autoauto", { createIfMissing: true })
const image = modal.images.fromRegistry("ubuntu:22.04")

// Create sandbox
const sandbox = await modal.sandboxes.create(app, image, {
  cpu: 2,
  memoryMiB: 4096,
  timeoutMs: 86_400_000, // 24h
  secrets: [modalSecret],
})

// Execute commands
const proc = await sandbox.exec(["bash", "-c", "apt-get update && apt-get install -y git"])
const output = await proc.stdout.readText()
const exitCode = await proc.wait()

// File operations
const file = await sandbox.open("/workspace/state.json", "r")
const content = await file.read()
await file.close()

// Tags for reconnection
await sandbox.setTags({ program: "my-program", runId: "20260409-011223" })

// Terminate
await sandbox.terminate()
```
