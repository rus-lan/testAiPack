import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { Manifest } from '@generated/types'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeJson, writeFile } from '../util/fs.js'
import {
  listRuns,
  findRun,
  planGc,
  executeGc,
  resolveWorkspace,
  readReport,
} from './workspace-runs.js'
import { makeReportV2 } from '../../tests/helpers/variants.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

// Local, genuinely v1-shaped fixtures (schemaVersion absent, side: 'old'|'new'
// literals) — NOT sourced from tests/report-fixture.ts (orchestrator ruling:
// that shared file is frozen/unowned this wave, nobody edits or imports it;
// duplicating a small builder locally is the accepted alternative). This
// package's v1-compat tests are specifically about reading a genuine v1
// artifact through the compat layer, so a local, self-contained fixture is
// also the more honest choice here regardless of the ruling.
const v1Manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: 'run-abc-001',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
  ...over,
})

const v1Primary = {
  totalTokens: '12345', wallClockMs: '45000', costUsd: 0.045, stepCount: 12, toolCallCount: 25, successRank: 4, maxParallelism: 1,
}
const v1Secondary = {
  inputTokens: '6000', outputTokens: '4000', reasoningTokens: '0', cacheReadTokens: '0',
  perTool: {}, reasoningTimeMs: '0', stepLatencyP50Ms: '100', stepLatencyP95Ms: '200', toolLatencyAvgMs: '50',
  finishCauseDistribution: { stop: 1 }, maxConsecutiveSameTool: 1,
}
const v1Dist = (median: number) => ({ median, min: median, max: median, samples: [median] })
const v1Stats = {
  totalTokens: v1Dist(12345), wallClockMs: v1Dist(45000), costUsd: v1Dist(0.045), stepCount: v1Dist(12), toolCallCount: v1Dist(25), successRank: v1Dist(4),
}
const v1SideAggregates = (side: 'old' | 'new'): Record<string, unknown> => ({
  side, primary: v1Primary, secondary: v1Secondary, stats: v1Stats, failedRuns: [], rawRunIds: [`session-${side}-1`],
})
const v1MetricDelta = { absolute: -1358, percent: -11.0, significant: true, better: 'better' as const }
const v1PrimaryDeltas = {
  totalTokens: v1MetricDelta, wallClockMs: v1MetricDelta, costUsd: v1MetricDelta, stepCount: v1MetricDelta,
  toolCallCount: v1MetricDelta, successRank: v1MetricDelta, maxParallelism: v1MetricDelta,
}
const v1DiffResult = (side: 'old' | 'new'): Record<string, unknown> => ({
  side,
  runs: [{ runIndex: 1, fullPatch: 'diff --git a/x b/x\n', summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] }, noChanges: false }],
})

/** A genuinely v1-shaped report.json (schemaVersion absent, side literals) — see the note above. */
const v1Report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifest: v1Manifest(),
  metricsDiff: { old: v1SideAggregates('old'), new: v1SideAggregates('new'), deltas: v1PrimaryDeltas, bothFailed: false },
  timeline: { old: [], new: [], mode: 'side-by-side' },
  diff: { old: v1DiffResult('old'), new: v1DiffResult('new') },
  summary: { headlineResult: 'new is faster', improvements: [v1MetricDelta], regressions: [], neutral: [], failures: [] },
  ...over,
})

const makeManifestV2 = (over: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 2,
  runId: 'run-abc-001',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  parallel: 2,
  baseline: 'base',
  packs: [],
  variants: [{ name: 'base', packs: [] }],
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
  ...over,
})

const seedRun = async (
  workspace: string,
  runId: string,
  timestamp: string,
  report = true,
): Promise<void> => {
  const dir = path.join(workspace, runId)
  await runP(ensureDir(path.join(dir, 'results')))
  const manifest = makeManifestV2({ runId, timestamp })
  await runP(writeJson(path.join(dir, 'manifest.json'), manifest))
  if (report) {
    const rep = makeReportV2({ manifest })
    await runP(writeJson(path.join(dir, 'results', 'report.json'), rep))
  }
}

