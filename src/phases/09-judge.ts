/**
 * Phase 09: judge (optional)
 *
 * If `--judge` is set, run an LLM judge over the old/new diffs and return a
 * `JudgeResult` (verdict ok/fail/unclear, quality scores, explanation). Without
 * `--judge` the phase is a no-op returning `{ judge: null }`. No judge failure
 * aborts the phase: model-unavailable, timeout, crash and rate-limit all
 * degrade to `verdict: "unclear"` with `ran: false` — `JudgeResult.ran`
 * distinguishes "judge could not run" from "judge ran and was unsure".
 *
 * @see docs/phases/09-judge.ru.md
 * @see contract/phases/09-judge.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import os from 'node:os'
import type {
  DiffResult,
  DiffRunResult,
  JudgeInput,
  JudgeResult,
  JudgeResultOutput,
  JudgeVerdict,
  RunInput,
} from '@generated/types'
import { run as opencodeRun } from '../opencode/cli.js'
import type { OpencodeRunOptions } from '../opencode/cli.js'
import { ensureDir, removeDir, writeFile, writeJson } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import type { PhaseError } from '../errors.js'
import { safeRefDisplay } from '../pack/detector.js'
import { redactUrlCredentials } from '../util/redact.js'

const VERDICTS: readonly JudgeVerdict[] = ['ok', 'fail', 'unclear']

const MODEL_UNAVAILABLE_PATTERNS: readonly string[] = [
  'e_model_unavailable',
  'unauthorized',
  'not authenticated',
  'authentication',
  'invalid api key',
  'invalid_api_key',
  'api key invalid',
  'apikey',
  '401',
  'model not found',
  'model_not_found',
  'no such model',
  'model is not available',
  'model unavailable',
]

const isModelUnavailable = (stderr: string): boolean => {
  const lower = stderr.toLowerCase()
  return MODEL_UNAVAILABLE_PATTERNS.some((p) => lower.includes(p))
}

// ---------------------------------------------------------------------------
// Pure: patch selection
// ---------------------------------------------------------------------------

/** Prefer run-1's patch; if empty, the first non-empty run; null if all empty. */
const firstNonEmptyPatch = (
  diff: DiffResult,
): { readonly patch: string; readonly runIndex: number } | null => {
  const sorted = [...diff.runs].sort((a, b) => a.runIndex - b.runIndex)
  const r1 = sorted.find((r) => r.runIndex === 1)
  if (r1 !== undefined && r1.fullPatch.trim() !== '') {
    return { patch: r1.fullPatch, runIndex: 1 }
  }
  const nonEmpty = sorted.find((r) => r.fullPatch.trim() !== '')
  return nonEmpty === undefined ? null : { patch: nonEmpty.fullPatch, runIndex: nonEmpty.runIndex }
}

// ---------------------------------------------------------------------------
// Pure: report-shaped summary (the judge only ever sees run-1's raw patch —
// this gives it the multi-run shape report.md would show, from data already
// on JudgeInput, without needing report.md itself)
// ---------------------------------------------------------------------------

/** A run with more changed files than this lists only the count, not every path. */
const PER_FILE_LIST_MAX = 20

const runSummaryLine = (r: DiffRunResult): string => {
  if (r.state === 'failed') {
    return `run-${String(r.runIndex)}: failed${r.error === undefined ? '' : ` (${r.error.message})`}`
  }
  if (r.noChanges) {
    return `run-${String(r.runIndex)}: no changes`
  }
  const stateSuffix = r.state === 'git-restored' || r.state === 'git-replaced' ? ` [${r.state}]` : ''
  const counts = `${String(r.summary.filesChanged)} file(s), +${String(r.summary.additions)}/-${String(r.summary.deletions)}`
  const files =
    r.summary.perFile.length > 0 && r.summary.perFile.length <= PER_FILE_LIST_MAX
      ? ` — ${r.summary.perFile.map((f) => `${f.path} (+${String(f.additions)}/-${String(f.deletions)})`).join(', ')}`
      : ''
  return `run-${String(r.runIndex)}: ${counts}${stateSuffix}${files}`
}

/** One line per run, sorted by runIndex, covering every run — not just the one whose patch is embedded. */
export const summarizeDiffRuns = (diff: DiffResult): string =>
  [...diff.runs]
    .sort((a, b) => a.runIndex - b.runIndex)
    .map(runSummaryLine)
    .join('\n')

// ---------------------------------------------------------------------------
// Pure: prompt builder
// ---------------------------------------------------------------------------

