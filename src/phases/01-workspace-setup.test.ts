import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { shimPair, threeVariants } from '../../tests/helpers/variants.js'
import { ensureDir, writeFile, readFile, exists } from '../util/fs.js'
import { workspaceSetup, buildTreePaths } from './01-workspace-setup.js'
import { PhaseError } from '../errors.js'
import type { PackSpec, RunInput, VariantSpec, WorkspaceTree } from '@generated/types'
import { manifestSchema } from '@generated/schemas'

vi.mock('../opencode/cli.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../opencode/cli.js')>('../opencode/cli.js')
  return { ...actual, version: vi.fn(() => Effect.succeed('1.2.3')) }
})

import { version } from '../opencode/cli.js'
import { OpencodeError } from '../opencode/cli.js'

const versionMock = vi.mocked(version)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const ensureDirP = (p: string): Promise<void> => runP(ensureDir(p))
const writeFileP = (p: string, c: string): Promise<void> => runP(writeFile(p, c))

/** Legacy old/new shim pair (1 pack on `new`) as the default base — overrides layer on top. */
const makeRunInput = (overrides: Partial<RunInput> & { workspacePath: string }): RunInput => ({
  ...shimPair().runInput,
  ...overrides,
})

const freshProject = async (): Promise<{ readonly project: string; readonly workspacePath: string }> => {
  const project = makeTempDir()
  await ensureDirP(project)
  return { project, workspacePath: path.join(project, '.testaipack') }
}

