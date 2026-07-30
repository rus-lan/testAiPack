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
  countStalls,
  STALL_THRESHOLD_MS,
} from './aggregate.js'
import type { EventsProfile } from './events-profile.js'
import type { ExtractedExtras, ExtractedMetrics } from './extract.js'
import { profileEvents } from './events-profile.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

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
  maxConsecutiveSameTool: 0,
})

const extras = (over: Partial<ExtractedExtras> = {}): ExtractedExtras => ({
  packCalls: 0,
  packErrors: 0,
  firstPackCallMs: undefined,
  invalidToolCalls: 0,
  duplicateToolCalls: 0,
  bashFailCount: 0,
  toolErrorTexts: [],
  riskyCommands: [],
  packActivitySignals: [],
  opencodeVersion: '1.18.4',
  firstStepInputTokens: undefined,
  lastStepInputTokens: undefined,
  textChars: 0,
  reasoningChars: 0,
  cacheWriteTokens: 0,
  ...over,
})

const profile = (over: Partial<EventsProfile> = {}): EventsProfile => ({
  timeToFirstToolMs: undefined,
  timeToFirstEditMs: undefined,
  maxEventGapMs: 0,
  gapsMs: [],
  ...over,
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

  it('percent is omitted for a 0 -> non-zero change (an infinite percent, not "no change")', () => {
    const d = computeMetricDelta(0, 50, undefined, 'lower-is-better')
    expect(d.absolute).toBe(50)
    expect(d.percent).toBeUndefined()
    expect('percent' in d).toBe(false)
  })

  it('percent stays 0 for a 0 -> 0 change (genuinely no change)', () => {
    expect(computeMetricDelta(0, 0, undefined, 'lower-is-better').percent).toBe(0)
  })

  it('percent is still computed normally for a non-zero -> 0 change', () => {
    expect(computeMetricDelta(50, 0, undefined, 'lower-is-better').percent).toBe(-100)
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
    const out = aggregateSecondary([a, b], [])
    // bash: count 4, errors 1, durSum 200*3 + 400*1 = 1000 -> avg 250
    expect(out.perTool['bash']?.count).toBe(4)
    expect(out.perTool['bash']?.errorRate).toBeCloseTo(0.25, 3)
    expect(out.perTool['bash']?.avgDurationMs).toBe('250')
    expect(out.perTool['ls']?.count).toBe(2)
    expect(out.finishCauseDistribution['stop']).toBe(2)
    expect(out.finishCauseDistribution['tool-calls']).toBe(1)
  })

  it('empty input -> zero secondary', () => {
    const out = aggregateSecondary([], [])
    expect(out.perTool).toEqual({})
    expect(out.maxConsecutiveSameTool).toBe(0)
  })

  it('merges the same tool name across non-adjacent runs (not pre-grouped)', () => {
    const a: SecondaryMetrics = {
      ...emptySecondary(),
      perTool: { zeta: { count: 1, errorRate: 0, avgDurationMs: '100' } },
    }
    const b: SecondaryMetrics = {
      ...emptySecondary(),
      perTool: { bash: { count: 2, errorRate: 0, avgDurationMs: '50' } },
    }
    const c: SecondaryMetrics = {
      ...emptySecondary(),
      perTool: { zeta: { count: 3, errorRate: 1 / 3, avgDurationMs: '300' } },
    }
    const out = aggregateSecondary([a, b, c], [])
    // zeta: count 1+3=4, durSum 100*1 + 300*3 = 1000 -> avg 250
    expect(out.perTool['zeta']?.count).toBe(4)
    expect(out.perTool['zeta']?.avgDurationMs).toBe('250')
    expect(out.perTool['bash']?.count).toBe(2)
  })
})