/** Patches above this size are truncated before being sent to the judge model. */
const MAX_PATCH_CHARS = 100_000
const TRUNCATED_PATCH_CHARS = 50_000

const truncatePatch = (patch: string): string => {
  if (patch.length <= MAX_PATCH_CHARS) return patch
  return `[truncated from ${String(patch.length)} chars]\n${patch.slice(0, TRUNCATED_PATCH_CHARS)}`
}

/**
 * Matches the literal artifact names this project actually writes
 * (report.md/json/html/yaml). Deliberately narrow — a fixed, known
 * vocabulary rather than a guess at every way a user might phrase "look at
 * the results", so it stays a high-confidence signal, not a noisy one.
 */
const REPORT_FILE_RE = /\breport\.(?:md|json|html|yaml)\b/i

/** True when a `--judge` instruction references a report artifact the judge cannot read (see below). */
export const judgeInstructionMentionsReportFile = (judgeText: string): boolean =>
  REPORT_FILE_RE.test(judgeText)

export interface JudgeSideDiff {
  readonly patch: string
  readonly summary: string
}

/**
 * Phase 09 runs before phase 11 (report-render) even exists, and always in an
 * empty scratch dir — so `report.md` can never be on disk for it to read, no
 * matter what the user's `--judge` instruction asks for. Rather than silently
 * feeding the model nothing (or letting it invent report contents), every
 * prompt states plainly what material it does and does not have, and a
 * `--judge` instruction that names a report file gets an explicit, louder
 * call-out — see `judgeInstructionMentionsReportFile`.
 */
export const buildJudgePrompt = (
  runInput: RunInput,
  old: JudgeSideDiff,
  nw: JudgeSideDiff,
): string => {
  // packRef reaches the judge model verbatim below — an inline mcp: ref can
  // carry a provider secret in its config payload, so it goes through the
  // same redaction as the on-disk manifest before it is embedded.
  const packRef =
    runInput.packRef === undefined ? 'n/a' : safeRefDisplay(redactUrlCredentials(runInput.packRef))
  const oldTrunc = truncatePatch(old.patch)
  const newTrunc = truncatePatch(nw.patch)
  const judgeInstruction = runInput.judge ?? ''
  const mentionsReportFile = judgeInstructionMentionsReportFile(judgeInstruction)
  return [
    '<system context>',
    'You are judging an A/B test of an opencode integration.',
    'You have NO file-system access: no report.md/json/html, no repository worktree, no results directory. Your only inputs are exactly what appears below — the task prompt, a per-run diff summary for each side, one representative patch per side, and the instruction that follows. If an instruction asks you to read or analyse a file, you cannot: say so plainly in your explanation instead of guessing what it might contain.',
    `Task prompt was: ${runInput.prompt}`,
    '</system context>',
    '',
    '<old side diff (baseline, no pack)>',
    'per-run summary:',
    old.summary,
    'representative patch:',
    '```diff',
    oldTrunc,
    '```',
    '</old side>',
    '',
    `<new side diff (with pack: ${packRef})>`,
    'per-run summary:',
    nw.summary,
    'representative patch:',
    '```diff',
    newTrunc,
    '```',
    '</new side>',
    '',
    ...(mentionsReportFile
      ? [
          '<note>',
          'The instruction below mentions a report file (report.md/json/html). This judge has no access to it — base your verdict only on the material above, and state in your explanation that the referenced report file was not available to you.',
          '</note>',
          '',
        ]
      : []),
    '<judge instruction>',
    judgeInstruction,
    '',
    'Respond as JSON: { "verdict": "ok" | "fail" | "unclear", "oldQuality": 0-10, "newQuality": 0-10, "explanation": "..." }',
    '</judge instruction>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Pure: response parsing
// ---------------------------------------------------------------------------

export interface ParsedJudge {
  readonly verdict: JudgeVerdict
  readonly oldQuality: number
  readonly newQuality: number
  readonly explanation: string
}

const isVerdict = (v: unknown): v is JudgeVerdict =>
  typeof v === 'string' && VERDICTS.includes(v as JudgeVerdict)

const isFiniteNumber = (u: unknown): u is number => typeof u === 'number' && Number.isFinite(u)

const clampQuality = (n: number): number => Math.round(Math.max(0, Math.min(10, n)))

const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return null
  }
}

