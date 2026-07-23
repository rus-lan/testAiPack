/**
 * Docker isolation runner — wraps `docker run` / `docker pull` / `docker image
 * inspect` so opencode commands can execute inside a throwaway container with
 * the isolated `$HOME` and the app working dir bind-mounted in.
 *
 * v0.3 home-isolation builds the same fake `$HOME` trees on the host (phase 04);
 * this module mounts `<host-home>` → `/home/opencode` and `<host-cwd>` →
 * `/workspace`, then runs the given command as `-w /workspace` with
 * `HOME=/home/opencode` inside the container. The host `HOME` path is therefore
 * the mount source, never the in-container value.
 */
import { Data, Effect } from 'effect'
import { randomBytes } from 'node:crypto'
import { spawnProcess, execCmd } from '../opencode/spawn.js'
import { inheritEnv } from '../util/env.js'

/** Default opencode container image. Override with `--docker-image`. */
export const DEFAULT_OPENCODE_IMAGE = 'opencode/opencode:latest'

/** Best-effort `docker kill` deadline after a run timeout. */
const KILL_TIMEOUT_MS = 5000
/** Default `docker pull` deadline. */
const DEFAULT_PULL_TIMEOUT_MS = 300_000

const DOCKER_ENV_KEYS: readonly string[] = [
  'PATH',
  'DOCKER_HOST',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
]

export class DockerError extends Data.TaggedError('DockerError')<{
  readonly command: string
  readonly exitCode: number | null
  readonly stderr: string
  readonly timedOut: boolean
  readonly cause?: unknown
}> {}

export interface DockerRunOptions {
  /** Container image, e.g. `opencode/opencode:latest`. */
  readonly image: string
  /** Host working dir → mounted as `/workspace` (container `-w`). */
  readonly cwd: string
  /** Host `$HOME` tree → mounted as `/home/opencode`. */
  readonly homeDir: string
  /** Extra env vars passed into the container (NOT `HOME` — set internally). */
  readonly env?: Record<string, string>
  /** Command vector executed inside the container (e.g. `['opencode','--version']`). */
  readonly command: readonly string[]
  /** Hard timeout. On expiry the container is `docker kill`-ed best-effort. */
  readonly timeoutMs?: number
  /** Optional stdout line sink so callers can stream JSON events. */
  readonly onStdoutLine?: (line: string) => void
}

export interface DockerRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

const dockerEnv = (): Record<string, string> => inheritEnv(DOCKER_ENV_KEYS)

const makeContainerName = (): string => `testaipack-${randomBytes(6).toString('hex')}`

export const buildDockerRunArgs = (
  opts: DockerRunOptions,
  containerName: string,
): readonly string[] => {
  const envFlags: readonly string[] = (Object.entries(opts.env ?? {})).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ])
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '-v',
    `${opts.cwd}:/workspace`,
    '-v',
    `${opts.homeDir}:/home/opencode`,
    '-w',
    '/workspace',
    '-e',
    'HOME=/home/opencode',
    ...envFlags,
    opts.image,
    ...opts.command,
  ]
}

const killContainer = (name: string, cwd: string): Effect.Effect<void> =>
  execCmd({
    command: 'docker',
    args: ['kill', name],
    cwd,
    env: dockerEnv(),
  }).pipe(
    Effect.timeoutOption(KILL_TIMEOUT_MS),
    Effect.ignore,
  )

/**
 * Run a command inside a fresh `--rm` container. On timeout the spawner aborts
 * the `docker run` client and we additionally `docker kill <name>` best-effort
 * (the auto-remove flag means the container is usually already gone).
 */
export const dockerRun = (
  opts: DockerRunOptions,
): Effect.Effect<DockerRunResult, DockerError> =>
  Effect.gen(function* () {
    const containerName = makeContainerName()
    const args = buildDockerRunArgs(opts, containerName)
    const out = yield* spawnProcess({
      command: 'docker',
      args,
      cwd: opts.cwd,
      env: dockerEnv(),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.onStdoutLine === undefined ? {} : { onStdoutLine: opts.onStdoutLine }),
    })

    if (out.timedOut) {
      yield* killContainer(containerName, opts.cwd)
      return yield* Effect.fail(
        new DockerError({
          command: 'run',
          exitCode: null,
          stderr: out.stderr,
          timedOut: true,
        }),
      )
    }
    if (out.exitCode !== 0) {
      return yield* Effect.fail(
        new DockerError({
          command: 'run',
          exitCode: out.exitCode,
          stderr: out.stderr,
          timedOut: false,
        }),
      )
    }
    return {
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      durationMs: out.durationMs,
      timedOut: false,
    }
  })

/** `docker image inspect <image>` exit 0 ⇔ image present locally. */
export const imageExists = (image: string): Effect.Effect<boolean, DockerError> =>
  Effect.gen(function* () {
    const out = yield* execCmd({
      command: 'docker',
      args: ['image', 'inspect', image],
      cwd: process.cwd(),
      env: dockerEnv(),
    })
    return out.exitCode === 0
  })

/** `docker pull <image>`; fails with `DockerError` on non-zero exit or timeout. */
export const pullImage = (
  image: string,
  timeoutMs: number = DEFAULT_PULL_TIMEOUT_MS,
): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    const result = yield* execCmd({
      command: 'docker',
      args: ['pull', image],
      cwd: process.cwd(),
      env: dockerEnv(),
    }).pipe(Effect.timeoutOption(timeoutMs))
    if (result._tag === 'None') {
      return yield* Effect.fail(
        new DockerError({
          command: 'pull',
          exitCode: null,
          stderr: `docker pull timed out after ${String(timeoutMs)}ms`,
          timedOut: true,
        }),
      )
    }
    const out = result.value
    if (out.exitCode !== 0) {
      return yield* Effect.fail(
        new DockerError({
          command: 'pull',
          exitCode: out.exitCode,
          stderr: out.stderr,
          timedOut: false,
        }),
      )
    }
  })

/** Pull the image only when it is not already present locally. */
export const ensureImage = (image: string): Effect.Effect<void, DockerError> =>
  Effect.gen(function* () {
    const present = yield* imageExists(image)
    if (!present) yield* pullImage(image)
  })
