import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeWorkspace, makeManifest, makeRunInput } from '../../tests/report-fixture.js'
import { readFile, writeFile } from '../util/fs.js'
import { FsError } from '../util/fs.js'
import {
  reviewWorkspace,
  buildWorkspaceJson,
  mapIdeToBinary,
} from './12-review-workspace.js'
import type { Manifest } from '@generated/types'

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

const manifestWith = (flagDefaults: Record<string, unknown>, runs = 1): Manifest =>
  makeManifest({ runs, flagDefaults })

const readWorkspaceFile = async (workspacePath: string): Promise<unknown> => {
  const raw = await runP(readFile(workspacePath))
  return JSON.parse(raw)
}

describe('reviewWorkspace — happy path', () => {
  it('writes review.code-workspace with three folders, relative paths, opened=false', async () => {
    const workspace = makeWorkspace(1)
    const manifest = manifestWith({ reviewRun: 1, ide: 'vscode' }, 1)
    const result = await runP(
      reviewWorkspace({ runInput: makeRunInput(), manifest, workspace }),
    )

    expect(result.opened).toBe(false)
    expect(result.workspacePath).toBe(path.join(workspace.results, 'review.code-workspace'))
    expect(existsSync(result.workspacePath)).toBe(true)

    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { path: string; name: string }[]
    }
    expect(file.folders).toHaveLength(3)
    expect(file.folders[0]!.name).toBe('OLD (baseline) run-1')
    expect(file.folders[1]!.name).toBe('NEW (with pack) run-1')
    expect(file.folders[2]!.name).toBe('PACK source (read-only)')

    const relOld = path.relative(workspace.results, workspace.appsOld[0]!)
    const relNew = path.relative(workspace.results, workspace.appsNew[0]!)
    const relPack = path.relative(workspace.results, workspace.pack)
    expect(file.folders[0]!.path).toBe(relOld)
    expect(file.folders[1]!.path).toBe(relNew)
    expect(file.folders[2]!.path).toBe(relPack)
  })

  it('command for vscode is "code <workspacePath>"', async () => {
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput(),
        manifest: manifestWith({ ide: 'vscode' }),
        workspace,
      }),
    )
    expect(result.command).toBe(`code ${result.workspacePath}`)
  })
})

describe('reviewWorkspace — review-run parameter', () => {
  it('reviewRun=2 with runs=2 points both sides at run-2', async () => {
    const workspace = makeWorkspace(2)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput({ runs: 2 }),
        manifest: manifestWith({ reviewRun: 2 }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { path: string; name: string }[]
    }
    expect(file.folders[0]!.path).toBe(path.relative(workspace.results, workspace.appsOld[1]!))
    expect(file.folders[1]!.path).toBe(path.relative(workspace.results, workspace.appsNew[1]!))
    expect(file.folders[0]!.name).toContain('run-2')
  })

  it('invalid reviewRun=5 (runs=3) falls back to run-1', async () => {
    const workspace = makeWorkspace(3)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput({ runs: 3 }),
        manifest: manifestWith({ reviewRun: 5 }, 3),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { name: string }[]
    }
    expect(file.folders[0]!.name).toContain('run-1')
    warnSpy.mockRestore()
  })

  it('reviewRun=0 falls back to run-1', async () => {
    const workspace = makeWorkspace(2)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput({ runs: 2 }),
        manifest: manifestWith({ reviewRun: 0 }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { name: string }[]
    }
    expect(file.folders[0]!.name).toContain('run-1')
  })

  it('missing reviewRun defaults to run-1', async () => {
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({ runInput: makeRunInput(), manifest: manifestWith({}, 1), workspace }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { name: string }[]
    }
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
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput(),
        manifest: manifestWith({ ide }),
        workspace,
      }),
    )
    expect(result.command.startsWith(`${binary} `)).toBe(true)
  })
})

