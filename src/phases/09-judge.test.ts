import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect, Fiber } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  judge,
  parseJudgeResponse,
  buildJudgePrompt,
  extractAssistantText,
  judgeInstructionMentionsReportFile,
  summarizeDiffRuns,
  JUDGE_SINGLE_CALL_BUDGET_CHARS,
  JUDGE_RESPONSE_FORMAT,
} from './09-judge.js'
import type { JudgeVariantDiff } from './09-judge.js'
import { makeTempDir } from '../../tests/setup.js'
import { readFile, writeFile, ensureDir, removeDir } from '../util/fs.js'
import { judgeResultSchema } from '@generated/schemas'
import type {
  DiffResult,
  JudgeInput,
  JudgeResult,
  JudgeVerdict,
  Manifest,
  RunInput,
} from '@generated/types'

vi.mock('../opencode/cli.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../opencode/cli.js')>('../opencode/cli.js')
  return { ...actual, run: vi.fn() }
})

import { OpencodeError } from '../opencode/cli.js'
import type { OpencodeRunOptions, OpencodeRunResult } from '../opencode/cli.js'

const { run } = await import('../opencode/cli.js')
const runMock = vi.mocked(run)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

// ---------------------------------------------------------------------------
// Real judge.log fixtures
// ---------------------------------------------------------------------------

const fixturePath = (name: string): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', name)

/** Captured verbatim from a real run (2026-07-30, model ollama/qwen3.5-9b-32k) where the model
 * returned a substantive, well-formed verdict in the legacy `oldQuality`/`newQuality` shape — the
 * old shim's format. Loaded from disk rather than retyped inline: the model's response text is
 * Cyrillic with JSON escapes, and the whole point of this fixture is byte fidelity. */
const REAL_JUDGE_LOG = readFileSync(fixturePath('judge-real-response.txt'), 'utf8')

/** A well-formed N-way (3 variant) response, record-scores + ranking, base/graphify/astgrep. */
const N_WAY_JUDGE_LOG = readFileSync(fixturePath('judge-n-way-response.txt'), 'utf8')

/** A well-formed record-scores response over an arbitrary 3-variant name set (base/a/b), matching
 * the literal parser-hardening example in `03-hard-problems.md` §2.4. */
const RECORD_SCORES_JUDGE_LOG = readFileSync(fixturePath('judge-record-scores-response.txt'), 'utf8')

/** The `--- stdout ---` section of a captured judge.log fixture — what opencode's `run()` would have returned as `stdout`. */
const stdoutSectionOf = (log: string): string => {
  const m = /--- stdout ---\n([\s\S]*?)\n\n--- stderr ---/.exec(log)
  if (m === null || m[1] === undefined) throw new Error('judge log fixture format changed — could not extract stdout section')
  return m[1]
}

const REAL_JUDGE_STDOUT = stdoutSectionOf(REAL_JUDGE_LOG)
const N_WAY_JUDGE_STDOUT = stdoutSectionOf(N_WAY_JUDGE_LOG)
const RECORD_SCORES_JUDGE_STDOUT = stdoutSectionOf(RECORD_SCORES_JUDGE_LOG)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRunInput = (over: Partial<RunInput> = {}): RunInput => ({
  schemaVersion: 2,
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  runs: 1,
  parallel: 2,
  baseline: 'old',
  packs: [],
  variants: [
    { name: 'old', packs: [] },
    { name: 'new', packs: [] },
  ],
  isolation: 'home',
  auth: {
    opencode: true, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  protectGit: false,
  preflightEnabled: true,
  formats: ['md'],
  outputPath: makeTempDir(),
  diffHtml: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60, runSeconds: 30, verifySeconds: 60,
    installSeconds: 60, watchdogSeconds: 90,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  preflightModel: 'cheap/judge-model',
  judge: 'Judge which side is better.',
  ...over,
})

const fakeManifest: Manifest = {
  schemaVersion: 2,
  runId: 'rid-judge',
  timestamp: '2026-07-21T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  runs: 1,
  parallel: 2,
  baseline: 'old',
  packs: [],
  variants: [
    { name: 'old', packs: [] },
    { name: 'new', packs: [] },
  ],
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

const diffRun = (runIndex: number, patch: string): DiffResult['runs'][number] => ({
  runIndex,
  fullPatch: patch,
  summary: {
    filesChanged: patch === '' ? 0 : 1,
    additions: patch === '' ? 0 : 1,
    deletions: 0,
    perFile: [],
  },
  noChanges: patch === '',
})

const makeDiff = (variant: string, patches: readonly { readonly runIndex: number; readonly patch: string }[]): DiffResult => ({
  variant,
  runs: patches.map((p) => diffRun(p.runIndex, p.patch)),
})

const buildInput = (over: Partial<{
  runInput: Partial<RunInput>
  diffOld: DiffResult
  diffNew: DiffResult
}> = {}): JudgeInput => {
  const runInput = makeRunInput(over.runInput ?? {})
  return {
    runInput,
    manifest: fakeManifest,
    diffs: [
      over.diffOld ?? makeDiff('old', [{ runIndex: 1, patch: 'diff --git a/x b/x\n+old' }]),
      over.diffNew ?? makeDiff('new', [{ runIndex: 1, patch: 'diff --git a/x b/x\n+new' }]),
    ],
  }
}

const directInput = (runInput: RunInput, diffOld?: DiffResult, diffNew?: DiffResult): JudgeInput => ({
  runInput,
  manifest: fakeManifest,
  diffs: [
    diffOld ?? makeDiff('old', [{ runIndex: 1, patch: '+old' }]),
    diffNew ?? makeDiff('new', [{ runIndex: 1, patch: '+new' }]),
  ],
})

const without = <T extends Record<string, unknown>>(obj: T, key: string): T => {
  const { [key]: _omit, ...rest } = obj
  void _omit
  return rest as T
}

const textEvent = (text: string): string => `${JSON.stringify({ type: 'text', text, id: 't1' })}\n`

const assistantMessageEvent = (text: string): string =>
  `${JSON.stringify({
    type: 'message',
    info: { role: 'assistant' },
    parts: [{ type: 'text', text, id: 'p1' }],
  })}\n`

/**
 * The shape opencode actually streams per NDJSON line — `text` sits under a
 * singular `part` object, not directly on the event and not under a `parts`
 * array. This is what the captured judge-log fixtures contain; `textEvent`
 * above (flat `{ type: "text", text }`) is a shape the old parser also
 * accepted, but it is not what a real run produces.
 */
const streamedTextEvent = (text: string): string =>
  `${JSON.stringify({ type: 'text', timestamp: 1, sessionID: 's1', part: { id: 'p1', type: 'text', text } })}\n`

const okResult = (stdout: string): OpencodeRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  durationMs: 5,
  timedOut: false,
})

const succeedWith = (stdout: string) =>
  (): Effect.Effect<OpencodeRunResult, OpencodeError> =>
    Effect.succeed(okResult(stdout))

const failWith = (args: { readonly exitCode: number | null; readonly stderr: string; readonly stdout?: string; readonly timedOut: boolean }) =>
  (): Effect.Effect<OpencodeRunResult, OpencodeError> =>
    Effect.fail(new OpencodeError({ command: 'run', stdout: '', ...args }))

beforeEach(() => {
  runMock.mockReset()
  runMock.mockImplementation(succeedWith(textEvent('{"verdict":"ok","scores":{"old":5,"new":8},"explanation":"new is better"}')))
})

// ---------------------------------------------------------------------------
// extractAssistantText — real opencode event shapes
// ---------------------------------------------------------------------------

