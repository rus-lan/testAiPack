import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { rm as fsRm } from 'node:fs/promises'
import { makeTempDir } from '../../tests/setup.js'
import { shimPair, threeVariants, makeWorkspaceTree } from '../../tests/helpers/variants.js'
import { ensureDir, writeFile } from '../util/fs.js'
import { repoClone } from './02-repo-clone.js'
import { PhaseError } from '../errors.js'
import type { Manifest, RunInput, WorkspaceTree } from '@generated/types'

vi.mock('../util/git.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/git.js')>('../util/git.js')
  return { ...actual, clone: vi.fn(actual.clone) }
})

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, copyDir: vi.fn(actual.copyDir), moveDir: vi.fn(actual.moveDir) }
})

import { clone } from '../util/git.js'
import { GitError } from '../util/git.js'
import { init, addAll, commit, revParseHead } from '../util/git.js'
import { copyDir, moveDir, FsError, exists } from '../util/fs.js'

const cloneMock = vi.mocked(clone)
const copyDirMock = vi.mocked(copyDir)
const moveDirMock = vi.mocked(moveDir)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const ensureDirP = (p: string): Promise<void> => runP(ensureDir(p))
const writeFileP = (p: string, c: string): Promise<void> => runP(writeFile(p, c))

/** Legacy old/new shim pair as the default base — overrides layer on top. */
const makeRunInput = (overrides: Partial<RunInput> = {}): RunInput => ({
  ...shimPair().runInput,
  repoUrl: '',
  runs: 2,
  ...overrides,
})

const buildSourceRepo = async (): Promise<string> => {
  const repo = makeTempDir()
  await runP(init(repo))
  await writeFileP(path.join(repo, 'README.md'), '# hello\n')
  await runP(addAll(repo))
  await runP(commit(repo, 'init'))
  return repo
}

const makeWorkspace = async (
  runs: number,
  names: readonly string[] = ['old', 'new'],
): Promise<{ readonly root: string; readonly tree: WorkspaceTree }> => {
  const root = makeTempDir()
  for (const name of names) {
    await ensureDirP(path.join(root, 'apps', name))
    await ensureDirP(path.join(root, 'gitdirs', name))
  }
  const tree = makeWorkspaceTree(root, runs, [...names])
  return { root, tree }
}

const treeOf = (tree: WorkspaceTree, name: string) => tree.variantTrees.find((vt) => vt.name === name)

const makeManifest = (runInput: RunInput): Manifest => ({
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
})

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const gitActual = await vi.importActual<typeof import('../util/git.js')>('../util/git.js')
  cloneMock.mockReset()
  cloneMock.mockImplementation(gitActual.clone)
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  copyDirMock.mockReset()
  copyDirMock.mockImplementation(fsActual.copyDir)
  moveDirMock.mockReset()
  moveDirMock.mockImplementation(fsActual.moveDir)
})

describe('repoClone — happy path', () => {
  it('clones a local file:// repo and produces 2×N copies', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(2)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 2 })
    const result = await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))

    const oldApps = treeOf(tree, 'old')?.apps ?? []
    const newApps = treeOf(tree, 'new')?.apps ?? []

    expect(result.sourcePath).toBe(tree.appsSource)
    expect(existsSync(path.join(tree.appsSource, '.git'))).toBe(true)
    expect(existsSync(path.join(tree.appsSource, 'README.md'))).toBe(true)
    expect(result.copyPaths.find((c) => c.name === 'old')?.paths).toEqual(oldApps)
    expect(result.copyPaths.find((c) => c.name === 'new')?.paths).toEqual(newApps)
    for (const p of [...oldApps, ...newApps]) {
      expect(existsSync(path.join(p, 'README.md'))).toBe(true)
      expect(existsSync(path.join(p, '.git'))).toBe(true)
    }
    expect(Number(result.cloneDurationMs)).toBeGreaterThanOrEqual(0)
  })

  it('N=1 produces exactly one copy per variant', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1 })
    const result = await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const oldPaths = result.copyPaths.find((c) => c.name === 'old')?.paths ?? []
    const newPaths = result.copyPaths.find((c) => c.name === 'new')?.paths ?? []
    expect(oldPaths).toHaveLength(1)
    expect(newPaths).toHaveLength(1)
    expect(existsSync(path.join(oldPaths[0] ?? '', 'README.md'))).toBe(true)
  })
})

