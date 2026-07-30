/**
 * `testaipack report --rebuild`: recomputes phases 07 (aggregate) -> 08
 * (diff) -> 10 (timeline) -> 11 (report-render) from artifacts already on
 * disk. No agent, LLM, or docker call by default — the sub-agent session tree
 * walk phases 07/10 normally do via the opencode binary is disabled here (an
 * always-empty tree loader is injected into both, degrading to root-only
 * session data), and an existing `judge.json` verdict is reused verbatim,
 * never re-requested. The one opt-in exception is `--rejudge`: it permits
 * exactly one live call to phase 09 (`judge`) against the rebuilt diff, never
 * on by default, and the resulting verdict is disclosed as coming from a
 * re-judge over rebuilt data rather than from the original run.
 *
 * Two data paths, chosen per run:
 * - post-upgrade: `run-input.json` (§3) parses — the exact original input is
 *   used.
 * - pre-upgrade: `run-input.json` is missing. Falls back to best-effort
 *   recovery (`src/recovery/run-recovery.ts`) from `manifest.json` and
 *   `config/{baseline,new}.json`; unrecoverable fields take a CLI override
 *   when the caller supplies one, else a documented default. Every
 *   recovered / supplied / defaulted field is disclosed in the rebuilt
 *   report — pricing and judge get a loud warning, since a silent default
 *   there would misrepresent cost or imply judging was never requested.
 *
 * Same rule per run: `raw/<side>/run-N.result.json` (§3) is used when it
 * parses; otherwise the run's outcome is reconstructed from its `.log` /
 * `.events.ndjson`, and any field even that cannot recover (mainly a run
 * that died before writing a `[STOP]` line) takes a disclosed default.
 */
import { Effect } from 'effect'
import path from 'node:path'
import type {
  DiffResult,
  JudgeResult,
  Manifest,
  OutputFormat,
  PackSetupReport,
  ReportRenderInput,
  RunInput,
  Side,
  TimelineMode,
  WorkspaceTree,
} from '@generated/types'
import {
  runInputSchema,
  runSideResultSchema,
  errorCodeSchema,
  judgeResultSchema,
  opencodeExportSchema,
  packSetupReportSchema,
} from '@generated/schemas'
import { exists, isPathWithin, readFile, writeJson, writeFile } from '../util/fs.js'
import { findRun } from './workspace-runs.js'
import { buildTreePaths } from '../phases/01-workspace-setup.js'
import type { RunSideResultExt } from '../phases/06-run-side.js'
import { derivePackSetupMode } from '../phases/04b-pack-setup.js'
import { recoverRunResult, recoverManifestCensus } from '../recovery/run-recovery.js'
import type { ManifestFieldStatus, RecoveredRunResult } from '../recovery/run-recovery.js'
import { loadPricing } from '../pricing/lookup.js'
import { aggregate } from '../phases/07-aggregate.js'
import { diff } from '../phases/08-diff.js'
import { judge } from '../phases/09-judge.js'
import { timeline } from '../phases/10-timeline.js'
import { reportRender } from '../phases/11-report-render.js'
import { buildReportSummary } from './summary.js'
import {
  DEFAULT_ALLOW_BASELINE_TOOL,
  DEFAULT_AUTH,
  DEFAULT_COLLAPSE_REPEATS,
  DEFAULT_DIFF_HTML,
  DEFAULT_FORMATS,
  DEFAULT_INIT_SIDE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PREFLIGHT_ENABLED,
  DEFAULT_PURE_BASELINE,
  DEFAULT_TIMELINE_MODE,
  DEFAULT_TIMEOUTS,
} from '../phases/00-cli-parse.js'

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

export interface RebuildFlags {
  readonly runId: string | undefined
  readonly workspace: string
  readonly force: boolean
  /** Empty = not supplied on this rebuild command. */
  readonly formats: readonly OutputFormat[]
  /**
   * Disclosure-only unless `rejudge` is also set: without `--rejudge` this is
   * never fed to an LLM. With `--rejudge`, it becomes the instructions for
   * the one permitted live judge call (falling back to the original
   * `run-input.json` judge instructions, in exact mode, when not supplied).
   */
  readonly judge: string | undefined
  /** The one opt-in exception to "rebuild invokes no LLM" — see the module doc. */
  readonly rejudge: boolean
  readonly pricingPath: string | undefined
  readonly diffHtml: boolean | undefined
  readonly collapseRepeats: boolean | undefined
  readonly timelineMode: TimelineMode | undefined
}

// ---------------------------------------------------------------------------
// Provenance — what was recovered / supplied / defaulted, per field
// ---------------------------------------------------------------------------

export type ProvenanceSource = 'recovered' | 'supplied' | 'defaulted'

export interface ProvenanceEntry {
  readonly field: string
  readonly source: ProvenanceSource
  readonly note: string
}

export interface RunProvenance {
  readonly side: Side
  readonly runIndex: number
  readonly source: 'result-json' | 'log-recovery'
  readonly defaultedFields: readonly string[]
}

export type JudgeDisclosureState =
  | 'reused'
  | 'rejudged'
  | 'confirmed-not-requested'
  | 'requested-but-missing'
  | 'unknown'

export interface JudgeDisclosure {
  readonly state: JudgeDisclosureState
  readonly note: string
}

export type PackSetupDisclosureState = 'reused' | 'confirmed-not-used' | 'unavailable'

export interface PackSetupDisclosure {
  readonly state: PackSetupDisclosureState
  readonly note: string
}

export interface RebuildProvenance {
  readonly runInputMode: 'exact' | 'recovered'
  readonly fields: readonly ProvenanceEntry[]
  readonly runs: readonly RunProvenance[]
  readonly judge: JudgeDisclosure
  readonly packSetup: PackSetupDisclosure
  readonly pricingWarning: string | undefined
}

// ---------------------------------------------------------------------------
// RunInput resolution
// ---------------------------------------------------------------------------

const readJsonOrUndefined = (filePath: string): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    const has = yield* exists(filePath)
    if (!has) return undefined
    const raw = yield* readFile(filePath).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (raw === '') return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })

