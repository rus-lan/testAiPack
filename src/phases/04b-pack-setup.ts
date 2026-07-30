/**
 * Phase 04b: pack-setup
 *
 * Installs the pack's runtime into the new side's first HOME (`--pack-setup`,
 * once for the whole experiment), then copies that HOME over every other
 * new-side HOME — they are already byte-identical at this point (phase 04
 * built each from the same skeleton + auth + instructions), so the copy is a
 * pure replacement, not a merge. Scans the delivered pack for dependency
 * markers when nothing was declared, so a pack that clearly wraps an
 * external runtime does not fail silently. No-op (mode `delivered-only`)
 * when `--pack-setup`/`--pack-check`/`--pack-exercise` are all absent — byte
 * identical to today's behavior.
 *
 * `--pack-check` (verified per-HOME on both sides) and `--pack-exercise`
 * (run per new-side run, before the agent session) are NOT executed here —
 * see gate 6 in `05-preflight.ts` and the per-run step in `cli/pipeline.ts`.
 * This phase only produces the `setup` half of `PackSetupReport`; the
 * `checks`/`exercises` arrays start empty and are filled in by those two
 * call sites.
 *
 * @see docs/phases/04b-pack-setup.ru.md
 * @see contract/phases/04b-pack-setup.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { PackCmdResult, PackSetupInput, PackSetupMode, PackSetupReport } from '@generated/types'
import type { PackInstallOutcome } from './03-pack-install.js'
import type { DockerExec } from '../opencode/cli.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import { runShellInHome } from '../isolation/shell-runner.js'
import { copyDir, ensureDir, exists, readDir, readFile, removeDir, writeFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import { packSetupError } from '../errors.js'
import type { PhaseError } from '../errors.js'

/**
 * Local input extension: widens `packInstall` to phase 03's `PackInstallOutcome`
 * (needed for `packPath`, the marker scan's root) and carries the docker
 * image resolved by phase 04, mirroring the `*Ext` pattern every phase after
 * 03 already uses for this exact hand-off. `newHomePath` is the exact
 * `EnvVarSet.PATH` phase 04 already computed for `homeNew[0]` — reused
 * rather than recomputed, so `--pack-setup` resolves a HOME-installed binary
 * (for anything it itself shells out to) exactly like the agent's own bash
 * tool will. Undefined when `--pack-setup` was never declared.
 */
export interface PackSetupInputExt extends PackSetupInput {
  readonly packInstall?: PackInstallOutcome
  readonly dockerImage?: string
  readonly newHomePath?: string
}

export interface PackSetupResultExt {
  readonly report: PackSetupReport
  readonly logPath: string
}

// ---------------------------------------------------------------------------
// Undeclared-dependency marker scan (only consulted when nothing was declared)
// ---------------------------------------------------------------------------

/** Matches the install-command prose a skill/README typically steers a model toward. */
const DEP_INSTALL_TEXT_RE = /\b(pip install|uv tool install|npm i(?:nstall)?\b|npx )/i

const scanPackageJsonBin = (packRoot: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pkgPath = path.join(packRoot, 'package.json')
    if (!(yield* exists(pkgPath))) return false
    const raw = yield* readFile(pkgPath).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (raw === '') return false
    try {
      const obj = JSON.parse(raw) as unknown
      return isRecord(obj) && obj['bin'] !== undefined
    } catch {
      return false
    }
  })

const scanRequirementsTxt = (packRoot: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const entries = yield* readDir(packRoot).pipe(Effect.catchAll(() => Effect.succeed([] as readonly string[])))
    return entries.some((e) => /^requirements.*\.txt$/i.test(e))
  })

const scanInstallTextIn = (filePath: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* exists(filePath))) return false
    const raw = yield* readFile(filePath).pipe(Effect.catchAll(() => Effect.succeed('')))
    return DEP_INSTALL_TEXT_RE.test(raw)
  })

/**
 * A heuristic, not a hard requirement: self-contained skills with nothing to
 * install must keep working with zero new flags. Only returns a message when
 * a marker was actually found — the caller decides whether that is even
 * worth checking (only when `--pack-setup`/`--pack-exercise` are absent).
 */
