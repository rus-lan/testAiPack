import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeReportV2, shimPair, makeWorkspaceTree } from '../../tests/helpers/variants.js'
import { makeTempDir } from '../../tests/setup.js'
import { readFile, writeFile } from '../util/fs.js'
import { FsError } from '../util/fs.js'
import {
  reviewWorkspace,
  buildWorkspaceJson,
  mapIdeToBinary,
} from './12-review-workspace.js'
import type { Manifest, RunInput, WorkspaceTree } from '@generated/types'

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const writeFileMock = vi.mocked(writeFile)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  writeFileMock.mockImplementation(actual.writeFile)
})

const baseManifest = (): Manifest => makeReportV2().manifest
const baseRunInput = (): RunInput => shimPair().runInput

const manifestWith = (flagDefaults: Record<string, unknown>, runs = 1): Manifest => ({
  ...baseManifest(),
  runs,
  flagDefaults,
})

const workspaceFor = (runs: number, names: readonly string[]): WorkspaceTree =>
  makeWorkspaceTree(makeTempDir(), runs, [...names])

const readWorkspaceFile = async (workspacePath: string): Promise<unknown> => {
  const raw = await runP(readFile(workspacePath))
  return JSON.parse(raw)
}

describe('reviewWorkspace — happy path (3 variants + 2 packs)', () => {
  it('writes review.code-workspace with 5 folders (WP11 AC), relative paths correct, opened=false', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({ reviewRun: 1, ide: 'vscode' }, 1)
    const result = await runP(
      reviewWorkspace({ runInput: baseRunInput(), manifest, workspace }),
    )

    expect(result.opened).toBe(false)
    expect(result.workspacePath).toBe(path.join(workspace.results, 'review.code-workspace'))
    expect(existsSync(result.workspacePath)).toBe(true)

    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { path: string; name: string }[]
    }
    expect(file.folders).toHaveLength(5)
    expect(file.folders.map((f) => f.name)).toEqual([
      'base run-1 (baseline)',
      'graphify run-1',
      'astgrep run-1',
      'PACK graphify (read-only)',
      'PACK astgrep (read-only)',
    ])

    const baseTree = workspace.variantTrees.find((t) => t.name === 'base')!
    expect(file.folders[0]!.path).toBe(path.relative(workspace.results, baseTree.apps[0]!))
    expect(file.folders[3]!.path).toBe(path.relative(workspace.results, path.join(workspace.pack, 'graphify')))
    expect(file.folders[4]!.path).toBe(path.relative(workspace.results, path.join(workspace.pack, 'astgrep')))
  })

  it('command for vscode is "code <workspacePath>"', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ ide: 'vscode' }),
        workspace,
      }),
    )
    expect(result.command).toBe(`code ${result.workspacePath}`)
  })
})

describe('reviewWorkspace — shim pair (2 variants, 1 pack)', () => {
  it('3 folders: old, new (baseline suffix on old), PACK', async () => {
    const { runInput } = shimPair()
    const workspace = workspaceFor(1, ['old', 'new'])
    const manifest = manifestWith({}, 1)
    // shimPair's manifest baseline is "old" but our fixture manifest defaults to "base" —
    // build a manifest matching shimPair's variant set directly.
    const shimManifest: Manifest = { ...manifest, baseline: 'old', variants: runInput.variants, packs: runInput.packs }
    const result = await runP(reviewWorkspace({ runInput, manifest: shimManifest, workspace }))
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders.map((f) => f.name)).toEqual([
      'old run-1 (baseline)',
      'new run-1',
      'PACK demo-pack (read-only)',
    ])
  })
})

describe('reviewWorkspace — review-run parameter', () => {
  it('reviewRun=2 with runs=2 points every variant at run-2', async () => {
    const workspace = workspaceFor(2, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ reviewRun: 2 }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { path: string; name: string }[]
    }
    const baseTree = workspace.variantTrees.find((t) => t.name === 'base')!
    expect(file.folders[0]!.path).toBe(path.relative(workspace.results, baseTree.apps[1]!))
    expect(file.folders[0]!.name).toContain('run-2')
    expect(file.folders[1]!.name).toContain('run-2')
  })

  it('invalid reviewRun=5 (runs=3) falls back to run-1', async () => {
    const workspace = workspaceFor(3, ['base', 'graphify', 'astgrep'])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ reviewRun: 5 }, 3),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders[0]!.name).toContain('run-1')
    warnSpy.mockRestore()
  })

  it('reviewRun=0 falls back to run-1', async () => {
    const workspace = workspaceFor(2, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ reviewRun: 0 }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders[0]!.name).toContain('run-1')
  })

  it('missing reviewRun defaults to run-1', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({ runInput: baseRunInput(), manifest: manifestWith({}, 1), workspace }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders[0]!.name).toContain('run-1')
  })
})