describe('extractAssistantText — event shape regression', () => {
  it('flat { type: "text", text } event (export-style part) — already worked', () => {
    expect(extractAssistantText(textEvent('hello'))).toBe('hello')
  })

  it('{ type: "message", parts: [...] } assistant event — already worked', () => {
    expect(extractAssistantText(assistantMessageEvent('hello'))).toBe('hello')
  })

  it('streamed run event { type: "text", part: { type: "text", text } } — the real opencode shape, was silently dropped before the fix', () => {
    expect(extractAssistantText(streamedTextEvent('hello'))).toBe('hello')
  })

  it('multiple streamed text events concatenate in order, same as the flat shape', () => {
    const stdout = streamedTextEvent('foo') + streamedTextEvent('bar')
    expect(extractAssistantText(stdout)).toBe('foobar')
  })

  it('non-text streamed events (step_start, step_finish) contribute nothing and do not throw', () => {
    const stdout =
      `${JSON.stringify({ type: 'step_start', part: { type: 'step-start' } })}\n` +
      streamedTextEvent('the verdict') +
      `${JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } })}\n`
    expect(extractAssistantText(stdout)).toBe('the verdict')
  })

  it('extracts the real qwen3.5-9b-32k transcript (judge-real-response.txt fixture) — this is the exact bug report', () => {
    const text = extractAssistantText(REAL_JUDGE_STDOUT)
    expect(text).toContain('```json')
    expect(text).toContain('"verdict": "unclear"')
    expect(text).toContain('"oldQuality": 5')
    expect(text).toContain('"newQuality": 8')
    expect(text).toContain('Файл report.md недоступен')
  })

  it('extracts the N-way fixture transcript (judge-n-way-response.txt)', () => {
    const text = extractAssistantText(N_WAY_JUDGE_STDOUT)
    expect(text).toContain('"verdict": "ok"')
    expect(text).toContain('"scores"')
    expect(text).toContain('"ranking"')
  })

  it('extracts the record-scores fixture transcript (judge-record-scores-response.txt)', () => {
    const text = extractAssistantText(RECORD_SCORES_JUDGE_STDOUT)
    expect(text).toContain('"scores":{"a":7,"b":5,"base":4}')
  })
})

// ---------------------------------------------------------------------------
// parseJudgeResponse — pure tabular tests (legacy old/new keys — the shim's format)
// ---------------------------------------------------------------------------

interface ParseCase {
  readonly name: string
  readonly raw: string
  readonly expect: { readonly verdict: JudgeVerdict; readonly scores: Record<string, number>; readonly explanation: string } | null
}

const PARSE_CASES: readonly ParseCase[] = [
  {
    name: 'plain JSON ok',
    raw: '{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"better"}',
    expect: { verdict: 'ok', scores: { old: 5, new: 8 }, explanation: 'better' },
  },
  {
    name: 'plain JSON fail',
    raw: '{"verdict":"fail","oldQuality":7,"newQuality":3,"explanation":"worse"}',
    expect: { verdict: 'fail', scores: { old: 7, new: 3 }, explanation: 'worse' },
  },
  {
    name: 'markdown json fence',
    raw: 'Here is my verdict:\n```json\n{"verdict":"ok","oldQuality":6,"newQuality":9,"explanation":"yes"}\n```\n',
    expect: { verdict: 'ok', scores: { old: 6, new: 9 }, explanation: 'yes' },
  },
  {
    name: 'markdown bare fence',
    raw: '```\n{"verdict":"unclear","oldQuality":0,"newQuality":0,"explanation":"?"}\n```',
    expect: { verdict: 'unclear', scores: { old: 0, new: 0 }, explanation: '?' },
  },
  {
    name: 'JSON embedded in prose',
    raw: 'I think {"verdict":"ok","oldQuality":5,"newQuality":7,"explanation":"x"} is the answer',
    expect: { verdict: 'ok', scores: { old: 5, new: 7 }, explanation: 'x' },
  },
  { name: 'garbage prose', raw: 'I cannot decide', expect: null },
  { name: 'empty string', raw: '', expect: null },
  { name: 'missing fields', raw: '{"verdict":"ok"}', expect: null },
  { name: 'verdict out of enum', raw: '{"verdict":"great","oldQuality":5,"newQuality":5,"explanation":"x"}', expect: null },
  { name: 'quality out of range high', raw: '{"verdict":"ok","oldQuality":15,"newQuality":5,"explanation":"x"}', expect: { verdict: 'ok', scores: { old: 10, new: 5 }, explanation: 'x' } },
  { name: 'quality out of range low', raw: '{"verdict":"ok","oldQuality":-1,"newQuality":5,"explanation":"x"}', expect: { verdict: 'ok', scores: { old: 0, new: 5 }, explanation: 'x' } },
  { name: 'quality clamps both extremes', raw: '{"verdict":"ok","oldQuality":-5,"newQuality":42,"explanation":"x"}', expect: { verdict: 'ok', scores: { old: 0, new: 10 }, explanation: 'x' } },
  { name: 'quality fractional is accepted and rounded', raw: '{"verdict":"ok","oldQuality":5.5,"newQuality":8.4,"explanation":"x"}', expect: { verdict: 'ok', scores: { old: 6, new: 8 }, explanation: 'x' } },
  { name: 'quality not a number', raw: '{"verdict":"ok","oldQuality":"5","newQuality":5,"explanation":"x"}', expect: null },
  { name: 'explanation not string', raw: '{"verdict":"ok","oldQuality":5,"newQuality":5,"explanation":42}', expect: null },
  { name: 'not an object', raw: '[1,2,3]', expect: null },
  {
    name: 'trailing explanation after fenced JSON, with a stray closing brace in the prose',
    raw: '```json\n{"verdict":"ok","oldQuality":5,"newQuality":5,"explanation":"x"}\n```\nHope that helps! :}',
    expect: { verdict: 'ok', scores: { old: 5, new: 5 }, explanation: 'x' },
  },
  {
    name: 'trailing explanation after bare JSON (no fence), with a stray closing brace in the prose',
    raw: '{"verdict":"ok","oldQuality":6,"newQuality":6,"explanation":"see {a:1} above"}\np.s. thanks for reading :}',
    expect: { verdict: 'ok', scores: { old: 6, new: 6 }, explanation: 'see {a:1} above' },
  },
  {
    name: 'different key casing (Verdict/OldQuality/NewQuality/Explanation)',
    raw: '{"Verdict":"fail","OldQuality":8,"NewQuality":2,"Explanation":"regressed"}',
    expect: { verdict: 'fail', scores: { old: 8, new: 2 }, explanation: 'regressed' },
  },
  {
    name: 'SCREAMING key casing',
    raw: '{"VERDICT":"ok","OLDQUALITY":4,"NEWQUALITY":9,"EXPLANATION":"caps"}',
    expect: { verdict: 'ok', scores: { old: 4, new: 9 }, explanation: 'caps' },
  },
  {
    name: 'Russian text in explanation, no fence',
    raw: '{"verdict":"unclear","oldQuality":5,"newQuality":8,"explanation":"Файл report.md недоступен для анализа"}',
    expect: { verdict: 'unclear', scores: { old: 5, new: 8 }, explanation: 'Файл report.md недоступен для анализа' },
  },
]

describe('parseJudgeResponse — tabular (legacy old/new keys)', () => {
  for (const c of PARSE_CASES) {
    it(`${c.name} → ${c.expect === null ? 'null' : c.expect.verdict}`, () => {
      const parsed = parseJudgeResponse(c.raw, ['old', 'new'])
      if (c.expect === null) {
        expect(parsed).toBeNull()
        return
      }
      expect(parsed).not.toBeNull()
      expect(parsed?.verdict).toBe(c.expect.verdict)
      expect(parsed?.scores).toEqual(c.expect.scores)
      expect(parsed?.explanation).toBe(c.expect.explanation)
    })
  }
})

