/**
 * Phase 07: aggregate
 *
 * Reads raw/<variant>/run-{1..N}.json for every variant, validates each
 * against the OpencodeExport schema, extracts primary/secondary metrics,
 * aggregates per variant (median + distribution), and computes the deltas
 * for every non-baseline variant against the baseline. Writes
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
  RunInput,
  RunResult,
  VariantAggregates,
  VariantRunResults,
  VariantSpec,
  VerifyStats,
  WorkspaceTree,
} from '@generated/types'
import { opencodeExportSchema } from '@generated/schemas'
import { aggregateError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, readFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import type { PricingTable } from '../pricing/lookup.js'
import { loadPricing } from '../pricing/lookup.js'
import { extractMetricsFromTree, findPhaseBoundary } from '../metrics/extract.js'
import type { ExtractedMetrics } from '../metrics/extract.js'
import { profileEvents } from '../metrics/events-profile.js'
import type { EventsProfile } from '../metrics/events-profile.js'
import { buildVariantAggregates, computeMetricsReport } from '../metrics/aggregate.js'
import type { VariantAggregationInput } from '../metrics/aggregate.js'
import { findConfigDriftSignal, parseInstalledInventory } from '../metrics/baseline-contamination.js'
import type { ConfigDriftSignal } from '../metrics/baseline-contamination.js'
import { detectPack } from '../pack/detector.js'
import { foreignPacksOf } from './00-cli-parse.js'
import { loadTreeForRun } from './10-timeline.js'
import type { SessionTreeLoader } from './10-timeline.js'
import { toNum } from '../util/numeric.js'

/** Injectable tree loader for v0.2 sub-agent aggregation (tests pass a stub). */
export interface AggregateDeps {
  readonly loadTree?: SessionTreeLoader
}

/** One (variant, pack) visibility reading from phase 05's pack-visibility gate. */
export interface PackVisibilityEntry {
  readonly variant: string
  readonly pack: string
  readonly confirmed: boolean
}

/**
 * Local input extension: carries phase 05's pack-visibility gate outcome per
 * (variant, pack) so `packUse.visibilityConfirmed` reflects the check that
 * actually ran (docker-aware, see phase 05) instead of aggregate re-deriving
 * its own separate existence check. A pair absent from the list (`--no-
 * preflight`, or preflight never reached the gate) means "not confirmed",
 * the honest default — every variant, baseline included, goes through the
 * same lookup now (no more forcing the baseline to false).
 */
export interface AggregateInputExt extends AggregateInput {
  readonly packVisibility?: readonly PackVisibilityEntry[]
}

type ProcessedRun =
  | {
      readonly kind: 'ok'
      readonly metrics: ExtractedMetrics
      readonly id: string
      readonly runIndex: number
      // undefined when events.ndjson could not be read at all (older
      // workspace, ephemeral cleanup) — distinct from a file that exists and
      // profiles to zero gaps; the run then contributes no P5 data point at
      // all instead of a fabricated "0".
      readonly eventsProfile: EventsProfile | undefined
      /** `RunResult.initRan === true` — feeds SidePhaseSplit.runsWithLostInit (metric-split spec §5.4). */
      readonly initRan: boolean
    }
  | { readonly kind: 'failed'; readonly failedRun: FailedRun }

const errorCodeFor = (r: RunResult): ErrorCode => r.errorCode ?? 'E_RUN_CRASH'

/**
 * `run <variant>/<n> failed: ...` — also reconstructed by `src/cli/rebuild.ts`
 * (WP13) from the same bridged run result, to find and annotate
 * unrecoverable-outcome runs in the rendered Failed Runs table without
 * touching this file or `src/report/*`. Exported so both sides read the
 * exact same string builder instead of two hand-kept copies.
 */
export const failedRunMarker = (
  variant: string,
  r: {
    readonly runIndex: number
    readonly finishCause: string
    readonly exitCode: number
    readonly watchdogTriggered: boolean
  },
): string =>
  `run ${variant}/${String(r.runIndex)} failed: finishCause=${r.finishCause} exitCode=${String(r.exitCode)} watchdog=${String(r.watchdogTriggered)}`

export const toFailedRun = (r: RunResult, timestamp: string): FailedRun => ({
  variant: r.variant,
  runIndex: r.runIndex,
  errorCode: errorCodeFor(r),
  errorMessage: failedRunMarker(r.variant, r),
  timestamp,
})

const toExportInvalid = (variant: string, runIndex: number, cause: unknown): PhaseError =>
  aggregateError(
    `export invalid for ${variant}/run-${String(runIndex)}: missing or schema-mismatch`,
    'E_EXPORT_INVALID',
    {
      variant,
      runIndex,
      reason: 'missing-or-invalid-export',
      ...(cause === undefined ? {} : { cause }),
    },
  )

/**
 * A missing/unreadable events.ndjson (older workspace) yields no profile, not
 * a fabricated one. `boundaryTs`, when the run had an init phase (metric-
 * split spec §5.3/§5.4), scopes `timeToFirstToolMs`/`timeToFirstEditMs` to
 * the task phase — otherwise they'd measure the init session's first tool on
 * an init-bearing run.
 */
