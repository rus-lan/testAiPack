import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { makeTempDir } from '../../tests/setup.js'
import { makeWorkspaceTree } from '../../tests/helpers/variants.js'
import { copyDir, ensureDir, moveDir, readFile, removeDir, writeFile, writeJson } from '../util/fs.js'
import { diff } from './08-diff.js'
import { PhaseError } from '../errors.js'
import type { DiffResult, DiffResultOutput, Manifest, RunInput, WorkspaceTree } from '@generated/types'

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    copyDir: vi.fn(actual.copyDir),
    removeDir: vi.fn(actual.removeDir),
    moveDir: vi.fn(actual.moveDir),
    ensureDir: vi.fn(actual.ensureDir),
  }
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
import { GitError, init, addAll, commit, diffCached, diffStatFull, lsFilesStage } from '../util/git.js'

const writeFileMock = vi.mocked(writeFile)
const copyDirMock = vi.mocked(copyDir)
const removeDirMock = vi.mocked(removeDir)
const moveDirMock = vi.mocked(moveDir)
const ensureDirMock = vi.mocked(ensureDir)
const addAllMock = vi.mocked(addAll)
const diffCachedMock = vi.mocked(diffCached)
const diffStatFullMock = vi.mocked(diffStatFull)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const makeRunInput = (over: Partial<RunInput> = {}): RunInput => ({
  schemaVersion: 2,
  repoUrl: '',
  prompt: 'p',
  runs: 1,
  parallel: 2,
  baseline: 'old',
  packs: [],
  variants: [
    { name: 'old', packs: [] },
    { name: 'new', packs: [] },
  ],
  isolation: 'home',
  auth: {
    opencode: false, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  protectGit: false,
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
  schemaVersion: 2,
  runId: 'rid',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: runInput.repoUrl,
  ...(runInput.prompt === undefined ? {} : { prompt: runInput.prompt }),
  runs: runInput.runs,
  parallel: runInput.parallel,
  baseline: runInput.baseline,
  packs: runInput.packs,
  variants: runInput.variants,
  isolation: runInput.isolation,
  opencodeVersion: 'test',
  flagDefaults: {},
})

/** Path-only workspace tree (nothing on disk yet) for `names`, defaulting to the shim's old/new pair. */
const makeWorkspace = (runs: number, names: readonly string[] = ['old', 'new']): WorkspaceTree =>
  makeWorkspaceTree(makeTempDir(), runs, [...names])

const appDir = (tree: WorkspaceTree, name: string, runIndex = 1): string =>
  tree.variantTrees.find((vt) => vt.name === name)?.apps[runIndex - 1] ?? ''

const gitDirOf = (tree: WorkspaceTree, name: string, runIndex = 1): string =>
  tree.variantTrees.find((vt) => vt.name === name)?.gitDirs[runIndex - 1] ?? ''

const allAppDirs = (tree: WorkspaceTree): readonly string[] => tree.variantTrees.flatMap((vt) => vt.apps)

const withVariantGitDirs = (tree: WorkspaceTree, name: string, gitDirs: readonly string[]): WorkspaceTree => ({
  ...tree,
  variantTrees: tree.variantTrees.map((vt) => (vt.name === name ? { ...vt, gitDirs: [...gitDirs] } : vt)),
})

const diffResultFor = (output: DiffResultOutput, name: string): DiffResult => {
  const d = output.diffs.find((x) => x.variant === name)
  if (d === undefined) throw new Error(`no diff result for variant ${name}`)
  return d
}

/** Build a real git repo at dir with one committed file, ready for agent edits. */
const buildRepo = async (dir: string): Promise<void> => {
  await runP(ensureDir(dir))
  await runP(init(dir))
  await runP(writeFile(path.join(dir, 'a.txt'), 'a\n'))
  await runP(addAll(dir))
  await runP(commit(dir, 'init'))
}

/** Mirrors phase 02: build the pristine repo at `appsSource`, then copy it into every variant's run dirs. */
const buildReposFromSource = async (tree: WorkspaceTree): Promise<void> => {
  await buildRepo(tree.appsSource)
  for (const dir of allAppDirs(tree)) {
    await runP(copyDir(tree.appsSource, dir))
  }
}

/** Mirrors phase 02 under --protect-git: copy from source, then move .git to gitDirs, per variant. */
const buildProtectedRepos = async (tree: WorkspaceTree): Promise<void> => {
  await buildRepo(tree.appsSource)
  const pairs = tree.variantTrees.flatMap((vt) =>
    vt.apps.map((dest, i) => ({ dest, gitDir: vt.gitDirs[i] ?? '' })),
  )
  for (const { dest, gitDir } of pairs) {
    await runP(copyDir(tree.appsSource, dest))
    await runP(ensureDir(path.dirname(gitDir)))
    await runP(moveDir(path.join(dest, '.git'), gitDir))
  }
}

const stripStyle = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, '')

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  writeFileMock.mockImplementation(fsActual.writeFile)
  copyDirMock.mockImplementation(fsActual.copyDir)
  removeDirMock.mockImplementation(fsActual.removeDir)
  moveDirMock.mockImplementation(fsActual.moveDir)
  ensureDirMock.mockImplementation(fsActual.ensureDir)
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const gitActual = await vi.importActual<typeof import('../util/git.js')>('../util/git.js')
  addAllMock.mockImplementation(gitActual.addAll)
  diffCachedMock.mockImplementation(gitActual.diffCached)
  diffStatFullMock.mockImplementation(gitActual.diffStatFull)
})

