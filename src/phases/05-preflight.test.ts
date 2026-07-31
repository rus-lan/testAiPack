import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, symlink, removeDir } from '../util/fs.js'
import { preflight } from './05-preflight.js'
import type { PreflightInputExt } from './05-preflight.js'
import type {
  HomeCheckTarget,
  Manifest,
  PackSpec,
  PreflightCheck,
  RunInput,
  TimeoutConfig,
  VariantHomesForCheck,
  VariantSpec,
} from '@generated/types'
import type { PackInstallOutcome, PackDeliveryExt } from './03-pack-install.js'
import type * as CliParseModule from './00-cli-parse.js'

vi.mock('../opencode/cli.js', () => ({
  OpencodeError: class extends Error {
    readonly _tag = 'OpencodeError'
    readonly command: string
    readonly exitCode: number | null
    readonly stderr: string
    readonly stdout: string
    readonly timedOut: boolean
    constructor(args: {
      command: string
      exitCode: number | null
      stderr: string
      stdout?: string
      timedOut: boolean
    }) {
      super(`opencode ${args.command} failed`)
      this.command = args.command
      this.exitCode = args.exitCode
      this.stderr = args.stderr
      this.stdout = args.stdout ?? ''
      this.timedOut = args.timedOut
    }
  },
  version: vi.fn(),
  run: vi.fn(),
  installPlugin: vi.fn(),
  exportSession: vi.fn(),
  listMcp: vi.fn(),
}))

vi.mock('../opencode/spawn.js', () => ({
  spawnProcess: vi.fn(),
  execCmd: vi.fn(),
}))

vi.mock('../isolation/docker-runner.js', () => ({
  ensureImage: vi.fn(),
  dockerRun: vi.fn(),
  DEFAULT_OPENCODE_IMAGE: 'testaipack-opencode:latest',
  DockerError: class extends Error {
    readonly _tag = 'DockerError'
    readonly command: string
    readonly exitCode: number | null
    readonly stderr: string
    readonly timedOut: boolean
    constructor(args: {
      command: string
      exitCode: number | null
      stderr: string
      timedOut: boolean
      cause?: unknown
    }) {
      super(`docker ${args.command} failed`)
      this.command = args.command
      this.exitCode = args.exitCode
      this.stderr = args.stderr
      this.timedOut = args.timedOut
    }
  },
}))

// Real packsOf/foreignPacksOf/effectiveOf run by default (wrapped as
// vi.fn() so individual tests can still override just one via
// `foreignPacksOfMock.mockReturnValueOnce(...)` etc. to isolate a gate's own
// logic from real name-resolution behavior).
vi.mock('./00-cli-parse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CliParseModule>()
  return {
    ...actual,
    packsOf: vi.fn(actual.packsOf),
    foreignPacksOf: vi.fn(actual.foreignPacksOf),
    effectiveOf: vi.fn(actual.effectiveOf),
  }
})

const { version, run, OpencodeError } = await import('../opencode/cli.js')
const versionMock = vi.mocked(version)
const runMock = vi.mocked(run)
const { ensureImage, dockerRun, DockerError, DEFAULT_OPENCODE_IMAGE } = await import('../isolation/docker-runner.js')
const ensureImageMock = vi.mocked(ensureImage)
const dockerRunMock = vi.mocked(dockerRun)
const { spawnProcess } = await import('../opencode/spawn.js')
const spawnMock = vi.mocked(spawnProcess)
const { packsOf, foreignPacksOf, effectiveOf } = await import('./00-cli-parse.js')
const packsOfMock = vi.mocked(packsOf)
const foreignPacksOfMock = vi.mocked(foreignPacksOf)
const effectiveOfMock = vi.mocked(effectiveOf)
const {
  packsOf: realPacksOf,
  foreignPacksOf: realForeignPacksOf,
  effectiveOf: realEffectiveOf,
} = await vi.importActual<typeof CliParseModule>('./00-cli-parse.js')

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const baseTimeouts: TimeoutConfig = {
  preflightSeconds: 30,
  runSeconds: 60,
  verifySeconds: 60,
  installSeconds: 5,
  watchdogSeconds: 60,
}

