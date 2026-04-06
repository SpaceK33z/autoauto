#!/usr/bin/env python3
"""Filter agent JSONL streams into a compact progress view.

Supports both Claude Code (--output-format stream-json) and Codex (--json).
Reads JSON lines from stdin, prints a one-line activity indicator for each
meaningful event to stderr. Passes through final result text to stdout.

Usage:
    claude -p "..." --output-format stream-json | python3 scripts/autoresearch-progress.py
    codex exec --json ... | python3 scripts/autoresearch-progress.py
"""

import json
import sys
import time

# ANSI colors
DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
RESET = "\033[0m"

start_time = time.time()
tool_count = 0
turn_count = 0
last_tool = ""
final_text_parts: list[str] = []
total_input_tokens = 0
total_output_tokens = 0


def elapsed() -> str:
    secs = int(time.time() - start_time)
    mins, secs = divmod(secs, 60)
    return f"{mins:02d}:{secs:02d}"


def truncate(s: str, max_len: int = 80) -> str:
    s = s.replace("\n", " ").strip()
    if len(s) > max_len:
        return s[: max_len - 1] + "\u2026"
    return s


def print_progress(icon: str, color: str, message: str) -> None:
    print(f"{DIM}[{elapsed()}]{RESET} {color}{icon}{RESET} {message}", file=sys.stderr)
    sys.stderr.flush()


def tool_summary(name: str, input_data: dict) -> str:
    """One-line summary of a tool call."""
    if name == "Read":
        path = input_data.get("file_path", "?")
        return f"Read {path}"
    if name == "Write":
        path = input_data.get("file_path", "?")
        return f"Write {path}"
    if name == "Edit":
        path = input_data.get("file_path", "?")
        old = input_data.get("old_string", "")
        return f"Edit {path} ({len(old.splitlines())} lines)"
    if name == "Bash":
        cmd = input_data.get("command", "?")
        return f"$ {truncate(cmd, 70)}"
    if name == "Grep":
        pattern = input_data.get("pattern", "?")
        path = input_data.get("path", ".")
        return f"Grep '{truncate(pattern, 40)}' in {path}"
    if name == "Glob":
        pattern = input_data.get("pattern", "?")
        return f"Glob {pattern}"
    if name == "Skill":
        skill = input_data.get("skill", "?")
        return f"Skill /{skill}"
    return f"{name}({truncate(json.dumps(input_data), 60)})"


# ── Claude Code event handlers ──────────────────────────────────────────────


def handle_claude_assistant(event: dict) -> None:
    global turn_count, tool_count, last_tool
    turn_count += 1
    message = event.get("message", {})
    content = message.get("content", [])
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type", "")
        if btype == "thinking":
            text = block.get("thinking", "")
            if text:
                print_progress("\u2699", DIM, f"thinking: {truncate(text, 70)}")
        elif btype == "text":
            text = block.get("text", "")
            if text:
                final_text_parts.append(text)
                print_progress("\u270e", CYAN, truncate(text, 80))
        elif btype == "tool_use":
            tool_count += 1
            name = block.get("name", "?")
            inp = block.get("input", {})
            last_tool = name
            print_progress("\u25b6", YELLOW, tool_summary(name, inp))


def handle_claude_result(event: dict) -> None:
    subtype = event.get("subtype", "")
    if subtype == "tool_result":
        content = event.get("content", "")
        _show_tool_result(content)
    elif subtype == "success":
        cost = event.get("cost_usd", 0)
        print_progress(
            "\u2713",
            GREEN,
            f"Done in {elapsed()} | {turn_count} turns, {tool_count} tools | ${cost:.3f}",
        )


# ── Codex event handlers ────────────────────────────────────────────────────


def handle_codex_item_started(event: dict) -> None:
    global tool_count, last_tool
    item = event.get("item", {})
    itype = item.get("type", "")
    if itype == "command_execution":
        tool_count += 1
        cmd = item.get("command", "?")
        last_tool = "shell"
        print_progress("\u25b6", YELLOW, f"$ {truncate(cmd, 70)}")


