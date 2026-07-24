import { Data, Effect } from 'effect'
import { spawnProcess, execCmd } from './spawn.js'
import type { ExecOutput } from './spawn.js'
import { inheritEnv } from '../util/env.js'
import { isRecord } from '../util/types.js'
import { dockerRun } from '../isolation/docker-runner.js'
import type { DockerError } from '../isolation/docker-runner.js'

/**
 * When set, the opencode command runs inside a `docker run --rm` container with
 * the host `cwd` → `/workspace` and host `homeDir` → `/home/opencode` mounted
 * in. v0.3 `--isolation=docker` wires this from phase 06. Omitted ⇒ the legacy
 * direct-spawn path (home isolation).
 */
export interface DockerExec {
  readonly image: string
}

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
  readonly docker?: DockerExec
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

/**
 * Docker env: only opencode-specific vars. `HOME` is set by `dockerRun`
 * (`-e HOME=/home/opencode`); PATH/LANG come from the container image. Includes
 * `OPENCODE_CONFIG_CONTENT` and the disable/pure flags passed via `opts.env`.
 */
const buildDockerEnv = (opts: OpencodeRunOptions): Record<string, string> => {
  const configPart =
    opts.configContent === undefined
      ? {}
      : { OPENCODE_CONFIG_CONTENT: opts.configContent }
  return { ...configPart, ...(opts.env ?? {}) }
}

const dockerErrorToOpencode =
  (command: string) =>
  (d: DockerError): OpencodeError =>
    new OpencodeError({
      command,
      exitCode: d.exitCode,
      stderr: d.stderr,
      timedOut: d.timedOut,
    })

export const buildRunArgs = (opts: OpencodeRunOptions): readonly string[] => [
  'run',
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
  if (!isRecord(ev)) return undefined
  // opencode streams the session id as top-level `sessionID` (capital ID); older
  // mock fixtures used `sessionId`. Accept both, plus the nested shapes.
  const topId = ev['sessionID']
  if (typeof topId === 'string') return topId
  const lowerId = ev['sessionId']
  if (typeof lowerId === 'string') return lowerId
  const part = ev['part']
  if (isRecord(part) && typeof part['sessionID'] === 'string') return part['sessionID']
  if (isRecord(part) && typeof part['sessionId'] === 'string') return part['sessionId']
  const session = ev['session']
  if (isRecord(session) && typeof session['id'] === 'string') {
    return session['id']
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

    if (opts.docker !== undefined) {
      const dres = yield* dockerRun({
        image: opts.docker.image,
        cwd: opts.cwd,
        homeDir: opts.homeDir,
        env: buildDockerEnv(opts),
        command: [OPENCODE_BIN, ...args],
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(onLine === undefined ? {} : { onStdoutLine: onLine }),
      }).pipe(Effect.mapError(dockerErrorToOpencode('run')))
      const sessionId = findSessionIdInText(dres.stdout)
      return {
        exitCode: dres.exitCode,
        stdout: dres.stdout,
        stderr: dres.stderr,
        durationMs: dres.durationMs,
        timedOut: false,
        ...(sessionId === undefined ? {} : { sessionId }),
      }
    }

    const env = buildRunEnv(opts)
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

interface SimpleOpencodeSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly homeDir: string
  readonly docker?: DockerExec
}

/**
 * Shared backend for the non-streaming opencode subcommands. In docker mode the
 * command runs inside a container (cwd and homeDir both mount the isolated
 * `$HOME`); otherwise it is a direct `execFile` in the isolated `$HOME`.
 */
const runSimpleOpencode = (
  spec: SimpleOpencodeSpec,
): Effect.Effect<ExecOutput, OpencodeError> =>
  Effect.gen(function* () {
    if (spec.docker !== undefined) {
      const dres = yield* dockerRun({
        image: spec.docker.image,
        cwd: spec.homeDir,
        homeDir: spec.homeDir,
        command: [OPENCODE_BIN, ...spec.args],
      }).pipe(Effect.mapError(dockerErrorToOpencode(spec.command)))
      return { stdout: dres.stdout, stderr: dres.stderr, exitCode: dres.exitCode }
    }
    return yield* execCmd({
      command: OPENCODE_BIN,
      args: spec.args,
      cwd: spec.homeDir,
      env: buildBaseEnv(spec.homeDir, {}),
    })
  })

export const version = (
  homeDir: string,
  docker?: DockerExec,
): Effect.Effect<string, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* runSimpleOpencode({
      command: 'version',
      args: ['--version'],
      homeDir,
      ...(docker === undefined ? {} : { docker }),
    })
    yield* failOnNonZero('version', out)
    return parseVersion(out.stdout)
  })

export const exportSession = (
  homeDir: string,
  sessionId: string,
  docker?: DockerExec,
): Effect.Effect<string, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* runSimpleOpencode({
      command: 'export',
      args: ['export', sessionId],
      homeDir,
      ...(docker === undefined ? {} : { docker }),
    })
    yield* failOnNonZero('export', out)
    return out.stdout
  })

export const installPlugin = (
  homeDir: string,
  module: string,
  docker?: DockerExec,
): Effect.Effect<void, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* runSimpleOpencode({
      command: 'plugin',
      args: ['plugin', module],
      homeDir,
      ...(docker === undefined ? {} : { docker }),
    })
    yield* failOnNonZero('plugin', out)
  })

export const listMcp = (
  homeDir: string,
  docker?: DockerExec,
): Effect.Effect<string, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* runSimpleOpencode({
      command: 'mcp',
      args: ['mcp', 'list'],
      homeDir,
      ...(docker === undefined ? {} : { docker }),
    })
    yield* failOnNonZero('mcp', out)
    return out.stdout
  })

/**
 * `opencode db query <sql> --format json` — runs an SQL query against the
 * opencode session database in an isolated HOME and parses the JSON result.
 * Used by v0.2 to walk the session tree via the `session.parent_id` column.
 */
export const dbQuery = (
  homeDir: string,
  sql: string,
  docker?: DockerExec,
): Effect.Effect<unknown, OpencodeError> =>
  Effect.gen(function* () {
    const out = yield* runSimpleOpencode({
      command: 'db',
      args: ['db', 'query', sql, '--format', 'json'],
      homeDir,
      ...(docker === undefined ? {} : { docker }),
    })
    yield* failOnNonZero('db', out)
    return yield* Effect.try({
      try: () => JSON.parse(out.stdout) as unknown,
      catch: (e): OpencodeError =>
        new OpencodeError({
          command: 'db',
          exitCode: out.exitCode,
          stderr: `json parse failed: ${String(e)}`,
          timedOut: false,
        }),
    })
  })
