import { SyntaxStyle } from "@opentui/core"
import type { ThemeTokenStyle } from "@opentui/core"

const theme: ThemeTokenStyle[] = [
  // Base text
  { scope: ["default"], style: { foreground: "#a9b1d6" } },

  // Keywords & control flow
  { scope: ["keyword"], style: { foreground: "#bb9af7", bold: true } },
  { scope: ["operator"], style: { foreground: "#89ddff" } },

  // Literals
  { scope: ["string"], style: { foreground: "#9ece6a" } },
  { scope: ["number"], style: { foreground: "#ff9e64" } },
  { scope: ["constant"], style: { foreground: "#ff9e64" } },

  // Functions & types
  { scope: ["function"], style: { foreground: "#7aa2f7" } },
  { scope: ["type"], style: { foreground: "#2ac3de" } },

  // Comments
  { scope: ["comment"], style: { foreground: "#565f89", italic: true } },

  // Variables & properties
  { scope: ["variable"], style: { foreground: "#c0caf5" } },
  { scope: ["property"], style: { foreground: "#73daca" } },
  { scope: ["punctuation"], style: { foreground: "#89ddff" } },
  { scope: ["tag"], style: { foreground: "#f7768e" } },

  // Markdown-specific
  { scope: ["markup.heading"], style: { foreground: "#7aa2f7", bold: true } },
  { scope: ["markup.italic"], style: { italic: true } },
  { scope: ["markup.bold"], style: { bold: true } },
  { scope: ["markup.link"], style: { foreground: "#7aa2f7", underline: true } },
  { scope: ["markup.raw"], style: { foreground: "#9ece6a" } },
  { scope: ["markup.list"], style: { foreground: "#ff7b72" } },
]

export const syntaxStyle = SyntaxStyle.fromTheme(theme)
