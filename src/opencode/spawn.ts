import { Effect } from 'effect'
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process'

/** How long to wait after SIGTERM before forcing SIGKILL on a child that ignores it. */
const KILL_GRACE_MS = 5000

const MAX_BUFFER_BYTES = 16 * 1024 * 1024
const MAX_BUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

export interface SpawnInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs?: number
  readonly onStdoutLine?: (line: string) => void
}

export interface SpawnOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface ExecInput {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
}

export interface ExecOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  /** The raw non-numeric error code (e.g. `ENOENT`) when `exitCode` falls back to -1. */
  readonly spawnErrorCode?: string
}

export const spawnProcess = (input: SpawnInput): Effect.Effect<SpawnOutput> =>
  Effect.async<SpawnOutput>((resume) => {
    const start = Date.now()
    const controller = new AbortController()
    let timedOut = false
    let settled = false

    const stdoutChunks: string[] = []
    let lineCarry = ''
    let stderrStr = ''
    let exitCode: number | null = null
    let stdoutClosed = false
    let stderrClosed = false
    let procExited = false

    let killTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (out: SpawnOutput): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resume(Effect.succeed(out))
    }

    const maybeFinish = (): void => {
      if (procExited && stdoutClosed && stderrClosed) {
        finish({
          stdout: stdoutChunks.join(''),
          stderr: stderrStr,
          exitCode,
          durationMs: Date.now() - start,
          timedOut,
        })
      }
    }

    const child = nodeSpawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      signal: controller.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const abortThenEscalate = (): void => {
      controller.abort()
      killTimer = setTimeout(() => {
        if (!procExited) child.kill('SIGKILL')
      }, KILL_GRACE_MS)
    }

    const timer =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            abortThenEscalate()
          }, input.timeoutMs)

    const onStdoutLine = input.onStdoutLine
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutChunks.push(chunk)
      if (onStdoutLine !== undefined) {
        lineCarry += chunk
        let idx = lineCarry.indexOf('\n')
        while (idx >= 0) {
          const line = lineCarry.slice(0, idx)
          lineCarry = lineCarry.slice(idx + 1)
          onStdoutLine(line)
          idx = lineCarry.indexOf('\n')
        }
      }
    })
    child.stdout.on('end', () => {
      if (onStdoutLine !== undefined && lineCarry.length > 0) {
        onStdoutLine(lineCarry)
        lineCarry = ''
      }
      stdoutClosed = true
      maybeFinish()
    })
    child.stdout.on('error', () => {
      stdoutClosed = true
      maybeFinish()
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrStr += chunk
    })
    child.stderr.on('end', () => {
      stderrClosed = true
      maybeFinish()
    })
    child.stderr.on('error', () => {
      stderrClosed = true
      maybeFinish()
    })

    child.on('exit', (code) => {
      procExited = true
      exitCode = code
      if (killTimer) clearTimeout(killTimer)
      maybeFinish()
    })

    child.on('error', (err) => {
      finish({
        stdout: stdoutChunks.join(''),
        stderr: `${stderrStr}${stderrStr ? '\n' : ''}spawn error: ${err.message}`,
        exitCode: null,
        durationMs: Date.now() - start,
        timedOut,
      })
    })

    return Effect.sync(() => {
      if (timer) clearTimeout(timer)
      abortThenEscalate()
    })
  })

export const execCmd = (input: ExecInput): Effect.Effect<ExecOutput> =>
  Effect.async<ExecOutput>((resume) => {
    const controller = new AbortController()
    let settled = false
    nodeExecFile(
      input.command,
      [...input.args],
      {
        cwd: input.cwd,
        env: input.env,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        signal: controller.signal,
      },
      (err, stdout, stderr) => {
        if (settled) return
        settled = true
        if (err !== null && err.code === MAX_BUFFER_ERROR_CODE) {
          resume(
            Effect.succeed({
              stdout,
              stderr: `${stderr}${stderr ? '\n' : ''}output exceeded max buffer size (${String(MAX_BUFFER_BYTES)} bytes)`,
              exitCode: -1,
              spawnErrorCode: MAX_BUFFER_ERROR_CODE,
            }),
          )
          return
        }
        const exitCode = err === null ? 0 : typeof err.code === 'number' ? err.code : -1
        const spawnErrorCode = err !== null && typeof err.code === 'string' ? err.code : undefined
        resume(
          Effect.succeed({
            stdout,
            stderr,
            exitCode,
            ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
          }),
        )
      },
    )
    return Effect.sync(() => {
      settled = true
      controller.abort()
    })
  })
