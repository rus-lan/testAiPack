/**
 * Metrics: aggregate — median / min / max / IQR across the successful runs of
 * one variant, and the per-variant delta vs the baseline (VariantDelta). All
 * pure.
 *
 * @see docs/phases/07-aggregate.ru.md
 * @see contract/main.tsp (VariantAggregates, VariantDelta, MetricsReport, MetricDistribution)
 */
import type {
  AggregateStats,
  ContaminationSignal,
  FailedRun,
  MetricDelta,
  MetricDistribution,
  MetricsReport,
  PackUse,
  PhaseDeltas,
  PhaseSlice,
  PhaseSliceStats,
  PhaseSplit,
  PrimaryDeltas,
  PrimaryMetrics,
  RiskyCommand,
  SecondaryMetrics,
  ToolStat,
  VariantAggregates,
  VariantDelta,
  VerifyStats,
} from '@generated/types'
import type { EventsProfile } from './events-profile.js'
import type { ExtractedExtras, ExtractedMetrics, ExtractedPhases, PhaseSliceNum } from './extract.js'
import type { ConfigDriftSignal } from './baseline-contamination.js'
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

/** A pack this variant declares — one entry per pack, feeding one `buildPackUse` call each. */
export interface DeclaredPack {
  readonly name: string
  /** Whether the pack type can be seen in exports at all (false for plugin/mcp/agent/command). */
  readonly canDetect: boolean
  /** Whether phase 05's pack-visibility gate proved this pack was present in this variant's run-1 HOME before any run started. */
  readonly visibilityConfirmed: boolean
}

