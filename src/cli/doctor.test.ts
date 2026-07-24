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
    expect(hasCriticalFailure(checks)).toBe(false)
  })

  it('opencode missing (exit < 0) → fail + critical', async () => {
    execMock.mockImplementation((input) =>
      Effect.succeed({
        stdout: '',
        stderr: 'not found',
        exitCode: input.command === 'opencode' ? -1 : 0,
      }),
    )
    existsMock.mockImplementation(() => Effect.succeed(true))
    const checks = await runP(runDoctor('/cwd'))
    const oc = checks.find((c) => c.name === 'opencode')
    expect(oc?.status).toBe('fail')
    expect(hasCriticalFailure(checks)).toBe(true)
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
