/**
 * v1 -> v2 artifact mapping (`.research/n-way-variants/01-contract.md` §7,
 * normative). v1 artifacts (workspaces from before the n-way variants
 * contract, `schemaVersion` absent) are parsed with the hand-frozen
 * `src/compat/v1-schemas.ts`, never the regenerated v2 schemas, then mapped
 * into the current (v2) generated types. This is the only module that
 * imports `v1-schemas.ts`.
 *
 * Every `parse*Compat` function tries the v2 schema first, then falls back
 * to the v1 schema + mapping ONLY when the artifact's v2-defining field is
 * genuinely absent (`hasOwnKey`, per artifact below) — never merely because
 * v2 validation failed. A v2-shaped document with an unrelated broken field
 * would otherwise parse cleanly as v1 (v1's required fields are a strict
 * subset of v2's, and zod drops unknown keys), silently discarding
 * everything v1 has no slot for. Callers that need to know whether a
 * workspace predates the contract (e.g. to pick the right on-disk path
 * layout) read the returned `schemaVersion`.
 */
import type { z } from 'zod'
import type {
  DiffRunResult,
  JudgeResult,
  Manifest,
  MetricDelta,
  MetricsReport,
  PackCmdResult,
  PhaseDeltas,
  PrepReport,
  PrimaryDeltas,
  Report,
  ReportSummary,
  RunInput,
  RunResult,
  Timeline,
  TimelineEvent,
  TimeoutConfig,
  VariantAggregates,
  VariantSpec,
} from '@generated/types'
import {
  judgeResultSchema,
  manifestSchema,
  prepReportSchema,
  reportSchema,
  runInputSchema,
  runResultSchema,
} from '@generated/schemas'
import {
  judgeResultV1Schema,
  manifestV1Schema,
  packSetupReportV1Schema,
  reportV1Schema,
  runInputV1Schema,
  runSideResultV1Schema,
} from './v1-schemas.js'
import type {
  diffRunResultV1Schema,
  failedRunV1Schema,
  initSideV1Schema,
  packCmdResultV1Schema,
  reportSummaryV1Schema,
  sideAggregatesV1Schema,
  timelineEventV1Schema,
} from './v1-schemas.js'
import { packShortName } from '../phases/00-cli-parse.js'

type ManifestV1 = z.infer<typeof manifestV1Schema>
type RunInputV1 = z.infer<typeof runInputV1Schema>
type ReportV1 = z.infer<typeof reportV1Schema>
type RunSideResultV1 = z.infer<typeof runSideResultV1Schema>
type JudgeResultV1 = z.infer<typeof judgeResultV1Schema>
type PackSetupReportV1 = z.infer<typeof packSetupReportV1Schema>
type PackCmdResultV1 = z.infer<typeof packCmdResultV1Schema>
type SideAggregatesV1 = z.infer<typeof sideAggregatesV1Schema>
type TimelineEventV1 = z.infer<typeof timelineEventV1Schema>
type FailedRunV1 = z.infer<typeof failedRunV1Schema>
type ReportSummaryV1 = z.infer<typeof reportSummaryV1Schema>
type InitSideV1 = z.infer<typeof initSideV1Schema>
type DiffRunResultV1 = z.infer<typeof diffRunResultV1Schema>

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** `packNameV1 = packShortName(manifest.packRef)`; `packRef` absent -> no packs. */
const packNameFor = (packRef: string | undefined): string | undefined =>
  packRef === undefined ? undefined : packShortName(packRef)

// ---------------------------------------------------------------------------
// Variant + pack synthesis (shared by Manifest and RunInput mapping)
// ---------------------------------------------------------------------------

const INIT_SIDE_VALUES: ReadonlySet<string> = new Set(['both', 'old', 'new'])

/**
 * `flagDefaults.initSide` is an untyped disclosure bag, the same channel
 * `dockerDowngraded` uses (`src/report/md.ts`'s `initSideLine` reads it the
 * same defensive way) — absent or not one of the three known values maps to
 * `'both'`, matching `DEFAULT_INIT_SIDE`.
 */
