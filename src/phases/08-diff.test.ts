import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile } from '../util/fs.js'
import { diff } from './08-diff.js'
import { PhaseError } from '../errors.js'
import type { Manifest, RunInput, WorkspaceTree } from '@generated/types'

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

vi.mock('../util/git.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/git.js')>('../util/git.js')
  return {
    ...actual,
    addAll: vi.fn(actual.addAll),
    diffCached: vi.fn(actual.diffCached),
    diffStatFull: vi.fn(actual.diffStatFull),
  }
})

import { FsError } from '../util/fs.js'
import { GitError, init, addAll, commit, diffCached, diffStatFull } from '../util/git.js'

const writeFileMock = vi.mocked(writeFile)
const addAllMock = vi.mocked(addAll)
const diffCachedMock = vi.mocked(diffCached)
const diffStatFullMock = vi.mocked(diffStatFull)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const makeRunInput = (over: Partial<RunInput>): RunInput => ({
  repoUrl: '',
  prompt: 'p',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: false, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  pureBaseline: true,
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  collapseRepeats: true,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60, runSeconds: 600, verifySeconds: 300,
    installSeconds: 300, watchdogSeconds: 1200,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  ...over,
})

const makeManifest = (runInput: RunInput): Manifest => ({
  runId: 'rid',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: runInput.repoUrl,
  prompt: runInput.prompt,
  runs: runInput.runs,
  isolation: runInput.isolation,
  opencodeVersion: 'test',
  flagDefaults: {},
})

const makeWorkspace = (runs: number): WorkspaceTree => {
  const root = makeTempDir()
  const range = Array.from({ length: runs }, (_, i) => i + 1)
  const tree: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'apps', 'source'),
    appsOld: range.map((n) => path.join(root, 'apps', 'oldVersion', `run-${String(n)}`)),
    appsNew: range.map((n) => path.join(root, 'apps', 'newVersion', `run-${String(n)}`)),
    pack: path.join(root, 'pack'),
    homeOld: [],
    homeNew: [],
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'results', 'raw'),
    diff: path.join(root, 'results', 'diff'),
  }
  return tree
}

/** Build a real git repo at dir with one committed file, ready for agent edits. */
const buildRepo = async (dir: string): Promise<void> => {
  await runP(ensureDir(dir))
  await runP(init(dir))
  await runP(writeFile(path.join(dir, 'a.txt'), 'a\n'))
  await runP(addAll(dir))
  await runP(commit(dir, 'init'))
}

const buildRepos = async (tree: WorkspaceTree): Promise<void> => {
  for (const dir of [...tree.appsOld, ...tree.appsNew]) {
    await buildRepo(dir)
  }
}

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  writeFileMock.mockImplementation(fsActual.writeFile)
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const gitActual = await vi.importActual<typeof import('../util/git.js')>('../util/git.js')
  addAllMock.mockImplementation(gitActual.addAll)
  diffCachedMock.mockImplementation(gitActual.diffCached)
  diffStatFullMock.mockImplementation(gitActual.diffStatFull)
})

describe('diff — happy path', () => {
  it('agent edited 2 files -> non-empty patch, summary.filesChanged=2, noChanges false', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    const oldDir = tree.appsOld[0] ?? ''
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(writeFile(path.join(oldDir, 'new.txt'), 'fresh\n'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))

    const run = result.diff.old.runs[0] ?? result.diff.old.runs[0]
    expect(run).toBeDefined()
    const r = run!
    expect(r.noChanges).toBe(false)
    expect(r.fullPatch.length).toBeGreaterThan(0)
    expect(r.summary.filesChanged).toBe(2)
    expect(r.summary.additions).toBeGreaterThanOrEqual(2)
    expect(r.summary.perFile).toHaveLength(2)
    expect(r.htmlPath).toBeUndefined()
    // files were persisted
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'full.patch'))).toBe(true)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'summary.json'))).toBe(true)
  })

  it('N=3 -> three DiffRunResult per side', async () => {
    const tree = makeWorkspace(3)
    await buildRepos(tree)
    for (const dir of [...tree.appsOld, ...tree.appsNew]) {
      await runP(writeFile(path.join(dir, 'a.txt'), 'changed\n'))
    }
    const runInput = makeRunInput({ runs: 3 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(result.diff.old.runs).toHaveLength(3)
    expect(result.diff.new.runs).toHaveLength(3)
    expect(result.diff.old.runs.map((r) => r.runIndex)).toEqual([1, 2, 3])
    expect(result.diff.old.side).toBe('old')
    expect(result.diff.new.side).toBe('new')
  })
})

