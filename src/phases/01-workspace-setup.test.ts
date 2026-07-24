import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, readFile, exists } from '../util/fs.js'
import { workspaceSetup } from './01-workspace-setup.js'
import { PhaseError } from '../errors.js'
import type { RunInput, WorkspaceTree } from '@generated/types'
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

const makeRunInput = (overrides: Partial<RunInput> & { workspacePath: string }): RunInput => ({
  repoUrl: 'https://github.com/example/repo.git',
  prompt: 'fix the bug',
  runs: 3,
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
  logLevel: 'info',
  ...overrides,
})

const freshProject = async (): Promise<{ readonly project: string; readonly workspacePath: string }> => {
  const project = makeTempDir()
  await ensureDirP(project)
  return { project, workspacePath: path.join(project, '.testaipack') }
}

describe('workspaceSetup — happy path', () => {
  it('creates the full skeleton, manifest.json, and treePaths for N=3', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath }), runId: '2026-07-21_17-05-13_a1b2c3' }),
    )
    expect(result.rootPath).toBe(path.resolve(workspacePath, '2026-07-21_17-05-13_a1b2c3'))

    for (const p of [
      path.join(result.rootPath, 'apps', 'source'),
      path.join(result.rootPath, 'apps', 'oldVersion'),
      path.join(result.rootPath, 'apps', 'newVersion'),
      path.join(result.rootPath, 'pack'),
      path.join(result.rootPath, 'home', 'old'),
      path.join(result.rootPath, 'home', 'new'),
      path.join(result.rootPath, 'config'),
      path.join(result.rootPath, 'results'),
      path.join(result.rootPath, 'results', 'raw', 'old'),
      path.join(result.rootPath, 'results', 'raw', 'new'),
      path.join(result.rootPath, 'results', 'diff', 'old'),
      path.join(result.rootPath, 'results', 'diff', 'new'),
    ]) {
      expect(await runP(exists(p))).toBe(true)
    }

    expect(result.manifest.runId).toBe('2026-07-21_17-05-13_a1b2c3')
    expect(result.manifest.runs).toBe(3)
    expect(result.manifest.repoUrl).toBe('https://github.com/example/repo.git')
    expect(result.manifest.isolation).toBe('home')
    expect(result.manifest.opencodeVersion).toBe('1.2.3')
    expect(result.manifest.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    expect(await runP(exists(path.join(result.rootPath, 'manifest.json')))).toBe(true)

    const tree: WorkspaceTree = result.treePaths
    expect(tree.root).toBe(result.rootPath)
    expect(tree.appsSource).toBe(path.join(result.rootPath, 'apps', 'source'))
    expect(tree.appsOld).toEqual([
      path.join(result.rootPath, 'apps', 'oldVersion', 'run-1'),
      path.join(result.rootPath, 'apps', 'oldVersion', 'run-2'),
      path.join(result.rootPath, 'apps', 'oldVersion', 'run-3'),
    ])
    expect(tree.appsNew).toHaveLength(3)
    expect(tree.homeOld).toEqual([
      path.join(result.rootPath, 'home', 'old', 'run-1'),
      path.join(result.rootPath, 'home', 'old', 'run-2'),
      path.join(result.rootPath, 'home', 'old', 'run-3'),
    ])
    expect(tree.homeNew).toHaveLength(3)
    expect(tree.pack).toBe(path.join(result.rootPath, 'pack'))
    expect(tree.config).toBe(path.join(result.rootPath, 'config'))
    expect(tree.results).toBe(path.join(result.rootPath, 'results'))
    expect(tree.raw).toBe(path.join(result.rootPath, 'results', 'raw'))
    expect(tree.diff).toBe(path.join(result.rootPath, 'results', 'diff'))
  })

  it('writes run-N directories for N=1 only', async () => {
    const { workspacePath } = await freshProject()
    const result = await runP(
      workspaceSetup({ runInput: makeRunInput({ workspacePath, runs: 1 }), runId: 'rid' }),
    )
    expect(result.treePaths.appsOld).toEqual([path.join(result.rootPath, 'apps', 'oldVersion', 'run-1')])
    expect(result.treePaths.appsNew).toEqual([path.join(result.rootPath, 'apps', 'newVersion', 'run-1')])
    expect(result.treePaths.homeOld).toHaveLength(1)
    expect(result.treePaths.homeNew).toHaveLength(1)
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