describe('workspaceSetup — happy path', () => {
  it('creates skeleton + treePaths for 3 variants, runs 2 (02-phases.md §01 AC)', async () => {
    const { workspacePath } = await freshProject()
    const { runInput: threeVariantInput } = threeVariants()
    const result = await runP(
      workspaceSetup({
        runInput: makeRunInput({ ...threeVariantInput, workspacePath, runs: 2 }),
        runId: '2026-07-21_17-05-13_a1b2c3',
      }),
    )
    expect(result.rootPath).toBe(path.resolve(workspacePath, '2026-07-21_17-05-13_a1b2c3'))

    const names = threeVariantInput.variants.map((v) => v.name)
    for (const name of names) {
      expect(await runP(exists(path.join(result.rootPath, 'apps', name)))).toBe(true)
      expect(await runP(exists(path.join(result.rootPath, 'home', name)))).toBe(true)
      expect(await runP(exists(path.join(result.rootPath, 'gitdirs', name)))).toBe(true)
      expect(await runP(exists(path.join(result.rootPath, 'results', 'raw', name)))).toBe(true)
      expect(await runP(exists(path.join(result.rootPath, 'results', 'diff', name)))).toBe(true)
    }
    expect(await runP(exists(path.join(result.rootPath, 'apps', 'source')))).toBe(true)
    expect(await runP(exists(path.join(result.rootPath, 'pack')))).toBe(true)
    expect(await runP(exists(path.join(result.rootPath, 'config')))).toBe(true)

    expect(result.manifest.runId).toBe('2026-07-21_17-05-13_a1b2c3')
    expect(result.manifest.schemaVersion).toBe(2)
    expect(result.manifest.runs).toBe(2)
    expect(result.manifest.parallel).toBe(threeVariantInput.parallel)
    expect(result.manifest.baseline).toBe('base')
    expect(result.manifest.repoUrl).toBe('https://example.com/repo.git')
    expect(result.manifest.isolation).toBe('home')
    expect(result.manifest.opencodeVersion).toBe('1.2.3')
    expect(result.manifest.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(manifestSchema.safeParse(result.manifest).success).toBe(true)

    expect(await runP(exists(path.join(result.rootPath, 'manifest.json')))).toBe(true)

    const tree: WorkspaceTree = result.treePaths
    expect(tree.root).toBe(result.rootPath)
    expect(tree.appsSource).toBe(path.join(result.rootPath, 'apps', 'source'))
    expect(tree.variantTrees).toHaveLength(3)
    // AC: "6 app dirs, 6 homes, 6 gitdirs" — 3 variants × runs 2.
    expect(tree.variantTrees.flatMap((vt) => vt.apps)).toHaveLength(6)
    expect(tree.variantTrees.flatMap((vt) => vt.homes)).toHaveLength(6)
    expect(tree.variantTrees.flatMap((vt) => vt.gitDirs)).toHaveLength(6)
    for (const name of names) {
      const vt = tree.variantTrees.find((v) => v.name === name)
      expect(vt?.apps).toEqual([
        path.join(result.rootPath, 'apps', name, 'run-1'),
        path.join(result.rootPath, 'apps', name, 'run-2'),
      ])
      expect(vt?.homes).toEqual([
        path.join(result.rootPath, 'home', name, 'run-1'),
        path.join(result.rootPath, 'home', name, 'run-2'),
      ])
      expect(vt?.gitDirs).toEqual([
        path.join(result.rootPath, 'gitdirs', name, 'run-1'),
        path.join(result.rootPath, 'gitdirs', name, 'run-2'),
      ])
    }
    expect(tree.pack).toBe(path.join(result.rootPath, 'pack'))
    expect(tree.config).toBe(path.join(result.rootPath, 'config'))
    expect(tree.results).toBe(path.join(result.rootPath, 'results'))
    expect(tree.raw).toBe(path.join(result.rootPath, 'results', 'raw'))
    expect(tree.diff).toBe(path.join(result.rootPath, 'results', 'diff'))
  })

  it('treePaths carries exactly one run-N entry per variant for N=1', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath, runs: 1 }), runId: 'rid' }),
    )
    for (const vt of result.treePaths.variantTrees) {
      expect(vt.apps).toEqual([path.join(result.rootPath, 'apps', vt.name, 'run-1')])
      expect(vt.homes).toHaveLength(1)
      expect(vt.gitDirs).toHaveLength(1)
    }
  })

  it('buildTreePaths(root, runs, names, 2) equals the treePaths workspaceSetup returns for the same inputs (pins the refactor)', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath, runs: 4 }), runId: 'pin-check' }),
    )
    const names = result.manifest.variants.map((v) => v.name)
    expect(buildTreePaths(result.rootPath, 4, names, 2)).toEqual(result.treePaths)
  })

  it('v1 path shape: buildTreePaths(root, 2, [old,new], 1) reproduces the legacy apps/oldVersion|newVersion, home/old|new, gitdirs/old|new paths byte-for-byte (guards rebuild\'s legacy mapping)', () => {
    const root = path.join('example', 'root')
    const result = buildTreePaths(root, 2, ['old', 'new'], 1)

    const old = result.variantTrees.find((vt) => vt.name === 'old')
    const newV = result.variantTrees.find((vt) => vt.name === 'new')

    expect(old?.apps).toEqual([
      path.join(root, 'apps', 'oldVersion', 'run-1'),
      path.join(root, 'apps', 'oldVersion', 'run-2'),
    ])
    expect(newV?.apps).toEqual([
      path.join(root, 'apps', 'newVersion', 'run-1'),
      path.join(root, 'apps', 'newVersion', 'run-2'),
    ])
    expect(old?.homes).toEqual([
      path.join(root, 'home', 'old', 'run-1'),
      path.join(root, 'home', 'old', 'run-2'),
    ])
    expect(newV?.homes).toEqual([
      path.join(root, 'home', 'new', 'run-1'),
      path.join(root, 'home', 'new', 'run-2'),
    ])
    expect(old?.gitDirs).toEqual([
      path.join(root, 'gitdirs', 'old', 'run-1'),
      path.join(root, 'gitdirs', 'old', 'run-2'),
    ])
    expect(newV?.gitDirs).toEqual([
      path.join(root, 'gitdirs', 'new', 'run-1'),
      path.join(root, 'gitdirs', 'new', 'run-2'),
    ])
    expect(result.appsSource).toBe(path.join(root, 'apps', 'source'))
    expect(result.pack).toBe(path.join(root, 'pack'))
    expect(result.config).toBe(path.join(root, 'config'))
    expect(result.results).toBe(path.join(root, 'results'))
    expect(result.raw).toBe(path.join(root, 'results', 'raw'))
    expect(result.diff).toBe(path.join(root, 'results', 'diff'))
  })
})