describe('diff — happy path', () => {
  it('agent edited 2 files -> non-empty patch, summary.filesChanged=2, noChanges false, state ok', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(writeFile(path.join(oldDir, 'new.txt'), 'fresh\n'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))

    const r = diffResultFor(result, 'old').runs[0]
    expect(r).toBeDefined()
    const run = r!
    expect(run.state).toBe('ok')
    expect(run.noChanges).toBe(false)
    expect(run.fullPatch.length).toBeGreaterThan(0)
    expect(run.summary.filesChanged).toBe(2)
    expect(run.summary.additions).toBeGreaterThanOrEqual(2)
    expect(run.summary.perFile).toHaveLength(2)
    expect(run.htmlPath).toBeUndefined()
    // files were persisted
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'full.patch'))).toBe(true)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'summary.json'))).toBe(true)
  })

  it('N=3 runs -> three DiffRunResult per variant', async () => {
    const tree = makeWorkspace(3)
    await buildReposFromSource(tree)
    for (const dir of allAppDirs(tree)) {
      await runP(writeFile(path.join(dir, 'a.txt'), 'changed\n'))
    }
    const runInput = makeRunInput({ runs: 3 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(diffResultFor(result, 'old').runs).toHaveLength(3)
    expect(diffResultFor(result, 'new').runs).toHaveLength(3)
    expect(diffResultFor(result, 'old').runs.map((r) => r.runIndex)).toEqual([1, 2, 3])
    expect(diffResultFor(result, 'old').variant).toBe('old')
    expect(diffResultFor(result, 'new').variant).toBe('new')
  })
})

describe('diff — no changes', () => {
  it('clean working tree -> noChanges true, empty patch', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.noChanges).toBe(true)
    expect(r.fullPatch).toBe('')
    expect(r.summary.filesChanged).toBe(0)
    expect(r.summary.perFile).toEqual([])
  })
})

describe('diff — html', () => {
  it('diffHtml=true -> side.html created with embedded CSS, htmlPath set', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.htmlPath).toBeDefined()
    expect(existsSync(r.htmlPath!)).toBe(true)
    const html = await runP(readFile(r.htmlPath!))
    expect(html).toContain('<style>')
  })

  it('side.html uses side-by-side layout with file list', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const html = await runP(readFile(diffResultFor(result, 'old').runs[0]!.htmlPath!))
    const body = stripStyle(html)
    expect(body).toContain('d2h-file-list')
    expect(body).toContain('d2h-files-diff')
    expect(html).toContain('run-1')
  })

  it('side.html is self-contained (inlined diff2html CSS, no external http(s) links)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const html = await runP(readFile(diffResultFor(result, 'old').runs[0]!.htmlPath!))
    expect(html).toContain('--d2h-bg-color')
    expect(html).not.toMatch(/src=["']https?:\/\//i)
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//i)
    expect(html).not.toMatch(/@import\s+url\s*\(\s*https?:\/\//i)
  })

  it('empty patch -> renderNothingWhenEmpty: file list shows 0, no diff file blocks', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.noChanges).toBe(true)
    const html = await runP(readFile(r.htmlPath!))
    expect(html).toContain('<html')
    expect(html).toContain('--d2h-bg-color')
    const body = stripStyle(html)
    expect(body).toContain('Files changed (0)')
    expect(body).not.toContain('d2h-file-wrapper')
  })

  it('diffHtml=false -> htmlPath omitted', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const runInput = makeRunInput({ runs: 1, diffHtml: false })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(diffResultFor(result, 'old').runs[0]!.htmlPath).toBeUndefined()
  })
})

