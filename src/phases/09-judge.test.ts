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
} from './09-judge.js'
import type { JudgeSideDiff } from './09-judge.js'
import { makeTempDir } from '../../tests/setup.js'
import { readFile, writeFile, ensureDir, removeDir } from '../util/fs.js'
import { judgeResultSchema } from '@generated/schemas'
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

// ---------------------------------------------------------------------------
// Real judge.log fixture — captured verbatim from a real run
// (2026-07-30_14-05-58_b7d56c, model ollama/qwen3.5-9b-32k) where the model
// returned a substantive, well-formed verdict that the parser nonetheless
// discarded as "Failed to parse judge response". Loaded from disk rather
// than retyped inline: the model's response text is Cyrillic with JSON
// escapes, and the whole point of this fixture is byte fidelity, not a
// hand-typed approximation of it.
// ---------------------------------------------------------------------------

const REAL_JUDGE_LOG = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'judge-real-response.txt'),
  'utf8',
)

/** The `--- stdout ---` section of the fixture — what opencode's `run()` would have returned as `stdout`. */
const REAL_JUDGE_STDOUT = (() => {
  const m = /--- stdout ---\n([\s\S]*?)\n\n--- stderr ---/.exec(REAL_JUDGE_LOG)
  if (m === null || m[1] === undefined) throw new Error('judge-real-response fixture format changed — could not extract stdout section')
  return m[1]
})()

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
  protectGit: false,
  allowBaselineTool: false,
  initSide: 'both',
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

