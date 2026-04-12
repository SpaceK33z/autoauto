import { describe, expect, test } from "bun:test"
import { allocateColumnWidths, formatCell, formatPValue, formatStatusWithP, padRight, truncate } from "./format.ts"

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

  test("sanitizes inline control sequences before truncating", () => {
    expect(formatCell("foo\tbar\nbaz", 11)).toBe("foo bar baz")
    expect(formatCell("\u001B[31mred\u001B[0m", 3)).toBe("red")
  })

  test("does not grow columns when min exceeds ideal", () => {
    expect(allocateColumnWidths(0, [
      { ideal: 1, min: 4 },
    ])).toEqual([0])
  })
})

describe("formatPValue", () => {
  test("formats normal p-values with p= prefix", () => {
    expect(formatPValue(0.05)).toBe("p=0.05")
    expect(formatPValue(0.10)).toBe("p=0.10")
    expect(formatPValue(0.50)).toBe("p=0.50")
  })

  test("uses exponential notation for small p-values", () => {
    expect(formatPValue(0.008)).toBe("p=8.0e-3")
    expect(formatPValue(0.001)).toBe("p=1.0e-3")
  })

  test("uses ≤ prefix when p is at minimum", () => {
    expect(formatPValue(0.10, true)).toBe("p≤0.10")
    expect(formatPValue(0.008, true)).toBe("p≤8.0e-3")
  })

  test("uses = prefix when isMinimum is false or undefined", () => {
    expect(formatPValue(0.10, false)).toBe("p=0.10")
    expect(formatPValue(0.10)).toBe("p=0.10")
  })
})

describe("formatStatusWithP", () => {
  test("appends p-value to status", () => {
    expect(formatStatusWithP("keep", 0.03)).toBe("keep p=0.03")
  })

  test("shows ≤ for minimum p-values", () => {
    expect(formatStatusWithP("keep", 0.10, true)).toBe("keep p≤0.10")
  })

  test("returns bare status when no p-value", () => {
    expect(formatStatusWithP("keep")).toBe("keep")
    expect(formatStatusWithP("discard", undefined)).toBe("discard")
  })
})
