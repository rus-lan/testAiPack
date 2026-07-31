import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, exists, pathKind, readFile } from '../util/fs.js'
import { homeIsolation } from './04-home-isolation.js'
import type { HomeIsolationInputExt } from './04-home-isolation.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import type {
  RunInput,
  Manifest,
  WorkspaceTree,
  VariantTree,
  VariantSpec,
  PackSpec,
} from '@generated/types'
import type { PackInstallOutcome, PackDeliveryExt } from './03-pack-install.js'

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
  installPlugin: vi.fn(),
}))

const { installPlugin } = await import('../opencode/cli.js')
const installMock = vi.mocked(installPlugin)

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
    opencode: true,
    npmrc: false,
    anthropic: false,
    openai: false,
    gemini: false,
    aws: false,
    ssh: false,
    git: false,
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

const buildWorkspace = (names: readonly string[], runs: number): { workspace: WorkspaceTree; root: string } => {
  const root = makeTempDir()
  const variantTrees: VariantTree[] = names.map((name) => {
    const homes: string[] = []
    for (let i = 1; i <= runs; i++) homes.push(path.join(root, 'home', name, `run-${String(i)}`))
    return { name, apps: [], homes, gitDirs: [] }
  })
  const workspace: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'src'),
    pack: path.join(root, 'pack'),
    variantTrees,
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'raw'),
    diff: path.join(root, 'diff'),
  }
  return { workspace, root }
}

const homesOf = (workspace: WorkspaceTree, name: string): readonly string[] =>
  workspace.variantTrees.find((t) => t.name === name)?.homes ?? []

const buildInput = (
  variants: VariantSpec[],
  packs: PackSpec[],
  packInstall: PackInstallOutcome | undefined,
  runs = 1,
  runInputOverrides: Partial<RunInput> = {},
): HomeIsolationInputExt => {
  const { workspace } = buildWorkspace(
    variants.map((v) => v.name),
    runs,
  )
  return {
    runInput: makeRunInput(variants, packs, { runs, ...runInputOverrides }),
    manifest: { ...fakeManifest(variants, packs), runs },
    workspace,
    ...(packInstall === undefined ? {} : { packInstall }),
  }
}

let savedHome: string | undefined
const useFakeHome = async (setup?: (home: string) => Promise<void>): Promise<string> => {
  savedHome = process.env['HOME']
  const fake = makeTempDir('testaipack-fake-home-')
  process.env['HOME'] = fake
  await runP(ensureDir(fake))
  if (setup) await setup(fake)
  return fake
}

const restoreHome = (): void => {
  if (savedHome === undefined) {
    delete process.env['HOME']
  } else {
    process.env['HOME'] = savedHome
  }
  savedHome = undefined
}

const seedOpencodeAuth = (h: string) =>
  Effect.gen(function* () {
    yield* ensureDir(path.join(h, '.local', 'share', 'opencode'))
    yield* writeFile(path.join(h, '.local', 'share', 'opencode', 'auth.json'), '{}')
  })

const writePackSkill = async (name = 'myskill'): Promise<string> => {
  const packDir = makeTempDir('testaipack-pack-src-')
  await runP(ensureDir(packDir))
  await runP(writeFile(path.join(packDir, 'SKILL.md'), `# ${name}\n`))
  return packDir
}

const makeOutcome = (deliveries: PackDeliveryExt[]): PackInstallOutcome => ({
  deliveries,
  installLogPath: '/tmp/install.log',
})

const skillDelivery = (pack: string, packDir: string, name = 'myskill'): PackDeliveryExt => ({
  pack,
  packPath: packDir,
  detectedType: 'skill',
  registeredIn: ['skills'],
  instructions: [{ kind: 'skill', name, target: packDir }],
})

const pluginDelivery = (pack: string, name = 'myplugin'): PackDeliveryExt => ({
  pack,
  packPath: '',
  detectedType: 'plugin',
  registeredIn: ['plugins'],
  instructions: [{ kind: 'plugin', name }],
})

const localPluginDelivery = (pack: string, target: string, name = 'myplugin'): PackDeliveryExt => ({
  pack,
  packPath: '',
  detectedType: 'all',
  registeredIn: ['plugins'],
  instructions: [{ kind: 'plugin', name, target }],
})

const agentDelivery = (pack: string, mdPath: string, name = 'deploy'): PackDeliveryExt => ({
  pack,
  packPath: mdPath,
  detectedType: 'agent',
  registeredIn: ['agents'],
  instructions: [{ kind: 'file', section: 'agents', name, target: mdPath }],
})

