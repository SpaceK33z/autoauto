/**
 * Centralized color palette for the AutoAuto TUI.
 * Tokyo Night inspired. Import `colors` and use semantic names
 * instead of inline hex values.
 */

export const colors = {
  // Semantic status
  primary: "#7aa2f7",
  success: "#9ece6a",
  error: "#ff5555",
  warning: "#e0af68",
  info: "#73daca",
  orange: "#ff9e64",

  // Text
  text: "#ffffff",
  textMuted: "#888888",
  textDim: "#666666",
  textDimmer: "#555555",

  // Surfaces
  surface: "#1a1b26",
  surfaceAlt: "#1a1a2e",
  surfaceSelected: "#333333",
  surfaceHighlight: "#292e42",
  surfaceActiveSelection: "#3d59a1",

  // Borders
  borderActive: "#7aa2f7",
  borderDim: "#666666",
  borderDanger: "#ff5555",
} as const