const readRunInputExact = (runRoot: string): Effect.Effect<RunInput | undefined> =>
  Effect.gen(function* () {
    const parsed = yield* readJsonOrUndefined(path.join(runRoot, 'run-input.json'))
    if (parsed === undefined) return undefined
    const check = runInputSchema.safeParse(parsed)
    return check.success ? (check.data as RunInput) : undefined
  })

const censusNote = (fields: readonly ManifestFieldStatus[], field: string): string =>
  fields.find((f) => f.field === field)?.note ?? ''

/** One CLI-overridable field: an explicit flag wins, else a disclosed default (nothing to "recover" for these — see the census). */
const resolveOverridable = <T>(
  field: string,
  supplied: T | undefined,
  fallback: T,
  census: readonly ManifestFieldStatus[],
): { readonly value: T; readonly entry: ProvenanceEntry } =>
  supplied !== undefined
    ? { value: supplied, entry: { field, source: 'supplied', note: 'given on the rebuild command' } }
    : { value: fallback, entry: { field, source: 'defaulted', note: censusNote(census, field) } }

interface SyntheticRunInputResult {
  readonly runInput: RunInput
  readonly fields: readonly ProvenanceEntry[]
}

const MANIFEST_RECOVERABLE_FIELDS: readonly string[] = [
  'repoUrl', 'packRef', 'packType', 'prompt', 'init', 'verify', 'runs', 'isolation', 'opencodeVersion',
]

/** `manifest.flagDefaults.protectGit` exists only for workspaces produced since --protect-git shipped (`pipeline.ts`). */
const manifestProtectGit = (manifest: Manifest): boolean | undefined => {
  const raw = manifest.flagDefaults['protectGit']
  return typeof raw === 'boolean' ? raw : undefined
}

const resolveProtectGit = (
  manifest: Manifest,
  gitDirsOldRun1: string,
): Effect.Effect<{ readonly value: boolean; readonly source: 'manifest' | 'disk-evidence' }> =>
  Effect.gen(function* () {
    const fromManifest = manifestProtectGit(manifest)
    if (fromManifest !== undefined) return { value: fromManifest, source: 'manifest' as const }
    const detected = yield* exists(gitDirsOldRun1)
    return { value: detected, source: 'disk-evidence' as const }
  })

const FOREVER_DEFAULTED_FIELDS: readonly string[] = [
  'auth', 'pureBaseline', 'initSide', 'preflightEnabled', 'dockerNetwork', 'preflightModel', 'timeouts', 'workspacePath', 'logLevel',
  'allowBaselineTool',
]

/**
 * Builds a best-effort `RunInput` for a workspace with no `run-input.json`,
 * from `manifest.json` (via `recoverManifestCensus`) plus any CLI override.
 * `resultsDir` is the in-workspace `results/` — a pre-upgrade workspace never
 * recorded a custom `--output`, so this is the only value available.
 * `protectGit` is never guessed: `resolveProtectGit` prefers
 * `manifest.flagDefaults.protectGit` (written by `pipeline.ts` since the
 * --protect-git feature landed — the stronger, authoritative signal when
 * present) and falls back to checking whether `gitdirs/old/run-1` actually
 * exists on disk (`repoClone` only populates it when `--protect-git` moved
 * `.git` there — real evidence for workspaces from before that manifest
 * field existed) — either way `diff` looks in the right place for a
 * protected run's `.git`.
 */
const buildSyntheticRunInput = (
  manifest: Manifest,
  runRoot: string,
  resultsDir: string,
  census: { readonly modelFoundInConfig: boolean; readonly fields: readonly ManifestFieldStatus[] },
  overrides: RebuildFlags,
  protectGit: { readonly value: boolean; readonly source: 'manifest' | 'disk-evidence' },
): SyntheticRunInputResult => {
  const fs = census.fields
  const formats = resolveOverridable('formats', overrides.formats.length > 0 ? overrides.formats : undefined, DEFAULT_FORMATS, fs)
  const pricingPath = resolveOverridable<string | undefined>('pricingPath', overrides.pricingPath, undefined, fs)
  const diffHtml = resolveOverridable('diffHtml', overrides.diffHtml, DEFAULT_DIFF_HTML, fs)
  const collapseRepeats = resolveOverridable('collapseRepeats', overrides.collapseRepeats, DEFAULT_COLLAPSE_REPEATS, fs)
  const timelineMode = resolveOverridable('timelineMode', overrides.timelineMode, DEFAULT_TIMELINE_MODE, fs)

  const runInput: RunInput = {
    repoUrl: manifest.repoUrl,
    ...(manifest.packRef === undefined ? {} : { packRef: manifest.packRef }),
    ...(manifest.packType === undefined ? {} : { packType: manifest.packType }),
    prompt: manifest.prompt,
    ...(manifest.init === undefined ? {} : { init: manifest.init }),
    initSide: DEFAULT_INIT_SIDE,
    ...(manifest.verify === undefined ? {} : { verify: manifest.verify }),
    ...(manifest.packSetup === undefined ? {} : { packSetup: manifest.packSetup }),
    ...(manifest.packCheck === undefined ? {} : { packCheck: manifest.packCheck }),
    ...(manifest.packExercise === undefined ? {} : { packExercise: manifest.packExercise }),
    runs: manifest.runs,
    isolation: manifest.isolation,
    opencodeVersion: manifest.opencodeVersion,
    auth: DEFAULT_AUTH,
    pureBaseline: DEFAULT_PURE_BASELINE,
    protectGit: protectGit.value,
    preflightEnabled: DEFAULT_PREFLIGHT_ENABLED,
    allowBaselineTool: DEFAULT_ALLOW_BASELINE_TOOL,
    formats: [...formats.value],
    outputPath: resultsDir,
    diffHtml: diffHtml.value,
    collapseRepeats: collapseRepeats.value,
    timelineMode: timelineMode.value,
    timeouts: DEFAULT_TIMEOUTS,
    workspacePath: path.dirname(runRoot),
    logLevel: DEFAULT_LOG_LEVEL,
    ...(pricingPath.value === undefined ? {} : { pricingPath: pricingPath.value }),
  }

  const recoveredEntries: readonly ProvenanceEntry[] = MANIFEST_RECOVERABLE_FIELDS.flatMap((field) => {
    const status = fs.find((f) => f.field === field)
    if (status === undefined) return []
    return [{ field, source: status.recoverable ? 'recovered' : 'defaulted', note: status.note }]
  })
  const modelEntry: ProvenanceEntry = {
    field: 'model',
    source: census.modelFoundInConfig ? 'recovered' : 'defaulted',
    note: censusNote(fs, 'model'),
  }
  const protectGitEntry: ProvenanceEntry = {
    field: 'protectGit',
    source: 'recovered',
    note:
      protectGit.source === 'manifest'
        ? `recovered from manifest.flagDefaults.protectGit (written by pipeline.ts since --protect-git shipped): ${String(protectGit.value)}`
        : `manifest.flagDefaults has no protectGit entry (workspace predates that field) — detected instead from whether gitdirs/old/run-1 exists on disk: ${String(protectGit.value)}`,
  }
  const foreverDefaultedEntries: readonly ProvenanceEntry[] = FOREVER_DEFAULTED_FIELDS.map((field) => {
    const base = censusNote(fs, field)
    const suffix = 'irrelevant to a rebuilt report — only governs a live run'
    return { field, source: 'defaulted' as const, note: base === '' ? suffix : `${base} (${suffix})` }
  })

  return {
    runInput,
    fields: [
      ...recoveredEntries,
      modelEntry,
      protectGitEntry,
      formats.entry,
      pricingPath.entry,
      diffHtml.entry,
      collapseRepeats.entry,
      timelineMode.entry,
      ...foreverDefaultedEntries,
    ],
  }
}