const buildPackUse = (
  extras: readonly ExtractedExtras[],
  runIndexes: readonly number[],
  pack: DeclaredPack,
): PackUse => {
  const callsOf = (e: ExtractedExtras): number => e.packCalls[pack.name] ?? 0
  const firstTimes = extras.flatMap((e) => {
    const t = e.firstPackCallMs[pack.name]
    return t === undefined ? [] : [t]
  })
  const firstCallMsMedian = firstTimes.length === 0 ? undefined : String(round(median(firstTimes)))
  const runsWithoutCall = extras.flatMap((e, i) => (callsOf(e) === 0 ? [runIndexes[i] ?? 0] : []))
  return {
    pack: pack.name,
    calls: extras.reduce((a, e) => a + callsOf(e), 0),
    errors: extras.reduce((a, e) => a + (e.packErrors[pack.name] ?? 0), 0),
    runsWithCall: extras.filter((e) => callsOf(e) > 0).length,
    runCount: extras.length,
    canDetect: pack.canDetect,
    visibilityConfirmed: pack.visibilityConfirmed,
    ...(firstCallMsMedian === undefined ? {} : { firstCallMsMedian }),
    // Present (possibly empty) whenever runCount > 0 — measured and clean is
    // different from never checked. Omitted only when there was nothing to
    // inspect at all (matches riskyCommands/contaminationSignals convention).
    ...(extras.length === 0 ? {} : { runsWithoutCall: [...runsWithoutCall] }),
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
 * for every pack foreign to this variant, plus this variant's own config-
 * drift signal, if any. Computed for EVERY variant now — `03-hard-problems.md`
 * §1: the pack under test is only ever foreign to the variants that don't
 * declare it, so a shared pack never contaminates either of its own
 * declarers. Grouped by foreign pack (declaration order), then by run.
 */
const buildContaminationSignals = (
  extras: readonly ExtractedExtras[],
  runIndexes: readonly number[],
  foreignPacks: readonly string[],
  configDrift: ConfigDriftSignal | undefined,
): readonly ContaminationSignal[] => [
  ...foreignPacks.flatMap((foreignName) =>
    extras.flatMap((e, i) =>
      (e.packActivitySignals[foreignName] ?? []).map(
        (s): ContaminationSignal => ({ ...s, runIndex: runIndexes[i] ?? 0 }),
      ),
    ),
  ),
  // install-drift names no single pack (it is variant-level) — stamped with
  // an empty pack to satisfy the contract's required `pack: string` field;
  // see `ConfigDriftSignal`'s doc comment in baseline-contamination.ts.
  ...(configDrift === undefined ? [] : [{ ...configDrift, pack: '' }]),
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

// ---------------------------------------------------------------------------
// Phase split (metric-split spec §5.5): median + distribution of the five
// splittable metrics for `init`/`task`, plus the harness-only `setup` segment.
// ---------------------------------------------------------------------------

const phaseSliceDist = (
  slices: readonly PhaseSliceNum[],
): { readonly median: PhaseSlice; readonly stats: PhaseSliceStats } => {
  const totalTokens = slices.map((s) => s.totalTokens)
  const wallClockMs = slices.map((s) => s.wallClockMs)
  const costUsd = slices.map((s) => s.costUsd)
  const stepCount = slices.map((s) => s.stepCount)
  const toolCallCount = slices.map((s) => s.toolCallCount)
  return {
    median: {
      totalTokens: String(round(median(totalTokens))),
      wallClockMs: String(round(median(wallClockMs))),
      costUsd: median(costUsd),
      stepCount: round(median(stepCount)),
      toolCallCount: round(median(toolCallCount)),
    },
    stats: {
      totalTokens: dist(totalTokens),
      wallClockMs: dist(wallClockMs),
      costUsd: dist(costUsd),
      stepCount: dist(stepCount),
      toolCallCount: dist(toolCallCount),
    },
  }
}

/**
 * Builds `PhaseSplit` from per-run phase slices (parallel to `extracted`
 * in `VariantAggregationInput`): `task` medians over every successful run
 * (a run with no init IS the task, whole); `init` only over runs whose
 * export carried a boundary. `runsWithLostInit` catches phase 06 recording
 * that `--init` ran (`initRanFlags`) while the export shows no boundary at
 * all — the "lost session continuation" case (spec §2.4): init cost went
 * unmeasured, not zero. `setup` is harness wall-clock only (spec §6.1),
 * aggregated separately from `setupWallMsList` — never a fabricated zero for
 * a run that never exercised.
 */
const buildPhaseSplit = (
  phasesList: readonly ExtractedPhases[],
  initRanFlags: readonly boolean[],
  setupWallMsList: readonly (number | undefined)[],
): PhaseSplit | undefined => {
  if (phasesList.length === 0) return undefined
  const initSlices = phasesList.flatMap((p) => (p.init === undefined ? [] : [p.init]))
  const taskSlices = phasesList.map((p) => p.task)
  const runsWithLostInit = phasesList.reduce(
    (n, p, i) => n + (p.init === undefined && (initRanFlags[i] ?? false) ? 1 : 0),
    0,
  )
  const costProrated = phasesList.some((p) => p.init?.costProrated === true || p.task.costProrated)
  const { median: task, stats: taskStats } = phaseSliceDist(taskSlices)
  const setupValues = setupWallMsList.filter((v): v is number => v !== undefined)

  return {
    runsWithInit: initSlices.length,
    runsWithLostInit,
    task,
    taskStats,
    ...(costProrated ? { costProrated: true } : {}),
    ...(initSlices.length === 0
      ? {}
      : (() => {
          const { median: init, stats: initStats } = phaseSliceDist(initSlices)
          return { init, initStats }
        })()),
    ...(setupValues.length === 0
      ? {}
      : { setup: { wallClockMs: String(round(median(setupValues))) }, setupStats: dist(setupValues) }),
  }
}

export interface VariantAggregationInput {
  readonly variant: string
  readonly extracted: readonly ExtractedMetrics[]
  readonly failedRuns: readonly FailedRun[]
  readonly rawRunIds: readonly string[]
  /** Parallel to `extracted` — one entry per successfully-extracted run. */
  readonly extras: readonly ExtractedExtras[]
  /** Parallel to `extracted` — the run index each entry came from. */
  readonly runIndexes: readonly number[]
  /** One entry per successfully-profiled run — NOT parallel to `extracted`; runs with no readable events.ndjson are absent. */
  readonly eventsProfiles: readonly EventsProfile[]
  /** Packs this variant declares — one `PackUse` built per entry (empty when the variant declares no packs). */
  readonly packs: readonly DeclaredPack[]
  /**
   * Packs OTHER variants declare that this one does NOT — contamination is
   * checked against this set for every variant now (`03-hard-problems.md`
   * §1; a pack shared by two variants is in neither's foreign set).
   */
  readonly foreignPacks: readonly string[]
  /** Computed by phase 07 from this variant's results (§1.6); passed through unchanged. */
  readonly verifyStats?: VerifyStats
  /**
   * This variant's own captured-config drift signal (from `installed.json`,
   * read by phase 07) — computed for every variant now; see
   * `baseline-contamination.ts`.
   */
  readonly configDriftSignal?: ConfigDriftSignal
  /** Parallel to `extracted` — true when `RunSideResultExt.initRan === true` for that run (spec §5.4). */
  readonly initRanFlags: readonly boolean[]
  /**
   * Every attempted run's `RunResult.setupWallMs` (successful AND
   * failed — the pack-exercise segment runs before the agent session, so a
   * later agent crash doesn't invalidate its own wall-clock reading);
   * `undefined` entries are runs with no setup segment.
   */
  readonly setupWallMsList: readonly (number | undefined)[]
}

export const buildVariantAggregates = (input: VariantAggregationInput): VariantAggregates => {
  const packUses = input.packs.map((p) => buildPackUse(input.extras, input.runIndexes, p))
  if (input.extracted.length === 0) {
    return {
      variant: input.variant,
      primary: emptyPrimary(),
      secondary: emptySecondary(),
      stats: emptyStats(),
      failedRuns: [...input.failedRuns],
      rawRunIds: [...input.rawRunIds],
      ...(packUses.length === 0 ? {} : { packUses: [...packUses] }),
      ...(input.verifyStats === undefined ? {} : { verifyStats: input.verifyStats }),
      // The config-drift signal comes from installed.json, not from any
      // successful run — it survives even when every run failed (a variant
      // whose runs all crashed can still show config drift, and dropping the
      // signal here would silently hide it). Foreign-pack activity signals
      // ARE omitted: there is no successful export left to have scanned.
      ...(input.configDriftSignal === undefined
        ? {}
        : { contaminationSignals: [{ ...input.configDriftSignal, pack: '' }] }),
      // riskyCommands / opencodeVersions / phaseSplit omitted — no successful run was ever inspected.
    }
  }
  const { median: primary, stats } = aggregatePrimary(input.extracted.map((e) => e.primary))
  const secondary = aggregateSecondary(input.extracted.map((e) => e.secondary), input.extras, input.eventsProfiles)
  const phaseSplit = buildPhaseSplit(
    input.extracted.map((e) => e.phases),
    input.initRanFlags,
    input.setupWallMsList,
  )
  return {
    variant: input.variant,
    primary,
    secondary,
    stats,
    failedRuns: [...input.failedRuns],
    rawRunIds: [...input.rawRunIds],
    ...(packUses.length === 0 ? {} : { packUses: [...packUses] }),
    riskyCommands: [...buildRiskyCommands(input.extras, input.runIndexes)],
    opencodeVersions: [...buildOpencodeVersions(input.extras)],
    ...(input.verifyStats === undefined ? {} : { verifyStats: input.verifyStats }),
    contaminationSignals: [
      ...buildContaminationSignals(input.extras, input.runIndexes, input.foreignPacks, input.configDriftSignal),
    ],
    ...(phaseSplit === undefined ? {} : { phaseSplit }),
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
 * Single-metric delta. Exposed for table testing; `computeVariantDelta`
 * wires the variant-aggregate values + baseline IQR into it.
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

const variantHasSamples = (agg: VariantAggregates): boolean =>
  agg.stats.totalTokens.samples.length > 0

/** Same shape as `computeMetricDelta` — injected so phase deltas go through the caller's `pairIncomplete` neutralization instead of always computing a real (possibly misleadingly "significant") delta. */
type MetricDeltaFn = (
  baseValue: number,
  vValue: number,
  iqrVal: number | undefined,
  direction: DeltaDirection,
) => MetricDelta

/**
 * Five metric-delta calls over a phase slice pair — same lower-is-better
 * direction as the matching `PrimaryDeltas` entries (spec §5.5); significance
 * is judged against the BASELINE's own distribution for that phase, same
 * convention `computeVariantDelta` uses for the whole-run deltas.
 * `deltaFor` is `computeVariantDelta`'s own pairIncomplete-aware wrapper —
 * threading it through here (rather than calling `computeMetricDelta`
 * directly) means an incomplete pair renders neutral task/init deltas too,
 * not just neutral primary deltas.
 */
const computePhaseDeltas = (
  baseSlice: PhaseSlice,
  vSlice: PhaseSlice,
  baseStats: PhaseSliceStats,
  deltaFor: MetricDeltaFn,
): PhaseDeltas => ({
  totalTokens: deltaFor(
    toNum(baseSlice.totalTokens),
    toNum(vSlice.totalTokens),
    baseStats.totalTokens.iqr,
    'lower-is-better',
  ),
  wallClockMs: deltaFor(
    toNum(baseSlice.wallClockMs),
    toNum(vSlice.wallClockMs),
    baseStats.wallClockMs.iqr,
    'lower-is-better',
  ),
  costUsd: deltaFor(baseSlice.costUsd, vSlice.costUsd, baseStats.costUsd.iqr, 'lower-is-better'),
  stepCount: deltaFor(baseSlice.stepCount, vSlice.stepCount, baseStats.stepCount.iqr, 'lower-is-better'),
  toolCallCount: deltaFor(
    baseSlice.toolCallCount,
    vSlice.toolCallCount,
    baseStats.toolCallCount.iqr,
    'lower-is-better',
  ),
})

/**
 * Reference distribution = the baseline variant (`03-hard-problems.md` §1.2):
 * for every non-baseline variant V, `Δ = V.median − base.median`, judged
 * significant against `1.5 × IQR(base)` — the baseline's spread is the
 * shared yardstick, not either side's own. `pairIncomplete` generalizes the
 * old `anyFailed` containment: deltas still compute (absolute/percent
 * render) but are forced non-significant/neutral whenever either side of
 * THIS pair has zero samples.
 */
export const computeVariantDelta = (base: VariantAggregates, v: VariantAggregates): VariantDelta => {
  const pairIncomplete = !variantHasSamples(base) || !variantHasSamples(v)

  const deltaFor = (
    baseValue: number,
    vValue: number,
    iqrVal: number | undefined,
    direction: DeltaDirection,
  ): MetricDelta => {
    if (pairIncomplete) {
      const absolute = vValue - baseValue
      const percent = percentDelta(baseValue, absolute)
      return {
        absolute,
        ...(percent === undefined ? {} : { percent }),
        significant: false,
        better: 'neutral',
      }
    }
    return computeMetricDelta(baseValue, vValue, iqrVal, direction)
  }

  const deltas: PrimaryDeltas = {
    totalTokens: deltaFor(
      toNum(base.primary.totalTokens),
      toNum(v.primary.totalTokens),
      base.stats.totalTokens.iqr,
      'lower-is-better',
    ),
    wallClockMs: deltaFor(
      toNum(base.primary.wallClockMs),
      toNum(v.primary.wallClockMs),
      base.stats.wallClockMs.iqr,
      'lower-is-better',
    ),
    costUsd: deltaFor(
      base.primary.costUsd,
      v.primary.costUsd,
      base.stats.costUsd.iqr,
      'lower-is-better',
    ),
    stepCount: deltaFor(
      base.primary.stepCount,
      v.primary.stepCount,
      base.stats.stepCount.iqr,
      'lower-is-better',
    ),
    toolCallCount: deltaFor(
      base.primary.toolCallCount,
      v.primary.toolCallCount,
      base.stats.toolCallCount.iqr,
      'lower-is-better',
    ),
    successRank: deltaFor(
      base.primary.successRank,
      v.primary.successRank,
      base.stats.successRank.iqr,
      'higher-is-better',
    ),
    maxParallelism: deltaFor(
      base.primary.maxParallelism,
      v.primary.maxParallelism,
      undefined,
      'context-dependent',
    ),
  }

  // taskDeltas: present iff both sides carry a phaseSplit (spec §5.5) — the
  // like-for-like basis whenever init runs on one side or both; initDeltas
  // additionally requires runsWithInit > 0 on BOTH sides (--init-side both),
  // never rendered when init is one-sided (that is a cost figure, not a delta).
  const taskDeltas =
    base.phaseSplit !== undefined && v.phaseSplit !== undefined
      ? computePhaseDeltas(base.phaseSplit.task, v.phaseSplit.task, base.phaseSplit.taskStats, deltaFor)
      : undefined

  const bothHaveInit = (base.phaseSplit?.runsWithInit ?? 0) > 0 && (v.phaseSplit?.runsWithInit ?? 0) > 0
  const baseInit = base.phaseSplit?.init
  const vInit = v.phaseSplit?.init
  const baseInitStats = base.phaseSplit?.initStats
  const initDeltas =
    bothHaveInit && baseInit !== undefined && vInit !== undefined && baseInitStats !== undefined
      ? computePhaseDeltas(baseInit, vInit, baseInitStats, deltaFor)
      : undefined

  return {
    variant: v.variant,
    deltas,
    pairIncomplete,
    ...(taskDeltas === undefined ? {} : { taskDeltas }),
    ...(initDeltas === undefined ? {} : { initDeltas }),
  }
}

/**
 * Assembles the N-1 per-variant deltas vs the baseline (config order,
 * baseline excluded) plus `allFailed` = every variant empty (generalizes the
 * old `bothFailed`, `03-hard-problems.md` §1.2). `baseline` naming a variant
 * absent from `all` is a caller error (validated upstream by phase 00/05) —
 * throws rather than silently returning a report that renders as "complete,
 * zero comparisons".
 */
export const computeMetricsReport = (baseline: string, all: readonly VariantAggregates[]): MetricsReport => {
  const baseAgg = all.find((a) => a.variant === baseline)
  if (baseAgg === undefined) {
    throw new Error(`computeMetricsReport: baseline variant "${baseline}" not found among [${all.map((a) => a.variant).join(', ')}]`)
  }
  const others = all.filter((a) => a.variant !== baseline)
  const deltas = others.map((v) => computeVariantDelta(baseAgg, v))
  const allFailed = all.length > 0 && all.every((a) => !variantHasSamples(a))
  return {
    baseline,
    variants: [...all],
    deltas,
    allFailed,
  }
}

export { percentile }
