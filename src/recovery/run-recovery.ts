/**
 * Reconstructs what a finished (or crashed) run left behind on disk, for
 * workspaces where the pipeline died before persisting a structured result —
 * e.g. phase 08 aborting the whole run before 09/10/11/12 ever wrote
 * anything. `RunSideResult` itself is never serialized as JSON anywhere; the
 * only durable trace of a run's outcome is the free-text
 * `results/raw/<side>/run-N.log` line `[STOP] finish=... rank=...
 * durationMs=...` written by phase 06 (`src/phases/06-run-side.ts`), plus
 * the export/events files next to it.
 *
 * Every field here is `undefined` unless a durable artifact directly says
 * so — nothing is inferred or guessed. `errorCode` cannot be recovered by
 * this module under any circumstance: it is never written to the `.log`
 * text, only carried in the in-memory `RunSideResultExt` (see
 * `notRecoverableFields`).
 *
 * Read-only: never writes to the workspace it inspects. No CLI or pipeline
 * wiring here on purpose — a later rebuild command owns that.
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { ZodType } from 'zod'
import type { FinishCause, Side, SuccessRank } from '@generated/types'
import { exists, readFile } from '../util/fs.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields of the wire `RunSideResult` this module can never fill in. */
export const NOT_RECOVERABLE_FIELDS: readonly string[] = ['errorCode']

export interface RunArtifactDiagnostics {
  readonly logPath: string
  readonly logExists: boolean
  readonly exportPath: string
  readonly exportExists: boolean
  readonly exportValid: boolean
  readonly eventsLogPath: string
  readonly eventsExists: boolean
  readonly eventsLineCount: number
  readonly eventsParseableLineCount: number
  readonly exportAttempts: number
  readonly verifyTimedOut: boolean
}

export interface RecoveredRunResult {
  readonly side: Side
  readonly runIndex: number
  readonly exportPath: string
  readonly eventsLogPath: string
  readonly successRank: SuccessRank | undefined
  readonly finishCause: FinishCause | undefined
  readonly exitCode: number | undefined
  readonly durationMs: string | undefined
  readonly verifyExitCode: number | undefined
  readonly watchdogTriggered: boolean | undefined
  readonly diagnostics: RunArtifactDiagnostics
  readonly notRecoverable: readonly string[]
}

// ---------------------------------------------------------------------------
// Pure log-line parsing
// ---------------------------------------------------------------------------

const FINISH_VALUES: ReadonlySet<string> = new Set([
  'stop',
  'tool-calls',
  'length',
  'error',
  'other',
  'unknown',
])

/** `[TAG] key=val key=val ...` — the shape every 06-run-side.ts log line uses. */
const parseTaggedLine = (line: string): { readonly tag: string; readonly fields: Record<string, string> } | undefined => {
  const trimmed = line.trim()
  const tagMatch = /^\[([A-Z_]+)\]\s*(.*)$/.exec(trimmed)
  if (tagMatch === null) return undefined
  const tag = tagMatch[1] ?? ''
  const rest = tagMatch[2] ?? ''
  const fields = rest
    .split(/\s+/)
    .filter((tok) => tok.includes('='))
    .reduce<Record<string, string>>((acc, tok) => {
      const idx = tok.indexOf('=')
      const key = tok.slice(0, idx)
      const value = tok.slice(idx + 1)
      return key === '' ? acc : { ...acc, [key]: value }
    }, {})
  return { tag, fields }
}

const parseIntField = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined
  if (!/^-?\d+$/.test(v)) return undefined
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

