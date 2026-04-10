/** Pad a string to a fixed width, truncating if too long. */
export function padRight(str: string, width: number): string {
  if (width <= 0) return ""
  return str.length >= width ? str.slice(0, width) : str + " ".repeat(width - str.length)
}

function stripAnsi(str: string): string {
  let out = ""

  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 0x1b && str[i + 1] === "[") {
      i += 2
      while (i < str.length) {
        const code = str.charCodeAt(i)
        if (code >= 0x40 && code <= 0x7e) break
        i++
      }
      continue
    }

    out += str[i]
  }

  return out
}

function sanitizeInlineText(str: string): string {
  return stripAnsi(str)
    .replace(/[\r\n\t]+/g, " ")
}

/** Truncate a string with an ellipsis if it exceeds maxLen. */
export function truncate(str: string, maxLen: number): string {
  if (maxLen <= 0) return ""
  if (maxLen === 1) return str.length > 1 ? "…" : str
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str
}

export interface ColumnSpec {
  ideal: number
  min?: number
}

export function allocateColumnWidths(available: number, specs: ColumnSpec[]): number[] {
  const target = Math.max(available, 0)
  const widths = specs.map((spec) => Math.max(spec.ideal, 0))
  let overflow = widths.reduce((sum, width) => sum + width, 0) - target

  if (overflow <= 0) return widths

  for (let i = widths.length - 1; i >= 0 && overflow > 0; i--) {
    const min = Math.max(specs[i].min ?? 0, 0)
    const shrink = Math.min(Math.max(widths[i] - min, 0), overflow)
    widths[i] -= shrink
    overflow -= shrink
  }

  for (let i = widths.length - 1; i >= 0 && overflow > 0; i--) {
    const shrink = Math.min(widths[i], overflow)
    widths[i] -= shrink
    overflow -= shrink
  }

  return widths
}

export function formatCell(str: string, width: number): string {
  return padRight(truncate(sanitizeInlineText(str), width), width)
}

export function truncateStreamText(prev: string, text: string): string {
  const next = prev + text
  return next.length > 8000 ? next.slice(-6000) : next
}
