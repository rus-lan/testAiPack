import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, exists, readFile, writeFile } from '../util/fs.js'
import { addAll, commit, init } from '../util/git.js'
import { packSetup, derivePackSetupMode, scanForDependencyMarkers } from './04b-pack-setup.js'
import type { PackSetupInputExt } from './04b-pack-setup.js'
import type { RunInput, Manifest, WorkspaceTree, VariantTree, VariantSpec, PackSpec, VariantEnv } from '@generated/types'
import type { PackInstallOutcome, PackDeliveryExt } from './03-pack-install.js'

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

const appsOf = (workspace: WorkspaceTree, name: string): readonly string[] =>
  workspace.variantTrees.find((t) => t.name === name)?.apps ?? []

/**
 * Real git repo at `appDir` with one committed file (`README.md`) — 04b now
 * runs `git status --porcelain` against a variant's run-1 app dir after every
 * successful `setup`, so it must be a genuine git worktree even in tests
 * where `spawnProcess` (and therefore the setup command itself) is mocked.
 */
const initAppRepo = async (appDir: string): Promise<void> => {
  await runP(ensureDir(appDir))
  await runP(init(appDir))
  await runP(writeFile(path.join(appDir, 'README.md'), 'seed\n'))
  await runP(addAll(appDir))
  await runP(commit(appDir, 'init'))
}