/**
 * Scans forward from the first `{`, tracking JSON string/escape state and
 * brace depth, to the matching close brace. A small local model routinely
 * pads its JSON with a leading "Here is my verdict:" or a trailing "Hope
 * that helps!" (sometimes itself containing a stray `{`/`}`) — stopping at
 * the depth-0 close, rather than at the raw string's last `}`, is what keeps
 * that padding from being swept into the parse and breaking it. String
 * content is tracked so a brace mentioned inside `explanation` (e.g.
 * describing a code snippet) is not mistaken for structure.
 */
interface BraceScanState {
  readonly depth: number
  readonly inString: boolean
  readonly escaped: boolean
  readonly end: number | null
}

const scanChar = (state: BraceScanState, ch: string, index: number): BraceScanState => {
  if (state.end !== null) return state
  if (state.inString) {
    if (state.escaped) return { ...state, escaped: false }
    if (ch === '\\') return { ...state, escaped: true }
    if (ch === '"') return { ...state, inString: false }
    return state
  }
  if (ch === '"') return { ...state, inString: true }
  if (ch === '{') return { ...state, depth: state.depth + 1 }
  if (ch === '}') {
    const depth = state.depth - 1
    return depth === 0 ? { ...state, depth, end: index } : { ...state, depth }
  }
  return state
}

const balancedJsonObject = (s: string): string | null => {
  const start = s.indexOf('{')
  if (start === -1) return null
  const initial: BraceScanState = { depth: 0, inString: false, escaped: false, end: null }
  // Indexed directly against `s` (not `Array.from(s)`), so a surrogate-pair
  // character (e.g. emoji in a chatty explanation) cannot desync this scan's
  // index from the `s.slice()` offsets it feeds back into below.
  const final = Array.from({ length: s.length - start }, (_, i) => start + i).reduce(
    (state, i) => scanChar(state, s[i] ?? '', i),
    initial,
  )
  return final.end === null ? null : s.slice(start, final.end + 1)
}

/** Extract the first JSON object from a raw string (direct, code-fence, or embedded — with or without prose around it). */
const extractJsonObject = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence !== null && fence[1] !== undefined) {
    const inFence = balancedJsonObject(fence[1])
    if (inFence !== null) return inFence
  }
  return balancedJsonObject(trimmed)
}

/** Case-insensitive key lookup — a small local model is not consistent about `verdict` vs `Verdict` vs `VERDICT`. */
const getField = (obj: Record<string, unknown>, key: string): unknown => {
  if (key in obj) return obj[key]
  const lower = key.toLowerCase()
  const found = Object.keys(obj).find((k) => k.toLowerCase() === lower)
  return found === undefined ? undefined : obj[found]
}

export const parseJudgeResponse = (raw: string): ParsedJudge | null => {
  const extracted = extractJsonObject(raw)
  if (extracted === null) return null
  const obj = safeJsonParse(extracted)
  if (!isRecord(obj)) return null
  const verdict = getField(obj, 'verdict')
  if (!isVerdict(verdict)) return null
  const oldQuality = getField(obj, 'oldQuality')
  const newQuality = getField(obj, 'newQuality')
  if (!isFiniteNumber(oldQuality) || !isFiniteNumber(newQuality)) return null
  // Quality out of [0, 10] is clamped rather than rejected (spec step 7).
  const explanation = getField(obj, 'explanation')
  if (typeof explanation !== 'string') return null
  return {
    verdict,
    oldQuality: clampQuality(oldQuality),
    newQuality: clampQuality(newQuality),
    explanation,
  }
}

// ---------------------------------------------------------------------------
// Pure: extract assistant text from opencode stdout (JSON event lines)
// ---------------------------------------------------------------------------

const textFromEvent = (ev: unknown): string => {
  if (!isRecord(ev)) return ''
  const part = ev['part']
  const partRecord = isRecord(part) ? part : undefined
  // Two shapes carry assistant text, same split `06-run-side.ts` already
  // handles for tool/finish events: an export-style part with the text
  // directly on the event (`{ type: "text", text }`), and the streamed run
  // event opencode actually emits per NDJSON line, where `text` sits one
  // level down (`{ type: "text", part: { type: "text", text } }`). Verified
  // against a real judge.log (qwen3.5-9b-32k) — the old flat-only check
  // matched the top-level `type` but then read `ev.text`, which does not
  // exist on the streamed shape, so it silently returned '' for a
  // substantive, well-formed verdict.
  if (ev['type'] === 'text' || partRecord?.['type'] === 'text') {
    const direct = ev['text']
    if (typeof direct === 'string') return direct
    const nested = partRecord?.['text']
    if (typeof nested === 'string') return nested
  }
  if (ev['type'] === 'message') {
    const info = ev['info']
    const role = isRecord(info) ? info['role'] : undefined
    if (role !== 'assistant') return ''
    const parts = ev['parts']
    if (!Array.isArray(parts)) return ''
    return parts
      .filter((p): p is Record<string, unknown> => isRecord(p))
      .filter((p): p is Record<string, unknown> & { readonly text: string } =>
        p['type'] === 'text' && typeof p['text'] === 'string',
      )
      .map((p) => p.text)
      .join('')
  }
  return ''
}

