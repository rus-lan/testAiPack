import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
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
import {
  makeManifest,
  makeReport,
} from '../../tests/report-fixture.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const seedRun = async (
  workspace: string,
  runId: string,
  timestamp: string,
  report = true,
): Promise<void> => {
  const dir = path.join(workspace, runId)
  await runP(ensureDir(path.join(dir, 'results')))
  const manifest = makeManifest({ runId, timestamp })
  await runP(writeJson(path.join(dir, 'manifest.json'), manifest))
  if (report) {
    const rep = makeReport({ manifest })
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

  it('readReport returns null when report.json absent', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r', '2025-01-01T00:00:00.000Z', false)
    const runs = await runP(listRuns(ws))
    const rep = await runP(readReport(runs[0]!.resultsDir))
    expect(rep).toBeNull()
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

  it('planGc --aggressive prunes home/ and apps/ from kept runs', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'r1', '2025-01-01T00:00:00.000Z')
    const plan = await runP(planGc(ws, { aggressive: true }))
    expect(plan.delete).toEqual([])
    expect(plan.pruneHome.some((p) => p.endsWith('home'))).toBe(true)
    expect(plan.pruneHome.some((p) => p.endsWith('apps'))).toBe(true)
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
    await runP(ensureDir(path.join(runDir, 'home', 'old', 'run-1')))
    await runP(writeFile(path.join(runDir, 'home', 'old', 'run-1', 'marker'), 'x'))
    const plan = await runP(planGc(ws, { aggressive: true }))
    await runP(executeGc(plan))
    // home dir pruned, manifest still present
    const runs = await runP(listRuns(ws))
    expect(runs.length).toBe(1)
  })
})