const parseBoolField = (v: string | undefined): boolean | undefined => {
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

const parseFinishField = (v: string | undefined): FinishCause | undefined =>
  v !== undefined && FINISH_VALUES.has(v) ? (v as FinishCause) : undefined

const parseDurationField = (v: string | undefined): string | undefined =>
  v !== undefined && /^\d+$/.test(v) ? v : undefined

interface DoneFields {
  readonly exitCode: number | undefined
  readonly watchdog: boolean | undefined
}

interface ParsedLog {
  readonly initDone: DoneFields | undefined
  readonly promptDone: DoneFields | undefined
  readonly stopFinish: FinishCause | undefined
  readonly stopRank: number | undefined
  readonly stopDurationMs: string | undefined
  readonly verifyExitCode: number | undefined
  readonly verifyTimedOut: boolean
  readonly exportAttempts: number
}

const EMPTY_PARSED_LOG: ParsedLog = {
  initDone: undefined,
  promptDone: undefined,
  stopFinish: undefined,
  stopRank: undefined,
  stopDurationMs: undefined,
  verifyExitCode: undefined,
  verifyTimedOut: false,
  exportAttempts: 0,
}

/**
 * A successful export attempt logs two `[EXPORT]` lines ("requesting" then
 * "written to") carrying the same `attempt N` number — counting lines would
 * double the real retry count, so this reads the highest `N` seen instead.
 */
const EXPORT_ATTEMPT_RE = /^\[EXPORT]\s+attempt\s+(\d+):/

const maxExportAttempt = (lines: readonly string[]): number =>
  lines.reduce((max, line) => {
    const m = EXPORT_ATTEMPT_RE.exec(line.trim())
    if (m?.[1] === undefined) return max
    const n = Number.parseInt(m[1], 10)
    return Number.isFinite(n) && n > max ? n : max
  }, 0)

/** Pure: turns raw `.log` text into every field it durably carries. Never throws. */
export const parseRunLog = (logText: string): ParsedLog => {
  const lines = logText.split('\n')
  const base = lines
    .map(parseTaggedLine)
    .filter((p): p is NonNullable<typeof p> => p !== undefined)
    .reduce<ParsedLog>((acc, { tag, fields }) => {
      if (tag === 'INIT_DONE') {
        return { ...acc, initDone: { exitCode: parseIntField(fields['exitCode']), watchdog: parseBoolField(fields['watchdog']) } }
      }
      if (tag === 'PROMPT_DONE') {
        return { ...acc, promptDone: { exitCode: parseIntField(fields['exitCode']), watchdog: parseBoolField(fields['watchdog']) } }
      }
      if (tag === 'STOP') {
        return {
          ...acc,
          stopFinish: parseFinishField(fields['finish']),
          stopRank: parseIntField(fields['rank']),
          stopDurationMs: parseDurationField(fields['durationMs']),
        }
      }
      if (tag === 'VERIFY_DONE') {
        return { ...acc, verifyExitCode: parseIntField(fields['exitCode']) }
      }
      if (tag === 'VERIFY_TIMEOUT') {
        return { ...acc, verifyTimedOut: true }
      }
      return acc
    }, EMPTY_PARSED_LOG)
  return { ...base, exportAttempts: maxExportAttempt(lines) }
}

/**
 * Mirrors `runSide`'s combine rule (`06-run-side.ts`): the first non-zero
 * exit among init-then-prompt wins, else the last attempted call's exit.
 * `undefined` only when neither call left a parseable `*_DONE` line.
 */
export const combineExitCode = (init: number | undefined, prompt: number | undefined): number | undefined => {
  if (init !== undefined && init !== 0) return init
  if (prompt !== undefined) return prompt
  return init
}

/** `true` if either call watchdog-triggered, `false` only if both are known and neither did, else unknown. */
export const combineWatchdog = (init: boolean | undefined, prompt: boolean | undefined): boolean | undefined => {
  if (init === true || prompt === true) return true
  if (init === undefined && prompt === undefined) return undefined
  return false
}

// ---------------------------------------------------------------------------
// Filesystem-backed recovery
// ---------------------------------------------------------------------------

const countLines = (text: string): number => text.split('\n').filter((l) => l.trim() !== '').length

const countParseableLines = (text: string): number =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .reduce((acc, l) => {
      try {
        JSON.parse(l)
        return acc + 1
      } catch {
        return acc
      }
    }, 0)

/**
 * `rawDir` is the workspace's `results/raw` directory (same path
 * `WorkspaceTree.raw` points to) — passed as a plain string so this module
 * has no dependency on the contract or on a live pipeline run.
 */
export const recoverRunResult = (
  rawDir: string,
  side: Side,
  runIndex: number,
  exportSchema: ZodType,
): Effect.Effect<RecoveredRunResult> =>
  Effect.gen(function* () {
    const sideDir = path.join(rawDir, side)
    const logPath = path.join(sideDir, `run-${String(runIndex)}.log`)
    const exportPath = path.join(sideDir, `run-${String(runIndex)}.json`)
    const eventsLogPath = path.join(sideDir, `run-${String(runIndex)}.events.ndjson`)

    const logExists = yield* exists(logPath)
    const logText = logExists ? yield* readFile(logPath).pipe(Effect.catchAll(() => Effect.succeed(''))) : ''
    const parsed = parseRunLog(logText)

    const exportExists = yield* exists(exportPath)
    const exportValid = exportExists
      ? yield* readFile(exportPath).pipe(
          Effect.catchAll(() => Effect.succeed('')),
          Effect.map((raw) => {
            try {
              return exportSchema.safeParse(JSON.parse(raw)).success
            } catch {
              return false
            }
          }),
        )
      : false

    const eventsExists = yield* exists(eventsLogPath)
    const eventsText = eventsExists ? yield* readFile(eventsLogPath).pipe(Effect.catchAll(() => Effect.succeed(''))) : ''

    const diagnostics: RunArtifactDiagnostics = {
      logPath,
      logExists,
      exportPath,
      exportExists,
      exportValid,
      eventsLogPath,
      eventsExists,
      eventsLineCount: countLines(eventsText),
      eventsParseableLineCount: countParseableLines(eventsText),
      exportAttempts: parsed.exportAttempts,
      verifyTimedOut: parsed.verifyTimedOut,
    }

    return {
      side,
      runIndex,
      exportPath,
      eventsLogPath,
      successRank: parsed.stopRank,
      finishCause: parsed.stopFinish,
      exitCode: combineExitCode(parsed.initDone?.exitCode, parsed.promptDone?.exitCode),
      durationMs: parsed.stopDurationMs,
      verifyExitCode: parsed.verifyTimedOut ? undefined : parsed.verifyExitCode,
      watchdogTriggered: combineWatchdog(parsed.initDone?.watchdog, parsed.promptDone?.watchdog),
      diagnostics,
      notRecoverable: NOT_RECOVERABLE_FIELDS,
    }
  })

// ---------------------------------------------------------------------------
// RunInput field census (§2 — what survives in manifest.json / config/*.json)
// ---------------------------------------------------------------------------

export type FieldRecoverySource = 'manifest' | 'config' | 'external-argument' | 'not-recoverable'

export interface ManifestFieldStatus {
  readonly field: string
  readonly recoverable: boolean
  readonly source: FieldRecoverySource
  readonly note: string
}

const has = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined && obj[key] !== null

/**
 * Pure: given the parsed `manifest.json` object and whether `model` turned
 * up in `config/{baseline,new}.json`, report each `RunInput` field's
 * recoverability. `manifest` field names are those the current `Manifest`
 * contract (`contract/main.tsp`) actually declares — fields the contract has
 * never carried are marked not-recoverable regardless of what any single
 * instance happens to contain.
 */
export const censusManifestFields = (
  manifest: Record<string, unknown>,
  modelFoundInConfig: boolean,
): readonly ManifestFieldStatus[] => [
  { field: 'repoUrl', recoverable: has(manifest, 'repoUrl'), source: 'manifest', note: 'credential-redacted copy (redactUrlCredentials), not byte-identical to the original clone URL' },
  { field: 'packRef', recoverable: has(manifest, 'packRef'), source: 'manifest', note: 'credential-redacted + safeRefDisplay copy; absent for smoke-test runs' },
  { field: 'packType', recoverable: has(manifest, 'packType'), source: 'manifest', note: 'absent when no pack was installed' },
  { field: 'prompt', recoverable: has(manifest, 'prompt'), source: 'manifest', note: 'verbatim resolved text, not the original --prompt-file path' },
  { field: 'promptFiles', recoverable: false, source: 'not-recoverable', note: 'file path lost; only the resolved prompt text survives — irrelevant for a report-only rebuild since opencode is not re-run' },
  { field: 'init', recoverable: has(manifest, 'init'), source: 'manifest', note: 'verbatim resolved text' },
  { field: 'initFiles', recoverable: false, source: 'not-recoverable', note: 'same as promptFiles' },
  { field: 'verify', recoverable: has(manifest, 'verify'), source: 'manifest', note: 'absent when --verify was not used' },
  { field: 'runs', recoverable: has(manifest, 'runs'), source: 'manifest', note: '' },
  { field: 'isolation', recoverable: has(manifest, 'isolation'), source: 'manifest', note: '' },
  { field: 'dockerNetwork', recoverable: false, source: 'not-recoverable', note: 'Manifest never carries it; only matters for re-running opencode, not for rebuilding a report from existing raw exports' },
  { field: 'opencodeVersion', recoverable: has(manifest, 'opencodeVersion'), source: 'manifest', note: 'for isolation=docker workspaces recorded before the phase-01 probe fix, this may be the HOST binary version, not the one the runs actually used' },
  { field: 'auth', recoverable: false, source: 'not-recoverable', note: 'Manifest never carries it; only matters for re-running opencode' },
  { field: 'pureBaseline', recoverable: false, source: 'not-recoverable', note: "Manifest never carries it; its effect is already baked into the old side's raw exports" },
  { field: 'judge', recoverable: false, source: 'not-recoverable', note: 'Manifest never carries it, and no judge.json is ever written — a rebuild cannot know whether judging was requested or reproduce the original verdict, only run a new one' },
  { field: 'judgeFiles', recoverable: false, source: 'not-recoverable', note: 'same as judge' },
  { field: 'preflightEnabled', recoverable: false, source: 'not-recoverable', note: 'inferable only indirectly from preflight.log presence/content, not a structured field' },
  { field: 'preflightModel', recoverable: false, source: 'not-recoverable', note: 'Manifest never carries it' },
  { field: 'model', recoverable: modelFoundInConfig, source: modelFoundInConfig ? 'config' : 'not-recoverable', note: 'not in manifest.json at all — only recoverable from config/baseline.json or config/new.json, which phase 04 has always written' },
  { field: 'formats', recoverable: false, source: 'not-recoverable', note: 'report format(s) requested; must default (likely md) — may not match what the user originally asked for' },
  { field: 'outputPath', recoverable: false, source: 'not-recoverable', note: "not recorded; inferable only by absence of a separate --output tree next to results/, which is not a reliable positive signal" },
  { field: 'diffHtml', recoverable: false, source: 'not-recoverable', note: 'no side.html anywhere to infer from when phase 08 died before writing any — must default, and the rebuilt report may link to files it never generates or vice versa' },
  { field: 'collapseRepeats', recoverable: false, source: 'not-recoverable', note: 'report-formatting-only option, no artifact reveals it' },
  { field: 'timelineMode', recoverable: false, source: 'not-recoverable', note: 'no timeline.html exists to infer from; must default' },
  { field: 'timeouts', recoverable: false, source: 'not-recoverable', note: 'only matters for re-running opencode, not for rebuilding a report from existing raw exports' },
  { field: 'workspacePath', recoverable: true, source: 'external-argument', note: 'given externally as the path the rebuild command is pointed at, not read from any file' },
  { field: 'logLevel', recoverable: false, source: 'not-recoverable', note: 'only affects live progress output, irrelevant to a rebuild' },
  { field: 'pricingPath', recoverable: false, source: 'not-recoverable', note: 'not recorded — a rebuilt report falls back to the built-in pricing table, which can silently mis-price a custom/local model (e.g. an ollama model) the original run had a --pricing-path entry for' },
]

const readJsonRecord = (p: string): Effect.Effect<Record<string, unknown>> =>
  Effect.gen(function* () {
    if (!(yield* exists(p))) return {}
    const raw = yield* readFile(p).pipe(Effect.catchAll(() => Effect.succeed('')))
    try {
      const obj: unknown = JSON.parse(raw)
      return obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  })

export interface ManifestCensusResult {
  readonly manifest: Record<string, unknown>
  readonly modelFoundInConfig: boolean
  readonly fields: readonly ManifestFieldStatus[]
}

/**
 * `runRoot` is one run directory (e.g. `<workspace>/<run-id>/`, the same
 * level `manifest.json` and `config/` live at). Reads `manifest.json` plus
 * `config/{baseline,new}.json` (only for the `model` field — see the note on
 * that entry) and never fails: a missing/unreadable file just yields an
 * empty object, which `censusManifestFields` reports as fully not-recoverable.
 */
export const recoverManifestCensus = (runRoot: string): Effect.Effect<ManifestCensusResult> =>
  Effect.gen(function* () {
    const manifest = yield* readJsonRecord(path.join(runRoot, 'manifest.json'))
    const baseline = yield* readJsonRecord(path.join(runRoot, 'config', 'baseline.json'))
    const newConfig = yield* readJsonRecord(path.join(runRoot, 'config', 'new.json'))
    const modelFoundInConfig = has(baseline, 'model') || has(newConfig, 'model')
    return { manifest, modelFoundInConfig, fields: censusManifestFields(manifest, modelFoundInConfig) }
  })
