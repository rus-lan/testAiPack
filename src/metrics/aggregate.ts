/**
 * Metrics: aggregate — median / min / max / IQR across the successful runs of
 * one side, and the new-minus-old delta (MetricsDiff). All pure.
 *
 * @see docs/phases/07-aggregate.ru.md
 * @see contract/main.tsp (SideAggregates, MetricsDiff, MetricDistribution)
 */
import type {
  AggregateStats,
  FailedRun,
  MetricDelta,
  MetricDistribution,
  MetricsDiff,
  PrimaryMetrics,
  SecondaryMetrics,
  Side,
  SideAggregates,
  ToolStat,
} from '@generated/types'
import type { ExtractedMetrics } from './extract.js'
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
  fileDiffStats: { additions: 0, deletions: 0, filesChanged: 0 },
  maxConsecutiveSameTool: 0,
})

interface PerToolMerge {
  readonly count: number
  readonly errors: number
  readonly durSum: number
}

const mergePerTool = (records: readonly Record<string, ToolStat>[]): Record<string, ToolStat> => {
  const acc = records.reduce<Record<string, PerToolMerge>>((out, rec) => {
    return Object.entries(rec).reduce<Record<string, PerToolMerge>>((inner, [name, stat]) => {
      const prev = inner[name] ?? { count: 0, errors: 0, durSum: 0 }
      return {
        ...inner,
        [name]: {
          count: prev.count + stat.count,
          errors: prev.errors + Math.round(stat.errorRate * stat.count),
          durSum: prev.durSum + toNum(stat.avgDurationMs) * stat.count,
        },
      }
    }, out)
  }, {})
  return Object.entries(acc).reduce<Record<string, ToolStat>>((out, [name, v]) => ({
    ...out,
    [name]: {
      count: v.count,
      errorRate: v.count === 0 ? 0 : v.errors / v.count,
      avgDurationMs: String(v.count === 0 ? 0 : Math.round(v.durSum / v.count)),
    },
  }), {})
}

const mergeFinishCause = (records: readonly Record<string, number>[]): Record<string, number> =>
  records.reduce<Record<string, number>>((out, rec) => {
    return Object.entries(rec).reduce<Record<string, number>>((inner, [k, v]) => ({
      ...inner,
      [k]: (inner[k] ?? 0) + v,
    }), out)
  }, {})

export const aggregateSecondary = (list: readonly SecondaryMetrics[]): SecondaryMetrics => {
  if (list.length === 0) return emptySecondary()
  const numMedian = (vals: readonly string[]): string =>
    String(round(median(vals.map(toNum))))
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
    fileDiffStats: {
      additions: round(median(list.map((m) => m.fileDiffStats.additions))),
      deletions: round(median(list.map((m) => m.fileDiffStats.deletions))),
      filesChanged: round(median(list.map((m) => m.fileDiffStats.filesChanged))),
    },
    maxConsecutiveSameTool: round(median(list.map((m) => m.maxConsecutiveSameTool))),
  }
}

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
}

export const buildSideAggregates = (input: SideAggregationInput): SideAggregates => {
  if (input.extracted.length === 0) {
    return {
      side: input.side,
      primary: emptyPrimary(),
      secondary: emptySecondary(),
      stats: emptyStats(),
      failedRuns: [...input.failedRuns],
      rawRunIds: [...input.rawRunIds],
    }
  }
  const { median: primary, stats } = aggregatePrimary(input.extracted.map((e) => e.primary))
  const secondary = aggregateSecondary(input.extracted.map((e) => e.secondary))
  return {
    side: input.side,
    primary,
    secondary,
    stats,
    failedRuns: [...input.failedRuns],
    rawRunIds: [...input.rawRunIds],
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
  const percent = oldValue === 0 ? 0 : (absolute / oldValue) * 100
  return {
    absolute,
    percent,
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
      return {
        absolute,
        percent: oldValue === 0 ? 0 : (absolute / oldValue) * 100,
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
