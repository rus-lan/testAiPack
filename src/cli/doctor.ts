/**
 * `testaipack doctor` \u2014 environment diagnostics. Probes the tools testaipack
 * shells out to at runtime (opencode, git, node, docker) and the opencode auth
 * directory, and reports an ok/fail/warn verdict per check. Every probe is
 * isolated: a failure is reported, never thrown.
 *
 * `bun` is checked too but never as a runtime dependency: the released binary
 * is a standalone `bun build --compile` output and never shells out to `bun`.
 * It only matters to someone building from source (`npm run build`), so a
 * missing/broken `bun` is reported as `warn`, never `fail`.
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

/** First non-empty line, so multi-line command output never spills across a table row. */
const firstLine = (s: string): string => s.trim().split('\n', 1)[0] ?? ''

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
        return out.spawnErrorCode === 'ENOENT'
          ? fail(name, `${command} not found`)
          : fail(name, `${command} failed to run (${out.spawnErrorCode ?? 'unknown error'})`)
      }
      if (out.exitCode !== 0) {
        const stderr = firstLine(out.stderr)
        return {
          name,
          status: 'fail',
          detail: stderr === '' ? `exit ${String(out.exitCode)}` : stderr.slice(0, 120),
        }
      }
      return { name, status: 'ok', detail: firstLine(out.stdout).slice(0, 80) }
    }),
    Effect.catchAll((e) =>
      Effect.succeed(fail(name, `${command} timed out (${String(e)})`)),
    ),
  )

/**
 * `bun` is a build-time-only dependency (see module docstring) — any probe
 * failure is downgraded to `warn` so it never reads as a broken environment.
 */
const checkBun = (cwd: string): Effect.Effect<DoctorCheck> =>
  probeCmd('bun', 'bun', ['--version'], cwd).pipe(
    Effect.map((c): DoctorCheck =>
      c.status === 'ok'
        ? c
        : { name: 'bun', status: 'warn', detail: 'not needed to run testaipack, only to build it from source' },
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
      checkBun(cwd),
      probeCmd('docker', 'docker', ['info'], cwd),
      checkAuthDir('opencode auth.json', '.local/share/opencode/auth.json'),
    ],
    { concurrency: 4 },
  )

export const hasCriticalFailure = (checks: readonly DoctorCheck[]): boolean => {
  const critical = new Set(['opencode', 'git'])
  return checks.some((c) => critical.has(c.name) && c.status === 'fail')
}
