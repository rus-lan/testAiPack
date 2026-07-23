import { vi, describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'

vi.mock('./spawn.js', () => ({
  spawnProcess: vi.fn(),
  execCmd: vi.fn(),
}))

import { spawnProcess, execCmd } from './spawn.js'
import {
  run,
  version,
  exportSession,
  installPlugin,
  listMcp,
  dbQuery,
  OpencodeError,
  buildRunArgs,
} from './cli.js'
import type { SpawnInput, SpawnOutput, ExecOutput } from './spawn.js'

const sp = vi.mocked(spawnProcess)
const ex = vi.mocked(execCmd)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

const okSpawn = (overrides: Partial<SpawnOutput> = {}): SpawnOutput => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  timedOut: false,
  ...overrides,
})

const okExec = (overrides: Partial<ExecOutput> = {}): ExecOutput => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  ...overrides,
})

const baseOpts = {
  homeDir: '/home/test',
  cwd: '/work/app',
  prompt: 'fix the bug',
}

let lastSpawn: SpawnInput | undefined
let lastExec: Parameters<typeof execCmd>[0] | undefined

beforeEach(() => {
  lastSpawn = undefined
  lastExec = undefined
  sp.mockReset()
  ex.mockReset()
  sp.mockImplementation((input) => {
    lastSpawn = input
    return Effect.succeed(okSpawn())
  })
  ex.mockImplementation((input) => {
    lastExec = input
    return Effect.succeed(okExec())
  })
})

describe('opencode cli — buildRunArgs', () => {
  it('emits positional prompt + --format json + --auto by default', () => {
    const args = buildRunArgs({ ...baseOpts })
    expect(args).toEqual(['fix the bug', '--auto', '--format', 'json'])
  })

  it('forwards agent/model/session/--continue/--pure when provided', () => {
    const args = buildRunArgs({
      ...baseOpts,
      agent: 'coder',
      model: 'glm-5.2',
      session: 's1',
      continueSession: true,
      pure: true,
    })
    expect(args).toEqual([
      'fix the bug',
      '--agent', 'coder',
      '--model', 'glm-5.2',
      '--session', 's1',
      '--continue',
      '--auto',
      '--pure',
      '--format', 'json',
    ])
  })

  it('omits --auto when auto:false', () => {
    const args = buildRunArgs({ ...baseOpts, auto: false })
    expect(args).not.toContain('--auto')
  })
})

describe('opencode cli — run', () => {
  it('passes the built command line to the spawner', async () => {
    await runP(run({ ...baseOpts, agent: 'coder', model: 'glm-5.2' }))
    expect(lastSpawn?.command).toBe('opencode')
    expect(lastSpawn?.args).toEqual([
      'fix the bug', '--agent', 'coder', '--model', 'glm-5.2', '--auto', '--format', 'json',
    ])
    expect(lastSpawn?.cwd).toBe('/work/app')
  })

  it('propagates HOME and OPENCODE_CONFIG_CONTENT into the child env', async () => {
    await runP(
      run({ ...baseOpts, configContent: '{"models":{}}', env: { FOO: 'bar' } }),
    )
    expect(lastSpawn?.env['HOME']).toBe('/home/test')
    expect(lastSpawn?.env['OPENCODE_CONFIG_CONTENT']).toBe('{"models":{}}')
    expect(lastSpawn?.env['FOO']).toBe('bar')
  })

  it('forwards timeoutMs to the spawner', async () => {
    await runP(run({ ...baseOpts, timeoutMs: 12345 }))
    expect(lastSpawn?.timeoutMs).toBe(12345)
  })

  it('returns exitCode 0 and timedOut:false on a clean run', async () => {
    const result = await runP(run({ ...baseOpts }))
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBe(5)
  })

  it('raises OpencodeError {timedOut:true, exitCode:null} on timeout', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: null, timedOut: true }))
    })
    const err = await runFlip(run({ ...baseOpts, timeoutMs: 10 }))
    expect(err).toBeInstanceOf(OpencodeError)
    expect(err.timedOut).toBe(true)
    expect(err.exitCode).toBe(null)
    expect(err.command).toBe('run')
  })

  it('raises OpencodeError for a non-zero exit that is not a timeout', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: 2, stderr: 'boom' }))
    })
    const err = await runFlip(run({ ...baseOpts }))
    expect(err).toBeInstanceOf(OpencodeError)
    expect(err.timedOut).toBe(false)
    expect(err.exitCode).toBe(2)
    expect(err.stderr).toBe('boom')
  })

  it('calls onEvent for each JSON line and extracts sessionId from stdout', async () => {
    const events: unknown[] = []
    const sessionLine = '{"type":"session.start","sessionId":"sess-42"}'
    const stepLine = '{"type":"step.finish"}'
    const emitted = [sessionLine, stepLine, 'not-json-line', '']
    sp.mockImplementation((input) => {
      lastSpawn = input
      for (const line of emitted) input.onStdoutLine?.(line)
      return Effect.succeed(okSpawn({ stdout: `${sessionLine}\n${stepLine}\n` }))
    })
    const result = await runP(
      run({ ...baseOpts, onEvent: (e) => events.push(e) }),
    )
    expect(events).toEqual([
      { type: 'session.start', sessionId: 'sess-42' },
      { type: 'step.finish' },
    ])
    expect(result.sessionId).toBe('sess-42')
  })

  it('extracts sessionId from a nested session.id event shape', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(
        okSpawn({ stdout: '{"session":{"id":"sess-nested"}}\n' }),
      )
    })
    const result = await runP(run({ ...baseOpts }))
    expect(result.sessionId).toBe('sess-nested')
  })

  it('returns no sessionId when stdout has no recognizable event', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ stdout: 'plain text\n{}\n' }))
    })
    const result = await runP(run({ ...baseOpts }))
    expect(result.sessionId).toBeUndefined()
  })
})

