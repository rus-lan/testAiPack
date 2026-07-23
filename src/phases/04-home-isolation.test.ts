import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, exists, readSymlink, readFile } from '../util/fs.js'
import { homeIsolation } from './04-home-isolation.js'
import type { HomeIsolationInputExt } from './04-home-isolation.js'
import type {
  RunInput,
  Manifest,
  WorkspaceTree,
} from '@generated/types'
import type { PackInstallOutcome } from './03-pack-install.js'

vi.mock('../opencode/cli.js', () => ({
  OpencodeError: class extends Error {
    readonly _tag = 'OpencodeError'
    readonly command: string
    readonly exitCode: number | null
    readonly stderr: string
    readonly timedOut: boolean
    constructor(args: {
      command: string
      exitCode: number | null
      stderr: string
      timedOut: boolean
    }) {
      super(`opencode ${args.command} failed`)
      this.command = args.command
      this.exitCode = args.exitCode
      this.stderr = args.stderr
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

const makeRunInput = (overrides: Partial<RunInput>): RunInput => ({
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
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
  pureBaseline: true,
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

interface BuiltWorkspace {
  readonly workspace: WorkspaceTree
  readonly root: string
  readonly homeOld: readonly string[]
  readonly homeNew: readonly string[]
}

const buildWorkspace = (runs: number): BuiltWorkspace => {
  const root = makeTempDir()
  const homeOld: string[] = []
  const homeNew: string[] = []
  for (let i = 1; i <= runs; i++) {
    const s = String(i)
    homeOld.push(path.join(root, 'home', 'old', `run-${s}`))
    homeNew.push(path.join(root, 'home', 'new', `run-${s}`))
  }
  const workspace: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'src'),
    appsOld: [],
    appsNew: [],
    pack: path.join(root, 'pack'),
    homeOld,
    homeNew,
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'raw'),
    diff: path.join(root, 'diff'),
  }
  return { workspace, root, homeOld, homeNew }
}

const buildInput = (
  runInputOverrides: Partial<RunInput>,
  packInstall: PackInstallOutcome | undefined,
  runs = 1,
): HomeIsolationInputExt => ({
  runInput: makeRunInput(runInputOverrides),
  manifest: { ...fakeManifest, runs },
  workspace: buildWorkspace(runs).workspace,
  ...(packInstall === undefined ? {} : { packInstall }),
})

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

const writePackSkill = async (name = 'myskill'): Promise<string> => {
  const packDir = makeTempDir('testaipack-pack-src-')
  await runP(ensureDir(packDir))
  await runP(writeFile(path.join(packDir, 'SKILL.md'), `# ${name}\n`))
  return packDir
}

const skillOutcome = (packDir: string, name = 'myskill'): PackInstallOutcome => ({
  packPath: packDir,
  detectedType: 'skill',
  installLogPath: '/tmp/install.log',
  registeredIn: ['skills'],
  instructions: [{ kind: 'symlink', name, target: packDir }],
})

const pluginOutcome = (name = 'myplugin'): PackInstallOutcome => ({
  packPath: '',
  detectedType: 'plugin',
  installLogPath: '/tmp/install.log',
  registeredIn: ['plugins'],
  instructions: [{ kind: 'plugin', name }],
})

const agentOutcome = (mdPath: string, name = 'build'): PackInstallOutcome => ({
  packPath: mdPath,
  detectedType: 'agent',
  installLogPath: '/tmp/install.log',
  registeredIn: ['agents'],
  instructions: [{ kind: 'file', section: 'agents', name, target: mdPath }],
})

describe('phase 04 — homeIsolation', () => {
  beforeEach(() => {
    installMock.mockReset()
    installMock.mockImplementation(() => Effect.succeed(undefined))
  })
  afterEach(() => {
    restoreHome()
  })

  it('happy-path skill: N=1 builds both HOMEs, new gets symlink, auth copied', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
      await runP(writeFile(path.join(h, '.opencode', 'auth.json'), '{}'))
    })
    const packDir = await writePackSkill('myskill')
    const input = buildInput({}, skillOutcome(packDir))
    const result = await runP(homeIsolation(input))
    expect(result.homeTrees.old).toHaveLength(1)
    expect(result.homeTrees.new).toHaveLength(1)
    expect(result.envVars).toHaveLength(2)
    expect(result.envVars[0]).toHaveLength(1)
    expect(result.envVars[1]).toHaveLength(1)
    const newHome = input.workspace.homeNew[0]!
    const linkPath = path.join(newHome, '.config', 'opencode', 'skills', 'myskill')
    expect(await runP(exists(linkPath))).toBe(true)
    expect(await runP(readSymlink(linkPath))).toBe(packDir)
    expect(result.homeTrees.new[0]!.copiedAuth).toContain('.opencode')
  })

  it('smoke-test (no packInstall): no symlink, no plugin install, identical configs', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    expect(installMock).not.toHaveBeenCalled()
    expect(result.generatedConfigs.baseline).toBe(result.generatedConfigs.new)
    const newHome = input.workspace.homeNew[0]!
    expect(await runP(exists(path.join(newHome, '.config', 'opencode', 'skills', 'myskill')))).toBe(false)
  })

  it('plugin install success → installPlugin called per new run', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({}, pluginOutcome('myplugin'))
    const result = await runP(homeIsolation(input))
    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).toHaveBeenCalledWith(input.workspace.homeNew[0], 'myplugin')
    expect(result.homeTrees.new[0]).toBeDefined()
  })

  it('plugin install timeout → E_PACK_INSTALL_TIMEOUT', async () => {
    installMock.mockImplementation(() => Effect.sleep('200 millis'))
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput(
      { timeouts: { ...baseTimeouts, installSeconds: 0.05 } },
      pluginOutcome('myplugin'),
    )
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
          timedOut: false,
        }),
      ),
    )
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({}, pluginOutcome('myplugin'))
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_PACK_INSTALL_FAILED')
  })

  it('auth fully missing → E_AUTH_MISSING', async () => {
    await useFakeHome()
    const input = buildInput(
      {
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
      },
      undefined,
    )
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_AUTH_MISSING')
  })

  it('auth partial (only npmrc) → OK, copiedAuth=[".npmrc"]', async () => {
    await useFakeHome(async (h) => {
      await runP(writeFile(path.join(h, '.npmrc'), 'registry=https://registry.npmjs.org\n'))
    })
    const input = buildInput(
      {
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
      },
      undefined,
    )
    const result = await runP(homeIsolation(input))
    const copied = result.homeTrees.new[0]!.copiedAuth
    expect(copied).toEqual(['.npmrc'])
  })

  it('envVars: old has PURE+DISABLE flags, new does not', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    const oldEnv = result.envVars[0]![0]!
    const newEnv = result.envVars[1]![0]!
    expect(oldEnv.OPENCODE_PURE).toBe(true)
    expect(oldEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(true)
    expect(oldEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe(true)
    expect(oldEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(true)
    expect(newEnv.OPENCODE_PURE).toBe(false)
    expect(newEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe(false)
    expect(newEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe(false)
    expect(newEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe(true)
    expect(oldEnv.HOME).toBe(input.workspace.homeOld[0])
    expect(newEnv.HOME).toBe(input.workspace.homeNew[0])
  })

  it('generatedConfigs differ for old/new when a pack is present', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const packDir = await writePackSkill('myskill')
    const input = buildInput({}, skillOutcome(packDir))
    const result = await runP(homeIsolation(input))
    expect(result.generatedConfigs.baseline).not.toBe(result.generatedConfigs.new)
    expect(result.generatedConfigs.new).toContain('myskill')
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expect(baselineJson['agent']).toBeDefined()
    expect(newJson['agent']).toBeDefined()
  })

  it('writes config/baseline.json and config/new.json to disk', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const packDir = await writePackSkill('myskill')
    const input = buildInput({}, skillOutcome(packDir))
    const result = await runP(homeIsolation(input))
    const baselinePath = path.join(input.workspace.config, 'baseline.json')
    const newPath = path.join(input.workspace.config, 'new.json')
    expect(await runP(exists(baselinePath))).toBe(true)
    expect(await runP(exists(newPath))).toBe(true)
    const baselineOnDisk = JSON.parse(await runP(readFile(baselinePath))) as Record<string, unknown>
    const newOnDisk = JSON.parse(await runP(readFile(newPath))) as Record<string, unknown>
    expect(baselineOnDisk).toEqual(JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>)
    expect(newOnDisk).toEqual(JSON.parse(result.generatedConfigs.new) as Record<string, unknown>)
    expect(baselineOnDisk['testaipack']).toBeUndefined()
    const packMeta = newOnDisk['testaipack'] as Record<string, unknown>
    expect(packMeta).toBeDefined()
    expect(packMeta['packName']).toBe('myskill')
    expect(packMeta['packType']).toBe('skill')
    expect(newOnDisk['agent']).toBeDefined()
  })

  it('smoke-test writes identical baseline.json and new.json (no pack metadata)', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({}, undefined)
    await runP(homeIsolation(input))
    const baselinePath = path.join(input.workspace.config, 'baseline.json')
    const newPath = path.join(input.workspace.config, 'new.json')
    const baselineOnDisk = JSON.parse(await runP(readFile(baselinePath))) as Record<string, unknown>
    const newOnDisk = JSON.parse(await runP(readFile(newPath))) as Record<string, unknown>
    expect(baselineOnDisk['testaipack']).toBeUndefined()
    expect(newOnDisk['testaipack']).toBeUndefined()
    expect(baselineOnDisk).toEqual(newOnDisk)
  })

  it('N=3 → three homeTrees per side, three envVars per side', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({ runs: 3 }, undefined, 3)
    const result = await runP(homeIsolation(input))
    expect(result.homeTrees.old).toHaveLength(3)
    expect(result.homeTrees.new).toHaveLength(3)
    expect(result.envVars[0]).toHaveLength(3)
    expect(result.envVars[1]).toHaveLength(3)
    for (const t of result.homeTrees.old) {
      expect(t.structure.length).toBeGreaterThan(0)
    }
  })

  it('agent file instruction → .md copied into agents/ on new side only', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const mdSrc = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(mdSrc))
    const mdPath = path.join(mdSrc, 'deploy.md')
    await runP(writeFile(mdPath, '# deploy agent\n'))
    const input = buildInput({}, agentOutcome(mdPath, 'deploy'))
    const result = await runP(homeIsolation(input))
    const newAgentsFile = path.join(
      input.workspace.homeNew[0]!,
      '.config',
      'opencode',
      'agents',
      'deploy.md',
    )
    const oldAgentsFile = path.join(
      input.workspace.homeOld[0]!,
      '.config',
      'opencode',
      'agents',
      'deploy.md',
    )
    expect(await runP(exists(newAgentsFile))).toBe(true)
    expect(await runP(exists(oldAgentsFile))).toBe(false)
    expect(await runP(readFile(newAgentsFile))).toBe('# deploy agent\n')
    void result
  })

  it('command file instruction → .md copied into command/ (singular dir) on new side', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const mdSrc = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(mdSrc))
    const mdPath = path.join(mdSrc, 'run.md')
    await runP(writeFile(mdPath, '# run command\n'))
    const outcome: PackInstallOutcome = {
      packPath: mdPath,
      detectedType: 'command',
      installLogPath: '/tmp/install.log',
      registeredIn: ['commands'],
      instructions: [{ kind: 'file', section: 'commands', name: 'run', target: mdPath }],
    }
    const input = buildInput({}, outcome)
    await runP(homeIsolation(input))
    const newCmdFile = path.join(
      input.workspace.homeNew[0]!,
      '.config',
      'opencode',
      'command',
      'run.md',
    )
    const oldCmdFile = path.join(
      input.workspace.homeOld[0]!,
      '.config',
      'opencode',
      'command',
      'run.md',
    )
    expect(await runP(exists(newCmdFile))).toBe(true)
    expect(await runP(exists(oldCmdFile))).toBe(false)
  })

  it('mcp config instruction → E_HOME_SETUP_FAILED (v0.3 not supported)', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [{ kind: 'config', section: 'mcp', json: { x: 1 } }],
    }
    const input = buildInput({}, outcome)
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
  })

  it('docker isolation (v0.3) → E_DOCKER_FAILED', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({ isolation: 'docker' }, undefined)
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_DOCKER_FAILED')
  })

  it('build.md written into every HOME (for preflight gate 3)', async () => {
    await useFakeHome(async (h) => {
      await runP(ensureDir(path.join(h, '.opencode')))
    })
    const input = buildInput({}, undefined)
    await runP(homeIsolation(input))
    const oldBuild = path.join(
      input.workspace.homeOld[0]!,
      '.config',
      'opencode',
      'agents',
      'build.md',
    )
    const newBuild = path.join(
      input.workspace.homeNew[0]!,
      '.config',
      'opencode',
      'agents',
      'build.md',
    )
    expect(await runP(exists(oldBuild))).toBe(true)
    expect(await runP(exists(newBuild))).toBe(true)
  })
})
