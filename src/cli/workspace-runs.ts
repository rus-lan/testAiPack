/**
 * Workspace introspection helpers for the `list`, `gc`, `report` and `review`
 * commands: enumerate run directories under the workspace root, read their
 * manifests, and resolve the "latest" run. All filesystem access goes through
 * the Effect-based `util/fs` seam so errors surface as normal Effects.
 *
 * `manifest.json`/`report.json` reads route through `src/compat/legacy.ts`:
 * a v1 workspace (predates `schemaVersion`) is transparently mapped to the
 * current v2 shape, so every caller of `listRuns`/`findRun`/`readReport`
 * sees v2 objects regardless of which schema version produced the run.
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { Manifest, Report } from '@generated/types'
import { ensureDir, exists, readDir, readFile, removeDir, ParseError } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { parseManifestCompat, parseReportCompat } from '../compat/legacy.js'

export interface RunEntry {
  readonly runId: string
  readonly dir: string
  readonly timestamp: string
  /** Always v2-shaped — compat-mapped from v1 when the run predates `schemaVersion`. */
  readonly manifest: Manifest
  /** The run's true on-disk schema version. Layout (`buildTreePaths`) depends on this, not on `manifest` (which is always v2-shaped). */
  readonly schemaVersion: 1 | 2
  readonly resultsDir: string
}

const DEFAULT_WORKSPACE = '.testaipack'

export const resolveWorkspace = (workspacePath: string | undefined): string =>
  workspacePath === undefined || workspacePath === '' ? DEFAULT_WORKSPACE : workspacePath

const readJsonUnknown = (filePath: string): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    const raw = yield* readFile(filePath).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (raw === '') return undefined
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })

const tryReadManifest = (
  dir: string,
): Effect.Effect<RunEntry | null> =>
  Effect.gen(function* () {
    const manifestPath = path.join(dir, 'manifest.json')
    const has = yield* exists(manifestPath)
    if (!has) return null
    const parsed = yield* readJsonUnknown(manifestPath)
    if (parsed === undefined) return null
    const result = parseManifestCompat(parsed)
    if (result === undefined) return null
    return {
      runId: result.manifest.runId,
      dir,
      timestamp: result.manifest.timestamp,
      manifest: result.manifest,
      schemaVersion: result.schemaVersion,
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

export const parseOlderThan = (spec: string): number | null => {
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
    // `gitdirs/` holds the `--protect-git` relocated git dirs (a full clone
    // per run) — phase 13's own ephemeral cleanup already prunes it for
    // ephemeral runs; aggressive gc needs the same target so a retained run
    // does not keep those clones alive forever, which defeats most of what
    // `--aggressive` is meant to reclaim.
    const pruneHome = opts.aggressive
      ? toKeep.flatMap((r) => [path.join(r.dir, 'home'), path.join(r.dir, 'apps'), path.join(r.dir, 'gitdirs')])
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
    const raw = yield* readFile(file)
    const parsedJson = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) => new ParseError({ path: file, reason: 'invalid-json', issues: e }),
    })
    const result = parseReportCompat(parsedJson)
    if (result === undefined) {
      return yield* Effect.fail(
        new ParseError({
          path: file,
          reason: 'schema-mismatch',
          issues: 'report.json matched neither the v2 nor the legacy v1 report schema',
        }),
      )
    }
    return result.report
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
