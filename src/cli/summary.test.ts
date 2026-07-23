import { describe, it, expect } from 'vitest'
import { buildReportSummary } from './summary.js'
import { makeMetricsDiff } from '../../tests/report-fixture.js'

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
})