describe('buildSideAggregates', () => {
  const extracted = (over: Partial<PrimaryMetrics>): ExtractedMetrics => ({
    primary: primary(over),
    secondary: emptySecondary(),
    extras: extras(),
  })

  const baseInput = {
    extras: [] as readonly ExtractedExtras[],
    runIndexes: [] as readonly number[],
    eventsProfiles: [] as readonly EventsProfile[],
    canDetect: false,
    visibilityConfirmed: false,
  }

  it('aggregates successful runs and carries failedRuns', () => {
    const agg = buildSideAggregates({
      side: 'new',
      extracted: [extracted({ totalTokens: '10' }), extracted({ totalTokens: '30' })],
      failedRuns: [{ runIndex: 2, errorCode: 'E_RUN_CRASH', errorMessage: 'boom', timestamp: 't' }],
      rawRunIds: ['s1', 's3'],
      extras: [extras(), extras()],
      runIndexes: [1, 3],
      eventsProfiles: [],
      canDetect: false,
      visibilityConfirmed: false,
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
      ...baseInput,
    })
    expect(agg.primary).toEqual({
      totalTokens: '0', wallClockMs: '0', costUsd: 0, stepCount: 0, toolCallCount: 0, successRank: 0, maxParallelism: 0,
    })
    expect(agg.stats.totalTokens.samples).toEqual([])
    expect(agg.riskyCommands).toBeUndefined()
    expect(agg.opencodeVersions).toBeUndefined()
  })
})

describe('buildSideAggregates — contaminationSignals only ever surface on the baseline (old) side', () => {
  const extracted = (): ExtractedMetrics => ({
    primary: primary({}),
    secondary: emptySecondary(),
    extras: extras(),
  })

  it('attaches runIndex to per-run activity signals and appends the config-drift signal, on old', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [extracted(), extracted()],
      failedRuns: [],
      rawRunIds: ['s1', 's2'],
      extras: [
        extras({ packActivitySignals: [{ kind: 'bash-install', detail: 'npm install -g @sentropic/graphify' }] }),
        extras({ packActivitySignals: [] }),
      ],
      runIndexes: [1, 2],
      eventsProfiles: [],
      canDetect: false,
      visibilityConfirmed: false,
      configDriftSignal: { kind: 'install-drift', detail: "captured config differs across this side's own runs in: skills" },
    })
    expect(agg.contaminationSignals).toEqual([
      { kind: 'bash-install', detail: 'npm install -g @sentropic/graphify', runIndex: 1 },
      { kind: 'install-drift', detail: "captured config differs across this side's own runs in: skills" },
    ])
  })

  it('present but empty on old when nothing was observed — checked and clean, not "not checked"', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [extracted()],
      failedRuns: [],
      rawRunIds: ['s1'],
      extras: [extras()],
      runIndexes: [1],
      eventsProfiles: [],
      canDetect: false,
      visibilityConfirmed: false,
    })
    expect(agg.contaminationSignals).toEqual([])
  })

  it('never surfaced on new, even with the same signals present in extras', () => {
    const agg = buildSideAggregates({
      side: 'new',
      extracted: [extracted()],
      failedRuns: [],
      rawRunIds: ['s1'],
      extras: [extras({ packActivitySignals: [{ kind: 'skill-call', detail: 'skill tool call succeeded for "graphify"' }] })],
      runIndexes: [1],
      eventsProfiles: [],
      canDetect: true,
      visibilityConfirmed: true,
      configDriftSignal: { kind: 'install-drift', detail: 'irrelevant on new' },
    })
    expect(agg.contaminationSignals).toBeUndefined()
  })
})

