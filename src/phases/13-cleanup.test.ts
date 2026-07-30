import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { shimPair, makeWorkspaceTree } from '../../tests/helpers/variants.js'
import { ensureDir, readFile, removeDir, writeFile } from '../util/fs.js'
import { FsError } from '../util/fs.js'
import { cleanup } from './13-cleanup.js'
import type { Manifest, RunInput, WorkspaceTree } from '@generated/types'

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, removeDir: vi.fn(actual.removeDir) }
})

const removeDirMock = vi.mocked(removeDir)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const makeRunInput = (): RunInput => shimPair().runInput

const makeManifest = (): Manifest => {
  const { runInput } = shimPair()
  return {
    schemaVersion: 2,
    runId: 'rid',
    timestamp: new Date().toISOString(),
    repoUrl: runInput.repoUrl,
    runs: runInput.runs,
    parallel: runInput.parallel,
    baseline: runInput.baseline,
    packs: runInput.packs,
    variants: runInput.variants,
    isolation: runInput.isolation,
    opencodeVersion: 'test',
    flagDefaults: {},
  }
}

const buildWorkspaceTree = async (runs = 1): Promise<WorkspaceTree> => {
  const root = makeTempDir()
  const workspace = makeWorkspaceTree(root, runs, ['old', 'new'])
  for (const p of [
    path.join(workspace.root, 'apps'),
    path.join(workspace.root, 'home'),
    path.join(workspace.root, 'gitdirs'),
    workspace.pack,
    workspace.config,
    workspace.results,
  ]) {
    await runP(ensureDir(p))
  }
  await runP(writeFile(path.join(workspace.pack, 'marker.txt'), 'pack\n'))
  await runP(writeFile(path.join(workspace.root, 'gitdirs', 'marker.txt'), 'gitdirs\n'))
  return workspace
}

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  removeDirMock.mockImplementation(actual.removeDir)
})

describe('cleanup — ephemeral off (default)', () => {
  it('deletes nothing and writes gc.log noting retention is on', async () => {
    const workspace = await buildWorkspaceTree()
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: false }),
    )
    expect(result.deleted).toEqual([])
    expect(result.gcLogPath).toBe(path.join(workspace.results, 'gc.log'))
    expect(result.gcLogPath).not.toBe('')
    expect(existsSync(result.gcLogPath)).toBe(true)
    const log = await runP(readFile(result.gcLogPath))
    expect(log).toContain('cleanup skipped (retention on)')
    expect(existsSync(path.join(workspace.root, 'apps'))).toBe(true)
    expect(existsSync(workspace.pack)).toBe(true)
  })

  it('kept contains results and every variant path (apps/homes/gitDirs), covering all variants (02-phases.md §13 AC)', async () => {
    const workspace = await buildWorkspaceTree()
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: false }),
    )
    expect(result.kept).toContain(workspace.results)
    expect(result.kept).toContain(workspace.config)
    expect(result.kept).toContain(workspace.pack)
    expect(workspace.variantTrees).toHaveLength(2)
    for (const vt of workspace.variantTrees) {
      for (const a of vt.apps) expect(result.kept).toContain(a)
      for (const h of vt.homes) expect(result.kept).toContain(h)
      for (const g of vt.gitDirs) expect(result.kept).toContain(g)
    }
  })
})

describe('cleanup — ephemeral on', () => {
  it('removes apps/, home/, gitdirs/, pack/ and keeps results/', async () => {
    const workspace = await buildWorkspaceTree()
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: true }),
    )
    expect(result.deleted).toHaveLength(4)
    expect(result.deleted).toContain(path.join(workspace.root, 'apps'))
    expect(result.deleted).toContain(path.join(workspace.root, 'home'))
    expect(result.deleted).toContain(path.join(workspace.root, 'gitdirs'))
    expect(result.deleted).toContain(workspace.pack)
    expect(existsSync(path.join(workspace.root, 'apps'))).toBe(false)
    expect(existsSync(path.join(workspace.root, 'home'))).toBe(false)
    expect(existsSync(path.join(workspace.root, 'gitdirs'))).toBe(false)
    expect(existsSync(workspace.pack)).toBe(false)
    expect(existsSync(workspace.results)).toBe(true)
    expect(result.kept).toContain(workspace.results)
  })

  it('writes gc.log describing the deletions', async () => {
    const workspace = await buildWorkspaceTree()
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: true }),
    )
    expect(result.gcLogPath).toBe(path.join(workspace.results, 'gc.log'))
    expect(existsSync(result.gcLogPath)).toBe(true)
    const log = await runP(readFile(result.gcLogPath))
    expect(log).toContain('ephemeral cleanup')
    expect(log).toContain(`deleted ${path.join(workspace.root, 'apps')}`)
  })

  it('deleting a non-existent directory does not crash (force rm)', async () => {
    const workspace = await buildWorkspaceTree()
    // pack already exists; pre-remove home so removal of a missing dir is exercised
    await runP(removeDir(path.join(workspace.root, 'home')))
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: true }),
    )
    expect(result.deleted).toContain(path.join(workspace.root, 'home'))
  })

  it('keeps config and results in kept', async () => {
    const workspace = await buildWorkspaceTree()
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: true }),
    )
    expect(result.kept).toContain(workspace.config)
    expect(result.kept).toContain(workspace.results)
    // transient dirs are not in kept
    expect(result.kept).not.toContain(path.join(workspace.root, 'apps'))
    expect(result.kept).not.toContain(path.join(workspace.root, 'gitdirs'))
  })
})

describe('cleanup — soft failure', () => {
  it('removal failure never fails the run; undeleted dirs land in kept and gc.log', async () => {
    const workspace = await buildWorkspaceTree()
    removeDirMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'apps', operation: 'removeDir', cause: new Error('ROFS') })),
    )
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: true }),
    )
    expect(result.deleted).toEqual([])
    expect(result.kept).toContain(path.join(workspace.root, 'apps'))
    expect(result.kept).toContain(path.join(workspace.root, 'home'))
    expect(result.kept).toContain(workspace.pack)
    expect(existsSync(workspace.results)).toBe(true)
    const log = await runP(readFile(result.gcLogPath))
    expect(log).toContain('WARN failed to delete')
    expect(log).toContain(path.join(workspace.root, 'apps'))
  })

  it('gc.log append failure does not crash the run', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const workspace = await buildWorkspaceTree()
    // sabotage appendFile via a directory-as-file trick: gc.log path is a dir
    await runP(ensureDir(path.join(workspace.results, 'gc.log')))
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: true }),
    )
    expect(result.deleted).toContain(path.join(workspace.root, 'apps'))
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