describe('repoClone — timeout', () => {
  it('clone exceeding installSeconds → E_REPO_TIMEOUT', async () => {
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: 'https://nonexistent.example/x.git', runs: 1, timeouts: { preflightSeconds: 60, runSeconds: 600, verifySeconds: 300, installSeconds: 1, watchdogSeconds: 1200 } })
    cloneMock.mockImplementation(() => Effect.never)
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_TIMEOUT')
    expect(err.context?.['repoUrl']).toBe(runInput.repoUrl)
  })
})

describe('repoClone — clone failed', () => {
  it('Permission denied stderr → E_REPO_CLONE_FAILED with --ssh/--git hint', async () => {
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: 'git@github.com:private/repo.git', runs: 1 })
    cloneMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'clone', exitCode: 128, stderr: 'Permission denied (publickey)' })),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.message).toContain('--ssh')
    expect(err.context?.['repoUrl']).toBe(runInput.repoUrl)
  })

  it('clone failure with credentials in repoUrl → error context leaks neither the token nor the userinfo', async () => {
    const { tree } = await makeWorkspace(1)
    const url = 'https://user:sk-fake-token@example.invalid/repo.git'
    const runInput = makeRunInput({ repoUrl: url, runs: 1 })
    cloneMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'clone', exitCode: 128, stderr: 'fatal: not found' })),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['repoUrl']).toBe('https://example.invalid/repo.git')
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain('sk-fake-token')
    expect(contextStr).not.toContain('user:')
  })

  it('generic non-zero exit → E_REPO_CLONE_FAILED', async () => {
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: 'https://example.com/missing.git', runs: 1 })
    cloneMock.mockImplementation(() =>
      Effect.fail(new GitError({ command: 'clone', exitCode: 128, stderr: 'fatal: not found' })),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
  })
})

describe('repoClone — copyPaths shape', () => {
  it('copyPaths carries one entry per variant, paths matching the variant tree', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(3)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 3 })
    const result = await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(result.copyPaths).toHaveLength(2)
    for (const vt of tree.variantTrees) {
      const entry = result.copyPaths.find((c) => c.name === vt.name)
      expect(entry?.paths).toEqual(vt.apps)
      expect(entry?.paths).toHaveLength(3)
    }
  })

  it('3 variants × 2 runs produce 6 copies (02-phases.md §02 AC)', async () => {
    const src = await buildSourceRepo()
    const { runInput: threeVariantInput } = threeVariants()
    const names = threeVariantInput.variants.map((v) => v.name)
    const { tree } = await makeWorkspace(2, names)
    const runInput = makeRunInput({
      repoUrl: `file://${src}`,
      runs: 2,
      baseline: threeVariantInput.baseline,
      variants: threeVariantInput.variants,
      packs: threeVariantInput.packs,
    })
    const result = await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(result.copyPaths).toHaveLength(3)
    const totalCopies = result.copyPaths.reduce((n, c) => n + c.paths.length, 0)
    expect(totalCopies).toBe(6)
    for (const p of result.copyPaths.flatMap((c) => c.paths)) {
      expect(existsSync(path.join(p, 'README.md'))).toBe(true)
    }
  })
})

describe('repoClone — no .git after clone', () => {
  it('clone produced no .git directory → E_REPO_CLONE_FAILED', async () => {
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: 'https://example.com/x.git', runs: 1 })
    cloneMock.mockImplementation(() => Effect.void)
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['reason']).toBe('no-git-dir')
  })
})

