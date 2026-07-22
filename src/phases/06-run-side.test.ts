import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile } from '../util/fs.js'
import {
  runSide,
  analyzeOutcome,
  executeVerify,
  buildEnvRecord,
  makeSessionId,
  computeMaxConsecutiveSameTool,
  hasRateLimitSignal,
  DOOM_LOOP_THRESHOLD,
} from './06-run-side.js'
import type { AnalyzeInput } from './06-run-side.js'
import type { RunInput, Manifest, WorkspaceTree, EnvVarSet, RunSideInput } from '@generated/types'
import type { OpencodeRunOptions } from '../opencode/cli.js'

vi.mock('../opencode/cli.js', () => ({
  OpencodeError: class extends Error {
    readonly _tag = 'OpencodeError'
    readonly command: string
    readonly exitCode: number | null
    readonly stderr: string
    readonly timedOut: boolean
    constructor(args: {
      command: string
      exitCode: number | null
      stderr: string
      timedOut: boolean
    }) {
      super(`opencode ${args.command} failed`)
      this.command = args.command
      this.exitCode = args.exitCode
      this.stderr = args.stderr
      this.timedOut = args.timedOut
    }
  },
  version: vi.fn(),
  run: vi.fn(),
  installPlugin: vi.fn(),
  exportSession: vi.fn(),
  listMcp: vi.fn(),
}))

vi.mock('../opencode/spawn.js', () => ({
  spawnProcess: vi.fn(),
}))

const { run, exportSession, OpencodeError } = await import('../opencode/cli.js')
const runMock = vi.mocked(run)
const exportMock = vi.mocked(exportSession)
const { spawnProcess } = await import('../opencode/spawn.js')
const spawnMock = vi.mocked(spawnProcess)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseTimeouts = {
  preflightSeconds: 30,
  runSeconds: 60,
  verifySeconds: 60,
  installSeconds: 5,
  watchdogSeconds: 90,
}

const makeRunInput = (overrides: Partial<RunInput>): RunInput => ({
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: true,
    npmrc: false,
    anthropic: false,
    openai: false,
    gemini: false,
    aws: false,
    ssh: false,
    git: false,
  },
  pureBaseline: true,
  preflightEnabled: false,
  formats: ['md'],
  outputPath: '/out',
  diffHtml: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: baseTimeouts,
  workspacePath: '/ws',
  logLevel: 'info',
  ...overrides,
})

const fakeManifest: Manifest = {
  runId: 'rid-abc',
  timestamp: new Date().toISOString(),
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

const buildWorkspace = (root: string): WorkspaceTree => ({
  root,
  appsSource: path.join(root, 'apps', 'source'),
  appsOld: [path.join(root, 'apps', 'oldVersion', 'run-1')],
  appsNew: [path.join(root, 'apps', 'newVersion', 'run-1')],
  pack: path.join(root, 'pack'),
  homeOld: [path.join(root, 'home', 'old', 'run-1')],
  homeNew: [path.join(root, 'home', 'new', 'run-1')],
  config: path.join(root, 'config'),
  results: path.join(root, 'results'),
  raw: path.join(root, 'results', 'raw'),
  diff: path.join(root, 'results', 'diff'),
})

const buildHomeEnv = (homeDir: string, side: 'old' | 'new'): EnvVarSet => ({
  HOME: homeDir,
  OPENCODE_DISABLE_PROJECT_CONFIG: true,
  OPENCODE_DISABLE_DEFAULT_PLUGINS: side === 'old',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: side === 'old',
  OPENCODE_PURE: side === 'old',
  OPENCODE_CONFIG_CONTENT: '{"$schema":"https://opencode.ai/config.json"}',
})

const validExport = (): string =>
  JSON.stringify({
    info: {
      id: 'sess-1',
      slug: 's1',
      projectID: 'p1',
      directory: '/app',
      title: 't',
      agent: 'build',
      model: { id: 'm1', providerID: 'anthropic' },
      version: '1.0.0',
      summary: { additions: 0, deletions: 0, files: 0 },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: '0', updated: '0' },
    },
    messages: [],
  })

const ev = (type: string, extra: Record<string, unknown> = {}): unknown => ({
  type,
  id: Math.random().toString(36).slice(2),
  ...extra,
})

const stepFinish = (reason: string): unknown => ev('step-finish', { reason })
const tool = (name: string): unknown => ev('tool', { tool: name, callID: 'c', state: { status: 'completed', input: {} } })