describe('parseJudgeResponse — real qwen3.5-9b-32k response (judge-real-response.txt fixture)', () => {
  it('parses the fenced JSON out of the real transcript into the verdict the model actually gave (legacy oldQuality/newQuality, shim variant set)', () => {
    const text = extractAssistantText(REAL_JUDGE_STDOUT)
    const parsed = parseJudgeResponse(text, ['old', 'new'])
    expect(parsed).not.toBeNull()
    expect(parsed?.verdict).toBe('unclear')
    expect(parsed?.scores).toEqual({ old: 5, new: 8 })
    expect(parsed?.explanation).toContain('Файл report.md недоступен')
    expect(parsed?.explanation).toContain('CHPU')
  })
})

// ---------------------------------------------------------------------------
// parseJudgeResponse — N-way scores record + ranking validation (§2.4)
// ---------------------------------------------------------------------------

describe('parseJudgeResponse — N-way scores record + ranking validation', () => {
  const names = ['base', 'a', 'b']

  it('accepts a record scores object keyed by variant name, one entry per variant', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4},"ranking":["a","b","base"],"explanation":"a wins"}'
    const parsed = parseJudgeResponse(raw, names)
    expect(parsed).not.toBeNull()
    expect(parsed?.scores).toEqual({ base: 4, a: 7, b: 5 })
    expect(parsed?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('parses the literal record-scores fixture (judge-record-scores-response.txt)', () => {
    const text = extractAssistantText(RECORD_SCORES_JUDGE_STDOUT)
    const parsed = parseJudgeResponse(text, names)
    expect(parsed).not.toBeNull()
    expect(parsed?.scores).toEqual({ base: 4, a: 7, b: 5 })
    expect(parsed?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('parses the N-way fixture (judge-n-way-response.txt, base/graphify/astgrep)', () => {
    const text = extractAssistantText(N_WAY_JUDGE_STDOUT)
    const parsed = parseJudgeResponse(text, ['base', 'graphify', 'astgrep'])
    expect(parsed).not.toBeNull()
    expect(parsed?.verdict).toBe('ok')
    expect(parsed?.scores).toEqual({ base: 5, graphify: 8, astgrep: 6 })
    expect(parsed?.ranking).toEqual(['graphify', 'astgrep', 'base'])
  })

  it('unknown extra key in scores is ignored', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4,"extra":99},"explanation":"x"}'
    const parsed = parseJudgeResponse(raw, names)
    expect(parsed?.scores).toEqual({ base: 4, a: 7, b: 5 })
  })

  it('case-insensitive variant key match in scores', () => {
    const raw = '{"verdict":"ok","scores":{"A":7,"B":5,"BASE":4},"explanation":"x"}'
    const parsed = parseJudgeResponse(raw, names)
    expect(parsed?.scores).toEqual({ base: 4, a: 7, b: 5 })
  })

  it('missing a declared variant in scores -> whole response unparseable (null)', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"base":4},"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)).toBeNull()
  })

  it('a ranking naming an unknown variant is rejected -> falls back to a derived ranking', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4},"ranking":["a","c","base"],"explanation":"x"}'
    const parsed = parseJudgeResponse(raw, names)
    expect(parsed).not.toBeNull()
    expect(parsed?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('a ranking with a duplicate entry is rejected -> derived', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4},"ranking":["a","a","base"],"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('a ranking shorter than the variant set is rejected -> derived', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4},"ranking":["a","base"],"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('missing ranking -> derived from scores desc', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4},"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('tied scores -> derived ranking breaks ties by config order', () => {
    const raw = '{"verdict":"ok","scores":{"a":5,"b":5,"base":5},"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)?.ranking).toEqual(['base', 'a', 'b'])
  })

  it('ranking is case-insensitive but canonicalized to the declared variant casing', () => {
    const raw = '{"verdict":"ok","scores":{"a":7,"b":5,"base":4},"ranking":["A","B","BASE"],"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)?.ranking).toEqual(['a', 'b', 'base'])
  })

  it('legacy oldQuality/newQuality accepted only when the variant set is exactly {old, new}', () => {
    const raw = '{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"x"}'
    expect(parseJudgeResponse(raw, ['old', 'new'])).toEqual({
      verdict: 'ok',
      scores: { old: 5, new: 8 },
      ranking: ['new', 'old'],
      explanation: 'x',
    })
  })

  it('legacy oldQuality/newQuality rejected for any other variant set', () => {
    const raw = '{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"x"}'
    expect(parseJudgeResponse(raw, names)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildJudgePrompt — pure
// ---------------------------------------------------------------------------

const vd = (over: Partial<JudgeVariantDiff> & Pick<JudgeVariantDiff, 'name'>): JudgeVariantDiff => ({
  packs: [],
  isBaseline: false,
  taskPrompt: 'build the thing',
  patch: '',
  summary: '',
  ...over,
})

describe('buildJudgePrompt', () => {
  it('contains variant count, baseline disclosure, packs, both patches, judge instruction and response schema', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, patch: 'OLDPATCH', summary: 'run-1: 1 file(s), +1/-0' }),
      vd({ name: 'new', patch: 'NEWPATCH', summary: 'run-1: 1 file(s), +1/-0' }),
    ])
    expect(prompt).toContain('build the thing')
    expect(prompt).toContain('2 configurations')
    expect(prompt).toContain('Variant "old" is the BASELINE')
    expect(prompt).toContain('old (no packs); new (no packs)')
    expect(prompt).toContain('OLDPATCH')
    expect(prompt).toContain('NEWPATCH')
    expect(prompt).toContain('Judge which side is better.')
    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('<variant "old" (BASELINE, packs: none)>')
    expect(prompt).toContain('<variant "new" (packs: none)>')
  })

  it('discloses a non-baseline variant\'s declared packs, both in the header line and its own tag', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'base', isBaseline: true }),
      vd({ name: 'graphify', packs: ['graphify'] }),
    ])
    expect(prompt).toContain('base (no packs); graphify (packs: graphify)')
    expect(prompt).toContain('<variant "graphify" (packs: graphify)>')
  })

  it('truncates patches larger than 100KB to 50KB with a notice', () => {
    const runInput = makeRunInput({})
    const big = 'X'.repeat(200_000)
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, patch: big }),
      vd({ name: 'new', patch: 'NEWPATCH' }),
    ])
    expect(prompt).toContain('[truncated from 200000 chars]')
    // truncated body is the 50_000-char slice, not the full 200_000
    const fullMatch = prompt.match(/X+/g) ?? []
    const longestXRun = fullMatch.reduce((m, s) => Math.max(m, s.length), 0)
    expect(longestXRun).toBe(50_000)
    // the small new patch survives untouched
    expect(prompt).toContain('NEWPATCH')
  })

  it('does not truncate patches at or below 100KB', () => {
    const runInput = makeRunInput({})
    const exact = 'Y'.repeat(100_000)
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, patch: exact }),
      vd({ name: 'new', patch: 'n' }),
    ])
    expect(prompt).not.toContain('[truncated')
  })

  it('embeds the per-variant run summary alongside the representative patch', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, patch: 'OLDPATCH', summary: 'run-1: 2 file(s), +5/-1' }),
      vd({ name: 'new', patch: 'NEWPATCH', summary: 'run-1: 3 file(s), +9/-2' }),
    ])
    expect(prompt).toContain('run-1: 2 file(s), +5/-1')
    expect(prompt).toContain('run-1: 3 file(s), +9/-2')
  })

  it('states plainly that the judge has no file-system access', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, [vd({ name: 'old', isBaseline: true }), vd({ name: 'new' })])
    expect(prompt.toLowerCase()).toContain('no file-system access')
    expect(prompt).toContain('report.md/json/html')
  })

  it('adds an explicit note when the judge instruction names a report file the judge cannot read', () => {
    const runInput = makeRunInput({ judge: 'Analyse the report from report.md and decide.' })
    const prompt = buildJudgePrompt(runInput, [vd({ name: 'old', isBaseline: true }), vd({ name: 'new' })])
    expect(prompt).toContain('<note>')
    expect(prompt).toContain('report file was not available')
  })

  it('does not add the report-file note for an instruction that never mentions one', () => {
    const runInput = makeRunInput({ judge: 'Judge which side is better.' })
    const prompt = buildJudgePrompt(runInput, [vd({ name: 'old', isBaseline: true }), vd({ name: 'new' })])
    expect(prompt).not.toContain('<note>')
  })

  it('renders "(no changes on any run)" for a variant with a null patch, without omitting the variant', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, patch: null }),
      vd({ name: 'new', patch: 'NEWPATCH' }),
    ])
    expect(prompt).toContain('<variant "old"')
    expect(prompt).toContain('(no changes on any run)')
    expect(prompt).toContain('NEWPATCH')
  })

  it('uses the single shared "Task prompt was:" line when every variant has the same effective prompt', () => {
    const runInput = makeRunInput({ prompt: 'global task' })
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, taskPrompt: 'global task' }),
      vd({ name: 'new', taskPrompt: 'global task' }),
    ])
    expect(prompt).toContain('Task prompt was: global task')
    expect(prompt).not.toContain('task prompt:')
    expect(prompt).not.toContain('Task prompts differ')
  })

  it('discloses differing per-variant task prompts, with each variant carrying its own "task prompt:" line', () => {
    const runInput = makeRunInput({ prompt: 'global task' })
    const prompt = buildJudgePrompt(runInput, [
      vd({ name: 'old', isBaseline: true, taskPrompt: 'global task' }),
      vd({ name: 'new', taskPrompt: 'a different task for new' }),
    ])
    expect(prompt).toContain('Task prompts differ across variants')
    expect(prompt).toContain('task prompt: global task')
    expect(prompt).toContain('task prompt: a different task for new')
    expect(prompt).not.toContain('Task prompt was:')
  })
})