export const scanForDependencyMarkers = (packRoot: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (packRoot === '') return undefined
    const hasPyproject = yield* exists(path.join(packRoot, 'pyproject.toml'))
    const hasBin = yield* scanPackageJsonBin(packRoot)
    const hasRequirements = yield* scanRequirementsTxt(packRoot)
    const hasInstallText =
      (yield* scanInstallTextIn(path.join(packRoot, 'SKILL.md'))) ||
      (yield* scanInstallTextIn(path.join(packRoot, 'README.md')))
    const markers = [
      ...(hasPyproject ? ['pyproject.toml'] : []),
      ...(hasBin ? ['package.json bin'] : []),
      ...(hasRequirements ? ['requirements*.txt'] : []),
      ...(hasInstallText ? ['install command text in SKILL.md/README.md'] : []),
    ]
    if (markers.length === 0) return undefined
    return `pack appears to wrap an external runtime (found: ${markers.join(', ')}) — nothing was declared (--pack-setup/--pack-check/--pack-exercise); the new side may be non-functional`
  })

// ---------------------------------------------------------------------------
// Mode derivation
// ---------------------------------------------------------------------------

/**
 * Both `checkVerified` and `exerciseHappened` are deliberately NOT the same
 * as "declared" — the mode this returns is what the report BANNER states
 * happened (`MODE_BANNER.exercised` in md.ts: "the harness installed the
 * pack, VERIFIED IT FUNCTIONAL, and ran its pipeline"), so it must reflect
 * completed evidence, not requested flags:
 * - `checkVerified`: `--pack-check` only ever runs inside preflight's gate 6
 *   (`05-preflight.ts`) — declared while preflight is disabled, or before
 *   preflight has run at all, is not yet verified.
 * - `exerciseHappened`: `--pack-exercise` runs per new-side run — declared
 *   with every attempt failing (see `packExerciseWithoutCheckWarning` for
 *   why an unchecked pack can fail every run) is not evidence the mechanism
 *   works.
 *
 * Two call sites, two honesty levels: phase 04b (`packSetup` below) calls
 * this early, before preflight or any run — only real for `setupDeclared`,
 * everything else is necessarily still "not yet"; `pipeline.ts` calls it
 * again at the end with what actually ran/passed, and THAT result is what
 * the final report and its banner show. `exercised` requires
 * `checkVerified`, not just `exerciseHappened`: an exercise can run against
 * a broken install with nothing to catch it if the check was skipped.
 * `--pack-exercise` alone (no verified check) still counts as real
 * evidence, just not the strongest kind: it falls to `installed-only`, same
 * as a bare `--pack-setup`.
 */
