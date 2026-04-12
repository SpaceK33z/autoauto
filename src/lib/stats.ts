/**
 * Statistical significance tests for measurement comparison.
 *
 * Mann-Whitney U test: non-parametric test comparing two independent samples.
 * Does not assume normal distribution — suitable for noisy, skewed, or
 * discrete measurements.
 */

export interface MannWhitneyResult {
  /** The U statistic (min of U_a and U_b) */
  U: number
  /** Two-sided p-value */
  p: number
  /** True when p is the minimum attainable for these sample sizes (U=0, complete separation) */
  isMinimum: boolean
}

/**
 * Mann-Whitney U test (two-sided, non-parametric).
 *
 * Tests whether two independent samples come from the same distribution.
 * Returns null if either sample has fewer than 2 values.
 *
 * Uses exact distribution via DP for small samples (n1+n2 ≤ 40),
 * normal approximation with continuity correction and tie adjustment otherwise.
 */
export function mannWhitneyU(
  sampleA: number[],
  sampleB: number[],
): MannWhitneyResult | null {
  const n1 = sampleA.length
  const n2 = sampleB.length
  if (n1 < 2 || n2 < 2) return null

  // Compute U_a via pairwise comparison
  let Ua = 0
  for (const a of sampleA) {
    for (const b of sampleB) {
      if (a > b) Ua++
      else if (a === b) Ua += 0.5
    }
  }
  const Ub = n1 * n2 - Ua
  const U = Math.min(Ua, Ub)

  const combined = [...sampleA, ...sampleB]
  const hasTies = checkTies(combined)

  const isMinimum = U === 0

  if (n1 + n2 <= 40 && !hasTies) {
    const p = exactPValue(U, n1, n2)
    return { U, p, isMinimum }
  }

  // Normal approximation with tie correction and continuity correction
  const N = n1 + n2
  const mean = (n1 * n2) / 2

  let variance: number
  if (hasTies) {
    const tieGroups = getTieGroupSizes(combined)
    const tieSum = tieGroups.reduce((s, t) => s + (t * t * t - t), 0)
    variance = ((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1)))
  } else {
    variance = (n1 * n2 * (N + 1)) / 12
  }

  if (variance <= 0) return { U, p: 1, isMinimum: false }

  const z = (Math.abs(U - mean) - 0.5) / Math.sqrt(variance)
  const p = Math.min(2 * (1 - normalCDF(z)), 1)

  return { U, p, isMinimum }
}

// --- Internal helpers ---

function checkTies(values: number[]): boolean {
  const seen = new Set<number>()
  for (const v of values) {
    if (seen.has(v)) return true
    seen.add(v)
  }
  return false
}

function getTieGroupSizes(values: number[]): number[] {
  const counts = new Map<number, number>()
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return [...counts.values()].filter((c) => c > 1)
}

/**
 * Exact two-sided p-value for Mann-Whitney U via DP.
 * Only valid for the no-ties case.
 *
 * Uses the recurrence: f(u, m, n) = f(u-n, m-1, n) + f(u, m, n-1)
 * where f(u, m, n) = number of rank permutations giving U_a = u
 * with m elements from sample A and n from sample B.
 */
function exactPValue(U: number, n1: number, n2: number): number {
  const memo = new Map<number, number>()

  // Pack (u, m, n) into a single key. u ∈ [0, n1*n2], m ∈ [0, n1], n ∈ [0, n2]
  const stride_m = (n1 * n2 + 1)
  const stride_n = stride_m * (n1 + 1)

  function f(u: number, m: number, n: number): number {
    if (u < 0) return 0
    if (m === 0 || n === 0) return u === 0 ? 1 : 0

    const key = u + m * stride_m + n * stride_n
    const cached = memo.get(key)
    if (cached !== undefined) return cached

    const result = f(u - n, m - 1, n) + f(u, m, n - 1)
    memo.set(key, result)
    return result
  }

  // Total arrangements = C(n1+n2, n1)
  const total = binomial(n1 + n2, n1)

  // Cumulative probability: P(U_a ≤ U_observed)
  const floorU = Math.floor(U)
  let cumulative = 0
  for (let u = 0; u <= floorU; u++) {
    cumulative += f(u, n1, n2)
  }

  // Two-sided p-value
  return Math.min((2 * cumulative) / total, 1)
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  k = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1)
  }
  return Math.round(result)
}

/**
 * Normal CDF approximation via erf (Abramowitz & Stegun 7.1.26).
 * Phi(x) = 0.5 * (1 + erf(x / sqrt(2))), where the erf coefficients
 * require the x/sqrt(2) substitution. Accurate to ~1.5e-7 for all x.
 */
function normalCDF(x: number): number {
  if (x < -8) return 0
  if (x > 8) return 1

  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + p * z)
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z)

  return 0.5 * (1 + sign * y)
}