const readEventsProfile = (
  eventsLogPath: string,
  boundaryTs?: number,
): Effect.Effect<EventsProfile | undefined> =>
  readFile(eventsLogPath).pipe(
    Effect.map((raw) => profileEvents(raw, boundaryTs)),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

const readAndExtract = (
  r: RunResult,
  variant: string,
  rawDir: string,
  homeDirs: readonly string[],
  pricing: PricingTable | null,
  packNames: readonly string[],
  loader?: SessionTreeLoader,
): Effect.Effect<
  {
    readonly kind: 'ok'
    readonly metrics: ExtractedMetrics
    readonly id: string
    readonly runIndex: number
    readonly eventsProfile: EventsProfile | undefined
    readonly initRan: boolean
  },
  PhaseError
> =>
  Effect.gen(function* () {
    const file = path.join(rawDir, variant, `run-${String(r.runIndex)}.json`)
    const raw = yield* readFile(file).pipe(
      Effect.mapError((e: FsError) => toExportInvalid(variant, r.runIndex, e)),
    )
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) => toExportInvalid(variant, r.runIndex, e),
    })
    const result = opencodeExportSchema.safeParse(parsed)
    if (!result.success) {
      return yield* Effect.fail(toExportInvalid(variant, r.runIndex, result.error))
    }
    // Zod infers optionals as `T | undefined` while the generated OpencodeExport
    // uses exact-optional under exactOptionalPropertyTypes; the data is already
    // schema-validated, so the two are runtime-equivalent.
    const data = result.data as OpencodeExport
    const homeDir = homeDirs[r.runIndex - 1] ?? ''
    const tree = yield* loadTreeForRun(homeDir, data, loader)
    // Boundary is taken from the ROOT export (spec §2.2), same source
    // `extractMetricsFromTree` below uses internally for the phase split.
    const boundaryTs = findPhaseBoundary(data)?.boundaryTs
    const eventsProfile = yield* readEventsProfile(r.eventsLogPath, boundaryTs)
    return {
      kind: 'ok' as const,
      metrics: extractMetricsFromTree(tree, pricing, r.successRank, {
        ...(packNames.length === 0 ? {} : { packNames }),
      }),
      id: data.info.id,
      runIndex: r.runIndex,
      eventsProfile,
      initRan: r.initRan === true,
    }
  })

/**
 * `installed.json` (phase 06) has no contract schema of its own — it is a
 * disk artifact, not part of the Report contract — so a missing or
 * malformed file yields no signal rather than failing the phase;
 * `parseInstalledInventory` is already defensive about the parse itself.
 */
const readConfigDriftSignal = (
  configRoot: string,
  variant: string,
): Effect.Effect<ConfigDriftSignal | undefined> =>
  readFile(path.join(configRoot, '.config', 'opencode', variant, 'installed.json')).pipe(
    Effect.map((raw) => findConfigDriftSignal(parseInstalledInventory(raw))),
    Effect.catchAll(() => Effect.succeed(undefined)),
  )

const buildVerifyStats = (results: readonly RunResult[]): VerifyStats | undefined => {
  const passed = results.filter((r) => r.verifyExitCode === 0).length
  const failed = results.filter((r) => r.verifyExitCode !== undefined && r.verifyExitCode !== 0).length
  const timedOut = results.filter((r) => r.errorCode === 'E_VERIFY_TIMEOUT').length
  const runCount = passed + failed + timedOut
  return runCount === 0 ? undefined : { passed, failed, timedOut, runCount }
}

const visibilityConfirmedFor = (
  entries: readonly PackVisibilityEntry[] | undefined,
  variant: string,
  pack: string,
): boolean => (entries ?? []).some((e) => e.variant === variant && e.pack === pack && e.confirmed)