/**
 * The shape opencode actually streams per NDJSON line — `text` sits under a
 * singular `part` object, not directly on the event and not under a `parts`
 * array. This is what `judge-real-response.txt` contains; `textEvent` above
 * (flat `{ type: "text", text }`) is a shape the old parser also accepted,
 * but it is not what a real run produces.
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
  runMock.mockImplementation(succeedWith(textEvent('{"verdict":"ok","oldQuality":5,"newQuality":8,"explanation":"new is better"}')))
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
  { name: 'quality out of range high', raw: '{"verdict":"ok","oldQuality":15,"newQuality":5,"explanation":"x"}', expect: { verdict: 'ok', oldQuality: 10, newQuality: 5, explanation: 'x' } },
  { name: 'quality out of range low', raw: '{"verdict":"ok","oldQuality":-1,"newQuality":5,"explanation":"x"}', expect: { verdict: 'ok', oldQuality: 0, newQuality: 5, explanation: 'x' } },
  { name: 'quality clamps both extremes', raw: '{"verdict":"ok","oldQuality":-5,"newQuality":42,"explanation":"x"}', expect: { verdict: 'ok', oldQuality: 0, newQuality: 10, explanation: 'x' } },
  { name: 'quality fractional is accepted and rounded', raw: '{"verdict":"ok","oldQuality":5.5,"newQuality":8.4,"explanation":"x"}', expect: { verdict: 'ok', oldQuality: 6, newQuality: 8, explanation: 'x' } },
  { name: 'quality not a number', raw: '{"verdict":"ok","oldQuality":"5","newQuality":5,"explanation":"x"}', expect: null },
  { name: 'explanation not string', raw: '{"verdict":"ok","oldQuality":5,"newQuality":5,"explanation":42}', expect: null },
  { name: 'not an object', raw: '[1,2,3]', expect: null },
  {
    name: 'trailing explanation after fenced JSON, with a stray closing brace in the prose',
    raw: '```json\n{"verdict":"ok","oldQuality":5,"newQuality":5,"explanation":"x"}\n```\nHope that helps! :}',
    expect: { verdict: 'ok', oldQuality: 5, newQuality: 5, explanation: 'x' },
  },
  {
    name: 'trailing explanation after bare JSON (no fence), with a stray closing brace in the prose',
    raw: '{"verdict":"ok","oldQuality":6,"newQuality":6,"explanation":"see {a:1} above"}\np.s. thanks for reading :}',
    expect: { verdict: 'ok', oldQuality: 6, newQuality: 6, explanation: 'see {a:1} above' },
  },
  {
    name: 'different key casing (Verdict/OldQuality/NewQuality/Explanation)',
    raw: '{"Verdict":"fail","OldQuality":8,"NewQuality":2,"Explanation":"regressed"}',
    expect: { verdict: 'fail', oldQuality: 8, newQuality: 2, explanation: 'regressed' },
  },
  {
    name: 'SCREAMING key casing',
    raw: '{"VERDICT":"ok","OLDQUALITY":4,"NEWQUALITY":9,"EXPLANATION":"caps"}',
    expect: { verdict: 'ok', oldQuality: 4, newQuality: 9, explanation: 'caps' },
  },
  {
    name: 'Russian text in explanation, no fence',
    raw: '{"verdict":"unclear","oldQuality":5,"newQuality":8,"explanation":"Файл report.md недоступен для анализа"}',
    expect: { verdict: 'unclear', oldQuality: 5, newQuality: 8, explanation: 'Файл report.md недоступен для анализа' },
  },
]

describe('parseJudgeResponse — tabular', () => {
  for (const c of PARSE_CASES) {
    it(`${c.name} → ${c.expect === null ? 'null' : c.expect.verdict}`, () => {
      expect(parseJudgeResponse(c.raw)).toEqual(c.expect)
    })
  }
})

describe('parseJudgeResponse — real qwen3.5-9b-32k response (judge-real-response.txt fixture)', () => {
  it('parses the fenced JSON out of the real transcript into the verdict the model actually gave', () => {
    const text = extractAssistantText(REAL_JUDGE_STDOUT)
    const parsed = parseJudgeResponse(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.verdict).toBe('unclear')
    expect(parsed?.oldQuality).toBe(5)
    expect(parsed?.newQuality).toBe(8)
    expect(parsed?.explanation).toContain('Файл report.md недоступен')
    expect(parsed?.explanation).toContain('CHPU')
  })
})

// ---------------------------------------------------------------------------
// buildJudgePrompt — pure
// ---------------------------------------------------------------------------

const sideDiff = (patch: string, summary = ''): JudgeSideDiff => ({ patch, summary })

describe('buildJudgePrompt', () => {
  it('contains task prompt, pack ref, both patches, judge instruction and JSON schema', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, sideDiff('OLDPATCH'), sideDiff('NEWPATCH'))
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
    const prompt = buildJudgePrompt(runInput, sideDiff('a'), sideDiff('b'))
    expect(prompt).toContain('with pack: n/a')
  })

  it('redacts an inline mcp: packRef instead of sending its secret config to the judge model', () => {
    const dangerousPackRef = 'mcp:myserver:{"env":{"API_KEY":"sk-secret-12345"}}'
    const runInput = makeRunInput({ packRef: dangerousPackRef })
    const prompt = buildJudgePrompt(runInput, sideDiff('a'), sideDiff('b'))
    expect(prompt).not.toContain('sk-secret-12345')
    expect(prompt).not.toContain('API_KEY')
    expect(prompt).not.toContain('{"env"')
    expect(prompt).toContain('with pack: mcp:myserver')
  })

  it('truncates patches larger than 100KB to 50KB with a notice', () => {
    const runInput = makeRunInput({})
    const big = 'X'.repeat(200_000)
    const prompt = buildJudgePrompt(runInput, sideDiff(big), sideDiff('NEWPATCH'))
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
    const prompt = buildJudgePrompt(runInput, sideDiff(exact), sideDiff('n'))
    expect(prompt).not.toContain('[truncated')
  })

  it('embeds the per-side run summary alongside the representative patch', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(
      runInput,
      sideDiff('OLDPATCH', 'run-1: 2 file(s), +5/-1'),
      sideDiff('NEWPATCH', 'run-1: 3 file(s), +9/-2'),
    )
    expect(prompt).toContain('run-1: 2 file(s), +5/-1')
    expect(prompt).toContain('run-1: 3 file(s), +9/-2')
  })

  it('states plainly that the judge has no file-system access', () => {
    const runInput = makeRunInput({})
    const prompt = buildJudgePrompt(runInput, sideDiff('a'), sideDiff('b'))
    expect(prompt.toLowerCase()).toContain('no file-system access')
    expect(prompt).toContain('report.md/json/html')
  })

  it('adds an explicit note when the judge instruction names a report file the judge cannot read', () => {
    const runInput = makeRunInput({ judge: 'Analyse the report from report.md and decide.' })
    const prompt = buildJudgePrompt(runInput, sideDiff('a'), sideDiff('b'))
    expect(prompt).toContain('<note>')
    expect(prompt).toContain('report file was not available')
  })

  it('does not add the report-file note for an instruction that never mentions one', () => {
    const runInput = makeRunInput({ judge: 'Judge which side is better.' })
    const prompt = buildJudgePrompt(runInput, sideDiff('a'), sideDiff('b'))
    expect(prompt).not.toContain('<note>')
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
      side: 'old',
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
      side: 'new',
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
      side: 'new',
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
      side: 'old',
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
    expect(j.ran).toBe(true)
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
    const scratchDir = path.join(os.tmpdir(), 'testaipack-judge', runId)
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
      await runP(removeDir(scratchDir))
    }
  })

  it('cleans up the scratch dir even when the judge call is interrupted mid-run', async () => {
    const runId = 'rid-judge-interrupted'
    const scratchDir = path.join(os.tmpdir(), 'testaipack-judge', runId)
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
    expect(j.oldQuality).toBe(0)
    expect(j.newQuality).toBe(0)
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
    expect(j.oldQuality).toBe(5)
    expect(j.newQuality).toBe(8)
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
      succeedWith(textEvent('{"verdict":"ok","oldQuality":7,"newQuality":9,"explanation":"new wins"}')),
    )
    const input = buildInput({})
    const result = await runP(judge(input))
    const judgeJsonPath = `${input.runInput.outputPath}/judge.json`
    expect(existsSync(judgeJsonPath)).toBe(true)
    const onDisk = JSON.parse(await runP(readFile(judgeJsonPath))) as { judge: JudgeResult | null }
    expect(onDisk.judge).not.toBeNull()
    expect((onDisk.judge as JudgeResult).verdict).toBe('ok')
    expect((onDisk.judge as JudgeResult).newQuality).toBe(9)
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
    const stdout = textEvent('{"verdict":"ok","oldQuality":7,"newQuality":9,"explanation":"new wins"}')
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

describe('judgeResultSchema — back-compat round-trip', () => {
  it('parses an old judge.json shape that has no ran field', () => {
    const old = {
      verdict: 'ok',
      oldQuality: 7,
      newQuality: 8,
      explanation: 'new is better',
      modelUsed: 'gpt-test',
      timestamp: '2025-01-01T00:00:00.000Z',
    }
    const parsed = judgeResultSchema.safeParse(old)
    expect(parsed.success).toBe(true)
  })

  it('parses a new judge.json shape that has ran: false', () => {
    const fresh = {
      verdict: 'unclear',
      oldQuality: 0,
      newQuality: 0,
      explanation: 'judge model unavailable',
      modelUsed: '',
      timestamp: '2025-01-01T00:00:00.000Z',
      ran: false,
    }
    const parsed = judgeResultSchema.safeParse(fresh)
    expect(parsed.success).toBe(true)
  })
})