describe('JUDGE_RESPONSE_FORMAT', () => {
  it('is a single exported constant, included verbatim in the prompt', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, [vd({ name: 'old', isBaseline: true }), vd({ name: 'new' })])
    expect(prompt).toContain(JUDGE_RESPONSE_FORMAT)
    expect(JUDGE_RESPONSE_FORMAT).toContain('"scores"')
    expect(JUDGE_RESPONSE_FORMAT).toContain('"ranking"')
  })
})

describe('JUDGE_SINGLE_CALL_BUDGET_CHARS', () => {
  it('is 260,000 chars', () => {
    expect(JUDGE_SINGLE_CALL_BUDGET_CHARS).toBe(260_000)
  })
})

describe('judgeInstructionMentionsReportFile', () => {
  it.each(['report.md', 'report.json', 'report.html', 'report.yaml', 'Report.MD'])(
    'detects %s',
    (name) => {
      expect(judgeInstructionMentionsReportFile(`please read ${name} first`)).toBe(true)
    },
  )

  it('is false for ordinary instructions with no report-file mention', () => {
    expect(judgeInstructionMentionsReportFile('Judge which side handled errors better.')).toBe(false)
  })

  it('does not false-positive on the unrelated word "report" alone', () => {
    expect(judgeInstructionMentionsReportFile('Write a short report of your findings.')).toBe(false)
  })
})

describe('summarizeDiffRuns', () => {
  it('one line per run, sorted by runIndex, with file counts and totals', () => {
    const diff = makeDiff('old', [
      { runIndex: 2, patch: 'diff --git a/b b/b\n+x' },
      { runIndex: 1, patch: 'diff --git a/a b/a\n+y' },
    ])
    const summary = summarizeDiffRuns(diff)
    const lines = summary.split('\n')
    expect(lines[0]).toContain('run-1')
    expect(lines[1]).toContain('run-2')
    expect(summary).toContain('1 file(s), +1/-0')
  })

  it('marks a run with no changes distinctly from a run with a real diff', () => {
    const diff = makeDiff('old', [{ runIndex: 1, patch: '' }])
    expect(summarizeDiffRuns(diff)).toContain('no changes')
  })

  it('surfaces a failed run instead of silently omitting it', () => {
    const diff: DiffResult = {
      variant: 'old',
      runs: [
        {
          runIndex: 1,
          fullPatch: '',
          summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
          noChanges: true,
          state: 'failed',
          error: { code: 'E_WORKTREE_BROKEN', message: 'worktree missing' },
        },
      ],
    }
    const summary = summarizeDiffRuns(diff)
    expect(summary).toContain('failed')
    expect(summary).toContain('worktree missing')
  })

  it('lists individual file paths when the run touched a small number of files', () => {
    const diff: DiffResult = {
      variant: 'new',
      runs: [
        {
          runIndex: 1,
          fullPatch: 'diff --git a/src/x.ts b/src/x.ts\n+x',
          summary: {
            filesChanged: 2,
            additions: 12,
            deletions: 3,
            perFile: [
              { path: 'src/x.ts', additions: 10, deletions: 1 },
              { path: 'src/y.ts', additions: 2, deletions: 2 },
            ],
          },
          noChanges: false,
        },
      ],
    }
    const summary = summarizeDiffRuns(diff)
    expect(summary).toContain('src/x.ts (+10/-1)')
    expect(summary).toContain('src/y.ts (+2/-2)')
  })

  it('falls back to just the file count when a run touched too many files to list', () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => ({
      path: `src/f${String(i)}.ts`,
      additions: 1,
      deletions: 0,
    }))
    const diff: DiffResult = {
      variant: 'new',
      runs: [
        {
          runIndex: 1,
          fullPatch: 'diff --git a/src/f0.ts b/src/f0.ts\n+x',
          summary: { filesChanged: 25, additions: 25, deletions: 0, perFile: manyFiles },
          noChanges: false,
        },
      ],
    }
    const summary = summarizeDiffRuns(diff)
    expect(summary).toContain('25 file(s)')
    expect(summary).not.toContain('src/f0.ts')
  })

  it('shows a git-restored/git-replaced marker when protect-git recovery kicked in', () => {
    const diff: DiffResult = {
      variant: 'old',
      runs: [
        {
          runIndex: 1,
          fullPatch: 'diff --git a/x b/x\n+x',
          summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] },
          noChanges: false,
          state: 'git-restored',
        },
      ],
    }
    expect(summarizeDiffRuns(diff)).toContain('[git-restored]')
  })
})

// ---------------------------------------------------------------------------
// judge phase — shim pair (old/new)
// ---------------------------------------------------------------------------

describe('judge — skipped', () => {
  it('judge prompt not set → { judge: null }', async () => {
    const input = directInput(without(makeRunInput({}), 'judge'))
    const result = await runP(judge(input))
    expect(result.judge).toBeNull()
    expect(runMock).not.toHaveBeenCalled()
  })

  it('judge prompt empty string → { judge: null }', async () => {
    const input = buildInput({ runInput: { judge: '' } })
    const result = await runP(judge(input))
    expect(result.judge).toBeNull()
    expect(runMock).not.toHaveBeenCalled()
  })
})

