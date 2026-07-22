/**
 * Metrics: significance — the 1.5×IQR rule that flags a primary-metric delta as
 * significant. A delta is significant when its absolute value exceeds 1.5× the
 * old side's IQR. With no IQR (N < 4) nothing is flagged.
 *
 * @see docs/phases/07-aggregate.ru.md
 */

export const isSignificant = (
  absolute: number,
  iqr: number | undefined,
): boolean => iqr !== undefined && Math.abs(absolute) > 1.5 * iqr
