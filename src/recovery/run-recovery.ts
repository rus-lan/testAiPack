/**
 * Reconstructs what a finished (or crashed) run left behind on disk, for
 * workspaces where the pipeline died before persisting a structured result —
 * e.g. phase 08 aborting the whole run before 09/10/11/12 ever wrote
 * anything. `RunResult` itself is never serialized as JSON anywhere; the
 * only durable trace of a run's outcome is the free-text
 * `results/raw/<variant>/run-N.log` line `[STOP] finish=... rank=...
 * durationMs=...` written by phase 06 (`src/phases/06-run-side.ts`), plus
 * the export/events files next to it.
 *
 * Every field here is `undefined` unless a durable artifact directly says
 * so — nothing is inferred or guessed. `errorCode` cannot be recovered by
 * this module under any circumstance: it is never written to the `.log`
 * text, only carried in the in-memory `RunResult` (see
 * `notRecoverableFields`).
 *
 * Read-only: never writes to the workspace it inspects. No CLI or pipeline
 * wiring here on purpose — the rebuild command owns that.
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { ZodType } from 'zod'
import type { FinishCause, SuccessRank } from '@generated/types'
import { exists, readDir, readFile } from '../util/fs.js'
import { parseManifestCompat } from '../compat/legacy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields of the wire `RunResult` this module can never fill in. */
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
  readonly variant: string
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
  /**
   * True when the `.log` carries an `[INIT_DONE]` line — the durable proof an
   * `--init` invocation actually ran, even when the rest of the run's outcome
   * is lost (metric-split spec §5.8). `false`, never `undefined`: unlike the
   * other fields here, "no INIT_DONE line" is itself the recovered fact, not
   * a gap — an export with only 1 user message plus `initRan: false` is an
   * honest "no init"; `initRan: true` with no matching export boundary is the
   * spec's "lost session continuation" case (§2.4), surfaced as
   * `runsWithLostInit` by phase 07/aggregate.
   */
  readonly initRan: boolean
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

/**
 * `[TAG] key=val key=val ...` — the shape every 06-run-side.ts log line uses.
 * Key-name-agnostic on purpose: whatever keys a line carries land in
 * `fields` under their own names, so a `[START]` line's `side=`/`variant=`
 * key (only its name changed when the n-way variants rename landed —
 * `05-risks.md` §1.3) is captured either way. Neither is read downstream
 * today; captured for completeness and future callers.
 */
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
 * has no dependency on the contract or on a live pipeline run. `variant` is
 * a plain path-segment string (the variant's name — `'old'`/`'new'` for a
 * v1-mapped workspace, whatever the config declared for a v2 one).
 */
