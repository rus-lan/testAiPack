/**
 * Builds the `ReportSummary` (headline + improvement/regression/neutral
 * buckets + failed runs) from a MetricsDiff. The report-render phase takes
 * this summary as input, so the orchestrator must materialise it before phase
 * 11. Pure function — safe to unit-test in isolation.
 *
 * @see docs/phases/11-report-render.ru.md
 */
import type {
  FailedRun,
  MetricDelta,
  MetricsDiff,
  ReportSummary,
} from '@generated/types'
import { PRIMARY_METRICS } from '../report/format.js'

type DeltaKey = keyof MetricsDiff['deltas']

const DELTA_KEYS: readonly DeltaKey[] = PRIMARY_METRICS.map((m) => m.key)

const isImprovement = (d: MetricDelta): boolean => d.better === 'better'
const isRegression = (d: MetricDelta): boolean => d.better === 'worse'
const isNeutral = (d: MetricDelta): boolean =>
  d.better === 'neutral' || d.better === 'context-dependent'

const labelForDelta = (key: DeltaKey): string => {
  const meta = PRIMARY_METRICS.find((m) => m.key === key)
  return meta === undefined ? key : meta.label
}

/**
 * One-line headline synthesised from the significant deltas. Mentions the
 * strongest significant improvement and regression when present; otherwise
 * reports the absence of significant change.
 */
const buildHeadline = (diff: MetricsDiff): string => {
  if (diff.bothFailed) {
    return 'Both sides failed — comparison unavailable.'
  }
  const entries = DELTA_KEYS.map((k) => ({ key: k, d: diff.deltas[k] }))
  const sig = entries.filter((e) => e.d.significant)
  if (sig.length === 0) {
    const improvements = entries.filter((e) => isImprovement(e.d)).length
    const regressions = entries.filter((e) => isRegression(e.d)).length
    return `No significant differences (${String(improvements)} better, ${String(regressions)} worse, all within noise).`
  }
  const sigImprovements = sig.filter((e) => isImprovement(e.d))
  const sigRegressions = sig.filter((e) => isRegression(e.d))
  const parts: readonly string[] = [
    ...(sigImprovements.length > 0
      ? [`${String(sigImprovements.length)} significant improvement(s): ${sigImprovements.map((e) => labelForDelta(e.key)).join(', ')}`]
      : []),
    ...(sigRegressions.length > 0
      ? [`${String(sigRegressions.length)} significant regression(s): ${sigRegressions.map((e) => labelForDelta(e.key)).join(', ')}`]
      : []),
  ]
  return parts.join('; ') + '.'
}

export const buildReportSummary = (diff: MetricsDiff): ReportSummary => {
  const deltas = DELTA_KEYS.map((k) => diff.deltas[k])
  const improvements = deltas.filter(isImprovement)
  const regressions = deltas.filter(isRegression)
  const neutral = deltas.filter(isNeutral)
  const failures: readonly FailedRun[] = [
    ...diff.old.failedRuns,
    ...diff.new.failedRuns,
  ]
  return {
    headlineResult: buildHeadline(diff),
    improvements: [...improvements],
    regressions: [...regressions],
    neutral: [...neutral],
    failures: [...failures],
  }
}
