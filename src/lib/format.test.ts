import { describe, expect, test } from "bun:test"
import { allocateColumnWidths, formatCell, padRight, truncate } from "./format.ts"

describe("format helpers", () => {
  test("handles zero and one character widths", () => {
    expect(padRight("abc", 0)).toBe("")
    expect(truncate("abc", 0)).toBe("")
    expect(truncate("abc", 1)).toBe("…")
    expect(formatCell("abc", 0)).toBe("")
  })

  test("shrinks columns to available width", () => {
    expect(allocateColumnWidths(12, [
      { ideal: 4, min: 2 },
      { ideal: 9, min: 0 },
      { ideal: 12, min: 0 },
    ])).toEqual([4, 8, 0])
  })

  test("preserves ideal widths when they fit", () => {
    expect(allocateColumnWidths(8, [
      { ideal: 2 },
      { ideal: 3 },
    ])).toEqual([2, 3])
  })

  test("does not grow columns when min exceeds ideal", () => {
    expect(allocateColumnWidths(0, [
      { ideal: 1, min: 4 },
    ])).toEqual([0])
  })
})
