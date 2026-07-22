import { describe, it, expect } from 'vitest'
import type {
  PrimaryMetrics,
  SecondaryMetrics,
  SideAggregates,
} from '@generated/types'
import {
  aggregatePrimary,
  aggregateSecondary,
  buildSideAggregates,
  computeDelta,
  computeMetricDelta,
} from './aggregate.js'
import type { ExtractedMetrics } from './extract.js'

const primary = (over: Partial<PrimaryMetrics>): PrimaryMetrics => ({
  totalTokens: '0',
  wallClockMs: '0',
  costUsd: 0,
  stepCount: 0,
  toolCallCount: 0,
  successRank: 0,
  maxParallelism: 1,
  ...over,
})

const emptySecondary = (): SecondaryMetrics => ({
  inputTokens: '0',
  outputTokens: '0',
  reasoningTokens: '0',
  cacheReadTokens: '0',
  perTool: {},
  reasoningTimeMs: '0',
  stepLatencyP50Ms: '0',
  stepLatencyP95Ms: '0',
  toolLatencyAvgMs: '0',
  finishCauseDistribution: {},
  fileDiffStats: { additions: 0, deletions: 0, filesChanged: 0 },
  maxConsecutiveSameTool: 0,
})

const sideFromPrimary = (side: 'old' | 'new', list: readonly PrimaryMetrics[]): SideAggregates => {
  const { median, stats } = aggregatePrimary(list)
  return { side, primary: median, secondary: emptySecondary(), stats, failedRuns: [], rawRunIds: [] }
}

describe('computeMetricDelta (table)', () => {
  it('old=100 new=120 IQR=5 (lower-is-better) -> significant, worse', () => {
    const d = computeMetricDelta(100, 120, 5, 'lower-is-better')
    expect(d.absolute).toBe(20)
    expect(d.percent).toBe(20)
    expect(d.significant).toBe(true) // |20| > 7.5
    expect(d.better).toBe('worse')
  })

  it('old=100 new=110 IQR=20 (lower-is-better) -> not significant, worse', () => {
    const d = computeMetricDelta(100, 110, 20, 'lower-is-better')
    expect(d.absolute).toBe(10)
    expect(d.percent).toBe(10)
    expect(d.significant).toBe(false) // |10| <= 30
    expect(d.better).toBe('worse')
  })

  it('successRank is higher-is-better', () => {
    expect(computeMetricDelta(3, 4, undefined, 'higher-is-better').better).toBe('better')
    expect(computeMetricDelta(4, 3, undefined, 'higher-is-better').better).toBe('worse')
    expect(computeMetricDelta(3, 3, undefined, 'higher-is-better').better).toBe('neutral')
  })

  it('maxParallelism is always context-dependent', () => {
    expect(computeMetricDelta(1, 5, undefined, 'context-dependent').better).toBe('context-dependent')
  })

  it('percent is 0 when old value is 0', () => {
    expect(computeMetricDelta(0, 50, undefined, 'lower-is-better').percent).toBe(0)
  })
})

describe('aggregatePrimary', () => {
  it('median of [10,20,30] is 20; no IQR for N<4', () => {
    const { median, stats } = aggregatePrimary([
      primary({ totalTokens: '10' }),
      primary({ totalTokens: '20' }),
      primary({ totalTokens: '30' }),
    ])
    expect(median.totalTokens).toBe('20')
    expect(stats.totalTokens.median).toBe(20)
    expect(stats.totalTokens.samples).toEqual([10, 20, 30])
    expect(stats.totalTokens.iqr).toBeUndefined()
  })

  it('IQR is defined for N>=4', () => {
    const { stats } = aggregatePrimary([
      primary({ totalTokens: '10' }),
      primary({ totalTokens: '20' }),
      primary({ totalTokens: '30' }),
      primary({ totalTokens: '40' }),
    ])
    expect(stats.totalTokens.iqr).toBeDefined()
  })

  it('successRank distribution: [4,4,3] -> median 4, min 3, max 4', () => {
    const { stats } = aggregatePrimary([
      primary({ successRank: 4 }),
      primary({ successRank: 4 }),
      primary({ successRank: 3 }),
    ])
    expect(stats.successRank.median).toBe(4)
    expect(stats.successRank.min).toBe(3)
    expect(stats.successRank.max).toBe(4)
  })
})

