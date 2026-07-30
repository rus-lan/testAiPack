import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { spawnProcess, execCmd } from './spawn.js'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile } from '../util/fs.js'

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

  it('escalates to SIGKILL when the child ignores SIGTERM past the timeout', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const pidFile = path.join(dir, 'pid')
    const childScript = [
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 60000)',
    ].join(';')
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        timeoutMs: 500,
      }),
    )
    expect(out.timedOut).toBe(true)

    let pid: number | undefined
    for (let i = 0; i < 100; i++) {
      try {
        pid = Number(await run(readFile(pidFile)))
        if (Number.isFinite(pid) && pid > 0) break
      } catch {
        // pid file not written yet
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(pid).toBeGreaterThan(0)

    const isAlive = (p: number): boolean => {
      try {
        process.kill(p, 0)
        return true
      } catch {
        return false
      }
    }
    let dead = false
    for (let i = 0; i < 400; i++) {
      if (!isAlive(pid as number)) {
        dead = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(dead).toBe(true)
  }, 20_000)

  it('writes `input` to the child\'s stdin and closes it — the child reads it back byte-exact', async () => {
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        input: 'fix the "2 failing" tests\nwith a second line',
      }),
    )
    expect(out.stdout).toBe('fix the "2 failing" tests\nwith a second line')
    expect(out.exitCode).toBe(0)
  })

  it('without `input`, stdin is ignored — a child that reads stdin sees EOF immediately, not a hang', async () => {
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.on('end', () => { process.stdout.write('eof'); process.exit(0) }); process.stdin.resume()",
        ],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        timeoutMs: 5000,
      }),
    )
    expect(out.stdout).toBe('eof')
    expect(out.timedOut).toBe(false)
  })

  it('a child that exits before reading stdin does not crash the caller (EPIPE swallowed)', async () => {
    const out = await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        input: 'x'.repeat(1024 * 1024),
      }),
    )
    expect(out.exitCode).toBe(0)
  })

  it('clears the internal timeout timer (configured for timeoutMs) once the process finishes normally', async () => {
    // Node resets a Timeout's `_idleTimeout` to -1 as part of clearing it, so
    // the delay it was created with must be captured before delegating to the
    // real clearTimeout, not read back afterwards from the spy's call log.
    const realClearTimeout = global.clearTimeout
    const clearedDelays: (number | undefined)[] = []
    const clearSpy = vi.spyOn(global, 'clearTimeout').mockImplementation((handle) => {
      clearedDelays.push((handle as unknown as { _idleTimeout?: number } | undefined)?._idleTimeout)
      realClearTimeout(handle)
    })
    const configuredTimeoutMs = 4242
    await run(
      spawnProcess({
        command: process.execPath,
        args: ['-e', "process.stdout.write('done')"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        timeoutMs: configuredTimeoutMs,
      }),
    )
    expect(clearedDelays).toContain(configuredTimeoutMs)
    clearSpy.mockRestore()
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

  it('a missing command surfaces spawnErrorCode ENOENT alongside exitCode -1', async () => {
    const out = await run(
      execCmd({
        command: '/definitely/not/a/real/binary-xyz',
        args: [],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }),
    )
    expect(out.exitCode).toBe(-1)
    expect(out.spawnErrorCode).toBe('ENOENT')
  })

  it('output over maxBuffer sets spawnErrorCode instead of a plain -1 crash', async () => {
    const out = await run(
      execCmd({
        command: process.execPath,
        args: ['-e', "for (let i = 0; i < 20; i++) process.stdout.write('x'.repeat(1024 * 1024))"],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }),
    )
    expect(out.exitCode).toBe(-1)
    expect(out.spawnErrorCode).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    expect(out.stderr).toContain('exceeded max buffer size')
  }, 15_000)

  it('kills the child process when interrupted by a timeout', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const pidFile = path.join(dir, 'pid')
    const childScript = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 60000)`
    const result = await run(
      execCmd({
        command: process.execPath,
        args: ['-e', childScript],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
      }).pipe(Effect.timeoutOption(400)),
    )
    expect(result._tag).toBe('None')

    let pid: number | undefined
    for (let i = 0; i < 50; i++) {
      try {
        pid = Number(await run(readFile(pidFile)))
        if (Number.isFinite(pid) && pid > 0) break
      } catch {
        // pid file not written yet
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(pid).toBeGreaterThan(0)

    const isAlive = (p: number): boolean => {
      try {
        process.kill(p, 0)
        return true
      } catch {
        return false
      }
    }
    let dead = false
    for (let i = 0; i < 50; i++) {
      if (!isAlive(pid as number)) {
        dead = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(dead).toBe(true)
  })
})
