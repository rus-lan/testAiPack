/**
 * Phase 09: judge (optional)
 *
 * If `--judge` is set, run an LLM judge over every variant's diffs and
 * return a `JudgeResult` (verdict ok/fail/unclear, per-variant quality
 * scores, ranking, explanation). Without `--judge` the phase is a no-op
 * returning `{ judge: null }`. No judge failure aborts the phase:
 * model-unavailable, timeout, crash and rate-limit all degrade to
 * `verdict: "unclear"` with `ran: false` — `JudgeResult.ran` distinguishes
 * "judge could not run" from "judge ran and was unsure".
 *
 * For N variants everything goes in one call (baseline first, packs
 * disclosed per variant) as long as the assembled prompt fits
 * `JUDGE_SINGLE_CALL_BUDGET_CHARS`; over budget it falls back to one
 * pairwise-vs-baseline call per non-baseline variant and assembles the
 * combined result (baseline quality = median of its per-pair scores).
 * See `.research/n-way-variants/03-hard-problems.md` §2.
 *
 * @see docs/phases/09-judge.ru.md
 * @see contract/phases/09-judge.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import os from 'node:os'
import type {
  DiffResult,
  JudgeInput,
  JudgeResult,
  JudgeResultOutput,
  JudgeVerdict,
  Manifest,
  RunInput,
  VariantScore,
} from '@generated/types'
import { run as opencodeRun } from '../opencode/cli.js'
import type { OpencodeRunOptions } from '../opencode/cli.js'
import { ensureDir, removeDir, writeFile, writeJson } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import { median } from '../metrics/stats.js'
import type { PhaseError } from '../errors.js'

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

const runSummaryLine = (r: DiffResult['runs'][number]): string => {
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

/** One variant's material for the judge prompt — built once per call from `JudgeInput` + `RunInput`. */
export interface JudgeVariantDiff {
  readonly name: string
  readonly packs: readonly string[]
  readonly isBaseline: boolean
  /** This variant's effective task prompt (own `prompt` override, else the global). */
  readonly taskPrompt: string
  /** `null` when every run of this variant produced no changes — the variant still gets a block, just no patch to show. */
  readonly patch: string | null
  readonly summary: string
}

const packsListLabel = (packs: readonly string[]): string =>
  packs.length === 0 ? 'no packs' : `packs: ${packs.join(', ')}`

const packsTagLabel = (packs: readonly string[]): string =>
  packs.length === 0 ? 'packs: none' : `packs: ${packs.join(', ')}`

const variantOpenTag = (v: JudgeVariantDiff): string =>
  v.isBaseline
    ? `<variant "${v.name}" (BASELINE, ${packsTagLabel(v.packs)})>`
    : `<variant "${v.name}" (${packsTagLabel(v.packs)})>`

const variantCloseTag = (v: JudgeVariantDiff): string => `</variant "${v.name}">`

/**
 * The response format is a single exported constant so a post-ship prompt
 * tweak (e.g. asking for more/less structure) is a one-line change instead
 * of a hunt through `buildJudgePrompt`.
 */
export const JUDGE_RESPONSE_FORMAT =
  'Respond as JSON: { "verdict": "ok" | "fail" | "unclear", "scores": { "<variant name>": 0-10, ... one entry per variant ... }, "ranking": ["best variant name", ..., "worst"], "explanation": "..." }'

/**
 * Phase 09 runs before phase 11 (report-render) even exists, and always in an
 * empty scratch dir — so `report.md` can never be on disk for it to read, no
 * matter what the user's `--judge` instruction asks for. Rather than silently
 * feeding the model nothing (or letting it invent report contents), every
 * prompt states plainly what material it does and does not have, and a
 * `--judge` instruction that names a report file gets an explicit, louder
 * call-out — see `judgeInstructionMentionsReportFile`.
 *
 * Used for both the single N-way call and each pairwise-vs-baseline fallback
 * call — `variants` is whatever subset (all N, or exactly baseline+one) the
 * caller is assembling a prompt for, baseline always first.
 */
