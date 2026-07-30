/**
 * Runs a plain shell command inside an isolated HOME — docker or host,
 * mirroring exactly where the agent's own opencode process would see that
 * environment. Shared by phase 04b (`--pack-setup`), phase 05 gate 6
 * (`--pack-check`), and the per-run `--pack-exercise` step in
 * `cli/pipeline.ts` — all three need the identical "run a command where the
 * agent runs, docker-aware" mechanic; the only differences between the three
 * are what they do with the result (abort the pipeline, fail a single gate,
 * or contain one run).
 *
 * `sh -c`, never `sh -lc`: confirmed empirically against the real image
 * (`testaipack-opencode:latest`, Debian-based) that a LOGIN shell
 * unconditionally re-sources `/etc/profile`, which resets `PATH` to a
 * hardcoded default regardless of what was inherited from the environment —
 * silently discarding the `.local/bin` prefix `--pack-setup` needs on every
 * single call. `sh -c` does not source login-only files, so an explicitly
 * passed `PATH` survives. The agent's own bash tool was verified separately
 * to already do the equivalent of `-c` (a real opencode run resolved a
 * HOME-installed binary via inherited PATH with no special handling needed).
 */
import { Effect } from 'effect'
import type { DockerExec } from '../opencode/cli.js'
import { dockerRun } from './docker-runner.js'
import type { DockerError } from './docker-runner.js'
import { spawnProcess } from '../opencode/spawn.js'
import { inheritEnv } from '../util/env.js'

export interface ShellOutcome {
  readonly exitCode: number
  readonly durationMs: number
  /** stdout+stderr tail, truncated (untrusted content — the command is user-supplied). */
  readonly outputTail: string
  readonly timedOut: boolean
}

/** Below this size the tail is the whole output; matches PackCmdResult.outputTail's truncation contract. */
const OUTPUT_TAIL_CHARS = 8000

const tail = (s: string, n: number): string => (s.length <= n ? s : s.slice(s.length - n))

const combinedOutput = (stdout: string, stderr: string): string =>
  [stdout, stderr].filter((s) => s !== '').join('\n')

/**
 * `docker !== undefined` uses the same image/mounts/uid the agent's own
 * opencode process gets (`homeDir` -> `/home/opencode`, `cwd` -> `/workspace`)
 * — never a side channel with different privileges or visibility. A docker
 * infra failure (missing image, daemon down, timeout) and an ordinary
 * non-zero exit both come back as ordinary fields here; callers that need to
 * tell "the command legitimately failed" apart from "the check itself could
 * not run" inspect `timedOut` plus their own knowledge of what a given exit
 * code means (e.g. gate 6 treats exit 1 from `--pack-check` as "tool
 * absent", anything else as an infra problem — see `05-preflight.ts`).
 *
 * `pathOverride` is the exact `EnvVarSet.PATH` phase 04 already computed for
 * this HOME (docker: a container-form path under `/home/opencode`; home
 * mode: the real host path) — passed in rather than recomputed here, so
 * `--pack-setup`/`--pack-check`/`--pack-exercise` all resolve a
 * HOME-installed binary exactly the way the agent's own bash tool will.
 * Undefined only when `--pack-setup` was never declared, in which case PATH
 * is left untouched (inherited image/host default).
 */
export const runShellInHome = (
  cmd: string,
  homeDir: string,
  cwd: string,
  docker: DockerExec | undefined,
  timeoutMs: number,
  pathOverride?: string,
): Effect.Effect<ShellOutcome> =>
  Effect.gen(function* () {
    if (docker !== undefined) {
      const outcome = yield* dockerRun({
        image: docker.image,
        cwd,
        homeDir,
        command: ['sh', '-c', cmd],
        ...(docker.network === undefined ? {} : { network: docker.network }),
        ...(pathOverride === undefined ? {} : { env: { PATH: pathOverride } }),
        timeoutMs,
      }).pipe(Effect.either)
      if (outcome._tag === 'Left') {
        const e: DockerError = outcome.left
        return {
          exitCode: e.exitCode ?? -1,
          durationMs: 0,
          outputTail: tail(e.stderr, OUTPUT_TAIL_CHARS),
          timedOut: e.timedOut,
        }
      }
      return {
        exitCode: outcome.right.exitCode,
        durationMs: outcome.right.durationMs,
        outputTail: tail(combinedOutput(outcome.right.stdout, outcome.right.stderr), OUTPUT_TAIL_CHARS),
        timedOut: false,
      }
    }
    const out = yield* spawnProcess({
      command: 'sh',
      args: ['-c', cmd],
      cwd,
      env: {
        ...inheritEnv(['PATH', 'LANG']),
        HOME: homeDir,
        ...(pathOverride === undefined ? {} : { PATH: pathOverride }),
      },
      timeoutMs,
    })
    return {
      exitCode: out.exitCode ?? -1,
      durationMs: out.durationMs,
      outputTail: tail(combinedOutput(out.stdout, out.stderr), OUTPUT_TAIL_CHARS),
      timedOut: out.timedOut,
    }
  })