export const readInitSideDefensively = (flagDefaults: Record<string, unknown>): InitSideV1 => {
  const raw = flagDefaults['initSide']
  return typeof raw === 'string' && INIT_SIDE_VALUES.has(raw) ? (raw as InitSideV1) : 'both'
}

const packsForV1 = (
  packRef: string | undefined,
  packType: ManifestV1['packType'],
  setup: string | undefined,
  check: string | undefined,
) => {
  const name = packNameFor(packRef)
  if (packRef === undefined || name === undefined) return []
  return [
    {
      name,
      ref: packRef,
      ...(packType === undefined ? {} : { type: packType }),
      ...(setup === undefined ? {} : { setup }),
      ...(check === undefined ? {} : { check }),
    },
  ]
}

interface VariantSynthesisInput {
  readonly packRef: string | undefined
  readonly init: string | undefined
  readonly initSide: InitSideV1
  /** Manifest v1 never carried `pureBaseline` — callers without the real flag pass `true` (`DEFAULT_PURE_BASELINE`). */
  readonly oldPure: boolean
  readonly allowBaselineTool: boolean | undefined
  readonly packExercise: string | undefined
}

/** `variants: [{name:'old', packs:[], pure}, {name:'new', packs: packRef?[packNameV1]:[], pure:false}]`, plus init/exercise/allowPacks per the table. */
const synthesizeVariants = (input: VariantSynthesisInput): readonly [VariantSpec, VariantSpec] => {
  const packName = packNameFor(input.packRef)
  const oldVariant: VariantSpec = {
    name: 'old',
    packs: [],
    pure: input.oldPure,
    ...(input.init !== undefined && (input.initSide === 'both' || input.initSide === 'old')
      ? { init: input.init }
      : {}),
    ...(input.allowBaselineTool === true && packName !== undefined ? { allowPacks: [packName] } : {}),
  }
  const newVariant: VariantSpec = {
    name: 'new',
    packs: packName === undefined ? [] : [packName],
    pure: false,
    ...(input.init !== undefined && (input.initSide === 'both' || input.initSide === 'new')
      ? { init: input.init }
      : {}),
    ...(input.packExercise === undefined ? {} : { exercise: input.packExercise }),
  }
  return [oldVariant, newVariant]
}

// ---------------------------------------------------------------------------
// Manifest v1 -> v2
// ---------------------------------------------------------------------------

export const mapManifestV1ToV2 = (v1: ManifestV1): Manifest => {
  const initSide = readInitSideDefensively(v1.flagDefaults)
  const [oldVariant, newVariant] = synthesizeVariants({
    packRef: v1.packRef,
    init: v1.init,
    initSide,
    oldPure: true,
    allowBaselineTool: undefined,
    packExercise: v1.packExercise,
  })
  return {
    schemaVersion: 2,
    runId: v1.runId,
    timestamp: v1.timestamp,
    repoUrl: v1.repoUrl,
    prompt: v1.prompt,
    ...(v1.verify === undefined ? {} : { verify: v1.verify }),
    ...(v1.packHint === undefined ? {} : { hint: v1.packHint }),
    runs: v1.runs,
    parallel: 2,
    baseline: 'old',
    packs: packsForV1(v1.packRef, v1.packType, v1.packSetup, v1.packCheck),
    variants: [oldVariant, newVariant],
    isolation: v1.isolation,
    opencodeVersion: v1.opencodeVersion,
    flagDefaults: { ...v1.flagDefaults, migratedFromV1: true },
  }
}

// ---------------------------------------------------------------------------
// RunInput v1 -> v2
// ---------------------------------------------------------------------------

