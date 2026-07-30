import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeWorkspace, makeRunInput, makeManifest } from '../../tests/report-fixture.js'
import { ensureDir, readFile, removeDir, writeFile } from '../util/fs.js'
import { FsError } from '../util/fs.js'
import { cleanup } from './13-cleanup.js'

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, removeDir: vi.fn(actual.removeDir) }
})

const removeDirMock = vi.mocked(removeDir)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const buildWorkspaceTree = async (runs = 1): Promise<ReturnType<typeof makeWorkspace>> => {
  const workspace = makeWorkspace(runs)
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

  it('kept contains results and the workspace paths', async () => {
    const workspace = await buildWorkspaceTree()
    const result = await runP(
      cleanup({ runInput: makeRunInput(), manifest: makeManifest(), workspace, ephemeral: false }),
    )
    expect(result.kept).toContain(workspace.results)
    expect(result.kept).toContain(workspace.config)
    expect(result.kept).toContain(workspace.pack)
    for (const p of [...workspace.gitDirsOld, ...workspace.gitDirsNew]) {
      expect(result.kept).toContain(p)
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
