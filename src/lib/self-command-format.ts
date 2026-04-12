import { getSelfCommand } from "./self-command.ts"

function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`
}

export function formatSelfCommand(subcommand: string): string {
  const command = getSelfCommand(subcommand)
  return [command.command, ...command.args].map(shellQuote).join(" ")
}