describe('aggregateSecondary', () => {
  it('merges perTool across runs (pooled errorRate, weighted duration)', () => {
    const a: SecondaryMetrics = {
      ...emptySecondary(),
      perTool: {
        bash: { count: 3, errorRate: 1 / 3, avgDurationMs: '200' },
      },
      finishCauseDistribution: { stop: 2 },
    }
    const b: SecondaryMetrics = {
      ...emptySecondary(),
      perTool: {
        bash: { count: 1, errorRate: 0, avgDurationMs: '400' },
        ls: { count: 2, errorRate: 0, avgDurationMs: '50' },
      },
      finishCauseDistribution: { 'tool-calls': 1 },
    }
    const out = aggregateSecondary([a, b])
    // bash: count 4, errors 1, durSum 200*3 + 400*1 = 1000 -> avg 250
    expect(out.perTool['bash']?.count).toBe(4)
    expect(out.perTool['bash']?.errorRate).toBeCloseTo(0.25, 3)
    expect(out.perTool['bash']?.avgDurationMs).toBe('250')
    expect(out.perTool['ls']?.count).toBe(2)
    expect(out.finishCauseDistribution['stop']).toBe(2)
    expect(out.finishCauseDistribution['tool-calls']).toBe(1)
  })

  it('empty input -> zero secondary', () => {
    const out = aggregateSecondary([])
    expect(out.perTool).toEqual({})
    expect(out.fileDiffStats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 })
  })
})

describe('buildSideAggregates', () => {
  const extracted = (over: Partial<PrimaryMetrics>): ExtractedMetrics => ({
    primary: primary(over),
    secondary: emptySecondary(),
  })

  it('aggregates successful runs and carries failedRuns', () => {
    const agg = buildSideAggregates({
      side: 'new',
      extracted: [extracted({ totalTokens: '10' }), extracted({ totalTokens: '30' })],
      failedRuns: [{ runIndex: 2, errorCode: 'E_RUN_CRASH', errorMessage: 'boom', timestamp: 't' }],
      rawRunIds: ['s1', 's3'],
    })
    expect(agg.side).toBe('new')
    expect(agg.primary.totalTokens).toBe('20') // median of [10,30]
    expect(agg.failedRuns).toHaveLength(1)
    expect(agg.failedRuns[0]?.errorCode).toBe('E_RUN_CRASH')
    expect(agg.rawRunIds).toEqual(['s1', 's3'])
  })

  it('no successful runs -> empty primary, empty samples, neutral-ready', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [],
      failedRuns: [],
      rawRunIds: [],
    })
    expect(agg.primary).toEqual({
      totalTokens: '0', wallClockMs: '0', costUsd: 0, stepCount: 0, toolCallCount: 0, successRank: 0, maxParallelism: 0,
    })
    expect(agg.stats.totalTokens.samples).toEqual([])
  })
})

describe('computeDelta', () => {
  it('both sides with samples -> computed deltas, bothFailed false', () => {
    const oldAgg = sideFromPrimary('old', [primary({ totalTokens: '100' })])
    const newAgg = sideFromPrimary('new', [primary({ totalTokens: '120' })])
    const diff = computeDelta(oldAgg, newAgg)
    expect(diff.bothFailed).toBe(false)
    expect(diff.deltas.totalTokens.absolute).toBe(20)
    expect(diff.deltas.totalTokens.better).toBe('worse')
    // no IQR (N=1) -> not significant
    expect(diff.deltas.totalTokens.significant).toBe(false)
  })

  it('one side empty -> neutral deltas, bothFailed false', () => {
    const oldAgg = sideFromPrimary('old', [primary({ totalTokens: '100' })])
    const newAgg = buildSideAggregates({ side: 'new', extracted: [], failedRuns: [], rawRunIds: [] })
    const diff = computeDelta(oldAgg, newAgg)
    expect(diff.bothFailed).toBe(false)
    expect(diff.deltas.totalTokens.better).toBe('neutral')
    expect(diff.deltas.totalTokens.significant).toBe(false)
  })

  it('both sides empty -> bothFailed true, all neutral', () => {
    const oldAgg = buildSideAggregates({ side: 'old', extracted: [], failedRuns: [], rawRunIds: [] })
    const newAgg = buildSideAggregates({ side: 'new', extracted: [], failedRuns: [], rawRunIds: [] })
    const diff = computeDelta(oldAgg, newAgg)
    expect(diff.bothFailed).toBe(true)
    expect(diff.deltas.maxParallelism.better).toBe('neutral')
  })
})