describe('diff — perFile stat parsing', () => {
  it('2 files changed -> perFile has 2 entries with paths', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const dir = appDir(tree, 'old')
    await runP(writeFile(path.join(dir, 'a.txt'), 'x\n'))
    await runP(writeFile(path.join(dir, 'b.txt'), 'y\n'))
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const perFile = diffResultFor(result, 'old').runs[0]!.summary.perFile
    expect(perFile).toHaveLength(2)
    const paths = perFile.map((f) => f.path).sort()
    expect(paths).toEqual(['a.txt', 'b.txt'])
  })
})

describe('diff — recovery: missing .git', () => {
  it('no .git in destDir -> restored from apps/source, state git-restored, diff correct', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(writeFile(path.join(oldDir, 'new.txt'), 'fresh\n'))
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('git-restored')
    expect(r.error).toBeUndefined()
    expect(r.noChanges).toBe(false)
    expect(r.summary.filesChanged).toBe(2)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'full.patch'))).toBe(true)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'summary.json'))).toBe(true)
  })

  it('no .git anywhere (destDir and apps/source) -> failed run, phase succeeds', async () => {
    const tree = makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(r.error?.message).toContain('no .git in')
    expect(r.error?.message).toContain(tree.appsSource)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'full.patch'))).toBe(false)
  })

  it('restore failure (copyDir error) -> failed run', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    copyDirMock.mockImplementationOnce(() =>
      Effect.fail(new FsError({ path: oldDir, operation: 'copyDir', cause: new Error('boom') })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.message).toContain('restore .git')
  })

  it('restore failure is ENOSPC -> E_DISK_FULL, aborts the whole phase (not contained)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    copyDirMock.mockImplementationOnce(() =>
      Effect.fail(
        new FsError({ path: oldDir, operation: 'copyDir', cause: new Error('ENOSPC: no space left on device') }),
      ),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
  })
})

describe('diff — recovery: pack-exercise exclude re-apply after .git restore', () => {
  it('without an exercise record, a restored .git loses the exclude and the pack artifact leaks into the patch', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    // The exercise's own output was excluded in the agent's `.git` at
    // exercise time, but that `.git` is gone below and no
    // `run-1.exercise.json` was left for phase 08 to re-apply from.
    await runP(writeFile(path.join(oldDir, 'GRAPH_REPORT.md'), 'pack output\n'))
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('git-restored')
    expect(r.fullPatch).toContain('GRAPH_REPORT.md')
  })

  it('an exercise record re-applies the same exclude to the restored .git, so the pack artifact stays out of the patch', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'GRAPH_REPORT.md'), 'pack output\n'))
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(ensureDir(path.join(tree.raw, 'old')))
    await runP(
      writeJson(path.join(tree.raw, 'old', 'run-1.exercise.json'), { excludedPaths: ['GRAPH_REPORT.md'] }),
    )
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('git-restored')
    expect(r.fullPatch).not.toContain('GRAPH_REPORT.md')
    expect(r.fullPatch).toContain('a.txt')
    expect(r.summary.filesChanged).toBe(1)
  })
})