const OVERRIDABLE_KEYS = ['formats', 'pricingPath', 'diffHtml', 'collapseRepeats', 'timelineMode'] as const

/** Applies any CLI override on top of an exactly-recovered `run-input.json`. An explicit flag always wins. */
const applyOverrides = (
  runInput: RunInput,
  overrides: RebuildFlags,
): { readonly runInput: RunInput; readonly fields: readonly ProvenanceEntry[] } => {
  const values: Partial<RunInput> = {
    ...(overrides.formats.length > 0 ? { formats: [...overrides.formats] } : {}),
    ...(overrides.pricingPath === undefined ? {} : { pricingPath: overrides.pricingPath }),
    ...(overrides.diffHtml === undefined ? {} : { diffHtml: overrides.diffHtml }),
    ...(overrides.collapseRepeats === undefined ? {} : { collapseRepeats: overrides.collapseRepeats }),
    ...(overrides.timelineMode === undefined ? {} : { timelineMode: overrides.timelineMode }),
  }
  const fields: readonly ProvenanceEntry[] = OVERRIDABLE_KEYS.flatMap((key) =>
    key in values
      ? [{ field: key, source: 'supplied' as const, note: 'given on the rebuild command, overrides run-input.json' }]
      : [],
  )
  return { runInput: { ...runInput, ...values }, fields }
}

// ---------------------------------------------------------------------------
// Per-run RunSideResult resolution
// ---------------------------------------------------------------------------

const runSideResultExtSchema = runSideResultSchema.extend({ errorCode: errorCodeSchema.optional() })

const readResultJson = (
  rawDir: string,
  side: Side,
  runIndex: number,
): Effect.Effect<RunSideResultExt | undefined> =>
  Effect.gen(function* () {
    const parsed = yield* readJsonOrUndefined(path.join(rawDir, side, `run-${String(runIndex)}.result.json`))
    if (parsed === undefined) return undefined
    const check = runSideResultExtSchema.safeParse(parsed)
    return check.success ? (check.data as RunSideResultExt) : undefined
  })

const RECOVERABLE_RESULT_FIELDS: readonly (keyof RecoveredRunResult)[] = [
  'successRank', 'finishCause', 'exitCode', 'durationMs', 'watchdogTriggered',
]

const defaultedFieldsOf = (r: RecoveredRunResult): readonly string[] =>
  RECOVERABLE_RESULT_FIELDS.flatMap((key) => (r[key] === undefined ? [key] : []))

/**
 * Bridges the recovery module's `| undefined` fields to the contract's
 * required ones. `errorCode` is left absent — phase 07 already falls back to
 * `E_RUN_CRASH` for any rank-0 run without one (`errorCodeFor`,
 * `07-aggregate.ts`), so re-deriving it here would duplicate that policy.
 * `initRan` mirrors the live path's convention (`06-run-side.ts`): present
 * (`true`) only when an init invocation actually ran, absent otherwise —
 * `recovered.initRan` is never guessed, it comes straight from the `.log`'s
 * `[INIT_DONE]` line (metric-split spec §5.8), so this keeps
 * `runsWithLostInit` honest under log recovery too. `initWallMs`/
 * `promptWallMs` have no durable trace in the `.log` and stay unrecoverable.
 */
const bridgeRecovered = (
  recovered: RecoveredRunResult,
): { readonly result: RunSideResultExt; readonly defaultedFields: readonly string[] } => {
  const result: RunSideResultExt = {
    side: recovered.side,
    runIndex: recovered.runIndex,
    exportPath: recovered.exportPath,
    eventsLogPath: recovered.eventsLogPath,
    successRank: recovered.successRank ?? 0,
    finishCause: recovered.finishCause ?? 'error',
    exitCode: recovered.exitCode ?? -1,
    durationMs: recovered.durationMs ?? '0',
    watchdogTriggered: recovered.watchdogTriggered ?? false,
    ...(recovered.verifyExitCode === undefined ? {} : { verifyExitCode: recovered.verifyExitCode }),
    ...(recovered.initRan ? { initRan: true } : {}),
  }
  return { result, defaultedFields: defaultedFieldsOf(recovered) }
}

