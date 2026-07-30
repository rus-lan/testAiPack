/**
 * Metrics: aggregate — median / min / max / IQR across the successful runs of
 * one side, and the new-minus-old delta (MetricsDiff). All pure.
 *
 * @see docs/phases/07-aggregate.ru.md
 * @see contract/main.tsp (SideAggregates, MetricsDiff, MetricDistribution)
 */
import type {
  AggregateStats,
  ContaminationSignal,
  FailedRun,
  MetricDelta,
  MetricDistribution,
  MetricsDiff,
  PackUse,
  PrimaryMetrics,
  RiskyCommand,
  SecondaryMetrics,
  Side,
  SideAggregates,
  ToolStat,
  VerifyStats,
} from '@generated/types'
import type { EventsProfile } from './events-profile.js'
import type { ExtractedExtras, ExtractedMetrics } from './extract.js'
import type { UnindexedSignal } from './baseline-contamination.js'
import { interquartileRange, maximum, median, minimum, percentile, toNum } from './stats.js'
import { isSignificant } from './significance.js'

const dist = (samples: readonly number[]): MetricDistribution => {
  const q = interquartileRange(samples)
  return {
    median: median(samples),
    min: minimum(samples),
    max: maximum(samples),
    samples: [...samples],
    ...(q === undefined ? {} : { iqr: q }),
  }
}

const round = (n: number): number => Math.round(n)

export const aggregatePrimary = (
  list: readonly PrimaryMetrics[],
): { readonly median: PrimaryMetrics; readonly stats: AggregateStats } => {
  const totalTokens = list.map((m) => toNum(m.totalTokens))
  const wallClockMs = list.map((m) => toNum(m.wallClockMs))
  const costUsd = list.map((m) => m.costUsd)
  const stepCount = list.map((m) => m.stepCount)
  const toolCallCount = list.map((m) => m.toolCallCount)
  const successRank = list.map((m) => m.successRank)
  const maxParallelism = list.map((m) => m.maxParallelism)

  const primaryMedian: PrimaryMetrics = {
    totalTokens: String(round(median(totalTokens))),
    wallClockMs: String(round(median(wallClockMs))),
    costUsd: median(costUsd),
    stepCount: round(median(stepCount)),
    toolCallCount: round(median(toolCallCount)),
    successRank: round(median(successRank)),
    maxParallelism: round(median(maxParallelism)),
  }

  const stats: AggregateStats = {
    totalTokens: dist(totalTokens),
    wallClockMs: dist(wallClockMs),
    costUsd: dist(costUsd),
    stepCount: dist(stepCount),
    toolCallCount: dist(toolCallCount),
    successRank: dist(successRank),
  }

  return { median: primaryMedian, stats }
}

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

interface PerToolMerge {
  readonly count: number
  readonly errors: number
  readonly durSum: number
}

interface PerToolFold {
  readonly key: string | null
  readonly acc: PerToolMerge
  readonly out: readonly (readonly [string, PerToolMerge])[]
}

const EMPTY_PER_TOOL_MERGE: PerToolMerge = { count: 0, errors: 0, durSum: 0 }

const flushPerToolRun = (fold: PerToolFold): readonly (readonly [string, PerToolMerge])[] =>
  fold.key === null ? fold.out : [...fold.out, [fold.key, fold.acc] as const]

/**
 * Merges per-run tool tables by name in one pass over all runs' entries
 * sorted by name: the output list only grows on a name change (bounded by
 * distinct tool count), not once per entry, so this stays O(n log n) instead
 * of the "spread the whole map every entry" O(n^2) shape.
 */