const makeRunInput = (overrides: Partial<RunInput>): RunInput => ({
  schemaVersion: 2,
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  parallel: 1,
  baseline: 'base',
  packs: [],
  variants: [{ name: 'base', packs: [] }],
  isolation: 'home',
  auth: {
    opencode: true,
    npmrc: false,
    anthropic: false,
    openai: false,
    gemini: false,
    aws: false,
    ssh: false,
    git: false,
  },
  protectGit: false,
  preflightEnabled: true,
  preflightModel: 'cheap/model',
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
  schemaVersion: 2,
  runId: 'rid',
  timestamp: new Date().toISOString(),
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  parallel: 1,
  baseline: 'base',
  packs: [],
  variants: [{ name: 'base', packs: [] }],
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

/** Build one HOME with the build agent in place (as phase 04 leaves it). */
const buildHome = async (root: string, variant: string, runIndex: number): Promise<string> => {
  const home = path.join(root, 'home', variant, `run-${String(runIndex)}`)
  await runP(ensureDir(path.join(home, '.config', 'opencode', 'skills')))
  await runP(ensureDir(path.join(home, '.config', 'opencode', 'agents')))
  await runP(ensureDir(path.join(home, '.config', 'opencode', 'plugins')))
  await runP(ensureDir(path.join(home, '.config', 'opencode', 'command')))
  await runP(writeFile(path.join(home, '.config', 'opencode', 'agents', 'build.md'), '# build\n'))
  return home
}

/** Build `runs` HOMEs for each named variant; returns { variantName: [homeDir, ...] }. */
const buildVariantHomes = async (
  root: string,
  variants: readonly string[],
  runs = 1,
): Promise<Record<string, string[]>> => {
  const result: Record<string, string[]> = {}
  for (const v of variants) {
    const dirs: string[] = []
    for (let i = 1; i <= runs; i++) {
      dirs.push(await buildHome(root, v, i))
    }
    result[v] = dirs
  }
  return result
}

const homesForCheckOf = (
  homesByVariant: Record<string, string[]>,
  pathOverrides?: Record<string, string>,
): VariantHomesForCheck[] =>
  Object.entries(homesByVariant).map(([name, dirs]) => ({
    name,
    homes: dirs.map(
      (homeDir): HomeCheckTarget => ({
        homeDir,
        ...(pathOverrides?.[name] === undefined ? {} : { pathOverride: pathOverrides[name] }),
      }),
    ),
  }))

const buildInput = (
  homesByVariant: Record<string, string[]>,
  runInputOverrides: Partial<RunInput>,
  extra: Partial<Pick<PreflightInputExt, 'packInstall' | 'dockerImage' | 'configs'>> = {},
): PreflightInputExt => {
  const runInput = makeRunInput(runInputOverrides)
  return {
    runInput,
    manifest: { ...fakeManifest, variants: runInput.variants, packs: runInput.packs, baseline: runInput.baseline },
    homesForCheck: homesForCheckOf(homesByVariant),
    // packInstall is required on the contract (phase 03 always produces one,
    // even an empty-registry smoke test) — default to "nothing delivered",
    // overridable per test via `extra.packInstall`.
    packInstall: packInstallOf([]),
    ...extra,
  }
}

const expectedLogPath = (input: PreflightInputExt): string =>
  path.join(input.runInput.outputPath, 'preflight.log')

const skillDelivery = (packName: string, packDir: string, skillName = packName): PackDeliveryExt => ({
  pack: packName,
  packPath: packDir,
  detectedType: 'skill',
  registeredIn: ['skills'],
  instructions: [{ kind: 'skill', name: skillName, target: packDir }],
})

const packInstallOf = (deliveries: readonly PackDeliveryExt[]): PackInstallOutcome => ({
  deliveries: [...deliveries],
  installLogPath: '/tmp/install.log',
})

/**
 * Registers a minimal real 'skill' instruction for `packName`, delivered
 * AND made visible (a real SKILL.md symlinked in) in `variant`'s run-1 HOME.
 * Gate 4/5 now fail loud on a declared/foreign pack with zero recorded
 * instructions (B1 fix), so gate-6-focused tests that only care about the
 * `check` command flow still need *some* real delivery for any pack a
 * variant declares, or gate 4 fails before gate 6 ever runs.
 */
const withMinimalDelivery = async (
  homes: Record<string, string[]>,
  variant: string,
  packName: string,
): Promise<PackDeliveryExt> => {
  const packDir = makeTempDir('testaipack-pack-src-')
  await runP(ensureDir(packDir))
  await runP(writeFile(path.join(packDir, 'SKILL.md'), `# ${packName}\n`))
  await runP(symlink(packDir, path.join(homes[variant]![0]!, '.config', 'opencode', 'skills', packName)))
  return skillDelivery(packName, packDir, packName)
}

const checkByVariant = (
  result: { readonly checks: readonly PreflightCheck[] },
  name: string,
  variant: string,
): PreflightCheck | undefined => result.checks.find((c) => c.name === name && c.variant === variant)

describe('phase 05 — preflight', () => {
  beforeEach(() => {
    versionMock.mockReset()
    runMock.mockReset()
    ensureImageMock.mockReset()
    ensureImageMock.mockImplementation(() => Effect.void)
    dockerRunMock.mockReset()
    dockerRunMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
    )
    spawnMock.mockReset()
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }),
    )
    versionMock.mockImplementation(() => Effect.succeed('1.0.0'))
    runMock.mockImplementation(() =>
      Effect.succeed({
        exitCode: 0,
        stdout: '{"role":"assistant","text":"OK"}',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    )
    packsOfMock.mockReset()
    packsOfMock.mockImplementation(realPacksOf)
    foreignPacksOfMock.mockReset()
    foreignPacksOfMock.mockImplementation(realForeignPacksOf)
    effectiveOfMock.mockReset()
    effectiveOfMock.mockImplementation(realEffectiveOf)
  })

  it('--no-preflight → checks=[], allPassed=true, exitCode=0', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['base'])
    const input = buildInput(homes, { preflightEnabled: false, workspacePath: root, outputPath: path.join(root, 'out') })
    const result = await runP(preflight(input))
    expect(result.checks).toEqual([])
    expect(result.allPassed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.logPath).toBe(expectedLogPath(input))
  })

  it('smoke variant (no packs anywhere): gates 1-3 per variant + gate 4/5/6 skip lines, exitCode=0', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['base'])
    const input = buildInput(homes, { workspacePath: root, outputPath: path.join(root, 'out') })
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.allPassed).toBe(true)
    expect(result.checks).toHaveLength(6)
    expect(checkByVariant(result, 'opencode-launch', 'base')).toBeDefined()
    expect(checkByVariant(result, 'auth-ping', 'base')).toBeDefined()
    expect(checkByVariant(result, 'build-agent', 'base')).toBeDefined()
    expect(checkByVariant(result, 'pack-visibility', 'base')?.details).toBe('skipped (no pack)')
    expect(checkByVariant(result, 'foreign-pack-absent', 'base')?.details).toBe('skipped (no foreign pack)')
    expect(checkByVariant(result, 'pack-functional', 'base')?.details).toBe('skipped (no check)')
    expect(result.packChecks).toBeUndefined()
  })

  it('a variant missing from homesForCheck → E_PREFLIGHT_FAILED, exitCode=2 (pipeline wiring guard)', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['base'])
    const input = buildInput(
      homes,
      { variants: [{ name: 'base', packs: [] }, { name: 'ghost', packs: [] }], workspacePath: root, outputPath: path.join(root, 'out') },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['variant']).toBe('ghost')
  })

  it('3 variants, config order: opencode-launch fails for the SECOND variant only', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'b', 'c'])
    versionMock.mockImplementation((homeDir: string) =>
      homeDir === homes['b']![0]
        ? Effect.fail(new OpencodeError({ command: 'version', exitCode: 1, stderr: 'crash in b', stdout: '', timedOut: false }))
        : Effect.succeed('1.0.0'),
    )
    const input = buildInput(
      homes,
      {
        variants: [{ name: 'a', packs: [] }, { name: 'b', packs: [] }, { name: 'c', packs: [] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('opencode-launch')
    expect(err.context?.['variant']).toBe('b')
  })

  it('auth-ping timeout → E_PREFLIGHT_TIMEOUT, exitCode=2', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['base'])
    runMock.mockImplementation(() =>
      Effect.fail(new OpencodeError({ command: 'run', exitCode: null, stderr: '', stdout: '', timedOut: true })),
    )
    const input = buildInput(homes, { workspacePath: root, outputPath: path.join(root, 'out') })
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_TIMEOUT')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('auth-ping')
  })

  it('auth-ping no credentials → E_AUTH_MISSING, exitCode=2', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['base'])
    runMock.mockImplementation(() =>
      Effect.fail(new OpencodeError({ command: 'run', exitCode: 1, stderr: 'ANTHROPIC_API_KEY is not set', stdout: '', timedOut: false })),
    )
    const input = buildInput(homes, { workspacePath: root, outputPath: path.join(root, 'out') })
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_AUTH_MISSING')
    expect(err.context?.['exitCode']).toBe(2)
  })

  it('auth-ping targets runInput.model, not preflightModel, for every variant', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'b'])
    const input = buildInput(
      homes,
      {
        model: 'x/y',
        preflightModel: 'a/b',
        variants: [{ name: 'a', packs: [] }, { name: 'b', packs: [] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
    )
    await runP(preflight(input))
    expect(runMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of runMock.mock.calls) {
      expect(call[0].model).toBe('x/y')
    }
  })

  // N1: a variant's own model must be probed, not the global one — else
  // preflight can pass while that variant's real model (baked into its
  // config at phase 04, used with NO --model flag at phase 06) has broken
  // auth, deferring the failure to the expensive run phase.
  it('auth-ping targets a variant\'s OWN model when it overrides the global one', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'b'])
    const seenModels: Record<string, string | undefined> = {}
    runMock.mockImplementation((opts: { homeDir: string; model?: string }) => {
      seenModels[opts.homeDir] = opts.model
      return Effect.succeed({
        exitCode: 0,
        stdout: '{"role":"assistant","text":"OK"}',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      })
    })
    const input = buildInput(homes, {
      model: 'x/y',
      variants: [{ name: 'a', packs: [], model: 'own/model' }, { name: 'b', packs: [] }],
      baseline: 'a',
      workspacePath: root,
      outputPath: path.join(root, 'out'),
    })
    await runP(preflight(input))
    expect(seenModels[homes['a']![0]!]).toBe('own/model')
    expect(seenModels[homes['b']![0]!]).toBe('x/y')
  })

  it('build-agent missing in one variant HOME → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['base'])
    await runP(removeDir(path.join(homes['base']![0]!, '.config', 'opencode', 'agents', 'build.md')))
    const input = buildInput(homes, { workspacePath: root, outputPath: path.join(root, 'out') })
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('build-agent')
  })

  // ---- gate 4: pack-visibility -------------------------------------------

  it('pack-visibility: declared skill visible → pass, details carries "pack-visibility [<variant>/<pack>]"', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes['a']![0]!, '.config', 'opencode', 'skills', 'myskill')))
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([skillDelivery('pack-a', packDir, 'myskill')]) },
    )
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const check = checkByVariant(result, 'pack-visibility', 'a')
    expect(check?.passed).toBe(true)
    expect(check?.details).toBe('pack-visibility [a/pack-a]')
  })

  it('pack-visibility: declared skill invisible → E_PREFLIGHT_PACK_INVISIBLE, exitCode=3', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    // no symlink created in a's HOME — never actually registered
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([skillDelivery('pack-a', packDir, 'myskill')]) },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['check']).toBe('pack-visibility')
    expect(err.context?.['variant']).toBe('a')
    expect(err.context?.['pack']).toBe('pack-a')
  })

  it('pack-visibility: variant with zero declared packs → skip line, exitCode=0', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['smoke'])
    const input = buildInput(homes, { variants: [{ name: 'smoke', packs: [] }], baseline: 'smoke', workspacePath: root, outputPath: path.join(root, 'out') })
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(checkByVariant(result, 'pack-visibility', 'smoke')?.details).toBe('skipped (no pack)')
  })

  // B1 (review-gate blocking finding): a declared pack whose delivery
  // recorded ZERO instructions (phase 03 does not fail a pack whose layout
  // it fails to recognize — it just delivers nothing, 03-pack-install.ts)
  // must NOT report a vacuous pass. Zero assertions run is not proof of
  // visibility, and WP12/phase 07 read `passed: true` as confirmation.
  it('pack-visibility: declared pack with an EMPTY instruction list → E_PREFLIGHT_FAILED, exitCode=2, not a vacuous pass', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      {
        packInstall: packInstallOf([
          { pack: 'pack-a', packPath: '/nowhere', detectedType: 'skill', registeredIn: [], instructions: [] },
        ]),
      },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('pack-visibility')
    expect(err.context?.['variant']).toBe('a')
    expect(err.context?.['pack']).toBe('pack-a')
  })

  // ---- gate 5: foreign-pack-absent ---------------------------------------

  it('foreign-pack-absent: pack correctly absent on a non-declaring variant → pass, details carries the tuple', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'smoke'])
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes['a']![0]!, '.config', 'opencode', 'skills', 'myskill')))
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'a', packs: ['pack-a'] }, { name: 'smoke', packs: [] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([skillDelivery('pack-a', packDir, 'myskill')]) },
    )
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const check = checkByVariant(result, 'foreign-pack-absent', 'smoke')
    expect(check?.passed).toBe(true)
    expect(check?.details).toBe('foreign-pack-absent [smoke/pack-a]')
  })

  it('foreign-pack-absent: planted foreign skill dir leaks → E_PREFLIGHT_FAILED naming variant, pack, and instruction kind', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'smoke'])
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes['a']![0]!, '.config', 'opencode', 'skills', 'myskill')))
    // leak: same skill accidentally planted into smoke's HOME
    await runP(symlink(packDir, path.join(homes['smoke']![0]!, '.config', 'opencode', 'skills', 'myskill')))
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'a', packs: ['pack-a'] }, { name: 'smoke', packs: [] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([skillDelivery('pack-a', packDir, 'myskill')]) },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('foreign-pack-absent')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['variant']).toBe('smoke')
    expect(err.context?.['pack']).toBe('pack-a')
    expect(err.context?.['instruction']).toBe('skill')
  })

  it('foreign-pack-absent: single-variant run has nothing foreign → skip line', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const input = buildInput(
      homes,
      { packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }], variants: [{ name: 'a', packs: ['pack-a'] }], baseline: 'a', workspacePath: root, outputPath: path.join(root, 'out') },
      { packInstall: packInstallOf([skillDelivery('pack-a', makeTempDir('testaipack-pack-src-'))]) },
    )
    // declared pack must still be visible for gate 4, so symlink it too
    const packDir = (input.packInstall.deliveries[0] as PackDeliveryExt).packPath
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes['a']![0]!, '.config', 'opencode', 'skills', 'pack-a')))
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(checkByVariant(result, 'foreign-pack-absent', 'a')?.details).toBe('skipped (no foreign pack)')
  })

  // B1, gate 5 side: symmetric defensive fix — a foreign pack whose delivery
  // recorded ZERO instructions must not report absence as "proven" either.
  // Unreachable through a normal preflight() call as long as gate 4 (which
  // runs first and covers every declared pack, including this one's
  // declaring variant) already rejects the same empty delivery — so this
  // test overrides foreignPacksOf directly to exercise gate 5's own guard in
  // isolation, independent of gate 4's coverage.
  it('foreign-pack-absent: a foreign pack with an EMPTY instruction list → E_PREFLIGHT_FAILED, exitCode=2, not a vacuous pass', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['smoke'])
    foreignPacksOfMock.mockImplementation((runInput: RunInput, v: VariantSpec) =>
      v.name === 'smoke' ? runInput.packs.filter((p) => p.name === 'pack-a') : realForeignPacksOf(runInput, v),
    )
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'smoke', packs: [] }],
        baseline: 'smoke',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      {
        packInstall: packInstallOf([
          { pack: 'pack-a', packPath: '/nowhere', detectedType: 'skill', registeredIn: [], instructions: [] },
        ]),
      },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('foreign-pack-absent')
    expect(err.context?.['variant']).toBe('smoke')
    expect(err.context?.['pack']).toBe('pack-a')
  })

  it('docker mode: foreign-pack-absent leak check fails loudly on a docker infra error, not silently "no leak"', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'smoke'])
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes['a']![0]
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 125, stderr: 'Error: No such image', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(
        homes,
        {
          isolation: 'docker',
          packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
          variants: [{ name: 'a', packs: ['pack-a'] }, { name: 'smoke', packs: [] }],
          baseline: 'a',
          workspacePath: root,
          outputPath: path.join(root, 'out'),
        },
        { packInstall: packInstallOf([skillDelivery('pack-a', packDir)]) },
      ),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('foreign-pack-absent')
    expect(err.message).toContain('cannot verify')
  })

  // ---- gate 6: pack-functional -------------------------------------------
  //
  // 3-variant matrix: pack-a declared by variant 'a', pack-b declared by
  // variant 'b', 'smoke' declares neither. Each pack's check is a
  // marker-file probe (`test -f marker-<pack>.txt` under HOME) — simulated
  // deterministically here by keying the spawn mock on `cwd` (the exact HOME
  // dir passed through by `runShellInHome`), the same technique the v1 suite
  // used for `--pack-check` routing.
  const matrixVariants = (): VariantSpec[] => [
    { name: 'a', packs: ['pack-a'] },
    { name: 'b', packs: ['pack-b'] },
    { name: 'smoke', packs: [] },
  ]
  const matrixPacks = (): PackSpec[] => [
    { name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker-pack-a.txt' },
    { name: 'pack-b', ref: 'github:o/pack-b', check: 'test -f marker-pack-b.txt' },
  ]

  it('gate 6 matrix: declared packs functional, foreign packs absent everywhere → all pass, packChecks = variants × packs-with-check', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'b', 'smoke'])
    // "marker present" ⇔ this HOME has the given pack's tool: a → pack-a only, b → pack-b only, smoke → neither.
    const packPresentAtHome: Record<string, string> = {
      [homes['a']![0]!]: 'pack-a',
      [homes['b']![0]!]: 'pack-b',
    }
    spawnMock.mockImplementation((opts: { cwd: string; args: readonly string[] }) => {
      const cmd = opts.args[1] ?? ''
      const wantsPack = cmd.includes('pack-a') ? 'pack-a' : 'pack-b'
      const present = packPresentAtHome[opts.cwd]
      return Effect.succeed({
        exitCode: present === wantsPack ? 0 : 1,
        stdout: '',
        stderr: '',
        durationMs: 2,
        timedOut: false,
      })
    })
    const input = buildInput(
      homes,
      {
        packs: matrixPacks(),
        variants: matrixVariants(),
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      {
        packInstall: packInstallOf([
          await withMinimalDelivery(homes, 'a', 'pack-a'),
          await withMinimalDelivery(homes, 'b', 'pack-b'),
        ]),
      },
    )
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks).toHaveLength(6) // 3 variants × 2 packs-with-check × 1 HOME
    expect(result.checks.some((c) => c.variant === 'a' && c.details === 'pack-functional [pack-a @ a] 1/1 HOME(s) verified')).toBe(true)
    expect(result.checks.some((c) => c.variant === 'a' && c.details === 'pack-functional [pack-b @ a] 1/1 HOME(s) verified')).toBe(true)
    expect(result.checks.some((c) => c.variant === 'b' && c.details === 'pack-functional [pack-b @ b] 1/1 HOME(s) verified')).toBe(true)
    expect(result.checks.some((c) => c.variant === 'smoke' && c.details === 'pack-functional [pack-a @ smoke] 1/1 HOME(s) verified')).toBe(true)
  })

  it('gate 6: declared pack not functional → E_PACK_CHECK_FAILED exitCode=3 reason=declared-not-functional', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 1, stdout: '', stderr: '', durationMs: 2, timedOut: false }),
    )
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([await withMinimalDelivery(homes, 'a', 'pack-a')]) },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('declared-not-functional')
    expect(err.context?.['variant']).toBe('a')
    expect(err.context?.['pack']).toBe('pack-a')
  })

  // N2: pins that allowPacks only ever rescues the FOREIGN direction — a
  // "simplification" that also checks `allowed` on the declared branch would
  // keep every other test green while silently letting a broken declared
  // pack through.
  it('gate 6: allowPacks does NOT rescue a DECLARED pack that fails its own check', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 1, stdout: '', stderr: '', durationMs: 2, timedOut: false }),
    )
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
        variants: [{ name: 'a', packs: ['pack-a'], allowPacks: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([await withMinimalDelivery(homes, 'a', 'pack-a')]) },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('declared-not-functional')
  })

  it('gate 6: foreign pack unexpectedly functional (no allowPacks) → E_PACK_CHECK_FAILED exitCode=3 reason=foreign-tool-present', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['smoke'])
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 2, timedOut: false }),
    )
    const input = buildInput(homes, {
      packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
      variants: [{ name: 'smoke', packs: [] }],
      baseline: 'smoke',
      workspacePath: root,
      outputPath: path.join(root, 'out'),
    })
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('foreign-tool-present')
  })

  it('gate 6: allowPacks downgrades an unexpectedly-functional foreign pack to an overridden pass', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['smoke'])
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 2, timedOut: false }),
    )
    const input = buildInput(homes, {
      packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
      variants: [{ name: 'smoke', packs: [], allowPacks: ['pack-a'] }],
      baseline: 'smoke',
      workspacePath: root,
      outputPath: path.join(root, 'out'),
    })
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const check = checkByVariant(result, 'pack-functional', 'smoke')
    expect(check?.passed).toBe(true)
    expect(check?.details).toContain('allowPacks')
  })

  // Review-gate regression carried over from v1: a missing command exits 127
  // via the shell (`sh: 1: graphify: not found`), not 1 — on a non-declaring
  // variant that IS the expected, required outcome, not an infra fault.
  it('gate 6: non-declaring variant exits 127 (command not found) → PASS, the invariant holds', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['smoke'])
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 127, stdout: '', stderr: 'sh: 1: graphify: not found', durationMs: 2, timedOut: false }),
    )
    const input = buildInput(homes, {
      packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'graphify --version' }],
      variants: [{ name: 'smoke', packs: [] }],
      baseline: 'smoke',
      workspacePath: root,
      outputPath: path.join(root, 'out'),
    })
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks?.[0]?.exitCode).toBe(127)
  })

  it('gate 6: the check itself times out → E_PACK_CHECK_FAILED exitCode=2, infra failure', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: -1, stdout: '', stderr: '', durationMs: 2, timedOut: true }),
    )
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([await withMinimalDelivery(homes, 'a', 'pack-a')]) },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['timedOut']).toBe(true)
  })

  it('gate 6: no pack in the registry declares a check → skip line per variant, exitCode=0', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([await withMinimalDelivery(homes, 'a', 'pack-a')]) },
    )
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const check = checkByVariant(result, 'pack-functional', 'a')
    expect(check?.details).toBe('skipped (no check)')
    expect(result.packChecks).toBeUndefined()
  })

  it('gate 6 (multi-HOME): run-2 fails while run-1 passes → fails loudly naming runIndex=2 (04b copy-out gap)', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'], 2)
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes['a']![0] ? 0 : 1,
        stdout: '',
        stderr: '',
        durationMs: 2,
        timedOut: false,
      }),
    )
    const input = buildInput(
      homes,
      {
        packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
        variants: [{ name: 'a', packs: ['pack-a'] }],
        baseline: 'a',
        workspacePath: root,
        outputPath: path.join(root, 'out'),
      },
      { packInstall: packInstallOf([await withMinimalDelivery(homes, 'a', 'pack-a')]) },
    )
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['reason']).toBe('declared-not-functional')
    expect(err.context?.['runIndex']).toBe(2)
  })

  it('gate 6 (home mode): forwards each HOME its own pathOverride as PATH', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a', 'smoke'])
    const seenPaths: Record<string, string | undefined> = {}
    spawnMock.mockImplementation((opts: { cwd: string; env?: Record<string, string> }) => {
      seenPaths[opts.cwd] = opts.env?.['PATH']
      return Effect.succeed({
        exitCode: opts.cwd === homes['a']![0] ? 0 : 1,
        stdout: '',
        stderr: '',
        durationMs: 2,
        timedOut: false,
      })
    })
    const pathOverrides = { a: '/a/.local/bin:/usr/bin', smoke: '/smoke/.local/bin:/usr/bin' }
    const input: PreflightInputExt = {
      ...buildInput(
        homes,
        {
          packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
          variants: [{ name: 'a', packs: ['pack-a'] }, { name: 'smoke', packs: [] }],
          baseline: 'a',
          workspacePath: root,
          outputPath: path.join(root, 'out'),
        },
        { packInstall: packInstallOf([await withMinimalDelivery(homes, 'a', 'pack-a')]) },
      ),
      homesForCheck: homesForCheckOf(homes, pathOverrides),
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(seenPaths[homes['a']![0]!]).toBe('/a/.local/bin:/usr/bin')
    expect(seenPaths[homes['smoke']![0]!]).toBe('/smoke/.local/bin:/usr/bin')
  })

  it('gate 6 (docker mode): runs through dockerRun, same pass/fail semantics', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    dockerRunMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 2, timedOut: false }),
    )
    const input: PreflightInputExt = {
      // dockerRunMock above always succeeds, so gate 4's visibility probe
      // (also routed through dockerRun in docker mode) passes regardless of
      // real file content — a dummy path is enough here, unlike the home-mode
      // tests where `withMinimalDelivery` has to create a real symlink.
      ...buildInput(
        homes,
        {
          isolation: 'docker',
          packs: [{ name: 'pack-a', ref: 'github:o/pack-a', check: 'test -f marker.txt' }],
          variants: [{ name: 'a', packs: ['pack-a'] }],
          baseline: 'a',
          workspacePath: root,
          outputPath: path.join(root, 'out'),
        },
        { packInstall: packInstallOf([skillDelivery('pack-a', '/dummy/pack-src', 'pack-a')]) },
      ),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks).toHaveLength(1)
  })

  // ---- docker mode: gates 1/4 mechanics (kept for regression) -----------

  it('docker mode: gate 1 calls ensureImage then version with the image', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker', variants: [{ name: 'a', packs: [] }], baseline: 'a', workspacePath: root, outputPath: path.join(root, 'out') }),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(ensureImageMock).toHaveBeenCalledWith(DEFAULT_OPENCODE_IMAGE)
    const dockerCalls = versionMock.mock.calls.filter(
      (c) => (c[1] as { image?: string } | undefined)?.image !== undefined,
    )
    expect(dockerCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('docker mode: ensureImage failure → E_PREFLIGHT_FAILED (image unavailable)', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    ensureImageMock.mockImplementation(() =>
      Effect.fail(new DockerError({ command: 'pull', exitCode: 1, stderr: 'manifest unknown', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker', variants: [{ name: 'a', packs: [] }], baseline: 'a', workspacePath: root, outputPath: path.join(root, 'out') }),
      dockerImage: 'opencode/missing:latest',
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('opencode-launch')
    expect(err.message).toContain('unavailable')
    expect(err.message).toContain('build-docker-image.sh')
    expect(err.context?.['image']).toBe('opencode/missing:latest')
  })

  it('docker mode: gate 4 trusts the container, not the host', async () => {
    const root = makeTempDir()
    const homes = await buildVariantHomes(root, ['a'])
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    // deliberately no file under homes.a/.config/opencode/skills/myskill —
    // the host filesystem alone would say "not visible".
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes['a']![0]
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(
        homes,
        { isolation: 'docker', packs: [{ name: 'pack-a', ref: 'github:o/pack-a' }], variants: [{ name: 'a', packs: ['pack-a'] }], baseline: 'a', workspacePath: root, outputPath: path.join(root, 'out') },
        { packInstall: packInstallOf([skillDelivery('pack-a', packDir, 'myskill')]) },
      ),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(dockerRunMock).toHaveBeenCalled()
  })
})
