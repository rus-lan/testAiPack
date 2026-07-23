/**
 * `compare` command — cross-run comparison of any two runs in the workspace.
 *
 * Unlike the per-run old-vs-new diff (which lives inside one run's
 * `metricsDiff`), this compares a chosen *side* of run 1 against the same (or
 * "best") side of run 2. Use cases: "pack-X a week ago vs pack-X now", or
 * "pack-X vs pack-Y".
 *
 * Layout: pure core (`compare`) + perspective selectors (`resolvePerspective`,
 * `selectSide`) + headline synthesis (`buildCompareHeadline`) + renderers
 * (`renderCompareMd`, `compareResultToJson`) + CLI glue (`executeCompare`).
 * All filesystem access reuses the Effect-based workspace helpers.
 *
 * @see README.ru.md (compare)
 */
import { Data, Effect } from 'effect'
import type {
  Manifest,
  MetricDelta,
  PrimaryDeltas,
  Report,
  SideAggregates,
} from '@generated/types'
import { findRun, readReport } from './workspace-runs.js'
import { computeDelta } from '../metrics/aggregate.js'
import {
  PRIMARY_METRICS,
  fmtPct,
  fmtSigned,
  fmtValue,
  sigLabel,
  toNum,
  verdictFor,
} from '../report/format.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComparePerspective = 'new-vs-new' | 'old-vs-old' | 'best' | 'auto'
export type CompareFormat = 'md' | 'json'
export type ResolvedPerspective = 'new-vs-new' | 'old-vs-old' | 'best'

export interface CompareOptions {
  readonly runId1: string
  readonly runId2: string
  readonly workspace: string
  readonly perspective: ComparePerspective
  readonly format: CompareFormat
}

export interface CompareRunSide {
  readonly id: string
  readonly manifest: Manifest
  readonly metrics: SideAggregates
}

export interface CompareResult {
  readonly run1: CompareRunSide
  readonly run2: CompareRunSide
  /** Primary-metric deltas, in PRIMARY_METRICS order; each = run2 minus run1. */
  readonly diff: readonly MetricDelta[]
  readonly perspective: ResolvedPerspective
  readonly headlineResult: string
}

export class CompareError extends Data.TaggedError('CompareError')<{
  readonly code: 'E_RUN_NOT_FOUND' | 'E_REPORT_INVALID'
  readonly message: string
  readonly context?: Readonly<Record<string, unknown>>
}> {}

const VALID_PERSPECTIVES: readonly ComparePerspective[] = [
  'new-vs-new',
  'old-vs-old',
  'best',
  'auto',
]
const VALID_FORMATS: readonly CompareFormat[] = ['md', 'json']

export const isComparePerspective = (v: string): v is ComparePerspective =>
  (VALID_PERSPECTIVES as readonly string[]).includes(v)

export const isCompareFormat = (v: string): v is CompareFormat =>
  (VALID_FORMATS as readonly string[]).includes(v)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the requested perspective against both manifests. `auto` picks
 * new-vs-new when both runs installed a pack, old-vs-old when both are
 * smoke-tests, and `best` for the mixed case.
 */
export const resolvePerspective = (
  m1: Manifest,
  m2: Manifest,
  requested: ComparePerspective,
): ResolvedPerspective => {
  if (requested === 'new-vs-new' || requested === 'old-vs-old' || requested === 'best') {
    return requested
  }
  const p1 = m1.packRef !== undefined
  const p2 = m2.packRef !== undefined
  if (p1 && p2) return 'new-vs-new'
  if (!p1 && !p2) return 'old-vs-old'
  return 'best'
}

/**
 * Pick the SideAggregates of a run for the given (resolved) perspective.
 * `best` returns whichever side has the higher median successRank (ties → new).
 */
export const selectSide = (
  report: Report,
  perspective: ResolvedPerspective,
): SideAggregates => {
  if (perspective === 'new-vs-new') return report.metricsDiff.new
  if (perspective === 'old-vs-old') return report.metricsDiff.old
  const oldAgg = report.metricsDiff.old
  const newAgg = report.metricsDiff.new
  return toNum(newAgg.primary.successRank) >= toNum(oldAgg.primary.successRank)
    ? newAgg
    : oldAgg
}

