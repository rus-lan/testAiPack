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

export type WorkspaceSetupInputExt = WorkspaceSetupInput & {
  readonly flagDefaults?: Readonly<Record<string, unknown>>
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

const probeOpencodeVersion = (probeHome: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const either = yield* opencodeVersionProbe(probeHome).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.either,
    )
    if (either._tag === 'Right' && either.right._tag === 'Some') return either.right.value
    return 'unknown'
  })

const buildManifest = (
  runInput: RunInput,
  runId: string,
  opencodeVersion: string,
  flagDefaults: Record<string, unknown>,
): Manifest => ({
  runId,
  timestamp: new Date().toISOString(),
  repoUrl: runInput.repoUrl,
  prompt: runInput.prompt,
  runs: runInput.runs,
  isolation: runInput.isolation,
  opencodeVersion,
  flagDefaults,
  ...(runInput.packRef !== undefined ? { packRef: runInput.packRef } : {}),
  ...(runInput.packType !== undefined ? { packType: runInput.packType } : {}),
  ...(runInput.init !== undefined ? { init: runInput.init } : {}),
  ...(runInput.verify !== undefined ? { verify: runInput.verify } : {}),
})

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

    const appsSource = path.join(rootPath, 'apps', 'source')
    const appsOldBase = path.join(rootPath, 'apps', 'oldVersion')
    const appsNewBase = path.join(rootPath, 'apps', 'newVersion')
    const pack = path.join(rootPath, 'pack')
    const homeOldBase = path.join(rootPath, 'home', 'old')
    const homeNewBase = path.join(rootPath, 'home', 'new')
    const config = path.join(rootPath, 'config')
    const results = path.join(rootPath, 'results')
    const raw = path.join(rootPath, 'results', 'raw')
    const rawOld = path.join(raw, 'old')
    const rawNew = path.join(raw, 'new')
    const diff = path.join(rootPath, 'results', 'diff')
    const diffOld = path.join(diff, 'old')
    const diffNew = path.join(diff, 'new')

    const skeleton: readonly string[] = [
      appsSource, appsOldBase, appsNewBase, pack, homeOldBase, homeNewBase, config, rawOld, rawNew, diffOld, diffNew,
    ]
    for (const p of skeleton) {
      yield* ensureDir(p).pipe(Effect.mapError(mapFsTo('mkdir-failed', p)))
    }

    const opencodeVersion = runInput.opencodeVersion ?? (yield* probeOpencodeVersion(config))
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

    yield* updateGitignore(path.join(projectRoot, '.gitignore'))

    const runs = runInput.runs
    const runPaths = (base: string) => range(runs).map((n) => path.join(base, `run-${n.toString()}`))

    const treePaths: WorkspaceTree = {
      root: rootPath,
      appsSource,
      appsOld: runPaths(appsOldBase),
      appsNew: runPaths(appsNewBase),
      pack,
      homeOld: runPaths(homeOldBase),
      homeNew: runPaths(homeNewBase),
      config,
      results,
      raw,
      diff,
    }

    return { manifest, rootPath, treePaths }
  })
