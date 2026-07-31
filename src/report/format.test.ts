import { describe, it, expect } from 'vitest'
import {
  deltaEntriesFor,
  fmtCost,
  fmtDurationMs,
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtValue,
  PHASE_METRICS,
  PRIMARY_METRICS,
  sigLabel,
  toNum,
  trimTrailingZeros,
  verdictFor,
} from './format.js'
import type { MetricKind } from './format.js'
import type { MetricDelta, MetricsReport, PhaseDeltas } from '@generated/types'
import { makeMetricsReport } from '../../tests/helpers/variants.js'

describe('format — number helpers', () => {
  it.each([
    ['0', 0],
    ['12345', 12345],
    ['10987', 10987],
  ])('toNum("%s") === %d', (input, expected) => {
    expect(toNum(input)).toBe(expected)
  })

  it.each<[string | number, string]>([
    ['12345', '12345'],
    [10987, '10987'],
    [52000, '52000'],
    ['45000', '45000'],
  ])('fmtInt(%j) === %s', (input, expected) => {
    expect(fmtInt(input)).toBe(expected)
  })

  it.each<[number, string]>([
    [0, '0'],
    [0.045, '0.045'],
    [0.041, '0.041'],
    [0.004, '0.004'],
    [1.2, '1.2'],
    [1.0, '1'],
  ])('fmtCost(%d) === %s', (input, expected) => {
    expect(fmtCost(input)).toBe(expected)
  })

  it.each<[string, string]>([
    ['0.0450', '0.045'],
    ['1.2000', '1.2'],
    ['1.0000', '1'],
    ['5', '5'],
  ])('trimTrailingZeros(%j) === %j', (input, expected) => {
    expect(trimTrailingZeros(input)).toBe(expected)
  })
})

describe('format — signed deltas and percent', () => {
  it.each<[number, 'int' | 'cost' | 'rank', string]>([
    [-1358, 'int', '-1358'],
    [7000, 'int', '+7000'],
    [0, 'int', '0'],
    [-0.004, 'cost', '-0.004'],
    [0.004, 'cost', '+0.004'],
    [2, 'rank', '+2'],
    [0, 'rank', '0'],
  ])('fmtSigned(%d, %s) === %s', (value, kind, expected) => {
    expect(fmtSigned(value, kind)).toBe(expected)
  })

  it.each<[number, string]>([
    [-11.0, '-11.0%'],
    [15.6, '+15.6%'],
    [0, '0.0%'],
    [-8.9, '-8.9%'],
  ])('fmtPct(%d) === %s', (value, expected) => {
    expect(fmtPct(value)).toBe(expected)
  })

  it('fmtPct(undefined) === "н/д" (the omitted 0 -> non-zero percent)', () => {
    expect(fmtPct(undefined)).toBe('н/д')
  })

  it.each<[string | number, MetricKind, string]>([
    ['12345', 'int', '12345'],
    [0.045, 'cost', '0.045'],
    [4, 'rank', '4'],
  ])('fmtValue(%j, %s) === %s', (value, kind, expected) => {
    expect(fmtValue(value, kind)).toBe(expected)
  })
})

describe('format — fmtDurationMs (readability: raw ms does not read as minutes)', () => {
  it.each<[string | number, string]>([
    [0, '0ms'],
    [500, '500ms'],
    [59999, '59999ms'],
    [60000, '60000ms (~1.0min)'],
    [252915, '252915ms (~4.2min)'],
    ['252915', '252915ms (~4.2min)'],
    [240663, '240663ms (~4.0min)'],
  ])('fmtDurationMs(%j) === %s', (value, expected) => {
    expect(fmtDurationMs(value)).toBe(expected)
  })
})

const delta = (
  better: MetricDelta['better'],
  significant: boolean,
): MetricDelta => ({
  absolute: 0,
  percent: 0,
  significant,
  better,
})

describe('PHASE_METRICS — the five splittable metrics (metric-split spec §5.7)', () => {
  it('matches the first five PRIMARY_METRICS entries by key/label/kind (drift guard)', () => {
    expect(PHASE_METRICS).toEqual(PRIMARY_METRICS.slice(0, 5))
  })

  it('does not carry successRank or maxParallelism (those stay whole-run-only)', () => {
    const keys = PHASE_METRICS.map((m) => m.key)
    expect(keys).not.toContain('successRank')
    expect(keys).not.toContain('maxParallelism')
  })
})

