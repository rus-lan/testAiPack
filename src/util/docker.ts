import { Effect } from 'effect'
import { execCmd } from '../opencode/spawn.js'
import { inheritEnv } from './env.js'

const DOCKER_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
]

export const DOCKER_PROBE_TIMEOUT_MS = 3000

export const isDockerAvailable = (
  timeoutMs: number = DOCKER_PROBE_TIMEOUT_MS,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const result = yield* execCmd({
      command: 'docker',
      args: ['info'],
      cwd: process.cwd(),
      env: inheritEnv(DOCKER_ENV_KEYS),
    }).pipe(Effect.timeoutOption(timeoutMs))
    if (result._tag === 'None') return false
    return result.value.exitCode === 0
  })
