/**
 * Phase 07: aggregate
 *
 * Reads raw/<side>/run-{1..N}.json for both sides, validates each against the
 * OpencodeExport schema, extracts primary/secondary metrics, aggregates per side
 * (median + distribution), and computes the new-minus-old MetricsDiff. Writes
 * results/metrics.json.
 *
 * @see docs/phases/07-aggregate.ru.md
 * @see contract/phases/07-aggregate.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type {
  AggregateInput,
  AggregateResult,
  ErrorCode,
  FailedRun,
  OpencodeExport,
  RunSideResult,
  Side,
  SideAggregates,
} from '@generated/types'
import { opencodeExportSchema } from '@generated/schemas'
import { aggregateError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, readFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import type { PricingTable } from '../pricing/lookup.js'
import { loadPricing } from '../pricing/lookup.js'
import { extractMetrics } from '../metrics/extract.js'
import type { ExtractedMetrics } from '../metrics/extract.js'
import { buildSideAggregates, computeDelta } from '../metrics/aggregate.js'

type ProcessedRun =
  | { readonly kind: 'ok'; readonly metrics: ExtractedMetrics; readonly id: string }
  | { readonly kind: 'failed'; readonly failedRun: FailedRun }

const errorCodeFor = (r: RunSideResult): ErrorCode =>
  r.watchdogTriggered
    ? 'E_RUN_HANG_WATCHDOG'
    : 'E_RUN_CRASH'

const toFailedRun = (r: RunSideResult, timestamp: string): FailedRun => ({
  runIndex: r.runIndex,
  errorCode: errorCodeFor(r),
  errorMessage: `run ${r.side}/${String(r.runIndex)} failed: finishCause=${r.finishCause} exitCode=${String(r.exitCode)} watchdog=${String(r.watchdogTriggered)}`,
  timestamp,
})

const toExportInvalid = (side: Side, runIndex: number, cause: unknown): PhaseError =>
  aggregateError(
    `export invalid for ${side}/run-${String(runIndex)}: missing or schema-mismatch`,
    'E_EXPORT_INVALID',
    {
      side,
      runIndex,
      reason: 'missing-or-invalid-export',
      ...(cause === undefined ? {} : { cause }),
    },
  )

const readAndExtract = (
  r: RunSideResult,
  side: Side,
  rawDir: string,
  pricing: PricingTable | null,
): Effect.Effect<
  { readonly kind: 'ok'; readonly metrics: ExtractedMetrics; readonly id: string },
  PhaseError
> =>
  Effect.gen(function* () {
    const file = path.join(rawDir, side, `run-${String(r.runIndex)}.json`)
    const raw = yield* readFile(file).pipe(
      Effect.mapError((e: FsError) => toExportInvalid(side, r.runIndex, e)),
    )
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) => toExportInvalid(side, r.runIndex, e),
    })
    const result = opencodeExportSchema.safeParse(parsed)
    if (!result.success) {
      return yield* Effect.fail(toExportInvalid(side, r.runIndex, result.error))
    }
    // Zod infers optionals as `T | undefined` while the generated OpencodeExport
    // uses exact-optional under exactOptionalPropertyTypes; the data is already
    // schema-validated, so the two are runtime-equivalent.
    const data = result.data as OpencodeExport
    return {
      kind: 'ok' as const,
      metrics: extractMetrics(data, pricing, r.successRank),
      id: data.info.id,
    }
  })

const aggregateSide = (
  side: Side,
  results: readonly RunSideResult[],
  rawDir: string,
  pricing: PricingTable | null,
  timestamp: string,
): Effect.Effect<SideAggregates, PhaseError> =>
  Effect.gen(function* () {
    const processed = yield* Effect.forEach(
      results,
      (r): Effect.Effect<ProcessedRun, PhaseError> =>
        r.successRank === 0
          ? Effect.succeed({
              kind: 'failed' as const,
              failedRun: toFailedRun(r, timestamp),
            })
          : readAndExtract(r, side, rawDir, pricing),
      { concurrency: 1 },
    )
    const extracted = processed.flatMap((p) => (p.kind === 'ok' ? [p.metrics] : []))
    const rawRunIds = processed.flatMap((p) => (p.kind === 'ok' ? [p.id] : []))
    const failedRuns = processed.flatMap((p) => (p.kind === 'failed' ? [p.failedRun] : []))
    return buildSideAggregates({ side, extracted, failedRuns, rawRunIds })
  })

const ignorePricingError = (): Effect.Effect<null> => Effect.succeed(null)

export const aggregate = (
  input: AggregateInput,
): Effect.Effect<AggregateResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace, sideResults, manifest } = input
    const pricing: PricingTable | null = runInput.pricingPath
      ? yield* loadPricing(runInput.pricingPath).pipe(Effect.catchAll(ignorePricingError))
      : null

    const timestamp = manifest.timestamp
    const oldAgg = yield* aggregateSide('old', sideResults.old, workspace.raw, pricing, timestamp)
    const newAgg = yield* aggregateSide('new', sideResults.new, workspace.raw, pricing, timestamp)
    const metricsDiff = computeDelta(oldAgg, newAgg)
    const result: AggregateResult = {
      metricsDiff,
      rawAggregates: { old: oldAgg, new: newAgg },
    }

    yield* ensureDir(workspace.results).pipe(
      Effect.mapError((e: FsError) =>
        aggregateError(`results dir unavailable: ${e.operation} on ${e.path}`, 'E_EXPORT_INVALID', {
          reason: 'results-dir',
          cause: e,
        }),
      ),
    )
    yield* writeJson(path.join(workspace.results, 'metrics.json'), result).pipe(
      Effect.mapError((e: FsError) =>
        aggregateError(`failed to write metrics.json: ${e.operation} on ${e.path}`, 'E_EXPORT_INVALID', {
          reason: 'write-metrics',
          cause: e,
        }),
      ),
    )

    return result
  })
