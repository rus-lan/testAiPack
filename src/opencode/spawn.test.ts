import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { spawnProcess, execCmd } from './spawn.js'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir } from '../util/fs.js'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

describe('spawnProcess (real subprocess)', () => {
  it('captures stdout and exit code 0', async () => {
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', "process.stdout.write('hello opencode\\n')"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }),
    )
    expect(out.stdout).toContain('hello opencode')
    expect(out.exitCode).toBe(0)
    expect(out.timedOut).toBe(false)
  })

  it('invokes onStdoutLine once per emitted line', async () => {
    const lines: string[] = []
    await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', "process.stdout.write('a\\nb\\nc\\n')"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        onStdoutLine: (l) => lines.push(l),
      }),
    )
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  it('reports a non-zero exit code for a failing script', async () => {
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', "process.exit(7)"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }),
    )
    expect(out.exitCode).toBe(7)
  })

  it('aborts and sets timedOut=true when timeoutMs elapses', async () => {
    const start = Date.now()
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', "setInterval(()=>{}, 1000)"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        timeoutMs: 120,
      }),
    )
    expect(out.timedOut).toBe(true)
    expect(out.exitCode).toBe(null)
    expect(Date.now() - start).toBeGreaterThanOrEqual(100)
  })
})

describe('execCmd (real subprocess)', () => {
  it('returns stdout/stderr/exitCode for a simple command', async () => {
    const cwd = makeTempDir()
    await run(ensureDir(cwd))
    const out = await run(
      execCmd({
        command: process.execPath,
        args: ['-e', "process.stdout.write('ok'); process.exit(0)"],
        cwd,
        env: { ...process.env } as Record<string, string>,
      }),
    )
    expect(out.stdout).toBe('ok')
    expect(out.exitCode).toBe(0)
    expect(path.isAbsolute(cwd)).toBe(true)
  })

  it('returns non-zero exitCode on failure', async () => {
    const out = await run(
      execCmd({
        command: process.execPath,
        args: ['-e', "process.exit(3)"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }),
    )
    expect(out.exitCode).toBe(3)
  })
})
