/** Pad a string to a fixed width, truncating if too long. */
export function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length)
}

/** Truncate a string with an ellipsis if it exceeds maxLen. */
export function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str
}