const mcpDelivery = (pack: string, name: string, json: unknown): PackDeliveryExt => ({
  pack,
  packPath: '',
  detectedType: 'mcp',
  registeredIn: ['mcp'],
  instructions: [{ kind: 'config', section: 'mcp', name, json }],
})

/** Two variants: `smoke` declares no pack (pure by D1 default), `withpack` declares one. */
const twoVariants = (packName = 'demo-pack'): VariantSpec[] => [
  { name: 'smoke', packs: [] },
  { name: 'withpack', packs: [packName] },
]

const onePack = (name = 'demo-pack', over: Partial<PackSpec> = {}): PackSpec[] => [
  { name, ref: 'github:owner/demo', ...over },
]

describe('phase 04 — homeIsolation', () => {
  beforeEach(() => {
    installMock.mockReset()
    installMock.mockImplementation(() => Effect.succeed(undefined))
  })
  afterEach(() => {
    restoreHome()
  })

  it('happy-path skill: declaring variant gets a real copy (not a symlink), non-declaring variant does not, auth copied', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const packDir = await writePackSkill('myskill')
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([skillDelivery('demo-pack', packDir)]))
    const result = await runP(homeIsolation(input))
    expect(result.homeTrees).toHaveLength(2)
    expect(result.envVars).toHaveLength(2)
    for (const vh of result.homeTrees) expect(vh.trees).toHaveLength(1)
    for (const ve of result.envVars) expect(ve.envs).toHaveLength(1)

    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    const smokeHome = homesOf(input.workspace, 'smoke')[0]!
    const destPath = path.join(withpackHome, '.config', 'opencode', 'skills', 'myskill')
    expect(await runP(exists(destPath))).toBe(true)
    // A real directory copy, not a symlink: a docker container that only
    // mounts the run HOME (never workspace.pack/) still sees the file.
    expect(await runP(pathKind(destPath))).toBe('dir')
    expect(await runP(readFile(path.join(destPath, 'SKILL.md')))).toBe('# myskill\n')
    expect(await runP(exists(path.join(smokeHome, '.config', 'opencode', 'skills', 'myskill')))).toBe(false)

    const withpackTree = result.homeTrees.find((t) => t.name === 'withpack')!
    expect(withpackTree.trees[0]!.copiedAuth).toContain('.local/share/opencode/auth.json')
  })

  it('skill instruction whose name escapes the skills dir → E_HOME_SETUP_FAILED, nothing written outside it', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const packDir = await writePackSkill('evil')
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([skillDelivery('demo-pack', packDir, '../../evil')]))
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    expect(await runP(exists(path.join(withpackHome, '.config', 'opencode', 'skills')))).toBe(true)
    expect(await runP(exists(path.join(withpackHome, '.config', 'evil')))).toBe(false)
  })

  it('smoke-test (no packInstall, no packs declared anywhere): no skill/plugin install, all variant configs byte-identical', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }, { name: 'b', packs: [] }]
    const input = buildInput(variants, [], undefined)
    const result = await runP(homeIsolation(input))
    expect(installMock).not.toHaveBeenCalled()
    const aCfg = result.generatedConfigs.find((c) => c.name === 'a')!.config
    const bCfg = result.generatedConfigs.find((c) => c.name === 'b')!.config
    expect(aCfg).toBe(bCfg)
    const aHome = homesOf(input.workspace, 'a')[0]!
    expect(await runP(exists(path.join(aHome, '.config', 'opencode', 'skills', 'myskill')))).toBe(false)
  })

  it('plugin install success → installPlugin called once, only for the declaring variant', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]))
    const result = await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).toHaveBeenCalledWith(withpackHome, 'myplugin')
    expect(result.homeTrees.find((t) => t.name === 'withpack')).toBeDefined()
  })

  it('docker isolation threads the docker image into plugin install', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]), 1, {
      isolation: 'docker',
    })
    await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    expect(installMock).toHaveBeenCalledWith(withpackHome, 'myplugin', { image: DEFAULT_OPENCODE_IMAGE })
  })

  it('docker isolation with a custom --docker-image threads it into plugin install', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input: HomeIsolationInputExt = {
      ...buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]), 1, { isolation: 'docker' }),
      dockerImage: 'registry.example/oc:dev',
    }
    await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    expect(installMock).toHaveBeenCalledWith(withpackHome, 'myplugin', { image: 'registry.example/oc:dev' })
  })

  it('docker isolation with --docker-network threads it into plugin install', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input: HomeIsolationInputExt = {
      ...buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]), 1, {
        isolation: 'docker',
        dockerNetwork: 'host',
      }),
      dockerImage: 'registry.example/oc:dev',
    }
    await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    expect(installMock).toHaveBeenCalledWith(withpackHome, 'myplugin', {
      image: 'registry.example/oc:dev',
      network: 'host',
    })
  })

  it('home isolation ignores dockerNetwork (no docker exec at all)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]), 1, {
      isolation: 'home',
      dockerNetwork: 'host',
    })
    await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    expect(installMock).toHaveBeenCalledWith(withpackHome, 'myplugin')
  })

  it('local plugin file (target set): copied into declaring variant plugins/ + registered as a local spec, installPlugin NOT called; the other variant never gets the file', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const srcDir = makeTempDir('testaipack-plugin-src-')
    await runP(ensureDir(srcDir))
    const srcFile = path.join(srcDir, 'myplugin.js')
    await runP(writeFile(srcFile, 'module.exports = {}'))
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([localPluginDelivery('demo-pack', srcFile)]))
    await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    const smokeHome = homesOf(input.workspace, 'smoke')[0]!
    const dstFile = path.join(withpackHome, '.config/opencode/plugins/myplugin.js')
    expect(await runP(exists(dstFile))).toBe(true)
    const cfgPath = path.join(withpackHome, '.config/opencode/opencode.json')
    const cfg = JSON.parse(await runP(readFile(cfgPath))) as { plugin?: readonly string[] }
    expect(cfg.plugin).toEqual([dstFile])
    expect(installMock).not.toHaveBeenCalled()
    const smokeDst = path.join(smokeHome, '.config/opencode/plugins/myplugin.js')
    expect(await runP(exists(smokeDst))).toBe(false)
  })

  it('local plugin file under --isolation docker: registers a container-form path (/home/opencode/...), not the host path our own process wrote to', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const srcDir = makeTempDir('testaipack-plugin-src-')
    await runP(ensureDir(srcDir))
    const srcFile = path.join(srcDir, 'myplugin.js')
    await runP(writeFile(srcFile, 'module.exports = {}'))
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([localPluginDelivery('demo-pack', srcFile)]), 1, {
      isolation: 'docker',
    })
    await runP(homeIsolation(input))
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    const dstFile = path.join(withpackHome, '.config/opencode/plugins/myplugin.js')
    expect(await runP(exists(dstFile))).toBe(true)
    const cfgPath = path.join(withpackHome, '.config/opencode/opencode.json')
    const cfg = JSON.parse(await runP(readFile(cfgPath))) as { plugin?: readonly string[] }
    expect(cfg.plugin).toEqual(['/home/opencode/.config/opencode/plugins/myplugin.js'])
    expect(cfg.plugin?.[0]).not.toBe(dstFile)
  })

  it('plugin install timeout → E_PACK_INSTALL_TIMEOUT', async () => {
    installMock.mockImplementation(() => Effect.sleep('200 millis'))
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]), 1, {
      timeouts: { ...baseTimeouts, installSeconds: 0.05 },
    })
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_PACK_INSTALL_TIMEOUT')
    expect(err.phase).toBe('home-isolation')
  })

  it('plugin install failure (non-zero exit) → E_PACK_INSTALL_FAILED', async () => {
    const { OpencodeError } = await import('../opencode/cli.js')
    installMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({
          command: 'plugin',
          exitCode: 1,
          stderr: 'package not found',
          stdout: '',
          timedOut: false,
        }),
      ),
    )
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]))
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_PACK_INSTALL_FAILED')
  })

  it('auth fully missing → E_AUTH_MISSING', async () => {
    await useFakeHome()
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined, 1, {
      auth: {
        opencode: true,
        npmrc: true,
        anthropic: true,
        openai: true,
        gemini: true,
        aws: true,
        ssh: true,
        git: true,
      },
    })
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_AUTH_MISSING')
  })

  it('auth partial (only npmrc) → OK, copiedAuth=[".npmrc"]', async () => {
    await useFakeHome(async (h) => {
      await runP(writeFile(path.join(h, '.npmrc'), 'registry=https://registry.npmjs.org\n'))
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined, 1, {
      auth: {
        opencode: false,
        npmrc: true,
        anthropic: false,
        openai: false,
        gemini: false,
        aws: false,
        ssh: false,
        git: false,
      },
    })
    const result = await runP(homeIsolation(input))
    const copied = result.homeTrees.find((t) => t.name === 'a')!.trees[0]!.copiedAuth
    expect(copied).toEqual(['.npmrc'])
  })

  it('purity (D1): a no-pack variant is pure by default, a pack-declaring variant is impure by default', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), undefined)
    const result = await runP(homeIsolation(input))
    const smokeEnv = result.envVars.find((e) => e.name === 'smoke')!.envs[0]!
    const withpackEnv = result.envVars.find((e) => e.name === 'withpack')!.envs[0]!
    expect(smokeEnv.OPENCODE_PURE).toBe(true)
    expect(smokeEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(true)
    expect(smokeEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe(true)
    expect(smokeEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(true)
    expect(withpackEnv.OPENCODE_PURE).toBe(false)
    expect(withpackEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(false)
    expect(withpackEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe(false)
    expect(withpackEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(true)
    expect(smokeEnv.HOME).toBe(homesOf(input.workspace, 'smoke')[0])
    expect(withpackEnv.HOME).toBe(homesOf(input.workspace, 'withpack')[0])
  })

  it('purity (D1): explicit variant.pure overrides the packs-based default in both directions', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [
      { name: 'forced-impure', packs: [], pure: false },
      { name: 'forced-pure', packs: ['demo-pack'], pure: true },
    ]
    const input = buildInput(variants, onePack(), makeOutcome([pluginDelivery('demo-pack')]))
    const result = await runP(homeIsolation(input))
    expect(result.envVars.find((e) => e.name === 'forced-impure')!.envs[0]!.OPENCODE_PURE).toBe(false)
    expect(result.envVars.find((e) => e.name === 'forced-pure')!.envs[0]!.OPENCODE_PURE).toBe(true)
  })

  it('N4: a declared pack with no matching delivery (packInstall supplied but missing this pack) fails E_PACK_INSTALL_FAILED naming variant+pack, instead of silently yielding an impure empty HOME', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    // packInstall ran (deliveries present) but does not contain 'demo-pack' —
    // a real mismatch, not the "phase 03 never ran" smoke-test case.
    const variants = twoVariants()
    const outcome = makeOutcome([pluginDelivery('some-other-pack')])
    const input = buildInput(variants, onePack(), outcome)
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_PACK_INSTALL_FAILED')
    expect(err.context?.['variant']).toBe('withpack')
    expect(err.context?.['pack']).toBe('demo-pack')
  })

  it('N1: a variant is applied and purity-gated on the FULL declared pack set, not just the first pack (regression guard for Stage 2)', async () => {
    // Stage 1 caps declaredPacks at length <=1, so this simulates what
    // packsOf would return once WP16 lifts that guard, proving processVariant
    // does not special-case index 0.
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const aSkillDir = await writePackSkill('a-skill')
    const variants: VariantSpec[] = [{ name: 'multi', packs: ['pack-a', 'pack-b'] }]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a' },
      { name: 'pack-b', ref: 'github:owner/b' },
    ]
    const outcome = makeOutcome([
      skillDelivery('pack-a', aSkillDir, 'a-skill'),
      pluginDelivery('pack-b', 'b-plugin'),
    ])
    const input = buildInput(variants, packs, outcome)
    const result = await runP(homeIsolation(input))
    const multiHome = homesOf(input.workspace, 'multi')[0]!
    expect(await runP(exists(path.join(multiHome, '.config', 'opencode', 'skills', 'a-skill')))).toBe(true)
    expect(installMock).toHaveBeenCalledWith(multiHome, 'b-plugin')
    expect(result.envVars.find((e) => e.name === 'multi')!.envs[0]!.OPENCODE_PURE).toBe(false)
  })

  it('3 variants (smoke, pack-a, pack-b): purity only on the smoke variant, each pack lands only in its own declaring variant HOMEs, per-variant config/<name>.json written, envVars carries names not positions', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const aSkillDir = await writePackSkill('a-skill')
    const variants: VariantSpec[] = [
      { name: 'smoke', packs: [] },
      { name: 'variant-a', packs: ['pack-a'] },
      { name: 'variant-b', packs: ['pack-b'] },
    ]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'github:owner/a' },
      { name: 'pack-b', ref: 'github:owner/b' },
    ]
    const outcome = makeOutcome([
      skillDelivery('pack-a', aSkillDir, 'a-skill'),
      pluginDelivery('pack-b', 'b-plugin'),
    ])
    const input = buildInput(variants, packs, outcome)
    const result = await runP(homeIsolation(input))

    expect(result.envVars.find((e) => e.name === 'smoke')!.envs[0]!.OPENCODE_PURE).toBe(true)
    expect(result.envVars.find((e) => e.name === 'variant-a')!.envs[0]!.OPENCODE_PURE).toBe(false)
    expect(result.envVars.find((e) => e.name === 'variant-b')!.envs[0]!.OPENCODE_PURE).toBe(false)

    const aHome = homesOf(input.workspace, 'variant-a')[0]!
    const bHome = homesOf(input.workspace, 'variant-b')[0]!
    const smokeHome = homesOf(input.workspace, 'smoke')[0]!
    expect(await runP(exists(path.join(aHome, '.config', 'opencode', 'skills', 'a-skill')))).toBe(true)
    expect(await runP(exists(path.join(bHome, '.config', 'opencode', 'skills', 'a-skill')))).toBe(false)
    expect(await runP(exists(path.join(smokeHome, '.config', 'opencode', 'skills', 'a-skill')))).toBe(false)
    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).toHaveBeenCalledWith(bHome, 'b-plugin')

    for (const name of ['smoke', 'variant-a', 'variant-b']) {
      expect(await runP(exists(path.join(input.workspace.config, `${name}.json`)))).toBe(true)
    }

    // no positional indexing: shuffled lookup by name still resolves correctly
    const byName = new Map(result.envVars.map((e) => [e.name, e]))
    expect(byName.get('variant-b')!.envs[0]!.HOME).toBe(bHome)
    expect(byName.get('variant-a')!.envs[0]!.HOME).toBe(aHome)
  })

  it('mcp pack isolation: variant a config carries only pack-a mcp server, variant b only pack-b, smoke has none', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [
      { name: 'smoke', packs: [] },
      { name: 'variant-a', packs: ['pack-a'] },
      { name: 'variant-b', packs: ['pack-b'] },
    ]
    const packs: PackSpec[] = [
      { name: 'pack-a', ref: 'mcp:srv-a:{}' },
      { name: 'pack-b', ref: 'mcp:srv-b:{}' },
    ]
    const outcome = makeOutcome([
      mcpDelivery('pack-a', 'srv-a', { command: 'npx' }),
      mcpDelivery('pack-b', 'srv-b', { command: 'node' }),
    ])
    const input = buildInput(variants, packs, outcome)
    const result = await runP(homeIsolation(input))

    const cfgFor = (name: string): Record<string, unknown> =>
      JSON.parse(result.generatedConfigs.find((c) => c.name === name)!.config) as Record<string, unknown>

    expect(cfgFor('smoke')['mcp']).toBeUndefined()
    const aMcp = cfgFor('variant-a')['mcp'] as Record<string, unknown>
    expect(aMcp['srv-a']).toBeDefined()
    expect(aMcp['srv-b']).toBeUndefined()
    const bMcp = cfgFor('variant-b')['mcp'] as Record<string, unknown>
    expect(bMcp['srv-b']).toBeDefined()
    expect(bMcp['srv-a']).toBeUndefined()
  })

  it('effectiveOf precedence: variant.model > runInput.model > source opencode.json model', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
      await runP(ensureDir(path.join(h, '.config', 'opencode')))
      await runP(writeFile(path.join(h, '.config', 'opencode', 'opencode.json'), '{"model":"source/model"}'))
    })
    const variants: VariantSpec[] = [
      { name: 'own-model', packs: [], model: 'variant/model' },
      { name: 'global-model', packs: [] },
    ]
    const input = buildInput(variants, [], undefined, 1, { model: 'global/model' })
    const result = await runP(homeIsolation(input))
    const ownCfg = JSON.parse(result.generatedConfigs.find((c) => c.name === 'own-model')!.config) as Record<string, unknown>
    const globalCfg = JSON.parse(result.generatedConfigs.find((c) => c.name === 'global-model')!.config) as Record<string, unknown>
    expect(ownCfg['model']).toBe('variant/model')
    expect(globalCfg['model']).toBe('global/model')
  })

  it('effectiveOf: an explicit empty-string variant.model disables the global, falls through to source connectivity', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
      await runP(ensureDir(path.join(h, '.config', 'opencode')))
      await runP(writeFile(path.join(h, '.config', 'opencode', 'opencode.json'), '{"model":"source/model"}'))
    })
    const variants: VariantSpec[] = [{ name: 'disabled', packs: [], model: '' }]
    const input = buildInput(variants, [], undefined, 1, { model: 'global/model' })
    const result = await runP(homeIsolation(input))
    const cfg = JSON.parse(result.generatedConfigs[0]!.config) as Record<string, unknown>
    expect(cfg['model']).toBe('source/model')
  })

  it('PATH symmetry (05-risks.md §2.6, NORMATIVE): any registry pack declaring setup gives EVERY variant .local/bin on PATH, including non-declaring ones', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const packs = onePack('demo-pack', { setup: 'npm install -g x' })
    const input = buildInput(variants, packs, undefined)
    const result = await runP(homeIsolation(input))
    const smokeEnv = result.envVars.find((e) => e.name === 'smoke')!.envs[0]!
    const withpackEnv = result.envVars.find((e) => e.name === 'withpack')!.envs[0]!
    expect(smokeEnv.PATH).toBeDefined()
    expect(withpackEnv.PATH).toBeDefined()
    const smokeHome = homesOf(input.workspace, 'smoke')[0]!
    expect(smokeEnv.PATH).toContain(path.join(smokeHome, '.local', 'bin'))
    expect(await runP(exists(path.join(smokeHome, '.local', 'bin')))).toBe(true)
  })

  it('no registry pack declares setup → no PATH override, no .local/bin skeleton dir', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), undefined)
    const result = await runP(homeIsolation(input))
    expect(result.envVars.find((e) => e.name === 'smoke')!.envs[0]!.PATH).toBeUndefined()
    const smokeHome = homesOf(input.workspace, 'smoke')[0]!
    expect(await runP(exists(path.join(smokeHome, '.local', 'bin')))).toBe(false)
  })

  it('propagates the model from the source opencode.json into every variant config when no override exists', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
      await runP(ensureDir(path.join(h, '.config', 'opencode')))
      await runP(
        writeFile(
          path.join(h, '.config', 'opencode', 'opencode.json'),
          '{"model":"zai-coding-plan/glm-5.2"}',
        ),
      )
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), undefined)
    const result = await runP(homeIsolation(input))
    for (const name of ['smoke', 'withpack']) {
      const cfg = JSON.parse(result.generatedConfigs.find((c) => c.name === name)!.config) as Record<string, unknown>
      expect(cfg['model']).toBe('zai-coding-plan/glm-5.2')
    }
  })

  const OLLAMA_PROVIDER = {
    ollama: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: 'http://localhost:11434/v1' },
      models: { 'qwen3.5:9b': { name: 'Qwen3.5 9B' } },
    },
  }

  const SOURCE_CONNECTIVITY_CONFIG = {
    model: 'ollama/qwen3.5:9b',
    small_model: 'anthropic/claude-haiku',
    provider: OLLAMA_PROVIDER,
    enabled_providers: ['ollama', 'anthropic'],
    disabled_providers: ['openai'],
  }

  const expectConnectivityPropagated = (json: Record<string, unknown>): void => {
    expect(json['provider']).toEqual(OLLAMA_PROVIDER)
    expect(json['small_model']).toBe('anthropic/claude-haiku')
    expect(json['enabled_providers']).toEqual(['ollama', 'anthropic'])
    expect(json['disabled_providers']).toEqual(['openai'])
  }

  it('propagates provider/small_model/enabled_providers/disabled_providers from the source opencode.json into every variant config', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
      await runP(ensureDir(path.join(h, '.config', 'opencode')))
      await runP(
        writeFile(
          path.join(h, '.config', 'opencode', 'opencode.json'),
          JSON.stringify(SOURCE_CONNECTIVITY_CONFIG),
        ),
      )
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), undefined)
    const result = await runP(homeIsolation(input))
    for (const name of ['smoke', 'withpack']) {
      const cfg = JSON.parse(result.generatedConfigs.find((c) => c.name === name)!.config) as Record<string, unknown>
      expectConnectivityPropagated(cfg)
    }
  })

  it('ignores enabled_providers/disabled_providers with an unexpected (non-string-array) shape, same tolerance as an absent field', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
      await runP(ensureDir(path.join(h, '.config', 'opencode')))
      await runP(
        writeFile(
          path.join(h, '.config', 'opencode', 'opencode.json'),
          JSON.stringify({ enabled_providers: 'anthropic', disabled_providers: [1, 2], small_model: 42 }),
        ),
      )
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined)
    const result = await runP(homeIsolation(input))
    const cfg = JSON.parse(result.generatedConfigs[0]!.config) as Record<string, unknown>
    expect(cfg['enabled_providers']).toBeUndefined()
    expect(cfg['disabled_providers']).toBeUndefined()
    expect(cfg['small_model']).toBeUndefined()
  })

  it('writes config/<name>.json to disk for every variant', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const packDir = await writePackSkill('myskill')
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([skillDelivery('demo-pack', packDir)]))
    const result = await runP(homeIsolation(input))
    for (const name of ['smoke', 'withpack']) {
      const p = path.join(input.workspace.config, `${name}.json`)
      expect(await runP(exists(p))).toBe(true)
      const onDisk = JSON.parse(await runP(readFile(p))) as Record<string, unknown>
      const inMemory = JSON.parse(result.generatedConfigs.find((c) => c.name === name)!.config) as Record<string, unknown>
      expect(onDisk).toEqual(inMemory)
      expect(onDisk['testaipack']).toBeUndefined()
    }
  })

  it('redacts a provider apiKey on disk, but the in-memory generatedConfigs (fed to OPENCODE_CONFIG_CONTENT) keeps the real value', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
      await runP(ensureDir(path.join(h, '.config', 'opencode')))
      await runP(
        writeFile(
          path.join(h, '.config', 'opencode', 'opencode.json'),
          JSON.stringify({
            provider: {
              anthropic: { npm: '@ai-sdk/anthropic', options: { apiKey: 'sk-ant-REAL-SECRET' } },
            },
          }),
        ),
      )
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined)
    const result = await runP(homeIsolation(input))

    const cfg = JSON.parse(result.generatedConfigs[0]!.config) as {
      provider: { anthropic: { options: { apiKey: string } } }
    }
    expect(cfg.provider.anthropic.options.apiKey).toBe('sk-ant-REAL-SECRET')

    const onDiskPath = path.join(input.workspace.config, 'a.json')
    const onDiskText = await runP(readFile(onDiskPath))
    expect(onDiskText).not.toContain('sk-ant-REAL-SECRET')
    const onDisk = JSON.parse(onDiskText) as { provider: { anthropic: { npm: string; options: { apiKey: string } } } }
    expect(onDisk.provider.anthropic.options.apiKey).toBe('[REDACTED]')
    expect(onDisk.provider.anthropic.npm).toBe('@ai-sdk/anthropic')
  })

  it('redacts an mcp server env secret on disk, keeps it real in generatedConfigs for the declaring variant', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const outcome = makeOutcome([
      mcpDelivery('demo-pack', 'myserver', {
        command: 'npx',
        args: ['-y', 'myserver'],
        env: { API_TOKEN: 'sk-mcp-REAL-SECRET' },
      }),
    ])
    const input = buildInput(variants, onePack(), outcome)
    const result = await runP(homeIsolation(input))

    const cfg = JSON.parse(result.generatedConfigs.find((c) => c.name === 'withpack')!.config) as {
      mcp: { myserver: { env: { API_TOKEN: string } } }
    }
    expect(cfg.mcp.myserver.env.API_TOKEN).toBe('sk-mcp-REAL-SECRET')

    const onDiskPath = path.join(input.workspace.config, 'withpack.json')
    const onDiskText = await runP(readFile(onDiskPath))
    expect(onDiskText).not.toContain('sk-mcp-REAL-SECRET')
    const onDisk = JSON.parse(onDiskText) as { mcp: { myserver: { env: { API_TOKEN: string } } } }
    expect(onDisk.mcp.myserver.env.API_TOKEN).toBe('[REDACTED]')
  })

  it('re-verify: a bare <VENDOR>_KEY and a URL with embedded userinfo stay real in generatedConfigs (the OPENCODE_CONFIG_CONTENT source), redacted only on disk', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const outcome = makeOutcome([
      mcpDelivery('demo-pack', 'myserver', {
        command: 'npx',
        env: { GEMINI_KEY: 'sk-gemini-REAL-SECRET' },
        url: 'https://svcuser:svcpass@remote.example/sse',
      }),
    ])
    const input = buildInput(variants, onePack(), outcome)
    const result = await runP(homeIsolation(input))

    const cfg = JSON.parse(result.generatedConfigs.find((c) => c.name === 'withpack')!.config) as {
      mcp: { myserver: { env: { GEMINI_KEY: string }; url: string } }
    }
    expect(cfg.mcp.myserver.env.GEMINI_KEY).toBe('sk-gemini-REAL-SECRET')
    expect(cfg.mcp.myserver.url).toBe('https://svcuser:svcpass@remote.example/sse')

    const onDiskPath = path.join(input.workspace.config, 'withpack.json')
    const onDiskText = await runP(readFile(onDiskPath))
    expect(onDiskText).not.toContain('sk-gemini-REAL-SECRET')
    expect(onDiskText).not.toContain('svcuser:svcpass')
    const onDisk = JSON.parse(onDiskText) as {
      mcp: { myserver: { env: { GEMINI_KEY: string }; url: string } }
    }
    expect(onDisk.mcp.myserver.env.GEMINI_KEY).toBe('[REDACTED]')
    expect(onDisk.mcp.myserver.url).toBe('https://remote.example/sse')
  })

  it('N=3 → three home trees per variant, three env sets per variant', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined, 3, { runs: 3 })
    const result = await runP(homeIsolation(input))
    const aTrees = result.homeTrees.find((t) => t.name === 'a')!.trees
    const aEnvs = result.envVars.find((e) => e.name === 'a')!.envs
    expect(aTrees).toHaveLength(3)
    expect(aEnvs).toHaveLength(3)
    for (const t of aTrees) expect(t.structure.length).toBeGreaterThan(0)
  })

  it('agent file instruction → .md copied into agents/ on the declaring variant only', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const mdSrc = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(mdSrc))
    const mdPath = path.join(mdSrc, 'deploy.md')
    await runP(writeFile(mdPath, '# deploy agent\n'))
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), makeOutcome([agentDelivery('demo-pack', mdPath, 'deploy')]))
    await runP(homeIsolation(input))
    const withpackAgents = path.join(homesOf(input.workspace, 'withpack')[0]!, '.config', 'opencode', 'agents', 'deploy.md')
    const smokeAgents = path.join(homesOf(input.workspace, 'smoke')[0]!, '.config', 'opencode', 'agents', 'deploy.md')
    expect(await runP(exists(withpackAgents))).toBe(true)
    expect(await runP(exists(smokeAgents))).toBe(false)
    expect(await runP(readFile(withpackAgents))).toBe('# deploy agent\n')
  })

  it('command file instruction → .md copied into command/ (singular dir) on the declaring variant', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const mdSrc = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(mdSrc))
    const mdPath = path.join(mdSrc, 'run.md')
    await runP(writeFile(mdPath, '# run command\n'))
    const variants = twoVariants()
    const outcome = makeOutcome([
      { pack: 'demo-pack', packPath: mdPath, detectedType: 'command', registeredIn: ['commands'], instructions: [{ kind: 'file', section: 'commands', name: 'run', target: mdPath }] },
    ])
    const input = buildInput(variants, onePack(), outcome)
    await runP(homeIsolation(input))
    const withpackCmd = path.join(homesOf(input.workspace, 'withpack')[0]!, '.config', 'opencode', 'command', 'run.md')
    const smokeCmd = path.join(homesOf(input.workspace, 'smoke')[0]!, '.config', 'opencode', 'command', 'run.md')
    expect(await runP(exists(withpackCmd))).toBe(true)
    expect(await runP(exists(smokeCmd))).toBe(false)
  })

  it('mcp config extends an existing opencode.json instead of overwriting', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const outcome = makeOutcome([mcpDelivery('demo-pack', 'srv2', { command: 'node' })])
    const input = buildInput(variants, onePack(), outcome)
    const withpackHome = homesOf(input.workspace, 'withpack')[0]!
    const cfgDir = path.join(withpackHome, '.config', 'opencode')
    await runP(ensureDir(cfgDir))
    const preExisting = { otherKey: 1, mcp: { srv1: { command: 'a' } } }
    await runP(writeFile(path.join(cfgDir, 'opencode.json'), JSON.stringify(preExisting)))
    await runP(homeIsolation(input))
    const after = JSON.parse(await runP(readFile(path.join(cfgDir, 'opencode.json')))) as Record<string, unknown>
    expect(after['otherKey']).toBe(1)
    const mcp = after['mcp'] as Record<string, unknown>
    expect(mcp['srv1']).toEqual({ command: 'a' })
    expect(mcp['srv2']).toEqual({ command: 'node' })
  })

  it('docker isolation builds HOMEs and records isolation/dockerImage', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined, 1, { isolation: 'docker' })
    const result = await runP(homeIsolation(input))
    expect(result.isolation).toBe('docker')
    expect(result.dockerImage).toBe(DEFAULT_OPENCODE_IMAGE)
    expect(result.homeTrees).toHaveLength(1)
  })

  it('docker isolation honours a custom --docker-image override', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input: HomeIsolationInputExt = {
      ...buildInput(variants, [], undefined, 1, { isolation: 'docker' }),
      dockerImage: 'registry.example/oc:dev',
    }
    const result = await runP(homeIsolation(input))
    expect(result.dockerImage).toBe('registry.example/oc:dev')
  })

  it('home isolation records isolation="home" and no dockerImage', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants: VariantSpec[] = [{ name: 'a', packs: [] }]
    const input = buildInput(variants, [], undefined, 1, { isolation: 'home' })
    const result = await runP(homeIsolation(input))
    expect(result.isolation).toBe('home')
    expect(result.dockerImage).toBeUndefined()
  })

  it('build.md written into every variant HOME (for preflight gate 3)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const variants = twoVariants()
    const input = buildInput(variants, onePack(), undefined)
    await runP(homeIsolation(input))
    for (const name of ['smoke', 'withpack']) {
      const build = path.join(homesOf(input.workspace, name)[0]!, '.config', 'opencode', 'agents', 'build.md')
      expect(await runP(exists(build))).toBe(true)
    }
  })
})
