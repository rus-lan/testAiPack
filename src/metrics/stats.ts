/**
 * Small pure statistics helpers shared by metrics extraction (percentiles per
 * run) and aggregation (median / IQR across runs). No Effect, no IO.
 *
 * @see docs/phases/07-aggregate.ru.md
 */

const valueAt = (sorted: readonly number[], i: number): number => {
  const v = sorted[i]
  return v === undefined ? 0 : v
}

const sortAsc = (values: readonly number[]): readonly number[] =>
  [...values].sort((a, b) => a - b)

export const median = (values: readonly number[]): number => {
  const sorted = sortAsc(values)
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (valueAt(sorted, mid - 1) + valueAt(sorted, mid)) / 2 : valueAt(sorted, mid)
}

/**
 * Linear-interpolation percentile (Type 7, same as numpy default). For p=50 on
 * an odd-length sample this equals the median.
 */
export const percentile = (values: readonly number[], p: number): number => {
  const sorted = sortAsc(values)
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return valueAt(sorted, 0)
  const rank = (p / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  const loV = valueAt(sorted, lo)
  const hiV = valueAt(sorted, hi)
  if (lo === hi) return loV
  return loV + (hiV - loV) * (rank - lo)
}

export const minimum = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.min(...values)

export const maximum = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values)

/**
 * Interquartile range (P75 - P25). Returns undefined when fewer than 4 samples
 * are present — the phase doc reserves IQR for N >= 4.
 */
export const interquartileRange = (values: readonly number[]): number | undefined => {
  if (values.length < 4) return undefined
  return percentile(values, 75) - percentile(values, 25)
}

export { toNum } from '../util/numeric.js'