describe('diff — no changes', () => {
  it('clean working tree -> noChanges true, empty patch', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = result.diff.old.runs[0]!
    expect(r.noChanges).toBe(true)
    expect(r.fullPatch).toBe('')
    expect(r.summary.filesChanged).toBe(0)
    expect(r.summary.perFile).toEqual([])
  })
})

describe('diff — html', () => {
  it('diffHtml=true -> side.html created with embedded CSS, htmlPath set', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    await runP(writeFile(path.join(tree.appsOld[0] ?? '', 'a.txt'), 'edit\n'))
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = result.diff.old.runs[0]!
    expect(r.htmlPath).toBeDefined()
    expect(existsSync(r.htmlPath!)).toBe(true)
    const html = await runP(readFile(r.htmlPath!))
    expect(html).toContain('<style>')
  })

  it('diffHtml=false -> htmlPath omitted', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    const runInput = makeRunInput({ runs: 1, diffHtml: false })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(result.diff.old.runs[0]!.htmlPath).toBeUndefined()
  })
})

describe('diff — perFile stat parsing', () => {
  it('2 files changed -> perFile has 2 entries with paths', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    const dir = tree.appsOld[0] ?? ''
    await runP(writeFile(path.join(dir, 'a.txt'), 'x\n'))
    await runP(writeFile(path.join(dir, 'b.txt'), 'y\n'))
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const perFile = result.diff.old.runs[0]!.summary.perFile
    expect(perFile).toHaveLength(2)
    const paths = perFile.map((f) => f.path).sort()
    expect(paths).toEqual(['a.txt', 'b.txt'])
  })
})

describe('diff — errors', () => {
  it('no .git in destDir -> E_DISK_FULL with reason no-git-dir', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    const oldDir = tree.appsOld[0] ?? ''
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('no-git-dir')
    expect(err.context?.['runIndex']).toBe(1)
  })

  it('ENOSPC on writing full.patch -> E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    await runP(writeFile(path.join(tree.appsOld[0] ?? '', 'a.txt'), 'edit\n'))
    writeFileMock.mockImplementation(() =>
      Effect.fail(
        new FsError({
          path: 'full.patch',
          operation: 'writeFile',
          cause: new Error('ENOSPC: no space left on device'),
        }),
      ),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['runIndex']).toBe(1)
  })

  it('ENOSPC on writing summary.json -> E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    await runP(writeFile(path.join(tree.appsOld[0] ?? '', 'a.txt'), 'edit\n'))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    writeFileMock.mockImplementation((p, content) =>
      p.includes('summary.json')
        ? Effect.fail(new FsError({ path: p, operation: 'writeFile', cause: new Error('ENOSPC') }))
        : fsActual.writeFile(p, content),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.message).toContain('summary.json')
  })

  it('ENOSPC on writing side.html (diffHtml=true) -> E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    await runP(writeFile(path.join(tree.appsOld[0] ?? '', 'a.txt'), 'edit\n'))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    writeFileMock.mockImplementation((p, content) =>
      p.includes('side.html')
        ? Effect.fail(new FsError({ path: p, operation: 'writeFile', cause: new Error('ENOSPC') }))
        : fsActual.writeFile(p, content),
    )
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.message).toContain('side.html')
  })
})

describe('diff — git failures', () => {
  it('git add -A fails -> E_DISK_FULL with reason git-failure', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    addAllMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'add', exitCode: 128, stderr: 'bad index' })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('git-failure')
    expect(err.context?.['command']).toBe('add')
  })

  it('git diff --cached fails -> E_DISK_FULL git-failure', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    diffCachedMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'diff', exitCode: 129, stderr: 'diff broken' })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('git-failure')
    expect(err.context?.['command']).toBe('diff')
  })

  it('git diff --numstat fails -> E_DISK_FULL git-failure', async () => {
    const tree = makeWorkspace(1)
    await buildRepos(tree)
    diffStatFullMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'numstat-full', exitCode: 1, stderr: 'numstat broken' })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('git-failure')
  })
})
