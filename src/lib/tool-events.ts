import { basename } from "node:path"

/** Format a tool call into a brief human-readable status string */
export function formatToolEvent(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case "Read": {
      const filePath = input.file_path
      if (typeof filePath === "string") {
        const fileName = basename(filePath)
        return `Reading ${fileName}`
      }
      return "Reading file..."
    }
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
        const truncated =
          command.length > 60 ? `${command.slice(0, 57)}...` : command
        return `Running: ${truncated}`
      }
      return "Running command..."
    }
    case "Write": {
      const filePath = input.file_path
      if (typeof filePath === "string") {
        const fileName = basename(filePath)
        return `Writing ${fileName}`
      }
      return "Writing file..."
    }
    case "Edit": {
      const filePath = input.file_path
      if (typeof filePath === "string") {
        const fileName = basename(filePath)
        return `Editing ${fileName}`
      }
      return "Editing file..."
    }
    default:
      return `Using ${toolName}...`
  }
}