const aggregateVariant = (
  variant: VariantSpec,
  runInput: RunInput,
  results: readonly VariantRunResults[],
  workspace: WorkspaceTree,
  pricing: PricingTable | null,
  timestamp: string,
  allPackNames: readonly string[],
  canDetectByPack: ReadonlyMap<string, boolean>,
  packVisibility: readonly PackVisibilityEntry[] | undefined,
  loader?: SessionTreeLoader,
): Effect.Effect<VariantAggregates, PhaseError> =>
  Effect.gen(function* () {
    const runs = results.find((r) => r.name === variant.name)?.runs ?? []
    const homeDirs = workspace.variantTrees.find((t) => t.name === variant.name)?.homes ?? []
    const configDriftSignal = yield* readConfigDriftSignal(workspace.config, variant.name)
    const processed = yield* Effect.forEach(
      runs,
      (r): Effect.Effect<ProcessedRun, PhaseError> =>
        r.successRank === 0
          ? Effect.succeed({
              kind: 'failed' as const,
              failedRun: toFailedRun(r, timestamp),
            })
          : readAndExtract(r, variant.name, workspace.raw, homeDirs, pricing, allPackNames, loader),
      { concurrency: 1 },
    )
    const extracted = processed.flatMap((p) => (p.kind === 'ok' ? [p.metrics] : []))
    const extras = processed.flatMap((p) => (p.kind === 'ok' ? [p.metrics.extras] : []))
    const runIndexes = processed.flatMap((p) => (p.kind === 'ok' ? [p.runIndex] : []))
    const eventsProfiles = processed.flatMap((p) =>
      p.kind === 'ok' && p.eventsProfile !== undefined ? [p.eventsProfile] : [],
    )
    const rawRunIds = processed.flatMap((p) => (p.kind === 'ok' ? [p.id] : []))
    const failedRuns = processed.flatMap((p) => (p.kind === 'failed' ? [p.failedRun] : []))
    // Parallel to `extracted` — same filter/order as `extras`/`runIndexes` above.
    const initRanFlags = processed.flatMap((p) => (p.kind === 'ok' ? [p.initRan] : []))
    // Every ATTEMPTED run, not just successful ones — the pack-exercise
    // segment runs before the agent session, so a later agent crash doesn't
    // invalidate its own wall-clock reading (metric-split spec §6.1).
    const setupWallMsList = runs.map((r) => (r.setupWallMs === undefined ? undefined : toNum(r.setupWallMs)))
    const verifyStats = buildVerifyStats(runs)

    const packs = variant.packs.map((name) => ({
      name,
      canDetect: canDetectByPack.get(name) ?? false,
      visibilityConfirmed: visibilityConfirmedFor(packVisibility, variant.name, name),
    }))

    const aggInput: VariantAggregationInput = {
      variant: variant.name,
      extracted,
      failedRuns,
      rawRunIds,
      extras,
      runIndexes,
      eventsProfiles,
      packs,
      // `foreignPacksOf` (00-cli-parse.ts) is the CANONICAL foreign-set
      // computation, shared with gate 5's foreign-pack-absent check in
      // 05-preflight.ts — importing it (rather than a local reimplementation)
      // guarantees contamination attribution here and the preflight gate
      // never disagree on either membership OR declaration order (WP7 groups
      // contamination signals by this array's order, `metrics/aggregate.ts`).
      foreignPacks: foreignPacksOf(runInput, variant).map((p) => p.name),
      initRanFlags,
      setupWallMsList,
      ...(verifyStats === undefined ? {} : { verifyStats }),
      ...(configDriftSignal === undefined ? {} : { configDriftSignal }),
    }
    return buildVariantAggregates(aggInput)
  })

const ignorePricingError = (): Effect.Effect<null> => Effect.succeed(null)

export const aggregate = (
  input: AggregateInputExt,
  deps?: AggregateDeps,
): Effect.Effect<AggregateResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace, manifest, results } = input
    const loader = deps?.loadTree
    const pricing: PricingTable | null = runInput.pricingPath
      ? yield* loadPricing(runInput.pricingPath).pipe(Effect.catchAll(ignorePricingError))
      : null

    // Wave 1: only a skill pack shows up as tool parts in exports — plugin/
    // mcp/agent/command usage is invisible there, so canDetect is false for
    // them. Detected once per REGISTRY pack (not per variant): detectability
    // is a property of the pack itself, not of who declares it. `cliParse`
    // (00-cli-parse.ts) already resolves `PackSpec.type` for every pack
    // before phase 07 ever runs ("so downstream phases never re-detect") —
    // honor it and skip `detectPack` entirely when it is set; a pack the
    // user explicitly typed `skill` must not be silently re-derived as
    // something else from its ref. Only a pack that somehow arrives here
    // without a resolved type (e.g. a pre-normalization persisted input)
    // falls back to detection.
    const packDetections = yield* Effect.forEach(
      runInput.packs,
      (p): Effect.Effect<readonly [string, boolean]> =>
        p.type !== undefined
          ? Effect.succeed([p.name, p.type === 'skill'])
          : detectPack(p.ref).pipe(
              Effect.map((detected): readonly [string, boolean] => [p.name, detected.type === 'skill']),
              Effect.catchAll(() => Effect.succeed<readonly [string, boolean]>([p.name, false])),
            ),
      { concurrency: 1 },
    )
    const canDetectByPack = new Map(packDetections)
    // Extraction scans the FULL registry, not just each variant's own packs
    // — a variant's foreign-pack contamination signals only exist if
    // extraction was watching for that name too; `buildVariantAggregates`
    // below is the one that decides, per variant, which names are its own
    // vs. foreign (`03-hard-problems.md` §3.1 / phase-07 mechanics).
    const allPackNames = runInput.packs.map((p) => p.name)

    const timestamp = manifest.timestamp
    const variantAggregates = yield* Effect.forEach(
      runInput.variants,
      (v) =>
        aggregateVariant(
          v,
          runInput,
          results,
          workspace,
          pricing,
          timestamp,
          allPackNames,
          canDetectByPack,
          input.packVisibility,
          loader,
        ),
      { concurrency: 1 },
    )

    const metrics = computeMetricsReport(runInput.baseline, variantAggregates)
    const result: AggregateResult = { metrics }

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