describe('diff — one broken run does not kill the others', () => {
  it('old run-1 broken (restore fails) -> old run-2 and both new runs stay ok', async () => {
    const tree = makeWorkspace(2)
    await buildReposFromSource(tree)
    await rm(path.join(appDir(tree, 'old', 1), '.git'), { recursive: true, force: true })
    // old run-1 is the only dir missing `.git`, so it is the only one that
    // calls restoreGit / copyDir — failing exactly that one call breaks only
    // that run, while run-2 and both new runs never call copyDir at all
    // (their own `.git` already matches apps/source).
    copyDirMock.mockImplementationOnce(() =>
      Effect.fail(new FsError({ path: appDir(tree, 'old', 1), operation: 'copyDir', cause: new Error('boom') })),
    )

    const runInput = makeRunInput({ runs: 2 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(diffResultFor(result, 'old').runs).toHaveLength(2)
    expect(diffResultFor(result, 'new').runs).toHaveLength(2)
    expect(diffResultFor(result, 'old').runs[0]!.state).toBe('failed')
    expect(diffResultFor(result, 'old').runs[1]!.state).toBe('ok')
    expect(diffResultFor(result, 'new').runs[0]!.state).toBe('ok')
    expect(diffResultFor(result, 'new').runs[1]!.state).toBe('ok')
  })
})

describe('diff — recovery: foreign .git', () => {
  it('agent ran git init -> foreign .git replaced, state git-replaced', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    await runP(init(oldDir))
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(writeFile(path.join(oldDir, 'new.txt'), 'fresh\n'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('git-replaced')
    expect(r.summary.filesChanged).toBe(2)
    expect(r.fullPatch).toContain('-a\n')
    // the foreign .git is preserved, not deleted — it is the only record of
    // what the agent did in git terms
    const preserved = path.join(tree.root, 'apps', 'agent-git', 'old', 'run-1')
    expect(existsSync(path.join(preserved, 'HEAD'))).toBe(true)
    // preserved outside destDir, so it never pollutes the diff it is meant to explain
    expect(existsSync(path.join(oldDir, 'agent-git'))).toBe(false)
    expect(r.fullPatch).not.toContain('agent-git')
  })

  it('agent committed its work -> state git-replaced, committed changes appear in full.patch', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(addAll(oldDir))
    await runP(commit(oldDir, 'agent commit'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('git-replaced')
    expect(r.noChanges).toBe(false)
    expect(r.fullPatch).toContain('-a\n')
    expect(r.fullPatch).toContain('+bb\n')
  })

  it('replace failure (moveDir error) -> failed run E_WORKTREE_BROKEN', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    await runP(init(oldDir))
    moveDirMock.mockImplementationOnce(() =>
      Effect.fail(new FsError({ path: oldDir, operation: 'moveDir', cause: new Error('boom') })),
    )

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(r.error?.message).toContain('move foreign .git')
  })

  it('moveDir ENOSPC during replace -> E_DISK_FULL, aborts the whole phase (not contained)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    await runP(init(oldDir))
    moveDirMock.mockImplementationOnce(() =>
      Effect.fail(new FsError({ path: oldDir, operation: 'moveDir', cause: new Error('ENOSPC: no space left on device') })),
    )

    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
  })

  it('source apps/source HEAD unreadable -> unverifiable runs are contained as failed, not silently "ok"', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await rm(path.join(tree.appsSource, '.git'), { recursive: true, force: true })

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const oldRun = diffResultFor(result, 'old').runs[0]!
    const newRun = diffResultFor(result, 'new').runs[0]!
    expect(oldRun.state).toBe('failed')
    expect(oldRun.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(oldRun.fullPatch).toBe('')
    expect(newRun.state).toBe('failed')
    expect(newRun.error?.code).toBe('E_WORKTREE_BROKEN')
  })

  it('source apps/source HEAD unreadable + agent committed its own work in destDir -> still contained as failed, not reported as "no changes"', async () => {
    // The incident this guards against: apps/source damaged, agent runs its
    // own `git init` + commit, so an unstaged `git add -A` in destDir would
    // find nothing to add and produce an empty "ok" patch — silently hiding
    // everything the agent did.
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    await runP(init(oldDir))
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'agent-changed\n'))
    await runP(addAll(oldDir))
    await runP(commit(oldDir, 'agent commit'))
    await rm(path.join(tree.appsSource, '.git'), { recursive: true, force: true })

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.noChanges).toBe(false)
    expect(r.fullPatch).toBe('')
  })
})

describe('diff — errors', () => {
  it('ENOSPC on writing full.patch -> E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
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
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    writeFileMock.mockImplementation((p, content) =>
      p.includes('summary.json')
        ? Effect.fail(new FsError({ path: p, operation: 'writeFile', cause: new Error('ENOSPC: no space left on device') }))
        : fsActual.writeFile(p, content),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.message).toContain('summary.json')
  })

  it('ENOSPC on writing side.html (diffHtml=true) -> E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    writeFileMock.mockImplementation((p, content) =>
      p.includes('side.html')
        ? Effect.fail(new FsError({ path: p, operation: 'writeFile', cause: new Error('ENOSPC: no space left on device') }))
        : fsActual.writeFile(p, content),
    )
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.message).toContain('side.html')
  })
})