export const extractAssistantText = (stdout: string): string =>
  stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') || l.startsWith('['))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown]
      } catch {
        return []
      }
    })
    .map(textFromEvent)
    .join('')

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

const nowIso = (): string => new Date().toISOString()

const bothEmptyResult = (): JudgeResult => ({
  verdict: 'unclear',
  oldQuality: 0,
  newQuality: 0,
  explanation: 'Both sides produced no changes',
  modelUsed: '',
  timestamp: nowIso(),
  ran: false,
})

const unclearFromFailure = (
  explanation: string,
  rawResponse: string,
  modelUsed: string,
  ran: boolean,
): JudgeResult => ({
  verdict: 'unclear',
  oldQuality: 0,
  newQuality: 0,
  explanation,
  ...(rawResponse === '' ? {} : { rawResponse }),
  modelUsed,
  timestamp: nowIso(),
  ran,
})

/** How much of stderr rides along in a one-line explanation (the rest is in judge.log). */
const STDERR_TAIL_CHARS = 200

interface JudgeRunOutcome {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/**
 * Full stdout/stderr for whatever opencode call actually happened — written
 * to `results/judge.log` so a crash/timeout/parse-failure is diagnosable
 * after the fact without re-running the judge (the `explanation` field only
 * carries a short tail, not the whole output).
 */
const buildJudgeLog = (model: string, outcome: JudgeRunOutcome): string =>
  [
    '=== testaipack judge log ===',
    `model: ${model === '' ? '(default)' : model}`,
    `timestamp: ${nowIso()}`,
    `exitCode: ${outcome.exitCode === null ? 'unknown' : String(outcome.exitCode)}`,
    `timedOut: ${String(outcome.timedOut)}`,
    '',
    '--- stdout ---',
    outcome.stdout,
    '',
    '--- stderr ---',
    outcome.stderr,
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/** `computeJudge`'s result plus the full opencode transcript for `results/judge.log` (null when opencode was never invoked). */
interface JudgeCompute {
  readonly result: JudgeResult | null
  readonly log: string | null
}

/**
 * Computes the judge result (or null when the judge was not requested). Does
 * not touch disk beyond the one console warning below. Never fails:
 * model-unavailable, timeout, crash and 429 all return a `JudgeResult` with
 * verdict "unclear" and `ran: false`.
 */
const computeJudge = (
  input: JudgeInput,
): Effect.Effect<JudgeCompute> =>
  Effect.gen(function* () {
    const { runInput, diff } = input

    if (runInput.judge === undefined || runInput.judge === '') {
      return { result: null, log: null }
    }

    if (judgeInstructionMentionsReportFile(runInput.judge)) {
      yield* Effect.sync(() => {
        console.warn(
          'judge: --judge instruction references a report file (report.md/json/html), which this judge cannot see — phase 09 runs before the report is rendered, in an isolated scratch dir with no repository access. The model has been told this plainly in its prompt; consider rewriting the instruction to work from the diff/summary instead.',
        )
      })
    }

    const oldPatch = firstNonEmptyPatch(diff.old)
    const newPatch = firstNonEmptyPatch(diff.new)
    if (oldPatch === null && newPatch === null) {
      return { result: bothEmptyResult(), log: null }
    }

    const prompt = buildJudgePrompt(
      runInput,
      { patch: oldPatch?.patch ?? '', summary: summarizeDiffRuns(diff.old) },
      { patch: newPatch?.patch ?? '', summary: summarizeDiffRuns(diff.new) },
    )

    const model = runInput.preflightModel
    // homeDir must stay the real HOME: opencode keeps the provider
    // credentials there that the judge needs to call the model. cwd is a
    // disposable scratch dir instead, since the prompt embeds diff content
    // from the run under judgment — acquire/release so it is always cleaned
    // up (including on interruption), and never falls back to a shared tmp
    // dir if it can't be created.
    const homeDir = process.env['HOME'] ?? '/tmp'
    const scratchDir = path.join(os.tmpdir(), 'testaipack-judge', input.manifest.runId)

    const acquireOutcome = yield* Effect.acquireUseRelease(
      ensureDir(scratchDir),
      () =>
        opencodeRun({
          homeDir,
          cwd: scratchDir,
          agent: 'plan',
          prompt,
          auto: false,
          ...(model === undefined ? {} : { model }),
          timeoutMs: runInput.timeouts.runSeconds * 1000,
        } satisfies OpencodeRunOptions).pipe(Effect.either),
      () => removeDir(scratchDir).pipe(Effect.orElse(() => Effect.void)),
    ).pipe(Effect.either)

    if (acquireOutcome._tag === 'Left') {
      return {
        result: unclearFromFailure('could not create scratch directory for judge', '', model ?? '', false),
        log: null,
      }
    }
    const outcome = acquireOutcome.right

    if (outcome._tag === 'Left') {
      const err = outcome.left
      const log = buildJudgeLog(model ?? '', err)
      if (isModelUnavailable(err.stderr)) {
        return {
          result: unclearFromFailure(
            `judge model unavailable${model === undefined ? '' : ` (${model})`}: ${err.stderr.slice(0, STDERR_TAIL_CHARS)}`,
            '',
            model ?? '',
            false,
          ),
          log,
        }
      }
      const explanation = err.timedOut
        ? `judge timeout after ${String(runInput.timeouts.runSeconds)}s: ${err.stderr.slice(0, STDERR_TAIL_CHARS)}`
        : `judge crashed (exit ${err.exitCode === null ? 'unknown' : String(err.exitCode)}): ${err.stderr.slice(0, STDERR_TAIL_CHARS)}`
      return { result: unclearFromFailure(explanation, '', model ?? '', false), log }
    }

    const log = buildJudgeLog(model ?? '', outcome.right)
    const raw = extractAssistantText(outcome.right.stdout)
    const parsed = parseJudgeResponse(raw)
    if (parsed === null) {
      return { result: unclearFromFailure('Failed to parse judge response', raw, model ?? '', true), log }
    }

    return {
      result: {
        verdict: parsed.verdict,
        oldQuality: parsed.oldQuality,
        newQuality: parsed.newQuality,
        explanation: parsed.explanation,
        ...(raw === '' ? {} : { rawResponse: raw }),
        modelUsed: model ?? '',
        timestamp: nowIso(),
        ran: true,
      } satisfies JudgeResult,
      log,
    }
  })

/**
 * Writes `results/judge.json` with `{ judge: <result | null> }`. Best-effort:
 * a disk failure is logged but never fails the phase.
 */
const writeJudgeJson = (
  resultsDir: string,
  result: JudgeResult | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const judgeJsonPath = path.join(resultsDir, 'judge.json')
    yield* ensureDir(resultsDir).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.warn(
            `judge: cannot create results dir: ${e.operation} on ${e.path}: ${String(e.cause)}`,
          )
        }),
      ),
    )
    yield* writeJson(judgeJsonPath, { judge: result }).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.warn(
            `judge: cannot write judge.json: ${e.operation} on ${e.path}: ${String(e.cause)}`,
          )
        }),
      ),
    )
  })

