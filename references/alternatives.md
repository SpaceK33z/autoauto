# Competitors / Alternatives

All implement some variant of the Karpathy "autoresearch" pattern: autonomous experiment loops with keep/discard decisions based on metric improvement.

---

## pi-autoresearch

- **URL**: https://github.com/davebcn87/pi-autoresearch
- **Stars**: 3,438 | **Created**: 2026-03-11 | **Activity**: Very active (39 merged PRs in < 1 month)
- **Form factor**: Plugin/extension for the **pi** terminal agent (not standalone)

**What it does**: Extension for pi (an AI coding agent by Mario Zechner) that adds autonomous experiment loops. Edit → commit → benchmark → keep/revert → repeat. Works for any optimization target (test speed, bundle size, ML loss, Lighthouse scores, etc.).

**How it works**:
- Exposes 3 MCP-style tools to the host agent: `init_experiment`, `run_experiment`, `log_experiment`
- LLM-agnostic — uses whatever provider pi is configured with
- The agent decides keep/discard (confidence scores are advisory only)
- Session state via two files: `autoresearch.jsonl` (append-only log) and `autoresearch.md` (living document with objective + history). A fresh agent can resume from these.
- MAD-based (Median Absolute Deviation) confidence scoring for noise estimation
- Optional `autoresearch.checks.sh` for correctness checks (tests, types, lint) after each benchmark
- **Finalize skill**: groups kept experiments into logical changesets and creates independent branches for clean PRs

**Unique aspects**:
- Finalize skill for post-loop cleanup into reviewable branches
- Session resumability via `autoresearch.md` — any agent can pick up where the last left off
- Browser-based live export dashboard
- Fastest traction in the space (3.4k stars in < 1 month)

**Overlap with AutoAuto**: Very high — closest competitor. Same core loop. Key differences: plugin vs standalone TUI, agent-driven keep/discard vs programmatic decision, no variance/noise threshold calibration, no measurement locking.

---

## autoresearch-oss (Frozo)

- **URL**: https://github.com/frozo-ai/autoresearch-oss
- **Stars**: 2 | **Created**: 2026-04-02 | **Activity**: Minimal (brand new)
- **Form factor**: Standalone **CLI tool** (`pip install autoresearch-cli`, command: `ars`). Also has a paid cloud version at research.frozo.ai.

**What it does**: Autonomous experiment loop runner. Define an optimization goal in `program.md`, provide a target file and eval script, and it loops: LLM proposes changes → eval → keep/revert.

**How it works**:
- Python CLI (~172k LoC Python, ~5k shell)
- **Non-agentic**: LLM proposes file edits directly (no tool calling). Orchestration is external Python code.
- **Multi-provider**: Anthropic (Claude), OpenAI (GPT-4o-mini), Google Gemini
- Eval harness: user script prints `metric_name:value` to stdout
- Smart loop: adaptive early stopping (15 consecutive failures), eval caching (SHA-256 dedup), explore/exploit strategy switching, cross-run memory of failed strategies
- `ars init` wizard with templates for prompt optimization, config tuning, marketing copy, test-passing code, SOPs

**Unique aspects**:
- **Freemium SaaS play**: OSS CLI capped at 25 experiments (unlimited if logged in); cloud plans $9-79/mo with parallel lanes (up to 16) and team features
- Cross-run memory of failed strategies
- Template scaffolding for common optimization types
- Provider-agnostic out of the box

**Overlap with AutoAuto**: High conceptual overlap, different implementation. Non-agentic (no tool use), simpler single-run eval (no variance analysis), file-level changes only (not multi-file agentic edits), freemium commercial model.

---

## auto-agent

- **URL**: https://github.com/alfonsograziano/auto-agent
- **Stars**: 26 | **Created**: 2026-03-21 | **Activity**: Low (last push 2026-03-24)
- **Form factor**: Standalone **CLI tool** (Node.js scripts via `npm run`). No TUI or web UI.

