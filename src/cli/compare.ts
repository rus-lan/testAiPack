/**
 * `compare` command — cross-run comparison of any two runs in the workspace.
 *
 * Unlike the per-run within-run deltas (which live in one run's `metrics`,
 * every variant vs the run's own baseline), `compare` picks one variant out
 * of run 1 and one variant out of run 2 and diffs those two selections
 * directly. Use cases: "pack-X a week ago vs pack-X now" (same variant name
 * on both sides), or "pack-X vs pack-Y" (different variant names, possibly
 * even different repos/tasks).
 *
 * Run 1's selection plays the baseline role for the synthetic pair
 * (`03-hard-problems.md §1.5`): `computeVariantDelta(side1, side2)`, so the
 * delta is run2 − run1 and significance is judged against run1's IQR — the
 * same convention the in-run baseline comparison uses.
 *
 * Layout: pure core (`compare`) + variant selection (`selectVariant`) +
 * headline synthesis (`buildCompareHeadline`) + renderers (`renderCompareMd`,
 * `compareResultToJson`) + CLI glue (`executeCompare`). All filesystem
 * access reuses the Effect-based workspace helpers.
 *
 * @see README.ru.md (compare)
 */
import { Data, Effect } from 'effect'
import type {
  Manifest,
  MetricDelta,
  MetricsReport,
  PhaseSlice,
  PrimaryMetrics,
  Report,
  VariantAggregates,
  VariantDelta,
} from '@generated/types'
import { findRun, readReport } from './workspace-runs.js'
import { computeVariantDelta } from '../metrics/aggregate.js'
import {
  deltaEntriesFor,
  fmtPct,
  fmtSigned,
  fmtValue,
  sigLabel,
  toNum,
  verdictFor,
} from '../report/format.js'
import type { DeltaEntry } from '../report/format.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A variant name, or the reserved sentinel `'best'` = highest median
 * successRank (ties → later in config order). Not a `string | 'best'`
 * union — TypeScript widens that to plain `string` anyway (any string
 * literal is already a `string`), so the type is `string` with `'best'`
 * documented as the one reserved value.
 */
export type VariantSelector = string
export type CompareFormat = 'md' | 'json'

export interface CompareOptions {
  readonly runId1: string
  readonly runId2: string
  readonly workspace: string
  /** Variant picked from run 1 — plays the baseline role for the delta. */
  readonly variant1: VariantSelector
  /** Variant picked from run 2 — compared against run 1's selection. */
  readonly variant2: VariantSelector
  readonly format: CompareFormat
}

export interface CompareRunSide {
  readonly id: string
  readonly manifest: Manifest
  readonly selector: VariantSelector
  readonly metrics: VariantAggregates
}

export interface CompareResult {
  readonly run1: CompareRunSide
  readonly run2: CompareRunSide
  /** run2's selection vs run1's selection, run1 playing the baseline role. */
  readonly delta: VariantDelta
  readonly entries: readonly DeltaEntry[]
  readonly basis: 'task' | 'total'
  readonly headlineResult: string
}

export class CompareError extends Data.TaggedError('CompareError')<{
  readonly code: 'E_RUN_NOT_FOUND' | 'E_REPORT_INVALID' | 'E_VARIANT_NOT_FOUND'
  readonly message: string
  readonly context?: Readonly<Record<string, unknown>>
}> {}

const VALID_FORMATS: readonly CompareFormat[] = ['md', 'json']

export const isCompareFormat = (v: string): v is CompareFormat =>
  (VALID_FORMATS as readonly string[]).includes(v)

/** Accepts any non-empty string — a bare variant name or `'best'`; exists for CLI symmetry. */
export const isVariantSelector = (v: string): boolean => v.length > 0

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const pickBestVariant = (variants: readonly VariantAggregates[]): VariantAggregates =>
  variants.reduce((best, cur) =>
    toNum(cur.primary.successRank) >= toNum(best.primary.successRank) ? cur : best,
  )

/**
 * Resolve a `VariantSelector` against a report: by name, or `best` = highest
 * median successRank (tie → later in config order, preserving today's
 * ties→new). `runId` is only used to make the error message identify which
 * run the unknown name was requested from.
 */
export const selectVariant = (
  report: Report,
  selector: VariantSelector,
  runId?: string,
): Effect.Effect<VariantAggregates, CompareError> => {
  if (selector === 'best') {
    if (report.metrics.variants.length === 0) {
      const id = runId ?? report.manifest.runId
      return Effect.fail(
        new CompareError({
          code: 'E_VARIANT_NOT_FOUND',
          message: `No variants in run ${id}`,
          context: { selector, runId: id },
        }),
      )
    }
    return Effect.succeed(pickBestVariant(report.metrics.variants))
  }
  const found = report.metrics.variants.find((v) => v.variant === selector)
  if (found !== undefined) return Effect.succeed(found)
  const available = report.metrics.variants.map((v) => v.variant)
  return Effect.fail(
    new CompareError({
      code: 'E_VARIANT_NOT_FOUND',
      message: `Unknown variant "${selector}"${runId === undefined ? '' : ` in run ${runId}`} (available: ${available.join(', ')})`,
      context: { selector, runId, available },
    }),
  )
}

