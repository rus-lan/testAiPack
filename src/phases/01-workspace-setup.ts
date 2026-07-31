/**
 * Phase 01: workspace-setup
 *
 * @see docs/phases/01-workspace-setup.ru.md
 * @see contract/phases/01-workspace-setup.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type {
  Manifest,
  RunInput,
  VariantTree,
  WorkspaceSetupInput,
  WorkspaceSetupResult,
  WorkspaceTree,
} from '@generated/types'
import { manifestSchema } from '@generated/schemas'
import { workspaceSetupError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, pathKind, readDir, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { updateGitignore } from '../util/gitignore.js'
import { version as opencodeVersionProbe } from '../opencode/cli.js'
import type { DockerExec } from '../opencode/cli.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import { redactUrlCredentials } from '../util/redact.js'
import { safeRefDisplay } from '../pack/detector.js'

/**
 * Local input extension: carries the docker image (resolved from `--docker-image` /
 * config at phase 00, before phase 04 confirms it) so the version probe below runs
 * against the binary the run will actually use in docker isolation, not the host one.
 */
export type WorkspaceSetupInputExt = WorkspaceSetupInput & {
  readonly flagDefaults?: Readonly<Record<string, unknown>>
  readonly dockerImage?: string
}

const VERSION_PROBE_TIMEOUT_MS = 5000

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

const fail = (
  reason: 'already-exists' | 'not-a-directory' | 'mkdir-failed' | 'write-failed',
  message: string,
  context: Record<string, unknown>,
): Effect.Effect<never, PhaseError> =>
  Effect.fail(workspaceSetupError(message, 'E_HOME_SETUP_FAILED', { reason, ...context }))

const mapFsTo = (
  reason: 'mkdir-failed' | 'write-failed',
  p: string,
): ((e: FsError) => PhaseError) =>
  (e: FsError) =>
    workspaceSetupError(`${reason}: ${p}`, 'E_HOME_SETUP_FAILED', { reason, path: p, cause: String(e) })

/**
 * `--isolation docker` runs opencode inside a container pinned to its own
 * version (`Dockerfile.opencode` `ARG OPENCODE_VERSION`), which can differ
 * from whatever `opencode` resolves to on the host `PATH`. Probing without
 * `docker` here recorded the host binary's version in the manifest even
 * though the run never touches it.
 */
const probeOpencodeVersion = (probeHome: string, docker?: DockerExec): Effect.Effect<string> =>
  Effect.gen(function* () {
    const either = yield* opencodeVersionProbe(probeHome, docker).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.either,
    )
    if (either._tag === 'Right' && either.right._tag === 'Some') return either.right.value
    return 'unknown'
  })

/**
 * The manifest is a report/audit artifact (list, compare, report.md/json/html
 * all read it), never the source of truth for re-running the pipeline (that
 * stays on `runInput`) — so `repoUrl`/pack refs are redacted here, at the one
 * place all four shared artifacts trace back to, rather than in each renderer.
 */
const buildManifest = (
  runInput: RunInput,
  runId: string,
  opencodeVersion: string,
  flagDefaults: Record<string, unknown>,
): Manifest => ({
  schemaVersion: 2,
  runId,
  timestamp: new Date().toISOString(),
  repoUrl: redactUrlCredentials(runInput.repoUrl),
  runs: runInput.runs,
  parallel: runInput.parallel,
  baseline: runInput.baseline,
  packs: runInput.packs.map((p) => ({ ...p, ref: safeRefDisplay(redactUrlCredentials(p.ref)) })),
  variants: runInput.variants,
  isolation: runInput.isolation,
  opencodeVersion,
  flagDefaults,
  ...(runInput.prompt !== undefined ? { prompt: runInput.prompt } : {}),
  ...(runInput.init !== undefined ? { init: runInput.init } : {}),
  ...(runInput.hint !== undefined ? { hint: runInput.hint } : {}),
  ...(runInput.verify !== undefined ? { verify: runInput.verify } : {}),
})

/**
 * Pure function of `(rootPath, runs, variants, schemaVersion)` — the same
 * `WorkspaceTree` this phase derives while setting up a run, rederivable at
 * any later point (e.g. `report --rebuild`) without touching disk. Kept in
 * lockstep with the directory layout `workspaceSetup` creates below.
 *
 * `schemaVersion` picks the apps-dir naming only: v1 workspaces (pre-dating
 * n-way variants) spelled the two arms `apps/oldVersion` / `apps/newVersion`;
 * v2 uses the variant's own name (`apps/<name>`). `home/<name>` and
 * `gitdirs/<name>` never carried the `Version` suffix, so both versions agree
 * there — rebuild depends on this exact split to reconstruct pre-upgrade
 * workspaces (`01-contract.md §7`).
 */