describe('repoClone — copy failure', () => {
  it('ENOSPC during copyDir → E_REPO_CLONE_FAILED with reason disk-full', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1 })
    const oldApp0 = treeOf(tree, 'old')?.apps[0] ?? ''
    copyDirMock.mockImplementation(() =>
      Effect.fail(
        new FsError({ path: oldApp0, operation: 'copyDir', cause: new Error('ENOSPC: no space left on device') }),
      ),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['reason']).toBe('disk-full')
  })

  it('generic copy error → E_REPO_CLONE_FAILED with reason copy-failed', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1 })
    copyDirMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'x', operation: 'copyDir', cause: new Error('boom') })),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['reason']).toBe('copy-failed')
  })

  it('non-deterministic copy: tracked file dropped from a copy index (ls-files differs) → E_REPO_CLONE_FAILED', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1 })
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    copyDirMock.mockImplementation((srcP, dst) =>
      Effect.gen(function* () {
        yield* fsActual.copyDir(srcP, dst)
        if (dst.endsWith(path.join('old', 'run-1'))) {
          yield* Effect.promise(() => fsRm(path.join(dst, 'README.md')))
          yield* addAll(dst).pipe(Effect.catchAll(() => Effect.void))
        }
      }),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['reason']).toBe('non-deterministic')
  })

  it('non-deterministic copy: extra commit in a copy (rev-parse HEAD differs) → E_REPO_CLONE_FAILED', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1 })
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const fsActual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
    copyDirMock.mockImplementation((srcP, dst) =>
      Effect.gen(function* () {
        yield* fsActual.copyDir(srcP, dst)
        if (dst.endsWith(path.join('old', 'run-1'))) {
          yield* fsActual.writeFile(path.join(dst, 'extra.txt'), 'tampered\n')
          yield* addAll(dst).pipe(Effect.catchAll(() => Effect.void))
          yield* commit(dst, 'tamper').pipe(Effect.catchAll(() => Effect.void))
        }
      }),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['reason']).toBe('non-deterministic')
  })
})

describe('repoClone — protectGit', () => {
  it('protect ON, 3 variants × 2 runs: no .git left in any run dir, all 6 gitdirs/<variant>/run-N hold HEAD, determinism check passes (02-phases.md §02 AC)', async () => {
    const src = await buildSourceRepo()
    const { runInput: threeVariantInput } = threeVariants()
    const names = threeVariantInput.variants.map((v) => v.name)
    const { tree } = await makeWorkspace(2, names)
    const runInput = makeRunInput({
      repoUrl: `file://${src}`,
      runs: 2,
      protectGit: true,
      baseline: threeVariantInput.baseline,
      variants: threeVariantInput.variants,
      packs: threeVariantInput.packs,
    })
    const result = await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))

    expect(existsSync(path.join(tree.appsSource, '.git'))).toBe(true)

    const allDests = tree.variantTrees.flatMap((vt) => vt.apps)
    const allGitDirs = tree.variantTrees.flatMap((vt) => vt.gitDirs)
    expect(allDests).toHaveLength(6)
    expect(allGitDirs).toHaveLength(6)

    for (const dest of allDests) {
      expect(existsSync(path.join(dest, '.git'))).toBe(false)
      expect(existsSync(path.join(dest, 'README.md'))).toBe(true)
    }
    for (const gitDir of allGitDirs) {
      expect(existsSync(path.join(gitDir, 'HEAD'))).toBe(true)
    }
    for (const vt of tree.variantTrees) {
      expect(result.copyPaths.find((c) => c.name === vt.name)?.paths).toEqual(vt.apps)
    }
  })

  it('protect ON: two-path revParseHead against the relocated gitDir returns the same HEAD as source', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1, protectGit: true })
    await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    const sourceHead = await runP(revParseHead(tree.appsSource))
    const oldTree = treeOf(tree, 'old')
    const copyHead = await runP(revParseHead(oldTree?.apps[0] ?? '', oldTree?.gitDirs[0]))
    expect(copyHead).toBe(sourceHead)
  })

  it('protect ON, move failure → E_REPO_CLONE_FAILED with reason protect-git-move', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1, protectGit: true })
    moveDirMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'x', operation: 'moveDir', cause: new Error('boom') })),
    )
    const err = await runFlip(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_REPO_CLONE_FAILED')
    expect(err.context?.['reason']).toBe('protect-git-move')
  })

  it('protect OFF (default): no move attempted, .git stays in every run dir, gitdirs/ stays empty', async () => {
    const src = await buildSourceRepo()
    const { tree } = await makeWorkspace(1)
    const runInput = makeRunInput({ repoUrl: `file://${src}`, runs: 1, protectGit: false })
    await runP(repoClone({ runInput, manifest: makeManifest(runInput), workspace: tree }))
    expect(moveDirMock).not.toHaveBeenCalled()
    const oldTree = treeOf(tree, 'old')
    const newTree = treeOf(tree, 'new')
    for (const dest of [...(oldTree?.apps ?? []), ...(newTree?.apps ?? [])]) {
      expect(existsSync(path.join(dest, '.git'))).toBe(true)
    }
    expect(await runP(exists(oldTree?.gitDirs[0] ?? ''))).toBe(false)
  })
})