export const mapRunInputV1ToV2 = (v1: RunInputV1): RunInput => {
  const [oldVariant, newVariant] = synthesizeVariants({
    packRef: v1.packRef,
    init: v1.init,
    initSide: v1.initSide,
    oldPure: v1.pureBaseline,
    allowBaselineTool: v1.allowBaselineTool,
    packExercise: v1.packExercise,
  })
  return {
    schemaVersion: 2,
    repoUrl: v1.repoUrl,
    prompt: v1.prompt,
    ...(v1.promptFiles === undefined ? {} : { promptFiles: v1.promptFiles }),
    ...(v1.initFiles === undefined ? {} : { initFiles: v1.initFiles }),
    ...(v1.packHint === undefined ? {} : { hint: v1.packHint }),
    ...(v1.verify === undefined ? {} : { verify: v1.verify }),
    ...(v1.model === undefined ? {} : { model: v1.model }),
    runs: v1.runs,
    parallel: 2,
    baseline: 'old',
    packs: packsForV1(v1.packRef, v1.packType, v1.packSetup, v1.packCheck),
    variants: [oldVariant, newVariant],
    isolation: v1.isolation,
    ...(v1.dockerNetwork === undefined ? {} : { dockerNetwork: v1.dockerNetwork }),
    ...(v1.opencodeVersion === undefined ? {} : { opencodeVersion: v1.opencodeVersion }),
    auth: v1.auth,
    ...(v1.judge === undefined ? {} : { judge: v1.judge }),
    ...(v1.judgeFiles === undefined ? {} : { judgeFiles: v1.judgeFiles }),
    preflightEnabled: v1.preflightEnabled,
    ...(v1.preflightModel === undefined ? {} : { preflightModel: v1.preflightModel }),
    formats: v1.formats,
    outputPath: v1.outputPath,
    diffHtml: v1.diffHtml,
    protectGit: v1.protectGit,
    collapseRepeats: v1.collapseRepeats,
    timelineMode: v1.timelineMode,
    timeouts: v1.timeouts as TimeoutConfig,
    workspacePath: v1.workspacePath,
    logLevel: v1.logLevel,
    ...(v1.pricingPath === undefined ? {} : { pricingPath: v1.pricingPath }),
  }
}

// ---------------------------------------------------------------------------
// RunResult (was RunSideResult) v1 -> v2
// ---------------------------------------------------------------------------

export const mapRunResultV1ToV2 = (v1: RunSideResultV1): RunResult => {
  const { side, ...rest } = v1
  return { ...rest, variant: side } as RunResult
}

// ---------------------------------------------------------------------------
// Report v1 -> v2
// ---------------------------------------------------------------------------

const hasSamplesV1 = (agg: SideAggregatesV1): boolean => agg.stats.totalTokens.samples.length > 0

const mapSideAggregatesV1ToV2 = (
  agg: SideAggregatesV1,
  variant: 'old' | 'new',
  packName: string | undefined,
): VariantAggregates => ({
    variant,
    primary: agg.primary,
    secondary: agg.secondary,
    stats: agg.stats,
    failedRuns: agg.failedRuns.map((f) => ({ ...f, variant })),
    rawRunIds: agg.rawRunIds,
    ...(agg.packUse === undefined || packName === undefined ? {} : { packUses: [{ pack: packName, ...agg.packUse }] }),
    ...(agg.riskyCommands === undefined ? {} : { riskyCommands: agg.riskyCommands }),
    ...(agg.opencodeVersions === undefined ? {} : { opencodeVersions: agg.opencodeVersions }),
    ...(agg.verifyStats === undefined ? {} : { verifyStats: agg.verifyStats }),
    ...(agg.contaminationSignals === undefined
      ? {}
      : {
          // `install-drift` is a variant-level observation (installed.json
          // drift), not a pack's activity — v1's schema never carried a
          // `pack` field on it either. Stamping a real pack name here would
          // invent an attribution the source data never made, and disagree
          // with fresh v2 runs, which deliberately use `pack: ''` for the
          // same kind (WP7). Pack-activity signals (skill-call/bash-install)
          // still need a real pack name; dropped when none is known.
          contaminationSignals: agg.contaminationSignals.flatMap((c) =>
            c.kind === 'install-drift'
              ? [{ ...c, pack: '' }]
              : packName === undefined
                ? []
                : [{ ...c, pack: packName }],
          ),
        }),
    ...(agg.phaseSplit === undefined ? {} : { phaseSplit: agg.phaseSplit }),
  }) as VariantAggregates

