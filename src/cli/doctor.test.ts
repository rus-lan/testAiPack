import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import type { ExecOutput } from '../opencode/spawn.js'
import { runDoctor, hasCriticalFailure } from './doctor.js'

vi.mock('../opencode/spawn.js', () => ({
  execCmd: vi.fn(),
}))

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, exists: vi.fn(actual.exists) }
})

const { execCmd } = await import('../opencode/spawn.js')
const execMock = vi.mocked(execCmd)
const { exists } = await import('../util/fs.js')
const existsMock = vi.mocked(exists)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const out = (stdout: string, exitCode = 0): Effect.Effect<ExecOutput> =>
  Effect.succeed({ stdout, stderr: '', exitCode })

describe('cli/doctor — runDoctor', () => {
  beforeEach(() => {
    execMock.mockReset()
    existsMock.mockReset()
  })

  it('all probes ok → statuses ok, no critical failure', async () => {
    execMock.mockImplementation((input) =>
      out(input.command === 'git' ? 'git version 2.43' : `${input.command} 1.0`),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const names = checks.map((c) => c.name)
    expect(names).toContain('opencode')
    expect(names).toContain('git')
    expect(names).toContain('node')
    expect(names).toContain('bun')
    expect(names).toContain('docker')
    expect(checks.find((c) => c.name === 'bun')?.status).toBe('ok')
    expect(hasCriticalFailure(checks)).toBe(false)
  })

  it('bun missing (ENOENT) → warn, not fail, and not critical', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: '',
        exitCode: input.command === 'bun' ? -1 : 0,
        ...(input.command === 'bun' ? { spawnErrorCode: 'ENOENT' } : {}),
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const bun = checks.find((c) => c.name === 'bun')
    expect(bun?.status).toBe('warn')
    expect(bun?.detail).toContain('only to build it from source')
    expect(hasCriticalFailure(checks)).toBe(false)
  })

  it('bun non-zero exit → still warn, not fail', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: '',
        exitCode: input.command === 'bun' ? 1 : 0,
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const bun = checks.find((c) => c.name === 'bun')
    expect(bun?.status).toBe('warn')
  })

  it('docker info returns multi-line output → detail is the first line only', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout:
          input.command === 'docker'
            ? 'Client:\n Version:    29.6.2\n Context:    default\n Debug Mode: false\n'
            : `${input.command} 1.0`,
        stderr: '',
        exitCode: 0,
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const docker = checks.find((c) => c.name === 'docker')
    expect(docker?.status).toBe('ok')
    expect(docker?.detail).toBe('Client:')
    expect(docker?.detail).not.toContain('\n')
  })

  it('opencode missing (ENOENT, exit < 0) → fail "not found" + critical', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: 'not found',
        exitCode: input.command === 'opencode' ? -1 : 0,
        ...(input.command === 'opencode' ? { spawnErrorCode: 'ENOENT' } : {}),
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const oc = checks.find((c) => c.name === 'opencode')
    expect(oc?.status).toBe('fail')
    expect(oc?.detail).toContain('not found')
    expect(hasCriticalFailure(checks)).toBe(true)
  })

  it('opencode exits < 0 for a reason other than ENOENT → fail, but not reported as "not found"', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: '',
        exitCode: input.command === 'opencode' ? -1 : 0,
        ...(input.command === 'opencode' ? { spawnErrorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } : {}),
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const oc = checks.find((c) => c.name === 'opencode')
    expect(oc?.status).toBe('fail')
    expect(oc?.detail).not.toContain('not found')
    expect(oc?.detail).toContain('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
  })

  it('opencode non-zero exit → fail with exit code detail', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: input.command === 'opencode' ? '' : '',
        exitCode: input.command === 'opencode' ? 2 : 0,
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const oc = checks.find((c) => c.name === 'opencode')
    expect(oc?.status).toBe('fail')
    expect(oc?.detail).toContain('exit 2')
  })

  it('git fails → critical', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: 'no git',
        exitCode: input.command === 'git' ? -1 : 0,
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    expect(hasCriticalFailure(checks)).toBe(true)
  })

  it('node fails (non-critical) → not critical', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: '',
        exitCode: input.command === 'node' ? -1 : 0,
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    expect(hasCriticalFailure(checks)).toBe(false)
  })

  it('auth dir missing → warn status', async () => {
    execMock.mockImplementation((input) => out(`${input.command} 1.0`))
    existsMock.mockImplementation(() => Effect.succeed(false))
    const checks = await runP(runDoctor('/cwd'))
    const auth = checks.find((c) => c.name.startsWith('opencode auth'))
    expect(auth?.status).toBe('warn')
  })
})
