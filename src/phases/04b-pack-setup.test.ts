import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, exists, readFile, writeFile } from '../util/fs.js'
import { packSetup, derivePackSetupMode, scanForDependencyMarkers } from './04b-pack-setup.js'
import type { PackSetupInputExt } from './04b-pack-setup.js'
import type { RunInput, Manifest, WorkspaceTree } from '@generated/types'
import type { PackInstallOutcome } from './03-pack-install.js'

vi.mock('../opencode/spawn.js', () => ({
  spawnProcess: vi.fn(),
  execCmd: vi.fn(),
}))

const { spawnProcess } = await import('../opencode/spawn.js')
const spawnMock = vi.mocked(spawnProcess)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const baseTimeouts = {
  preflightSeconds: 30,
  runSeconds: 60,
  verifySeconds: 60,
  installSeconds: 5,
  watchdogSeconds: 60,
}

const makeRunInput = (overrides: Partial<RunInput>): RunInput => ({
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: true, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  pureBaseline: true,
  protectGit: false,
  allowBaselineTool: false,
  initSide: 'both',
  preflightEnabled: true,
  formats: ['md'],
  outputPath: '/out',
  diffHtml: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: baseTimeouts,
  workspacePath: '/ws',
  logLevel: 'info',
  ...overrides,
})

const fakeManifest: Manifest = {
  runId: 'rid',
  timestamp: new Date().toISOString(),
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

const buildWorkspace = (runs: number): WorkspaceTree => {
  const root = makeTempDir()
  const homeNew: string[] = []
  const appsNew: string[] = []
  for (let i = 1; i <= runs; i++) {
    homeNew.push(path.join(root, 'home', 'new', `run-${String(i)}`))
    appsNew.push(path.join(root, 'apps', 'new', `run-${String(i)}`))
  }
  return {
    root,
    appsSource: path.join(root, 'src'),
    appsOld: [],
    appsNew,
    pack: path.join(root, 'pack'),
    homeOld: [],
    homeNew,
    gitDirsOld: [],
    gitDirsNew: [],
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'raw'),
    diff: path.join(root, 'diff'),
  }
}

const buildInput = (
  runs: number,
  overrides: Partial<RunInput>,
  packInstall?: PackInstallOutcome,
): { readonly input: PackSetupInputExt; readonly workspace: WorkspaceTree } => {
  const workspace = buildWorkspace(runs)
  return {
    input: {
      runInput: makeRunInput(overrides),
      manifest: { ...fakeManifest, runs },
      workspace,
      ...(packInstall === undefined ? {} : { packInstall }),
    },
    workspace,
  }
}

