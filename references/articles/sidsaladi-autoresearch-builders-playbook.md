# Autoresearch 101 Builder's Playbook: Make Your AI Skills, Prompts, and Agents Improve Themselves Overnight

- **Author:** Sid Saladi
- **Published:** 2026-03-22
- **URL:** https://sidsaladi.substack.com/p/autoresearch-101-builders-playbook
- **Note:** Partially paywalled — Phases 3-5 (building the loop, running it, analyzing results) not available

---

Karpathy pushed 630 lines of Python to GitHub and went to sleep. By morning, his AI agent had run 50 experiments and found improvements he'd missed for months.

The tech world covered the ML angle. They missed the bigger story. The pattern underneath works on **anything you can measure** — your Claude skills, your system prompts, your agent workflows, your content templates. I've spent two weeks pulling this apart and building the loop into my own workflows. This playbook shows you how to make everything you build with AI get better while you sleep.

No GPU required. No ML knowledge needed. Just a coding agent and 20 minutes of setup.

## What You'll Build

By the end of this playbook, you'll have a **self-improving AI system** that:

- Takes any skill, prompt, or agent workflow you've already built
- Defines what "good output" looks like with binary yes/no tests
- Runs 50–100 improvement cycles overnight without your involvement
- Keeps changes that score better, discards everything else
- Hands you a measurably better version by morning

The total investment: $5–25 in API costs and one evening of setup.

I'm running this in Claude Code, but Cursor, Windsurf, OpenAI Codex, and Antigravity all work. Any coding agent that can read files, edit files, and use git.

## The Core Idea (2 Minutes to Understand)

Andrej Karpathy — former Tesla AI lead, OpenAI co-founder, and the person who coined "vibe coding" — released [autoresearch](https://github.com/karpathy/autoresearch) in early March. It hit 42,000 GitHub stars in its first week. Fortune called the underlying method "The Karpathy Loop."

Here's what the loop actually does:

1. **Read** the current version of a file
2. **Change** one thing about it
3. **Test** it against a fixed scoring rubric
4. **Keep** if the score went up — **discard** if it didn't
5. **Repeat** forever

That's it. That's the whole pattern.

Karpathy ran it on ML training code and found 20 improvements he'd missed after months of manual optimization. All 20 stacked together for an 11% speedup.

Shopify CEO Tobi Lütke ran it overnight on Liquid — the template engine that powers every single Shopify store, a codebase he originally created 20 years ago. The agent ran 120 automated experiments, produced 93 commits, and delivered **53% faster rendering with 61% fewer memory allocations**. All 974 unit tests still passed.

But here's the thing everyone keeps overlooking. **The loop has nothing to do with ML.** The pattern works on any output where three conditions hold:

1. You can score it with a number. Not a vibe check. Binary yes/no questions that produce a percentage.
2. The scoring runs without a human. An eval script generates outputs, grades them, prints the score.
3. Only one file changes per round. Your prompt, your skill, your template. Everything else is locked.

All three true? The loop works. Any one missing? It won't. That's the entire filter.

Your job is choosing what "better" means and writing the yes/no questions that define it. The agent handles the 100 rounds of iteration you were never going to do manually.

## What You'll Need

Before we start building, here's your toolkit:

- A coding agent — Claude Code (preferred), Cursor, Windsurf, or Codex

**Cost estimate:** At ~18,000 tokens per cycle and ~$0.10 per cycle, a 50-round overnight run costs roughly $5. A 100-round deep run costs $10–25 depending on the model.

That's it. Let's build.

## Phase 1: Pick Your Target (10 Minutes)

Start with **the thing that frustrates you most.** The prompt you re-run 3 times before getting usable output. The skill file that works great on your favorite use case but fails on edge cases. The agent workflow that occasionally goes off the rails.

Here are five categories worth targeting, ranked by how quickly you'll see results:

### Category 1: Claude Skills (SKILL.md Files)

This is the killer app for autoresearch. Skills are pure text instructions that control agent behavior. They're the perfect optimization target because they're a single file, the output is measurable, and small changes compound fast.

A developer named Udit Goenka built a generalized [Claude Code autoresearch skill](https://github.com/uditgoenka/autoresearch) that does exactly this — it hit 608 GitHub stars in 3 days. The Loooom skill marketplace is already exploring autonomous skill improvement where one agent optimizes the instructions that other agents follow. Meta.

**Best first target:** The skill you use most often that has the most inconsistent output quality.

### Category 2: System Prompts

Every AI workflow starts with a system prompt. Most of them are written once and never tested. The autoresearch loop can optimize system prompts for specificity, formatting compliance, error handling, and output consistency.

**Best first target:** A system prompt that produces outputs needing manual edits more than 30% of the time.

### Category 3: Content Templates

Newsletter templates, email sequences, landing page copy, social posts. Anything where you have a template that generates content and you know what "good" looks like.

**Best first target:** The template where you spend the most time editing the AI-generated output before publishing.

### Category 4: Agent Workflows

Multi-step agent configs where the agent calls tools, processes data, and produces a deliverable. The loop can optimize tool-calling sequences, error recovery behavior, and output quality.

**Best first target:** An agent workflow that fails or produces bad output more than 20% of the time.

### Category 5: Eval Criteria Themselves

This is the meta play. Once you have a working autoresearch loop, you can use a *second* loop to optimize the eval criteria of the first loop. Agents improving the instructions that measure other agents. We're living in the future.

**Best first target:** Save this for after you've run your first loop successfully.

## Phase 2: Write Your Eval Criteria (The Hard Part — 20 Minutes)

This is where 90% of people succeed or fail. The eval criteria are **the most important thing you'll write.** They define what "better" means. Get them right and the loop does the rest. Get them wrong and the agent optimizes for garbage.

### The Rules

**Every criterion must be binary.** Yes or no. Pass or fail. No sliding scales. The moment you introduce a 1–7 rating, the agent starts producing outputs that technically score a 5 but read like garbage.

**3 to 6 criteria is the sweet spot.** Below 3 and the agent finds loopholes. Above 6 and it starts gaming the checklist instead of improving real quality.

**If you can't explain how to score it in one sentence, rewrite it.** A stranger should be able to grade your outputs without any additional context.

### Copy-Paste Eval Templates

Here are ready-to-use eval criteria for each category. Pick the one that matches your target and customize it.

#### For Skills (SKILL.md Optimization)

```
EVAL CRITERIA:
1. Does the skill output include specific, actionable steps (not vague advice)?
2. Is the output formatted exactly as specified in the skill instructions?
3. Does the output handle the edge case of [YOUR MOST COMMON FAILURE MODE]?
4. Is every section of the output present and non-empty?
5. Would a first-time user be able to follow the output without additional context?
```

#### For System Prompts

```
EVAL CRITERIA:
1. Does the output follow the exact structure defined in the system prompt?
2. Is the output free of hallucinated information or fabricated examples?
3. Does the output stay within the specified word/length constraints?
4. Does the response address the user's specific request (not a generic version)?
5. Is the tone consistent with the defined persona throughout?
```

## Paywalled Sections (not available)

- Eval templates for content templates and agent workflows
- Phase 3: Build the loop
- Phase 4: Run it overnight
- Phase 5: Analyze results
