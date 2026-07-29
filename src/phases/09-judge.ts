/**
 * Phase 09: judge (optional)
 *
 * If `--judge` is set, run an LLM judge over the old/new diffs and return a
 * `JudgeResult` (verdict ok/fail/unclear, quality scores, explanation). Without
 * `--judge` the phase is a no-op returning `{ judge: null }`. Timeout / crash /
 * rate-limit of the judge model are non-fatal (verdict "unclear"); only a hard
 * model-unavailable failure (auth/model-not-found) fails the phase with
 * `E_MODEL_UNAVAILABLE`.
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
  RunInput,
} from '@generated/types'
import { run as opencodeRun } from '../opencode/cli.js'
import type { OpencodeRunOptions } from '../opencode/cli.js'
import { ensureDir, removeDir, writeJson } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import { judgeError } from '../errors.js'
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
// Pure: prompt builder
// ---------------------------------------------------------------------------

/** Patches above this size are truncated before being sent to the judge model. */
const MAX_PATCH_CHARS = 100_000
const TRUNCATED_PATCH_CHARS = 50_000

const truncatePatch = (patch: string): string => {
  if (patch.length <= MAX_PATCH_CHARS) return patch
  return `[truncated from ${String(patch.length)} chars]\n${patch.slice(0, TRUNCATED_PATCH_CHARS)}`
}

export const buildJudgePrompt = (
  runInput: RunInput,
  oldPatch: string,
  newPatch: string,
): string => {
  // packRef reaches the judge model verbatim below — an inline mcp: ref can
  // carry a provider secret in its config payload, so it goes through the
  // same redaction as the on-disk manifest before it is embedded.
  const packRef =
    runInput.packRef === undefined ? 'n/a' : safeRefDisplay(redactUrlCredentials(runInput.packRef))
  const oldTrunc = truncatePatch(oldPatch)
  const newTrunc = truncatePatch(newPatch)
  return [
    '<system context>',
    'You are judging an A/B test of an opencode integration.',
    `Task prompt was: ${runInput.prompt}`,
    '</system context>',
    '',
    '<old side diff (baseline, no pack)>',
    '```diff',
    oldTrunc,
    '```',
    '</old side>',
    '',
    `<new side diff (with pack: ${packRef})>`,
    '```diff',
    newTrunc,
    '```',
    '</new side>',
    '',
    '<judge instruction>',
    runInput.judge ?? '',
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

/** Extract the first JSON object from a raw string (direct, code-fence, or embedded). */
const extractJsonObject = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('{')) return trimmed
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fence !== null && fence[1] !== undefined) {
    const inner = fence[1].trim()
    if (inner.startsWith('{')) return inner
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1)
  return null
}

export const parseJudgeResponse = (raw: string): ParsedJudge | null => {
  const extracted = extractJsonObject(raw)
  if (extracted === null) return null
  const obj = safeJsonParse(extracted)
  if (!isRecord(obj)) return null
  const verdict = obj['verdict']
  if (!isVerdict(verdict)) return null
  const oldQuality = obj['oldQuality']
  const newQuality = obj['newQuality']
  if (!isFiniteNumber(oldQuality) || !isFiniteNumber(newQuality)) return null
  // Quality out of [0, 10] is clamped rather than rejected (spec step 7).
  const explanation = obj['explanation']
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
  if (ev['type'] === 'text' && typeof ev['text'] === 'string') return ev['text']
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
})

const unclearFromFailure = (explanation: string, rawResponse: string, modelUsed: string): JudgeResult => ({
  verdict: 'unclear',
  oldQuality: 0,
  newQuality: 0,
  explanation,
  ...(rawResponse === '' ? {} : { rawResponse }),
  modelUsed,
  timestamp: nowIso(),
})

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

/**
 * Computes the judge result (or null when the judge was not requested). Does
 * not touch disk. The only failure path is `E_MODEL_UNAVAILABLE` (hard model
 * unavailability); timeout/crash/429 return a `JudgeResult` with verdict
 * "unclear".
 */
const computeJudge = (
  input: JudgeInput,
): Effect.Effect<JudgeResult | null, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, diff } = input

    if (runInput.judge === undefined || runInput.judge === '') {
      return null
    }

    const oldPatch = firstNonEmptyPatch(diff.old)
    const newPatch = firstNonEmptyPatch(diff.new)
    if (oldPatch === null && newPatch === null) {
      return bothEmptyResult()
    }

    const prompt = buildJudgePrompt(
      runInput,
      oldPatch?.patch ?? '',
      newPatch?.patch ?? '',
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
      return unclearFromFailure('could not create scratch directory for judge', '', model ?? '')
    }
    const outcome = acquireOutcome.right

    if (outcome._tag === 'Left') {
      const err = outcome.left
      if (isModelUnavailable(err.stderr)) {
        return yield* Effect.fail(
          judgeError('judge model unavailable', 'E_MODEL_UNAVAILABLE', {
            ...(model === undefined ? {} : { model }),
            stderr: err.stderr,
            ...(err.timedOut ? { timedOut: true } : {}),
          }),
        )
      }
      const explanation = err.timedOut
        ? `judge timeout after ${String(runInput.timeouts.runSeconds)}s`
        : `judge crashed (exit ${err.exitCode === null ? 'unknown' : String(err.exitCode)})`
      return unclearFromFailure(explanation, '', model ?? '')
    }

    const raw = extractAssistantText(outcome.right.stdout)
    const parsed = parseJudgeResponse(raw)
    if (parsed === null) {
      return unclearFromFailure('Failed to parse judge response', raw, model ?? '')
    }

    return {
      verdict: parsed.verdict,
      oldQuality: parsed.oldQuality,
      newQuality: parsed.newQuality,
      explanation: parsed.explanation,
      ...(raw === '' ? {} : { rawResponse: raw }),
      modelUsed: model ?? '',
      timestamp: nowIso(),
    } satisfies JudgeResult
  })

/**
 * Writes `results/judge.json` with `{ judge: <result | null> }`. Best-effort:
 * a disk failure is logged but never fails the phase (the only contract error
 * is `E_MODEL_UNAVAILABLE`, which is unrelated to disk writes).
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

export const judge = (
  input: JudgeInput,
): Effect.Effect<JudgeResultOutput, PhaseError> =>
  Effect.gen(function* () {
    const result = yield* computeJudge(input)
    const resultsDir = path.resolve(input.runInput.outputPath)
    yield* writeJudgeJson(resultsDir, result)
    return { judge: result }
  })
