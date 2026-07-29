import { vi, describe, it, expect, beforeEach } from 'vitest'
import { Effect } from 'effect'

vi.mock('../opencode/spawn.js', () => ({
  spawnProcess: vi.fn(),
  execCmd: vi.fn(),
}))

import { spawnProcess, execCmd } from '../opencode/spawn.js'
import type { SpawnInput, SpawnOutput, ExecInput, ExecOutput } from '../opencode/spawn.js'
import {
  dockerRun,
  pullImage,
  imageExists,
  ensureImage,
  buildDockerRunArgs,
  DockerError,
  DEFAULT_OPENCODE_IMAGE,
} from './docker-runner.js'

const sp = vi.mocked(spawnProcess)
const ex = vi.mocked(execCmd)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const okSpawn = (overrides: Partial<SpawnOutput> = {}): SpawnOutput => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 4,
  timedOut: false,
  ...overrides,
})

const okExec = (overrides: Partial<ExecOutput> = {}): ExecOutput => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
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
  ex.mockImplementation(() => Effect.succeed(okExec()))
})

const execCalls = (): readonly ExecInput[] =>
  ex.mock.calls.map((c) => c[0])

const baseOpts = {
  image: DEFAULT_OPENCODE_IMAGE,
  cwd: '/host/workspace',
  homeDir: '/host/home',
  command: ['opencode', '--version'],
}