describe('diff — non-disk-full fs failures are contained per-run, not aborted as disk-full', () => {
  it('EACCES on ensureDir(outDir) -> failed run E_WORKTREE_BROKEN, phase continues', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    ensureDirMock.mockImplementation((p) =>
      p.includes(path.join('diff', 'old'))
        ? Effect.fail(new FsError({ path: p, operation: 'ensureDir', cause: new Error('EACCES: permission denied') }))
        : fsActual.ensureDir(p),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(diffResultFor(result, 'new').runs[0]!.state).toBe('ok')
  })

  it('EACCES on writing full.patch -> failed run E_WORKTREE_BROKEN, not E_DISK_FULL, phase continues', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    writeFileMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'full.patch', operation: 'writeFile', cause: new Error('EACCES: permission denied') })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    for (const r of [...diffResultFor(result, 'old').runs, ...diffResultFor(result, 'new').runs]) {
      expect(r.state).toBe('failed')
      expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
    }
  })

  it('EACCES on writing summary.json -> failed run E_WORKTREE_BROKEN, not E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    writeFileMock.mockImplementation((p, content) =>
      p.includes('summary.json')
        ? Effect.fail(new FsError({ path: p, operation: 'writeFile', cause: new Error('EACCES: permission denied') }))
        : fsActual.writeFile(p, content),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
  })

  it('EACCES on writing side.html (diffHtml=true) -> failed run E_WORKTREE_BROKEN, not E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    await runP(writeFile(path.join(appDir(tree, 'old'), 'a.txt'), 'edit\n'))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    writeFileMock.mockImplementation((p, content) =>
      p.includes('side.html')
        ? Effect.fail(new FsError({ path: p, operation: 'writeFile', cause: new Error('EACCES: permission denied') }))
        : fsActual.writeFile(p, content),
    )
    const runInput = makeRunInput({ runs: 1, diffHtml: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
  })
})

describe('diff — containment: git command failures', () => {
  it('git add -A fails -> run marked failed with E_WORKTREE_BROKEN, phase succeeds', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    addAllMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'add', exitCode: 128, stderr: 'bad index' })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    for (const r of [...diffResultFor(result, 'old').runs, ...diffResultFor(result, 'new').runs]) {
      expect(r.state).toBe('failed')
      expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
      expect(r.error?.message).toContain('git add -A failed')
      expect(r.fullPatch).toBe('')
      expect(r.noChanges).toBe(false)
    }
  })

  it('git diff --cached fails -> failed run, E_WORKTREE_BROKEN', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    diffCachedMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'diff', exitCode: 129, stderr: 'diff broken' })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(r.error?.message).toContain('git diff --cached failed')
  })

  it('git diff --numstat fails -> failed run, E_WORKTREE_BROKEN', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    diffStatFullMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'numstat-full', exitCode: 1, stderr: 'numstat broken' })),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(r.error?.message).toContain('git diff --numstat failed')
  })

  it('git add -A fails with an ENOSPC-shaped stderr -> E_DISK_FULL, aborts the whole phase (not contained)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    addAllMock.mockImplementation(() =>
      Effect.fail(
        new GitError({ command: 'add', exitCode: 128, stderr: 'fatal: Unable to write new index file: No space left on device' }),
      ),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.message).toContain('git add -A failed')
  })

  it('ENOSPC-shaped stderr with trailing content (errno suffix) still matches -> E_DISK_FULL', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    addAllMock.mockImplementation(() =>
      Effect.fail(
        new GitError({ command: 'add', exitCode: 128, stderr: 'fatal: write error: No space left on device (28)' }),
      ),
    )
    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
  })

  it('a path spoofing "no space left on device" stays contained (git quotes embedded paths, defeating the colon anchor)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    addAllMock.mockImplementation(() =>
      Effect.fail(
        new GitError({
          command: 'add',
          exitCode: 128,
          stderr: "error: open('no space left on device'): Permission denied",
        }),
      ),
    )
    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
  })
})

