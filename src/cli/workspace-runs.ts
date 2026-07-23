/**
 * Workspace introspection helpers for the `list`, `gc`, `report` and `review`
 * commands: enumerate run directories under the workspace root, read their
 * manifests, and resolve the "latest" run. All filesystem access goes through
 * the Effect-based `util/fs` seam so errors surface as normal Effects.
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { Manifest } from '@generated/types'
import { manifestSchema } from '@generated/schemas'
import { ensureDir, exists, readDir, readJson, removeDir, readFile } from '../util/fs.js'
import type { FsError, ParseError } from '../util/fs.js'
import { reportSchema } from '@generated/schemas'
import type { Report } from '@generated/types'

export interface RunEntry {
  readonly runId: string
  readonly dir: string
  readonly timestamp: string
  readonly manifest: Manifest
  readonly resultsDir: string
}

const DEFAULT_WORKSPACE = '.testaipack'

export const resolveWorkspace = (workspacePath: string | undefined): string =>
  workspacePath === undefined || workspacePath === '' ? DEFAULT_WORKSPACE : workspacePath

const tryReadManifest = (
  dir: string,
): Effect.Effect<RunEntry | null> =>
  Effect.gen(function* () {
    const manifestPath = path.join(dir, 'manifest.json')
    const has = yield* exists(manifestPath)
    if (!has) return null
    const read = yield* readJson(manifestPath, manifestSchema).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )
    if (read === null) return null
    // Zod-inferred optionals vs generated exact-optional; schema-validated.
    const manifest = read as Manifest
    return {
      runId: manifest.runId,
      dir,
      timestamp: manifest.timestamp,
      manifest,
      resultsDir: path.join(dir, 'results'),
    }
  })

export const listRuns = (
  workspacePath: string,
): Effect.Effect<readonly RunEntry[]> =>
  Effect.gen(function* () {
    const root = resolveWorkspace(workspacePath)
    const has = yield* exists(root)
    if (!has) return []
    const entries = yield* readDir(root).pipe(Effect.catchAll(() => Effect.succeed([])))
    const abs = entries.map((e) => path.join(root, e))
    const tried = yield* Effect.all(abs.map((d) => tryReadManifest(d)), {
      concurrency: 4,
    })
    const runs = tried.filter((r): r is RunEntry => r !== null)
    return [...runs].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  })

export const findRun = (
  workspacePath: string,
  runId: string | undefined,
): Effect.Effect<RunEntry | null> =>
  Effect.gen(function* () {
    const runs = yield* listRuns(workspacePath)
    if (runs.length === 0) return null
    if (runId === undefined) return runs[0] ?? null
    return runs.find((r) => r.runId === runId || r.dir.endsWith(runId)) ?? null
  })

export interface GcPlan {
  readonly delete: readonly string[]
  readonly keep: readonly RunEntry[]
  readonly pruneHome: readonly string[]
}

const parseOlderThan = (spec: string): number | null => {
  const m = /^(\d+)\s*(d|h|days?|hours?|m|minutes?)?$/i.exec(spec.trim())
  if (m === null || m[1] === undefined) return null
  const n = Number.parseInt(m[1], 10)
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? 'd').toLowerCase()
  if (unit.startsWith('d')) return n * 86_400_000
  if (unit.startsWith('h')) return n * 3_600_000
  return n * 60_000
}

export interface GcOptions {
  readonly keepLast?: number
  readonly olderThan?: string
  readonly aggressive?: boolean
}

export const planGc = (
  workspacePath: string,
  opts: GcOptions,
): Effect.Effect<GcPlan> =>
  Effect.gen(function* () {
    const runs = yield* listRuns(workspacePath)
    const keepLastApplied: readonly RunEntry[] =
      opts.keepLast !== undefined && opts.keepLast >= 0 ? runs.slice(0, opts.keepLast) : runs
    const deleteFromKeepLast: readonly RunEntry[] =
      opts.keepLast !== undefined && opts.keepLast >= 0 ? runs.slice(opts.keepLast) : []

    const staleDirs: ReadonlySet<string> = (() => {
      if (opts.olderThan === undefined) return new Set<string>()
      const ms = parseOlderThan(opts.olderThan)
      if (ms === null) return new Set<string>()
      const cutoff = Date.now() - ms
      return new Set(
        runs.filter((r) => Date.parse(r.timestamp) < cutoff).map((r) => r.dir),
      )
    })()
    const staleRuns: readonly RunEntry[] = runs.filter((r) => staleDirs.has(r.dir))
    const toDelete = [...deleteFromKeepLast, ...staleRuns].filter(
      (r, i, arr) => arr.findIndex((x) => x.dir === r.dir) === i,
    )
    const toKeep = keepLastApplied.filter((r) => !staleDirs.has(r.dir))
    const pruneHome = opts.aggressive
      ? toKeep.flatMap((r) => [path.join(r.dir, 'home'), path.join(r.dir, 'apps')])
      : []
    return {
      delete: toDelete.map((r) => r.dir),
      keep: toKeep,
      pruneHome,
    }
  })

export const executeGc = (
  plan: GcPlan,
): Effect.Effect<{ readonly deleted: readonly string[] }> =>
  Effect.gen(function* () {
    const targets = [...plan.delete, ...plan.pruneHome]
    const outcomes = yield* Effect.forEach(targets, (target) =>
      removeDir(target).pipe(
        Effect.map(() => ({ target, ok: true as const })),
        Effect.catchAll(() => Effect.succeed({ target, ok: false as const })),
      ),
      { concurrency: 1 },
    )
    return { deleted: outcomes.filter((o) => o.ok).map((o) => o.target) }
  })

export const readReport = (
  resultsDir: string,
): Effect.Effect<Report | null, FsError | ParseError> =>
  Effect.gen(function* () {
    const file = path.join(resultsDir, 'report.json')
    const has = yield* exists(file)
    if (!has) return null
    const parsed = yield* readJson(file, reportSchema)
    // Zod-inferred optionals vs generated exact-optional; schema-validated.
    return parsed as Report
  })

export const readMetricsText = (resultsDir: string): Effect.Effect<string> =>
  readFile(path.join(resultsDir, 'metrics.json')).pipe(
    Effect.catchAll(() => Effect.succeed('')),
  )

export const ensureWorkspace = (
  workspacePath: string,
): Effect.Effect<string, FsError> =>
  Effect.gen(function* () {
    const root = resolveWorkspace(workspacePath)
    yield* ensureDir(root)
    return root
  })