export const recoverRunResult = (
  rawDir: string,
  variant: string,
  runIndex: number,
  exportSchema: ZodType,
): Effect.Effect<RecoveredRunResult> =>
  Effect.gen(function* () {
    const variantDir = path.join(rawDir, variant)
    const logPath = path.join(variantDir, `run-${String(runIndex)}.log`)
    const exportPath = path.join(variantDir, `run-${String(runIndex)}.json`)
    const eventsLogPath = path.join(variantDir, `run-${String(runIndex)}.events.ndjson`)

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
      variant,
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
      initRan: parsed.initDone !== undefined,
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
 * Pure: given the (v2-shaped, compat-mapped when the source predates
 * `schemaVersion`) manifest object and whether `model` turned up in any
 * `config/*.json`, report each `RunInput` field's recoverability. Field
 * names are those the current v2 `Manifest` contract (`contract/main.tsp`)
 * actually declares — fields the contract has never carried are marked
 * not-recoverable regardless of what any single instance happens to
 * contain. `packs`/`variants`/`baseline`/`parallel` are recoverable
 * verbatim off the manifest even for a v1-sourced workspace, because
 * `parseManifestCompat` has already synthesized them via the legacy
 * mapping before this function ever sees the object.
 */
export const censusManifestFields = (
  manifest: Record<string, unknown>,
  modelFoundInConfig: boolean,
): readonly ManifestFieldStatus[] => [
  { field: 'repoUrl', recoverable: has(manifest, 'repoUrl'), source: 'manifest', note: 'копия с вырезанными учётными данными (redactUrlCredentials), побайтово не совпадает с исходным URL клона' },
  { field: 'packs', recoverable: has(manifest, 'packs'), source: 'manifest', note: 'провенанс-копия (ref вырезан); пусто для smoke-test прогонов. Для воркспейса до n-way (v1) это синтезируется из packRef/packType через слой совместимости с legacy, а не читается напрямую' },
  { field: 'variants', recoverable: has(manifest, 'variants'), source: 'manifest', note: 'провенанс-копия спецификации каждого варианта (name/packs/pure/init/exercise/...); для воркспейса с источником v1 это синтезируется (old/new, pureBaseline/allowBaselineTool невозможно восстановить только по манифесту) через слой совместимости с legacy' },
  { field: 'baseline', recoverable: has(manifest, 'baseline'), source: 'manifest', note: '' },
  { field: 'parallel', recoverable: has(manifest, 'parallel'), source: 'manifest', note: 'воркспейс с источником v1 никогда это не записывал — маппинг подставляет исторический дефолт (2)' },
  { field: 'prompt', recoverable: has(manifest, 'prompt'), source: 'manifest', note: 'дословный итоговый ГЛОБАЛЬНЫЙ текст по умолчанию; переопределения prompt по вариантам — в variants[*].prompt' },
  { field: 'promptFiles', recoverable: false, source: 'not-recoverable', note: 'путь к файлу утерян; сохраняется только итоговый текст prompt — не имеет значения для пересборки только отчёта, так как opencode повторно не запускается' },
  { field: 'init', recoverable: has(manifest, 'init'), source: 'manifest', note: 'дословный итоговый ГЛОБАЛЬНЫЙ текст по умолчанию; переопределения init по вариантам (включая весь --init-side сплит из источника v1) — в variants[*].init' },
  { field: 'initFiles', recoverable: false, source: 'not-recoverable', note: 'то же, что и promptFiles' },
  { field: 'hint', recoverable: has(manifest, 'hint'), source: 'manifest', note: 'отсутствует, если не использовался --hint/--pack-hint' },
  { field: 'verify', recoverable: has(manifest, 'verify'), source: 'manifest', note: 'отсутствует, если --verify не использовался' },
  { field: 'runs', recoverable: has(manifest, 'runs'), source: 'manifest', note: '' },
  { field: 'isolation', recoverable: has(manifest, 'isolation'), source: 'manifest', note: '' },
  { field: 'dockerNetwork', recoverable: false, source: 'not-recoverable', note: 'манифест никогда это не несёт; важно только для повторного запуска opencode, не для пересборки отчёта по существующим raw-экспортам' },
  { field: 'opencodeVersion', recoverable: has(manifest, 'opencodeVersion'), source: 'manifest', note: 'для воркспейсов с isolation=docker, записанных до фикса пробы в phase-01, это может быть версия HOST-бинарника, а не та, что реально использовали прогоны' },
  { field: 'auth', recoverable: false, source: 'not-recoverable', note: 'манифест никогда это не несёт; важно только для повторного запуска opencode' },
  { field: 'judge', recoverable: false, source: 'not-recoverable', note: 'манифест никогда это не несёт, и judge.json никогда не пишется, если оценка судьи по-настоящему не запрашивалась — пересборка не может знать, запрашивалась ли оценка судьи, и не может воспроизвести исходный вердикт, только запустить новый' },
  { field: 'judgeFiles', recoverable: false, source: 'not-recoverable', note: 'то же, что и judge' },
  { field: 'preflightEnabled', recoverable: false, source: 'not-recoverable', note: 'выводимо лишь косвенно из наличия/содержимого preflight.log, не структурированное поле' },
  { field: 'preflightModel', recoverable: false, source: 'not-recoverable', note: 'манифест никогда это не несёт' },
  { field: 'model', recoverable: modelFoundInConfig, source: modelFoundInConfig ? 'config' : 'not-recoverable', note: 'вообще отсутствует в manifest.json — восстановимо только из файла config/*.json, который phase 04 всегда писала для каждого варианта' },
  { field: 'formats', recoverable: false, source: 'not-recoverable', note: 'запрошенные формат(ы) отчёта; берётся дефолт (скорее всего md) — может не совпадать с тем, что изначально просил пользователь' },
  { field: 'outputPath', recoverable: false, source: 'not-recoverable', note: 'не записывается; выводимо лишь по отсутствию отдельного дерева --output рядом с results/, а это ненадёжный положительный признак' },
  { field: 'diffHtml', recoverable: false, source: 'not-recoverable', note: 'негде взять <variant>.html, если phase 08 упала до того, как хоть один записала — берётся дефолт, и пересобранный отчёт может ссылаться на файлы, которые не генерирует, или наоборот' },
  { field: 'collapseRepeats', recoverable: false, source: 'not-recoverable', note: 'опция влияет только на форматирование отчёта, ни один артефакт её не раскрывает' },
  { field: 'timelineMode', recoverable: false, source: 'not-recoverable', note: 'timeline.html не существует, чтобы из него вывести значение; берётся дефолт' },
  { field: 'timeouts', recoverable: false, source: 'not-recoverable', note: 'важно только для повторного запуска opencode, не для пересборки отчёта по существующим raw-экспортам' },
  { field: 'workspacePath', recoverable: true, source: 'external-argument', note: 'задаётся извне как путь, на который указывает команда rebuild, а не читается из файла' },
  { field: 'logLevel', recoverable: false, source: 'not-recoverable', note: 'влияет только на вывод прогресса вживую, не имеет значения для пересборки' },
  { field: 'pricingPath', recoverable: false, source: 'not-recoverable', note: 'не записывается — пересобранный отчёт откатывается на встроенную таблицу цен, которая может молча дать неверную цену для кастомной/локальной модели (например, модели ollama), для которой в исходном прогоне была запись --pricing-path' },
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

/**
 * Generic on purpose: v2 writes `config/<variantName>.json` per variant,
 * v1 wrote the fixed `config/baseline.json` + `config/new.json` — rather
 * than branch on the workspace's schema version and variant names, this
 * just probes every `.json` file directly under `config/` for a `model`
 * key. Correct for both naming schemes and any future one.
 */
const configDirHasModel = (runRoot: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const configDir = path.join(runRoot, 'config')
    const dirExists = yield* exists(configDir)
    if (!dirExists) return false
    const entries = yield* readDir(configDir).pipe(Effect.catchAll(() => Effect.succeed([])))
    const jsonFiles = entries.filter((e) => e.endsWith('.json'))
    const flags = yield* Effect.forEach(jsonFiles, (f) =>
      readJsonRecord(path.join(configDir, f)).pipe(Effect.map((obj) => has(obj, 'model'))),
    )
    return flags.some((f) => f)
  })

export interface ManifestCensusResult {
  readonly manifest: Record<string, unknown>
  readonly modelFoundInConfig: boolean
  readonly fields: readonly ManifestFieldStatus[]
  /** The workspace's true on-disk schema version (1 when manifest.json predates `schemaVersion`, or is missing/unreadable). */
  readonly schemaVersion: 1 | 2
}

/**
 * `runRoot` is one run directory (e.g. `<workspace>/<run-id>/`, the same
 * level `manifest.json` and `config/` live at). Reads `manifest.json`
 * (routed through `parseManifestCompat` so a v1-sourced manifest is
 * v1->v2-mapped before `censusManifestFields` ever sees it) plus every
 * `config/*.json` file (only for the `model` field — see the note on that
 * entry) and never fails: a missing/unreadable file just yields an empty
 * object, which `censusManifestFields` reports as fully not-recoverable.
 */
export const recoverManifestCensus = (runRoot: string): Effect.Effect<ManifestCensusResult> =>
  Effect.gen(function* () {
    const rawManifest = yield* readJsonRecord(path.join(runRoot, 'manifest.json'))
    const compat = parseManifestCompat(rawManifest)
    const manifest: Record<string, unknown> =
      compat === undefined ? rawManifest : compat.manifest
    const modelFoundInConfig = yield* configDirHasModel(runRoot)
    return {
      manifest,
      modelFoundInConfig,
      fields: censusManifestFields(manifest, modelFoundInConfig),
      schemaVersion: compat?.schemaVersion ?? 1,
    }
  })
