/**
 * Builds the `ReportSummary` (headline + per-variant improvement/regression/
 * neutral buckets + failed runs) from a `MetricsReport`. The report-render
 * phase takes this summary as input, so the orchestrator must materialise it
 * before phase 11. Pure function — safe to unit-test in isolation.
 *
 * @see docs/phases/11-report-render.ru.md
 */
import type {
  FailedRun,
  MetricDelta,
  MetricsReport,
  ReportSummary,
  VariantDelta,
  VariantSummary,
} from '@generated/types'
import { deltaEntriesFor } from '../report/format.js'
import type { DeltaEntry } from '../report/format.js'

const isImprovement = (d: MetricDelta): boolean => d.better === 'better'
const isRegression = (d: MetricDelta): boolean => d.better === 'worse'
const isNeutral = (d: MetricDelta): boolean =>
  d.better === 'neutral' || d.better === 'context-dependent'

/** One clause per non-baseline variant (`03-hard-problems.md` §1.4). */
const clauseFor = (metrics: MetricsReport, delta: VariantDelta): string => {
  if (delta.pairIncomplete) {
    return `${delta.variant} — no samples (all runs failed)`
  }
  const { entries } = deltaEntriesFor(metrics, delta.variant)
  const sig = entries.filter((e) => e.d.significant)
  if (sig.length === 0) {
    const improvements = entries.filter((e) => isImprovement(e.d)).length
    const regressions = entries.filter((e) => isRegression(e.d)).length
    return `${delta.variant} — no significant differences (${String(improvements)} better, ${String(regressions)} worse, all within noise)`
  }
  const sigImprovements = sig.filter((e) => isImprovement(e.d))
  const sigRegressions = sig.filter((e) => isRegression(e.d))
  // ' and ', not '; ' — '; ' is reserved for the join BETWEEN variant clauses
  // (buildHeadline below); a variant with both an improvement and a
  // regression part must not look like two separate variant clauses.
  const parts: readonly string[] = [
    ...(sigImprovements.length > 0
      ? [`${String(sigImprovements.length)} significant improvement(s): ${sigImprovements.map((e) => e.label).join(', ')}`]
      : []),
    ...(sigRegressions.length > 0
      ? [`${String(sigRegressions.length)} significant regression(s): ${sigRegressions.map((e) => e.label).join(', ')}`]
      : []),
  ]
  return `${delta.variant} — ${parts.join(' and ')}`
}

/**
 * One-line headline synthesised from every non-baseline variant's deltas,
 * config order. `allFailed` collapses to a single sentence (generalizes the
 * old two-sided `bothFailed`); a single-variant run (no non-baseline variant
 * at all, legal per phase 00) has nothing to compare and gets its own
 * sentence rather than the broken `vs base: .`; otherwise one clause per
 * variant, joined — see `03-hard-problems.md` §1.4 for the exact wording
 * this mirrors.
 */
const buildHeadline = (metrics: MetricsReport): string => {
  if (metrics.allFailed) {
    return `All ${String(metrics.variants.length)} variants failed — comparison unavailable.`
  }
  if (metrics.deltas.length === 0) {
    return `Only ${metrics.baseline} ran — no comparison.`
  }
  const clauses = metrics.deltas.map((delta) => clauseFor(metrics, delta))
  return `vs ${metrics.baseline}: ${clauses.join('; ')}.`
}

/** 'task' iff every pair reports on the task basis; 'total' iff every pair does; omitted when mixed (renderers disclose the mix in the header text). */
const overallBasis = (bases: readonly ('task' | 'total')[]): 'task' | 'total' | undefined => {
  if (bases.length === 0) return undefined
  if (bases.every((b) => b === 'task')) return 'task'
  if (bases.every((b) => b === 'total')) return 'total'
  return undefined
}

export const buildReportSummary = (metrics: MetricsReport): ReportSummary => {
  const entriesByVariant = new Map(metrics.deltas.map((d) => [d.variant, deltaEntriesFor(metrics, d.variant)]))
  const perVariant: readonly VariantSummary[] = metrics.deltas.map((delta) => {
    const entries: readonly DeltaEntry[] = entriesByVariant.get(delta.variant)?.entries ?? []
    const deltas = entries.map((e) => e.d)
    return {
      variant: delta.variant,
      improvements: deltas.filter(isImprovement),
      regressions: deltas.filter(isRegression),
      neutral: deltas.filter(isNeutral),
    }
  })
  const failures: readonly FailedRun[] = metrics.variants.flatMap((v) => v.failedRuns)
  const basis = overallBasis([...entriesByVariant.values()].map((e) => e.basis))
  return {
    headlineResult: buildHeadline(metrics),
    perVariant: [...perVariant],
    failures: [...failures],
    ...(basis === undefined ? {} : { basis }),
  }
}
