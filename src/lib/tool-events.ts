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

/** Format a tool call into a brief human-readable status string */
export function formatToolEvent(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case "Read":
      return formatFileToolEvent("Reading", input)
    case "Write":
      return formatFileToolEvent("Writing", input)
    case "Edit":
      return formatFileToolEvent("Editing", input)
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
    default:
      return `Using ${toolName}...`
  }
}