def handle_codex_item_completed(event: dict) -> None:
    global turn_count
    item = event.get("item", {})
    itype = item.get("type", "")
    if itype == "agent_message":
        turn_count += 1
        text = item.get("text", "")
        if text:
            final_text_parts.append(text)
            print_progress("\u270e", CYAN, truncate(text, 80))
    elif itype == "command_execution":
        cmd = item.get("command", "?")
        exit_code = item.get("exit_code")
        output = item.get("aggregated_output", "")
        if exit_code is not None and exit_code != 0:
            print_progress("\u2716", RED, f"$ {truncate(cmd, 50)} (exit {exit_code})")
        elif "error" in output.lower() or "fail" in output.lower():
            print_progress("\u2716", RED, f"shell: {truncate(output, 70)}")
        else:
            lines = output.count("\n") + 1 if output else 0
            print_progress("\u2714", GREEN, f"shell: {lines} lines")


def handle_codex_turn_completed(event: dict) -> None:
    global total_input_tokens, total_output_tokens
    usage = event.get("usage", {})
    total_input_tokens += usage.get("input_tokens", 0)
    total_output_tokens += usage.get("output_tokens", 0)


# ── Shared helpers ───────────────────────────────────────────────────────────


def _show_tool_result(content) -> None:
    if isinstance(content, str):
        if "error" in content.lower() or "fail" in content.lower():
            print_progress("\u2716", RED, f"{last_tool}: {truncate(content, 70)}")
        elif len(content) < 200:
            print_progress("\u2714", GREEN, f"{last_tool}: {truncate(content, 70)}")
        else:
            lines = content.count("\n") + 1
            print_progress("\u2714", GREEN, f"{last_tool}: {lines} lines")
    elif isinstance(content, list):
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        combined = " ".join(text_parts)
        if "error" in combined.lower() or "fail" in combined.lower():
            print_progress("\u2716", RED, f"{last_tool}: {truncate(combined, 70)}")
        elif len(combined) < 200:
            print_progress("\u2714", GREEN, f"{last_tool}: {truncate(combined, 70)}")
        else:
            lines = combined.count("\n") + 1
            print_progress("\u2714", GREEN, f"{last_tool}: {lines} lines")


# ── Main loop ────────────────────────────────────────────────────────────────

agent_type = None  # auto-detected from first event

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue

    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue

    etype = event.get("type", "")

    # Auto-detect agent type from first event
    if agent_type is None:
        if etype in ("assistant", "result", "error"):
            agent_type = "claude"
        elif etype in ("thread.started", "turn.started", "turn.completed",
                        "item.started", "item.completed"):
            agent_type = "codex"
            if etype == "thread.started":
                thread_id = event.get("thread_id", "")
                print_progress("\u25cb", DIM, f"codex session {thread_id[:12]}...")
                continue

    if agent_type == "claude":
        if etype == "assistant":
            handle_claude_assistant(event)
        elif etype == "result":
            handle_claude_result(event)
        elif etype == "error":
            error = event.get("error", {})
            msg = error.get("message", str(error))
            print_progress("\u2716", RED, f"ERROR: {truncate(msg, 70)}")

    elif agent_type == "codex":
        if etype == "item.started":
            handle_codex_item_started(event)
        elif etype == "item.completed":
            handle_codex_item_completed(event)
        elif etype == "turn.completed":
            handle_codex_turn_completed(event)

# Print summary for codex (claude gets it from the "success" result event)
if agent_type == "codex":
    tokens = total_input_tokens + total_output_tokens
    print_progress(
        "\u2713",
        GREEN,
        f"Done in {elapsed()} | {turn_count} turns, {tool_count} tools | {tokens:,} tokens",
    )

# Print final assistant text to stdout (for any downstream consumers)
if final_text_parts:
    print("\n".join(final_text_parts))