describe('judge — happy path', () => {
  it('both diffs present, valid record-scores JSON response → verdict + scores from response', async () => {
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"ok","scores":{"old":5,"new":8},"explanation":"new adds validation"}')),
    )
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j).not.toBeNull()
    expect(j.verdict).toBe('ok')
    expect(j.scores).toEqual([{ variant: 'old', quality: 5 }, { variant: 'new', quality: 8 }])
    expect(j.ranking).toEqual(['new', 'old'])
    expect(j.explanation).toBe('new adds validation')
    expect(j.modelUsed).toBe('cheap/judge-model')
    expect(j.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(j.ran).toBe(true)
    expect(j.pairwiseFallback).toBeUndefined()
  })

  it('legacy oldQuality/newQuality response (shim variant set) → still parses', async () => {
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"fail","oldQuality":9,"newQuality":2,"explanation":"regression"}')),
    )
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('fail')
    expect(j.scores).toEqual([{ variant: 'old', quality: 9 }, { variant: 'new', quality: 2 }])
  })

  it('response inside assistant message event → parsed', async () => {
    runMock.mockImplementation(
      succeedWith(assistantMessageEvent('{"verdict":"fail","scores":{"old":9,"new":2},"explanation":"regression"}')),
    )
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('fail')
    expect(j.scores).toEqual([{ variant: 'old', quality: 9 }, { variant: 'new', quality: 2 }])
  })

  it('prompt sent to opencode includes patches and judge instruction', async () => {
    await runP(judge(buildInput({})))
    const opts = runMock.mock.calls[0]?.[0]
    expect(opts).toBeDefined()
    const prompt = opts!.prompt
    expect(prompt).toContain('+old')
    expect(prompt).toContain('+new')
    expect(prompt).toContain('Judge which side is better.')
    expect(opts!.model).toBe('cheap/judge-model')
    expect(opts!.agent).toBe('plan')
    expect(opts!.auto).toBe(false)
    expect(opts!.cwd).not.toBe(opts!.homeDir)
    expect(opts!.cwd).toContain('testaipack-judge')
    expect(opts!.timeoutMs).toBe(30 * 1000)
  })

  it('scratch cwd is removed again after the judge call finishes', async () => {
    await runP(judge(buildInput({})))
    const opts = runMock.mock.calls[0]?.[0]
    expect(existsSync(opts!.cwd)).toBe(false)
  })

  it('degrades to unclear (no shared-tmp fallback, no opencode call) when the scratch dir cannot be created', async () => {
    const runId = 'rid-judge-scratch-blocked'
    const scratchDir = path.join(os.tmpdir(), 'testaipack-judge', runId, 'single')
    await runP(ensureDir(path.dirname(scratchDir)))
    await runP(writeFile(scratchDir, 'a plain file blocking the scratch dir path'))
    try {
      const input = { ...buildInput({}), manifest: { ...fakeManifest, runId } }
      const result = await runP(judge(input))
      const j = result.judge as JudgeResult
      expect(j.verdict).toBe('unclear')
      expect(j.ran).toBe(false)
      expect(j.explanation).toContain('scratch directory')
      expect(runMock).not.toHaveBeenCalled()
    } finally {
      await runP(removeDir(path.dirname(scratchDir)))
    }
  })

  it('cleans up the scratch dir even when the judge call is interrupted mid-run', async () => {
    const runId = 'rid-judge-interrupted'
    const scratchDir = path.join(os.tmpdir(), 'testaipack-judge', runId, 'single')
    runMock.mockImplementation(() => Effect.never)
    const input = { ...buildInput({}), manifest: { ...fakeManifest, runId } }

    const fiber = Effect.runFork(judge(input))
    let created = false
    for (let i = 0; i < 50; i++) {
      if (existsSync(scratchDir)) {
        created = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(created).toBe(true)

    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(existsSync(scratchDir)).toBe(false)
  })

  it('no preflightModel → model option omitted', async () => {
    const input = directInput(without(makeRunInput({}), 'preflightModel'))
    await runP(judge(input))
    const opts = runMock.mock.calls[0]?.[0]
    expect(opts!.model).toBeUndefined()
    const j = (await runP(judge(input))).judge as JudgeResult
    expect(j.modelUsed).toBe('')
  })
})

describe('judge — run-1 fallback', () => {
  it('run-1 old empty, run-2 non-empty → uses run-2 patch', async () => {
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"ok","scores":{"old":1,"new":2},"explanation":"x"}')),
    )
    const diffOld = makeDiff('old', [
      { runIndex: 1, patch: '' },
      { runIndex: 2, patch: 'diff --git a/y b/y\n+run2' },
    ])
    const input = buildInput({ diffOld })
    await runP(judge(input))
    const opts = runMock.mock.calls[0]?.[0]
    expect(opts!.prompt).toContain('+run2')
  })

  it('run-1 new empty, run-2 non-empty → uses run-2 patch for new', async () => {
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"ok","scores":{"old":1,"new":2},"explanation":"x"}')),
    )
    const diffNew = makeDiff('new', [
      { runIndex: 1, patch: '' },
      { runIndex: 2, patch: 'diff --git a/z b/z\n+newrun2' },
    ])
    const input = buildInput({ diffNew })
    await runP(judge(input))
    const opts = runMock.mock.calls[0]?.[0]
    expect(opts!.prompt).toContain('+newrun2')
  })
})

describe('judge — both empty', () => {
  it('all patches empty → verdict unclear without calling LLM', async () => {
    const diffOld = makeDiff('old', [{ runIndex: 1, patch: '' }, { runIndex: 2, patch: '' }])
    const diffNew = makeDiff('new', [{ runIndex: 1, patch: '' }])
    const result = await runP(judge(buildInput({ diffOld, diffNew })))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.scores).toEqual([{ variant: 'old', quality: 0 }, { variant: 'new', quality: 0 }])
    expect(j.explanation).toContain('no changes')
    expect(j.modelUsed).toBe('')
    expect(j.ran).toBe(false)
    expect(runMock).not.toHaveBeenCalled()
  })
})

describe('judge — unparseable response', () => {
  it('LLM returns prose → verdict unclear, ran true, rawResponse preserved', async () => {
    runMock.mockImplementation(succeedWith(textEvent('I really cannot decide this one.')))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.scores).toEqual([{ variant: 'old', quality: 0 }, { variant: 'new', quality: 0 }])
    expect(j.explanation).toContain('parse')
    expect(j.rawResponse).toBe('I really cannot decide this one.')
    expect(j.ran).toBe(true)
  })
})

describe('judge — real qwen3.5-9b-32k response fixture (regression: was reported as "Failed to parse")', () => {
  it('opencode stdout from the real run parses into the verdict the model actually gave, not "unclear/0/0/Failed to parse"', async () => {
    runMock.mockImplementation(succeedWith(REAL_JUDGE_STDOUT))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.ran).toBe(true)
    expect(j.explanation).not.toContain('Failed to parse')
    expect(j.verdict).toBe('unclear')
    expect(j.scores).toEqual([{ variant: 'old', quality: 5 }, { variant: 'new', quality: 8 }])
    expect(j.explanation).toContain('Файл report.md недоступен')
  })
})

