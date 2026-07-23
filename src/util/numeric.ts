/**
 * Safe string|number -> finite number. Falls back to 0 for undefined / null /
 * non-finite values. Shared by metrics extraction/aggregation and report
 * formatting (int64 values arrive as strings on the wire).
 */

export const toNum = (value: string | number | undefined | null): number => {
  if (value === undefined || value === null) return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}