const mergePerTool = (records: readonly Record<string, ToolStat>[]): Record<string, ToolStat> => {
  const entries = records.flatMap((rec) => Object.entries(rec))
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const folded = sorted.reduce<PerToolFold>((fold, [name, stat]) => {
    const inc: PerToolMerge = {
      count: stat.count,
      errors: Math.round(stat.errorRate * stat.count),
      durSum: toNum(stat.avgDurationMs) * stat.count,
    }
    if (fold.key === name) {
      return {
        ...fold,
        acc: {
          count: fold.acc.count + inc.count,
          errors: fold.acc.errors + inc.errors,
          durSum: fold.acc.durSum + inc.durSum,
        },
      }
    }
    return { key: name, acc: inc, out: flushPerToolRun(fold) }
  }, { key: null, acc: EMPTY_PER_TOOL_MERGE, out: [] })
  return Object.fromEntries(
    flushPerToolRun(folded).map(([name, v]): readonly [string, ToolStat] => [
      name,
      {
        count: v.count,
        errorRate: v.count === 0 ? 0 : v.errors / v.count,
        avgDurationMs: String(v.count === 0 ? 0 : Math.round(v.durSum / v.count)),
      },
    ]),
  )
}

const mergeFinishCause = (records: readonly Record<string, number>[]): Record<string, number> =>
  records.reduce<Record<string, number>>((out, rec) => {
    return Object.entries(rec).reduce<Record<string, number>>((inner, [k, v]) => ({
      ...inner,
      [k]: (inner[k] ?? 0) + v,
    }), out)
  }, {})

/** Top distinct texts by frequency (ties keep first-seen order — `Array.sort` is stable). */
const topByFrequency = (texts: readonly string[], limit: number): readonly string[] => {
  const counts = texts.reduce<Readonly<Record<string, number>>>(
    (m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }),
    {},
  )
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([t]) => t)
}

const TOOL_ERROR_TEXTS_LIMIT = 5

/**
 * A gap this long between two consecutive streamed events (text/tool/
 * reasoning/step) is not normal per-step latency — every per-tool duration
 * observed in real runs is single-digit to low-triple-digit milliseconds —
 * it reads as the agent or model being stuck, not thinking. The threshold is
 * a caller-side choice (see `EventsProfile.gapsMs` doc); `events-profile.ts`
 * itself stays threshold-agnostic.
 */
export const STALL_THRESHOLD_MS = 60_000

export interface StallStats {
  /** Sum across runs of gaps exceeding the threshold. */
  readonly stallCount: number
  /** Number of runs with at least one such gap. */
  readonly runsWithStall: number
}

/** Counts gaps over `thresholdMs` across runs, and how many runs had at least one. */
export const countStalls = (
  profiles: readonly EventsProfile[],
  thresholdMs: number = STALL_THRESHOLD_MS,
): StallStats =>
  profiles.reduce<StallStats>(
    (acc, p) => {
      const hits = p.gapsMs.filter((g) => g > thresholdMs).length
      return {
        stallCount: acc.stallCount + hits,
        runsWithStall: acc.runsWithStall + (hits > 0 ? 1 : 0),
      }
    },
    { stallCount: 0, runsWithStall: 0 },
  )

/** Median over the defined values only; `undefined` when none are defined. */
const definedMedian64 = (vals: readonly (number | undefined)[]): string | undefined => {
  const defined = vals.filter((v): v is number => v !== undefined)
  return defined.length === 0 ? undefined : String(round(median(defined)))
}