export const derivePackSetupMode = (
  setupDeclared: boolean,
  checkVerified: boolean,
  exerciseHappened: boolean,
): PackSetupMode => {
  if (checkVerified && exerciseHappened) return 'exercised'
  if (setupDeclared || checkVerified || exerciseHappened) return 'installed-only'
  return 'delivered-only'
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

const fail = (message: string, code: 'E_PACK_SETUP_FAILED' | 'E_PACK_SETUP_TIMEOUT', context?: Record<string, unknown>): PhaseError =>
  packSetupError(message, code, context)

export const packSetup = (
  input: PackSetupInputExt,
): Effect.Effect<PackSetupResultExt, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const logPath = path.join(workspace.results, 'pack-setup.log')
    yield* ensureDir(workspace.results).pipe(
      Effect.mapError((e: FsError) => fail(`cannot create results dir: ${e.path}`, 'E_PACK_SETUP_FAILED', { path: e.path })),
    )

    const setupDeclared = runInput.packSetup !== undefined
    const checkDeclared = runInput.packCheck !== undefined
    const exerciseDeclared = runInput.packExercise !== undefined
    // `--pack-check` only executes inside preflight (gate 6, 05-preflight.ts)
    // — declared with preflight disabled means it never ran. CLI parse now
    // refuses that combination outright (00-cli-parse.ts), but `mode` stays
    // defensive about it too: it must reflect what ran, not what was asked.
    const checkVerified = checkDeclared && runInput.preflightEnabled
    const mode = derivePackSetupMode(setupDeclared, checkVerified, exerciseDeclared)

    const packRoot = input.packInstall?.packPath ?? ''
    const undeclaredDepWarning =
      setupDeclared || exerciseDeclared ? undefined : yield* scanForDependencyMarkers(packRoot)

    const headerLines: readonly string[] = [
      '=== testaipack pack-setup log ===',
      `mode: ${mode}`,
      `setupDeclared=${String(setupDeclared)} checkDeclared=${String(checkDeclared)} exerciseDeclared=${String(exerciseDeclared)}`,
      ...(undeclaredDepWarning === undefined ? [] : [`WARNING: ${undeclaredDepWarning}`]),
      '',
    ]

    const writeLog = (extra: readonly string[] = []): Effect.Effect<void> =>
      writeFile(logPath, `${[...headerLines, ...extra].join('\n')}\n`).pipe(Effect.catchAll(() => Effect.void))

    if (!setupDeclared) {
      yield* writeLog()
      return {
        report: {
          mode,
          setupDeclared,
          checkDeclared,
          exerciseDeclared,
          ...(undeclaredDepWarning === undefined ? {} : { undeclaredDepWarning }),
          checks: [],
          exercises: [],
        },
        logPath,
      }
    }

    const homeNew0 = workspace.homeNew[0] ?? ''
    const appsNew0 = workspace.appsNew[0] ?? ''
    if (homeNew0 === '' || appsNew0 === '') {
      yield* Effect.fail(fail('missing new-side HOME/app dir for --pack-setup', 'E_PACK_SETUP_FAILED', {}))
    }

    const isolation = runInput.isolation
    const dockerImage = isolation === 'docker' ? (input.dockerImage ?? DEFAULT_OPENCODE_IMAGE) : undefined
    const docker: DockerExec | undefined =
      dockerImage === undefined
        ? undefined
        : { image: dockerImage, ...(runInput.dockerNetwork === undefined ? {} : { network: runInput.dockerNetwork }) }
    const timeoutMs = runInput.timeouts.installSeconds * 1000

    const outcome = yield* runShellInHome(runInput.packSetup ?? '', homeNew0, appsNew0, docker, timeoutMs, input.newHomePath)
    const setupLogLines: readonly string[] = [
      `[SETUP] exitCode=${String(outcome.exitCode)} durationMs=${String(outcome.durationMs)} timedOut=${String(outcome.timedOut)}`,
      outcome.outputTail,
    ]

    if (outcome.timedOut) {
      yield* writeLog(setupLogLines)
      return yield* Effect.fail(
        fail(`--pack-setup timed out after ${String(runInput.timeouts.installSeconds)}s`, 'E_PACK_SETUP_TIMEOUT', {
          durationMs: outcome.durationMs,
        }),
      )
    }
    if (outcome.exitCode !== 0) {
      yield* writeLog(setupLogLines)
      return yield* Effect.fail(
        fail(`--pack-setup failed (exit ${String(outcome.exitCode)})`, 'E_PACK_SETUP_FAILED', {
          exitCode: outcome.exitCode,
          outputTail: outcome.outputTail,
        }),
      )
    }

    const setupResult: PackCmdResult = {
      side: 'new',
      runIndex: 0,
      exitCode: outcome.exitCode,
      durationMs: String(outcome.durationMs),
      outputTail: outcome.outputTail,
    }

    // Every new HOME was already byte-identical before setup ran (phase 04
    // built each from the same skeleton + auth + pack instructions) — this is
    // a pure replacement, not a merge, and it is the ONE network hit for the
    // whole experiment, not one per run.
    const restHomes = workspace.homeNew.slice(1)
    yield* Effect.forEach(
      restHomes,
      (homeDir) =>
        Effect.gen(function* () {
          yield* removeDir(homeDir).pipe(
            Effect.mapError((e: FsError) => fail(`cannot clear ${homeDir} before HOME copy: ${e.path}`, 'E_PACK_SETUP_FAILED', { path: e.path })),
          )
          yield* copyDir(homeNew0, homeDir).pipe(
            Effect.mapError((e: FsError) => fail(`cannot copy setup HOME into ${homeDir}: ${e.path}`, 'E_PACK_SETUP_FAILED', { path: e.path })),
          )
        }),
      { concurrency: 1 },
    )

    yield* writeLog(setupLogLines)

    return {
      report: {
        mode,
        setupDeclared,
        checkDeclared,
        exerciseDeclared,
        ...(undeclaredDepWarning === undefined ? {} : { undeclaredDepWarning }),
        setup: setupResult,
        checks: [],
        exercises: [],
      },
      logPath,
    }
  })