describe('workspaceSetup — manifest', () => {
  it('manifest.json round-trips through the Zod manifestSchema', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    const raw = await runP(readFile(path.join(result.rootPath, 'manifest.json')))
    const parsed = manifestSchema.safeParse(JSON.parse(raw))
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.runId).toBe('rid')
    }
  })

  it('threads flagDefaults from the input into the manifest', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({
        runInput: makeRunInput({ workspacePath }),
        runId: 'rid',
        flagDefaults: { dockerDowngraded: true, configSource: 'merged' },
      }),
    )
    expect(result.manifest.flagDefaults).toMatchObject({ dockerDowngraded: true, configSource: 'merged' })
  })

  it('default flagDefaults when none provided', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    expect(result.manifest.flagDefaults).toMatchObject({ dockerDowngraded: false })
  })

  it('prefers runInput.opencodeVersion over the probed version', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({
        runInput: makeRunInput({ workspacePath, opencodeVersion: '9.9.9' }),
        runId: 'rid',
      }),
    )
    expect(result.manifest.opencodeVersion).toBe('9.9.9')
  })

  it('carries the global hint + per-variant provenance (prompt/init/hint) into the manifest verbatim', async () => {
    const { workspacePath } = await freshProject()
    const variants: VariantSpec[] = [
      { name: 'old', packs: [], pure: true, prompt: 'old prompt', init: 'old init' },
      { name: 'new', packs: ['demo-pack'], pure: false, hint: 'variant-level hint' },
    ]
    const result = await runP(
      workspaceSetup({
        runInput: makeRunInput({
          workspacePath,
          hint: 'If .graphify/ contains a prepared index, use it. If not, work as usual.',
          variants,
        }),
        runId: 'rid',
      }),
    )
    expect(result.manifest.hint).toBe(
      'If .graphify/ contains a prepared index, use it. If not, work as usual.',
    )
    expect(result.manifest.variants).toEqual(variants)
    const raw = await runP(readFile(path.join(result.rootPath, 'manifest.json')))
    const onDisk = JSON.parse(raw) as { hint?: string }
    expect(onDisk.hint).toBe(result.manifest.hint)
  })

  it('hint absent from the manifest when not set', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    expect(result.manifest.hint).toBeUndefined()
  })

  it('redacts a credentialed repoUrl and each pack ref (git URL + inline mcp secret), in the returned manifest and on disk', async () => {
    const { workspacePath } = await freshProject()
    const packs: PackSpec[] = [
      { name: 'demo-pack', ref: 'https://user:ghp_secrettoken@github.com/org/repo.git' },
      { name: 'mcp-pack', ref: 'mcp:srv:{"env":{"API_KEY":"sk-fake-secret"}}' },
    ]
    const variants: VariantSpec[] = [
      { name: 'old', packs: [], pure: true },
      { name: 'new', packs: ['demo-pack', 'mcp-pack'], pure: false },
    ]
    const result = await runP(
      workspaceSetup({
        runInput: makeRunInput({
          workspacePath,
          repoUrl: 'https://user:ghp_secrettoken@github.com/org/repo.git',
          packs,
          variants,
          baseline: 'old',
        }),
        runId: 'rid',
      }),
    )
    expect(result.manifest.repoUrl).not.toContain('ghp_secrettoken')
    expect(result.manifest.repoUrl).not.toContain('user:')

    const demoPack = result.manifest.packs.find((p) => p.name === 'demo-pack')
    const mcpPack = result.manifest.packs.find((p) => p.name === 'mcp-pack')
    expect(demoPack?.ref).not.toContain('ghp_secrettoken')
    expect(demoPack?.ref).not.toContain('user:')
    expect(mcpPack?.ref).not.toContain('sk-fake-secret')
    expect(mcpPack?.ref).not.toContain('API_KEY')
    expect(mcpPack?.ref).toBe('mcp:srv')

    const raw = await runP(readFile(path.join(result.rootPath, 'manifest.json')))
    expect(raw).not.toContain('ghp_secrettoken')
    expect(raw).not.toContain('sk-fake-secret')
    expect(raw).not.toContain('API_KEY')
  })

  it('falls back to "unknown" when the opencode version probe fails', async () => {
    versionMock.mockReturnValue(
      Effect.fail(new OpencodeError({ command: 'version', exitCode: 1, stderr: 'not found', stdout: '', timedOut: false })),
    )
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    expect(result.manifest.opencodeVersion).toBe('unknown')
    versionMock.mockReturnValue(Effect.succeed('1.2.3'))
  })
})