describe('opencode cli — auxiliary commands', () => {
  it('version parses the version number from `opencode --version`', async () => {
    ex.mockImplementation((input) => {
      lastExec = input
      return Effect.succeed(okExec({ stdout: 'opencode 1.2.3\n' }))
    })
    expect(await runP(version('/h'))).toBe('1.2.3')
    expect(lastExec?.args).toEqual(['--version'])
  })

  it('version raises OpencodeError on non-zero exit', async () => {
    ex.mockImplementation(() =>
      Effect.succeed(okExec({ exitCode: 1, stderr: 'no such command' })),
    )
    const err = await runFlip(version('/h'))
    expect(err).toBeInstanceOf(OpencodeError)
    expect(err.command).toBe('version')
  })

  it('installPlugin calls `opencode plugin <module>`', async () => {
    await runP(installPlugin('/h', 'myplugin'))
    expect(lastExec?.args).toEqual(['plugin', 'myplugin'])
  })

  it('exportSession calls `opencode export <sessionId>` and returns stdout', async () => {
    ex.mockImplementation(() => Effect.succeed(okExec({ stdout: '{"info":{}}' })))
    expect(await runP(exportSession('/h', 'sess-9'))).toBe('{"info":{}}')
  })

  it('listMcp returns the mcp list stdout', async () => {
    ex.mockImplementation(() => Effect.succeed(okExec({ stdout: 'mcpA\nmcpB\n' })))
    expect(await runP(listMcp('/h'))).toBe('mcpA\nmcpB\n')
  })
})

describe('opencode cli — dbQuery', () => {
  it('calls `opencode db query <sql> --format json` in the isolated HOME', async () => {
    ex.mockImplementation((input) => {
      lastExec = input
      return Effect.succeed(okExec({ stdout: '[]' }))
    })
    await runP(dbQuery('/home/iso', 'SELECT id FROM session'))
    expect(lastExec?.command).toBe('opencode')
    expect(lastExec?.args).toEqual(['db', 'query', 'SELECT id FROM session', '--format', 'json'])
    expect(lastExec?.cwd).toBe('/home/iso')
    expect(lastExec?.env['HOME']).toBe('/home/iso')
  })

  it('parses the JSON response into a value', async () => {
    ex.mockImplementation(() =>
      Effect.succeed(okExec({ stdout: '[{"id":"sess-a"},{"id":"sess-b"}]' })),
    )
    expect(await runP(dbQuery('/h', 'SELECT id'))).toEqual([
      { id: 'sess-a' },
      { id: 'sess-b' },
    ])
  })

  it('raises OpencodeError on a non-zero exit', async () => {
    ex.mockImplementation(() =>
      Effect.succeed(okExec({ exitCode: 1, stderr: 'no such table' })),
    )
    const err = await runFlip(dbQuery('/h', 'SELECT 1'))
    expect(err).toBeInstanceOf(OpencodeError)
    expect(err.command).toBe('db')
    expect(err.exitCode).toBe(1)
    expect(err.stderr).toBe('no such table')
  })

  it('raises OpencodeError when stdout is not valid JSON', async () => {
    ex.mockImplementation(() => Effect.succeed(okExec({ stdout: 'not-json' })))
    const err = await runFlip(dbQuery('/h', 'SELECT 1'))
    expect(err).toBeInstanceOf(OpencodeError)
    expect(err.command).toBe('db')
  })
})