/**
 * Writes `results/judge.log` with the full opencode stdout/stderr for the
 * judge call, so a crash/timeout/parse-failure is diagnosable after the fact
 * without re-running the judge (`JudgeResult.explanation` only carries a
 * short stderr tail). Best-effort, same as `writeJudgeJson`.
 */
const writeJudgeLog = (
  resultsDir: string,
  content: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const judgeLogPath = path.join(resultsDir, 'judge.log')
    yield* ensureDir(resultsDir).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.warn(
            `judge: cannot create results dir: ${e.operation} on ${e.path}: ${String(e.cause)}`,
          )
        }),
      ),
    )
    yield* writeFile(judgeLogPath, content).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          console.warn(
            `judge: cannot write judge.log: ${e.operation} on ${e.path}: ${String(e.cause)}`,
          )
        }),
      ),
    )
  })

export const judge = (
  input: JudgeInput,
): Effect.Effect<JudgeResultOutput, PhaseError> =>
  Effect.gen(function* () {
    const { result, log } = yield* computeJudge(input)
    const resultsDir = path.resolve(input.runInput.outputPath)
    yield* writeJudgeJson(resultsDir, result)
    if (log !== null) {
      yield* writeJudgeLog(resultsDir, log)
    }
    return { judge: result }
  })