**What it does**: Autonomous agent optimization system that iteratively improves a target AI agent's accuracy against a golden dataset. You provide a repo with an AI agent + eval suite; auto-agent loops hypothesis-driven code changes, evaluates, and accepts or rolls back.

**How it works**:
- **Two-repo architecture**: orchestrator lives separately from the target agent repo
- Spawns `claude` or `kiro-cli` as child processes (via `execFileSync`), not via SDK
- Each iteration: create git branch → spawn coding agent with context (JOB.md + MEMORY.md + baseline report) → agent writes REPORT.md with CONTINUE/ROLLBACK decision → orchestrator parses it
- MEMORY.md persists across iterations — tracks what worked, what failed, known blockers
- Zero runtime dependencies (only Node.js built-ins + TypeScript types)
- Provider abstraction: supports Claude Code and Kiro CLI as interchangeable backends

**Unique aspects**:
- Specialized for improving AI agents (expects golden dataset + eval suite)
- Two-repo separation keeps orchestrator isolated from target code
- Agent makes its own keep/rollback decision (writes REPORT.md)
- Changelog generation post-run with inline diffs
- Zero dependencies philosophy

**Overlap with AutoAuto**: High conceptual, moderate implementation. Specialized for AI agent improvement vs AutoAuto's general-purpose approach. No variance-aware measurement, no TUI, no safeguards. Agent decides keep/rollback vs programmatic decision.

---

## openclaw-autoresearch

- **URL**: https://github.com/gianfrancopiana/openclaw-autoresearch
- **Stars**: 157 | **Created**: 2026-03-13 | **Activity**: Moderate (last push 2026-04-05)
- **Form factor**: **Plugin for OpenClaw** (AI coding assistant). Not standalone.

**What it does**: Port of `pi-autoresearch` for the OpenClaw ecosystem. Same autonomous experiment loop: edit → benchmark → keep/discard → repeat.

**How it works**:
- TypeScript plugin (~182k LoC), Vitest tests, `@sinclair/typebox` for schema validation
- 3 MCP-style tools: `init_experiment`, `run_experiment`, `log_experiment`
- Parses `METRIC name=number` lines from benchmark stdout
- MAD-based confidence scoring after 3+ runs
- File-first resumability: 6 repo-root files (session doc, benchmark script, JSONL log, ideas backlog, checkpoint JSON, session lock)
- **Ideas backlog**: discarded experiments must leave behind a concrete follow-up idea, building a persistent exploration queue
- Session lock with PID detection to prevent concurrent sessions

**Unique aspects**:
- Direct port of pi-autoresearch (battle-tested design) for the OpenClaw ecosystem
- Ideas backlog on discard — forced exploration queue
- File-first resumability (6 plain files any agent can read)
- Session locking with PID detection

