function abbreviatePath(filePath: string): string {
  const parts = filePath.replace(/^\//, "").split("/")
  if (parts.length <= 3) return parts.join("/")
  return `…/${parts.slice(-3).join("/")}`
}

function formatFileToolEvent(verb: string, input: Record<string, unknown>): string {
  const filePath = input.file_path
  if (typeof filePath === "string") {
    // Multiple file changes (Codex file_change items)
    const changes = input.changes
    if (Array.isArray(changes) && changes.length > 1) {
      return `${verb} ${abbreviatePath(filePath)} (+${changes.length - 1} more)`
    }
    return `${verb} ${abbreviatePath(filePath)}`
  }
  return `${verb} file...`
}

/** Canonical tool name map (lowercase → switch key) */
const TOOL_ALIASES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  bash: "Bash",
  list: "List",
  apply_patch: "Edit",
  multiedit: "Edit",
  webfetch: "WebFetch",
  websearch: "WebSearch",
}

function canonicalToolName(toolName: string): string {
  return TOOL_ALIASES[toolName.toLowerCase()] ?? TOOL_ALIASES[toolName] ?? toolName
}

/** Format a tool call into a brief human-readable status string */
export function formatToolEvent(
  toolName: string,
  input: Record<string, unknown>
): string {
  // Provider-supplied title takes precedence (e.g. OpenCode state.title)
  const title = input.__title
  if (typeof title === "string" && title.trim()) return title

  const canonical = canonicalToolName(toolName)
  switch (canonical) {
    case "Read":
      return formatFileToolEvent("Reading", input)
    case "Write":
      return formatFileToolEvent("Writing", input)
    case "Edit":
      return formatFileToolEvent("Editing", input)
    case "List":
      return "Listing directory..."
    case "Glob": {
      const pattern = input.pattern
      if (typeof pattern === "string") {
        return `Searching for ${pattern}`
      }
      return "Searching files..."
    }
    case "Grep": {
      const pattern = input.pattern
      const path = input.path
      if (typeof pattern === "string") {
        const suffix = typeof path === "string" ? ` in ${abbreviatePath(path)}` : ""
        return `Grep: ${pattern}${suffix}`
      }
      return "Searching content..."
    }
    case "Bash": {
      const command = input.command
      if (typeof command === "string") {
        if (command.includes("validate-measurement")) {
          return "Validating measurement stability — this may take a minute"
        }
        if (command.includes("build.sh")) {
          return "Running build step"
        }
        if (command.includes("measure.sh")) {
          return "Running measurement"
        }
        const truncated =
          command.length > 80 ? `${command.slice(0, 77)}...` : command
        return `$ ${truncated}`
      }
      return "Running command..."
    }
    case "WebFetch":
      return "Fetching web content..."
    case "WebSearch":
      return "Searching the web..."
    default:
      return `Using ${toolName}...`
  }
}