const resolveSideResult = (
  rawDir: string,
  side: Side,
  runIndex: number,
): Effect.Effect<{ readonly result: RunSideResultExt; readonly provenance: RunProvenance }> =>
  Effect.gen(function* () {
    const fromResultJson = yield* readResultJson(rawDir, side, runIndex)
    if (fromResultJson !== undefined) {
      return {
        result: fromResultJson,
        provenance: { side, runIndex, source: 'result-json' as const, defaultedFields: [] },
      }
    }
    const recovered = yield* recoverRunResult(rawDir, side, runIndex, opencodeExportSchema)
    const { result, defaultedFields } = bridgeRecovered(recovered)
    return { result, provenance: { side, runIndex, source: 'log-recovery' as const, defaultedFields } }
  })

const resolveSideResults = (
  rawDir: string,
  side: Side,
  runs: number,
): Effect.Effect<{ readonly results: readonly RunSideResultExt[]; readonly provenance: readonly RunProvenance[] }> =>
  Effect.gen(function* () {
    const range = Array.from({ length: runs }, (_, i) => i + 1)
    const resolved = yield* Effect.forEach(range, (n) => resolveSideResult(rawDir, side, n), { concurrency: 1 })
    return { results: resolved.map((r) => r.result), provenance: resolved.map((r) => r.provenance) }
  })

// ---------------------------------------------------------------------------
// Judge — reuse only, never re-invoked
// ---------------------------------------------------------------------------

const truncateJudgeText = (s: string): string => (s.length > 120 ? `${s.slice(0, 120)}...` : s)

const resolveJudge = (
  resultsDir: string,
  runInputMode: 'exact' | 'recovered',
  runInput: RunInput,
  originalJudge: string | undefined,
  judgeHint: string | undefined,
  rejudge: boolean,
  manifest: Manifest,
  diffResult: { readonly old: DiffResult; readonly new: DiffResult },
): Effect.Effect<{ readonly judge: JudgeResult | undefined; readonly disclosure: JudgeDisclosure }> =>
  Effect.gen(function* () {
    if (rejudge) {
      const instructions = judgeHint ?? originalJudge
      if (instructions === undefined) {
        return {
          judge: undefined,
          disclosure: {
            state: 'unknown' as const,
            note: '--rejudge was requested but no judge instructions are available (supply --judge "..."); no verdict produced',
          },
        }
      }
      const outcome = yield* Effect.either(
        judge({ runInput: { ...runInput, judge: instructions }, manifest, diff: diffResult }),
      )
      if (outcome._tag === 'Left') {
        return {
          judge: undefined,
          disclosure: {
            state: 'unknown' as const,
            note: `--rejudge failed: [${outcome.left.code}] ${outcome.left.message}; no verdict produced`,
          },
        }
      }
      if (outcome.right.judge === null) {
        return {
          judge: undefined,
          disclosure: { state: 'unknown' as const, note: '--rejudge ran but produced no verdict' },
        }
      }
      return {
        judge: outcome.right.judge as JudgeResult,
        disclosure: {
          state: 'rejudged' as const,
          note: 'verdict came from a re-judge over rebuilt data (--rejudge), not the original run',
        },
      }
    }

    const parsedJudge = yield* readJsonOrUndefined(path.join(resultsDir, 'judge.json'))
    const check = parsedJudge === undefined ? undefined : judgeResultSchema.safeParse(parsedJudge)
    if (check?.success === true) {
      return {
        judge: check.data as JudgeResult,
        disclosure: { state: 'reused', note: 'existing verdict in judge.json reused verbatim; judge was not re-invoked' },
      }
    }
    if (runInputMode === 'exact') {
      if (originalJudge !== undefined) {
        return {
          judge: undefined,
          disclosure: {
            state: 'requested-but-missing',
            note: `the original run requested judging (instructions: "${truncateJudgeText(originalJudge)}") but no verdict was ever persisted to judge.json — pass --rejudge to judge the rebuilt data now, or rerun live to reproduce the original`,
          },
        }
      }
      return {
        judge: undefined,
        disclosure: { state: 'confirmed-not-requested', note: 'run-input.json confirms --judge was not set on the original run' },
      }
    }
    if (judgeHint !== undefined) {
      return {
        judge: undefined,
        disclosure: {
          state: 'unknown',
          note: `this workspace predates run-input.json, so whether the ORIGINAL run used --judge cannot be confirmed. You supplied judge instructions on this rebuild command ("${truncateJudgeText(judgeHint)}") but not --rejudge, so no LLM was invoked and no verdict is produced`,
        },
      }
    }
    return {
      judge: undefined,
      disclosure: {
        state: 'unknown',
        note: 'this workspace predates run-input.json; whether --judge was originally requested cannot be determined. The absence of a verdict below does not confirm judging was skipped',
      },
    }
  })

// ---------------------------------------------------------------------------
// Pack setup — reuse only, never recomputed (harness shell-command evidence,
// nothing else on disk can reconstruct it)
// ---------------------------------------------------------------------------

/**
 * Reads back `results/pack-setup.json` — the same `PackSetupReport`
 * `pipeline.ts` writes once at the end of a live run — and threads it into
 * the rebuilt report verbatim. Unlike aggregate/diff/timeline, this is never
 * recomputed: `checks`/`exercises` are exit codes and output tails from
 * harness-run shell commands, and nothing else on disk (raw exports, git
 * diffs) records them.
 *
 * A missing file is genuinely ambiguous: either no `--pack-setup`/
 * `--pack-check`/`--pack-exercise` was ever declared for this run (correct
 * absence — the section should stay absent), or one WAS declared but the
 * evidence file itself did not survive (a workspace predating this artifact,
 * or the original run crashed before `pipeline.ts`'s write). The manifest's
 * own `packSetup`/`packCheck`/`packExercise` provenance strings are written
 * whenever declared regardless of `pack-setup.json`'s fate, so they settle
 * the ambiguity: absence there means genuinely unused; presence there with
 * `pack-setup.json` missing means "declared, evidence lost" — and that case
 * gets a synthesized report instead of silent omission, so "the section is
 * absent" is never mistaken for "no pack setup was used". `mode` in that
 * synthesized report is derived conservatively (never `exercised` — that
 * claims verification this path cannot prove) and `checks`/`exercises` stay
 * empty, since no per-run exit code survives outside the missing file.
 */
