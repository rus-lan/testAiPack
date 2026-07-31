/**
 * Phase 04b: pack-setup
 *
 * For each variant, for each of its own declared packs that has `setup`
 * (declaration order): installs the pack's runtime into that variant's
 * run-1 HOME (once per (declaring variant, pack) — D6), then copies that
 * HOME over the variant's OTHER HOMEs — they are already byte-identical at
 * this point (phase 04 built each from the same skeleton + auth +
 * instructions), so the copy is a pure replacement, not a merge. Scans a
 * pack's delivered directory for dependency markers when neither `setup`
 * nor any declaring variant's `exercise` was declared, so a pack that
 * clearly wraps an external runtime does not fail silently. A registry pack
 * with none of `setup`/`check`/any declaring variant's `exercise` costs
 * nothing here — mode `delivered-only`, byte identical to today's no-flags
 * behavior.
 *
 * `check` (verified per-HOME by preflight gate 6, `05-preflight.ts`) and
 * `exercise` (run per run of the declaring variant, before the agent
 * session, in `cli/pipeline.ts`) are NOT executed here — this phase only
 * produces the `setups` half of `PrepReport`; `checks`/`exercises` start
 * empty and are filled in by those two call sites.
 *
 * @see docs/phases/04b-pack-setup.ru.md
 * @see contract/phases/04b-pack-setup.tsp
 */