const percentPhrase = (
  percent: number | undefined,
  more: string,
  fewer: string,
  equal: string,
): string => {
  // percent is omitted only for a 0 → non-zero change (see MetricDelta.percent);
  // absolute moved away from zero, so it reads as the "more"/increase case.
  if (percent === undefined) return more
  const abs = Math.abs(percent).toFixed(1)
  if (percent > 0) return `${abs}% ${more}`
  if (percent < 0) return `${abs}% ${fewer}`
  return equal
}

const findDelta = (entries: readonly DeltaEntry[], key: string): MetricDelta | undefined =>
  entries.find((e) => e.key === key)?.d

export const buildCompareHeadline = (entries: readonly DeltaEntry[]): string => {
  const tokensD = findDelta(entries, 'totalTokens')
  const wallD = findDelta(entries, 'wallClockMs')
  const rankD = findDelta(entries, 'successRank')
  const tokens =
    tokensD === undefined
      ? 'an unmeasured token change'
      : percentPhrase(tokensD.percent, 'more tokens', 'fewer tokens', 'the same tokens')
  const wall =
    wallD === undefined
      ? 'an unmeasured wall-clock change'
      : percentPhrase(wallD.percent, 'longer wall-clock', 'less wall-clock', 'the same wall-clock')
  const rankPhrase =
    rankD === undefined
      ? 'an unmeasured success rank'
      : rankD.better === 'better'
        ? 'a higher success rank'
        : rankD.better === 'worse'
          ? 'a lower success rank'
          : 'the same success rank'
  return `Run 2 vs Run 1: used ${tokens}, took ${wall}, achieved ${rankPhrase}.`
}

// ---------------------------------------------------------------------------
// Core effect
// ---------------------------------------------------------------------------

const loadRunReport = (
  workspace: string,
  runId: string,
): Effect.Effect<Report, CompareError> =>
  Effect.gen(function* () {
    const entry = yield* findRun(workspace, runId)
    if (entry === null) {
      return yield* Effect.fail(
        new CompareError({
          code: 'E_RUN_NOT_FOUND',
          message: `Run not found: ${runId}`,
          context: { runId },
        }),
      )
    }
    const report = yield* readReport(entry.resultsDir).pipe(
      Effect.mapError(
        (e) =>
          new CompareError({
            code: 'E_REPORT_INVALID',
            message: `Invalid report for ${runId}: ${e._tag}`,
            context: { runId },
          }),
      ),
    )
    if (report === null) {
      return yield* Effect.fail(
        new CompareError({
          code: 'E_REPORT_INVALID',
          message: `No report.json for ${runId}`,
          context: { runId },
        }),
      )
    }
    return report
  })

export const compare = (
  opts: CompareOptions,
): Effect.Effect<CompareResult, CompareError> =>
  Effect.gen(function* () {
    const report1 = yield* loadRunReport(opts.workspace, opts.runId1)
    const report2 = yield* loadRunReport(opts.workspace, opts.runId2)

    const side1 = yield* selectVariant(report1, opts.variant1, opts.runId1)
    const side2 = yield* selectVariant(report2, opts.variant2, opts.runId2)

    // Synthetic single-pair MetricsReport so deltaEntriesFor (built for
    // N-way reports) can be reused for compare's 2-way case too — run1's
    // selection plays the baseline role (03-hard-problems.md §1.5).
    const delta = computeVariantDelta(side1, side2)
    const hasSamples = (agg: VariantAggregates): boolean => agg.stats.totalTokens.samples.length > 0
    const bothEmpty = !hasSamples(side1) && !hasSamples(side2)
    const syntheticMetrics: MetricsReport = {
      baseline: side1.variant,
      variants: [side1, side2],
      deltas: [delta],
      allFailed: bothEmpty,
    }
    const { entries, basis } = deltaEntriesFor(syntheticMetrics, side2.variant)
    const headlineResult = buildCompareHeadline(entries)

    return {
      run1: {
        id: report1.manifest.runId,
        manifest: report1.manifest,
        selector: opts.variant1,
        metrics: side1,
      },
      run2: {
        id: report2.manifest.runId,
        manifest: report2.manifest,
        selector: opts.variant2,
        metrics: side2,
      },
      delta,
      entries,
      basis,
      headlineResult,
    }
  })

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const escapeCell = (s: string): string =>
  s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const variantPacks = (manifest: Manifest, variantName: string): readonly string[] =>
  manifest.variants.find((v) => v.name === variantName)?.packs ?? []