export const aggregateSecondary = (
  list: readonly SecondaryMetrics[],
  extras: readonly ExtractedExtras[],
  eventsProfiles: readonly EventsProfile[] = [],
): SecondaryMetrics => {
  if (list.length === 0) return emptySecondary()
  const numMedian = (vals: readonly string[]): string =>
    String(round(median(vals.map(toNum))))
  const timeToFirstToolMs = definedMedian64(eventsProfiles.map((p) => p.timeToFirstToolMs))
  const timeToFirstEditMs = definedMedian64(eventsProfiles.map((p) => p.timeToFirstEditMs))
  const maxEventGapMs =
    eventsProfiles.length === 0
      ? undefined
      : String(Math.round(Math.max(...eventsProfiles.map((p) => p.maxEventGapMs))))
  const stalls = eventsProfiles.length === 0 ? undefined : countStalls(eventsProfiles)
  const firstStepInputTokens = definedMedian64(extras.map((e) => e.firstStepInputTokens))
  const lastStepInputTokens = definedMedian64(extras.map((e) => e.lastStepInputTokens))
  return {
    inputTokens: numMedian(list.map((m) => m.inputTokens)),
    outputTokens: numMedian(list.map((m) => m.outputTokens)),
    reasoningTokens: numMedian(list.map((m) => m.reasoningTokens)),
    cacheReadTokens: numMedian(list.map((m) => m.cacheReadTokens)),
    perTool: mergePerTool(list.map((m) => m.perTool)),
    reasoningTimeMs: numMedian(list.map((m) => m.reasoningTimeMs)),
    stepLatencyP50Ms: numMedian(list.map((m) => m.stepLatencyP50Ms)),
    stepLatencyP95Ms: numMedian(list.map((m) => m.stepLatencyP95Ms)),
    toolLatencyAvgMs: numMedian(list.map((m) => m.toolLatencyAvgMs)),
    finishCauseDistribution: mergeFinishCause(list.map((m) => m.finishCauseDistribution)),
    maxConsecutiveSameTool: round(median(list.map((m) => m.maxConsecutiveSameTool))),
    // Rare-event counters SUM across runs — a median would hide (0,0,0,0,3) as 0.
    invalidToolCalls: extras.reduce((a, e) => a + e.invalidToolCalls, 0),
    duplicateToolCalls: extras.reduce((a, e) => a + e.duplicateToolCalls, 0),
    bashFailCount: extras.reduce((a, e) => a + e.bashFailCount, 0),
    toolErrorTexts: [
      ...topByFrequency(
        extras.flatMap((e) => e.toolErrorTexts),
        TOOL_ERROR_TEXTS_LIMIT,
      ),
    ],
    ...(timeToFirstToolMs === undefined ? {} : { timeToFirstToolMs }),
    ...(timeToFirstEditMs === undefined ? {} : { timeToFirstEditMs }),
    ...(maxEventGapMs === undefined ? {} : { maxEventGapMs }),
    ...(stalls === undefined ? {} : { stallCount: stalls.stallCount, stalledRunCount: stalls.runsWithStall }),
    ...(firstStepInputTokens === undefined ? {} : { firstStepInputTokens }),
    ...(lastStepInputTokens === undefined ? {} : { lastStepInputTokens }),
    textChars: numMedian(extras.map((e) => String(e.textChars))),
    reasoningChars: numMedian(extras.map((e) => String(e.reasoningChars))),
    cacheWriteTokens: numMedian(extras.map((e) => String(e.cacheWriteTokens))),
  }
}

const buildPackUse = (
  extras: readonly ExtractedExtras[],
  packName: string | undefined,
  canDetect: boolean,
  visibilityConfirmed: boolean,
): PackUse | undefined => {
  if (packName === undefined) return undefined
  const firstTimes = extras.flatMap((e) => (e.firstPackCallMs === undefined ? [] : [e.firstPackCallMs]))
  const firstCallMsMedian = firstTimes.length === 0 ? undefined : String(round(median(firstTimes)))
  return {
    calls: extras.reduce((a, e) => a + e.packCalls, 0),
    errors: extras.reduce((a, e) => a + e.packErrors, 0),
    runsWithCall: extras.filter((e) => e.packCalls > 0).length,
    runCount: extras.length,
    canDetect,
    visibilityConfirmed,
    ...(firstCallMsMedian === undefined ? {} : { firstCallMsMedian }),
  }
}

const buildRiskyCommands = (
  extras: readonly ExtractedExtras[],
  runIndexes: readonly number[],
): readonly RiskyCommand[] =>
  extras.flatMap((e, i) => e.riskyCommands.map((r) => ({ ...r, runIndex: runIndexes[i] ?? 0 })))

const buildOpencodeVersions = (extras: readonly ExtractedExtras[]): readonly string[] =>
  [...new Set(extras.map((e) => e.opencodeVersion).filter((v) => v !== ''))].sort()

/**
 * Per-run activity signals (attach `runIndex`, same as `buildRiskyCommands`)
 * plus the side-level config-drift signal, if any. Only ever called for the
 * `old` (baseline) side — see `buildSideAggregates`.
 */
