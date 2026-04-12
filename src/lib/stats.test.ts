import { describe, test, expect } from "bun:test"
import { mannWhitneyU } from "./stats.ts"

describe("mannWhitneyU", () => {
  test("returns null when either sample has fewer than 2 values", () => {
    expect(mannWhitneyU([1], [2, 3])).toBeNull()
    expect(mannWhitneyU([1, 2], [3])).toBeNull()
    expect(mannWhitneyU([], [1, 2])).toBeNull()
  })

  describe("exact p-values (small samples, no ties)", () => {
    test("interleaved distributions give high p and isMinimum=false", () => {
      const result = mannWhitneyU([1, 3, 5], [2, 4, 6])!
      expect(result.p).toBeGreaterThan(0.5)
      expect(result.isMinimum).toBe(false)
    })

    test("completely separated samples give minimum p-value with isMinimum flag", () => {
      // All of A < all of B → U = 0 → minimum p
      // For n1=n2=3, minimum p = 2 * 1/20 = 0.1
      const result = mannWhitneyU([1, 2, 3], [4, 5, 6])!
      expect(result.U).toBe(0)
      expect(result.p).toBeCloseTo(0.1, 4)
      expect(result.isMinimum).toBe(true)
    })

    test("known n=3,3 U=1 gives p=0.2", () => {
      // U_a: 1 beats none of B (0), 2 beats none (0), 3 beats 1 of B (just the value 2 wait...
      // Let me construct carefully: A=[1,2,4], B=[3,5,6]
      // U_a: 1>3? no. 1>5? no. 1>6? no. → 0
      //       2>3? no. 2>5? no. 2>6? no. → 0
      //       4>3? yes. 4>5? no. 4>6? no. → 1
      // U_a = 1, U_b = 9 - 1 = 8, U = min(1, 8) = 1
      const result = mannWhitneyU([1, 2, 4], [3, 5, 6])!
      expect(result.U).toBe(1)
      expect(result.p).toBeCloseTo(0.2, 4)
    })

    test("larger samples give more discriminating p-values", () => {
      // n=5 vs n=5, complete separation → U = 0
      // C(10,5) = 252, p = 2/252 ≈ 0.00794
      const result = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])!
      expect(result.U).toBe(0)
      expect(result.p).toBeCloseTo(2 / 252, 4)
    })

    test("n=5 equal overlap gives high p-value", () => {
      const result = mannWhitneyU([1, 3, 5, 7, 9], [2, 4, 6, 8, 10])!
      expect(result.p).toBeGreaterThan(0.5)
    })
  })

  describe("samples with ties (normal approximation)", () => {
    test("handles tied values between samples", () => {
      const result = mannWhitneyU([1, 2, 3], [3, 4, 5])!
      expect(result).not.toBeNull()
      expect(result.p).toBeGreaterThan(0)
      expect(result.p).toBeLessThanOrEqual(1)
    })

    test("identical samples give p = 1", () => {
      const result = mannWhitneyU([5, 5, 5], [5, 5, 5])!
      // U = 4.5 (half of 3*3), everything tied
      expect(result.p).toBe(1)
    })

    test("clear separation with ties gives low p-value", () => {
      // Groups clearly differ despite some tied values
      // scipy.stats.mannwhitneyu([1,1,2,2,3], [4,4,5,5,6]) → p ≈ 0.0122 (two-sided)
      const result = mannWhitneyU([1, 1, 2, 2, 3], [4, 4, 5, 5, 6])!
      expect(result.U).toBe(0)
      expect(result.p).toBeLessThan(0.02)
      expect(result.p).toBeGreaterThan(0.005)
    })

    test("partial overlap with ties gives moderate p-value", () => {
      // Some overlap: A=[1,2,3,3,4], B=[3,3,4,5,6]
      const result = mannWhitneyU([1, 2, 3, 3, 4], [3, 3, 4, 5, 6])!
      expect(result.p).toBeGreaterThan(0.05)
      expect(result.p).toBeLessThan(0.5)
    })
  })

  describe("real-world measurement scenarios", () => {
    test("clear improvement: baseline ~100, experiment ~90 (lower is better)", () => {
      const baseline = [100, 102, 98, 101, 99]
      const experiment = [90, 92, 88, 91, 89]
      const result = mannWhitneyU(baseline, experiment)!
      // Completely separated → very low p-value
      expect(result.p).toBeLessThan(0.05)
    })

    test("marginal improvement: overlapping distributions", () => {
      const baseline = [100, 102, 98, 101, 99]
      const experiment = [97, 99, 95, 101, 96]
      const result = mannWhitneyU(baseline, experiment)!
      // Mostly separated with some overlap → moderate p
      expect(result.p).toBeGreaterThan(0.01)
    })

    test("no real difference: same distribution", () => {
      const baseline = [100, 102, 98, 101, 99]
      const experiment = [100, 101, 99, 102, 98]
      const result = mannWhitneyU(baseline, experiment)!
      expect(result.p).toBeGreaterThan(0.5)
    })

    test("works with repeats=3 (limited power)", () => {
      const baseline = [100, 102, 98]
      const experiment = [90, 92, 88]
      const result = mannWhitneyU(baseline, experiment)!
      // Complete separation with n=3 → p = 0.1 (minimum possible)
      expect(result.U).toBe(0)
      expect(result.p).toBeCloseTo(0.1, 4)
    })
  })

  describe("symmetry", () => {
    test("swapping samples gives same p-value", () => {
      const a = [1, 3, 5, 7]
      const b = [2, 4, 6, 8]
      const r1 = mannWhitneyU(a, b)!
      const r2 = mannWhitneyU(b, a)!
      expect(r1.p).toBeCloseTo(r2.p, 10)
      expect(r1.U).toBeCloseTo(r2.U, 10)
    })
  })
})