describe('aggregateSecondary — wave-1 rare-event sums', () => {
  const list3 = [emptySecondary(), emptySecondary(), emptySecondary()]

  it('sums invalid/duplicate/bashFail across runs, not median — (0,0,3) -> 3', () => {
    const out = aggregateSecondary(list3, [
      extras({ bashFailCount: 0 }),
      extras({ bashFailCount: 0 }),
      extras({ bashFailCount: 3 }),
    ])
    expect(out.bashFailCount).toBe(3)
  })

  it('invalidToolCalls and duplicateToolCalls also sum, present even when 0', () => {
    const out = aggregateSecondary(list3, [
      extras({ invalidToolCalls: 1, duplicateToolCalls: 2 }),
      extras({ invalidToolCalls: 0, duplicateToolCalls: 0 }),
      extras({ invalidToolCalls: 0, duplicateToolCalls: 1 }),
    ])
    expect(out.invalidToolCalls).toBe(1)
    expect(out.duplicateToolCalls).toBe(3)
  })

  it('toolErrorTexts: top-5 by frequency, deduped', () => {
    const out = aggregateSecondary(list3, [
      extras({ toolErrorTexts: ['a', 'a', 'b'] }),
      extras({ toolErrorTexts: ['a'] }),
      extras({ toolErrorTexts: ['c'] }),
    ])
    // a x3, b x1, c x1 -> a first, all 3 distinct texts fit in top 5
    expect(out.toolErrorTexts).toEqual(['a', 'b', 'c'])
  })

  it('wave-2 medians: firstStep/lastStep/textChars/reasoningChars/cacheWrite median across runs', () => {
    const out = aggregateSecondary(list3, [
      extras({ firstStepInputTokens: 100, lastStepInputTokens: 200, textChars: 10, reasoningChars: 20, cacheWriteTokens: 1 }),
      extras({ firstStepInputTokens: 100, lastStepInputTokens: 300, textChars: 20, reasoningChars: 30, cacheWriteTokens: 2 }),
      extras({ firstStepInputTokens: 100, lastStepInputTokens: 400, textChars: 30, reasoningChars: 40, cacheWriteTokens: 3 }),
    ])
    expect(out.firstStepInputTokens).toBe('100')
    expect(out.lastStepInputTokens).toBe('300')
    expect(out.textChars).toBe('20')
    expect(out.reasoningChars).toBe('30')
    expect(out.cacheWriteTokens).toBe('2')
  })

  it('step-token medians over defined values only, omitted when none defined', () => {
    const definedOnly = aggregateSecondary(list3, [
      extras({ lastStepInputTokens: undefined }),
      extras({ lastStepInputTokens: 100 }),
      extras({ lastStepInputTokens: 300 }),
    ])
    expect(definedOnly.lastStepInputTokens).toBe('200') // median of [100, 300]

    const noneDefined = aggregateSecondary(list3, [
      extras({ lastStepInputTokens: undefined }),
      extras({ lastStepInputTokens: undefined }),
      extras({ lastStepInputTokens: undefined }),
    ])
    expect(noneDefined.lastStepInputTokens).toBeUndefined()
  })

  it('timeToFirstToolMs median over defined values', () => {
    const out = aggregateSecondary(list3, [extras(), extras(), extras()], [
      profile({ timeToFirstToolMs: 100 }),
      profile({ timeToFirstToolMs: 200 }),
      profile({ timeToFirstToolMs: 300 }),
    ])
    expect(out.timeToFirstToolMs).toBe('200')
  })

  it('timeToFirstEditMs median over runs-that-edited, omitted when none edited', () => {
    const out = aggregateSecondary(list3, [extras(), extras(), extras()], [
      profile({ timeToFirstEditMs: undefined }),
      profile({ timeToFirstEditMs: 500 }),
      profile({ timeToFirstEditMs: undefined }),
    ])
    expect(out.timeToFirstEditMs).toBe('500')

    const noEdits = aggregateSecondary(list3, [extras(), extras(), extras()], [
      profile({ timeToFirstEditMs: undefined }),
      profile({ timeToFirstEditMs: undefined }),
      profile({ timeToFirstEditMs: undefined }),
    ])
    expect(noEdits.timeToFirstEditMs).toBeUndefined()
  })

  it('maxEventGapMs is MAX across runs, not median — (10s, 10s, 240s) -> 240s', () => {
    const out = aggregateSecondary(list3, [extras(), extras(), extras()], [
      profile({ maxEventGapMs: 10000 }),
      profile({ maxEventGapMs: 10000 }),
      profile({ maxEventGapMs: 240000 }),
    ])
    expect(out.maxEventGapMs).toBe('240000')
  })

  it('aggregateSecondary wires stallCount/stalledRunCount from countStalls (default 60s threshold)', () => {
    const out = aggregateSecondary(list3, [extras(), extras(), extras()], [
      profile({ gapsMs: [70000, 10000] }), // 1 stall
      profile({ gapsMs: [5000] }), // 0 stalls
      profile({ gapsMs: [90000, 65000] }), // 2 stalls
    ])
    expect(out.stallCount).toBe(3)
    expect(out.stalledRunCount).toBe(2)
  })

  it('stallCount/stalledRunCount omitted when there are no eventsProfiles at all', () => {
    const out = aggregateSecondary(list3, [extras(), extras(), extras()], [])
    expect(out.stallCount).toBeUndefined()
    expect(out.stalledRunCount).toBeUndefined()
  })

  it('explicitly empty extras/eventsProfiles -> wave-1/2 fields omitted (base secondary still built from list)', () => {
    // extras is required (no default) precisely so a caller with a non-empty
    // `list` cannot omit it by accident and get these fields fabricated as 0.
    const out = aggregateSecondary(list3, [])
    expect(out.invalidToolCalls).toBe(0)
    expect(out.toolErrorTexts).toEqual([])
    expect(out.timeToFirstToolMs).toBeUndefined()
    expect(out.maxEventGapMs).toBeUndefined()
  })
})

