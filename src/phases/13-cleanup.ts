/**
 * Phase 13: cleanup (ephemeral mode)
 *
 * By default (`ephemeral = false`) does nothing — workspace retention is on.
 * When `ephemeral = true`, removes `apps/`, `home/` and `pack/`, keeping
 * `config/` and `results/` (which holds all reports/diffs/timeline). Soft
 * phase: removal errors are logged to `results/gc.log` and never fail the run.
 *
 * The standalone `testaipack gc` subcommand (keep-last / older-than /
 * aggressive) lives in CLI wiring, not here.
 *
 * @see docs/phases/13-cleanup.ru.md
 * @see contract/phases/13-cleanup.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { CleanupInput, CleanupResult, WorkspaceTree } from '@generated/types'
import type { PhaseError } from '../errors.js'
import { appendFile, ensureDir, removeDir } from '../util/fs.js'
import type { FsError } from '../util/fs.js'

const ephemeralTargets = (workspace: WorkspaceTree): readonly string[] => [
  path.join(workspace.root, 'apps'),
  path.join(workspace.root, 'home'),
  workspace.pack,
]

const allWorkspacePaths = (workspace: WorkspaceTree): readonly string[] => [
  workspace.root,
  workspace.appsSource,
  ...workspace.appsOld,
  ...workspace.appsNew,
  workspace.pack,
  ...workspace.homeOld,
  ...workspace.homeNew,
  workspace.config,
  workspace.results,
  workspace.raw,
  workspace.diff,
]

const softEnsure = (label: string) => (e: FsError): Effect.Effect<void> =>
  Effect.sync(() => {
    console.warn(`cleanup: ${label} failed: ${e.operation} on ${e.path}: ${String(e.cause)}`)
  })

export const cleanup = (
  input: CleanupInput,
): Effect.Effect<CleanupResult, PhaseError> =>
  Effect.gen(function* () {
    const { workspace, ephemeral } = input
    const resultsDir = workspace.results

    if (!ephemeral) {
      const gcLogPath = path.join(resultsDir, 'gc.log')
      const stamp = new Date().toISOString()
      yield* ensureDir(resultsDir).pipe(Effect.catchAll(softEnsure('ensureDir')))
      yield* appendFile(gcLogPath, `[${stamp}] cleanup skipped (retention on)\n`).pipe(
        Effect.catchAll(softEnsure('appendGcLog')),
      )
      return {
        deleted: [],
        kept: [...allWorkspacePaths(workspace)],
        gcLogPath,
      }
    }

    const targets = ephemeralTargets(workspace)
    const outcomes = yield* Effect.forEach(targets, (dir) =>
      removeDir(dir).pipe(
        Effect.map(() => ({ dir, ok: true as const })),
        Effect.catchAll(() => Effect.succeed({ dir, ok: false as const })),
      ),
      { concurrency: 1 },
    )
    const deleted = outcomes.filter((o) => o.ok).map((o) => o.dir)
    const failed = outcomes.filter((o) => !o.ok).map((o) => o.dir)

    const gcLogPath = path.join(resultsDir, 'gc.log')
    const stamp = new Date().toISOString()
    const logBody = [
      `[${stamp}] ephemeral cleanup`,
      ...deleted.map((d) => `deleted ${d}`),
      ...failed.map((d) => `WARN failed to delete ${d}`),
    ].join('\n')

    yield* ensureDir(resultsDir).pipe(Effect.catchAll(softEnsure('ensureDir')))
    yield* appendFile(gcLogPath, `${logBody}\n`).pipe(Effect.catchAll(softEnsure('appendGcLog')))

    return {
      deleted,
      kept: [workspace.config, resultsDir, ...failed],
      gcLogPath,
    }
  })