const buildInput = async (
  variants: VariantSpec[],
  packs: PackSpec[],
  overrides: Partial<RunInput> = {},
  packInstall?: PackInstallOutcome,
  envVars?: readonly VariantEnv[],
): Promise<{ readonly input: PackSetupInputExt; readonly workspace: WorkspaceTree }> => {
  const runs = overrides.runs ?? 1
  const workspace = buildWorkspace(
    variants.map((v) => v.name),
    runs,
  )
  // Every run's app dir is a real git repo in production (phase 02 clones the
  // same commit into each) — init all of them, not just run-1's, so a test
  // asserting "run-2 was never touched" is checking a real starting state
  // rather than a path nothing ever created.
  for (const v of variants) {
    for (const appDir of appsOf(workspace, v.name)) {
      await initAppRepo(appDir)
    }
    // run-1's HOME must exist on disk once setup succeeds and `runs > 1` —
    // the existing restHomes copy-out (`copyDir(home0, homeDir)`) always
    // runs after a successful setup, HOME contamination or not.
    const home0 = homesOf(workspace, v.name)[0]
    if (home0 !== undefined) await runP(ensureDir(home0))
  }
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
    const { input, workspace } = await buildInput(variants, [])
    const result = await runP(packSetup(input))
    expect(result.report.packs).toEqual([])
    expect(result.report.variants).toEqual([{ variant: 'a', exerciseDeclared: false, exercises: [] }])
    expect(spawnMock).not.toHaveBeenCalled()
    expect(await runP(exists(path.join(homesOf(workspace, 'a')[0]!, '.local/bin')))).toBe(false)
  })

  it('registry pack with nothing declared → mode delivered-only, empty checks/exercises', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo' }]
    const { input } = await buildInput(variants, packs)
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
    const { input, workspace } = await buildInput(variants, packs, { runs: 3 })
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
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
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
    const { input } = await buildInput(variants, packs)
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_TIMEOUT')
  })

  it('setup + check, no exercise → mode installed-only', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's', check: 'c' }]
    const { input } = await buildInput(variants, packs)
    const result = await runP(packSetup(input))
    const prep = result.report.packs[0]!
    expect(prep.mode).toBe('installed-only')
    expect(prep.checkDeclared).toBe(true)
    expect(prep.exerciseDeclared).toBe(false)
  })

  it('setup + check + exercise (on the declaring variant) → mode exercised', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'], exercise: 'e' }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's', check: 'c' }]
    const { input } = await buildInput(variants, packs)
    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.mode).toBe('exercised')
  })

  it('check declared with preflight disabled, no setup → mode delivered-only, not installed-only (check never ran)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', check: 'c' }]
    const { input } = await buildInput(variants, packs, { preflightEnabled: false })
    const result = await runP(packSetup(input))
    const prep = result.report.packs[0]!
    expect(prep.mode).toBe('delivered-only')
    expect(prep.checkDeclared).toBe(true)
    expect(prep.checks).toEqual([])
  })

  it('check declared with preflight disabled BUT setup also declared → mode still installed-only (setup itself always runs, independent of preflight)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's', check: 'c' }]
    const { input } = await buildInput(variants, packs, { preflightEnabled: false })
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
    const { input } = await buildInput(variants, packs, {}, outcome)
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
    const { input } = await buildInput(variants, packs, {}, outcome)
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
    const { input } = await buildInput(variants, packs, {}, outcome)
    const result = await runP(packSetup(input))
    expect(result.report.packs[0]!.undeclaredDepWarning).toBeUndefined()
  })

  it('D6: a pack declared by 2 variants runs setup twice (once per variant), copying each variant HOME set independently', async () => {
    const variants: VariantSpec[] = [
      { name: 'x', packs: ['shared'] },
      { name: 'y', packs: ['shared'] },
    ]
    const packs: PackSpec[] = [{ name: 'shared', ref: 'github:owner/shared', setup: 'npm install -g x' }]
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
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
    const { input } = await buildInput(variants, packs)
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_FAILED')
    expect(err.context?.['variant']).toBe('b')
    expect(err.context?.['pack']).toBe('pack-b')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  // ---- Stage 2 (WP16): multi-pack sequential ordering ---------------------

  it('Stage 2: two packs with setup on ONE variant run sequentially in DECLARATION order, not registry order', async () => {
    const calls: string[] = []
    spawnMock.mockImplementation((opts: { args: readonly string[] }) => {
      calls.push(opts.args[1] ?? '')
      return Effect.succeed({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, timedOut: false })
    })
    // registry order is [pack-a, pack-b] but the variant declares them reversed
    const variants: VariantSpec[] = [{ name: 'multi', packs: ['pack-b', 'pack-a'] }]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a', setup: 'install-a' },
      { name: 'pack-b', ref: 'github:owner/b', setup: 'install-b' },
    ]
    const { input } = await buildInput(variants, packs)
    const result = await runP(packSetup(input))
    expect(calls).toEqual(['install-b', 'install-a'])
    expect(result.report.packs.find((p) => p.pack === 'pack-a')!.setups).toHaveLength(1)
    expect(result.report.packs.find((p) => p.pack === 'pack-b')!.setups).toHaveLength(1)
  })

  it('Stage 2: a mid-sequence failure on the SECOND pack of one variant aborts naming that variant+pack; the first pack already ran', async () => {
    let call = 0
    spawnMock.mockImplementation(() => {
      call += 1
      if (call === 1) return Effect.succeed({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, timedOut: false })
      return Effect.succeed({ stdout: '', stderr: 'boom', exitCode: 1, durationMs: 5, timedOut: false })
    })
    const variants: VariantSpec[] = [{ name: 'multi', packs: ['pack-a', 'pack-b'] }]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a', setup: 'install-a' },
      { name: 'pack-b', ref: 'github:owner/b', setup: 'install-b' },
    ]
    const { input } = await buildInput(variants, packs)
    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_FAILED')
    expect(err.context?.['variant']).toBe('multi')
    expect(err.context?.['pack']).toBe('pack-b')
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('Stage 2: copy-out rewrites BOTH packs\' local-plugin paths when a variant declares two setup packs', async () => {
    const variants: VariantSpec[] = [{ name: 'multi', packs: ['pack-a', 'pack-b'] }]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a', setup: 'install-a' },
      { name: 'pack-b', ref: 'github:owner/b', setup: 'install-b' },
    ]
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
    const homes = homesOf(workspace, 'multi')
    // Simulate what phase 04 already wrote into EACH run's own HOME before
    // 04b ever runs: two local-plugin registrations, one per pack, each with
    // a genuinely per-run absolute path.
    for (const home of homes) {
      const cfgDir = path.join(home, '.config', 'opencode')
      await runP(ensureDir(cfgDir))
      const pluginA = path.join(cfgDir, 'plugins', 'plugin-a.js')
      const pluginB = path.join(cfgDir, 'plugins', 'plugin-b.js')
      await runP(writeFile(path.join(cfgDir, 'opencode.json'), JSON.stringify({ plugin: [pluginA, pluginB] })))
    }

    const result = await runP(packSetup(input))
    expect(result.report.packs.find((p) => p.pack === 'pack-a')!.setups).toHaveLength(1)
    expect(result.report.packs.find((p) => p.pack === 'pack-b')!.setups).toHaveLength(1)

    const run2Cfg = JSON.parse(
      await runP(readFile(path.join(homes[1]!, '.config', 'opencode', 'opencode.json'))),
    ) as { plugin: string[] }
    expect(run2Cfg.plugin).toEqual([
      path.join(homes[1]!, '.config', 'opencode', 'plugins', 'plugin-a.js'),
      path.join(homes[1]!, '.config', 'opencode', 'plugins', 'plugin-b.js'),
    ])
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
    const { input } = await buildInput(variants, packs, {}, undefined, envVars)
    await runP(packSetup(input))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const callArg = spawnMock.mock.calls[0]![0] as { env?: Record<string, string> }
    expect(callArg.env?.['PATH']).toBe('/custom/local/bin:/usr/bin')
  })

  it('N5: absent envVars means no PATH override — the inherited process PATH passes through unchanged, same as no registry pack declaring setup', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'echo hi' }]
    const { input } = await buildInput(variants, packs)
    await runP(packSetup(input))
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const callArg = spawnMock.mock.calls[0]![0] as { env?: Record<string, string> }
    expect(callArg.env?.['PATH']).toBe(process.env['PATH'])
  })

  it('N2: copy-out rewrites a local-plugin absolute path in opencode.json from run-1 to the destination run (HOME mode only)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 's' }]
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
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
    const { input, workspace } = await buildInput(variants, packs, { runs: 2, isolation: 'docker' })
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

// ---------------------------------------------------------------------------
// App-dir contamination: a setup that writes into the workspace (not just
// HOME) must not silently diverge run-1 from runs 2..N — a setup command like
// `graphify opencode install`, which writes AGENTS.md/.opencode/plugins into
// cwd, previously left run-1 the only run to ever see those files.
// ---------------------------------------------------------------------------

describe('phase 04b — pack-setup: app-dir contamination', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() =>
      Effect.succeed({ stdout: 'ok', stderr: '', exitCode: 0, durationMs: 5, timedOut: false }),
    )
  })

  it('setup writes an untracked file into run-1 app dir -> present in every run\'s app dir for that variant', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'graphify opencode install' }]
    const { input, workspace } = await buildInput(variants, packs, { runs: 3 })
    const apps = appsOf(workspace, 'a')
    // seed app0 with a marker mimicking what the real install would leave
    // behind — spawnProcess is mocked, so it never touches disk.
    await runP(writeFile(path.join(apps[0]!, 'AGENTS.md'), 'contamination\n'))

    await runP(packSetup(input))

    for (const appDir of [apps[1]!, apps[2]!]) {
      expect(await runP(exists(path.join(appDir, 'AGENTS.md')))).toBe(true)
      expect(await runP(readFile(path.join(appDir, 'AGENTS.md')))).toBe('contamination\n')
    }
  })

  it('...and is excluded from the measured diff for every run (not just run-1): every run\'s own .git/info/exclude gets it, plus a per-variant record for phase 08', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'graphify opencode install' }]
    const { input, workspace } = await buildInput(variants, packs, { runs: 3 })
    const apps = appsOf(workspace, 'a')
    await runP(writeFile(path.join(apps[0]!, 'AGENTS.md'), 'contamination\n'))

    await runP(packSetup(input))

    for (const appDir of apps) {
      const exclude = await runP(readFile(path.join(appDir, '.git', 'info', 'exclude')))
      expect(exclude).toContain('AGENTS.md')
    }
    const record = JSON.parse(
      await runP(readFile(path.join(workspace.raw, 'a', 'setup.json'))),
    ) as { excludedPaths: string[] }
    expect(record.excludedPaths).toEqual(['AGENTS.md'])
  })

  it('setup that modifies a TRACKED file in the app dir aborts loudly, naming variant + pack + path — no propagation, no exclude', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'corrupt-tracked-file' }]
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
    const apps = appsOf(workspace, 'a')
    // `initAppRepo` committed README.md — simulate the setup command
    // overwriting it (spawnProcess is mocked, so this stands in for what a
    // real setup would have done to the working tree).
    await runP(writeFile(path.join(apps[0]!, 'README.md'), 'clobbered by setup\n'))

    const err = await runFlip(packSetup(input))
    expect(err.code).toBe('E_PACK_SETUP_FAILED')
    expect(err.message).toContain('modified tracked file')
    expect(err.message).toContain('README.md')
    expect(err.context?.['variant']).toBe('a')
    expect(err.context?.['pack']).toBe('demo')
    expect(err.context?.['paths']).toEqual(['README.md'])
    // run-2's app dir never received anything and was never touched.
    expect(await runP(exists(path.join(apps[1]!, 'README.md')))).toBe(true)
    expect(await runP(readFile(path.join(apps[1]!, 'README.md')))).toBe('seed\n')
  })

  it('setup that writes nothing into the app dir behaves exactly as today — no copy, no exclude, no setup.json (no regression)', async () => {
    const variants: VariantSpec[] = [{ name: 'a', packs: ['demo'] }]
    const packs: PackSpec[] = [{ name: 'demo', ref: 'github:owner/demo', setup: 'npm install -g x' }]
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
    const apps = appsOf(workspace, 'a')
    // `git init` (in `initAppRepo`) already leaves a stock, commented-out
    // `.git/info/exclude` behind — the bar for "no regression" is that
    // `packSetup` leaves it byte-identical, not that it never existed.
    const excludeBefore = await runP(readFile(path.join(apps[0]!, '.git', 'info', 'exclude')))

    await runP(packSetup(input))

    expect(await runP(exists(path.join(workspace.raw, 'a', 'setup.json')))).toBe(false)
    expect(await runP(readFile(path.join(apps[0]!, '.git', 'info', 'exclude')))).toBe(excludeBefore)
    expect(await runP(exists(path.join(apps[1]!, 'AGENTS.md')))).toBe(false)
  })

  it('multi-pack: two packs with setup on ONE variant, both writing into the app dir, both propagated to run-2', async () => {
    const variants: VariantSpec[] = [{ name: 'multi', packs: ['pack-a', 'pack-b'] }]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a', setup: 'install-a' },
      { name: 'pack-b', ref: 'github:owner/b', setup: 'install-b' },
    ]
    const { input, workspace } = await buildInput(variants, packs, { runs: 2 })
    const apps = appsOf(workspace, 'multi')
    spawnMock.mockImplementation((opts: { args: readonly string[] }) => {
      const cmd = opts.args[1] ?? ''
      if (cmd === 'install-a') writeFileSync(path.join(apps[0]!, 'from-a.txt'), 'a\n')
      if (cmd === 'install-b') writeFileSync(path.join(apps[0]!, 'from-b.txt'), 'b\n')
      return Effect.succeed({ stdout: '', stderr: '', exitCode: 0, durationMs: 5, timedOut: false })
    })

    await runP(packSetup(input))

    expect(await runP(exists(path.join(apps[1]!, 'from-a.txt')))).toBe(true)
    expect(await runP(exists(path.join(apps[1]!, 'from-b.txt')))).toBe(true)
    const exclude = await runP(readFile(path.join(apps[1]!, '.git', 'info', 'exclude')))
    expect(exclude).toContain('from-a.txt')
    expect(exclude).toContain('from-b.txt')
    const record = JSON.parse(
      await runP(readFile(path.join(workspace.raw, 'multi', 'setup.json'))),
    ) as { excludedPaths: string[] }
    expect([...record.excludedPaths].sort()).toEqual(['from-a.txt', 'from-b.txt'])
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