describe('diff — protectGit', () => {
  it('happy: agent edit -> state ok, correct patch/summary, artifacts written', async () => {
    const tree = makeWorkspace(1)
    await buildProtectedRepos(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    await runP(writeFile(path.join(oldDir, 'new.txt'), 'fresh\n'))

    const runInput = makeRunInput({ runs: 1, protectGit: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.noChanges).toBe(false)
    expect(r.summary.filesChanged).toBe(2)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'full.patch'))).toBe(true)
    expect(existsSync(path.join(tree.diff, 'old', 'run-1', 'summary.json'))).toBe(true)
  })

  it('protected runs never have .git in the work tree -> state stays ok, recovery never fires (.git absent before and after)', async () => {
    const tree = makeWorkspace(1)
    await buildProtectedRepos(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
    expect(existsSync(path.join(oldDir, '.git'))).toBe(false)

    const runInput = makeRunInput({ runs: 1, protectGit: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    // pins "recovery bypassed": if restoreGit had fired it would have copied
    // apps/source/.git back into the work tree.
    expect(existsSync(path.join(oldDir, '.git'))).toBe(false)
  })

  it('agent recreated a top-level .git via git init -> patch identical to the same run without it (§7.1)', async () => {
    const runOnce = async (withGitInit: boolean) => {
      const tree = makeWorkspace(1)
      await buildProtectedRepos(tree)
      const oldDir = appDir(tree, 'old')
      await runP(writeFile(path.join(oldDir, 'a.txt'), 'bb\n'))
      if (withGitInit) await runP(init(oldDir))
      const runInput = makeRunInput({ runs: 1, protectGit: true })
      const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
      return diffResultFor(result, 'old').runs[0]!
    }
    const control = await runOnce(false)
    const withInit = await runOnce(true)
    expect(withInit.state).toBe('ok')
    expect(withInit.fullPatch).toBe(control.fullPatch)
    expect(withInit.summary).toEqual(control.summary)
  })

  it('agent nested-init foo/.git with a commit -> gitlink entry (160000) for foo, perFile shows 0/0 (§7.2)', async () => {
    // A nested repo needs a resolvable HEAD (at least one commit) to become a
    // gitlink entry — verified directly against real git: an uncommitted
    // nested `git init` makes `git add -A` fail outright (see the next test),
    // it does not produce the "noise" the spec describes.
    const tree = makeWorkspace(1)
    await buildProtectedRepos(tree)
    const oldDir = appDir(tree, 'old')
    const fooDir = path.join(oldDir, 'foo')
    await runP(ensureDir(fooDir))
    await runP(init(fooDir))
    await runP(writeFile(path.join(fooDir, 'x.txt'), 'hi\n'))
    await runP(addAll(fooDir))
    await runP(commit(fooDir, 'nested'))

    const runInput = makeRunInput({ runs: 1, protectGit: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.fullPatch).toContain('160000')
    // A new gitlink's numstat line is `1\t0\tfoo` (one "Subproject commit …"
    // text line, not `-\t-` binary-style) — verified directly against git
    // 2.53.0, not assumed.
    const fooEntry = r.summary.perFile.find((f) => f.path === 'foo')
    expect(fooEntry).toEqual({ path: 'foo', additions: 1, deletions: 0 })
  })

  it('agent nested-init foo/.git WITHOUT a commit -> git add -A fails, that run is contained as failed', async () => {
    const tree = makeWorkspace(1)
    await buildProtectedRepos(tree)
    const oldDir = appDir(tree, 'old')
    const fooDir = path.join(oldDir, 'foo')
    await runP(ensureDir(fooDir))
    await runP(init(fooDir))
    await runP(writeFile(path.join(fooDir, 'x.txt'), 'hi\n'))

    const runInput = makeRunInput({ runs: 1, protectGit: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
  })

  it('protected git dir deleted (operator error) -> that run failed with E_WORKTREE_BROKEN, other runs and phase complete', async () => {
    const tree = makeWorkspace(2)
    await buildProtectedRepos(tree)
    await rm(gitDirOf(tree, 'old', 1), { recursive: true, force: true })

    const runInput = makeRunInput({ runs: 2, protectGit: true })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(diffResultFor(result, 'old').runs[0]!.state).toBe('failed')
    expect(diffResultFor(result, 'old').runs[0]!.error?.code).toBe('E_WORKTREE_BROKEN')
    expect(diffResultFor(result, 'old').runs[1]!.state).toBe('ok')
    expect(diffResultFor(result, 'new').runs[0]!.state).toBe('ok')
    expect(diffResultFor(result, 'new').runs[1]!.state).toBe('ok')
  })

  it('gitDirs shorter than apps (structural mismatch) -> whole phase fails loudly, never falls through to restoreGit', async () => {
    const tree = makeWorkspace(2)
    await buildProtectedRepos(tree)
    const oldGitDirs = tree.variantTrees.find((vt) => vt.name === 'old')?.gitDirs ?? []
    const mismatched = withVariantGitDirs(tree, 'old', oldGitDirs.slice(0, 1))

    const runInput = makeRunInput({ runs: 2, protectGit: true })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: mismatched }))
    expect(err.code).toBe('E_WORKTREE_BROKEN')
    expect(err.message).toContain('protect-git dir count')
    // the un-paired run-2 destDir must not have been "recovered" into
    expect(existsSync(path.join(appDir(tree, 'old', 2), '.git'))).toBe(false)
  })
})

describe('diff — temp index isolation', () => {
  it('a stale .git/index.lock in destDir does not break the diff (the worktree is diffable, the lock is not ours)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'edit\n'))
    await runP(writeFile(path.join(oldDir, '.git', 'index.lock'), ''))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.summary.filesChanged).toBe(1)
  })

  it('staging for the diff does not touch or overwrite what the agent had staged in its own index', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'staged-by-agent.txt'), 'staged\n'))
    await runP(addAll(oldDir))
    await runP(writeFile(path.join(oldDir, 'a.txt'), 'unstaged-change\n'))
    const stagedBefore = await runP(lsFilesStage(oldDir))
    const cachedBefore = await runP(diffCached(oldDir))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    // the diff still sees both the agent's staged and unstaged changes
    expect(r.summary.filesChanged).toBe(2)
    expect(r.fullPatch).toContain('staged-by-agent.txt')
    expect(r.fullPatch).toContain('a.txt')
    // but the agent's own index (what it chose to `git add`) is untouched —
    // same staged paths and same `--cached` diff against HEAD as before
    expect(await runP(lsFilesStage(oldDir))).toBe(stagedBefore)
    expect(await runP(diffCached(oldDir))).toBe(cachedBefore)
  })
})