describe('phase 04b — pack-setup', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5, timedOut: false }),
    )
  })

  it('all three absent → no-op, mode=delivered-only, empty checks/exercises, no HOME touched', async () => {
    const { input, workspace } = buildInput(1, {})
    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('delivered-only')
    expect(result.report.setupDeclared).toBe(false)
    expect(result.report.checkDeclared).toBe(false)
    expect(result.report.exerciseDeclared).toBe(false)
    expect(result.report.setup).toBeUndefined()
    expect(result.report.checks).toEqual([])
    expect(result.report.exercises).toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
    expect(await runP(exists(path.join(workspace.homeNew[0]!, '.local/bin')))).toBe(false)
  })

  it('--pack-setup declared and succeeds → setup PackCmdResult recorded, HOME copied to runs 2..N', async () => {
    const { input, workspace } = buildInput(3, { packSetup: 'npm install -g x' })
    // seed homeNew[0] with a marker mimicking what the real install would
    // leave behind — spawnProcess is mocked, so it never touches disk.
    await runP(ensureDir(path.join(workspace.homeNew[0]!, '.local/bin')))
    await runP(writeFile(path.join(workspace.homeNew[0]!, '.local/bin', 'mytool'), '#!/bin/sh\necho hi\n'))

    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('installed-only')
    expect(result.report.setup?.exitCode).toBe(0)
    expect(result.report.setup?.side).toBe('new')
    expect(result.report.setup?.runIndex).toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)

    for (const homeDir of [workspace.homeNew[1]!, workspace.homeNew[2]!]) {
      const copied = path.join(homeDir, '.local/bin', 'mytool')
      expect(await runP(exists(copied))).toBe(true)
      expect(await runP(readFile(copied))).toBe('#!/bin/sh\necho hi\n')
    }
  })

  it('setup exit non-zero → E_PACK_SETUP_FAILED, no HOME copy attempted', async () => {
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: 'boom', exitCode: 1, durationMs: 5, timedOut: false }),
    )
    const { input, workspace } = buildInput(2, { packSetup: 'false' })
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_FAILED')
    expect(await runP(exists(path.join(workspace.homeNew[1]!, '.local/bin')))).toBe(false)
  })

  it('setup times out → E_PACK_SETUP_TIMEOUT', async () => {
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: null, durationMs: 5000, timedOut: true }),
    )
    const { input } = buildInput(1, { packSetup: 'sleep 999' })
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_TIMEOUT')
  })

  it('setup + check, no exercise → mode installed-only', async () => {
    const { input } = buildInput(1, { packSetup: 's', packCheck: 'c' })
    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('installed-only')
    expect(result.report.checkDeclared).toBe(true)
    expect(result.report.exerciseDeclared).toBe(false)
  })

  it('setup + check + exercise → mode exercised', async () => {
    const { input } = buildInput(1, { packSetup: 's', packCheck: 'c', packExercise: 'e' })
    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('exercised')
  })

  // Review-gate regression: --pack-check only ever executes inside preflight
  // gate 6 (05-preflight.ts). Declaring it with preflight disabled means it
  // never runs — mode must not read as "installed-only" (verified) in that
  // case; 00-cli-parse.ts now refuses the combination outright, but this
  // phase stays defensive about it too (see derivePackSetupMode's doc).
  it('--pack-check declared with preflight disabled, no --pack-setup → mode delivered-only, not installed-only (check never ran)', async () => {
    const { input } = buildInput(1, { packCheck: 'c', preflightEnabled: false })
    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('delivered-only')
    // checkDeclared still records the true request — only `mode` (the
    // verification-evidence claim) is downgraded.
    expect(result.report.checkDeclared).toBe(true)
    expect(result.report.checks).toEqual([])
  })

  it('--pack-check declared with preflight disabled BUT --pack-setup also declared → mode still installed-only (setup itself always runs, independent of preflight)', async () => {
    const { input } = buildInput(1, { packSetup: 's', packCheck: 'c', preflightEnabled: false })
    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('installed-only')
  })

  it('marker scan: nothing declared but pack has pyproject.toml → undeclaredDepWarning, still mode=delivered-only (not a failure)', async () => {
    const packRoot = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packRoot))
    await runP(writeFile(path.join(packRoot, 'pyproject.toml'), '[project]\nname = "x"\n'))
    const packInstall: PackInstallOutcome = {
      packPath: packRoot, detectedType: 'skill', installLogPath: '/tmp/x.log',
      registeredIn: ['skills'], instructions: [],
    }
    const { input } = buildInput(1, {}, packInstall)
    const result = await runP(packSetup(input))
    expect(result.report.mode).toBe('delivered-only')
    expect(result.report.undeclaredDepWarning).toContain('pyproject.toml')
    expect(result.report.undeclaredDepWarning).toContain('nothing was declared')
  })

  it('marker scan: skipped once --pack-setup is declared, even if markers are present', async () => {
    const packRoot = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packRoot))
    await runP(writeFile(path.join(packRoot, 'pyproject.toml'), '[project]\n'))
    const packInstall: PackInstallOutcome = {
      packPath: packRoot, detectedType: 'skill', installLogPath: '/tmp/x.log',
      registeredIn: ['skills'], instructions: [],
    }
    const { input } = buildInput(1, { packSetup: 's' }, packInstall)
    const result = await runP(packSetup(input))
    expect(result.report.undeclaredDepWarning).toBeUndefined()
  })

  it('marker scan: no markers found → no warning', async () => {
    const packRoot = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packRoot))
    await runP(writeFile(path.join(packRoot, 'SKILL.md'), '# a self-contained skill, no external tool\n'))
    const packInstall: PackInstallOutcome = {
      packPath: packRoot, detectedType: 'skill', installLogPath: '/tmp/x.log',
      registeredIn: ['skills'], instructions: [],
    }
    const { input } = buildInput(1, {}, packInstall)
    const result = await runP(packSetup(input))
    expect(result.report.undeclaredDepWarning).toBeUndefined()
  })
})

describe('derivePackSetupMode', () => {
  it('exercised requires BOTH check verified and exercise happened', () => {
    expect(derivePackSetupMode(true, true, true)).toBe('exercised')
    expect(derivePackSetupMode(false, true, true)).toBe('exercised')
  })
  // Review-gate regression: exercise happening alone (no verified check)
  // used to claim "exercised" — the banner for that mode says "verified it
  // functional", which was false when the check never ran.
  it('exercise happened but check was never verified → installed-only, not exercised', () => {
    expect(derivePackSetupMode(false, false, true)).toBe('installed-only')
    expect(derivePackSetupMode(true, false, true)).toBe('installed-only')
  })
  it('setup or verified check, no exercise → installed-only', () => {
    expect(derivePackSetupMode(true, false, false)).toBe('installed-only')
    expect(derivePackSetupMode(false, true, false)).toBe('installed-only')
    expect(derivePackSetupMode(true, true, false)).toBe('installed-only')
  })
  it('nothing declared/verified/happened → delivered-only', () => {
    expect(derivePackSetupMode(false, false, false)).toBe('delivered-only')
  })
})

describe('scanForDependencyMarkers', () => {
  it('empty packRoot → undefined, no crash', async () => {
    expect(await runP(scanForDependencyMarkers(''))).toBeUndefined()
  })

  it('package.json with a bin field is a marker', async () => {
    const dir = makeTempDir()
    await runP(ensureDir(dir))
    await runP(writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', bin: { x: 'bin.js' } })))
    const warning = await runP(scanForDependencyMarkers(dir))
    expect(warning).toContain('package.json bin')
  })

  it('requirements.txt is a marker', async () => {
    const dir = makeTempDir()
    await runP(ensureDir(dir))
    await runP(writeFile(path.join(dir, 'requirements.txt'), 'requests\n'))
    const warning = await runP(scanForDependencyMarkers(dir))
    expect(warning).toContain('requirements*.txt')
  })

  it('install-command text in SKILL.md is a marker', async () => {
    const dir = makeTempDir()
    await runP(ensureDir(dir))
    await runP(writeFile(path.join(dir, 'SKILL.md'), 'Step 1: run `pip install mytool`\n'))
    const warning = await runP(scanForDependencyMarkers(dir))
    expect(warning).toContain('install command text')
  })
})
