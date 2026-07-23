import { Data, Effect } from 'effect'
import { spawnProcess, execCmd } from './spawn.js'
import { inheritEnv } from '../util/env.js'
import { isRecord } from '../util/types.js'

export interface OpencodeRunOptions {
  readonly homeDir: string
  readonly cwd: string
  readonly configContent?: string
  readonly agent?: string
  readonly model?: string
  readonly prompt: string
  readonly session?: string
  readonly continueSession?: boolean
  readonly auto?: boolean
  readonly pure?: boolean
  readonly env?: Record<string, string>
  readonly timeoutMs?: number
  readonly onEvent?: (event: unknown) => void
}

export interface OpencodeRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  readonly sessionId?: string
}

export class OpencodeError extends Data.TaggedError('OpencodeError')<{
  readonly command: string
  readonly exitCode: number | null
  readonly stderr: string
  readonly timedOut: boolean
}> {}

const OPENCODE_BIN = process.env['OPENCODE_BIN'] ?? 'opencode'

const buildBaseEnv = (
  homeDir: string,
  extra: Record<string, string>,
): Record<string, string> => ({
  ...inheritEnv(['PATH', 'LANG']),
  HOME: homeDir,
  ...extra,
})

const buildRunEnv = (opts: OpencodeRunOptions): Record<string, string> => {
  const configPart =
    opts.configContent === undefined
      ? {}
      : { OPENCODE_CONFIG_CONTENT: opts.configContent }
  return buildBaseEnv(opts.homeDir, { ...configPart, ...(opts.env ?? {}) })
}

export const buildRunArgs = (opts: OpencodeRunOptions): readonly string[] => [
  opts.prompt,
  ...(opts.agent !== undefined ? ['--agent', opts.agent] : []),
  ...(opts.model !== undefined ? ['--model', opts.model] : []),
  ...(opts.session !== undefined ? ['--session', opts.session] : []),
  ...(opts.continueSession === true ? ['--continue'] : []),
  ...(opts.auto !== false ? ['--auto'] : []),
  ...(opts.pure === true ? ['--pure'] : []),
  '--format',
  'json',
]

const sessionIdFromEvent = (ev: unknown): string | undefined => {
  if (isRecord(ev) && typeof ev['sessionId'] === 'string') return ev['sessionId']
  if (
    isRecord(ev) &&
    isRecord(ev['session']) &&
    typeof ev['session']['id'] === 'string'
  ) {
    return ev['session']['id']
  }
  return undefined
}

type JsonParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

const tryParseJson = (line: string): JsonParseResult => {
  try {
    return { ok: true, value: JSON.parse(line) as unknown }
  } catch {
    return { ok: false }
  }
}

const findSessionIdInText = (stdout: string): string | undefined => {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parsed = tryParseJson(trimmed)
    if (parsed.ok) {
      const id = sessionIdFromEvent(parsed.value)
      if (id !== undefined) return id
    }
  }
  return undefined
}

const parseVersion = (raw: string): string => {
  const match = /(\d+\.\d+\.\d+[0-9A-Za-z.\-]*)/.exec(raw)
  return match?.[1] ?? raw.trim()
}

export const run = (
  opts: OpencodeRunOptions,
): Effect.Effect<OpencodeRunResult, OpencodeError> =>
  Effect.gen(function* () {
    const args = buildRunArgs(opts)
    const env = buildRunEnv(opts)
    const onEvent = opts.onEvent
    const onLine =
      onEvent === undefined
        ? undefined
        : (line: string): void => {
            const trimmed = line.trim()
            if (trimmed === '') return
            const parsed = tryParseJson(trimmed)
            if (parsed.ok) onEvent(parsed.value)
          }

    const out = yield* spawnProcess({
      command: OPENCODE_BIN,
      args,
      cwd: opts.cwd,
      env,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(onLine === undefined ? {} : { onStdoutLine: onLine }),
    })

    if (out.timedOut) {
      yield* Effect.fail(
        new OpencodeError({
          command: 'run',
          exitCode: null,
          stderr: out.stderr,
          timedOut: true,
        }),
      )
    }
    if (out.exitCode !== 0) {
      yield* Effect.fail(
        new OpencodeError({
          command: 'run',
          exitCode: out.exitCode,
          stderr: out.stderr,
          timedOut: false,
        }),
      )
    }
    const sessionId = findSessionIdInText(out.stdout)
    return {
      exitCode: out.exitCode ?? 0,
      stdout: out.stdout,
      stderr: out.stderr,
      durationMs: out.durationMs,
      timedOut: false,
      ...(sessionId === undefined ? {} : { sessionId }),
    }
  })

const failOnNonZero = (
  command: string,
  out: { readonly exitCode: number; readonly stderr: string },
): Effect.Effect<void, OpencodeError> =>
  out.exitCode === 0
    ? Effect.sync(() => undefined)
    : Effect.fail(
        new OpencodeError({
          command,
          exitCode: out.exitCode,
          stderr: out.stderr,
          timedOut: false,
        }),
      )

export const version = (homeDir: string): Effect.Effect<string, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* execCmd({
      command: OPENCODE_BIN,
      args: ['--version'],
      cwd: homeDir,
      env: buildBaseEnv(homeDir, {}),
    })
    yield* failOnNonZero('version', out)
    return parseVersion(out.stdout)
  })

export const exportSession = (
  homeDir: string,
  sessionId: string,
): Effect.Effect<string, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* execCmd({
      command: OPENCODE_BIN,
      args: ['export', sessionId],
      cwd: homeDir,
      env: buildBaseEnv(homeDir, {}),
    })
    yield* failOnNonZero('export', out)
    return out.stdout
  })

export const installPlugin = (
  homeDir: string,
  module: string,
): Effect.Effect<void, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* execCmd({
      command: OPENCODE_BIN,
      args: ['plugin', module],
      cwd: homeDir,
      env: buildBaseEnv(homeDir, {}),
    })
    yield* failOnNonZero('plugin', out)
  })

export const listMcp = (homeDir: string): Effect.Effect<string, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* execCmd({
      command: OPENCODE_BIN,
      args: ['mcp', 'list'],
      cwd: homeDir,
      env: buildBaseEnv(homeDir, {}),
    })
    yield* failOnNonZero('mcp', out)
    return out.stdout
  })
