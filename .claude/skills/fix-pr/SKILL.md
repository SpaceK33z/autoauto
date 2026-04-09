---
name: fix-pr
description: Fix CI failures and implement CodeRabbit feedback on the current PR
disable-model-invocation: true
allowed-tools: Bash(gh *) Bash(git *) Bash(bun *)
---

# Fix PR

You are iterating on a pull request until CI is green and CodeRabbit is satisfied.
The current branch is already pushed and a PR exists.

## PR context

- PR info: !`gh pr view --json number,title,url,headRefName,statusCheckRollup 2>/dev/null || echo "No PR found on current branch"`
- CI status: !`gh pr checks 2>/dev/null || echo "No checks found"`

## Step 1: Fix CI failures

1. Run `gh pr checks` to see check status.
2. If any checks failed, inspect the failing logs with `gh run view <run-id> --log-failed`.
3. Fix the issues, run `bun lint && bun typecheck` locally to verify.
4. Commit the fixes (conventional commits) and push.
5. Wait for CI to pass by polling `gh pr checks` (sleep 30s between polls, max 10 min).
6. If CI still fails, repeat from step 2.

## Step 2: Wait for CodeRabbit review (round 1)

1. Poll for a CodeRabbit review using `gh pr view --json reviews` — look for a review from `coderabbitai[bot]`.
2. Also check for CodeRabbit review comments with `gh api repos/{owner}/{repo}/pulls/{number}/comments` and filter for user login `coderabbitai[bot]`.
3. Sleep 30s between polls, max 15 min total.

## Step 3: Implement CodeRabbit feedback

1. Read all CodeRabbit comments carefully.
2. For each piece of feedback, decide whether you agree:
   - **Agree**: implement the change.
   - **Disagree**: leave a reply explaining why you disagree.
   - **Nitpick/style-only with no clear improvement**: skip silently.
3. After addressing all feedback, run `bun lint && bun typecheck`.
4. Commit (conventional commits) and push.

## Step 4: Wait for CI + CodeRabbit (round 2)

1. Wait for CI to pass (same polling as step 1).
2. Fix any new CI failures.
3. Wait for CodeRabbit's second review (same polling as step 2, max 15 min).
4. Read the new comments. If there are actionable items, implement them, commit, and push.
5. Report a summary of what was done.

## Rules

- Use `gh api` for fetching PR comments/reviews when `gh pr view` doesn't give enough detail.
- Always run `bun lint && bun typecheck` before committing.
- Keep commits small and focused — one commit per logical fix.
- Never force-push.
- When sleeping/polling, tell the user what you're waiting for.