const buildInput = (
  root: string,
  overrides: { runInput?: Partial<RunInput>; sessionId?: string; side?: 'old' | 'new' } = {},
): RunSideInput => {
  const ws = buildWorkspace(root)
  const side = overrides.side ?? 'old'
  return {
    runInput: makeRunInput(overrides.runInput ?? {}),
    manifest: fakeManifest,
    workspace: ws,
    homeEnv: buildHomeEnv(path.join(root, 'home', side, 'run-1'), side),
    side,
    runIndex: 1,
    sessionId: overrides.sessionId ?? 'rid-abc-old-1-deadbe',
  }
}

const okRun = (events: readonly unknown[] = [stepFinish('stop')]) =>
  Effect.gen(function* () {
    for (const e of events) {
      void e
    }
  })

// A run mock that emits the given events then succeeds.
const emitThenSucceed = (events: readonly unknown[]) =>
  (opts: { onEvent?: (e: unknown) => void }) =>
    Effect.sync(() => {
      for (const e of events) opts.onEvent?.(e)
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }
    })

describe('phase 06 — run-side', () => {
  beforeEach(() => {
    runMock.mockReset()
    exportMock.mockReset()
    spawnMock.mockReset()
    runMock.mockImplementation(emitThenSucceed([stepFinish('stop')]))
    exportMock.mockImplementation(() => Effect.succeed(validExport()))
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }),
    )
    void okRun
  })

  // -------------------------------------------------------------------------
  // happy paths
  // -------------------------------------------------------------------------

  it('happy-path: init + prompt + verify all succeed → rank 4, finish stop, verifyExitCode 0', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const input = buildInput(root, {
      runInput: { init: 'setup first', verify: 'npm test' },
    })
    const result = await runP(runSide(input))
    expect(result.successRank).toBe(4)
    expect(result.finishCause).toBe('stop')
    expect(result.exitCode).toBe(0)
    expect(result.verifyExitCode).toBe(0)
    expect(result.watchdogTriggered).toBe(false)
    expect(result.side).toBe('old')
    expect(result.runIndex).toBe(1)
  })

  it('without init (prompt only) → rank 4, run called once', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(4)
    expect(runMock).toHaveBeenCalledTimes(1)
  })

  it('without verify → verifyExitCode is undefined', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const result = await runP(runSide(buildInput(root)))
    expect(result.verifyExitCode).toBeUndefined()
  })

  it('tool-calls finish → rank 3', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    runMock.mockImplementation(
      emitThenSucceed([stepFinish('tool_use')]),
    )
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(3)
    expect(result.finishCause).toBe('tool-calls')
  })

  // -------------------------------------------------------------------------
  // crash / timeout / hang
  // -------------------------------------------------------------------------

  it('crash opencode (exit 1) → rank 0, finish error, phase OK, export still written', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    runMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({ command: 'run', exitCode: 1, stderr: 'boom', timedOut: false }),
      ),
    )
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(0)
    expect(result.finishCause).toBe('error')
    expect(result.exitCode).toBe(1)
    // export.json still written despite crash
    const exported = await runP(readFile(result.exportPath))
    expect(exported).toBe(validExport())
  })

  it('hang (watchdog) → watchdogTriggered true, rank 1, finish tool-calls', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    // mock run sleeps a long time without emitting any event
    runMock.mockImplementation(
      () =>
        Effect.gen(function* () {
          yield* Effect.sleep(2000)
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }
        }),
    )
    const input = buildInput(root, {
      runInput: { timeouts: { ...baseTimeouts, watchdogSeconds: 0.1, runSeconds: 600 } },
    })
    const result = await runP(runSide(input))
    expect(result.watchdogTriggered).toBe(true)
    expect(result.successRank).toBe(1)
    expect(result.finishCause).toBe('tool-calls')
  })

  it('hard run timeout → timedOut, rank 0, finish error', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    runMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({ command: 'run', exitCode: null, stderr: '', timedOut: true }),
      ),
    )
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(0)
    expect(result.finishCause).toBe('error')
  })

  it('total timeout (totalSeconds exhausted) → rank 0, finish error', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    // mock run hangs long enough for the (tiny) total deadline to fire first
    runMock.mockImplementation(
      () =>
        Effect.gen(function* () {
          yield* Effect.sleep(500)
          return { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }
        }),
    )
    const input = buildInput(root, {
      runInput: {
        init: 'setup',
        timeouts: { ...baseTimeouts, totalSeconds: 0.05, runSeconds: 600, watchdogSeconds: 90 },
      },
    })
    const result = await runP(runSide(input))
    expect(result.successRank).toBe(0)
    expect(result.finishCause).toBe('error')
    expect(result.watchdogTriggered).toBe(false)
  })

  it('context-overflow (finish length) → rank 2, finish length', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    runMock.mockImplementation(
      emitThenSucceed([stepFinish('max_tokens')]),
    )
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(2)
    expect(result.finishCause).toBe('length')
  })

  it('rate-limit exhausted (429 in events) → rank 0, finish error', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    runMock.mockImplementation(
      emitThenSucceed([
        ev('text', { text: 'HTTP 429 Too Many Requests' }),
        stepFinish('error'),
      ]),
    )
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(0)
    expect(result.finishCause).toBe('error')
  })

  it('doom-loop (same tool × 20, no clean finish) → rank 1', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const tools = Array.from({ length: 20 }, () => tool('bash'))
    runMock.mockImplementation(emitThenSucceed(tools))
    const result = await runP(runSide(buildInput(root)))
    expect(result.successRank).toBe(1)
    expect(result.finishCause).toBe('tool-calls')
  })

  // -------------------------------------------------------------------------
  // verify outcomes
  // -------------------------------------------------------------------------

  it('verify non-zero exit → verifyExitCode = N, phase OK', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: 2, durationMs: 1, timedOut: false }),
    )
    const input = buildInput(root, { runInput: { verify: 'npm test' } })
    const result = await runP(runSide(input))
    expect(result.verifyExitCode).toBe(2)
    expect(result.successRank).toBe(4)
  })

  it('verify timeout → verifyExitCode undefined, phase OK', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: null, durationMs: 1, timedOut: true }),
    )
    const input = buildInput(root, { runInput: { verify: 'npm test' } })
    const result = await runP(runSide(input))
    expect(result.verifyExitCode).toBeUndefined()
    // run itself succeeded, so rank stays based on run outcome
    expect(result.successRank).toBe(4)
  })

  // -------------------------------------------------------------------------
  // phase-level failures
  // -------------------------------------------------------------------------

  it('export.json not written (exportSession fails) → E_RUN_CRASH', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    exportMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({ command: 'export', exitCode: 1, stderr: 'no session', timedOut: false }),
      ),
    )
    const err = await runFlip(runSide(buildInput(root)))
    expect(err.code).toBe('E_RUN_CRASH')
    expect(err.phase).toBe('run-side')
  })

  it('export.json invalid (schema mismatch) → E_EXPORT_INVALID', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    exportMock.mockImplementation(() => Effect.succeed('{"not":"valid export"}'))
    const err = await runFlip(runSide(buildInput(root)))
    expect(err.code).toBe('E_EXPORT_INVALID')
  })

  it('missing app cwd → E_RUN_CRASH', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const input = buildInput(root)
    // wipe appsOld so the run-1 entry is absent
    const ws: WorkspaceTree = { ...input.workspace, appsOld: [], appsNew: [] }
    const err = await runFlip(runSide({ ...input, workspace: ws }))
    expect(err.code).toBe('E_RUN_CRASH')
  })

  // -------------------------------------------------------------------------
  // sessionId
  // -------------------------------------------------------------------------

  it('sessionId passed → used as-is in opencode.run and export', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const sid = 'my-explicit-session-42'
    await runP(runSide(buildInput(root, { sessionId: sid })))
    expect(runMock.mock.calls[0]?.[0]?.session).toBe(sid)
    expect(exportMock.mock.calls[0]?.[1]).toBe(sid)
  })

  it('sessionId empty → generated as <runId>-<side>-<runIndex>-<rand6hex>', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    await runP(runSide(buildInput(root, { sessionId: '' })))
    const sid = runMock.mock.calls[0]?.[0]?.session as string
    expect(sid).toMatch(/^rid-abc-old-1-[0-9a-f]{6,}$/)
  })

  // -------------------------------------------------------------------------
  // env propagation / file outputs
  // -------------------------------------------------------------------------

  it('env vars propagated to opencode.run (HOME, OPENCODE_*, config, agent, auto)', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const input = buildInput(root, { side: 'old' })
    const calls: OpencodeRunOptions[] = []
    runMock.mockImplementation((opts: OpencodeRunOptions) =>
      Effect.sync(() => {
        calls.push(opts)
        opts.onEvent?.(stepFinish('stop'))
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false }
      }),
    )
    await runP(runSide(input))
    expect(calls[0]?.homeDir).toBe(input.homeEnv.HOME)
    expect(calls[0]?.agent).toBe('build')
    expect(calls[0]?.auto).toBe(true)
    expect(calls[0]?.pure).toBe(true)
    expect(calls[0]?.configContent).toBe(input.homeEnv.OPENCODE_CONFIG_CONTENT)
    expect(calls[0]?.env?.['OPENCODE_PURE']).toBe('1')
    expect(calls[0]?.env?.['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1')
    expect(calls[0]?.env?.['OPENCODE_DISABLE_DEFAULT_PLUGINS']).toBe('1')
  })

  it('new side → OPENCODE_PURE disabled (0) and pure flag absent', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const input = buildInput(root, { side: 'new' })
    const calls: OpencodeRunOptions[] = []
    runMock.mockImplementation((opts: OpencodeRunOptions) =>
      Effect.sync(() => {
        calls.push(opts)
        opts.onEvent?.(stepFinish('stop'))
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false }
      }),
    )
    await runP(runSide(input))
    expect(calls[0]?.env?.['OPENCODE_PURE']).toBe('0')
    expect(calls[0]?.env?.['OPENCODE_DISABLE_DEFAULT_PLUGINS']).toBe('0')
    expect(calls[0]?.pure).toBeUndefined()
  })

  it('events.ndjson is written with one JSON object per line', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    runMock.mockImplementation(
      emitThenSucceed([stepFinish('stop'), tool('bash'), ev('text', { text: 'hi' })]),
    )
    const result = await runP(runSide(buildInput(root)))
    const raw = await runP(readFile(result.eventsLogPath))
    const lines = raw.split('\n').filter((l) => l !== '')
    expect(lines.length).toBe(3)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type: string }
      expect(typeof parsed.type).toBe('string')
    }
  })

  it('log file is written with START / PROMPT / STOP markers', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const result = await runP(runSide(buildInput(root)))
    const log = await runP(readFile(path.join(path.dirname(result.eventsLogPath), 'run-1.log')))
    expect(log).toContain('[START]')
    expect(log).toContain('[PROMPT]')
    expect(log).toContain('[STOP]')
    expect(log).toContain('finish=stop')
  })

  it('init + prompt → run called twice, second with continueSession=true', async () => {
    const root = makeTempDir()
    await runP(ensureDir(path.join(root, 'results', 'raw')))
    const calls: OpencodeRunOptions[] = []
    runMock.mockImplementation((opts: OpencodeRunOptions) =>
      Effect.sync(() => {
        calls.push(opts)
        opts.onEvent?.(stepFinish('stop'))
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 5, timedOut: false }
      }),
    )
    await runP(
      runSide(buildInput(root, { runInput: { init: 'do setup', prompt: 'do real work' } })),
    )
    expect(calls.length).toBe(2)
    expect(calls[0]?.continueSession).toBe(false)
    expect(calls[0]?.prompt).toBe('do setup')
    expect(calls[1]?.continueSession).toBe(true)
    expect(calls[1]?.prompt).toBe('do real work')
    expect(calls[1]?.session).toBe(calls[0]?.session)
  })

  // -------------------------------------------------------------------------
  // analyzeOutcome tabular tests
  // -------------------------------------------------------------------------

  const cases: readonly {
    readonly name: string
    readonly input: AnalyzeInput
    readonly rank: number
    readonly finish: string
  }[] = [
    {
      name: 'clean stop → 4',
      input: { events: [stepFinish('stop')], exitCode: 0, timedOut: false, watchdogTriggered: false, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 4,
      finish: 'stop',
    },
    {
      name: 'export-message info.finish=stop → 4',
      input: {
        events: [ev('message', { info: { finish: 'stop', role: 'assistant', time: { created: '0' } } })],
        exitCode: 0,
        timedOut: false,
        watchdogTriggered: false,
        doomLoopThreshold: DOOM_LOOP_THRESHOLD,
      },
      rank: 4,
      finish: 'stop',
    },
    {
      name: 'tool-calls → 3',
      input: { events: [stepFinish('tool_use')], exitCode: 0, timedOut: false, watchdogTriggered: false, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 3,
      finish: 'tool-calls',
    },
    {
      name: 'length → 2',
      input: { events: [stepFinish('max_tokens')], exitCode: 0, timedOut: false, watchdogTriggered: false, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 2,
      finish: 'length',
    },
    {
      name: 'doom-loop (consec tool > threshold) → 1',
      input: {
        events: Array.from({ length: 15 }, () => tool('bash')),
        exitCode: 0,
        timedOut: false,
        watchdogTriggered: false,
        doomLoopThreshold: 10,
      },
      rank: 1,
      finish: 'tool-calls',
    },
    {
      name: 'crash (non-zero exit) → 0',
      input: { events: [], exitCode: 1, timedOut: false, watchdogTriggered: false, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 0,
      finish: 'error',
    },
    {
      name: 'hard timeout → 0',
      input: { events: [stepFinish('stop')], exitCode: 0, timedOut: true, watchdogTriggered: false, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 0,
      finish: 'error',
    },
    {
      name: 'watchdog → 1',
      input: { events: [], exitCode: 0, timedOut: false, watchdogTriggered: true, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 1,
      finish: 'tool-calls',
    },
    {
      name: 'rate-limit (429) → 0',
      input: {
        events: [ev('text', { text: '429 too many requests' })],
        exitCode: 0,
        timedOut: false,
        watchdogTriggered: false,
        doomLoopThreshold: DOOM_LOOP_THRESHOLD,
      },
      rank: 0,
      finish: 'error',
    },
    {
      name: 'exit 0 but no finish signal → 0 (other)',
      input: { events: [], exitCode: 0, timedOut: false, watchdogTriggered: false, doomLoopThreshold: DOOM_LOOP_THRESHOLD },
      rank: 0,
      finish: 'other',
    },
    {
      name: 'stop beats doom-loop (high consec tool but clean stop) → 4',
      input: {
        events: [...Array.from({ length: 15 }, () => tool('bash')), stepFinish('stop')],
        exitCode: 0,
        timedOut: false,
        watchdogTriggered: false,
        doomLoopThreshold: 10,
      },
      rank: 4,
      finish: 'stop',
    },
  ]

  for (const c of cases) {
    it(`analyzeOutcome: ${c.name}`, () => {
      const out = analyzeOutcome(c.input)
      expect(out.rank).toBe(c.rank)
      expect(out.finish).toBe(c.finish)
    })
  }

  // -------------------------------------------------------------------------
  // pure helper units
  // -------------------------------------------------------------------------

  it('computeMaxConsecutiveSameTool counts longest run of identical tools', () => {
    expect(
      computeMaxConsecutiveSameTool([tool('a'), tool('a'), tool('b'), tool('a'), tool('a'), tool('a')]),
    ).toBe(3)
    expect(computeMaxConsecutiveSameTool([])).toBe(0)
    expect(computeMaxConsecutiveSameTool([ev('text', { text: 'x' })])).toBe(0)
  })

  it('hasRateLimitSignal detects 429 / rate-limit wording, ignores clean events', () => {
    expect(hasRateLimitSignal([ev('text', { text: 'rate limit exceeded' })])).toBe(true)
    expect(hasRateLimitSignal([ev('text', { text: 'too many requests' })])).toBe(true)
    expect(hasRateLimitSignal([stepFinish('stop')])).toBe(false)
  })

  it('hasRateLimitSignal does not throw on non-JSON-safe (circular) events', () => {
    const circular: Record<string, unknown> = { type: 'text' }
    circular['self'] = circular
    expect(hasRateLimitSignal([circular])).toBe(false)
  })

  it('makeSessionId format: <runId>-<side>-<runIndex>-<hex>', () => {
    const sid = makeSessionId('run42', 'new', 3)
    expect(sid).toMatch(/^run42-new-3-[0-9a-f]+$/)
  })

  it('buildEnvRecord maps booleans to 1/0', () => {
    const env = buildEnvRecord({
      HOME: '/h',
      OPENCODE_DISABLE_PROJECT_CONFIG: true,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: false,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: true,
      OPENCODE_PURE: false,
    })
    expect(env).toEqual({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '0',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_PURE: '0',
    })
  })

  // -------------------------------------------------------------------------
  // executeVerify direct tests
  // -------------------------------------------------------------------------

  it('executeVerify returns exitCode from spawn', async () => {
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: 7, durationMs: 1, timedOut: false }),
    )
    const r = await runP(executeVerify('npm test', '/cwd', 30))
    expect(r.exitCode).toBe(7)
    expect(r.timedOut).toBe(false)
    expect(spawnMock.mock.calls[0]?.[0]?.command).toBe('sh')
    expect(spawnMock.mock.calls[0]?.[0]?.args).toEqual(['-c', 'npm test'])
    expect(spawnMock.mock.calls[0]?.[0]?.cwd).toBe('/cwd')
  })

  it('executeVerify surfaces timeout from spawn', async () => {
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: null, durationMs: 1, timedOut: true }),
    )
    const r = await runP(executeVerify('npm test', '/cwd', 1))
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeNull()
  })
})
