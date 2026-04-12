import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SOURCE_ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), "..", "index.tsx")

export function getSelfCommand(subcommand: string): { command: string; args: string[] } {
  const execPath = process.execPath
  if (basename(execPath).toLowerCase() === "bun") {
    return { command: execPath, args: [SOURCE_ENTRYPOINT, subcommand] }
  }
  return { command: execPath, args: [subcommand] }
}
