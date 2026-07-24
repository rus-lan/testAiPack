/**
 * `testaipack doctor` \u2014 environment diagnostics. Probes the tools testaipack
 * shells out to (opencode, git, node, bun, docker) and the opencode auth
 * directory, and reports an ok/fail/warn verdict per check. Every probe is
 * isolated: a failure is reported, never thrown.
 */
import { Effect } from 'effect'
import os from 'node:os'
import path from 'node:path'
import { execCmd } from '../opencode/spawn.js'
import { exists } from '../util/fs.js'

export interface DoctorCheck {
  readonly name: string
  readonly status: 'ok' | 'fail' | 'warn'
  readonly detail: string
}

const PROBE_TIMEOUT_MS = 8_000

const fail = (name: string, detail: string): DoctorCheck => ({
  name,
  status: 'fail',
  detail,
})

const KEEP_ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'HOME'])

const cleanEnv: Record<string, string> = Object.entries(process.env).reduce<
  Record<string, string>
>(
  (acc, [k, v]) =>
    v !== undefined && KEEP_ENV.has(k) ? { ...acc, [k]: v } : acc,
  {},
)

const probeCmd = (
  name: string,
  command: string,
  args: readonly string[],
  cwd: string,
): Effect.Effect<DoctorCheck> =>
  execCmd({ command, args, cwd, env: { ...cleanEnv, HOME: cwd } }).pipe(
    Effect.timeout(PROBE_TIMEOUT_MS),
    Effect.map((out): DoctorCheck => {
      if (out.exitCode < 0) {
        return fail(name, `${command} not found`)
      }
      if (out.exitCode !== 0) {
        const stderr = out.stderr.trim()
        return {
          name,
          status: 'fail',
          detail: stderr === '' ? `exit ${String(out.exitCode)}` : stderr.slice(0, 120),
        }
      }
      return { name, status: 'ok', detail: out.stdout.trim().slice(0, 80) }
    }),
    Effect.catchAll((e) =>
      Effect.succeed(fail(name, `${command} timed out (${String(e)})`)),
    ),
  )

const checkAuthDir = (name: string, relPath: string): Effect.Effect<DoctorCheck> =>
  Effect.gen(function* () {
    const dir = path.join(os.homedir(), relPath)
    const has = yield* exists(dir)
    return {
      name,
      status: has ? 'ok' : 'warn',
      detail: has ? dir : `${dir} (not found)`,
    }
  })

export const runDoctor = (cwd: string): Effect.Effect<readonly DoctorCheck[]> =>
  Effect.all(
    [
      probeCmd('opencode', process.env['OPENCODE_BIN'] ?? 'opencode', ['--version'], cwd),
      probeCmd('git', 'git', ['--version'], cwd),
      probeCmd('node', 'node', ['--version'], cwd),
      probeCmd('bun', 'bun', ['--version'], cwd),
      probeCmd('docker', 'docker', ['info'], cwd),
      checkAuthDir('opencode auth.json', '.local/share/opencode/auth.json'),
    ],
    { concurrency: 4 },
  )

export const hasCriticalFailure = (checks: readonly DoctorCheck[]): boolean => {
  const critical = new Set(['opencode', 'git'])
  return checks.some((c) => critical.has(c.name) && c.status === 'fail')
}