import { Effect, Ref } from 'effect'
import path from 'node:path'
import type {
  PackCmdResult,
  PackPrep,
  PackSetupInput,
  PackSetupMode,
  PrepReport,
  VariantEnv,
  VariantPrep,
} from '@generated/types'
import type { PackInstallOutcome } from './03-pack-install.js'
import { packsOf } from './00-cli-parse.js'
import type { DockerExec } from '../opencode/cli.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import { runShellInHome } from '../isolation/shell-runner.js'
import { copyDir, ensureDir, exists, readDir, readFile, removeDir, writeFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { appendInfoExclude, statusPorcelain } from '../util/git.js'
import type { GitError } from '../util/git.js'
import { isRecord } from '../util/types.js'
import { packSetupError } from '../errors.js'
import type { PhaseError } from '../errors.js'

/**
 * Local input extension: widens `packInstall` to phase 03's `PackInstallOutcome`
 * (needed for `packPath`, the marker scan's root) and carries the docker
 * image resolved by phase 04, mirroring the `*Ext` pattern every phase after
 * 03 already uses for this exact hand-off. `Omit` (rather than re-declaring
 * the field on top of `extends PackSetupInput`) is the cleaner way to narrow
 * a member's type in a derived interface — no need to keep the base
 * member's wire type in scope at all.
 */
export interface PackSetupInputExt extends Omit<PackSetupInput, 'packInstall'> {
  readonly packInstall?: PackInstallOutcome
  readonly dockerImage?: string
  /**
   * Phase 04's per-variant env sets (`HomeIsolationResultExt.envVars`) —
   * reused, not recomputed, for a declaring variant's run-1 HOME `PATH`, so
   * `--pack-setup` resolves a HOME-installed binary exactly like the agent's
   * own bash tool will. Absent entries (or an absent `envVars` altogether)
   * simply mean no PATH override — the same as no registry pack declaring
   * `setup` at all.
   */
  readonly envVars?: readonly VariantEnv[]
}

export interface PackSetupResultExt {
  readonly report: PrepReport
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
 * A heuristic, not a hard requirement: self-contained packs with nothing to
 * install must keep working with zero new flags. Only returns a message when
 * a marker was actually found — the caller decides whether that is even
 * worth checking (only when neither `setup` nor any declaring variant's
 * `exercise` was declared for this pack).
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
    return `pack appears to wrap an external runtime (found: ${markers.join(', ')}) — nothing was declared (setup/check/exercise); the declaring variant(s) may be non-functional`
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
 * - `checkVerified`: `check` only ever runs inside preflight's gate 6
 *   (`05-preflight.ts`) — declared while preflight is disabled, or before
 *   preflight has run at all, is not yet verified.
 * - `exerciseHappened`: `exercise` runs per declaring-variant run — declared
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
 * `exercise` alone (no verified check) still counts as real evidence, just
 * not the strongest kind: it falls to `installed-only`, same as a bare
 * `setup`.
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

const fail = (
  message: string,
  code: 'E_PACK_SETUP_FAILED' | 'E_PACK_SETUP_TIMEOUT',
  context?: Record<string, unknown>,
): PhaseError => packSetupError(message, code, context)

/**
 * The copy-out below (`copyDir(home0, homeDir)`) is a pure replacement, sound
 * for every byte phase 04 made identical across a variant's runs — except
 * one: a local-plugin instruction's registration
 * (`04-home-isolation.ts`'s `applyInstruction`, `plugin` case) writes an
 * ABSOLUTE host path into `<home>/.config/opencode/opencode.json`'s
 * `plugin[]` array, and in HOME mode that path is genuinely `home0`'s own —
 * phase 04 already built run-N's OWN correctly-pathed copy before this phase
 * ever runs, and the blind copy would clobber it with run-1's path. Rewrite
 * every `plugin[]` entry rooted at `home0` to the same relative suffix under
 * `homeDir` so the destination points at its own plugin file again. Docker
 * mode is unaffected — `pluginConfigPath` already registers the
 * homeDir-agnostic container path (`/home/opencode/...`) there.
 */
const tryParseJson = (raw: string) => {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

const rewriteLocalPluginPaths = (
  cfgPath: string,
  fromHome: string,
  toHome: string,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    if (!(yield* exists(cfgPath))) return
    const raw = yield* readFile(cfgPath).pipe(
      Effect.mapError((e: FsError) =>
        fail(`cannot read opencode.json for plugin path rewrite: ${e.path}`, 'E_PACK_SETUP_FAILED', {
          path: e.path,
        }),
      ),
    )
    const parsed = tryParseJson(raw)
    if (parsed === undefined || !isRecord(parsed)) return
    const plugins = parsed['plugin']
    if (!Array.isArray(plugins) || !plugins.every((p) => typeof p === 'string')) return
    const rewritten = plugins.map((p) => (p.startsWith(fromHome) ? toHome + p.slice(fromHome.length) : p))
    if (rewritten.every((p, i) => p === plugins[i])) return
    yield* writeFile(cfgPath, `${JSON.stringify({ ...parsed, plugin: rewritten }, null, 2)}\n`).pipe(
      Effect.mapError((e: FsError) =>
        fail(`cannot rewrite opencode.json plugin paths: ${e.path}`, 'E_PACK_SETUP_FAILED', { path: e.path }),
      ),
    )
  })

/** `.git` dir for one run's app tree — outside it under `--protect-git`, inside it otherwise. Mirrors `cli/pipeline.ts`'s `gitDirFor`. */
const gitDirFor = (
  protectGit: boolean,
  appDir: string,
  gitDirsForVariant: readonly string[],
  idx: number,
): string => (protectGit ? (gitDirsForVariant[idx] ?? path.join(appDir, '.git')) : path.join(appDir, '.git'))

export const packSetup = (
  input: PackSetupInputExt,
): Effect.Effect<PackSetupResultExt, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const logPath = path.join(workspace.results, 'pack-setup.log')
    yield* ensureDir(workspace.results).pipe(
      Effect.mapError((e: FsError) => fail(`cannot create results dir: ${e.path}`, 'E_PACK_SETUP_FAILED', { path: e.path })),
    )

    // Pass 1 — per registry pack: mode/flags/marker-scan, purely derived (no
    // mutation) — one PackMeta per pack, in registry order.
    interface PackMeta {
      readonly pack: string
      readonly mode: PackSetupMode
      readonly setupDeclared: boolean
      readonly checkDeclared: boolean
      readonly exerciseDeclared: boolean
      readonly undeclaredDepWarning: string | undefined
    }
    const packMetas: readonly PackMeta[] = yield* Effect.forEach(
      runInput.packs,
      (pack) =>
        Effect.gen(function* () {
          const declaringVariants = runInput.variants.filter((v) => v.packs.includes(pack.name))
          const setupDeclared = pack.setup !== undefined
          const checkDeclared = pack.check !== undefined
          const exerciseDeclared = declaringVariants.some((v) => v.exercise !== undefined)
          // `check` only executes inside preflight (gate 6, 05-preflight.ts)
          // — declared with preflight disabled means it never ran. CLI parse
          // refuses that combination outright (00-cli-parse.ts), but `mode`
          // stays defensive about it too: it must reflect what ran, not what
          // was asked.
          const checkVerified = checkDeclared && runInput.preflightEnabled
          const mode = derivePackSetupMode(setupDeclared, checkVerified, exerciseDeclared)
          const packRoot = input.packInstall?.deliveries.find((d) => d.pack === pack.name)?.packPath ?? ''
          const undeclaredDepWarning =
            setupDeclared || exerciseDeclared ? undefined : yield* scanForDependencyMarkers(packRoot)
          return { pack: pack.name, mode, setupDeclared, checkDeclared, exerciseDeclared, undeclaredDepWarning }
        }),
      { concurrency: 1 },
    )
    const metaByPack = new Map(packMetas.map((m) => [m.pack, m] as const))

    // Log lines and setup results both accumulate as the (potentially
    // failing) pass-2 loop below runs — an Effect Ref, not plain mutation,
    // so a mid-loop failure can still flush everything gathered so far.
    const logRef = yield* Ref.make<readonly string[]>([
      '=== testaipack pack-setup log ===',
      '',
      ...packMetas.flatMap((m) => [
        `--- pack: ${m.pack} ---`,
        // Computed from DECLARATIONS, before gate 6 or any run — not yet
        // verified evidence. The final `PrepReport.packs[*].mode` (recomputed
        // in cli/pipeline.ts from what actually ran/passed, D12) is what the
        // report banner shows; this log line must not be read as that claim.
        `declared-mode: ${m.mode}`,
        `setupDeclared=${String(m.setupDeclared)} checkDeclared=${String(m.checkDeclared)} exerciseDeclared=${String(m.exerciseDeclared)}`,
        ...(m.undeclaredDepWarning === undefined ? [] : [`WARNING: ${m.undeclaredDepWarning}`]),
        '',
      ]),
    ])
    const appendLog = (lines: readonly string[]): Effect.Effect<void> =>
      Ref.update(logRef, (prev) => [...prev, ...lines])
    const flushLog = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lines = yield* Ref.get(logRef)
        yield* writeFile(logPath, `${lines.join('\n')}\n`).pipe(Effect.catchAll(() => Effect.void))
      })

    // Pass 2 — for each variant, for each of ITS declared packs with `setup`
    // (declaration order): run setup once in that variant's run-1 HOME, then
    // copy run-1 HOME over the variant's other HOMEs (D6).
    const isolation = runInput.isolation
    const dockerImage = isolation === 'docker' ? (input.dockerImage ?? DEFAULT_OPENCODE_IMAGE) : undefined
    const docker: DockerExec | undefined =
      dockerImage === undefined
        ? undefined
        : { image: dockerImage, ...(runInput.dockerNetwork === undefined ? {} : { network: runInput.dockerNetwork }) }
    const timeoutMs = runInput.timeouts.installSeconds * 1000

    const setupsRef = yield* Ref.make<readonly PackCmdResult[]>([])
    // Per-variant accumulator for paths a `setup` command wrote into run-1's
    // APP dir (as opposed to its HOME) — merged across every pack that
    // declares `setup` on the same variant, then persisted once as
    // `<raw>/<variant>/setup.json` after the loop below. Mirrors
    // `cli/pipeline.ts`'s `run-N.exercise.json`, but per-variant rather than
    // per-run: a setup runs once per (variant, pack), not once per run.
    const appExcludesRef = yield* Ref.make<ReadonlyMap<string, readonly string[]>>(new Map())
    for (const v of runInput.variants) {
      const vt = workspace.variantTrees.find((t) => t.name === v.name)
      const declaredPacks = packsOf(runInput, v)
      for (const pack of declaredPacks) {
        if (pack.setup === undefined) continue

        const home0 = vt?.homes[0] ?? ''
        const app0 = vt?.apps[0] ?? ''
        if (home0 === '' || app0 === '') {
          yield* flushLog()
          yield* Effect.fail(
            fail(
              `missing HOME/app dir for pack setup (variant=${v.name}, pack=${pack.name})`,
              'E_PACK_SETUP_FAILED',
              { variant: v.name, pack: pack.name },
            ),
          )
        }

        const pathOverride = input.envVars?.find((e) => e.name === v.name)?.envs[0]?.PATH
        const outcome = yield* runShellInHome(pack.setup, home0, app0, docker, timeoutMs, pathOverride)
        yield* appendLog([
          `[SETUP ${v.name}/${pack.name}] exitCode=${String(outcome.exitCode)} durationMs=${String(outcome.durationMs)} timedOut=${String(outcome.timedOut)}`,
          outcome.outputTail,
        ])

        if (outcome.timedOut) {
          yield* flushLog()
          yield* Effect.fail(
            fail(
              `pack setup timed out after ${String(runInput.timeouts.installSeconds)}s (variant=${v.name}, pack=${pack.name})`,
              'E_PACK_SETUP_TIMEOUT',
              { variant: v.name, pack: pack.name, durationMs: outcome.durationMs },
            ),
          )
        }
        if (outcome.exitCode !== 0) {
          yield* flushLog()
          yield* Effect.fail(
            fail(
              `pack setup failed (exit ${String(outcome.exitCode)}) (variant=${v.name}, pack=${pack.name})`,
              'E_PACK_SETUP_FAILED',
              { variant: v.name, pack: pack.name, exitCode: outcome.exitCode, outputTail: outcome.outputTail },
            ),
          )
        }

        const cmdResult: PackCmdResult = {
          variant: v.name,
          pack: pack.name,
          runIndex: 0,
          exitCode: outcome.exitCode,
          durationMs: String(outcome.durationMs),
          outputTail: outcome.outputTail,
        }
        yield* Ref.update(setupsRef, (prev) => [...prev, cmdResult])

        // Every HOME of this variant was already byte-identical before setup
        // ran (phase 04 built each from the same skeleton + auth + pack
        // instructions) — this is a pure replacement, not a merge, and it is
        // the ONE network hit for this (variant, pack), not one per run.
        const restHomes = (vt?.homes ?? []).slice(1)
        for (const homeDir of restHomes) {
          yield* removeDir(homeDir).pipe(
            Effect.mapError((e: FsError) =>
              fail(`cannot clear ${homeDir} before HOME copy: ${e.path}`, 'E_PACK_SETUP_FAILED', {
                path: e.path,
                variant: v.name,
                pack: pack.name,
              }),
            ),
          )
          yield* copyDir(home0, homeDir).pipe(
            Effect.mapError((e: FsError) =>
              fail(`cannot copy setup HOME into ${homeDir}: ${e.path}`, 'E_PACK_SETUP_FAILED', {
                path: e.path,
                variant: v.name,
                pack: pack.name,
              }),
            ),
          )
          if (docker === undefined) {
            yield* rewriteLocalPluginPaths(
              path.join(homeDir, '.config/opencode/opencode.json'),
              home0,
              homeDir,
            )
          }
        }

        // A setup that writes into the workspace (not just HOME) — e.g. an
        // install command that drops config into cwd — otherwise contaminates
        // ONLY run-1's app dir: 08-diff.ts measures every run's app dir
        // independently, so run-1 and runs 2..N would silently measure
        // different starting states. `git status --porcelain` on run-1's app
        // dir is the instrument (the app dir is a git worktree, cloned by
        // phase 02 before this phase ever runs): a tracked-file modification
        // means the setup changed the baseline repo itself — that cannot be
        // fixed by excluding a path after the fact, so it aborts loudly,
        // mirroring `cli/pipeline.ts`'s `E_PACK_EXERCISE_DIRTY` handling for
        // `--pack-exercise`. A new untracked path is the setup's own output —
        // copied onto every other run's app dir and excluded from every run's
        // OWN `.git/info/exclude` (mirroring `runPackExercise` in
        // `cli/pipeline.ts`), so no run's measured diff ever sees it.
        const gitDirsForVariant = vt?.gitDirs ?? []
        const gitDir0 = gitDirFor(runInput.protectGit, app0, gitDirsForVariant, 0)
        const statuses = yield* statusPorcelain(app0, gitDir0).pipe(
          Effect.mapError((e: GitError) =>
            fail(`cannot verify pack setup diff hygiene (git status failed): ${e.stderr}`, 'E_PACK_SETUP_FAILED', {
              variant: v.name,
              pack: pack.name,
            }),
          ),
        )
        const dirtyTracked = statuses.filter((s) => s.code !== '??' && s.code.trim() !== '')
        if (dirtyTracked.length > 0) {
          yield* flushLog()
          yield* Effect.fail(
            fail(
              `pack setup modified tracked file(s): ${dirtyTracked.map((s) => s.path).join(', ')} (variant=${v.name}, pack=${pack.name})`,
              'E_PACK_SETUP_FAILED',
              { variant: v.name, pack: pack.name, paths: dirtyTracked.map((s) => s.path) },
            ),
          )
        }

        const setupUntrackedPaths = statuses.filter((s) => s.code === '??').map((s) => s.path)
        if (setupUntrackedPaths.length > 0) {
          yield* appendInfoExclude(gitDir0, setupUntrackedPaths).pipe(
            Effect.mapError((e: FsError) =>
              fail(`cannot exclude setup artifacts in ${gitDir0}: ${e.path}`, 'E_PACK_SETUP_FAILED', {
                variant: v.name,
                pack: pack.name,
              }),
            ),
          )

          const restApps = (vt?.apps ?? []).slice(1)
          for (const [i, appDir] of restApps.entries()) {
            for (const relPath of setupUntrackedPaths) {
              const dst = path.join(appDir, relPath)
              yield* ensureDir(path.dirname(dst)).pipe(
                Effect.mapError((e: FsError) =>
                  fail(`cannot prepare ${dst} for setup artifact copy: ${e.path}`, 'E_PACK_SETUP_FAILED', {
                    variant: v.name,
                    pack: pack.name,
                  }),
                ),
              )
              yield* copyDir(path.join(app0, relPath), dst).pipe(
                Effect.mapError((e: FsError) =>
                  fail(`cannot copy setup artifact ${relPath} into ${appDir}: ${e.path}`, 'E_PACK_SETUP_FAILED', {
                    variant: v.name,
                    pack: pack.name,
                  }),
                ),
              )
            }
            const otherGitDir = gitDirFor(runInput.protectGit, appDir, gitDirsForVariant, i + 1)
            yield* appendInfoExclude(otherGitDir, setupUntrackedPaths).pipe(
              Effect.mapError((e: FsError) =>
                fail(`cannot exclude setup artifacts in ${otherGitDir}: ${e.path}`, 'E_PACK_SETUP_FAILED', {
                  variant: v.name,
                  pack: pack.name,
                }),
              ),
            )
          }

          yield* Ref.update(appExcludesRef, (prev) => {
            const merged = [...new Set([...(prev.get(v.name) ?? []), ...setupUntrackedPaths])]
            return new Map(prev).set(v.name, merged)
          })
        }
      }
    }

    // Persist the merged setup-written app-dir paths per variant — one write
    // per variant, after every one of its packs' setups has run — so
    // `08-diff.ts` can re-apply the same excludes to any run of this variant
    // whose `.git` later needs restoring/replacing (`reapplySetupExcludes`),
    // the same gap `run-N.exercise.json` closes for `--pack-exercise`.
    // Best-effort like that record: it only matters on the git-restore edge
    // case, the live `.git/info/exclude` written above is what protects the
    // ordinary path.
    const appExcludes = yield* Ref.get(appExcludesRef)
    for (const [variantName, paths] of appExcludes) {
      if (paths.length === 0) continue
      yield* ensureDir(path.join(workspace.raw, variantName)).pipe(Effect.catchAll(() => Effect.void))
      yield* writeJson(path.join(workspace.raw, variantName, 'setup.json'), { excludedPaths: paths }).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }

    yield* flushLog()

    const allSetups = yield* Ref.get(setupsRef)
    const packPreps: readonly PackPrep[] = runInput.packs.map((pack) => {
      const meta = metaByPack.get(pack.name)
      const mode = meta?.mode ?? 'delivered-only'
      return {
        pack: pack.name,
        mode,
        setupDeclared: meta?.setupDeclared ?? false,
        checkDeclared: meta?.checkDeclared ?? false,
        exerciseDeclared: meta?.exerciseDeclared ?? false,
        ...(meta?.undeclaredDepWarning === undefined ? {} : { undeclaredDepWarning: meta.undeclaredDepWarning }),
        setups: allSetups.filter((s) => s.pack === pack.name),
        checks: [],
      }
    })

    const variantPreps: readonly VariantPrep[] = runInput.variants.map((v) => ({
      variant: v.name,
      exerciseDeclared: v.exercise !== undefined,
      exercises: [],
    }))

    return {
      report: { packs: [...packPreps], variants: [...variantPreps] },
      logPath,
    }
  })