describe('reviewWorkspace — ide mapping', () => {
  it.each([
    ['cursor', 'cursor'],
    ['code-insiders', 'code-insiders'],
    ['vscode', 'code'],
    ['unknown-ide', 'code'],
  ])('ide=%s → command starts with "%s"', async (ide, binary) => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ ide }),
        workspace,
      }),
    )
    expect(result.command.startsWith(`${binary} `)).toBe(true)
  })
})

describe('reviewWorkspace — flag parsing edge cases', () => {
  it('string reviewRun "2" resolves to run-2', async () => {
    const workspace = workspaceFor(2, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ reviewRun: '2' }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders[0]!.name).toContain('run-2')
  })

  it('non-numeric string reviewRun falls back to run-1', async () => {
    const workspace = workspaceFor(2, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ reviewRun: 'abc' }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders[0]!.name).toContain('run-1')
  })

  it('empty-string ide falls back to vscode', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ ide: '' }),
        workspace,
      }),
    )
    expect(result.command.startsWith('code ')).toBe(true)
  })

  it('non-string ide falls back to vscode', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({
        runInput: baseRunInput(),
        manifest: manifestWith({ ide: 42 }),
        workspace,
      }),
    )
    expect(result.command.startsWith('code ')).toBe(true)
  })

  it('buildWorkspaceJson builds a fallback path when the run dir is absent', () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({}, 1)
    const file = buildWorkspaceJson(3, manifest, workspace, workspace.results)
    const expected = path.relative(workspace.results, path.join(workspace.root, 'apps', 'base', 'run-3'))
    expect(file.folders[0]!.path).toBe(expected)
  })
})

describe('reviewWorkspace — packless smoke test', () => {
  it('zero packs declared → zero PACK folders, only variant folders', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({}, 1)
    const smokeManifest: Manifest = { ...manifest, packs: [] }
    const result = await runP(
      reviewWorkspace({ runInput: baseRunInput(), manifest: smokeManifest, workspace }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as { folders: { name: string }[] }
    expect(file.folders).toHaveLength(3)
    expect(file.folders.every((f) => !f.name.startsWith('PACK'))).toBe(true)
  })
})

describe('reviewWorkspace — soft failure', () => {
  it('write failure logs warning, still returns opened=false, never throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'ws', operation: 'writeFile', cause: new Error('ROFS') })),
    )
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const result = await runP(
      reviewWorkspace({ runInput: baseRunInput(), manifest: manifestWith({}, 1), workspace }),
    )
    expect(result.opened).toBe(false)
    expect(result.command.startsWith('code ')).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('idempotent — re-running overwrites the same file', async () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const input = { runInput: baseRunInput(), manifest: manifestWith({}, 1), workspace }
    const r1 = await runP(reviewWorkspace(input))
    const r2 = await runP(reviewWorkspace(input))
    expect(r1.workspacePath).toBe(r2.workspacePath)
    expect(existsSync(r2.workspacePath)).toBe(true)
  })
})

describe('buildWorkspaceJson — pure tabular', () => {
  it('folders count is variants + packs, names follow the template, baseline suffixed', () => {
    const workspace = workspaceFor(2, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({}, 2)
    const file = buildWorkspaceJson(2, manifest, workspace, workspace.results)
    expect(file.folders).toHaveLength(5)
    expect(file.folders.map((f) => f.name)).toEqual([
      'base run-2 (baseline)',
      'graphify run-2',
      'astgrep run-2',
      'PACK graphify (read-only)',
      'PACK astgrep (read-only)',
    ])
  })

  it('variant paths are relative to the provided location dir', () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({}, 1)
    const file = buildWorkspaceJson(1, manifest, workspace, workspace.results)
    const baseTree = workspace.variantTrees.find((t) => t.name === 'base')!
    expect(file.folders[0]!.path).toBe(path.relative(workspace.results, baseTree.apps[0]!))
  })

  it('pack paths point at workspace.pack/<name>', () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({}, 1)
    const file = buildWorkspaceJson(1, manifest, workspace, workspace.results)
    const packFolder = file.folders.find((f) => f.name === 'PACK graphify (read-only)')
    expect(packFolder).toBeDefined()
    expect(packFolder!.path).toBe(path.relative(workspace.results, path.join(workspace.pack, 'graphify')))
  })

  it('settings contains an empty colorCustomizations object', () => {
    const workspace = workspaceFor(1, ['base', 'graphify', 'astgrep'])
    const manifest = manifestWith({}, 1)
    const file = buildWorkspaceJson(1, manifest, workspace, workspace.results)
    expect(file.settings['workbench.colorCustomizations']).toEqual({})
  })
})

describe('mapIdeToBinary — tabular', () => {
  it.each([
    ['vscode', 'code'],
    ['cursor', 'cursor'],
    ['code-insiders', 'code-insiders'],
    ['something-else', 'code'],
  ])('ide=%s → %s', (ide, binary) => {
    expect(mapIdeToBinary(ide)).toBe(binary)
  })
})
