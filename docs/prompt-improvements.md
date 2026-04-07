# Prompt Improvements

Future improvements to agent system prompts (`src/lib/system-prompts.ts`), based on research into best practices from Anthropic, Augment Code, Cursor, Ralphify, and cognitive-architecture-labs.

## Current State

Prompts are well above average. The Experiment Agent is particularly strong — constraint-heavy, clear exit conditions, avoids over-prescription. Setup Agent has excellent heuristics. Finalize Agent has clean structured output.

## Improvements

### 1. Setup Agent: progressive disclosure (prompt length)

The Setup Agent is ~388 lines with everything upfront: artifact formats, CV% tables, noise causes, autoresearch expertise. The agent doesn't need the CV% interpretation table at conversation start, or saving instructions until step 9.

**Fix:** Move reference material (artifact formats, CV% tables, noise causes, autoresearch expertise) into a file the agent reads when it reaches that step. Or at minimum, move reference sections to the bottom — models pay most attention to beginning and end of prompts.

Source: Anthropic context engineering blog ("find the smallest possible set of high-signal tokens"), Augment technique #10 (attention priority: beginning > end > middle).

### 2. Experiment Agent: add environment context

The agent knows it's "one experiment in an autonomous optimization loop" but doesn't know what tools it has, that it's in a worktree, where results.tsv is, or what the orchestrator does after it finishes.

**Fix:** Add a brief Environment section:
```
## Environment
- You are running in a git worktree (isolated copy of the repo)
- Tools available: Read, Write, Edit, Bash, Glob, Grep
- results.tsv is in the program directory — read it to see past experiments
- After you finish, the orchestrator will: run measure.sh, compare to baseline, keep or discard your commit
```

Source: Augment technique #2 ("present a complete picture of the world"), Anthropic ("if a human cannot follow the instructions, neither can the agent").

### 3. All agents: add thinking/reflection guidance

Prompts say *what* to do but don't guide *how to reason*. Anthropic and cognitive-architecture-labs both emphasize guiding the thinking process explicitly.

**Fix (Experiment Agent example):**
```
Before making any changes, use your thinking to:
1. Identify the hot path or bottleneck
2. Form a hypothesis about why your change will improve the metric
3. Estimate the expected improvement magnitude
If you can't articulate a clear mechanism, pick a different approach.
```

**Fix (Finalize Agent):**
```
Before grouping, think through:
1. Which commits are logically related (same optimization mechanism)?
2. Which files have cross-dependencies (changing one without the other would break things)?
3. Could each proposed group be cherry-picked independently without breaking the build?
```

Source: Anthropic ("after receiving tool results, carefully reflect on their quality"), cognitive-architecture-labs principle #3 ("guide the thinking process").

### 4. Experiment Agent: strengthen history reflection

The #1 waste in autoresearch loops is repeating discarded approaches. The prompt says "don't repeat discarded ideas" but doesn't force the agent to think through *why* each was discarded before planning.

**Fix:** Strengthen "Analyze Before Acting":
```
### 1. Analyze Before Acting
- Read results.tsv first. Before reading any source code, study the experiment history.
- For each recent discard, understand the MECHANISM that failed — not just that it was discarded.
- In your thinking, list 2-3 approaches that are clearly ruled out by the history.
- Only then read the source code within scope to find opportunities the history hasn't covered.
```

Source: Anthropic context engineering blog (structured note-taking), Ralphify (self-healing feedback loops).

### 5. Setup Agent: add resource budget for inspection

No guidance on how many tool calls to make during codebase inspection. Risk: during ideation "deep inspection", the agent reads every file.

**Fix:** Add a heuristic: "For initial codebase inspection, read the key config files (package.json, etc.), check the directory structure, and skim 2-3 representative source files. Don't read every file — get enough context to ask informed questions, then let the user guide deeper exploration."

Source: cognitive-architecture-labs ("dynamic resource budgeting"), Anthropic ("stopping criteria" heuristics).

### 6. Experiment Agent: safer commit staging

Currently says `git add -A` which could stage unintended files.

**Fix:** Change to `git add <specific files>` or add "only stage files you modified within scope."

Source: Anthropic's Claude Code prompt ("prefer adding specific files by name rather than using git add -A").

### 7. Experiment Agent: anti-over-engineering heuristic

Anthropic notes Opus 4.6 can over-engineer. The "keep diffs small" instruction is good but could be more explicit.

**Fix:**
```
- Prefer the simplest change that moves the metric. Do not refactor surrounding code.
- If your change requires more than 50 lines of diff, reconsider whether it's truly ONE mechanism.
```

Source: Anthropic ("avoid over-engineering — only make changes that are directly requested or clearly necessary").

## Research Sources

- [Anthropic: Prompting Best Practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Anthropic: Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Augment Code: 11 Prompting Techniques for Better AI Agents](https://augmentcode.com/blog/how-to-build-your-agent-11-prompting-techniques-for-better-ai-agents)
- [Cognitive Architecture Labs: Complete Engineering Guide to Prompting for Agents](https://cognitive-architecture-labs.ghost.io/the-complete-engineering-guide-to-prompting-for-agents/)
- [Cursor: Best Practices for Coding with Agents](https://cursor.com/blog/agent-best-practices)
- [Ralphify: Writing Prompts for Autonomous AI Coding Agents](https://ralphify.co/docs/writing-prompts/)
- [Agentailor: The Art of Agent Prompting (Anthropic's Playbook)](https://blog.agentailor.com/blog/the-art-of-agent-prompting)