describe('diff — gitignore: committed-but-ignored files (temp index priming)', () => {
  it('a tracked-but-now-ignored file is not reported as deleted when an unrelated file changes', async () => {
    const tree = makeWorkspace(1)
    await runP(ensureDir(tree.appsSource))
    await runP(init(tree.appsSource))
    await runP(ensureDir(path.join(tree.appsSource, 'dist')))
    await runP(writeFile(path.join(tree.appsSource, 'dist', 'bundle.js'), 'bundled\n'))
    await runP(writeFile(path.join(tree.appsSource, 'app.js'), 'console.log(1)\n'))
    await runP(addAll(tree.appsSource))
    await runP(commit(tree.appsSource, 'commit dist output while still tracked'))
    await runP(writeFile(path.join(tree.appsSource, '.gitignore'), 'dist/\n'))
    await runP(addAll(tree.appsSource))
    await runP(commit(tree.appsSource, 'ignore dist/ — bundle.js stays tracked, now also ignored'))
    for (const dir of allAppDirs(tree)) {
      await runP(copyDir(tree.appsSource, dir))
    }

    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'app.js'), 'console.log(2)\n'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.summary.filesChanged).toBe(1)
    // app.js's own one-line edit legitimately shows as 1 addition + 1
    // deletion (old line out, new line in) — the bug this guards against is
    // a SECOND, phantom deletion entry for dist/bundle.js, which the agent
    // never touched.
    expect(r.summary.perFile).toEqual([{ path: 'app.js', additions: 1, deletions: 1 }])
    expect(r.fullPatch).not.toContain('dist/bundle.js')
  })

  it('an untouched worktree with a committed-but-ignored file reports noChanges (not a phantom deletion)', async () => {
    const tree = makeWorkspace(1)
    await runP(ensureDir(tree.appsSource))
    await runP(init(tree.appsSource))
    await runP(ensureDir(path.join(tree.appsSource, 'dist')))
    await runP(writeFile(path.join(tree.appsSource, 'dist', 'bundle.js'), 'bundled\n'))
    await runP(addAll(tree.appsSource))
    await runP(commit(tree.appsSource, 'commit dist output while still tracked'))
    await runP(writeFile(path.join(tree.appsSource, '.gitignore'), 'dist/\n'))
    await runP(addAll(tree.appsSource))
    await runP(commit(tree.appsSource, 'ignore dist/'))
    for (const dir of allAppDirs(tree)) {
      await runP(copyDir(tree.appsSource, dir))
    }

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.noChanges).toBe(true)
    expect(r.fullPatch).toBe('')
    expect(r.summary.filesChanged).toBe(0)
  })
})

describe('diff — unborn HEAD (legitimately empty repo)', () => {
  it('apps/source has zero commits -> run succeeds, agent-created files show as additions, not a failure', async () => {
    const tree = makeWorkspace(1)
    await runP(ensureDir(tree.appsSource))
    await runP(init(tree.appsSource))
    for (const dir of allAppDirs(tree)) {
      await runP(copyDir(tree.appsSource, dir))
    }
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'app.js'), 'console.log(1)\n'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.noChanges).toBe(false)
    expect(r.summary.filesChanged).toBe(1)
    expect(r.fullPatch).toContain('new file mode')
  })

  it('apps/source unborn and untouched -> noChanges true, not a failure', async () => {
    const tree = makeWorkspace(1)
    await runP(ensureDir(tree.appsSource))
    await runP(init(tree.appsSource))
    for (const dir of allAppDirs(tree)) {
      await runP(copyDir(tree.appsSource, dir))
    }

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('ok')
    expect(r.noChanges).toBe(true)
  })

  it('apps/source unborn but destDir has a real commit (agent committed) -> treated as foreign, git-replaced', async () => {
    const tree = makeWorkspace(1)
    await runP(ensureDir(tree.appsSource))
    await runP(init(tree.appsSource))
    for (const dir of allAppDirs(tree)) {
      await runP(copyDir(tree.appsSource, dir))
    }
    const oldDir = appDir(tree, 'old')
    await runP(writeFile(path.join(oldDir, 'app.js'), 'console.log(1)\n'))
    await runP(addAll(oldDir))
    await runP(commit(oldDir, 'agent commit'))

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('git-replaced')
    expect(r.fullPatch).toContain('app.js')
  })
})