**Overlap with AutoAuto**: Very high — same core loop. Key differences: plugin vs standalone TUI, file-first state vs structured program/run directories, ideas backlog (AutoAuto doesn't have), no explicit noise threshold calibration or measurement locking.

---

## autoresearch (uditgoenka)

- **URL**: https://github.com/uditgoenka/autoresearch
- **Stars**: 3,339 | **Created**: 2026-03-13 | **Activity**: Very active (last push 2026-04-06)
- **Form factor**: **Claude Code skill/plugin** (prompt-only, zero runtime code). Also works with OpenCode and OpenAI Codex.

**What it does**: A set of markdown files placed in `.claude/skills/` that instruct the host agent to run autonomous experiment loops. Provide a goal, metric, scope, and verify command; the agent loops: change → commit → verify → keep/revert. Also ships 9 extra subcommands (security audits, debugging, docs, scenario exploration, shipping workflows, adversarial reasoning).

**How it works**:
- **Entirely prompt-based** — zero runtime code. 100% Shell (install scripts) + markdown
- The host agent (Claude Code, OpenCode, Codex) interprets the markdown instructions and uses its built-in tools (Read, Write, Edit, Bash, etc.)
- Multi-platform: adapter scripts translate the same prompts for different host agents
- Interactive setup wizard via prompt instructions
- Everything runs in a single long-running agent session

**Unique aspects**:
- Pure prompt engineering — no code whatsoever. Cleverly leverages the host agent's capabilities.
- Multi-platform (Claude Code, OpenCode, Codex)
- Broadest scope: 10 subcommands covering optimization, security, debugging, docs, shipping, reasoning
- High traction (3.3k stars) despite being pure prompts

**Overlap with AutoAuto**: High conceptual, fundamentally different implementation. No runtime, no measurement validation, no variance analysis, no TUI, no cost tracking, no safeguards (measurement locking, lock detection, drift re-baselining). Trusts the agent to follow prompt rules. Much broader scope but shallow in each area. AutoAuto is narrow and deep.

---

## AutoAgent (kevinrgu)

- **URL**: https://github.com/kevinrgu/autoagent
- **Stars**: 3,769 | **Created**: 2026-04-02 | **Activity**: Recent (last push 2026-04-03)
- **Form factor**: **Repo template / convention** — no CLI, TUI, or web UI. Your coding agent reads `program.md` and follows its instructions.

**What it does**: Autonomous agent-engineering loop. A meta-agent (your coding agent, e.g. Claude Code) iteratively improves a Python agent harness (`agent.py`) — modifying system prompts, tools, agent config, and orchestration — then runs a benchmark, checks the score, keeps or discards.

**How it works**:
- The **meta-agent** is your existing coding agent (Claude Code, Cursor, etc.) — not a built-in orchestrator
- `program.md` defines the loop rules, setup steps, keep/discard criteria, failure analysis patterns
- Subject under test: `agent.py`, a single-file agent harness (OpenAI Agents SDK with GPT-5 or Claude Agent SDK with Haiku)
- Uses [Harbor](https://github.com/laude-institute/harbor) benchmark format: Docker-isolated containers with task instructions, verifiers, 0.0-1.0 scores
- Metric: `passed` count (hill-climbing). Results logged to `results.tsv`
- Python 3.12+, `uv`, `openai-agents`, `harbor`, `pandas`, `numpy`

**Unique aspects**:
- **Zero-code orchestrator**: loop logic exists entirely as natural language in `program.md`
- Specifically focused on agent engineering with Harbor benchmarks
- Two SDK variants: OpenAI Agents SDK (GPT-5) and Claude Agent SDK (Haiku)
- Single-file constraint with explicit "editable" vs "fixed adapter boundary" split
- Fastest star growth in the space (3.7k in 5 days)

**Overlap with AutoAuto**: High conceptual overlap — same core pattern including `results.tsv` and `program.md`. Radically simpler "convention over code" approach — no orchestrator code, no safeguards, no measurement infrastructure. Narrowly focused on agent harness engineering vs AutoAuto's general-purpose scope.

---

## Summary Comparison

| | Form Factor | Language | LLM | Orchestrator | Measurement | Safeguards | Stars |
|---|---|---|---|---|---|---|---|
| **AutoAuto** | Standalone TUI | TS/Bun | Claude (Agent SDK) | Programmatic | Multi-run, CV%, noise threshold, re-baseline | Measurement locking, lock detection | — |
| **pi-autoresearch** | pi plugin | TS | Any (pi's LLM) | Agent-driven | MAD confidence | Checks script | 3,438 |
| **autoresearch-oss** | CLI + SaaS | Python | Claude/GPT/Gemini | Programmatic (non-agentic) | Single-run | Early stopping, eval cache | 2 |
| **auto-agent** | CLI | TS/Node | Claude Code / Kiro | Programmatic (shell-out) | Eval JSON | MEMORY.md | 26 |
| **openclaw-autoresearch** | OpenClaw plugin | TS | Any (OpenClaw's LLM) | Agent-driven | MAD confidence | Session lock, ideas backlog | 157 |
| **autoresearch (uditgoenka)** | Claude Code skill | Markdown only | Any (host agent) | Prompt-driven | Single-run | None | 3,339 |
| **AutoAgent (kevinrgu)** | Repo template | Python | Any (meta-agent) | Prompt-driven | Single-run (Harbor) | Docker isolation | 3,769 |
