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
import { deltaEntriesFor } from '../report/format.js'
import type { DeltaEntry } from '../report/format.js'

const isImprovement = (d: MetricDelta): boolean => d.better === 'better'
const isRegression = (d: MetricDelta): boolean => d.better === 'worse'
const isNeutral = (d: MetricDelta): boolean =>
  d.better === 'neutral' || d.better === 'context-dependent'

/**
 * One-line headline synthesised from the significant deltas. Mentions the
 * strongest significant improvement and regression when present; otherwise
 * reports the absence of significant change.
 */
const buildHeadline = (diff: MetricsDiff, entries: readonly DeltaEntry[]): string => {
  if (diff.bothFailed) {
    return 'Both sides failed — comparison unavailable.'
  }
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
      ? [`${String(sigImprovements.length)} significant improvement(s): ${sigImprovements.map((e) => e.label).join(', ')}`]
      : []),
    ...(sigRegressions.length > 0
      ? [`${String(sigRegressions.length)} significant regression(s): ${sigRegressions.map((e) => e.label).join(', ')}`]
      : []),
  ]
  return parts.join('; ') + '.'
}

export const buildReportSummary = (diff: MetricsDiff): ReportSummary => {
  const { entries, basis } = deltaEntriesFor(diff)
  const deltas = entries.map((e) => e.d)
  const improvements = deltas.filter(isImprovement)
  const regressions = deltas.filter(isRegression)
  const neutral = deltas.filter(isNeutral)
  const failures: readonly FailedRun[] = [
    ...diff.old.failedRuns,
    ...diff.new.failedRuns,
  ]
  return {
    headlineResult: buildHeadline(diff, entries),
    improvements: [...improvements],
    regressions: [...regressions],
    neutral: [...neutral],
    failures: [...failures],
    basis,
  }
}