export const buildTreePaths = (
  rootPath: string,
  runs: number,
  variants: readonly string[],
  schemaVersion: 1 | 2,
): WorkspaceTree => {
  const appsSource = path.join(rootPath, 'apps', 'source')
  const pack = path.join(rootPath, 'pack')
  const config = path.join(rootPath, 'config')
  const results = path.join(rootPath, 'results')
  const raw = path.join(rootPath, 'results', 'raw')
  const diff = path.join(rootPath, 'results', 'diff')
  const runPaths = (base: string) => range(runs).map((n) => path.join(base, `run-${n.toString()}`))
  const appsDirName = (name: string) => (schemaVersion === 1 ? `${name}Version` : name)

  const variantTrees: readonly VariantTree[] = variants.map((name) => ({
    name,
    apps: runPaths(path.join(rootPath, 'apps', appsDirName(name))),
    homes: runPaths(path.join(rootPath, 'home', name)),
    gitDirs: runPaths(path.join(rootPath, 'gitdirs', name)),
  }))

  return {
    root: rootPath,
    appsSource,
    pack,
    variantTrees: [...variantTrees],
    config,
    results,
    raw,
    diff,
  }
}

export const workspaceSetup = (
  input: WorkspaceSetupInputExt,
): Effect.Effect<WorkspaceSetupResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, runId } = input
    const rootPath = path.resolve(runInput.workspacePath, runId)
    const workspaceDir = path.resolve(runInput.workspacePath)
    const projectRoot = path.dirname(workspaceDir)

    const rootKind = yield* pathKind(rootPath)
    if (rootKind === 'file') {
      return yield* fail('not-a-directory', `rootPath is not a directory: ${rootPath}`, { path: rootPath })
    }
    if (rootKind === 'dir') {
      const entries = yield* readDir(rootPath).pipe(Effect.mapError(mapFsTo('mkdir-failed', rootPath)))
      if (entries.length > 0) {
        return yield* fail('already-exists', `rootPath already exists and is non-empty: ${rootPath}`, {
          path: rootPath,
          entries,
        })
      }
    }

    const workspaceKind = yield* pathKind(workspaceDir)
    if (workspaceKind === 'file') {
      return yield* fail('not-a-directory', `workspace path is not a directory: ${workspaceDir}`, {
        path: workspaceDir,
      })
    }

    const variantNames = runInput.variants.map((v) => v.name)
    const treePaths = buildTreePaths(rootPath, runInput.runs, variantNames, 2)
    const config = treePaths.config

    // Base dirs derived from treePaths.variantTrees (dirname of each run-1
    // entry) rather than re-joined from the variant name here — buildTreePaths
    // is the one place that knows the apps-dir naming rule (appsDirName), so
    // the skeleton can't drift from it.
    // home/<name> and gitdirs/<name> are created unconditionally (one pair per
    // variant) so the skeleton stays flag-free — gitdirs stay empty unless
    // --protect-git moves a run's .git into them (phase 02); per-run subdirs
    // are created by that move (or by phase 04 for home).
    const baseDirOf = (runPaths: readonly string[], fallback: string): string =>
      runPaths[0] === undefined ? fallback : path.dirname(runPaths[0])
    const skeleton: readonly string[] = [
      treePaths.appsSource,
      treePaths.pack,
      config,
      treePaths.results,
      ...treePaths.variantTrees.flatMap((vt) => [
        baseDirOf(vt.apps, path.join(rootPath, 'apps', vt.name)),
        baseDirOf(vt.homes, path.join(rootPath, 'home', vt.name)),
        baseDirOf(vt.gitDirs, path.join(rootPath, 'gitdirs', vt.name)),
        path.join(treePaths.raw, vt.name),
        path.join(treePaths.diff, vt.name),
      ]),
    ]
    for (const p of skeleton) {
      yield* ensureDir(p).pipe(Effect.mapError(mapFsTo('mkdir-failed', p)))
    }

    const docker: DockerExec | undefined =
      runInput.isolation === 'docker'
        ? {
            image: input.dockerImage ?? DEFAULT_OPENCODE_IMAGE,
            ...(runInput.dockerNetwork === undefined ? {} : { network: runInput.dockerNetwork }),
          }
        : undefined
    const opencodeVersion = runInput.opencodeVersion ?? (yield* probeOpencodeVersion(config, docker))
    const flagDefaults: Record<string, unknown> = input.flagDefaults
      ? { ...input.flagDefaults }
      : { dockerDowngraded: false }

    const manifest = buildManifest(runInput, runId, opencodeVersion, flagDefaults)
    const manifestCheck = manifestSchema.safeParse(manifest)
    if (!manifestCheck.success) {
      return yield* fail('write-failed', 'manifest failed schema validation', {
        issues: manifestCheck.error.issues,
      })
    }

    yield* writeJson(path.join(rootPath, 'manifest.json'), manifest).pipe(
      Effect.mapError(mapFsTo('write-failed', path.join(rootPath, 'manifest.json'))),
    )

    yield* updateGitignore(path.join(projectRoot, '.gitignore'), `${path.basename(workspaceDir)}/`)

    return { manifest, rootPath, treePaths }
  })