describe('judge — LLM failures (non-fatal → unclear, ran false)', () => {
  it('timeout → verdict unclear, ran false, explanation mentions timeout', async () => {
    runMock.mockImplementation(failWith({ exitCode: null, stderr: '', timedOut: true }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.ran).toBe(false)
    expect(j.explanation.toLowerCase()).toContain('timeout')
  })

  it('crash (exit 1) → verdict unclear, ran false, explanation mentions crash AND includes the stderr tail (was silently discarded)', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: 'boom: opencode printed usage and exited', timedOut: false }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.ran).toBe(false)
    expect(j.explanation.toLowerCase()).toContain('crash')
    expect(j.explanation).toContain('boom: opencode printed usage and exited')
  })

  it('timeout explanation also includes a stderr tail when the process wrote something before being killed', async () => {
    runMock.mockImplementation(failWith({ exitCode: null, stderr: 'partial output before kill', timedOut: true }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.explanation.toLowerCase()).toContain('timeout')
    expect(j.explanation).toContain('partial output before kill')
  })

  it('rate-limit (429 stderr, not auth) → verdict unclear, ran false', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: 'HTTP 429 too many requests', timedOut: false }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.ran).toBe(false)
  })
})

describe('judge — model unavailable (non-fatal → unclear, ran false)', () => {
  it('auth failure (401 unauthorized) → phase succeeds, verdict unclear, ran false', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: '401 Unauthorized invalid api key', timedOut: false }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.ran).toBe(false)
    expect(j.explanation).toContain('model unavailable')
  })

  it('model not found → phase succeeds, verdict unclear, ran false', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: 'model not found: cheap/judge-model', timedOut: false }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.ran).toBe(false)
  })
})

describe('judge — results/judge.json artifact', () => {
  it('writes judge.json with the result when the judge runs', async () => {
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"ok","scores":{"old":7,"new":9},"explanation":"new wins"}')),
    )
    const input = buildInput({})
    const result = await runP(judge(input))
    const judgeJsonPath = `${input.runInput.outputPath}/judge.json`
    expect(existsSync(judgeJsonPath)).toBe(true)
    const onDisk = JSON.parse(await runP(readFile(judgeJsonPath))) as { judge: JudgeResult | null }
    expect(onDisk.judge).not.toBeNull()
    expect((onDisk.judge as JudgeResult).verdict).toBe('ok')
    expect((onDisk.judge as JudgeResult).scores).toEqual([{ variant: 'old', quality: 7 }, { variant: 'new', quality: 9 }])
    expect(result.judge).not.toBeNull()
  })

  it('writes judge.json with { judge: null } when the judge is not requested', async () => {
    const input = directInput(without(makeRunInput({}), 'judge'))
    const result = await runP(judge(input))
    const judgeJsonPath = `${input.runInput.outputPath}/judge.json`
    expect(existsSync(judgeJsonPath)).toBe(true)
    const onDisk = JSON.parse(await runP(readFile(judgeJsonPath))) as { judge: JudgeResult | null }
    expect(onDisk.judge).toBeNull()
    expect(result.judge).toBeNull()
    expect(runMock).not.toHaveBeenCalled()
  })

  it('writes judge.json with an unclear verdict when the judge response is unparseable', async () => {
    runMock.mockImplementation(succeedWith(textEvent('I cannot decide this one.')))
    const input = buildInput({})
    await runP(judge(input))
    const onDisk = JSON.parse(await runP(readFile(`${input.runInput.outputPath}/judge.json`))) as {
      judge: JudgeResult | null
    }
    expect((onDisk.judge as JudgeResult).verdict).toBe('unclear')
  })
})

describe('judge — results/judge.log artifact (full transcript for post-mortem)', () => {
  it('writes judge.log with the full stdout on a successful run', async () => {
    const stdout = textEvent('{"verdict":"ok","scores":{"old":7,"new":9},"explanation":"new wins"}')
    runMock.mockImplementation(succeedWith(stdout))
    const input = buildInput({})
    await runP(judge(input))
    const logPath = `${input.runInput.outputPath}/judge.log`
    expect(existsSync(logPath)).toBe(true)
    const log = await runP(readFile(logPath))
    expect(log).toContain(stdout.trim())
    expect(log).toContain('exitCode: 0')
  })

  it('writes judge.log with the full stderr on a crash — diagnosable without re-running', async () => {
    runMock.mockImplementation(
      failWith({ exitCode: 1, stderr: 'diff --git a/x b/x looked like a flag and opencode printed usage', timedOut: false }),
    )
    const input = buildInput({})
    await runP(judge(input))
    const log = await runP(readFile(`${input.runInput.outputPath}/judge.log`))
    expect(log).toContain('diff --git a/x b/x looked like a flag and opencode printed usage')
    expect(log).toContain('exitCode: 1')
  })

  it('does not write judge.log when the judge was never invoked (not requested, both patches empty, scratch dir blocked)', async () => {
    const notRequested = directInput(without(makeRunInput({}), 'judge'))
    await runP(judge(notRequested))
    expect(existsSync(`${notRequested.runInput.outputPath}/judge.log`)).toBe(false)

    const diffOld = makeDiff('old', [{ runIndex: 1, patch: '' }])
    const diffNew = makeDiff('new', [{ runIndex: 1, patch: '' }])
    const bothEmpty = buildInput({ diffOld, diffNew })
    await runP(judge(bothEmpty))
    expect(existsSync(`${bothEmpty.runInput.outputPath}/judge.log`)).toBe(false)
  })
})