const mapTimelineEventV1ToV2 = (e: TimelineEventV1, variant: 'old' | 'new'): TimelineEvent => ({
  tStart: e.tStart,
  tEnd: e.tEnd,
  variant,
  runIndex: e.runIndex,
  sessionId: e.sessionId,
  swimlaneDepth: e.swimlaneDepth,
  type: e.type,
  ...(e.parentSessionId === undefined ? {} : { parentSessionId: e.parentSessionId }),
  ...(e.tool === undefined ? {} : { tool: e.tool }),
  ...(e.tokens === undefined ? {} : { tokens: e.tokens }),
  ...(e.status === undefined ? {} : { status: e.status }),
})

/**
 * `timestamp` alone is NOT a reliable disambiguator: v1 stamped every
 * `FailedRun` with the whole run's `manifest.timestamp`
 * (`aggregateSide('old'|'new')` both received the same `timestamp` — the v2
 * source keeps the identical rule, `07-aggregate.ts:346`), so old/run-N and
 * new/run-N failing the SAME way (e.g. both `E_RUN_TIMEOUT`) collapses to
 * the same `runIndex|errorCode|timestamp` key — the ordinary correlated-
 * failure case, not a corner case. `errorMessage` closes it: it embeds the
 * side (`run ${side}/${n} failed: ...`, `failedRunMarker`), so it always
 * disambiguates even when every other field ties.
 */
const failedRunKeyV1 = (f: FailedRunV1): string =>
  `${String(f.runIndex)}|${f.errorCode}|${f.timestamp}|${f.errorMessage}`

/**
 * `summary.failures` (v1) is the concatenation of `metricsDiff.old.failedRuns`
 * then `.new.failedRuns` (`src/cli/summary.ts`'s `buildReportSummary`) — but
 * stamping `variant` here matches by MEMBERSHIP in the old pool (runIndex +
 * errorCode + timestamp), not by position, so this stays correct even if a
 * future v1 writer ever changes that concatenation order.
 */
const mapMetricDeltaV1ToV2 = (d: { readonly absolute: number; readonly percent?: number | undefined; readonly significant: boolean; readonly better: MetricDelta['better'] }): MetricDelta => ({
  absolute: d.absolute,
  significant: d.significant,
  better: d.better,
  ...(d.percent === undefined ? {} : { percent: d.percent }),
})

const mapReportSummaryV1ToV2 = (v1: ReportSummaryV1, oldFailedRuns: readonly FailedRunV1[]): ReportSummary => {
  const oldKeys = new Set(oldFailedRuns.map(failedRunKeyV1))
  const perVariant = [
    {
      variant: 'new',
      improvements: v1.improvements.map(mapMetricDeltaV1ToV2),
      regressions: v1.regressions.map(mapMetricDeltaV1ToV2),
      neutral: v1.neutral.map(mapMetricDeltaV1ToV2),
    },
  ]
  const failures = v1.failures.map((f) => ({
    ...f,
    variant: oldKeys.has(failedRunKeyV1(f)) ? ('old' as const) : ('new' as const),
  }))
  return {
    headlineResult: v1.headlineResult,
    perVariant,
    failures,
    ...(v1.basis === undefined ? {} : { basis: v1.basis }),
  }
}

/** Tie rule matches `selectSide` (`src/cli/compare.ts:122-126`): ties favor 'new'. */
export const mapJudgeResultV1ToV2 = (v1: JudgeResultV1): JudgeResult => {
  const scores = [
    { variant: 'old', quality: v1.oldQuality },
    { variant: 'new', quality: v1.newQuality },
  ]
  const ranking = v1.newQuality >= v1.oldQuality ? ['new', 'old'] : ['old', 'new']
  return {
    verdict: v1.verdict,
    scores,
    ranking,
    explanation: v1.explanation,
    ...(v1.rawResponse === undefined ? {} : { rawResponse: v1.rawResponse }),
    modelUsed: v1.modelUsed,
    timestamp: v1.timestamp,
    ...(v1.ran === undefined ? {} : { ran: v1.ran }),
  }
}

const mapPackCmdResultV1ToV2 = (c: PackCmdResultV1, pack: string): PackCmdResult => {
  const { side, ...rest } = c
  return { ...rest, variant: side, pack } as PackCmdResult
}