const buildContaminationSignals = (
  extras: readonly ExtractedExtras[],
  runIndexes: readonly number[],
  configDrift: UnindexedSignal | undefined,
): readonly ContaminationSignal[] => [
  ...extras.flatMap((e, i) =>
    e.packActivitySignals.map((s): ContaminationSignal => ({ ...s, runIndex: runIndexes[i] ?? 0 })),
  ),
  ...(configDrift === undefined ? [] : [configDrift]),
]

const emptyPrimary = (): PrimaryMetrics => ({
  totalTokens: '0',
  wallClockMs: '0',
  costUsd: 0,
  stepCount: 0,
  toolCallCount: 0,
  successRank: 0,
  maxParallelism: 0,
})

const emptyStats = (): AggregateStats => ({
  totalTokens: dist([]),
  wallClockMs: dist([]),
  costUsd: dist([]),
  stepCount: dist([]),
  toolCallCount: dist([]),
  successRank: dist([]),
})

export interface SideAggregationInput {
  readonly side: Side
  readonly extracted: readonly ExtractedMetrics[]
  readonly failedRuns: readonly FailedRun[]
  readonly rawRunIds: readonly string[]
  /** Parallel to `extracted` — one entry per successfully-extracted run. */
  readonly extras: readonly ExtractedExtras[]
  /** Parallel to `extracted` — the run index each entry came from. */
  readonly runIndexes: readonly number[]
  /** Parallel to `extracted` — P5 latency profile of the run's events.ndjson. */
  readonly eventsProfiles: readonly EventsProfile[]
  /** The skill pack name to match, when `--pack` resolved to a skill. Absent -> packUse omitted. */
  readonly packName?: string
  /** Whether the pack type can be seen in exports at all (false for plugin/mcp/agent/command). */
  readonly canDetect: boolean
  /**
   * Whether phase 05's pack-visibility gate proved the pack was present in
   * this side's HOME before any run started. Always false for the old side —
   * the pack is deliberately never installed there.
   */
  readonly visibilityConfirmed: boolean
  /** Computed by phase 07 from side results (§1.6); passed through unchanged. */
  readonly verifyStats?: VerifyStats
  /**
   * The captured-config drift signal for this side (from `installed.json`,
   * read by phase 07) — only surfaced when `side === 'old'`; see
   * `baseline-contamination.ts`.
   */
  readonly configDriftSignal?: UnindexedSignal
}

export const buildSideAggregates = (input: SideAggregationInput): SideAggregates => {
  const packUse = buildPackUse(input.extras, input.packName, input.canDetect, input.visibilityConfirmed)
  if (input.extracted.length === 0) {
    return {
      side: input.side,
      primary: emptyPrimary(),
      secondary: emptySecondary(),
      stats: emptyStats(),
      failedRuns: [...input.failedRuns],
      rawRunIds: [...input.rawRunIds],
      ...(packUse === undefined ? {} : { packUse }),
      ...(input.verifyStats === undefined ? {} : { verifyStats: input.verifyStats }),
      // riskyCommands / opencodeVersions omitted — no successful run was ever inspected.
    }
  }
  const { median: primary, stats } = aggregatePrimary(input.extracted.map((e) => e.primary))
  const secondary = aggregateSecondary(input.extracted.map((e) => e.secondary), input.extras, input.eventsProfiles)
  return {
    side: input.side,
    primary,
    secondary,
    stats,
    failedRuns: [...input.failedRuns],
    rawRunIds: [...input.rawRunIds],
    ...(packUse === undefined ? {} : { packUse }),
    riskyCommands: [...buildRiskyCommands(input.extras, input.runIndexes)],
    opencodeVersions: [...buildOpencodeVersions(input.extras)],
    ...(input.verifyStats === undefined ? {} : { verifyStats: input.verifyStats }),
    // Contamination only means anything on the baseline — the pack side is
    // SUPPOSED to show pack activity, so the signal is never computed there.
    ...(input.side === 'old'
      ? { contaminationSignals: [...buildContaminationSignals(input.extras, input.runIndexes, input.configDriftSignal)] }
      : {}),
  }
}