const packLabel = (manifest: Manifest, variantName: string): string => {
  const packs = variantPacks(manifest, variantName)
  return packs.length === 0 ? '_no packs (smoke-test)_' : escapeCell(packs.join(', '))
}

const runLabel = (side: CompareRunSide): string => {
  const requested = side.selector === 'best' ? ' (requested: best)' : ''
  return `${side.id} (variant: ${side.metrics.variant}${requested}, packs: ${packLabel(side.manifest, side.metrics.variant)}, timestamp: ${side.manifest.timestamp})`
}

/** The five metrics that split into init/task slices (`PHASE_METRICS` in format.ts) — the other two (successRank, maxParallelism) never split. */
const SPLITTABLE_KEYS: ReadonlySet<string> = new Set([
  'totalTokens',
  'wallClockMs',
  'costUsd',
  'stepCount',
  'toolCallCount',
])

/** Resolves the same raw value an entry's delta was computed from: the task slice on task basis (for splittable keys), the whole-run primary otherwise. */
const rawValueFor = (side: VariantAggregates, key: string, basis: 'task' | 'total'): string | number => {
  if (basis === 'task' && SPLITTABLE_KEYS.has(key)) {
    const slice = side.phaseSplit?.task
    if (slice !== undefined) return slice[key as keyof PhaseSlice]
  }
  return side.primary[key as keyof PrimaryMetrics]
}

export const renderCompareMd = (result: CompareResult): string => {
  const header = [
    '# testaipack compare',
    '',
    `**Run 1:** ${runLabel(result.run1)}`,
    `**Run 2:** ${runLabel(result.run2)}`,
    `**Basis:** ${result.basis}`,
  ].join('\n')

  const summary = ['## Summary', '', result.headlineResult].join('\n')

  const tableHeader = [
    '## Primary metrics (run2 vs run1)',
    '',
    '| Metric | Run 1 | Run 2 | Δ | Δ% | Significant | Verdict |',
    '|---|---|---|---|---|---|---|',
  ]
  const rows = result.entries.map((e) => {
    const v1 = fmtValue(rawValueFor(result.run1.metrics, e.key, result.basis), e.kind)
    const v2 = fmtValue(rawValueFor(result.run2.metrics, e.key, result.basis), e.kind)
    return `| ${e.label} | ${v1} | ${v2} | ${fmtSigned(e.d.absolute, e.kind)} | ${fmtPct(e.d.percent)} | ${sigLabel(e.d)} | ${verdictFor(e.d)} |`
  })
  const table = [...tableHeader, ...rows].join('\n')

  // F9: a pairIncomplete delta still renders (absolute/percent are real
  // numbers) but is forced non-significant/neutral by computeVariantDelta —
  // flag it so the all-neutral row doesn't read as "no difference found".
  const pairWarning = result.delta.pairIncomplete
    ? '\n\n_⚠ One side of this pair produced no samples — the deltas above are not meaningful._'
    : ''

  return [header, summary, table].join('\n\n---\n\n') + pairWarning + '\n'
}

export interface CompareRunSideJson {
  readonly id: string
  readonly manifest: Manifest
  readonly variant: string
  readonly selector: VariantSelector
  readonly metrics: VariantAggregates
}

export interface CompareJsonResult {
  readonly run1: CompareRunSideJson
  readonly run2: CompareRunSideJson
  readonly basis: 'task' | 'total'
  readonly headlineResult: string
  readonly delta: VariantDelta
  readonly entries: readonly DeltaEntry[]
}

const sideToJson = (side: CompareRunSide): CompareRunSideJson => ({
  id: side.id,
  manifest: side.manifest,
  variant: side.metrics.variant,
  selector: side.selector,
  metrics: side.metrics,
})

export const compareResultToJson = (result: CompareResult): CompareJsonResult => ({
  run1: sideToJson(result.run1),
  run2: sideToJson(result.run2),
  basis: result.basis,
  headlineResult: result.headlineResult,
  delta: result.delta,
  entries: result.entries,
})

// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------

export const executeCompare = async (opts: CompareOptions): Promise<number> => {
  const outcome = await Effect.runPromise(Effect.either(compare(opts)))
  if (outcome._tag === 'Left') {
    const e = outcome.left
    console.error(`[${e.code}] ${e.message}`)
    return 1
  }
  const result = outcome.right
  const out =
    opts.format === 'json'
      ? `${JSON.stringify(compareResultToJson(result), null, 2)}\n`
      : `${renderCompareMd(result)}\n`
  process.stdout.write(out)
  return 0
}