export const mapPackSetupReportV1ToV2 = (v1: PackSetupReportV1, packName: string): PrepReport => ({
  packs: [
    {
      pack: packName,
      mode: v1.mode,
      setupDeclared: v1.setupDeclared,
      checkDeclared: v1.checkDeclared,
      exerciseDeclared: v1.exerciseDeclared,
      ...(v1.undeclaredDepWarning === undefined ? {} : { undeclaredDepWarning: v1.undeclaredDepWarning }),
      setups: v1.setup === undefined ? [] : [mapPackCmdResultV1ToV2(v1.setup, packName)],
      checks: v1.checks.map((c) => mapPackCmdResultV1ToV2(c, packName)),
    },
  ],
  variants: [
    {
      variant: 'new',
      exerciseDeclared: v1.exerciseDeclared,
      exercises: v1.exercises.map((e) => mapPackCmdResultV1ToV2(e, packName)),
    },
  ],
})

const mapDiffRunResultV1ToV2 = (r: DiffRunResultV1): DiffRunResult => ({
  runIndex: r.runIndex,
  fullPatch: r.fullPatch,
  summary: r.summary,
  noChanges: r.noChanges,
  ...(r.htmlPath === undefined ? {} : { htmlPath: r.htmlPath }),
  ...(r.state === undefined ? {} : { state: r.state }),
  ...(r.error === undefined ? {} : { error: r.error }),
})

export const mapReportV1ToV2 = (v1: ReportV1): Report => {
  const manifest = mapManifestV1ToV2(v1.manifest)
  const packName = packNameFor(v1.manifest.packRef)

  const variants = [
    mapSideAggregatesV1ToV2(v1.metricsDiff.old, 'old', packName),
    mapSideAggregatesV1ToV2(v1.metricsDiff.new, 'new', packName),
  ]
  const metrics: MetricsReport = {
    baseline: 'old',
    variants,
    deltas: [
      {
        variant: 'new',
        deltas: v1.metricsDiff.deltas as PrimaryDeltas,
        ...(v1.metricsDiff.taskDeltas === undefined ? {} : { taskDeltas: v1.metricsDiff.taskDeltas as PhaseDeltas }),
        ...(v1.metricsDiff.initDeltas === undefined ? {} : { initDeltas: v1.metricsDiff.initDeltas as PhaseDeltas }),
        pairIncomplete: !hasSamplesV1(v1.metricsDiff.old) || !hasSamplesV1(v1.metricsDiff.new),
      },
    ],
    allFailed: v1.metricsDiff.bothFailed,
  }

  const timeline: Timeline = {
    lanes: [
      { variant: 'old', events: v1.timeline.old.map((e) => mapTimelineEventV1ToV2(e, 'old')) },
      { variant: 'new', events: v1.timeline.new.map((e) => mapTimelineEventV1ToV2(e, 'new')) },
    ],
    mode: v1.timeline.mode,
  }

  const diffs = [
    { variant: 'old', runs: v1.diff.old.runs.map(mapDiffRunResultV1ToV2) },
    { variant: 'new', runs: v1.diff.new.runs.map(mapDiffRunResultV1ToV2) },
  ]

  const summary = mapReportSummaryV1ToV2(v1.summary, v1.metricsDiff.old.failedRuns)

  return {
    schemaVersion: 2,
    manifest,
    metrics,
    timeline,
    diffs,
    ...(v1.judge === undefined ? {} : { judge: mapJudgeResultV1ToV2(v1.judge) }),
    summary,
    ...(v1.packSetup === undefined || packName === undefined
      ? {}
      : { prep: mapPackSetupReportV1ToV2(v1.packSetup, packName) }),
  }
}

// ---------------------------------------------------------------------------
// Try-v2-then-v1 parse wrappers.
//
// The v1 fallback is gated on the artifact's v2-defining field being
// ABSENT, never merely on "v2 parsing failed" (01-contract.md §7: "field
// absent -> parse with v1-schemas.ts"). Those are NOT the same test: a v1
// schema's required fields are a strict subset of its v2 counterpart's, and
// zod silently drops unknown keys — so a genuinely v2 document that fails
// v2 validation for an unrelated reason (a corrupted/truncated field deep
// inside it) can still parse cleanly as v1, silently discarding everything
// v1 never had a slot for (extra variants, real pack sets, ...) and
// reporting `schemaVersion: 1`. That is a v2 ERROR, not a v1 document, and
// must come back `undefined`, not a fabricated old/new remap.
// ---------------------------------------------------------------------------

