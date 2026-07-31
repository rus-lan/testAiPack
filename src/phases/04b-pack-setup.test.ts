import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, exists, readFile, writeFile } from '../util/fs.js'
import { packSetup, derivePackSetupMode, scanForDependencyMarkers } from './04b-pack-setup.js'
import type { PackSetupInputExt } from './04b-pack-setup.js'
import type { RunInput, Manifest, WorkspaceTree, VariantTree, VariantSpec, PackSpec, VariantEnv } from '@generated/types'
import type { PackInstallOutcome, PackDeliveryExt } from './03-pack-install.js'

vi.mock('../opencode/spawn.js', () => ({
  spawnProcess: vi.fn(),
  execCmd: vi.fn(),
}))

// TODO(WP15): unmock — 00-cli-parse.ts (WP2) owns the real packsOf.
vi.mock('./00-cli-parse.js', () => ({
  packsOf: (runInput: RunInput, v: VariantSpec): readonly PackSpec[] =>
    v.packs
      .map((name) => runInput.packs.find((p) => p.name === name))
      .filter((p): p is PackSpec => p !== undefined),
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

const makeRunInput = (
  variants: VariantSpec[],
  packs: PackSpec[],
  overrides: Partial<RunInput> = {},
): RunInput => ({
  schemaVersion: 2,
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  parallel: 2,
  baseline: variants[0]?.name ?? 'base',
  packs,
  variants,
  isolation: 'home',
  auth: {
    opencode: true, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  preflightEnabled: true,
  formats: ['md'],
  outputPath: '/out',
  diffHtml: false,
  protectGit: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: baseTimeouts,
  workspacePath: '/ws',
  logLevel: 'info',
  ...overrides,
})

const fakeManifest = (variants: VariantSpec[], packs: PackSpec[]): Manifest => ({
  schemaVersion: 2,
  runId: 'rid',
  timestamp: new Date().toISOString(),
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  parallel: 2,
  baseline: variants[0]?.name ?? 'base',
  packs,
  variants,
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
})

const buildWorkspace = (names: readonly string[], runs: number): WorkspaceTree => {
  const root = makeTempDir()
  const variantTrees: VariantTree[] = names.map((name) => {
    const homes: string[] = []
    const apps: string[] = []
    for (let i = 1; i <= runs; i++) {
      homes.push(path.join(root, 'home', name, `run-${String(i)}`))
      apps.push(path.join(root, 'apps', name, `run-${String(i)}`))
    }
    return { name, apps, homes, gitDirs: [] }
  })
  return {
    root,
    appsSource: path.join(root, 'src'),
    pack: path.join(root, 'pack'),
    variantTrees,
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'raw'),
    diff: path.join(root, 'diff'),
  }
}

const homesOf = (workspace: WorkspaceTree, name: string): readonly string[] =>
  workspace.variantTrees.find((t) => t.name === name)?.homes ?? []

const buildInput = (
  variants: VariantSpec[],
  packs: PackSpec[],
  overrides: Partial<RunInput> = {},
  packInstall?: PackInstallOutcome,
  envVars?: readonly VariantEnv[],
): { readonly input: PackSetupInputExt; readonly workspace: WorkspaceTree } => {
  const runs = overrides.runs ?? 1
  const workspace = buildWorkspace(
    variants.map((v) => v.name),
    runs,
  )
  return {
    input: {
      runInput: makeRunInput(variants, packs, overrides),
      manifest: { ...fakeManifest(variants, packs), runs },
      workspace,
      ...(packInstall === undefined ? {} : { packInstall }),
      ...(envVars === undefined ? {} : { envVars }),
    },
    workspace,
  }
}

const makeOutcome = (deliveries: PackDeliveryExt[]): PackInstallOutcome => ({
  deliveries,
  installLogPath: '/tmp/install.log',
})

describe('phase 04b — pack-setup', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5, timedOut: false }),
    )
  })

  it('empty registry → no-op, empty packs/variants report accordingly, no HOME touched', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const { input, workspace } = buildInput(variants, [])
    const result = await runP(packSetup(input))
    expect(result.report.packs).toEqual([])
    expect(result.report.variants).toEqual([{ variant: 'a', exerciseDeclared: false, exercises: [] }])
    expect(spawnMock).not.toHaveBeenCalled()
    expect(await runP(exists(path.join(homesOf(workspace, 'a')[0]!, '.local/bin')))).toBe(false)
  })

  it('registry pack with nothing declared → mode delivered-only, empty checks/exercises', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo' }]
    const { input } = buildInput(variants, packs)
    const result = await runP(packSetup(input))
    expect(result.report.packs).toHaveLength(1)
    const prep = result.report.packs[0]!
    expect(prep.mode).toBe('delivered-only')
    expect(prep.setupDeclared).toBe(false)
    expect(prep.checkDeclared).toBe(false)
    expect(prep.exerciseDeclared).toBe(false)
    expect(prep.setups).toEqual([])
    expect(prep.checks).toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('setup declared and succeeds → setup PackCmdResult recorded (variant, pack, runIndex 0), HOME copied to runs 2..N', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'npm install -g x' }]
    const { input, workspace } = buildInput(variants, packs, { runs: 3 })
    const homes = homesOf(workspace, 'a')
    // seed homes[0] with a marker mimicking what the real install would leave
    // behind — spawnProcess is mocked, so it never touches disk.
    await runP(ensureDir(path.join(homes[0]!, '.local/bin')))
    await runP(writeFile(path.join(homes[0]!, '.local/bin', 'mytool'), '#!/bin/sh\necho hi\n'))

    const result = await runP(packSetup(input))
    const prep = result.report.packs.find((p) => p.pack === 'demo')!
    expect(prep.mode).toBe('installed-only')
    expect(prep.setups).toHaveLength(1)
    expect(prep.setups[0]!.variant).toBe('a')
    expect(prep.setups[0]!.pack).toBe('demo')
    expect(prep.setups[0]!.runIndex).toBe(0)
    expect(prep.setups[0]!.exitCode).toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)

    for (const homeDir of [homes[1]!, homes[2]!]) {
      const copied = path.join(homeDir, '.local/bin', 'mytool')
      expect(await runP(exists(copied))).toBe(true)
      expect(await runP(readFile(copied))).toBe('#!/bin/sh\necho hi\n')
    }
  })

  it('setup exit non-zero → E_PACK_SETUP_FAILED naming variant+pack, no HOME copy attempted', async () => {
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: 'boom', exitCode: 1, durationMs: 5, timedOut: false }),
    )
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'false' }]
    const { input, workspace } = buildInput(variants, packs, { runs: 2 })
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_FAILED')
    expect(err.context?.['variant']).toBe('a')
    expect(err.context?.['pack']).toBe('demo')
    expect(await runP(exists(path.join(homesOf(workspace, 'a')[1]!, '.local/bin')))).toBe(false)
  })

  it('setup times out → E_PACK_SETUP_TIMEOUT', async () => {
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: '', stderr: '', exitCode: null, durationMs: 5000, timedOut: true }),
    )
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'sleep 999' }]
    const { input } = buildInput(variants, packs)
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_TIMEOUT')
  })

  it('setup + check, no exercise → mode installed-only', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's', check: 'c' }]
    const { input } = buildInput(variants, packs)
    const result = await runP(packSetup(input))
    const prep = result.report.packs[0]!
    expect(prep.mode).toBe('installed-only')
    expect(prep.checkDeclared).toBe(true)
    expect(prep.exerciseDeclared).toBe(false)
  })

  it('setup + check + exercise (on the declaring variant) → mode exercised', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'], exercise: 'e' }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's', check: 'c' }]
    const { input } = buildInput(variants, packs)
    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.mode).toBe('exercised')
  })

  it('check declared with preflight disabled, no setup → mode delivered-only, not installed-only (check never ran)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', check: 'c' }]
    const { input } = buildInput(variants, packs, { preflightEnabled: false })
    const result = await runP(packSetup(input))
    const prep = result.report.packs[0]!
    expect(prep.mode).toBe('delivered-only')
    expect(prep.checkDeclared).toBe(true)
    expect(prep.checks).toEqual([])
  })

  it('check declared with preflight disabled BUT setup also declared → mode still installed-only (setup itself always runs, independent of preflight)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's', check: 'c' }]
    const { input } = buildInput(variants, packs, { preflightEnabled: false })
    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.mode).toBe('installed-only')
  })

  it('marker scan: nothing declared but pack has pyproject.toml → undeclaredDepWarning, still mode=delivered-only (not a failure)', async () => {
    const packRoot = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packRoot))
    await runP(writeFile(path.join(packRoot, 'pyproject.toml'), '[project]\nname = "x"\n'))
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo' }]
    const outcome = makeOutcome([
      { pack: 'demo', packPath: packRoot, detectedType: 'skill', registeredIn: ['skills'], instructions: [] },
    ])
    const { input } = buildInput(variants, packs, {}, outcome)
    const result = await runP(packSetup(input))
    const prep = result.report.packs[0]!
    expect(prep.mode).toBe('delivered-only')
    expect(prep.undeclaredDepWarning).toContain('pyproject.toml')
    expect(prep.undeclaredDepWarning).toContain('nothing was declared')
  })

  it('marker scan: skipped once setup is declared, even if markers are present', async () => {
    const packRoot = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packRoot))
    await runP(writeFile(path.join(packRoot, 'pyproject.toml'), '[project]\n'))
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's' }]
    const outcome = makeOutcome([
      { pack: 'demo', packPath: packRoot, detectedType: 'skill', registeredIn: ['skills'], instructions: [] },
    ])
    const { input } = buildInput(variants, packs, {}, outcome)
    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.undeclaredDepWarning).toBeUndefined()
  })

  it('marker scan: no markers found → no warning', async () => {
    const packRoot = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packRoot))
    await runP(writeFile(path.join(packRoot, 'SKILL.md'), '# a self-contained skill, no external tool\n'))
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo' }]
    const outcome = makeOutcome([
      { pack: 'demo', packPath: packRoot, detectedType: 'skill', registeredIn: ['skills'], instructions: [] },
    ])
    const { input } = buildInput(variants, packs, {}, outcome)
    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.undeclaredDepWarning).toBeUndefined()
  })

  it('D6: a pack declared by 2 variants runs setup twice (once per variant), copying each variant HOME set independently', async () => {
    const variants: VariantSpec[] = [
      { name: 'x', packs: ['shared'] },
      { name: 'y', packs: ['shared'] },
    ]
    const packs: PackSpec[] = [{ name: 'shared', ref: 'github:owner/shared', setup: 'npm install -g x' }]
    const { input, workspace } = buildInput(variants, packs, { runs: 2 })
    const xHomes = homesOf(workspace, 'x')
    const yHomes = homesOf(workspace, 'y')
    await runP(ensureDir(path.join(xHomes[0]!, '.local/bin')))
    await runP(writeFile(path.join(xHomes[0]!, '.local/bin', 'tool'), 'x-marker'))
    await runP(ensureDir(path.join(yHomes[0]!, '.local/bin')))
    await runP(writeFile(path.join(yHomes[0]!, '.local/bin', 'tool'), 'y-marker'))

    const result = await runP(packSetup(input))
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const prep = result.report.packs[0]!
    expect(prep.setups).toHaveLength(2)
    expect(prep.setups.map((s) => s.variant).sort()).toEqual(['x', 'y'])

    expect(await runP(readFile(path.join(xHomes[1]!, '.local/bin', 'tool')))).toBe('x-marker')
    expect(await runP(readFile(path.join(yHomes[1]!, '.local/bin', 'tool')))).toBe('y-marker')
  })

  it('failure in variant B setup aborts with E_PACK_SETUP_FAILED naming variant+pack; variant A already ran and is unaffected by the abort', async () => {
    let call = 0
    spawnMock.mockImplementation(() => {
      call += 1
      if (call === 1) return Effect.succeed({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, timedOut: false })
      return Effect.succeed({ stdout: '', stderr: 'boom', exitCode: 1, durationMs: 5, timedOut: false })
    })
    const variants: VariantSpec[] = [
      { name: 'a', packs: ['pack-a'] },
      { name: 'b', packs: ['pack-b'] },
    ]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a', setup: 's' },
      { name: 'pack-b', ref: 'github:owner/b', setup: 's' },
    ]
    const { input } = buildInput(variants, packs)
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_FAILED')
    expect(err.context?.['variant']).toBe('b')
    expect(err.context?.['pack']).toBe('pack-b')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('reuses phase 04 envVars PATH for the declaring variant run-1 HOME, not recomputed', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'echo hi' }]
    const envVars: VariantEnv[] = [
      {
        name: 'a',
        envs: [
          {
            HOME: '/whatever',
            OPENCODE_DISABLE_PROJECT_CONFIG: true,
            OPENCODE_DISABLE_DEFAULT_PLUGINS: false,
            OPENCODE_DISABLE_EXTERNAL_SKILLS: false,
            OPENCODE_PURE: false,
            PATH: '/custom/local/bin:/usr/bin',
          },
        ],
      },
    ]
    const { input } = buildInput(variants, packs, {}, undefined, envVars)
    await runP(packSetup(input))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const callArg = spawnMock.mock.calls[0]![0] as { env?: Record<string, string> }
    expect(callArg.env?.['PATH']).toBe('/custom/local/bin:/usr/bin')
  })

  it('N5: absent envVars means no PATH override — the inherited process PATH passes through unchanged, same as no registry pack declaring setup', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'echo hi' }]
    const { input } = buildInput(variants, packs)
    await runP(packSetup(input))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const callArg = spawnMock.mock.calls[0]![0] as { env?: Record<string, string> }
    expect(callArg.env?.['PATH']).toBe(process.env['PATH'])
  })

  it('N2: copy-out rewrites a local-plugin absolute path in opencode.json from run-1 to the destination run (HOME mode only)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's' }]
    const { input, workspace } = buildInput(variants, packs, { runs: 2 })
    const homes = homesOf(workspace, 'a')
    // Simulate what phase 04 already wrote into EACH run's own HOME before
    // 04b ever runs: a local-plugin registration whose absolute path is
    // genuinely per-run (04-home-isolation.ts applyInstruction, 'plugin' case).
    for (const home of homes) {
      const cfgDir = path.join(home, '.config', 'opencode')
      await runP(ensureDir(cfgDir))
      const pluginFile = path.join(cfgDir, 'plugins', 'myplugin.js')
      await runP(writeFile(path.join(cfgDir, 'opencode.json'), JSON.stringify({ other: 1, plugin: [pluginFile] })))
    }

    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.setups).toHaveLength(1)

    const run2Cfg = JSON.parse(
      await runP(readFile(path.join(homes[1]!, '.config', 'opencode', 'opencode.json'))),
    ) as { other: number; plugin: string[] }
    expect(run2Cfg.other).toBe(1)
    expect(run2Cfg.plugin).toEqual([path.join(homes[1]!, '.config', 'opencode', 'plugins', 'myplugin.js')])
    // Sanity: it must actually have been rewritten away from run-1's path,
    // not merely have started out equal.
    expect(run2Cfg.plugin[0]).not.toBe(path.join(homes[0]!, '.config', 'opencode', 'plugins', 'myplugin.js'))
  })

  it('N2: docker mode is unaffected — plugin paths are already homeDir-agnostic (/home/opencode/...), copy-out leaves them untouched', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's' }]
    const { input, workspace } = buildInput(variants, packs, { runs: 2, isolation: 'docker' })
    const homes = homesOf(workspace, 'a')
    const containerPath = '/home/opencode/.config/opencode/plugins/myplugin.js'
    for (const home of homes) {
      const cfgDir = path.join(home, '.config', 'opencode')
      await runP(ensureDir(cfgDir))
      await runP(writeFile(path.join(cfgDir, 'opencode.json'), JSON.stringify({ plugin: [containerPath] })))
    }
    await runP(packSetup(input))
    const run2Cfg = JSON.parse(
      await runP(readFile(path.join(homes[1]!, '.config', 'opencode', 'opencode.json'))),
    ) as { plugin: string[] }
    expect(run2Cfg.plugin).toEqual([containerPath])
  })
})

describe('derivePackSetupMode', () => {
  it('exercised requires BOTH check verified and exercise happened', () => {
    expect(derivePackSetupMode(true, true, true)).toBe('exercised')
    expect(derivePackSetupMode(false, true, true)).toBe('exercised')
  })
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