describe('format — verdict and significance labels', () => {
  it.each<[MetricDelta['better'], string]>([
    ['better', '✓ лучше'],
    ['worse', '⚠ хуже'],
    ['neutral', '= без изменений'],
    ['context-dependent', '≈ контекст'],
  ])('verdictFor(%s) === %s', (better, expected) => {
    expect(verdictFor(delta(better, false))).toBe(expected)
  })

  it.each<[MetricDelta['better'], boolean, string]>([
    ['better', true, '✓ значимо'],
    ['worse', true, '⚠ значимо'],
    ['neutral', true, 'значимо'],
    ['context-dependent', true, 'значимо'],
    ['neutral', false, '—'],
    ['better', false, 'в пределах шума'],
    ['worse', false, 'в пределах шума'],
  ])('sigLabel(%s, sig=%s) === %s', (better, significant, expected) => {
    expect(sigLabel(delta(better, significant))).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// deltaEntriesFor — per (baseline, variant) pair basis selection
// (`03-hard-problems.md` §1.2). `makeMetricsReport` (tests/helpers/variants.ts)
// gives 3 variants (base/graphify/astgrep), 2 deltas (vs base), no task split.
// ---------------------------------------------------------------------------

describe('report/format — deltaEntriesFor', () => {
  it('basis is "total" and 7 entries when the pair has no taskDeltas', () => {
    const metrics = makeMetricsReport()
    const { entries, basis } = deltaEntriesFor(metrics, 'graphify')
    expect(basis).toBe('total')
    expect(entries).toHaveLength(7)
  })

  it('reads entries from the (base, variant) pair, not a shared/global bucket', () => {
    const metrics = makeMetricsReport()
    const graphify = deltaEntriesFor(metrics, 'graphify')
    const astgrep = deltaEntriesFor(metrics, 'astgrep')
    // graphify's totalTokens/stepCount are significant improvements (fixture
    // comment: Δ -1200 > 2.25*300, Δ -6 > 2.25*2); astgrep's are not.
    const gTotal = graphify.entries.find((e) => e.key === 'totalTokens')
    const aTotal = astgrep.entries.find((e) => e.key === 'totalTokens')
    expect(gTotal?.d.significant).toBe(true)
    expect(gTotal?.d.better).toBe('better')
    expect(aTotal?.d.significant).toBe(false)
  })

  it('unknown variant name -> empty entries, basis "total"', () => {
    const metrics = makeMetricsReport()
    const { entries, basis } = deltaEntriesFor(metrics, 'does-not-exist')
    expect(entries).toEqual([])
    expect(basis).toBe('total')
  })

  it('basis is "task" and entries are the 5 phase deltas + successRank/maxParallelism when taskDeltas is present', () => {
    const taskDeltas: PhaseDeltas = {
      totalTokens: { absolute: 500, percent: 50, significant: true, better: 'worse' },
      wallClockMs: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      stepCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
    }
    const base = makeMetricsReport()
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => (d.variant === 'graphify' ? { ...d, taskDeltas } : d)),
    }
    const { entries, basis } = deltaEntriesFor(metrics, 'graphify')
    expect(basis).toBe('task')
    expect(entries).toHaveLength(7)
    const totalTokens = entries.find((e) => e.key === 'totalTokens')
    expect(totalTokens?.d).toEqual(taskDeltas.totalTokens)
    // successRank/maxParallelism stay sourced from the whole-run `deltas`, not taskDeltas.
    const graphifyDelta = metrics.deltas.find((d) => d.variant === 'graphify')
    const successRank = entries.find((e) => e.key === 'successRank')
    expect(successRank?.d).toEqual(graphifyDelta?.deltas.successRank)
  })

  it('basis is decided per pair — one variant can be task while another is total', () => {
    const taskDeltas: PhaseDeltas = {
      totalTokens: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      wallClockMs: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      stepCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
    }
    const base = makeMetricsReport()
    const metrics: MetricsReport = {
      ...base,
      deltas: base.deltas.map((d) => (d.variant === 'graphify' ? { ...d, taskDeltas } : d)),
    }
    expect(deltaEntriesFor(metrics, 'graphify').basis).toBe('task')
    expect(deltaEntriesFor(metrics, 'astgrep').basis).toBe('total')
  })
})