export type DeltaDirection = 'lower-is-better' | 'higher-is-better' | 'context-dependent'

const betterOf = (absolute: number, direction: DeltaDirection): MetricDelta['better'] => {
  if (direction === 'context-dependent') return 'context-dependent'
  if (absolute === 0) return 'neutral'
  if (direction === 'lower-is-better') return absolute < 0 ? 'better' : 'worse'
  return absolute > 0 ? 'better' : 'worse'
}

/**
 * `percent` has no meaningful value for a 0 → non-zero change (mathematically
 * an infinite percentage) — omitted rather than reported as the misleading
 * `0`. `0 → 0` stays `0` (no change); every other baseline divides normally.
 */
const percentDelta = (oldValue: number, absolute: number): number | undefined => {
  if (oldValue === 0) return absolute === 0 ? 0 : undefined
  return (absolute / oldValue) * 100
}

/**
 * Single-metric delta. Exposed for table testing; `computeDelta` wires the
 * side-aggregate values + old-side IQR into it.
 */
export const computeMetricDelta = (
  oldValue: number,
  newValue: number,
  iqrVal: number | undefined,
  direction: DeltaDirection,
): MetricDelta => {
  const absolute = newValue - oldValue
  const percent = percentDelta(oldValue, absolute)
  return {
    absolute,
    ...(percent === undefined ? {} : { percent }),
    significant: isSignificant(absolute, iqrVal),
    better: betterOf(absolute, direction),
  }
}

const sideHasSamples = (agg: SideAggregates): boolean =>
  agg.stats.totalTokens.samples.length > 0

export const computeDelta = (oldAgg: SideAggregates, newAgg: SideAggregates): MetricsDiff => {
  const bothFailed = !sideHasSamples(oldAgg) && !sideHasSamples(newAgg)
  const anyFailed = !sideHasSamples(oldAgg) || !sideHasSamples(newAgg)

  const deltaFor = (
    oldValue: number,
    newValue: number,
    iqrVal: number | undefined,
    direction: DeltaDirection,
  ): MetricDelta => {
    if (anyFailed) {
      const absolute = newValue - oldValue
      const percent = percentDelta(oldValue, absolute)
      return {
        absolute,
        ...(percent === undefined ? {} : { percent }),
        significant: false,
        better: 'neutral',
      }
    }
    return computeMetricDelta(oldValue, newValue, iqrVal, direction)
  }

  const deltas = {
    totalTokens: deltaFor(
      toNum(oldAgg.primary.totalTokens),
      toNum(newAgg.primary.totalTokens),
      oldAgg.stats.totalTokens.iqr,
      'lower-is-better',
    ),
    wallClockMs: deltaFor(
      toNum(oldAgg.primary.wallClockMs),
      toNum(newAgg.primary.wallClockMs),
      oldAgg.stats.wallClockMs.iqr,
      'lower-is-better',
    ),
    costUsd: deltaFor(
      oldAgg.primary.costUsd,
      newAgg.primary.costUsd,
      oldAgg.stats.costUsd.iqr,
      'lower-is-better',
    ),
    stepCount: deltaFor(
      oldAgg.primary.stepCount,
      newAgg.primary.stepCount,
      oldAgg.stats.stepCount.iqr,
      'lower-is-better',
    ),
    toolCallCount: deltaFor(
      oldAgg.primary.toolCallCount,
      newAgg.primary.toolCallCount,
      oldAgg.stats.toolCallCount.iqr,
      'lower-is-better',
    ),
    successRank: deltaFor(
      oldAgg.primary.successRank,
      newAgg.primary.successRank,
      oldAgg.stats.successRank.iqr,
      'higher-is-better',
    ),
    maxParallelism: deltaFor(
      oldAgg.primary.maxParallelism,
      newAgg.primary.maxParallelism,
      undefined,
      'context-dependent',
    ),
  }

  return { old: oldAgg, new: newAgg, deltas, bothFailed }
}

export { percentile }
