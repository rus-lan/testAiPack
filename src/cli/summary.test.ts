import { describe, it, expect } from 'vitest'
import { buildReportSummary } from './summary.js'
import { makeMetricsDiff, makePhaseDeltas } from '../../tests/report-fixture.js'

describe('cli/summary — buildReportSummary', () => {
  it('buckets all 7 primary deltas by better', () => {
    const diff = makeMetricsDiff()
    const s = buildReportSummary(diff)
    const total = s.improvements.length + s.regressions.length + s.neutral.length
    expect(total).toBe(7)
  })

  it('improvements contain better=worse? no: better', () => {
    const s = buildReportSummary(makeMetricsDiff())
    expect(s.improvements.every((d) => d.better === 'better')).toBe(true)
    expect(s.regressions.every((d) => d.better === 'worse')).toBe(true)
    expect(s.neutral.every((d) => d.better === 'neutral' || d.better === 'context-dependent')).toBe(true)
  })

  it('matches the fixture expectations: 2 improvements, 3 regressions, 2 neutral', () => {
    const s = buildReportSummary(makeMetricsDiff())
    expect(s.improvements.length).toBe(2)
    expect(s.regressions.length).toBe(3)
    expect(s.neutral.length).toBe(2)
  })

  it('headline mentions significant improvements and regressions', () => {
    const s = buildReportSummary(makeMetricsDiff())
    expect(s.headlineResult).toContain('significant')
    expect(s.headlineResult).toMatch(/improvement|regression/i)
  })

  it('bothFailed headline is explicit', () => {
    const diff = makeMetricsDiff({ bothFailed: true })
    const s = buildReportSummary(diff)
    expect(s.headlineResult).toContain('Both sides failed')
  })

  it('failures aggregate old + new failed runs', () => {
    const diff = makeMetricsDiff({
      old: makeMetricsDiff().old,
      new: makeMetricsDiff().new,
    })
    const oldFailed = { ...diff.old, failedRuns: [{ runIndex: 1, errorCode: 'E_RUN_CRASH' as const, errorMessage: 'x', timestamp: 't' }] }
    const withFailures = makeMetricsDiff({ old: oldFailed })
    const s = buildReportSummary(withFailures)
    expect(s.failures.length).toBe(1)
  })

  it('basis is "total" when no taskDeltas is present (old reports, or no split)', () => {
    const s = buildReportSummary(makeMetricsDiff())
    expect(s.basis).toBe('total')
  })
})

// ---------------------------------------------------------------------------
// Task basis (metric-split spec §5.6, §6, §9): whenever taskDeltas is
// present, the headline + buckets use the 5 phase deltas plus the 2
// whole-run-only metrics (successRank, maxParallelism) — one-sided AND
// two-sided init alike, decided: task, always.
// ---------------------------------------------------------------------------

describe('cli/summary — task basis', () => {
  it('basis is "task" whenever taskDeltas is present, even one-sided init (no initDeltas)', () => {
    const diff = makeMetricsDiff({ taskDeltas: makePhaseDeltas() })
    const s = buildReportSummary(diff)
    expect(s.basis).toBe('task')
  })

  it('basis is "task" with two-sided init too (initDeltas also present)', () => {
    const diff = makeMetricsDiff({ taskDeltas: makePhaseDeltas(), initDeltas: makePhaseDeltas() })
    const s = buildReportSummary(diff)
    expect(s.basis).toBe('task')
  })

  it('bucket total is 7: the 5 task-phase deltas plus successRank + maxParallelism (whole-run)', () => {
    const diff = makeMetricsDiff({ taskDeltas: makePhaseDeltas() })
    const s = buildReportSummary(diff)
    const total = s.improvements.length + s.regressions.length + s.neutral.length
    expect(total).toBe(7)
  })

  it('headline text is driven by the task deltas, not the whole-run ones', () => {
    // Whole-run deltas (defaultDeltas via makeMetricsDiff) call totalTokens a
    // significant improvement; the task deltas here call it a significant
    // regression instead — the headline must reflect the task figure.
    const diff = makeMetricsDiff({
      taskDeltas: makePhaseDeltas({
        totalTokens: { absolute: 500, percent: 50, significant: true, better: 'worse' },
      }),
    })
    const s = buildReportSummary(diff)
    expect(s.headlineResult).toContain('regression')
    expect(s.headlineResult).toContain('Total tokens')
  })

  it('a task-phase-only significant delta (e.g. Steps) surfaces in the headline even though the whole-run Steps delta is not significant', () => {
    const diff = makeMetricsDiff({
      taskDeltas: makePhaseDeltas({
        stepCount: { absolute: 10, percent: 100, significant: true, better: 'worse' },
      }),
    })
    const s = buildReportSummary(diff)
    expect(s.headlineResult).toContain('Steps')
  })

  it('whole-run-only metrics (successRank, maxParallelism) are still sourced from diff.deltas, not taskDeltas', () => {
    const diff = makeMetricsDiff({ taskDeltas: makePhaseDeltas() })
    const s = buildReportSummary(diff)
    // defaultDeltas has both neutral -> both land in `neutral`.
    const neutralKinds = s.neutral.length
    expect(neutralKinds).toBeGreaterThanOrEqual(2)
  })
})