const resolvePackSetup = (
  resultsDir: string,
  manifest: Manifest,
): Effect.Effect<{ readonly packSetup: PackSetupReport | undefined; readonly disclosure: PackSetupDisclosure }> =>
  Effect.gen(function* () {
    const parsed = yield* readJsonOrUndefined(path.join(resultsDir, 'pack-setup.json'))
    const check = parsed === undefined ? undefined : packSetupReportSchema.safeParse(parsed)
    if (check?.success === true) {
      return {
        packSetup: check.data as PackSetupReport,
        disclosure: {
          state: 'reused' as const,
          note: 'pack-setup.json reused verbatim; harness pack preparation was not re-run',
        },
      }
    }

    const setupDeclared = manifest.packSetup !== undefined
    const checkDeclared = manifest.packCheck !== undefined
    const exerciseDeclared = manifest.packExercise !== undefined
    if (!setupDeclared && !checkDeclared && !exerciseDeclared) {
      return {
        packSetup: undefined,
        disclosure: {
          state: 'confirmed-not-used' as const,
          note: 'manifest confirms no --pack-setup/--pack-check/--pack-exercise was declared on the original run',
        },
      }
    }

    return {
      packSetup: {
        mode: derivePackSetupMode(setupDeclared, false, false),
        setupDeclared,
        checkDeclared,
        exerciseDeclared,
        checks: [],
        exercises: [],
      },
      disclosure: {
        state: 'unavailable' as const,
        note: 'manifest shows pack-setup was declared (packSetup/packCheck/packExercise), but pack-setup.json is missing or unreadable — mode below is a conservative lower bound, not verified evidence, and per-run check/exercise rows could not be recovered',
      },
    }
  })

// ---------------------------------------------------------------------------
// Disclosure rendering + patching the misleading "not requested" judge line
// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<ProvenanceSource, string> = {
  recovered: 'recovered',
  supplied: 'supplied on the command line',
  defaulted: 'defaulted',
}

/**
 * A proper `##`-level section (not a top-of-file blockquote) so it reads as
 * one clearly delimited part of the report, spliced in before `## Summary`
 * by `applyDisclosure` — see the note there on why this lives outside
 * `src/report/*`.
 */
