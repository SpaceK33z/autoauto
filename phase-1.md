# Phase 1: Setup (MVP)

High-level tasks to complete the interactive setup flow described in [IDEA.md](./IDEA.md#phase-1-setup-mvp).

## 1a. Chat Foundation

- [x] Multi-turn conversation with message history in Chat component
- [x] Scroll through conversation, auto-scroll on new messages
- [x] Pass conversation history to Claude Agent SDK across turns

## 1b. Setup Agent

- [x] Setup Agent system prompt (inspect repo, ask what to optimize, define scope, generate artifacts)
- [x] Agent tools: read files, list directories, run shell commands (to inspect the target repo)
- [x] Ideation mode: agent analyzes codebase and suggests optimization targets

## 1c. Program Generation

- [x] Agent generates `program.md` (goal, scope, rules, steps)
- [x] Agent generates `measure.sh` (measurement script tailored to repo)
- [x] Agent generates `config.json` (metric field, direction, noise threshold, repeats, quality gates)
- [x] Save generated files to `.autoauto/programs/<name>/`
- [x] User review & confirm step before saving

## 1d. Measurement Validation

- [x] Run `measure.sh` multiple times after generation
- [x] Check variance, warn if measurements are unreliable
- [x] Iterate with agent until measurement is stable
- [x] Guide user on noise threshold and repeats based on observed variance

## 1e. Model Configuration

- [x] Configure execution model slot (Sonnet/Opus + throughput tier)
- [x] Configure support model slot (Sonnet/Opus + throughput tier)
- [x] Auth (slightly unrelated but basic): Check for `ANTHROPIC_API_KEY` on startup
- [x] Auth: Prompt user to run `claude setup-token` if missing (but only if not authenticated! for me i didnt appear to have to set ANTHROPIC_API_KEY manually)