describe('workspaceSetup — .gitignore', () => {
  it('creates .gitignore with .testaipack/ when absent', async () => {
    const { project, workspacePath } = await freshProject()
    await runP(workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }))
    const gi = await runP(readFile(path.join(project, '.gitignore')))
    expect(gi).toContain('.testaipack/')
  })

  it('does not duplicate .testaipack/ when already present', async () => {
    const { project, workspacePath } = await freshProject()
    await writeFileP(path.join(project, '.gitignore'), 'node_modules/\n.testaipack/\n')
    await runP(workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }))
    const gi = await runP(readFile(path.join(project, '.gitignore')))
    const matches = gi.match(/\.testaipack\//g) ?? []
    expect(matches).toHaveLength(1)
    expect(gi).toContain('node_modules/')
  })

  it('appends .testaipack/ to an existing gitignore that lacks it', async () => {
    const { project, workspacePath } = await freshProject()
    await writeFileP(path.join(project, '.gitignore'), 'node_modules/')
    await runP(workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }))
    const gi = await runP(readFile(path.join(project, '.gitignore')))
    expect(gi).toContain('node_modules/')
    expect(gi).toContain('.testaipack/')
  })

  it('appends without extra separator when gitignore ends with a newline', async () => {
    const { project, workspacePath } = await freshProject()
    await writeFileP(path.join(project, '.gitignore'), 'dist/\n')
    await runP(workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }))
    const gi = await runP(readFile(path.join(project, '.gitignore')))
    expect(gi).toBe('dist/\n.testaipack/\n')
  })

  it('uses the actual workspace dir name for a custom --workspace, not a hardcoded .testaipack/', async () => {
    const project = makeTempDir()
    await ensureDirP(project)
    const workspacePath = path.join(project, 'myworkspace')
    await runP(workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }))
    const gi = await runP(readFile(path.join(project, '.gitignore')))
    expect(gi).toContain('myworkspace/')
    expect(gi).not.toContain('.testaipack/')
  })
})

describe('workspaceSetup — errors', () => {
  it('non-empty existing rootPath → already-exists', async () => {
    const { workspacePath } = await freshProject()
    const rootPath = path.resolve(workspacePath, 'rid')
    await ensureDirP(rootPath)
    await writeFileP(path.join(rootPath, 'leftover.txt'), 'x')
    const err = await runFlip(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
    expect(err.context?.['reason']).toBe('already-exists')
  })

  it('rootPath is a file → not-a-directory', async () => {
    const { workspacePath } = await freshProject()
    const rootPath = path.resolve(workspacePath, 'rid')
    await ensureDirP(workspacePath)
    await writeFileP(rootPath, 'not a dir')
    const err = await runFlip(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
    expect(err.context?.['reason']).toBe('not-a-directory')
  })

  it('idempotent: re-running over an empty rootPath succeeds', async () => {
    const { workspacePath } = await freshProject()
    const rootPath = path.resolve(workspacePath, 'rid')
    await ensureDirP(rootPath)
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: 'rid' }),
    )
    expect(result.rootPath).toBe(rootPath)
  })

  it('workspacePath resolves to a file → not-a-directory', async () => {
    const project = makeTempDir()
    await ensureDirP(project)
    const filePath = path.join(project, 'awfile')
    await writeFileP(filePath, 'not a dir')
    const err = await runFlip(
      workspaceSetup({ runInput: makeRunInput({ workspacePath: filePath }), runId: 'rid' }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
    expect(err.context?.['reason']).toBe('not-a-directory')
  })
})