const hasOwnKey = (raw: unknown, key: string): boolean =>
  typeof raw === 'object' && raw !== null && key in raw

export interface ManifestParseResult {
  readonly manifest: Manifest
  readonly schemaVersion: 1 | 2
}

export const parseManifestCompat = (raw: unknown): ManifestParseResult | undefined => {
  const v2 = manifestSchema.safeParse(raw)
  if (v2.success) return { manifest: v2.data as Manifest, schemaVersion: 2 }
  if (hasOwnKey(raw, 'schemaVersion')) return undefined
  const v1 = manifestV1Schema.safeParse(raw)
  return v1.success ? { manifest: mapManifestV1ToV2(v1.data), schemaVersion: 1 } : undefined
}

export interface RunInputParseResult {
  readonly runInput: RunInput
  readonly schemaVersion: 1 | 2
}

export const parseRunInputCompat = (raw: unknown): RunInputParseResult | undefined => {
  const v2 = runInputSchema.safeParse(raw)
  if (v2.success) return { runInput: v2.data as RunInput, schemaVersion: 2 }
  if (hasOwnKey(raw, 'schemaVersion')) return undefined
  const v1 = runInputV1Schema.safeParse(raw)
  return v1.success ? { runInput: mapRunInputV1ToV2(v1.data), schemaVersion: 1 } : undefined
}

export interface ReportParseResult {
  readonly report: Report
  readonly schemaVersion: 1 | 2
}

export const parseReportCompat = (raw: unknown): ReportParseResult | undefined => {
  const v2 = reportSchema.safeParse(raw)
  if (v2.success) return { report: v2.data as Report, schemaVersion: 2 }
  if (hasOwnKey(raw, 'schemaVersion')) return undefined
  const v1 = reportV1Schema.safeParse(raw)
  return v1.success ? { report: mapReportV1ToV2(v1.data), schemaVersion: 1 } : undefined
}

/** RunResult carries no `schemaVersion` of its own (it's a per-run file, not independently versioned) — `variant` (v2-only; v1 has `side` instead) is its v2-defining field. */
export const parseRunResultCompat = (raw: unknown): RunResult | undefined => {
  const v2 = runResultSchema.safeParse(raw)
  if (v2.success) return v2.data as RunResult
  if (hasOwnKey(raw, 'variant')) return undefined
  const v1 = runSideResultV1Schema.safeParse(raw)
  return v1.success ? mapRunResultV1ToV2(v1.data) : undefined
}

/** JudgeResult's v2-defining field is `scores` (v1 has `oldQuality`/`newQuality` instead). */
export const parseJudgeResultCompat = (raw: unknown): JudgeResult | undefined => {
  const v2 = judgeResultSchema.safeParse(raw)
  if (v2.success) return v2.data as JudgeResult
  if (hasOwnKey(raw, 'scores')) return undefined
  const v1 = judgeResultV1Schema.safeParse(raw)
  return v1.success ? mapJudgeResultV1ToV2(v1.data) : undefined
}

/**
 * `packName` is the run's single (Stage 1) pack name, when any — needed
 * only for the v1 fallback mapping. PrepReport's v2-defining field is
 * `packs` (top-level array; v1's PackSetupReport is a flat single-pack
 * shape with no `packs`/`variants` fields at all).
 */
export const parsePrepReportCompat = (raw: unknown, packName: string | undefined): PrepReport | undefined => {
  const v2 = prepReportSchema.safeParse(raw)
  if (v2.success) return v2.data as PrepReport
  if (hasOwnKey(raw, 'packs')) return undefined
  if (packName === undefined) return undefined
  const v1 = packSetupReportV1Schema.safeParse(raw)
  return v1.success ? mapPackSetupReportV1ToV2(v1.data, packName) : undefined
}