export const buildJudgePrompt = (
  runInput: RunInput,
  variants: readonly JudgeVariantDiff[],
): string => {
  const baseline = variants.find((v) => v.isBaseline)
  const packsLine = variants.map((v) => `${v.name} (${packsListLabel(v.packs)})`).join('; ')
  const promptsDiffer = new Set(variants.map((v) => v.taskPrompt)).size > 1
  const judgeInstruction = runInput.judge ?? ''
  const mentionsReportFile = judgeInstructionMentionsReportFile(judgeInstruction)

  const variantBlocks = variants.flatMap((v) => [
    variantOpenTag(v),
    ...(promptsDiffer ? [`task prompt: ${v.taskPrompt}`] : []),
    'per-run summary:',
    v.summary,
    'representative patch:',
    ...(v.patch === null ? ['(no changes on any run)'] : ['```diff', truncatePatch(v.patch), '```']),
    variantCloseTag(v),
    '',
  ])

  return [
    '<system context>',
    `You are judging an N-way experiment comparing ${String(variants.length)} configurations ("variants") of an opencode agent on the same task.`,
    `Variant "${baseline?.name ?? ''}" is the BASELINE. Variants and their packs: ${packsLine}.`,
    'You have NO file-system access: no report.md/json/html, no repository worktree, no results directory. Your only inputs are exactly what appears below — the task prompt, a per-run diff summary for each variant, one representative patch per variant, and the instruction that follows. If an instruction asks you to read or analyse a file, you cannot: say so plainly in your explanation instead of guessing what it might contain.',
    promptsDiffer
      ? 'Task prompts differ across variants — see each variant\'s "task prompt:" line below.'
      : `Task prompt was: ${variants[0]?.taskPrompt ?? ''}`,
    '</system context>',
    '',
    ...variantBlocks,
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
    JUDGE_RESPONSE_FORMAT,
    '</judge instruction>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Pure: response parsing
// ---------------------------------------------------------------------------

export interface ParsedJudge {
  readonly verdict: JudgeVerdict
  /** Keyed by canonical variant name (case-corrected against `variantNames`), one entry per name. */
  readonly scores: Record<string, number>
  /** A full permutation of `variantNames` — model-provided if valid, else derived from `scores` (tie → config order). */
  readonly ranking: readonly string[]
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

/**
 * Case-insensitive key lookup — a small local model is not consistent about
 * `verdict` vs `Verdict` vs `VERDICT`. `Object.hasOwn` (not `key in obj`):
 * `in` walks the prototype chain, so a variant legitimately named
 * `constructor` (a valid name under `VARIANT_NAME_RE`) would otherwise read
 * `Object.prototype.constructor` instead of reporting the key as absent.
 */
const getField = (obj: Record<string, unknown>, key: string): unknown => {
  if (Object.hasOwn(obj, key)) return obj[key]
  const lower = key.toLowerCase()
  const found = Object.keys(obj).find((k) => k.toLowerCase() === lower)
  return found === undefined ? undefined : obj[found]
}

/** `variantNames` is exactly `{'old', 'new'}` — the shim's legacy pair, the only case the old `oldQuality`/`newQuality` keys are accepted for. */
const isShimVariantSet = (variantNames: readonly string[]): boolean => {
  const set = new Set(variantNames)
  return set.size === 2 && set.has('old') && set.has('new')
}

/**
 * `scores` as a record keyed by variant name (case-insensitive) is what a
 * model reliably produces — decision 12's array-over-record rule governs the
 * wire CONTRACT, not model output. Every declared variant name must be
 * present with a finite number, or the whole response is treated as
 * unparseable (falls into 'Failed to parse judge response' containment) —
 * except the legacy `oldQuality`/`newQuality` pair a model still latched onto
 * the old shim format might produce.
 */
const extractScores = (
  obj: Record<string, unknown>,
  variantNames: readonly string[],
): Record<string, number> | null => {
  const scoresField = getField(obj, 'scores')
  if (isRecord(scoresField)) {
    const scored = variantNames
      .map((name) => {
        const raw = getField(scoresField, name)
        return isFiniteNumber(raw) ? ([name, clampQuality(raw)] as const) : null
      })
      .filter((entry): entry is readonly [string, number] => entry !== null)
    return scored.length === variantNames.length ? Object.fromEntries(scored) : null
  }
  if (isShimVariantSet(variantNames)) {
    const oldQuality = getField(obj, 'oldQuality')
    const newQuality = getField(obj, 'newQuality')
    if (isFiniteNumber(oldQuality) && isFiniteNumber(newQuality)) {
      return { old: clampQuality(oldQuality), new: clampQuality(newQuality) }
    }
  }
  return null
}

const asStringArray = (u: unknown): readonly string[] | null =>
  Array.isArray(u) && u.every((x): x is string => typeof x === 'string') ? u : null

/** A valid `ranking` is a permutation of `variantNames` (case-insensitive) — mapped back to canonical casing. */
const canonicalRanking = (raw: readonly string[], variantNames: readonly string[]): readonly string[] | null => {
  const byLower = new Map(variantNames.map((n) => [n.toLowerCase(), n]))
  const mapped = raw
    .map((entry) => byLower.get(entry.toLowerCase()) ?? null)
    .filter((canon): canon is string => canon !== null)
  const noDuplicates = new Set(mapped).size === mapped.length
  return mapped.length === raw.length && noDuplicates && mapped.length === variantNames.length ? mapped : null
}

/** `variantNames` is already in config order, so a stable sort ties → config order for free. */
const deriveRanking = (variantNames: readonly string[], scores: Record<string, number>): readonly string[] =>
  [...variantNames].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0))

export const parseJudgeResponse = (raw: string, variantNames: readonly string[]): ParsedJudge | null => {
  const extracted = extractJsonObject(raw)
  if (extracted === null) return null
  const obj = safeJsonParse(extracted)
  if (!isRecord(obj)) return null
  const verdict = getField(obj, 'verdict')
  if (!isVerdict(verdict)) return null
  const scores = extractScores(obj, variantNames)
  if (scores === null) return null
  const explanation = getField(obj, 'explanation')
  if (typeof explanation !== 'string') return null
  const rankingRaw = asStringArray(getField(obj, 'ranking'))
  const ranking = rankingRaw === null ? null : canonicalRanking(rankingRaw, variantNames)
  return {
    verdict,
    scores,
    ranking: ranking ?? deriveRanking(variantNames, scores),
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

const zeroScores = (variantNames: readonly string[]) =>
  variantNames.map((variant): VariantScore => ({ variant, quality: 0 }))

const allEmptyResult = (variantNames: readonly string[]): JudgeResult => ({
  verdict: 'unclear',
  scores: zeroScores(variantNames),
  ranking: [...variantNames],
  explanation: 'all variants produced no changes',
  modelUsed: '',
  timestamp: nowIso(),
  ran: false,
})

const unclearFromFailure = (
  variantNames: readonly string[],
  explanation: string,
  rawResponse: string,
  modelUsed: string,
  ran: boolean,
): JudgeResult => ({
  verdict: 'unclear',
  scores: zeroScores(variantNames),
  ranking: [...variantNames],
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
// One opencode call, attempted and classified — shared by the single N-way
// call and each pairwise-vs-baseline fallback call.
// ---------------------------------------------------------------------------

interface JudgeCallAttempt {
  /** Non-null only when the call ran AND its response parsed. */
  readonly parsed: ParsedJudge | null
  /** `parsed.explanation` on success; a failure/parse-failure message otherwise. */
  readonly explanation: string
  readonly raw: string
  /** Full transcript for `judge.log`; null only when opencode was never invoked (scratch dir blocked). */
  readonly log: string | null
  /**
   * Whether the opencode call itself executed and returned a response — true
   * even when that response was unparseable prose, false only when the call
   * never completed at all (scratch dir blocked, crash, timeout,
   * model-unavailable). Distinct from `parsed !== null`: the single-call path
   * reports `ran: true` for an unparseable-but-executed call (matching the
   * pre-N-way behavior), while the pairwise fallback's own "did this pair
   * contribute a usable score" bar is `parsed !== null`, checked separately.
   *
   * This is a deliberate asymmetry, not a bug: the same event — opencode ran,
   * response came back, parsing failed — yields `ran: true` on the
   * single-call path but contributes to `ran: false` on the pairwise path if
   * EVERY pair fails to parse (`runPairwiseFallback`'s `anySucceeded` keys on
   * `parsed`, not on this field). The single-call `ran` answers "did the
   * model respond at all"; the pairwise result's `ran` answers "did at least
   * one pair produce a usable score" — a stricter bar, because the pairwise
   * result is itself a synthesized aggregate (median baseline, derived
   * ranking) that needs at least one real number to synthesize from.
   */
  readonly ran: boolean
}

/**
 * `homeDir` must stay the real HOME: opencode keeps the provider credentials
 * there that the judge needs to call the model. `cwd` is a disposable scratch
 * dir instead, since the prompt embeds diff content from the run under
 * judgment — acquire/release so it is always cleaned up (including on
 * interruption), and never falls back to a shared tmp dir if it can't be
 * created. `callId` disambiguates the scratch path across the several calls
 * a pairwise fallback makes for one run (`single`, `pair-<variant>`).
 */
const attemptJudgeCall = (
  runInput: RunInput,
  manifest: Manifest,
  prompt: string,
  variantNames: readonly string[],
  callId: string,
): Effect.Effect<JudgeCallAttempt> =>
  Effect.gen(function* () {
    const model = runInput.preflightModel
    const homeDir = process.env['HOME'] ?? '/tmp'
    const scratchDir = path.join(os.tmpdir(), 'testaipack-judge', manifest.runId, callId)

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
        parsed: null,
        explanation: 'could not create scratch directory for judge',
        raw: '',
        log: null,
        ran: false,
      }
    }
    const outcome = acquireOutcome.right

    if (outcome._tag === 'Left') {
      const err = outcome.left
      const log = buildJudgeLog(model ?? '', err)
      if (isModelUnavailable(err.stderr)) {
        return {
          parsed: null,
          explanation: `judge model unavailable${model === undefined ? '' : ` (${model})`}: ${err.stderr.slice(0, STDERR_TAIL_CHARS)}`,
          raw: '',
          log,
          ran: false,
        }
      }
      const explanation = err.timedOut
        ? `judge timeout after ${String(runInput.timeouts.runSeconds)}s: ${err.stderr.slice(0, STDERR_TAIL_CHARS)}`
        : `judge crashed (exit ${err.exitCode === null ? 'unknown' : String(err.exitCode)}): ${err.stderr.slice(0, STDERR_TAIL_CHARS)}`
      return { parsed: null, explanation, raw: '', log, ran: false }
    }

    const log = buildJudgeLog(model ?? '', outcome.right)
    const raw = extractAssistantText(outcome.right.stdout)
    const parsed = parseJudgeResponse(raw, variantNames)
    if (parsed === null) {
      return { parsed: null, explanation: 'Failed to parse judge response', raw, log, ran: true }
    }
    return { parsed, explanation: parsed.explanation, raw, log, ran: true }
  })

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/** `computeJudge`'s result plus the full opencode transcript(s) for `results/judge.log` (null when opencode was never invoked). */
interface JudgeCompute {
  readonly result: JudgeResult | null
  readonly log: string | null
}

/**
 * One call per non-baseline variant, each a 2-variant prompt (baseline + V)
 * built with the exact same `buildJudgePrompt` used for the single-call
 * path — every pair prompt is therefore ≤ the old 2-sided worst case by
 * construction, which is what keeps the fallback itself under budget.
 * Assembly per `03-hard-problems.md` §2.3: baseline quality = median of its
 * per-pair scores; a single pair-call failure degrades only that variant's
 * score (quality 0 + a note), not the whole result — `ran` stays true as
 * long as at least one pair produced usable scores.
 */
const runPairwiseFallback = (
  runInput: RunInput,
  manifest: Manifest,
  configOrder: readonly string[],
  baseline: string,
  variantDiffsByName: ReadonlyMap<string, JudgeVariantDiff>,
): Effect.Effect<JudgeCompute> =>
  Effect.gen(function* () {
    const nonBaseline = configOrder.filter((n) => n !== baseline)
    const pairResults = yield* Effect.forEach(
      nonBaseline,
      (v) => {
        // `pairNames` (config order) is only for `attemptJudgeCall`'s parse/
        // tie-break order — the PROMPT itself must put the baseline first
        // (§2.2/§2.3), same as the single-call path's `promptOrder` below;
        // config order would silently put a baseline declared later in
        // `variants` second, inverting the position cue for exactly the
        // pairs where the baseline isn't already first in config order.
        const pairNames = configOrder.filter((n) => n === baseline || n === v)
        const promptDiffs = [baseline, v].map((n) => variantDiffsByName.get(n)).filter((d): d is JudgeVariantDiff => d !== undefined)
        const prompt = buildJudgePrompt(runInput, promptDiffs)
        return attemptJudgeCall(runInput, manifest, prompt, pairNames, `pair-${v}`).pipe(
          Effect.map((attempt) => ({ variant: v, attempt })),
        )
      },
      { concurrency: 1 },
    )

    const model = runInput.preflightModel ?? ''

    // One outcome record per pair, derived without mutation — everything
    // below (logs, scores, explanation, verdict) is folded from this array
    // rather than accumulated in a loop.
    const outcomes = pairResults.map(({ variant, attempt }) =>
      attempt.parsed === null
        ? {
            variant,
            succeeded: false as const,
            verdict: null,
            quality: 0,
            baselineQuality: null,
            explanationPart: `vs ${variant}: ${attempt.explanation}`,
            rawPart: null,
            log: attempt.log,
          }
        : {
            variant,
            succeeded: true as const,
            verdict: attempt.parsed.verdict,
            quality: attempt.parsed.scores[variant] ?? 0,
            baselineQuality: attempt.parsed.scores[baseline] ?? 0,
            explanationPart: `vs ${variant}: ${attempt.parsed.explanation}`,
            rawPart: attempt.raw === '' ? null : `vs ${variant}: ${attempt.raw}`,
            log: attempt.log,
          },
    )

    const logs = outcomes.map((o) => o.log).filter((l): l is string => l !== null)
    const combinedLog = logs.length === 0 ? null : logs.join('\n')
    const explanationParts = outcomes.map((o) => o.explanationPart)
    const rawParts = outcomes.map((o) => o.rawPart).filter((r): r is string => r !== null)
    const anySucceeded = outcomes.some((o) => o.succeeded)

    if (!anySucceeded) {
      // Still `pairwiseFallback: true`: the run genuinely took the fallback
      // path (N-1 opencode calls, N-1 transcripts in judge.log below) even
      // though none of them produced a usable score — the artifact should
      // say so, not look like an ordinary single-call containment.
      return {
        result: {
          ...unclearFromFailure(configOrder, explanationParts.join(' '), rawParts.join('\n---\n'), model, false),
          pairwiseFallback: true,
        },
        log: combinedLog,
      }
    }

    const baselineScores = outcomes.map((o) => o.baselineQuality).filter((q): q is number => q !== null)
    const scoresRecord = {
      ...Object.fromEntries(outcomes.map((o) => [o.variant, o.quality])),
      [baseline]: clampQuality(median(baselineScores)),
    }
    const scores = configOrder.map((name) => ({ variant: name, quality: scoresRecord[name] ?? 0 }))
    const ranking = [...deriveRanking(configOrder, scoresRecord)]

    const anyOk = outcomes.some((o) => o.verdict === 'ok')
    const allFail = outcomes.every((o) => o.verdict === 'fail')
    const verdict: JudgeVerdict = anyOk ? 'ok' : allFail ? 'fail' : 'unclear'

    return {
      result: {
        verdict,
        scores,
        ranking,
        explanation: `baseline score = median of ${String(baselineScores.length)} pairwise scores. ${explanationParts.join(' ')}`.trim(),
        ...(rawParts.length === 0 ? {} : { rawResponse: rawParts.join('\n---\n') }),
        modelUsed: model,
        timestamp: nowIso(),
        ran: true,
        pairwiseFallback: true,
      },
      log: combinedLog,
    }
  })

/** Budget for the fully assembled single-call prompt (chars, measured after per-patch truncation). Above this, pairwise-vs-baseline fallback. */
export const JUDGE_SINGLE_CALL_BUDGET_CHARS = 260_000

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
    const { runInput, manifest, diffs } = input

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

    const configOrder = runInput.variants.map((v) => v.name)
    const baseline = runInput.baseline
    const diffsByName = new Map(diffs.map((d) => [d.variant, d] as const))

    const variantDiffsByName = new Map<string, JudgeVariantDiff>(
      runInput.variants.map((v) => {
        const d = diffsByName.get(v.name)
        const rep = d === undefined ? null : firstNonEmptyPatch(d)
        return [
          v.name,
          {
            name: v.name,
            packs: v.packs,
            isBaseline: v.name === baseline,
            taskPrompt: v.prompt ?? runInput.prompt ?? '',
            patch: rep === null ? null : rep.patch,
            summary: d === undefined ? '(no runs)' : summarizeDiffRuns(d),
          },
        ] as const
      }),
    )

    const allEmpty = [...variantDiffsByName.values()].every((vd) => vd.patch === null)
    if (allEmpty) {
      return { result: allEmptyResult(configOrder), log: null }
    }

    const promptOrder = [baseline, ...configOrder.filter((n) => n !== baseline)]
    const orderedDiffs = promptOrder.map((n) => variantDiffsByName.get(n)).filter((d): d is JudgeVariantDiff => d !== undefined)
    const fullPrompt = buildJudgePrompt(runInput, orderedDiffs)

    if (fullPrompt.length <= JUDGE_SINGLE_CALL_BUDGET_CHARS) {
      const attempt = yield* attemptJudgeCall(runInput, manifest, fullPrompt, configOrder, 'single')
      const model = runInput.preflightModel ?? ''
      if (attempt.parsed === null) {
        return { result: unclearFromFailure(configOrder, attempt.explanation, attempt.raw, model, attempt.ran), log: attempt.log }
      }
      const parsed = attempt.parsed
      return {
        result: {
          verdict: parsed.verdict,
          scores: configOrder.map((name): VariantScore => ({ variant: name, quality: parsed.scores[name] ?? 0 })),
          ranking: [...parsed.ranking],
          explanation: parsed.explanation,
          ...(attempt.raw === '' ? {} : { rawResponse: attempt.raw }),
          modelUsed: model,
          timestamp: nowIso(),
          ran: true,
        },
        log: attempt.log,
      }
    }

    return yield* runPairwiseFallback(runInput, manifest, configOrder, baseline, variantDiffsByName)
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
 * Writes `results/judge.log` with the full opencode stdout/stderr for every
 * call the judge made (one for the single-call path, several concatenated
 * for the pairwise fallback), so a crash/timeout/parse-failure is
 * diagnosable after the fact without re-running the judge
 * (`JudgeResult.explanation` only carries a short stderr tail). Best-effort,
 * same as `writeJudgeJson`.
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