describe('diff — replaceGit: agentGitDir prepare failure (disk-full classifier)', () => {
  it('ensureDir for agentGitDir fails with ENOSPC signature -> E_DISK_FULL, aborts the whole phase (not contained)', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    await runP(init(oldDir))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    ensureDirMock.mockImplementationOnce(fsActual.ensureDir) // outDir
    ensureDirMock.mockImplementationOnce(() =>
      Effect.fail(
        new FsError({ path: oldDir, operation: 'ensureDir', cause: new Error('ENOSPC: no space left on device') }),
      ),
    )

    const runInput = makeRunInput({ runs: 1 })
    const err = await runFlip(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err.code).toBe('E_DISK_FULL')
  })

  it('ensureDir for agentGitDir fails for a non-disk reason -> failed run, E_WORKTREE_BROKEN, phase continues', async () => {
    const tree = makeWorkspace(1)
    await buildReposFromSource(tree)
    const oldDir = appDir(tree, 'old')
    await rm(path.join(oldDir, '.git'), { recursive: true, force: true })
    await runP(init(oldDir))
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    ensureDirMock.mockImplementationOnce(fsActual.ensureDir) // outDir
    ensureDirMock.mockImplementationOnce(() =>
      Effect.fail(new FsError({ path: oldDir, operation: 'ensureDir', cause: new Error('EACCES: permission denied') })),
    )

    const runInput = makeRunInput({ runs: 1 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const r = diffResultFor(result, 'old').runs[0]!
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('E_WORKTREE_BROKEN')
  })
})

describe('diff — N variants (3-way)', () => {
  const threeNames = ['base', 'graphify', 'astgrep']
  const threeVariantsRunInput = (over: Partial<RunInput> = {}): RunInput =>
    makeRunInput({
      baseline: 'base',
      variants: threeNames.map((name) => ({ name, packs: [] })),
      ...over,
    })

  it('3 variants x 2 runs -> one diff dir per variant, each with 2 runs, all ok', async () => {
    const tree = makeWorkspace(2, threeNames)
    await buildReposFromSource(tree)
    for (const dir of allAppDirs(tree)) {
      await runP(writeFile(path.join(dir, 'a.txt'), 'changed\n'))
    }
    const runInput = threeVariantsRunInput({ runs: 2 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(result.diffs).toHaveLength(3)
    for (const name of threeNames) {
      const d = diffResultFor(result, name)
      expect(d.variant).toBe(name)
      expect(d.runs).toHaveLength(2)
      expect(d.runs.every((r) => r.state === 'ok')).toBe(true)
      expect(existsSync(path.join(tree.diff, name, 'run-1', 'full.patch'))).toBe(true)
      expect(existsSync(path.join(tree.diff, name, 'run-2', 'full.patch'))).toBe(true)
    }
  })

  it('a broken worktree in one variant (graphify run-1) is contained — base and astgrep, and graphify run-2, all stay ok', async () => {
    const tree = makeWorkspace(2, threeNames)
    await buildReposFromSource(tree)
    const brokenDir = appDir(tree, 'graphify', 1)
    await rm(path.join(brokenDir, '.git'), { recursive: true, force: true })
    copyDirMock.mockImplementationOnce(() =>
      Effect.fail(new FsError({ path: brokenDir, operation: 'copyDir', cause: new Error('boom') })),
    )

    const runInput = threeVariantsRunInput({ runs: 2 })
    const result = await runP(diff({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(diffResultFor(result, 'graphify').runs[0]!.state).toBe('failed')
    expect(diffResultFor(result, 'graphify').runs[1]!.state).toBe('ok')
    expect(diffResultFor(result, 'base').runs.every((r) => r.state === 'ok')).toBe(true)
    expect(diffResultFor(result, 'astgrep').runs.every((r) => r.state === 'ok')).toBe(true)
  })
})
