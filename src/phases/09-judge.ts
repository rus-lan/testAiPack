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
import { judgeError } from '../errors.js'
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

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u)

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

export const buildJudgePrompt = (
  runInput: RunInput,
  oldPatch: string,
  newPatch: string,
): string => {
  const packRef = runInput.packRef ?? 'n/a'
  return [
    '<system context>',
    'You are judging an A/B test of an opencode integration.',
    `Task prompt was: ${runInput.prompt}`,
    '</system context>',
    '',
    '<old side diff (baseline, no pack)>',
    '```diff',
    oldPatch,
    '```',
    '</old side>',
    '',
    `<new side diff (with pack: ${packRef})>`,
    '```diff',
    newPatch,
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

const isIntegerValue = (u: unknown): u is number => Number.isInteger(u)

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
  if (!isIntegerValue(oldQuality) || !isIntegerValue(newQuality)) return null
  if (oldQuality < 0 || oldQuality > 10 || newQuality < 0 || newQuality > 10) return null
  const explanation = obj['explanation']
  if (typeof explanation !== 'string') return null
  return { verdict, oldQuality, newQuality, explanation }
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

export const judge = (
  input: JudgeInput,
): Effect.Effect<JudgeResultOutput, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, diff } = input

    if (runInput.judge === undefined || runInput.judge === '') {
      return { judge: null }
    }

    const oldPatch = firstNonEmptyPatch(diff.old)
    const newPatch = firstNonEmptyPatch(diff.new)
    if (oldPatch === null && newPatch === null) {
      return { judge: bothEmptyResult() }
    }

    const prompt = buildJudgePrompt(
      runInput,
      oldPatch?.patch ?? '',
      newPatch?.patch ?? '',
    )

    const model = runInput.preflightModel
    const homeDir = process.env['HOME'] ?? '/tmp'
    const opts: OpencodeRunOptions = {
      homeDir,
      cwd: homeDir,
      agent: 'build',
      prompt,
      auto: true,
      ...(model === undefined ? {} : { model }),
      timeoutMs: runInput.timeouts.runSeconds * 1000,
    }

    const outcome = yield* opencodeRun(opts).pipe(Effect.either)

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
      return { judge: unclearFromFailure(explanation, '', model ?? '') }
    }

    const raw = extractAssistantText(outcome.right.stdout)
    const parsed = parseJudgeResponse(raw)
    if (parsed === null) {
      return {
        judge: unclearFromFailure(
          'Failed to parse judge response',
          raw,
          model ?? '',
        ),
      }
    }

    const judgeResult: JudgeResult = {
      verdict: parsed.verdict,
      oldQuality: parsed.oldQuality,
      newQuality: parsed.newQuality,
      explanation: parsed.explanation,
      ...(raw === '' ? {} : { rawResponse: raw }),
      modelUsed: model ?? '',
      timestamp: nowIso(),
    }
    return { judge: judgeResult }
  })
