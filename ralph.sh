#!/bin/bash
set -e

# Kill all child processes on exit (Ctrl+C, SIGTERM, etc.)
set -m  # Enable job control so this script is a process group leader
cleanup() {
    trap - SIGINT SIGTERM  # Prevent re-entry
    kill 0 2>/dev/null     # Kill entire process group (all children)
    wait 2>/dev/null
    exit 1
}
trap cleanup SIGINT SIGTERM EXIT

PLANS_DIR=".ralph"
DONE_FILE="$PLANS_DIR/completed-phases"

mkdir -p "$PLANS_DIR"
touch "$DONE_FILE"

notify_done() {
    local message="$1"
    if command -v osascript &> /dev/null; then
        osascript -e "display notification \"$message\" with title \"Ralph Complete\" sound name \"Glass\""
        afplay /System/Library/Sounds/Glass.aiff 2>/dev/null || true
    fi
}

process_plan() {
    local PLAN_FILE="$1"

    echo "============================================"
    echo "  Plan: $PLAN_FILE"
    echo "============================================"

    # Extract subsection IDs from plan file (e.g. 1a, 1b, 1c...)
    sections=($(grep -E '^## [0-9]+[a-z]\.' "$PLAN_FILE" | sed 's/^## \([0-9]*[a-z]*\)\..*/\1/'))

    if [ ${#sections[@]} -eq 0 ]; then
        echo "No sections found in $PLAN_FILE, skipping."
        return
    fi

    echo "Found sections: ${sections[*]}"
    echo ""

    for section in "${sections[@]}"; do
        echo "==========================================="
        echo "  Section $section"
        echo "==========================================="

        # Check if section has any unchecked tasks
        section_block=$(awk "/^## ${section}\./{found=1; next} /^## [0-9]/{if(found) exit} found" "$PLAN_FILE")

        if ! echo "$section_block" | grep -q '\- \[ \]'; then
            echo "Section $section: all tasks already done, skipping."
            echo ""
            continue
        fi

        plan_basename=$(basename "$PLAN_FILE" .md)
        plan_file="$PLANS_DIR/${plan_basename}-${section}.md"

        # Step 1: Generate implementation plan + review
        if [ ! -f "$plan_file" ]; then
            echo ">>> Planning section $section..."

            prompt="You are working on the AutoAuto project.

Read these files for context:
- IDEA.md (full project design)
- $PLAN_FILE (task plan — focus on section $section)
- CLAUDE.md (project conventions)
- src/ (current codebase)

Your job: create a detailed implementation plan for section **${section}** of $PLAN_FILE.

Analyze the codebase, understand the existing patterns, and write a step-by-step plan that another Claude session can follow to implement everything in section ${section}.

Use Exa search to look up API details, best practices, and current docs for any libraries/SDKs you'll be using (e.g. Claude Agent SDK, OpenTUI).
Read docs/ and references/articles/ for extra context on how and when to use autoresearch patterns.

The plan should include:
- Which files to create or modify
- What each file should contain (key types, functions, components)
- How it integrates with existing code
- Any dependencies or stubs needed
- Specific implementation details, not just restating the tasks
- Updates to CLAUDE.md (e.g. new commands, project structure changes, conventions)
- Updates to README.md (e.g. new features, usage instructions)
- New or updated docs in docs/ (e.g. architecture decisions, API docs, guides)

Write the plan to: $plan_file
Do NOT implement anything. Only write the plan."

            claude --verbose --output-format stream-json --dangerously-skip-permissions -p "$prompt" 2>&1

            # Step 1b: Review the plan and integrate feedback
            echo ""
            echo ">>> Reviewing plan for section $section..."

            review_prompt="You just wrote an implementation plan to $plan_file. Now review it as a critical expert.

Adopt this stance: You are now the CRITIC, not the planner. Do not rationalize. Your job is to find what's missing, what will break, and what's wishful thinking.

First, use web search to research best practices for the key technologies/approaches in the plan. Distill into 3-5 key principles.

Then review the plan against these 6 dimensions:
1. **Pre-mortem** — \"It's 3 months later and this plan failed. What were the top 3 causes?\"
2. **Completeness** — What's missing that a domain expert would expect?
3. **Feasibility** — Are there steps that depend on unconfirmed resources or approvals?
4. **Best-practice alignment** — How does this compare to the researched standards?
5. **Sequencing** — Are there hidden blockers? Would reordering reduce risk?
6. **Specificity** — Could someone unfamiliar execute each step without ambiguity?

Classify each finding as:
- **Red** — Critical. Will likely cause failure if unaddressed.
- **Yellow** — Important. Creates risk but plan can proceed.
- **Green** — Minor. Nice-to-have improvement.

If there are any Red or Yellow findings:
1. Print a summary of all findings.
2. Apply ALL Red and Yellow fixes directly to the plan file at $plan_file.
3. Mark changed sections with [CHANGED] and new sections with [NEW] so the next session can see what was revised.

If all findings are Green, print the summary but leave the plan file unchanged.

You MUST update $plan_file directly — do not just print recommendations."

            claude --verbose --output-format stream-json --dangerously-skip-permissions --continue -p "$review_prompt" 2>&1

            echo ""
        else
            echo "Plan already exists at $plan_file, skipping planning."
        fi

        # Step 2: Execute the plan
        echo ">>> Implementing section $section..."

        prompt="You are working on the AutoAuto project.

Read these files for context:
- IDEA.md (full project design)
- $PLAN_FILE (task plan)
- CLAUDE.md (project conventions)
- $plan_file (detailed implementation plan for this section)
- src/ (current codebase)

Your job: follow the implementation plan in $plan_file to implement section **${section}**.

ONLY work on section ${section}. Do not touch other sections.
If a task depends on something from a later section that doesn't exist yet, stub it minimally.

After implementing:
1. Run \`bun lint && bun typecheck\` and fix any issues.
2. Verify the TUI visually using tmux as described in CLAUDE.md under \"Testing the TUI Interactively\". Fix any rendering issues.
3. Commit all changes with a conventional commit message describing what you built.

CRITICAL — DO NOT SKIP: After committing, open $PLAN_FILE and mark every task you completed in section ${section} as done by changing \`- [ ]\` to \`- [x]\`. Then commit this change separately with: \`chore: mark phase ${section} tasks done\`. The automation loop depends on these checkboxes to skip completed sections — if you forget, the section will be re-run unnecessarily."

        claude --verbose --output-format stream-json --dangerously-skip-permissions -p "$prompt" 2>&1

        # Step 3: Simplify pass
        echo ""
        echo ">>> Simplify pass on section $section..."

        claude --verbose --output-format stream-json --dangerously-skip-permissions -p "/simplify look at the previous commit" 2>&1

        echo ""
        echo "Section $section done."
        echo ""
    done

    # Phase review: review all work done for this plan file and fix issues
    echo "==========================================="
    echo "  Review: $PLAN_FILE"
    echo "==========================================="

    prompt="You are working on the AutoAuto project.

Read these files for context:
- IDEA.md (full project design)
- $PLAN_FILE (task plan — all sections should now be done)
- CLAUDE.md (project conventions)
- src/ (current codebase)

All sections of $PLAN_FILE have been implemented by previous sessions.

Your job: do a thorough review of the work done.

1. Read through all the code that was added/changed for this phase.
2. Compare the implementation against IDEA.md — verify that the architecture, data model, file structure, and behavior match what's described there. Flag and fix any deviations.
3. Check for inconsistencies, bugs, missing edge cases, or integration issues between sections.
4. Run \`bun lint && bun typecheck\` and fix any issues.
5. Verify the TUI visually using tmux as described in CLAUDE.md under \"Testing the TUI Interactively\". Fix any rendering issues.
6. Implement any fixes needed.
7. If you made changes, commit with: \`fix: review fixes for $(basename "$PLAN_FILE" .md)\`"

    claude --verbose --output-format stream-json --dangerously-skip-permissions -p "$prompt" 2>&1

    echo ""
    echo "Plan $PLAN_FILE complete."
    echo ""

    # Mark this plan file as completed
    echo "$PLAN_FILE" >> "$DONE_FILE"
}

# Main loop: keep scanning for phase files
while true; do
    # Find all phase-*.md files, sorted naturally
    all_phases=($(ls phase-*.md 2>/dev/null | sort -V))

    if [ ${#all_phases[@]} -eq 0 ]; then
        echo "No phase-*.md files found."
        exit 1
    fi

    # Filter out already completed phases
    pending=()
    for phase in "${all_phases[@]}"; do
        if ! grep -qxF "$phase" "$DONE_FILE"; then
            pending+=("$phase")
        fi
    done

    if [ ${#pending[@]} -eq 0 ]; then
        echo "All phase files complete. Checking for new ones in 30s..."
        sleep 30
        continue
    fi

    # Process the next pending phase
    process_plan "${pending[0]}"

    # After completing a phase, loop back to rescan for new files
done