const percentPhrase = (
  percent: number,
  more: string,
  fewer: string,
  equal: string,
): string => {
  const abs = Math.abs(percent).toFixed(1)
  if (percent > 0) return `${abs}% ${more}`
  if (percent < 0) return `${abs}% ${fewer}`
  return equal
}

export const buildCompareHeadline = (deltas: PrimaryDeltas): string => {
  const tokens = percentPhrase(
    deltas.totalTokens.percent,
    'more tokens',
    'fewer tokens',
    'the same tokens',
  )
  const wall = percentPhrase(
    deltas.wallClockMs.percent,
    'longer wall-clock',
    'less wall-clock',
    'the same wall-clock',
  )
  const rank = deltas.successRank
  const rankPhrase =
    rank.better === 'better'
      ? 'a higher success rank'
      : rank.better === 'worse'
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

    const perspective = resolvePerspective(
      report1.manifest,
      report2.manifest,
      opts.perspective,
    )
    const side1 = selectSide(report1, perspective)
    const side2 = selectSide(report2, perspective)

    const metricsDiff = computeDelta(side1, side2)
    const diff: readonly MetricDelta[] = PRIMARY_METRICS.map(
      (m) => metricsDiff.deltas[m.key],
    )
    const headlineResult = buildCompareHeadline(metricsDiff.deltas)

    return {
      run1: { id: report1.manifest.runId, manifest: report1.manifest, metrics: side1 },
      run2: { id: report2.manifest.runId, manifest: report2.manifest, metrics: side2 },
      diff,
      perspective,
      headlineResult,
    }
  })

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

const escapeCell = (s: string): string =>
  s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const packLabel = (manifest: Manifest): string =>
  manifest.packRef !== undefined
    ? escapeCell(manifest.packRef)
    : '_smoke-test (no pack)_'

export const renderCompareMd = (result: CompareResult): string => {
  const header = [
    '# testaipack compare',
    '',
    `**Run 1:** ${result.run1.id} (pack: ${packLabel(result.run1.manifest)}, timestamp: ${result.run1.manifest.timestamp})`,
    `**Run 2:** ${result.run2.id} (pack: ${packLabel(result.run2.manifest)}, timestamp: ${result.run2.manifest.timestamp})`,
    `**Perspective:** ${result.perspective}`,
  ].join('\n')

  const summary = ['## Summary', '', result.headlineResult].join('\n')

  const tableHeader = [
    '## Primary metrics (run2 vs run1)',
    '',
    '| Metric | Run 1 | Run 2 | Δ | Δ% | Significant | Verdict |',
    '|---|---|---|---|---|---|---|',
  ]
  const rows = PRIMARY_METRICS.map((m, i) => {
    const d = result.diff[i]
    if (d === undefined) return ''
    const v1 = fmtValue(result.run1.metrics.primary[m.key], m.kind)
    const v2 = fmtValue(result.run2.metrics.primary[m.key], m.kind)
    return `| ${m.label} | ${v1} | ${v2} | ${fmtSigned(d.absolute, m.kind)} | ${fmtPct(d.percent)} | ${sigLabel(d)} | ${verdictFor(d)} |`
  })
  const table = [...tableHeader, ...rows].join('\n')

  return [header, summary, table].join('\n\n---\n\n') + '\n'
}

export interface CompareDiffEntry {
  readonly key: string
  readonly label: string
  readonly delta: MetricDelta
}

export interface CompareJsonResult {
  readonly run1: {
    readonly id: string
    readonly manifest: Manifest
    readonly metrics: SideAggregates
  }
  readonly run2: {
    readonly id: string
    readonly manifest: Manifest
    readonly metrics: SideAggregates
  }
  readonly perspective: ResolvedPerspective
  readonly headlineResult: string
  readonly diff: readonly CompareDiffEntry[]
}

export const compareResultToJson = (result: CompareResult): CompareJsonResult => ({
  run1: {
    id: result.run1.id,
    manifest: result.run1.manifest,
    metrics: result.run1.metrics,
  },
  run2: {
    id: result.run2.id,
    manifest: result.run2.manifest,
    metrics: result.run2.metrics,
  },
  perspective: result.perspective,
  headlineResult: result.headlineResult,
  diff: PRIMARY_METRICS.map((m, i) => ({
    key: m.key,
    label: m.label,
    // diff is built in compare() by the same PRIMARY_METRICS map, so index i is always defined.
    delta: result.diff[i] as MetricDelta,
  })),
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
