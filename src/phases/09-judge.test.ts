import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import { judge, parseJudgeResponse, buildJudgePrompt } from './09-judge.js'
import type {
  DiffResult,
  DiffRunResult,
  JudgeInput,
  JudgeResult,
  JudgeVerdict,
  Manifest,
  RunInput,
  Side,
} from '@generated/types'

vi.mock('../opencode/cli.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../opencode/cli.js')>('../opencode/cli.js')
  return { ...actual, run: vi.fn() }
})

import { OpencodeError } from '../opencode/cli.js'
import type { OpencodeRunResult } from '../opencode/cli.js'

const { run } = await import('../opencode/cli.js')
const runMock = vi.mocked(run)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRunInput = (over: Partial<RunInput>): RunInput => ({
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: true, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  pureBaseline: true,
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
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
  packRef: 'myorg/mypack',
  judge: 'Judge which side is better.',
  ...over,
})

const fakeManifest: Manifest = {
  runId: 'rid-judge',
  timestamp: '2026-07-21T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

const diffRun = (runIndex: number, patch: string): DiffRunResult => ({
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

const makeDiff = (side: Side, patches: readonly { readonly runIndex: number; readonly patch: string }[]): DiffResult => ({
  side,
  runs: patches.map((p) => diffRun(p.runIndex, p.patch)),
})

const buildInput = (over: Partial<{
  runInput: Partial<RunInput>
  diffOld: DiffResult
  diffNew: DiffResult
}>): JudgeInput => {
  const runInput = makeRunInput(over.runInput ?? {})
  return {
    runInput,
    manifest: fakeManifest,
    diff: {
      old: over.diffOld ?? makeDiff('old', [{ runIndex: 1, patch: 'diff --git a/x b/x\n+old' }]),
      new: over.diffNew ?? makeDiff('new', [{ runIndex: 1, patch: 'diff --git a/x b/x\n+new' }]),
    },
  }
}

const directInput = (runInput: RunInput, diffOld?: DiffResult, diffNew?: DiffResult): JudgeInput => ({
  runInput,
  manifest: fakeManifest,
  diff: {
    old: diffOld ?? makeDiff('old', [{ runIndex: 1, patch: '+old' }]),
    new: diffNew ?? makeDiff('new', [{ runIndex: 1, patch: '+new' }]),
  },
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

const failWith = (args: { readonly exitCode: number | null; readonly stderr: string; readonly timedOut: boolean }) =>
  (): Effect.Effect<OpencodeRunResult, OpencodeError> =>
    Effect.fail(new OpencodeError({ command: 'run', ...args }))

beforeEach(() => {
  runMock.mockReset()
  runMock.mockImplementation(succeedWith(textEvent('{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"new is better"}')))
})

// ---------------------------------------------------------------------------
// parseJudgeResponse — pure tabular tests
// ---------------------------------------------------------------------------

interface ParseCase {
  readonly name: string
  readonly raw: string
  readonly expect: { readonly verdict: JudgeVerdict; readonly oldQuality: number; readonly newQuality: number; readonly explanation: string } | null
}

const PARSE_CASES: readonly ParseCase[] = [
  {
    name: 'plain JSON ok',
    raw: '{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"better"}',
    expect: { verdict: 'ok', oldQuality: 5, newQuality: 8, explanation: 'better' },
  },
  {
    name: 'plain JSON fail',
    raw: '{"verdict":"fail","oldQuality":7,"newQuality":3,"explanation":"worse"}',
    expect: { verdict: 'fail', oldQuality: 7, newQuality: 3, explanation: 'worse' },
  },
  {
    name: 'markdown json fence',
    raw: 'Here is my verdict:\n```json\n{"verdict":"ok","oldQuality":6,"newQuality":9,"explanation":"yes"}\n```\n',
    expect: { verdict: 'ok', oldQuality: 6, newQuality: 9, explanation: 'yes' },
  },
  {
    name: 'markdown bare fence',
    raw: '```\n{"verdict":"unclear","oldQuality":0,"newQuality":0,"explanation":"?"}\n```',
    expect: { verdict: 'unclear', oldQuality: 0, newQuality: 0, explanation: '?' },
  },
  {
    name: 'JSON embedded in prose',
    raw: 'I think {"verdict":"ok","oldQuality":5,"newQuality":7,"explanation":"x"} is the answer',
    expect: { verdict: 'ok', oldQuality: 5, newQuality: 7, explanation: 'x' },
  },
  { name: 'garbage prose', raw: 'I cannot decide', expect: null },
  { name: 'empty string', raw: '', expect: null },
  { name: 'missing fields', raw: '{"verdict":"ok"}', expect: null },
  { name: 'verdict out of enum', raw: '{"verdict":"great","oldQuality":5,"newQuality":5,"explanation":"x"}', expect: null },
  { name: 'quality out of range high', raw: '{"verdict":"ok","oldQuality":15,"newQuality":5,"explanation":"x"}', expect: null },
  { name: 'quality out of range low', raw: '{"verdict":"ok","oldQuality":-1,"newQuality":5,"explanation":"x"}', expect: null },
  { name: 'quality not integer', raw: '{"verdict":"ok","oldQuality":5.5,"newQuality":5,"explanation":"x"}', expect: null },
  { name: 'explanation not string', raw: '{"verdict":"ok","oldQuality":5,"newQuality":5,"explanation":42}', expect: null },
  { name: 'not an object', raw: '[1,2,3]', expect: null },
]

describe('parseJudgeResponse — tabular', () => {
  for (const c of PARSE_CASES) {
    it(`${c.name} → ${c.expect === null ? 'null' : c.expect.verdict}`, () => {
      expect(parseJudgeResponse(c.raw)).toEqual(c.expect)
    })
  }
})

// ---------------------------------------------------------------------------
// buildJudgePrompt — pure
// ---------------------------------------------------------------------------

describe('buildJudgePrompt', () => {
  it('contains task prompt, pack ref, both patches, judge instruction and JSON schema', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, 'OLDPATCH', 'NEWPATCH')
    expect(prompt).toContain('build the thing')
    expect(prompt).toContain('myorg/mypack')
    expect(prompt).toContain('OLDPATCH')
    expect(prompt).toContain('NEWPATCH')
    expect(prompt).toContain('Judge which side is better.')
    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('<old side diff')
    expect(prompt).toContain('<new side diff')
  })

  it('uses n/a when packRef is absent', () => {
    const runInput = without(makeRunInput({}), 'packRef')
    const prompt = buildJudgePrompt(runInput, 'a', 'b')
    expect(prompt).toContain('with pack: n/a')
  })
})

// ---------------------------------------------------------------------------
// judge phase
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
  it('both patches present, valid JSON response → verdict from response', async () => {
    runMock.mockImplementation(
      succeedWith(textEvent('{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"new adds validation"}')),
    )
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j).not.toBeNull()
    expect(j.verdict).toBe('ok')
    expect(j.oldQuality).toBe(5)
    expect(j.newQuality).toBe(8)
    expect(j.explanation).toBe('new adds validation')
    expect(j.modelUsed).toBe('cheap/judge-model')
    expect(j.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('response inside assistant message event → parsed', async () => {
    runMock.mockImplementation(
      succeedWith(assistantMessageEvent('{"verdict":"fail","oldQuality":9,"newQuality":2,"explanation":"regression"}')),
    )
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('fail')
    expect(j.oldQuality).toBe(9)
    expect(j.newQuality).toBe(2)
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
    expect(opts!.agent).toBe('build')
    expect(opts!.timeoutMs).toBe(30 * 1000)
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
      succeedWith(textEvent('{"verdict":"ok","oldQuality":1,"newQuality":2,"explanation":"x"}')),
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
      succeedWith(textEvent('{"verdict":"ok","oldQuality":1,"newQuality":2,"explanation":"x"}')),
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
    expect(j.oldQuality).toBe(0)
    expect(j.newQuality).toBe(0)
    expect(j.explanation).toContain('no changes')
    expect(j.modelUsed).toBe('')
    expect(runMock).not.toHaveBeenCalled()
  })
})

describe('judge — unparseable response', () => {
  it('LLM returns prose → verdict unclear, rawResponse preserved', async () => {
    runMock.mockImplementation(succeedWith(textEvent('I really cannot decide this one.')))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.oldQuality).toBe(0)
    expect(j.newQuality).toBe(0)
    expect(j.explanation).toContain('parse')
    expect(j.rawResponse).toBe('I really cannot decide this one.')
  })
})

describe('judge — LLM failures (non-fatal → unclear)', () => {
  it('timeout → verdict unclear, explanation mentions timeout', async () => {
    runMock.mockImplementation(failWith({ exitCode: null, stderr: '', timedOut: true }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.explanation.toLowerCase()).toContain('timeout')
  })

  it('crash (exit 1) → verdict unclear, explanation mentions crash', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: 'boom', timedOut: false }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
    expect(j.explanation.toLowerCase()).toContain('crash')
  })

  it('rate-limit (429 stderr, not auth) → verdict unclear', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: 'HTTP 429 too many requests', timedOut: false }))
    const result = await runP(judge(buildInput({})))
    const j = result.judge as JudgeResult
    expect(j.verdict).toBe('unclear')
  })
})

describe('judge — model unavailable (fatal → E_MODEL_UNAVAILABLE)', () => {
  it('auth failure (401 unauthorized) → phase fails', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: '401 Unauthorized invalid api key', timedOut: false }))
    const err = await runFlip(judge(buildInput({})))
    expect(err.code).toBe('E_MODEL_UNAVAILABLE')
    expect(err.phase).toBe('judge')
  })

  it('model not found → phase fails', async () => {
    runMock.mockImplementation(failWith({ exitCode: 1, stderr: 'model not found: cheap/judge-model', timedOut: false }))
    const err = await runFlip(judge(buildInput({})))
    expect(err.code).toBe('E_MODEL_UNAVAILABLE')
  })
})