const hostUserFlag = (): string[] =>
  typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${String(process.getuid())}:${String(process.getgid())}`]
    : []

describe('docker-runner — buildDockerRunArgs', () => {
  it('mounts cwd→/workspace and homeDir→/home/opencode, sets -w and HOME', () => {
    const args = buildDockerRunArgs(baseOpts, 'cnt-1')
    expect(args).toEqual([
      'run', '--rm', '--name', 'cnt-1',
      '-v', '/host/workspace:/workspace',
      '-v', '/host/home:/home/opencode',
      '-w', '/workspace',
      '-e', 'HOME=/home/opencode',
      ...hostUserFlag(),
      DEFAULT_OPENCODE_IMAGE,
      'opencode', '--version',
    ])
  })

  it('runs as the host uid:gid so it can write into the bind-mounted, host-owned dirs', () => {
    const args = buildDockerRunArgs(baseOpts, 'cnt-1')
    expect(args).toEqual(expect.arrayContaining(hostUserFlag()))
  })

  it('emits -e K=V for every extra env var (after HOME, before image)', () => {
    const args = buildDockerRunArgs(
      { ...baseOpts, env: { FOO: 'bar', BAZ: 'qux' } },
      'cnt-1',
    )
    const homeIdx = args.indexOf('HOME=/home/opencode')
    const imageIdx = args.indexOf(DEFAULT_OPENCODE_IMAGE)
    expect(args).toContain('-e')
    expect(args).toContain('FOO=bar')
    expect(args).toContain('BAZ=qux')
    const fooIdx = args.indexOf('FOO=bar')
    const bazIdx = args.indexOf('BAZ=qux')
    expect(fooIdx).toBeGreaterThan(homeIdx)
    expect(fooIdx).toBeLessThan(imageIdx)
    expect(bazIdx).toBeGreaterThan(homeIdx)
    expect(bazIdx).toBeLessThan(imageIdx)
  })

  it('omits env flags when no extra env provided', () => {
    const args = buildDockerRunArgs(baseOpts, 'cnt-1')
    expect(args).not.toContain('FOO=bar')
  })

  it('omits --network when unset — byte-identical to the pre-network arg list', () => {
    const args = buildDockerRunArgs(baseOpts, 'cnt-1')
    expect(args).toEqual([
      'run', '--rm', '--name', 'cnt-1',
      '-v', '/host/workspace:/workspace',
      '-v', '/host/home:/home/opencode',
      '-w', '/workspace',
      '-e', 'HOME=/home/opencode',
      ...hostUserFlag(),
      DEFAULT_OPENCODE_IMAGE,
      'opencode', '--version',
    ])
  })

  it('emits --network <mode> right after --name when set', () => {
    const args = buildDockerRunArgs({ ...baseOpts, network: 'host' }, 'cnt-1')
    const nameIdx = args.indexOf('cnt-1')
    expect(args[nameIdx + 1]).toBe('--network')
    expect(args[nameIdx + 2]).toBe('host')
  })
})

describe('docker-runner — dockerRun', () => {
  it('invokes `docker` with the built args and the host cwd', async () => {
    await runP(dockerRun(baseOpts))
    expect(lastSpawn?.command).toBe('docker')
    expect(lastSpawn?.cwd).toBe('/host/workspace')
    expect(lastSpawn?.args).toContain('-v')
    expect(lastSpawn?.args).toContain('/host/workspace:/workspace')
    expect(lastSpawn?.args).toContain('/host/home:/home/opencode')
    expect(lastSpawn?.args).toContain('-w')
    expect(lastSpawn?.args).toContain('/workspace')
    expect(lastSpawn?.args).toContain('HOME=/home/opencode')
    expect(lastSpawn?.args).toContain(DEFAULT_OPENCODE_IMAGE)
    expect(lastSpawn?.args).toContain('opencode')
    expect(lastSpawn?.args).toContain('--version')
    expect(lastSpawn?.args[0]).toBe('run')
    expect(lastSpawn?.args[1]).toBe('--rm')
  })

  it('assigns a --name starting with testaipack- so it can be killed', async () => {
    await runP(dockerRun(baseOpts))
    const nameIdx = lastSpawn?.args.indexOf('--name') ?? -1
    expect(nameIdx).toBeGreaterThanOrEqual(0)
    const name = lastSpawn?.args[nameIdx + 1]
    expect(name).toMatch(/^testaipack-[0-9a-f]+$/)
  })

  it('forwards timeoutMs and onStdoutLine to the spawner', async () => {
    const sink = vi.fn()
    await runP(dockerRun({ ...baseOpts, timeoutMs: 12_000, onStdoutLine: sink }))
    expect(lastSpawn?.timeoutMs).toBe(12_000)
    expect(lastSpawn?.onStdoutLine).toBe(sink)
  })

  it('returns exitCode/stdout/stderr on a clean run', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ stdout: 'opencode 1.2.3\n', exitCode: 0 }))
    })
    const result = await runP(dockerRun(baseOpts))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('opencode 1.2.3\n')
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBe(4)
  })

  it('propagates a non-zero container exit as DockerError', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: 2, stderr: 'boom' }))
    })
    const err = await runFlip(dockerRun(baseOpts))
    expect(err).toBeInstanceOf(DockerError)
    expect(err.command).toBe('run')
    expect(err.exitCode).toBe(2)
    expect(err.stderr).toBe('boom')
    expect(err.timedOut).toBe(false)
  })

  it('on timeout: best-effort docker kill + DockerError {timedOut:true}', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(okSpawn({ exitCode: null, timedOut: true, stderr: 'hang' }))
    })
    const err = await runFlip(dockerRun({ ...baseOpts, timeoutMs: 50 }))
    expect(err).toBeInstanceOf(DockerError)
    expect(err.timedOut).toBe(true)
    expect(err.exitCode).toBe(null)
    // the kill best-effort call ran against the same container name
    const nameIdx = lastSpawn?.args.indexOf('--name') ?? -1
    const containerName = lastSpawn?.args[nameIdx + 1]
    const killCall = execCalls().find((c) => c.args[0] === 'kill')
    expect(killCall).toBeDefined()
    expect(killCall?.args).toEqual(['kill', containerName])
  })

  it('treats a spawn failure (docker binary missing) as DockerError', async () => {
    sp.mockImplementation((input) => {
      lastSpawn = input
      return Effect.succeed(
        okSpawn({ exitCode: null, stderr: 'spawn error: docker: not found', timedOut: false }),
      )
    })
    const err = await runFlip(dockerRun(baseOpts))
    expect(err).toBeInstanceOf(DockerError)
    expect(err.timedOut).toBe(false)
    expect(err.stderr).toContain('not found')
  })
})

describe('docker-runner — imageExists', () => {
  it('inspects the image: exit 0 ⇒ true', async () => {
    ex.mockImplementation(() => Effect.succeed(okExec({ exitCode: 0 })))
    expect(await runP(imageExists(DEFAULT_OPENCODE_IMAGE))).toBe(true)
    expect(execCalls().at(-1)?.args).toEqual([
      'image', 'inspect', DEFAULT_OPENCODE_IMAGE,
    ])
  })

  it('non-zero exit ⇒ false (no throw)', async () => {
    ex.mockImplementation(() => Effect.succeed(okExec({ exitCode: 1, stderr: 'no such image' })))
    expect(await runP(imageExists('opencode/missing:latest'))).toBe(false)
  })
})

describe('docker-runner — pullImage', () => {
  it('runs `docker pull <image>` and succeeds on exit 0', async () => {
    await runP(pullImage(DEFAULT_OPENCODE_IMAGE))
    expect(execCalls().at(-1)?.args).toEqual(['pull', DEFAULT_OPENCODE_IMAGE])
  })

  it('fails with DockerError on non-zero exit', async () => {
    ex.mockImplementation(() => Effect.succeed(okExec({ exitCode: 1, stderr: 'network error' })))
    const err = await runFlip(pullImage(DEFAULT_OPENCODE_IMAGE))
    expect(err).toBeInstanceOf(DockerError)
    expect(err.command).toBe('pull')
    expect(err.exitCode).toBe(1)
    expect(err.timedOut).toBe(false)
  })

  it('fails with DockerError {timedOut} on timeout', async () => {
    ex.mockImplementation(() =>
      Effect.async<ExecOutput>((resume) => {
        const t = setTimeout(() => {
          resume(Effect.succeed(okExec()))
        }, 60_000)
        return Effect.sync(() => {
          clearTimeout(t)
        })
      }),
    )
    const err = await runFlip(pullImage(DEFAULT_OPENCODE_IMAGE, 50))
    expect(err).toBeInstanceOf(DockerError)
    expect(err.timedOut).toBe(true)
    expect(err.command).toBe('pull')
  })
})

describe('docker-runner — ensureImage', () => {
  it('skips pull when the image is already present', async () => {
    ex.mockImplementation((input) =>
      Effect.succeed(okExec({ exitCode: input.args[0] === 'image' ? 0 : 0 })),
    )
    await runP(ensureImage(DEFAULT_OPENCODE_IMAGE))
    const pulled = execCalls().some((c) => c.args[0] === 'pull')
    expect(pulled).toBe(false)
  })

  it('pulls when the image is missing', async () => {
    ex.mockImplementation((input) => {
      // image inspect fails (missing) → triggers pull
      if (input.args[0] === 'image') return Effect.succeed(okExec({ exitCode: 1 }))
      return Effect.succeed(okExec({ exitCode: 0, stdout: 'pulled' }))
    })
    await runP(ensureImage(DEFAULT_OPENCODE_IMAGE))
    const pulled = execCalls().some((c) => c.args[0] === 'pull')
    expect(pulled).toBe(true)
  })

  it('propagates a pull failure', async () => {
    ex.mockImplementation((input) =>
      Effect.succeed(
        okExec({
          exitCode: input.args[0] === 'image' ? 1 : 1,
          stderr: 'manifest unknown',
        }),
      ),
    )
    const err = await runFlip(ensureImage('opencode/missing:latest'))
    expect(err).toBeInstanceOf(DockerError)
    expect(err.command).toBe('pull')
  })
})

describe('docker-runner — exports', () => {
  it('exposes a default local image constant', () => {
    expect(DEFAULT_OPENCODE_IMAGE).toBe('testaipack-opencode:latest')
  })
})
