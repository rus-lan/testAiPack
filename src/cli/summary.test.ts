import { describe, it, expect } from 'vitest'
import { buildReportSummary } from './summary.js'
import { makeMetricsReport } from '../../tests/helpers/variants.js'
import type { FailedRun, MetricsReport, PhaseDeltas, PrimaryDeltas } from '@generated/types'

describe('cli/summary — buildReportSummary (N-way, base/graphify/astgrep fixture)', () => {
  it('one perVariant bucket per non-baseline variant, config order (graphify, astgrep)', () => {
    const s = buildReportSummary(makeMetricsReport())
    expect(s.perVariant.map((v) => v.variant)).toEqual(['graphify', 'astgrep'])
  })

  it('each perVariant bucket accounts for all 7 primary deltas', () => {
    const s = buildReportSummary(makeMetricsReport())
    for (const v of s.perVariant) {
      expect(v.improvements.length + v.regressions.length + v.neutral.length).toBe(7)
    }
  })

  it('improvements/regressions/neutral are bucketed by `better`', () => {
    const s = buildReportSummary(makeMetricsReport())
    for (const v of s.perVariant) {
      expect(v.improvements.every((d) => d.better === 'better')).toBe(true)
      expect(v.regressions.every((d) => d.better === 'worse')).toBe(true)
      expect(v.neutral.every((d) => d.better === 'neutral' || d.better === 'context-dependent')).toBe(true)
    }
  })

  it('headline: one clause per variant, exact wording per 03-hard-problems.md §1.4', () => {
    const s = buildReportSummary(makeMetricsReport())
    expect(s.headlineResult).toBe(
      'По сравнению с base: graphify — 2 значимых улучшения: Всего токенов, Шаги; astgrep — нет значимых различий (3 лучше, 1 хуже, всё в пределах шума).',
    )
  })

  it('basis is "total" when no pair has taskDeltas', () => {
    const s = buildReportSummary(makeMetricsReport())
    expect(s.basis).toBe('total')
  })

  it('failures = concat of every variant\'s failedRuns, each carrying its own variant (D17)', () => {
    const failed: FailedRun = {
      variant: 'graphify',
      runIndex: 2,
      errorCode: 'E_RUN_CRASH',
      errorMessage: 'run graphify/2 failed: finishCause=error exitCode=1 watchdog=false',
      timestamp: '2025-01-01T00:00:00.000Z',
    }
    const base = makeMetricsReport()
    const metrics: MetricsReport = {
      ...base,
      variants: base.variants.map((v) => (v.variant === 'graphify' ? { ...v, failedRuns: [failed] } : v)),
    }
    const s = buildReportSummary(metrics)
    expect(s.failures).toEqual([failed])
  })
})

// ---------------------------------------------------------------------------
// allFailed / pairIncomplete (03-hard-problems.md §1.2, §1.4) — the N-way
// generalization of the old two-sided bothFailed/anyFailed containment.
// ---------------------------------------------------------------------------

describe('cli/summary — allFailed and pairIncomplete', () => {
  it('allFailed -> a single explicit sentence naming the variant count, no per-variant clauses', () => {
    const base = makeMetricsReport()
    const metrics: MetricsReport = { ...base, allFailed: true }
    const s = buildReportSummary(metrics)
    expect(s.headlineResult).toBe('Все 3 варианта провалились — сравнение недоступно.')
  })

  it('a broken pair (pairIncomplete) contributes "нет данных (все запуски провалились)", not a significance clause', () => {
    const base = makeMetricsReport()
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => (d.variant === 'graphify' ? { ...d, pairIncomplete: true } : d)),
    }
    const s = buildReportSummary(metrics)
    expect(s.headlineResult).toContain('graphify — нет данных (все запуски провалились)')
    expect(s.headlineResult).toContain('astgrep — нет значимых различий')
  })

  it('a single-variant run (no non-baseline variant, legal per phase 00) gets its own sentence, not "По сравнению с base: ."', () => {
    const base = makeMetricsReport()
    const metrics: MetricsReport = { ...base, variants: [base.variants[0]!], deltas: [] }
    const s = buildReportSummary(metrics)
    expect(s.headlineResult).toBe('Запущен только base — сравнивать не с чем.')
    expect(s.perVariant).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Task basis (metric-split spec §5.6, §6, §9) — basis is decided PER PAIR
// (03-hard-problems.md §1.2); the machine-readable ReportSummary.basis is
// "task" iff EVERY pair is task, "total" iff every pair is total, omitted
// when mixed.
// ---------------------------------------------------------------------------

const NEUTRAL_PHASE_DELTAS: PhaseDeltas = {
  totalTokens: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
  wallClockMs: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
  costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
  stepCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
  toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
}

describe('cli/summary — task basis', () => {
  it('basis is "task" when every pair carries taskDeltas', () => {
    const base = makeMetricsReport()
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => ({ ...d, taskDeltas: NEUTRAL_PHASE_DELTAS })),
    }
    const s = buildReportSummary(metrics)
    expect(s.basis).toBe('task')
  })

  it('basis is omitted (mixed) when only one pair carries taskDeltas', () => {
    const base = makeMetricsReport()
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => (d.variant === 'graphify' ? { ...d, taskDeltas: NEUTRAL_PHASE_DELTAS } : d)),
    }
    const s = buildReportSummary(metrics)
    expect(s.basis).toBeUndefined()
  })

  it('a task-phase-only significant delta surfaces in the headline even though the whole-run delta for that variant is not significant', () => {
    const base = makeMetricsReport()
    const taskDeltas: PhaseDeltas = {
      ...NEUTRAL_PHASE_DELTAS,
      stepCount: { absolute: 10, percent: 100, significant: true, better: 'worse' },
    }
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => (d.variant === 'astgrep' ? { ...d, taskDeltas } : d)),
    }
    const s = buildReportSummary(metrics)
    expect(s.headlineResult).toContain('astgrep')
    expect(s.headlineResult).toContain('Шаги')
    expect(s.headlineResult).toContain('значимая регрессия')
  })
})

// ---------------------------------------------------------------------------
// A variant with BOTH significant improvements and significant regressions
// must join the two parts of its OWN clause differently from the join
// between separate variants' clauses — otherwise a 3-part '; '-separated
// headline reads as three variants instead of one variant with two facts.
// ---------------------------------------------------------------------------

describe('cli/summary — one clause, two parts (significant improvement AND regression together)', () => {
  it('joins the improvement/regression parts of one clause with " и ", reserving "; " for the join between variants', () => {
    const base = makeMetricsReport()
    const mixedDeltas: PrimaryDeltas = {
      totalTokens: { absolute: -5000, percent: -30, significant: true, better: 'better' },
      wallClockMs: { absolute: 5000, percent: 30, significant: true, better: 'worse' },
      costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      stepCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      successRank: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
    }
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => (d.variant === 'graphify' ? { ...d, deltas: mixedDeltas } : d)),
    }
    const s = buildReportSummary(metrics)
    expect(s.headlineResult).toContain(
      'graphify — 1 значимое улучшение: Всего токенов и 1 значимая регрессия: Время (wall-clock), мс',
    )
    // The clause boundary before astgrep is still '; ', not ' и '.
    expect(s.headlineResult).toContain('мс; astgrep —')
  })
})
