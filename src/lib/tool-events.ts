import { basename } from "node:path"

function formatFileToolEvent(verb: string, input: Record<string, unknown>): string {
  const filePath = input.file_path
  if (typeof filePath === "string") {
    return `${verb} ${basename(filePath)}`
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
      if (typeof pattern === "string") {
        return `Grep: ${pattern}`
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
          command.length > 60 ? `${command.slice(0, 57)}...` : command
        return `Running: ${truncated}`
      }
      return "Running command..."
    }
    default:
      return `Using ${toolName}...`
  }
}