describe('reviewWorkspace — flag parsing edge cases', () => {
  it('string reviewRun "2" resolves to run-2', async () => {
    const workspace = makeWorkspace(2)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput({ runs: 2 }),
        manifest: manifestWith({ reviewRun: '2' }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { name: string }[]
    }
    expect(file.folders[0]!.name).toContain('run-2')
  })

  it('non-numeric string reviewRun falls back to run-1', async () => {
    const workspace = makeWorkspace(2)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput({ runs: 2 }),
        manifest: manifestWith({ reviewRun: 'abc' }, 2),
        workspace,
      }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { name: string }[]
    }
    expect(file.folders[0]!.name).toContain('run-1')
  })

  it('empty-string ide falls back to vscode', async () => {
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput(),
        manifest: manifestWith({ ide: '' }),
        workspace,
      }),
    )
    expect(result.command.startsWith('code ')).toBe(true)
  })

  it('non-string ide falls back to vscode', async () => {
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({
        runInput: makeRunInput(),
        manifest: manifestWith({ ide: 42 }),
        workspace,
      }),
    )
    expect(result.command.startsWith('code ')).toBe(true)
  })

  it('buildWorkspaceJson builds a fallback path when the run dir is absent', () => {
    const workspace = makeWorkspace(1)
    const file = buildWorkspaceJson(3, workspace, workspace.results)
    const expected = path.relative(
      workspace.results,
      path.join(workspace.root, 'apps', 'oldVersion', 'run-3'),
    )
    expect(file.folders[0]!.path).toBe(expected)
  })
})

describe('reviewWorkspace — smoke test', () => {
  it('pack folder is included even without a pack (smoke-test)', async () => {
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({ runInput: makeRunInput(), manifest: manifestWith({}, 1), workspace }),
    )
    const file = (await readWorkspaceFile(result.workspacePath)) as {
      folders: { name: string; path: string }[]
    }
    const packFolder = file.folders.find((f) => f.name === 'PACK source (read-only)')
    expect(packFolder).toBeDefined()
    expect(packFolder!.path).toBe(path.relative(workspace.results, workspace.pack))
  })
})

describe('reviewWorkspace — soft failure', () => {
  it('write failure logs warning, still returns opened=false, never throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'ws', operation: 'writeFile', cause: new Error('ROFS') })),
    )
    const workspace = makeWorkspace(1)
    const result = await runP(
      reviewWorkspace({ runInput: makeRunInput(), manifest: manifestWith({}, 1), workspace }),
    )
    expect(result.opened).toBe(false)
    expect(result.command.startsWith('code ')).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('idempotent — re-running overwrites the same file', async () => {
    const workspace = makeWorkspace(1)
    const input = { runInput: makeRunInput(), manifest: manifestWith({}, 1), workspace }
    const r1 = await runP(reviewWorkspace(input))
    const r2 = await runP(reviewWorkspace(input))
    expect(r1.workspacePath).toBe(r2.workspacePath)
    expect(existsSync(r2.workspacePath)).toBe(true)
  })
})

describe('buildWorkspaceJson — pure tabular', () => {
  it('folders count is always 3 and names follow the template', () => {
    const workspace = makeWorkspace(2)
    const file = buildWorkspaceJson(2, workspace, workspace.results)
    expect(file.folders).toHaveLength(3)
    expect(file.folders.map((f) => f.name)).toEqual([
      'OLD (baseline) run-2',
      'NEW (with pack) run-2',
      'PACK source (read-only)',
    ])
  })

  it('paths are relative to the provided location dir', () => {
    const workspace = makeWorkspace(1)
    const file = buildWorkspaceJson(1, workspace, workspace.results)
    expect(file.folders[0]!.path).toBe(path.relative(workspace.results, workspace.appsOld[0]!))
  })

  it('settings contains an empty colorCustomizations object', () => {
    const workspace = makeWorkspace(1)
    const file = buildWorkspaceJson(1, workspace, workspace.results)
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
