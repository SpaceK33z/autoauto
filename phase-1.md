# Phase 1: Setup (MVP)

High-level tasks to complete the interactive setup flow described in [IDEA.md](./IDEA.md#phase-1-setup-mvp).

## 1a. Chat Foundation

- [x] Multi-turn conversation with message history in Chat component
- [x] Scroll through conversation, auto-scroll on new messages
- [x] Pass conversation history to Claude Agent SDK across turns

## 1b. Setup Agent

- [ ] Setup Agent system prompt (inspect repo, ask what to optimize, define scope, generate artifacts)
- [ ] Agent tools: read files, list directories, run shell commands (to inspect the target repo)
- [ ] Ideation mode: agent analyzes codebase and suggests optimization targets

## 1c. Program Generation

- [ ] Agent generates `program.md` (goal, scope, rules, steps)
- [ ] Agent generates `measure.sh` (measurement script tailored to repo)
- [ ] Agent generates `config.json` (metric field, direction, noise threshold, repeats, quality gates)
- [ ] Save generated files to `.autoauto/programs/<name>/`
- [ ] User review & confirm step before saving

## 1d. Measurement Validation

- [ ] Run `measure.sh` multiple times after generation
- [ ] Check variance, warn if measurements are unreliable
- [ ] Iterate with agent until measurement is stable
- [ ] Guide user on noise threshold and repeats based on observed variance

## 1e. Model Configuration

- [ ] Configure execution model slot (Sonnet/Opus + throughput tier)
- [ ] Configure support model slot (Sonnet/Opus + throughput tier)
- [ ] Auth (slightly unrelated but basic): Check for `ANTHROPIC_API_KEY` on startup
- [ ] Auth: Prompt user to run `claude setup-token` if missing (but only if not authenticated! for me i didnt appear to have to set ANTHROPIC_API_KEY manually)