const renderProvenanceMd = (p: RebuildProvenance): string => {
  const header =
    p.runInputMode === 'exact'
      ? '> ⚠ **This report was rebuilt** (`testaipack report --rebuild`) from a run whose full `run-input.json` survived — inputs below are exact, not guessed.'
      : '> ⚠ **This report was rebuilt** (`testaipack report --rebuild`) from a workspace that predates `run-input.json` — some inputs are recovered best-effort, some are defaulted. See the field table below.'
  const fieldLines = p.fields.map(
    (f) => `> - \`${f.field}\`: ${SOURCE_LABEL[f.source]}${f.note === '' ? '' : ` — ${f.note}`}`,
  )
  const runLines = p.runs
    .filter((r) => r.source === 'log-recovery')
    .map(
      (r) =>
        `> - ${r.side}/run-${String(r.runIndex)}: recovered from its \`.log\`/\`.events.ndjson\`${r.defaultedFields.length === 0 ? '' : `, defaulted: ${r.defaultedFields.join(', ')}${r.defaultedFields.includes('successRank') ? ' — **outcome unrecoverable** (no [STOP] line found; rank/finishCause below are placeholders, not a real failure)' : ' (no [STOP] line found)'}`}`,
    )
  const pricingLine = p.pricingWarning === undefined ? [] : [`> ⚠ ${p.pricingWarning}`]
  const body = [
    header,
    '>',
    ...fieldLines,
    ...(runLines.length === 0 ? [] : ['>', '> Per-run recovery:', ...runLines]),
    '>',
    `> - **judge**: ${p.judge.note}`,
    `> - **pack setup**: ${p.packSetup.note}`,
    ...pricingLine,
  ].join('\n')
  return `## Rebuild provenance\n\n${body}`
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const renderProvenanceHtml = (p: RebuildProvenance): string => {
  const header =
    p.runInputMode === 'exact'
      ? 'This report was rebuilt (testaipack report --rebuild) from a run whose full run-input.json survived — inputs are exact, not guessed.'
      : 'This report was rebuilt (testaipack report --rebuild) from a workspace that predates run-input.json — some inputs are recovered best-effort, some are defaulted.'
  const fieldItems = p.fields
    .map((f) => `<li><code>${escapeHtml(f.field)}</code>: ${escapeHtml(SOURCE_LABEL[f.source])}${f.note === '' ? '' : ` — ${escapeHtml(f.note)}`}</li>`)
    .join('')
  const pricingItem = p.pricingWarning === undefined ? '' : `<li><strong>${escapeHtml(p.pricingWarning)}</strong></li>`
  return `<section class="rebuild-provenance"><h2>Rebuild provenance</h2><p>${escapeHtml(header)}</p><ul>${fieldItems}<li><strong>judge</strong>: ${escapeHtml(p.judge.note)}</li><li><strong>pack setup</strong>: ${escapeHtml(p.packSetup.note)}</li>${pricingItem}</ul></section>`
}

const JUDGE_NOT_REQUESTED_MD = '_Judge was not requested (--judge not set)_'
const JUDGE_NOT_REQUESTED_HTML = '<em>Judge was not requested.</em>'
const MD_SUMMARY_HEADING = '## Summary'
const OUTCOME_UNRECOVERABLE_NOTE = ' — outcome unrecoverable, see Rebuild provenance (this is NOT a confirmed failure)'

const patchOnce = (content: string, marker: string, replacement: string): string =>
  content.includes(marker) ? content.replace(marker, replacement) : content

const patchAppend = (content: string, marker: string, suffix: string): string =>
  content.includes(marker) ? content.replace(marker, `${marker}${suffix}`) : content

/**
 * `toFailedRun` (`src/phases/07-aggregate.ts`) builds this exact
 * `errorMessage` shape for every rank-0 run. Reconstructed here (from the
 * same bridged `RunSideResultExt` this module fed into `aggregate`) so the
 * unrecoverable-outcome runs can be found and annotated in the rendered
 * Failed Runs table without touching `07-aggregate.ts` or `src/report/*`.
 */
const failedRunMarker = (
  side: Side,
  r: { readonly runIndex: number; readonly finishCause: string; readonly exitCode: number; readonly watchdogTriggered: boolean },
): string =>
  `run ${side}/${String(r.runIndex)} failed: finishCause=${r.finishCause} exitCode=${String(r.exitCode)} watchdog=${String(r.watchdogTriggered)}`

/**
 * Per requirement: "we could not tell how this run ended" must not render
 * identically to "this run ended badly". Only runs whose `successRank` was
 * itself defaulted (no `[STOP]` line at all, so rank/finishCause are
 * placeholders, not a recovered fact) qualify — a run genuinely recovered as
 * rank 0 from a real `[STOP] finish=error rank=0` line is a confirmed
 * failure and is left alone.
 */
const unrecoverableOutcomeMarkers = (
  provenance: RebuildProvenance,
  oldResults: readonly RunSideResultExt[],
  newResults: readonly RunSideResultExt[],
): readonly string[] =>
  provenance.runs
    .filter((r) => r.defaultedFields.includes('successRank'))
    .flatMap((r) => {
      const pool = r.side === 'old' ? oldResults : newResults
      const result = pool.find((x) => x.runIndex === r.runIndex)
      return result === undefined ? [] : [failedRunMarker(r.side, result)]
    })

/**
 * Matches `<body>` with or without attributes (`<body class="...">` etc.) —
 * a literal `'<body>'` string match would silently no-op the day the
 * renderer's template gains one, dropping the disclosure section from
 * report.html with no signal. Warns (does not throw — a missing banner in
 * the html is not worth aborting an otherwise-successful rebuild over) if
 * even that fails to match.
 */
const BODY_TAG_RE = /<body(?:\s[^>]*)?>/i

export const injectAfterBodyTag = (html: string, injection: string): string => {
  if (!BODY_TAG_RE.test(html)) {
    console.error(
      'rebuild: no <body> tag found in the rendered report.html — the rebuild-provenance section could not be injected into it (report.md and report.json still carry it)',
    )
    return html
  }
  return html.replace(BODY_TAG_RE, (tag) => `${tag}${injection}`)
}

/**
 * `renderJudge` (`src/report/md.ts`/`html.ts`) always renders "not requested"
 * when `report.judge` is absent — accurate for a live run, but for a
 * requested-but-missing or genuinely unknown judge state that line would
 * misrepresent the run. Patched here (string substitution on the rendered
 * output) rather than in the renderer, to keep this change out of
 * `src/report/*`. The provenance section itself is spliced in before
 * `## Summary` (a proper, clearly delimited section) rather than prepended
 * ahead of the report title.
 */
const applyDisclosure = (
  mdContent: string,
  htmlContent: string | undefined,
  provenance: RebuildProvenance,
  oldResults: readonly RunSideResultExt[],
  newResults: readonly RunSideResultExt[],
): { readonly md: string; readonly html: string | undefined } => {
  const needsJudgeCorrection =
    provenance.judge.state === 'requested-but-missing' || provenance.judge.state === 'unknown'
  const unrecoverableMarkers = unrecoverableOutcomeMarkers(provenance, oldResults, newResults)

  const mdWithJudge = needsJudgeCorrection
    ? patchOnce(mdContent, JUDGE_NOT_REQUESTED_MD, `_${provenance.judge.note}_`)
    : mdContent
  const mdBody = unrecoverableMarkers.reduce(
    (acc, marker) => patchAppend(acc, marker, OUTCOME_UNRECOVERABLE_NOTE),
    mdWithJudge,
  )
  const md = mdBody.includes(MD_SUMMARY_HEADING)
    ? mdBody.replace(MD_SUMMARY_HEADING, `${renderProvenanceMd(provenance)}\n\n---\n\n${MD_SUMMARY_HEADING}`)
    : `${renderProvenanceMd(provenance)}\n\n${mdBody}`
  if (htmlContent === undefined) return { md, html: undefined }
  const htmlWithJudge = needsJudgeCorrection
    ? patchOnce(htmlContent, JUDGE_NOT_REQUESTED_HTML, `<em>${escapeHtml(provenance.judge.note)}</em>`)
    : htmlContent
  const htmlBody = unrecoverableMarkers.reduce(
    (acc, marker) => patchAppend(acc, marker, ` <strong>${escapeHtml(OUTCOME_UNRECOVERABLE_NOTE)}</strong>`),
    htmlWithJudge,
  )
  const html = injectAfterBodyTag(htmlBody, renderProvenanceHtml(provenance))
  return { md, html }
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const missingWorktrees = (
  tree: WorkspaceTree,
  runs: number,
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const range = Array.from({ length: runs }, (_, i) => i)
    const checks: readonly { readonly label: string; readonly dir: string }[] = range.flatMap((i) => [
      { label: `old/run-${String(i + 1)}`, dir: tree.appsOld[i] ?? '' },
      { label: `new/run-${String(i + 1)}`, dir: tree.appsNew[i] ?? '' },
    ])
    const results = yield* Effect.forEach(checks, (c) =>
      Effect.gen(function* () {
        const has = c.dir !== '' && (yield* exists(c.dir))
        return has ? [] : [c.label]
      }),
    )
    return results.flat()
  })

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const executeRebuild = async (flags: RebuildFlags): Promise<number> => {
  const found = await Effect.runPromise(findRun(flags.workspace, flags.runId))
  if (found === null) {
    console.error(
      `no run found in ${flags.workspace}${flags.runId === undefined ? '' : ` matching "${flags.runId}"`}`,
    )
    return 1
  }
  const runRoot = found.dir
  const manifest = found.manifest

  const exact = await Effect.runPromise(readRunInputExact(runRoot))
  const runInputMode: 'exact' | 'recovered' = exact === undefined ? 'recovered' : 'exact'

  const treePaths = buildTreePaths(runRoot, manifest.runs)
  const baseResolution: SyntheticRunInputResult = await (async () => {
    if (exact !== undefined) return { runInput: exact, fields: [] }
    const census = await Effect.runPromise(recoverManifestCensus(runRoot))
    const protectGit = await Effect.runPromise(resolveProtectGit(manifest, treePaths.gitDirsOld[0] ?? ''))
    return buildSyntheticRunInput(manifest, runRoot, treePaths.results, census, flags, protectGit)
  })()
  const overridden = applyOverrides(baseResolution.runInput, flags)
  const fields = [...baseResolution.fields, ...overridden.fields]

  // The explicitly passed --workspace always wins over a recorded
  // outputPath — never the other way round. `runInput.outputPath` (exact
  // mode: read straight from the original run's run-input.json; recovered
  // mode: a --output the original run used) can be an absolute path from
  // wherever/whenever the ORIGINAL run happened, on a different machine or
  // location than the workspace this --rebuild was pointed at. Honoring it
  // let `--rebuild --workspace <copy>` silently redirect writes back onto
  // the original — the exact scenario copying a workspace exists to avoid
  // (see the incident this fixes). A disagreement is ignored with a clear
  // notice, not gated behind an opt-in flag: that would leave the unsafe
  // behavior one flag away from being the default.
  const recordedOutputPath = overridden.runInput.outputPath
  const outputPathIgnored = recordedOutputPath !== treePaths.results
  const runInput: RunInput = outputPathIgnored
    ? { ...overridden.runInput, outputPath: treePaths.results }
    : overridden.runInput
  if (outputPathIgnored) {
    console.error(
      `rebuild: run-input.json records outputPath=${recordedOutputPath}, which is outside this --workspace's results dir (${treePaths.results}) — ignoring it and writing inside the given --workspace, as always. A copied or archived workspace must never redirect rebuild output back to wherever the original run wrote.`,
    )
  }

  const treePathsUsed: WorkspaceTree = treePaths

  // Hard guard, independent of the fix above: refuse to proceed if a future
  // path-handling change ever computes a results/diff path outside the
  // workspace root again — a regression here must fail loudly, never write
  // outside the tree the caller pointed --rebuild at.
  if (!isPathWithin(treePaths.root, treePathsUsed.results) || !isPathWithin(treePaths.root, treePathsUsed.diff)) {
    console.error(
      `rebuild: refusing to write outside the workspace root (${treePaths.root}): resolved results=${treePathsUsed.results} diff=${treePathsUsed.diff}`,
    )
    return 1
  }

  // Refusal: report.json already exists — never silently overwrite the one
  // artifact `list`/`compare`/`report` all read, unless --force.
  const reportJsonPath = path.join(treePathsUsed.results, 'report.json')
  if ((await Effect.runPromise(exists(reportJsonPath))) && !flags.force) {
    console.error(`report.json already exists (${reportJsonPath}); pass --force to overwrite`)
    return 1
  }

  // Refusal: app worktrees gone (--ephemeral or gc) — diff genuinely cannot
  // be recomputed without them; say exactly which are missing.
  const missing = await Effect.runPromise(missingWorktrees(treePathsUsed, manifest.runs))
  if (missing.length > 0) {
    console.error(
      `app worktrees are gone (--ephemeral or gc ran): missing ${missing.join(', ')}; rebuild cannot recompute diffs without them`,
    )
    return 1
  }

  const oldSide = await Effect.runPromise(resolveSideResults(treePaths.raw, 'old', manifest.runs))
  const newSide = await Effect.runPromise(resolveSideResults(treePaths.raw, 'new', manifest.runs))
  const sideResults = {
    old: [...oldSide.results],
    new: [...newSide.results],
  }

  // No opencode/* import anywhere in this module (grep-checkable) — the
  // sub-agent session tree walk both phases can do is disabled by always
  // returning an empty tree, which `loadTreeForRun` degrades to root-only.
  const noSubAgentTree = { loadTree: () => Effect.succeed([]) }

  const aggOutcome = await Effect.runPromise(
    Effect.either(aggregate({ runInput, manifest, workspace: treePathsUsed, sideResults }, noSubAgentTree)),
  )
  if (aggOutcome._tag === 'Left') {
    console.error(`[aggregate] ${aggOutcome.left.code}: ${aggOutcome.left.message}`)
    return 1
  }

  const diffOutcome = await Effect.runPromise(Effect.either(diff({ runInput, manifest, workspace: treePathsUsed })))
  if (diffOutcome._tag === 'Left') {
    console.error(`[diff] ${diffOutcome.left.code}: ${diffOutcome.left.message}`)
    return 1
  }

  const originalJudge = runInputMode === 'exact' ? exact?.judge : undefined
  const judgeResolution = await Effect.runPromise(
    resolveJudge(
      treePathsUsed.results,
      runInputMode,
      runInput,
      originalJudge,
      flags.judge,
      flags.rejudge,
      manifest,
      diffOutcome.right.diff,
    ),
  )
  const packSetupResolution = await Effect.runPromise(resolvePackSetup(treePathsUsed.results, manifest))

  const timelineOutcome = await Effect.runPromise(
    Effect.either(timeline({ runInput, manifest, workspace: treePathsUsed, sideResults }, noSubAgentTree)),
  )
  if (timelineOutcome._tag === 'Left') {
    console.error(`[timeline] ${timelineOutcome.left.code}: ${timelineOutcome.left.message}`)
    return 1
  }

  // Pricing: warn loudly whenever cost figures can silently mis-price a local/
  // custom model — either no pricingPath was ever recoverable/supplied, or one
  // IS configured (recovered exact, or --pricing-path) but unreadable right
  // now (aggregate's own `loadPricing` failure is swallowed, matching
  // `07-aggregate.ts`'s existing silent-fallback behavior — probed
  // independently here rather than changing that shared phase).
  const pricingNeverAvailable = fields.find((f) => f.field === 'pricingPath')?.source === 'defaulted'
  const pricingProbe =
    !pricingNeverAvailable && runInput.pricingPath !== undefined
      ? await Effect.runPromise(Effect.either(loadPricing(runInput.pricingPath)))
      : undefined
  const pricingUnreadable = pricingProbe !== undefined && pricingProbe._tag === 'Left'
  const pricingWarning = pricingNeverAvailable
    ? 'pricingPath was not recoverable and none was supplied (--pricing-path) — cost figures use the built-in pricing table, which will misprice a local/custom model'
    : pricingUnreadable
      ? `pricingPath is set (${runInput.pricingPath ?? ''}) but could not be read/parsed at rebuild time (aggregate silently falls back to the built-in pricing table) — cost figures will misprice a local/custom model; fix the path or re-supply --pricing-path`
      : undefined
  // Stderr is the only sink every `--format` reads: report.md's blockquote and
  // the sidecar `rebuild-provenance.json` field are both invisible to a
  // `--format json` caller printing report.json to stdout.
  if (pricingWarning !== undefined) {
    console.error(`rebuild: ${pricingWarning}`)
  }

  const summary = buildReportSummary(aggOutcome.right.metricsDiff)

  // Honesty gap: report.json (and the --format json stdout path) must also
  // carry a rebuild signal, not just the human-readable md/html sections —
  // `list`/`compare`/a plain `report` reprint all read report.json, never
  // the patched md. `flagDefaults` is the one contract field already typed
  // as an open record (`recordUnknownSchema` — no strict-object stripping),
  // so this survives every schema round-trip without a contract change.
  const rebuiltManifest: Manifest = {
    ...manifest,
    flagDefaults: {
      ...manifest.flagDefaults,
      rebuilt: true,
      rebuiltAt: new Date().toISOString(),
      rebuiltRunInputMode: runInputMode,
      rebuiltJudgeState: judgeResolution.disclosure.state,
      rebuiltPackSetupState: packSetupResolution.disclosure.state,
      rebuiltPricingWarning: pricingWarning !== undefined,
    },
  }

  const reportInput: ReportRenderInput = {
    runInput,
    manifest: rebuiltManifest,
    metricsDiff: aggOutcome.right.metricsDiff,
    timeline: timelineOutcome.right.timeline,
    diff: diffOutcome.right.diff,
    summary,
    ...(judgeResolution.judge === undefined ? {} : { judge: judgeResolution.judge }),
    ...(packSetupResolution.packSetup === undefined ? {} : { packSetup: packSetupResolution.packSetup }),
  }
  const renderOutcome = await Effect.runPromise(Effect.either(reportRender(reportInput)))
  if (renderOutcome._tag === 'Left') {
    console.error(`[report-render] ${renderOutcome.left.code}: ${renderOutcome.left.message}`)
    return 1
  }
  const render = renderOutcome.right

  const provenance: RebuildProvenance = {
    runInputMode,
    fields,
    runs: [...oldSide.provenance, ...newSide.provenance],
    judge: judgeResolution.disclosure,
    packSetup: packSetupResolution.disclosure,
    pricingWarning,
  }

  // `reportRender` always writes report.md (its own invariant, independent of
  // `runInput.formats`) — read that back rather than `render.stdoutMd`, which
  // is only populated when 'md' is in formats. Using `stdoutMd ?? ''` here
  // used to truncate an existing, fully-rendered report.md down to just the
  // provenance blockquote whenever the recovered/original formats excluded
  // 'md' (e.g. exact mode read `formats: ["json"]` from run-input.json) —
  // silent data loss on the one artifact this command exists to rescue.
  const mdReadBack =
    render.paths.md === undefined
      ? undefined
      : await Effect.runPromise(
          readFile(render.paths.md).pipe(Effect.either),
        )
  // A failed read-back here means the file `reportRender` just wrote is
  // unreadable a moment later — leave it untouched rather than patch and
  // overwrite it with a `render.stdoutMd ?? ''` stub, which would silently
  // replace a real report.md with an empty/truncated one.
  const mdContent = mdReadBack !== undefined && mdReadBack._tag === 'Right' ? mdReadBack.right : (render.stdoutMd ?? '')
  const mdReadFailed = mdReadBack !== undefined && mdReadBack._tag === 'Left'
  const htmlContent =
    render.paths.html === undefined
      ? undefined
      : await Effect.runPromise(
          readFile(render.paths.html).pipe(Effect.catchAll(() => Effect.succeed(undefined as string | undefined))),
        )
  const patched = applyDisclosure(mdContent, htmlContent, provenance, oldSide.results, newSide.results)

  if (render.paths.md !== undefined && !mdReadFailed) {
    await Effect.runPromise(writeFile(render.paths.md, patched.md).pipe(Effect.ignore))
  } else if (mdReadFailed) {
    console.error(
      `rebuild: could not read back ${render.paths.md ?? ''} after rendering — leaving it as written by report-render, without the rebuild-disclosure banner (report.json still carries the rebuild markers)`,
    )
  }
  if (patched.html !== undefined && render.paths.html !== undefined) {
    await Effect.runPromise(writeFile(render.paths.html, patched.html).pipe(Effect.ignore))
  }
  await Effect.runPromise(
    writeJson(path.join(treePathsUsed.results, 'rebuild-provenance.json'), provenance).pipe(Effect.ignore),
  )

  if (render.stdoutMd !== undefined) {
    process.stdout.write(`${patched.md}\n`)
  } else if (render.stdoutJson !== undefined) {
    // Carries the rebuild markers too — they are baked into `rebuiltManifest`
    // before `reportRender` runs, not patched onto the string afterward.
    process.stdout.write(render.stdoutJson)
  }

  return 0
}