describe('judge — report-file reference warning (console, best-effort surfacing)', () => {
  it('warns on stderr when --judge references a report file the judge cannot see', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const input = buildInput({ runInput: { judge: 'Read report.md and judge accordingly.' } })
    await runP(judge(input))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('report.md/json/html'))
    warnSpy.mockRestore()
  })

  it('does not warn for an instruction with no report-file reference', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await runP(judge(buildInput({})))
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('judgeResultSchema — v2 shape', () => {
  it('parses a full N-way result with scores array, ranking, and required fields only', () => {
    const fresh = {
      verdict: 'ok',
      scores: [{ variant: 'base', quality: 4 }, { variant: 'graphify', quality: 8 }],
      ranking: ['graphify', 'base'],
      explanation: 'graphify wins',
      modelUsed: 'gpt-test',
      timestamp: '2025-01-01T00:00:00.000Z',
    }
    expect(judgeResultSchema.safeParse(fresh).success).toBe(true)
  })

  it('parses with ran/pairwiseFallback/rawResponse present', () => {
    const fresh = {
      verdict: 'unclear',
      scores: [{ variant: 'old', quality: 0 }, { variant: 'new', quality: 0 }],
      ranking: ['old', 'new'],
      explanation: 'judge model unavailable',
      modelUsed: '',
      timestamp: '2025-01-01T00:00:00.000Z',
      ran: false,
      pairwiseFallback: true,
      rawResponse: 'raw text',
    }
    expect(judgeResultSchema.safeParse(fresh).success).toBe(true)
  })

  it('rejects the old v1 shape (oldQuality/newQuality instead of scores/ranking) — v1 artifacts go through the compat loader, not this schema directly', () => {
    const legacy = {
      verdict: 'ok',
      oldQuality: 7,
      newQuality: 8,
      explanation: 'new is better',
      modelUsed: 'gpt-test',
      timestamp: '2025-01-01T00:00:00.000Z',
    }
    expect(judgeResultSchema.safeParse(legacy).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// judge phase — N-way (3 variants): single-call path
// ---------------------------------------------------------------------------

describe('judge — N-way (3 variants), within budget', () => {
  const threeRunInput = (over: Partial<RunInput> = {}): RunInput =>
    makeRunInput({
      baseline: 'base',
      variants: [
        { name: 'base', packs: [] },
        { name: 'graphify', packs: ['graphify'] },
        { name: 'astgrep', packs: ['astgrep'] },
      ],
      packs: [
        { name: 'graphify', ref: 'https://example.com/graphify.git' },
        { name: 'astgrep', ref: 'https://example.com/astgrep.git' },
      ],
      ...over,
    })

  const threeDiffs = (patches: Partial<Record<string, string>> = {}): DiffResult[] => [
    makeDiff('base', [{ runIndex: 1, patch: patches['base'] ?? 'diff --git a/x b/x\n+base' }]),
    makeDiff('graphify', [{ runIndex: 1, patch: patches['graphify'] ?? 'diff --git a/x b/x\n+graphify' }]),
    makeDiff('astgrep', [{ runIndex: 1, patch: patches['astgrep'] ?? 'diff --git a/x b/x\n+astgrep' }]),
  ]

  it('exactly 1 opencode call, scores for all 3 variants, ranking length 3', async () => {
    runMock.mockImplementation(succeedWith(N_WAY_JUDGE_STDOUT))
    const input: JudgeInput = { runInput: threeRunInput(), manifest: fakeManifest, diffs: threeDiffs() }
    const result = await runP(judge(input))
    const j = result.judge as JudgeResult
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(j.scores).toHaveLength(3)
    expect(j.scores.map((s) => s.variant).sort()).toEqual(['astgrep', 'base', 'graphify'])
    expect(j.ranking).toHaveLength(3)
    expect(j.verdict).toBe('ok')
    expect(j.pairwiseFallback).toBeUndefined()
  })

  it('prompt discloses variant count, baseline, and per-variant packs', async () => {
    await runP(judge({ runInput: threeRunInput(), manifest: fakeManifest, diffs: threeDiffs() }))
    const prompt = runMock.mock.calls[0]?.[0]?.prompt ?? ''
    expect(prompt).toContain('3 configurations')
    expect(prompt).toContain('Variant "base" is the BASELINE')
    expect(prompt).toContain('base (no packs); graphify (packs: graphify); astgrep (packs: astgrep)')
  })

  it('a SUBSET of empty variants stays in the prompt (marked, not skipped) while the call still happens', async () => {
    const diffs = threeDiffs({ graphify: '' })
    await runP(judge({ runInput: threeRunInput(), manifest: fakeManifest, diffs }))
    expect(runMock).toHaveBeenCalledTimes(1)
    const prompt = runMock.mock.calls[0]?.[0]?.prompt ?? ''
    expect(prompt).toContain('<variant "graphify"')
    expect(prompt).toContain('(no changes on any run)')
  })

  it('ALL variants empty -> unclear, ran false, no opencode call, every variant scored 0', async () => {
    const diffs = threeDiffs({ base: '', graphify: '', astgrep: '' })
    const result = await runP(judge({ runInput: threeRunInput(), manifest: fakeManifest, diffs }))
    const j = result.judge as JudgeResult
    expect(runMock).not.toHaveBeenCalled()
    expect(j.ran).toBe(false)
    expect(j.explanation).toContain('all variants produced no changes')
    expect(j.scores.every((s) => s.quality === 0)).toBe(true)
    expect(j.scores).toHaveLength(3)
  })

  it('per-variant task prompt disclosure when a variant overrides prompt', async () => {
    const runInput = threeRunInput({
      variants: [
        { name: 'base', packs: [] },
        { name: 'graphify', packs: ['graphify'], prompt: 'a different task for graphify' },
        { name: 'astgrep', packs: ['astgrep'] },
      ],
    })
    await runP(judge({ runInput, manifest: fakeManifest, diffs: threeDiffs() }))
    const prompt = runMock.mock.calls[0]?.[0]?.prompt ?? ''
    expect(prompt).toContain('Task prompts differ across variants')
    expect(prompt).toContain('task prompt: a different task for graphify')
  })

  it('B1 regression: when the baseline is NOT first in config order, the single-call prompt still puts the baseline block first', async () => {
    const runInput = threeRunInput({
      variants: [
        { name: 'graphify', packs: ['graphify'] },
        { name: 'base', packs: [] },
        { name: 'astgrep', packs: ['astgrep'] },
      ],
    })
    await runP(judge({ runInput, manifest: fakeManifest, diffs: threeDiffs() }))
    const prompt = runMock.mock.calls[0]?.[0]?.prompt ?? ''
    const baselinePos = prompt.indexOf('<variant "base"')
    const graphifyPos = prompt.indexOf('<variant "graphify"')
    const astgrepPos = prompt.indexOf('<variant "astgrep"')
    expect(baselinePos).toBeGreaterThanOrEqual(0)
    expect(baselinePos).toBeLessThan(graphifyPos)
    expect(baselinePos).toBeLessThan(astgrepPos)
  })
})

// ---------------------------------------------------------------------------
// judge phase — N-way (3 variants): pairwise-vs-baseline fallback (over budget)
// ---------------------------------------------------------------------------

describe('judge — pairwise-vs-baseline fallback (assembled prompt over budget)', () => {
  /** Exactly 100_000 chars — the truncation boundary (`patch.length <= 100_000` stays untouched), the largest a single patch can contribute to a prompt. */
  const nearLimitPatch = (tag: string): string => `${tag}:${'X'.repeat(100_000 - tag.length - 1)}`

  const overBudgetRunInput = (): RunInput =>
    makeRunInput({
      baseline: 'base',
      variants: [
        { name: 'base', packs: [] },
        { name: 'graphify', packs: ['graphify'] },
        { name: 'astgrep', packs: ['astgrep'] },
      ],
    })

  const overBudgetDiffs = (): DiffResult[] => [
    makeDiff('base', [{ runIndex: 1, patch: nearLimitPatch('base') }]),
    makeDiff('graphify', [{ runIndex: 1, patch: nearLimitPatch('graphify') }]),
    makeDiff('astgrep', [{ runIndex: 1, patch: nearLimitPatch('astgrep') }]),
  ]

  it('the assembled single-call prompt for these 3 variants exceeds the budget (sanity check on the fixture)', () => {
    const prompt = buildJudgePrompt(overBudgetRunInput(), [
      vd({ name: 'base', isBaseline: true, patch: nearLimitPatch('base') }),
      vd({ name: 'graphify', packs: ['graphify'], patch: nearLimitPatch('graphify') }),
      vd({ name: 'astgrep', packs: ['astgrep'], patch: nearLimitPatch('astgrep') }),
    ])
    expect(prompt.length).toBeGreaterThan(JUDGE_SINGLE_CALL_BUDGET_CHARS)
  })

  it('B1 regression: when the baseline is NOT first in config order, every pairwise prompt still puts the baseline block first', async () => {
    // baseline "base" is declared SECOND in `variants` — config order is
    // [graphify, base, astgrep]. If the pairwise builder used config order
    // for the prompt (instead of always putting the baseline first), the
    // graphify pair's prompt would put graphify before base.
    const runInput = makeRunInput({
      baseline: 'base',
      variants: [
        { name: 'graphify', packs: ['graphify'] },
        { name: 'base', packs: [] },
        { name: 'astgrep', packs: ['astgrep'] },
      ],
    })
    const diffs: DiffResult[] = [
      makeDiff('graphify', [{ runIndex: 1, patch: nearLimitPatch('graphify') }]),
      makeDiff('base', [{ runIndex: 1, patch: nearLimitPatch('base') }]),
      makeDiff('astgrep', [{ runIndex: 1, patch: nearLimitPatch('astgrep') }]),
    ]
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"ok","scores":{"base":5,"graphify":5,"astgrep":5},"explanation":"x"}')),
    )
    await runP(judge({ runInput, manifest: fakeManifest, diffs }))
    expect(runMock).toHaveBeenCalledTimes(2)
    for (const call of runMock.mock.calls) {
      const prompt = call[0].prompt
      const baselinePos = prompt.indexOf('<variant "base"')
      expect(baselinePos).toBeGreaterThanOrEqual(0)
      const otherPos = prompt.includes('<variant "graphify"')
        ? prompt.indexOf('<variant "graphify"')
        : prompt.indexOf('<variant "astgrep"')
      expect(baselinePos).toBeLessThan(otherPos)
    }
  })

  it('4 variants / 3 pairs -> baseline quality is the MEDIAN, not the mean, of its per-pair scores', async () => {
    const fourNames = ['base', 'a', 'b', 'c']
    const runInput = makeRunInput({
      baseline: 'base',
      variants: fourNames.map((name) => ({ name, packs: [] })),
    })
    const diffs: DiffResult[] = fourNames.map((name) => makeDiff(name, [{ runIndex: 1, patch: nearLimitPatch(name) }]))
    runMock.mockImplementation((opts: OpencodeRunOptions) => {
      // baseline scores 2, 4, 9 across the 3 pairs — median 4, mean 5: only
      // a real median implementation gives 4.
      const body = opts.prompt.includes('"a"')
        ? { verdict: 'ok', scores: { base: 2, a: 6 }, explanation: 'x' }
        : opts.prompt.includes('"b"')
          ? { verdict: 'ok', scores: { base: 4, b: 6 }, explanation: 'x' }
          : { verdict: 'ok', scores: { base: 9, c: 6 }, explanation: 'x' }
      return Effect.succeed(okResult(textEvent(JSON.stringify(body))))
    })
    const result = await runP(judge({ runInput, manifest: fakeManifest, diffs }))
    const j = result.judge as JudgeResult
    expect(runMock).toHaveBeenCalledTimes(3)
    const baseScore = j.scores.find((s) => s.variant === 'base')
    expect(baseScore?.quality).toBe(4)
    expect(j.explanation).toContain('median of 3 pairwise scores')
  })

  it('N-1 pairwise calls instead of 1, pairwiseFallback true, baseline quality = median of its per-pair scores', async () => {
    runMock.mockImplementation((opts: OpencodeRunOptions) => {
      const body = opts.prompt.includes('"graphify"')
        ? { verdict: 'ok', scores: { base: 4, graphify: 9 }, ranking: ['graphify', 'base'], explanation: 'graphify wins' }
        : { verdict: 'fail', scores: { base: 6, astgrep: 3 }, ranking: ['base', 'astgrep'], explanation: 'astgrep regresses' }
      return Effect.succeed(okResult(textEvent(JSON.stringify(body))))
    })
    const result = await runP(judge({ runInput: overBudgetRunInput(), manifest: fakeManifest, diffs: overBudgetDiffs() }))
    const j = result.judge as JudgeResult
    expect(runMock).toHaveBeenCalledTimes(2)
    expect(j.pairwiseFallback).toBe(true)
    expect(j.ran).toBe(true)
    const baseScore = j.scores.find((s) => s.variant === 'base')
    const graphifyScore = j.scores.find((s) => s.variant === 'graphify')
    const astgrepScore = j.scores.find((s) => s.variant === 'astgrep')
    expect(baseScore?.quality).toBe(5) // median([4, 6])
    expect(graphifyScore?.quality).toBe(9)
    expect(astgrepScore?.quality).toBe(3)
    expect(j.verdict).toBe('ok') // any pair verdict ok -> ok
    expect(j.ranking).toEqual(['graphify', 'base', 'astgrep'])
    expect(j.explanation).toContain('median of 2 pairwise scores')
    expect(j.explanation).toContain('vs graphify: graphify wins')
    expect(j.explanation).toContain('vs astgrep: astgrep regresses')
  })

  it('each pairwise call prompt is a 2-variant prompt, well under the single-call budget by construction', async () => {
    let maxLen = 0
    runMock.mockImplementation((opts: OpencodeRunOptions) => {
      maxLen = Math.max(maxLen, opts.prompt.length)
      return Effect.succeed(
        okResult(textEvent('{"verdict":"ok","scores":{"base":5,"graphify":5,"astgrep":5},"explanation":"x"}')),
      )
    })
    await runP(judge({ runInput: overBudgetRunInput(), manifest: fakeManifest, diffs: overBudgetDiffs() }))
    expect(maxLen).toBeLessThan(JUDGE_SINGLE_CALL_BUDGET_CHARS)
  })

  it('verdict is fail only when every pair verdict is fail', async () => {
    runMock.mockImplementation((opts: OpencodeRunOptions) => {
      const body = opts.prompt.includes('"graphify"')
        ? { verdict: 'fail', scores: { base: 6, graphify: 3 }, explanation: 'graphify regressed' }
        : { verdict: 'fail', scores: { base: 6, astgrep: 2 }, explanation: 'astgrep regressed' }
      return Effect.succeed(okResult(textEvent(JSON.stringify(body))))
    })
    const result = await runP(judge({ runInput: overBudgetRunInput(), manifest: fakeManifest, diffs: overBudgetDiffs() }))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('fail')
  })

  it('one pairwise call fails (timeout), the other succeeds -> that variant scores 0 with a note, ran stays true', async () => {
    runMock.mockImplementation((opts: OpencodeRunOptions) => {
      if (opts.prompt.includes('"graphify"')) {
        return Effect.succeed(
          okResult(textEvent('{"verdict":"ok","scores":{"base":5,"graphify":7},"explanation":"graphify ok"}')),
        )
      }
      return Effect.fail(new OpencodeError({ command: 'run', stdout: '', exitCode: null, stderr: '', timedOut: true }))
    })
    const result = await runP(judge({ runInput: overBudgetRunInput(), manifest: fakeManifest, diffs: overBudgetDiffs() }))
    const j = result.judge as JudgeResult
    expect(j.ran).toBe(true)
    expect(j.pairwiseFallback).toBe(true)
    const astgrepScore = j.scores.find((s) => s.variant === 'astgrep')
    expect(astgrepScore?.quality).toBe(0)
    expect(j.explanation).toContain('vs astgrep:')
    expect(j.explanation.toLowerCase()).toContain('timeout')
    const graphifyScore = j.scores.find((s) => s.variant === 'graphify')
    expect(graphifyScore?.quality).toBe(7)
    // B2: the disclosed count is the number of scores the median was ACTUALLY
    // taken over (1 surviving pair — astgrep's call never produced a score),
    // not the number of pairs attempted (2).
    expect(j.explanation).toContain('median of 1 pairwise scores')
    const baseScore = j.scores.find((s) => s.variant === 'base')
    expect(baseScore?.quality).toBe(5) // median of the single surviving pairwise score
  })

  it('all pairwise calls fail -> ran false (usual containment), one combined judge.log with both transcripts', async () => {
    runMock.mockImplementation(
      failWith({ exitCode: 1, stderr: 'boom', timedOut: false }),
    )
    const input = { runInput: overBudgetRunInput(), manifest: fakeManifest, diffs: overBudgetDiffs() }
    const result = await runP(judge(input))
    const j = result.judge as JudgeResult
    expect(j.ran).toBe(false)
    expect(j.verdict).toBe('unclear')
    const logPath = `${input.runInput.outputPath}/judge.log`
    expect(existsSync(logPath)).toBe(true)
    const log = await runP(readFile(logPath))
    expect(log).toContain('boom')
    expect(log.match(/testaipack judge log/g)?.length).toBe(2)
  })
})