describe('cli/workspace-runs', () => {
  it('resolveWorkspace defaults to .testaipack', () => {
    expect(resolveWorkspace(undefined)).toBe('.testaipack')
    expect(resolveWorkspace('')).toBe('.testaipack')
    expect(resolveWorkspace('/abs/x')).toBe('/abs/x')
  })

  it('listRuns returns runs sorted by timestamp desc', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'run-b', '2025-01-02T00:00:00.000Z')
    await seedRun(ws, 'run-a', '2025-01-01T00:00:00.000Z')
    await seedRun(ws, 'run-c', '2025-01-03T00:00:00.000Z')
    const runs = await runP(listRuns(ws))
    expect(runs.map((r) => r.runId)).toEqual(['run-c', 'run-b', 'run-a'])
  })

  it('listRuns ignores dirs without manifest.json', async () => {
    const ws = makeTempDir()
    await runP(ensureDir(path.join(ws, 'junk')))
    await seedRun(ws, 'run-1', '2025-01-01T00:00:00.000Z')
    const runs = await runP(listRuns(ws))
    expect(runs.length).toBe(1)
  })

  it('listRuns on missing workspace returns []', async () => {
    const runs = await runP(listRuns(path.join(makeTempDir(), 'nope')))
    expect(runs).toEqual([])
  })

  it('findRun(default) returns the most recent', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'old', '2025-01-01T00:00:00.000Z')
    await seedRun(ws, 'new', '2025-01-02T00:00:00.000Z')
    const r = await runP(findRun(ws, undefined))
    expect(r?.runId).toBe('new')
  })

  it('findRun(by id substring) matches dir suffix', async () => {
    const ws = makeTempDir()
    await seedRun(ws, '2025-01-01_run-x', '2025-01-01T00:00:00.000Z')
    const r = await runP(findRun(ws, 'run-x'))
    expect(r?.runId).toBe('2025-01-01_run-x')
  })

  it('findRun returns null when none match', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'a', '2025-01-01T00:00:00.000Z')
    const r = await runP(findRun(ws, 'nope'))
    expect(r).toBeNull()
  })

  it('a v2 run reports schemaVersion 2 and its manifest verbatim', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'v2-run', '2025-01-01T00:00:00.000Z')
    const r = await runP(findRun(ws, undefined))
    expect(r?.schemaVersion).toBe(2)
    expect(r?.manifest.baseline).toBe('base')
    expect(r?.manifest.variants.map((v) => v.name)).toEqual(['base'])
  })

  // ---------------------------------------------------------------------------
  // v1 compat — a pre-n-way-variants workspace (schemaVersion absent)
  // ---------------------------------------------------------------------------

  it('listRuns/findRun read a v1 (schemaVersion-absent) manifest.json through the compat mapping', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'v1-run')
    await runP(ensureDir(dir))
    const manifest = v1Manifest({ runId: 'v1-run', timestamp: '2025-01-01T00:00:00.000Z', packRef: 'https://example.com/pack.git' })
    await runP(writeJson(path.join(dir, 'manifest.json'), manifest))

    const r = await runP(findRun(ws, undefined))
    expect(r?.runId).toBe('v1-run')
    expect(r?.schemaVersion).toBe(1)
    expect(r?.manifest.schemaVersion).toBe(2)
    expect(r?.manifest.baseline).toBe('old')
    expect(r?.manifest.variants.map((v) => v.name)).toEqual(['old', 'new'])
    expect(r?.manifest.packs.map((p) => p.name)).toEqual(['pack'])
    expect(r?.manifest.flagDefaults['migratedFromV1']).toBe(true)

    const runs = await runP(listRuns(ws))
    expect(runs).toHaveLength(1)
    expect(runs[0]?.schemaVersion).toBe(1)
  })

  it('readReport maps a v1 report.json to v2: variants old/new, diffs/timeline/summary reshaped', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'v1-run')
    await runP(ensureDir(path.join(dir, 'results')))
    const report = v1Report()
    await runP(writeJson(path.join(dir, 'results', 'report.json'), report))

    const rep = await runP(readReport(path.join(dir, 'results')))
    expect(rep).not.toBeNull()
    expect(rep?.schemaVersion).toBe(2)
    expect(rep?.metrics.variants.map((v) => v.variant)).toEqual(['old', 'new'])
    expect(rep?.metrics.baseline).toBe('old')
    expect(rep?.diffs.map((d) => d.variant)).toEqual(['old', 'new'])
    expect(rep?.timeline.lanes.map((l) => l.variant)).toEqual(['old', 'new'])
    expect(rep?.summary.perVariant.map((v) => v.variant)).toEqual(['new'])
  })

  it('readReport returns null when report.json absent', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r', '2025-01-01T00:00:00.000Z', false)
    const runs = await runP(listRuns(ws))
    const rep = await runP(readReport(runs[0]!.resultsDir))
    expect(rep).toBeNull()
  })

  it('readReport still loads a v2 report.json carrying an unrecognized extra field (unknown keys are silently dropped, not rejected)', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'extra-field', '2025-01-01T00:00:00.000Z', false)
    const runs = await runP(listRuns(ws))
    const resultsDir = runs[0]!.resultsDir
    await runP(ensureDir(resultsDir))
    const current = makeReportV2()
    const withExtraField = {
      ...current,
      metrics: {
        ...current.metrics,
        variants: current.metrics.variants.map((v, i) =>
          i === 0 ? { ...v, secondary: { ...v.secondary, fileDiffStats: { additions: 20, deletions: 5, filesChanged: 3 } } } : v,
        ),
      },
    }
    await runP(writeJson(path.join(resultsDir, 'report.json'), withExtraField))
    const rep = await runP(readReport(resultsDir))
    expect(rep).not.toBeNull()
    expect(rep?.manifest.runId).toBe(current.manifest.runId)
    const parsedSecondary = rep?.metrics.variants[0]?.secondary as unknown as Record<string, unknown>
    expect(parsedSecondary['fileDiffStats']).toBeUndefined()
  })

  it('planGc --keep-last keeps newest N', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r1', '2025-01-01T00:00:00.000Z')
    await seedRun(ws, 'r2', '2025-01-02T00:00:00.000Z')
    await seedRun(ws, 'r3', '2025-01-03T00:00:00.000Z')
    const plan = await runP(planGc(ws, { keepLast: 1 }))
    expect(plan.delete.length).toBe(2)
    expect(plan.keep.length).toBe(1)
    expect(plan.keep[0]?.runId).toBe('r3')
  })

  it('planGc --aggressive prunes home/, apps/ and gitdirs/ from kept runs', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r1', '2025-01-01T00:00:00.000Z')
    const plan = await runP(planGc(ws, { aggressive: true }))
    expect(plan.delete).toEqual([])
    expect(plan.pruneHome.some((p) => p.endsWith('home'))).toBe(true)
    expect(plan.pruneHome.some((p) => p.endsWith('apps'))).toBe(true)
    // --protect-git relocates each run's git dir into gitdirs/, outside apps/
    // and home/ — aggressive gc must reclaim it too, or a full clone per run
    // survives forever, which is most of what --aggressive exists to free.
    expect(plan.pruneHome.some((p) => p.endsWith('gitdirs'))).toBe(true)
  })

  it('executeGc deletes targeted dirs', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r1', '2025-01-01T00:00:00.000Z')
    await seedRun(ws, 'r2', '2025-01-02T00:00:00.000Z')
    const plan = await runP(planGc(ws, { keepLast: 1 }))
    const res = await runP(executeGc(plan))
    expect(res.deleted.length).toBe(1)
    const remaining = await runP(listRuns(ws))
    expect(remaining.length).toBe(1)
  })

  it('executeGc prunes home/apps subdirs in aggressive mode', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r1', '2025-01-01T00:00:00.000Z')
    const runDir = path.join(ws, 'r1')
    await runP(ensureDir(path.join(runDir, 'home', 'base', 'run-1')))
    await runP(writeFile(path.join(runDir, 'home', 'base', 'run-1', 'marker'), 'x'))
    const plan = await runP(planGc(ws, { aggressive: true }))
    await runP(executeGc(plan))
    // home dir pruned, manifest still present
    const runs = await runP(listRuns(ws))
    expect(runs.length).toBe(1)
  })

  it('executeGc prunes gitdirs/ (the --protect-git relocated clones) in aggressive mode', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r1', '2025-01-01T00:00:00.000Z')
    const runDir = path.join(ws, 'r1')
    const gitDirMarker = path.join(runDir, 'gitdirs', 'base', 'run-1', 'HEAD')
    await runP(ensureDir(path.join(runDir, 'gitdirs', 'base', 'run-1')))
    await runP(writeFile(gitDirMarker, 'ref: refs/heads/main\n'))
    const plan = await runP(planGc(ws, { aggressive: true }))
    await runP(executeGc(plan))
    expect(existsSync(gitDirMarker)).toBe(false)
    const runs = await runP(listRuns(ws))
    expect(runs.length).toBe(1)
  })
})
