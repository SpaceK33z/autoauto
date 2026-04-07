# Phase 3: Cleanup

High-level tasks to complete the review and packaging flow described in [IDEA.md](./IDEA.md#phase-3-cleanup).

## 3a. Cleanup Agent

- [ ] Cleanup Agent system prompt (review accumulated diff, flag risks, produce summary)
- [ ] Feed agent the full diff from baseline to branch tip
- [ ] Agent tools: read files, bash (git log, git diff, git show)

## 3b. Commit Squashing

- [ ] Squash all kept experiment commits into clean commit(s)
- [ ] Produce commits ready for PR

## 3c. Summary Report

- [ ] Generate `summary.md` per run with:
  - Total experiments, keeps, discards
  - Metric improvement timeline
  - Description of each kept change
  - Callouts for risky or user-facing changes
- [ ] Save to run directory (`.autoauto/programs/<name>/runs/<timestamp>/summary.md`)

## 3d. Manual Review Flags

- [ ] Flag changes that warrant manual review (e.g. user-facing behavior changes, security-sensitive edits)
- [ ] Surface flagged items in the TUI for user attention

## 3e. TUI Flow

- [ ] "Run Complete" screen prompts: run cleanup or abandon
- [ ] Display cleanup progress (agent thinking)
- [ ] Show summary report in TUI after cleanup finishes
