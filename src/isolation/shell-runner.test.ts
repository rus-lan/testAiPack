import { vi, describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'

vi.mock('../opencode/spawn.js', () => ({
  spawnProcess: vi.fn(),
  execCmd: vi.fn(),
}))

import { spawnProcess, execCmd } from '../opencode/spawn.js'
import type { SpawnInput, SpawnOutput } from '../opencode/spawn.js'
import { runShellInHome } from './shell-runner.js'

const sp = vi.mocked(spawnProcess)
const ex = vi.mocked(execCmd)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const okSpawn = (overrides: Partial<SpawnOutput> = {}): SpawnOutput => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 4,
  timedOut: false,
  ...overrides,
})

let lastSpawn: SpawnInput | undefined

beforeEach(() => {
  lastSpawn = undefined
  sp.mockReset()
  ex.mockReset()
  sp.mockImplementation((input) => {
    lastSpawn = input
    return Effect.succeed(okSpawn())
  })
  ex.mockImplementation(() => Effect.succeed({ stdout: '', stderr: '', exitCode: 0 }))
})

describe('shell-runner — runShellInHome (docker mode)', () => {
  it('runs `sh -c <cmd>`, never `sh -lc` — a login shell resets PATH on the real image', async () => {
    await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', { image: 'img:latest' }, 5000))
    const shIdx = lastSpawn?.args.indexOf('sh') ?? -1
    expect(lastSpawn?.args[shIdx + 1]).toBe('-c')
    expect(lastSpawn?.args[shIdx + 2]).toBe('mytool --version')
    expect(lastSpawn?.args).not.toContain('-lc')
  })

  it('passes pathOverride as -e PATH=<value> so the container sees exactly the agent\'s PATH', async () => {
    await runP(
      runShellInHome('mytool --version', '/host/home', '/host/apps', { image: 'img:latest' }, 5000, '/home/opencode/.local/bin:/usr/bin'),
    )
    expect(lastSpawn?.args).toContain('-e')
    expect(lastSpawn?.args).toContain('PATH=/home/opencode/.local/bin:/usr/bin')
  })

  it('omits -e PATH= entirely when pathOverride is undefined — inherits the image default', async () => {
    await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', { image: 'img:latest' }, 5000))
    expect(lastSpawn?.args.some((a) => a.startsWith('PATH='))).toBe(false)
  })

  it('mounts homeDir→/home/opencode and cwd→/workspace, matching the agent\'s own container', async () => {
    await runP(runShellInHome('cmd', '/host/home', '/host/apps', { image: 'img:latest', network: 'none' }, 5000))
    expect(lastSpawn?.args).toContain('/host/apps:/workspace')
    expect(lastSpawn?.args).toContain('/host/home:/home/opencode')
    expect(lastSpawn?.args).toContain('--network')
    expect(lastSpawn?.args).toContain('none')
  })

  it('maps a clean run to {exitCode, durationMs, outputTail, timedOut:false}', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ stdout: 'mytool v1.0.0\n', exitCode: 0, durationMs: 42 }))
    })
    const out = await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', { image: 'img:latest' }, 5000))
    expect(out).toEqual({ exitCode: 0, durationMs: 42, outputTail: 'mytool v1.0.0\n', timedOut: false })
  })

  it('maps a non-zero exit (DockerError, not timed out) to {exitCode, timedOut:false} — never throws, and keeps the real duration instead of reporting 0', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: 127, stderr: 'mytool: not found', durationMs: 356 }))
    })
    const out = await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', { image: 'img:latest' }, 5000))
    expect(out.exitCode).toBe(127)
    expect(out.timedOut).toBe(false)
    expect(out.outputTail).toContain('not found')
    expect(out.durationMs).toBe(356)
  })

  it('maps a timeout to {timedOut:true} — never throws, and reports the real elapsed time, not 0', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: null, timedOut: true, stderr: 'hang', durationMs: 5012 }))
    })
    const out = await runP(runShellInHome('sleep 999', '/host/home', '/host/apps', { image: 'img:latest' }, 50))
    expect(out.timedOut).toBe(true)
    expect(out.durationMs).toBe(5012)
  })
})

describe('shell-runner — runShellInHome (home mode, docker undefined)', () => {
  it('runs `sh -c <cmd>` on the host, never `sh -lc`', async () => {
    await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', undefined, 5000))
    expect(lastSpawn?.command).toBe('sh')
    expect(lastSpawn?.args).toEqual(['-c', 'mytool --version'])
  })

  it('sets HOME=<homeDir> and overrides PATH with pathOverride when given', async () => {
    await runP(
      runShellInHome('mytool --version', '/host/home', '/host/apps', undefined, 5000, '/host/home/.local/bin:/usr/bin'),
    )
    expect(lastSpawn?.env['HOME']).toBe('/host/home')
    expect(lastSpawn?.env['PATH']).toBe('/host/home/.local/bin:/usr/bin')
  })

  it('inherits the real host PATH when pathOverride is undefined', async () => {
    await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', undefined, 5000))
    expect(lastSpawn?.env['PATH']).toBe(process.env['PATH'])
  })

  it('uses cwd as the working dir', async () => {
    await runP(runShellInHome('cmd', '/host/home', '/host/apps', undefined, 5000))
    expect(lastSpawn?.cwd).toBe('/host/apps')
  })

  it('never touches execCmd (docker-only path) in home mode', async () => {
    await runP(runShellInHome('cmd', '/host/home', '/host/apps', undefined, 5000))
    expect(ex).not.toHaveBeenCalled()
  })

  it('reports the real duration on a non-zero exit, same as a clean run — unaffected by the docker error path', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: 127, stderr: 'mytool: not found', durationMs: 356 }))
    })
    const out = await runP(runShellInHome('mytool --version', '/host/home', '/host/apps', undefined, 5000))
    expect(out.exitCode).toBe(127)
    expect(out.timedOut).toBe(false)
    expect(out.durationMs).toBe(356)
  })
})