describe('countStalls — threshold is a caller choice, not baked into the parser', () => {
  it('one run stalled once vs four runs stalled repeatedly render differently', () => {
    const oneRunOnce = countStalls([
      profile({ gapsMs: [1000, 65000, 2000] }),
      profile({ gapsMs: [500, 800] }),
    ])
    expect(oneRunOnce).toEqual({ stallCount: 1, runsWithStall: 1 })

    const fourRunsRepeatedly = countStalls([
      profile({ gapsMs: [70000, 61000] }),
      profile({ gapsMs: [90000] }),
      profile({ gapsMs: [200000, 61000, 61000] }),
      profile({ gapsMs: [61000] }),
    ])
    expect(fourRunsRepeatedly).toEqual({ stallCount: 7, runsWithStall: 4 })
  })

  it('gaps exactly at the threshold do not count (strictly greater than)', () => {
    expect(countStalls([profile({ gapsMs: [STALL_THRESHOLD_MS] })])).toEqual({
      stallCount: 0,
      runsWithStall: 0,
    })
    expect(countStalls([profile({ gapsMs: [STALL_THRESHOLD_MS + 1] })])).toEqual({
      stallCount: 1,
      runsWithStall: 1,
    })
  })

  it('no gaps anywhere -> zero, not undefined', () => {
    expect(countStalls([profile(), profile()])).toEqual({ stallCount: 0, runsWithStall: 0 })
  })

  it('empty profiles list -> zero', () => {
    expect(countStalls([])).toEqual({ stallCount: 0, runsWithStall: 0 })
  })

  it('custom threshold overrides the default', () => {
    const out = countStalls([profile({ gapsMs: [5000] })], 1000)
    expect(out).toEqual({ stallCount: 1, runsWithStall: 1 })
  })
})

// ---------------------------------------------------------------------------
// Real ground truth — same sample workspace as events-profile.test.ts. Pins
// countStalls' default 60s threshold against the actual incident run.
// ---------------------------------------------------------------------------

const GOLDEN_ROOT = '/home/ruslan/.testaipack/2026-07-29_20-44-07_ed1eeb/results/raw'
const hasGoldenWorkspace = existsSync(GOLDEN_ROOT)

describe.skipIf(!hasGoldenWorkspace)('countStalls — real ground truth (golden-values.md)', () => {
  it('old side: run-1 (252915ms) and run-2 (50733ms, below 60s) — only run-1 stalls', () => {
    const profiles = [1, 2, 3, 4, 5].map((n) =>
      profileEvents(readFileSync(path.join(GOLDEN_ROOT, 'old', `run-${String(n)}.events.ndjson`), 'utf8')),
    )
    const out = countStalls(profiles)
    expect(out.runsWithStall).toBe(1)
    expect(out.stallCount).toBeGreaterThanOrEqual(1)
  })

  it('new side: run-2 (240663ms) is the only run over 60s', () => {
    const profiles = [1, 2, 3, 4, 5].map((n) =>
      profileEvents(readFileSync(path.join(GOLDEN_ROOT, 'new', `run-${String(n)}.events.ndjson`), 'utf8')),
    )
    const out = countStalls(profiles)
    expect(out.runsWithStall).toBe(1)
    expect(out.stallCount).toBeGreaterThanOrEqual(1)
  })
})

