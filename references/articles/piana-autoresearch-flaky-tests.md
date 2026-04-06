# How I Used Autoresearch to Fix Gumroad's Flaky Tests in a Week

- **Author:** Gianfranco Piana
- **Published:** 2026-03-25
- **URL:** https://gianfrancopiana.com/blog/autoresearch-flaky-tests

## Summary

Gianfranco Piana used Gumroad's team AI assistant (Gumclaw, running on OpenClaw) to fix 13 flaky tests overnight via an autoresearch loop. 206 commits, 94 CI runs, 13 merged PRs — without writing a single line of test code.

### The System
Built `openclaw-autoresearch`, a plugin for OpenClaw ported from pi-autoresearch (by Tobi Lutke). The agent runs a measurement command, gets a baseline, makes a change, re-runs. Keeps improvements, logs failures with notes on what to try next. All state in plain files — crash recovery via `/autoresearch resume`.

### What the Agent Found
- Race conditions, timing issues, browser session corruption, test cleanup hooks leaking between tests
- **Best find was a real bug:** file ID remapping where A→B then B→C silently corrupted file references. The flake was just the symptom.
- One tax input field went through four different approaches before finding one that held across CI runs

### Key Lessons
- **Flaky tests are a perfect autoresearch target.** Binary metric (green/red), no ambiguity.
- **The ideas backlog is the killer feature.** Every failed experiment forces the agent to write down what it tried, preventing repeated mistakes.
- **It takes time:** 206 commits for 13 PRs. Proving a flake is fixed means enough CI runs to trust it's gone, not hiding.

### Novel Application
This is one of the first examples of applying autoresearch outside ML training — using it for software quality improvement with CI pass/fail as the metric.