describe('buildSideAggregates — packUse / riskyCommands / opencodeVersions', () => {
  it('packUse omitted without packName', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [{ primary: primary({}), secondary: emptySecondary(), extras: extras({ packCalls: 1 }) }],
      failedRuns: [],
      rawRunIds: ['s1'],
      extras: [extras({ packCalls: 1 })],
      runIndexes: [1],
      eventsProfiles: [],
      canDetect: true,
      visibilityConfirmed: true,
    })
    expect(agg.packUse).toBeUndefined()
  })

  it('packUse: sums, runsWithCall, runCount, median firstCall over defined values only', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [1, 2, 3].map(() => ({ primary: primary({}), secondary: emptySecondary(), extras: extras() })),
      failedRuns: [],
      rawRunIds: ['s1', 's2', 's3'],
      extras: [
        extras({ packCalls: 1, packErrors: 0, firstPackCallMs: 100 }),
        extras({ packCalls: 0 }),
        extras({ packCalls: 2, packErrors: 1, firstPackCallMs: 300 }),
      ],
      runIndexes: [1, 2, 3],
      eventsProfiles: [],
      packName: 'graphify',
      canDetect: true,
      visibilityConfirmed: true,
    })
    expect(agg.packUse).toEqual({
      calls: 3,
      errors: 1,
      runsWithCall: 2,
      runCount: 3,
      firstCallMsMedian: '200',
      canDetect: true,
      visibilityConfirmed: true,
    })
  })

  it('riskyCommands concatenated with runIndex attached', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [1, 2].map(() => ({ primary: primary({}), secondary: emptySecondary(), extras: extras() })),
      failedRuns: [],
      rawRunIds: ['s1', 's2'],
      extras: [
        extras({ riskyCommands: [{ command: 'rm -rf x', completed: true, exitCode: 0 }] }),
        extras({ riskyCommands: [] }),
      ],
      runIndexes: [1, 2],
      eventsProfiles: [],
      canDetect: false,
      visibilityConfirmed: false,
    })
    expect(agg.riskyCommands).toEqual([{ command: 'rm -rf x', completed: true, exitCode: 0, runIndex: 1 }])
  })

  it('opencodeVersions distinct + sorted', () => {
    const agg = buildSideAggregates({
      side: 'old',
      extracted: [1, 2, 3].map(() => ({ primary: primary({}), secondary: emptySecondary(), extras: extras() })),
      failedRuns: [],
      rawRunIds: ['s1', 's2', 's3'],
      extras: [
        extras({ opencodeVersion: '1.18.4' }),
        extras({ opencodeVersion: '1.18.3' }),
        extras({ opencodeVersion: '1.18.4' }),
      ],
      runIndexes: [1, 2, 3],
      eventsProfiles: [],
      canDetect: false,
      visibilityConfirmed: false,
    })
    expect(agg.opencodeVersions).toEqual(['1.18.3', '1.18.4'])
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
    const newAgg = buildSideAggregates({
      side: 'new', extracted: [], failedRuns: [], rawRunIds: [],
      extras: [], runIndexes: [], eventsProfiles: [], canDetect: false, visibilityConfirmed: false,
    })
    const diff = computeDelta(oldAgg, newAgg)
    expect(diff.bothFailed).toBe(false)
    expect(diff.deltas.totalTokens.better).toBe('neutral')
    expect(diff.deltas.totalTokens.significant).toBe(false)
  })

  it('both sides empty -> bothFailed true, all neutral', () => {
    const oldAgg = buildSideAggregates({
      side: 'old', extracted: [], failedRuns: [], rawRunIds: [],
      extras: [], runIndexes: [], eventsProfiles: [], canDetect: false, visibilityConfirmed: false,
    })
    const newAgg = buildSideAggregates({
      side: 'new', extracted: [], failedRuns: [], rawRunIds: [],
      extras: [], runIndexes: [], eventsProfiles: [], canDetect: false, visibilityConfirmed: false,
    })
    const diff = computeDelta(oldAgg, newAgg)
    expect(diff.bothFailed).toBe(true)
    expect(diff.deltas.maxParallelism.better).toBe('neutral')
  })

  it('old side empty (0 tokens) vs a new side with tokens -> percent omitted, not 0', () => {
    const oldAgg = buildSideAggregates({
      side: 'old', extracted: [], failedRuns: [], rawRunIds: [],
      extras: [], runIndexes: [], eventsProfiles: [], canDetect: false, visibilityConfirmed: false,
    })
    const newAgg = sideFromPrimary('new', [primary({ totalTokens: '100' })])
    const diff = computeDelta(oldAgg, newAgg)
    expect(diff.deltas.totalTokens.absolute).toBe(100)
    expect(diff.deltas.totalTokens.percent).toBeUndefined()
  })
})
