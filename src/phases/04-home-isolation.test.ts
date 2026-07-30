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
} from '@generated/types'
import type { PackInstallOutcome } from './03-pack-install.js'

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
    gitDirsOld: [],
    gitDirsNew: [],
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

const skillOutcome = (packDir: string, name = 'myskill'): PackInstallOutcome => ({
  packPath: packDir,
  detectedType: 'skill',
  installLogPath: '/tmp/install.log',
  registeredIn: ['skills'],
  instructions: [{ kind: 'skill', name, target: packDir }],
})

const pluginOutcome = (name = 'myplugin'): PackInstallOutcome => ({
  packPath: '',
  detectedType: 'plugin',
  installLogPath: '/tmp/install.log',
  registeredIn: ['plugins'],
  instructions: [{ kind: 'plugin', name }],
})

const localPluginOutcome = (target: string, name = 'myplugin'): PackInstallOutcome => ({
  packPath: '',
  detectedType: 'all',
  installLogPath: '/tmp/install.log',
  registeredIn: ['plugins'],
  instructions: [{ kind: 'plugin', name, target }],
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

  it('happy-path skill: N=1 builds both HOMEs, new gets a real copy (not a symlink to the host pack dir), auth copied', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
    const destPath = path.join(newHome, '.config', 'opencode', 'skills', 'myskill')
    expect(await runP(exists(destPath))).toBe(true)
    // A real directory copy, not a symlink: a docker container that only
    // mounts the run HOME (never workspace.pack/) still sees the file.
    expect(await runP(pathKind(destPath))).toBe('dir')
    expect(await runP(readFile(path.join(destPath, 'SKILL.md')))).toBe('# myskill\n')
    expect(result.homeTrees.new[0]!.copiedAuth).toContain('.local/share/opencode/auth.json')
  })

  it('skill instruction whose name escapes the skills dir → E_HOME_SETUP_FAILED, nothing written outside it', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const packDir = await writePackSkill('evil')
    const input = buildInput({}, skillOutcome(packDir, '../../evil'))
    const err = await runFlip(homeIsolation(input))
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
    const newHome = input.workspace.homeNew[0]!
    expect(await runP(exists(path.join(newHome, '.config', 'opencode', 'skills')))).toBe(true)
    expect(await runP(exists(path.join(newHome, '.config', 'evil')))).toBe(false)
  })

  it('smoke-test (no packInstall): no skill install, no plugin install, identical configs', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({}, pluginOutcome('myplugin'))
    const result = await runP(homeIsolation(input))
    expect(installMock).toHaveBeenCalledTimes(1)
    expect(installMock).toHaveBeenCalledWith(input.workspace.homeNew[0], 'myplugin')
    expect(result.homeTrees.new[0]).toBeDefined()
  })

  it('docker isolation threads the docker image into plugin install (M7)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({ isolation: 'docker' }, pluginOutcome('myplugin'))
    await runP(homeIsolation(input))
    expect(installMock).toHaveBeenCalledWith(input.workspace.homeNew[0], 'myplugin', {
      image: DEFAULT_OPENCODE_IMAGE,
    })
  })

  it('docker isolation with a custom --docker-image threads it into plugin install', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input: HomeIsolationInputExt = {
      ...buildInput({ isolation: 'docker' }, pluginOutcome('myplugin')),
      dockerImage: 'registry.example/oc:dev',
    }
    await runP(homeIsolation(input))
    expect(installMock).toHaveBeenCalledWith(input.workspace.homeNew[0], 'myplugin', {
      image: 'registry.example/oc:dev',
    })
  })

  it('docker isolation with --docker-network threads it into plugin install', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input: HomeIsolationInputExt = {
      ...buildInput({ isolation: 'docker', dockerNetwork: 'host' }, pluginOutcome('myplugin')),
      dockerImage: 'registry.example/oc:dev',
    }
    await runP(homeIsolation(input))
    expect(installMock).toHaveBeenCalledWith(input.workspace.homeNew[0], 'myplugin', {
      image: 'registry.example/oc:dev',
      network: 'host',
    })
  })

  it('home isolation ignores dockerNetwork (no docker exec at all)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({ isolation: 'home', dockerNetwork: 'host' }, pluginOutcome('myplugin'))
    await runP(homeIsolation(input))
    expect(installMock).toHaveBeenCalledWith(input.workspace.homeNew[0], 'myplugin')
  })

  it('local plugin file (target set): copied into new HOME plugins/ + registered as a local spec, installPlugin NOT called', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const srcDir = makeTempDir('testaipack-plugin-src-')
    await runP(ensureDir(srcDir))
    const srcFile = path.join(srcDir, 'myplugin.js')
    await runP(writeFile(srcFile, 'module.exports = {}'))
    const input = buildInput({}, localPluginOutcome(srcFile, 'myplugin'))
    await runP(homeIsolation(input))
    const dstFile = path.join(input.workspace.homeNew[0]!, '.config/opencode/plugins/myplugin.js')
    expect(await runP(exists(dstFile))).toBe(true)
    const cfgPath = path.join(input.workspace.homeNew[0]!, '.config/opencode/opencode.json')
    const cfg = JSON.parse(await runP(readFile(cfgPath))) as { plugin?: readonly string[] }
    expect(cfg.plugin).toEqual([dstFile])
    expect(installMock).not.toHaveBeenCalled()
  })

  it('local plugin file under --isolation docker: registers a container-form path (/home/opencode/...), not the host path our own process wrote to', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const srcDir = makeTempDir('testaipack-plugin-src-')
    await runP(ensureDir(srcDir))
    const srcFile = path.join(srcDir, 'myplugin.js')
    await runP(writeFile(srcFile, 'module.exports = {}'))
    const input = buildInput({ isolation: 'docker' }, localPluginOutcome(srcFile, 'myplugin'))
    await runP(homeIsolation(input))
    const newHome = input.workspace.homeNew[0]!
    const dstFile = path.join(newHome, '.config/opencode/plugins/myplugin.js')
    expect(await runP(exists(dstFile))).toBe(true)
    const cfgPath = path.join(newHome, '.config/opencode/opencode.json')
    const cfg = JSON.parse(await runP(readFile(cfgPath))) as { plugin?: readonly string[] }
    // the registered spec must be reachable from INSIDE the container, where
    // homeDir is mounted at /home/opencode -- the host path (dstFile) does
    // not exist there.
    expect(cfg.plugin).toEqual(['/home/opencode/.config/opencode/plugins/myplugin.js'])
    expect(cfg.plugin?.[0]).not.toBe(dstFile)
  })

  it('local plugin file: old (baseline) side never gets the file or a plugin instruction applied', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const srcDir = makeTempDir('testaipack-plugin-src-')
    await runP(ensureDir(srcDir))
    const srcFile = path.join(srcDir, 'myplugin.js')
    await runP(writeFile(srcFile, 'module.exports = {}'))
    const input = buildInput({}, localPluginOutcome(srcFile, 'myplugin'))
    await runP(homeIsolation(input))
    const oldDstFile = path.join(input.workspace.homeOld[0]!, '.config/opencode/plugins/myplugin.js')
    expect(await runP(exists(oldDstFile))).toBe(false)
  })

  it('plugin install timeout → E_PACK_INSTALL_TIMEOUT', async () => {
    installMock.mockImplementation(() => Effect.sleep('200 millis'))
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
          stdout: '',
          timedOut: false,
        }),
      ),
    )
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
      await runP(seedOpencodeAuth(h))
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

  it('skill pack → baseline and new configs identical (pack lives on the filesystem, not the config)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const packDir = await writePackSkill('myskill')
    const input = buildInput({}, skillOutcome(packDir))
    const result = await runP(homeIsolation(input))
    expect(result.generatedConfigs.baseline).toBe(result.generatedConfigs.new)
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    expect(baselineJson['agent']).toBeDefined()
    expect(baselineJson['testaipack']).toBeUndefined()
  })

  it('propagates the model from the source opencode.json into both configs', async () => {
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
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expect(baselineJson['model']).toBe('zai-coding-plan/glm-5.2')
    expect(newJson['model']).toBe('zai-coding-plan/glm-5.2')
  })

  it('omits model from both configs when the source opencode.json has none', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    expect(baselineJson['model']).toBeUndefined()
  })

  it('runInput.model overrides the source opencode.json model in both configs', async () => {
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
    const input = buildInput({ model: 'anthropic/claude-x' }, undefined)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expect(baselineJson['model']).toBe('anthropic/claude-x')
    expect(newJson['model']).toBe('anthropic/claude-x')
  })

  it('runInput.model + mcp pack: baseline and new configs still differ only in mcp', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [
        { kind: 'config', section: 'mcp', name: 'myserver', json: { command: 'npx' } },
      ],
    }
    const input = buildInput({ model: 'anthropic/claude-x' }, outcome)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expect(baselineJson['model']).toBe('anthropic/claude-x')
    expect(newJson['model']).toBe('anthropic/claude-x')
    expect(baselineJson['mcp']).toBeUndefined()
    expect(newJson['mcp']).toBeDefined()
    const { mcp: _newMcp, ...newRest } = newJson
    expect(newRest).toEqual(baselineJson)
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

  it('propagates provider/small_model/enabled_providers/disabled_providers from the source opencode.json into both configs', async () => {
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
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expectConnectivityPropagated(baselineJson)
    expectConnectivityPropagated(newJson)
  })

  it('omits provider/small_model/enabled_providers/disabled_providers from both configs when the source opencode.json has none (byte-identical to today)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    for (const json of [baselineJson, newJson]) {
      expect(json['provider']).toBeUndefined()
      expect(json['small_model']).toBeUndefined()
      expect(json['enabled_providers']).toBeUndefined()
      expect(json['disabled_providers']).toBeUndefined()
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
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    expect(baselineJson['enabled_providers']).toBeUndefined()
    expect(baselineJson['disabled_providers']).toBeUndefined()
    expect(baselineJson['small_model']).toBeUndefined()
  })

  it('custom provider/small_model/enabled_providers/disabled_providers + mcp pack: baseline and new configs still differ only in mcp', async () => {
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
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [
        { kind: 'config', section: 'mcp', name: 'myserver', json: { command: 'npx' } },
      ],
    }
    const input = buildInput({}, outcome)
    const result = await runP(homeIsolation(input))
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expectConnectivityPropagated(baselineJson)
    expectConnectivityPropagated(newJson)
    expect(baselineJson['mcp']).toBeUndefined()
    expect(newJson['mcp']).toBeDefined()
    const { mcp: _newMcp, ...newRest } = newJson
    expect(newRest).toEqual(baselineJson)
  })

  it('writes config/baseline.json and config/new.json to disk', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
    expect(newOnDisk['testaipack']).toBeUndefined()
    expect(newOnDisk['agent']).toBeDefined()
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
    const input = buildInput({}, undefined)
    const result = await runP(homeIsolation(input))

    // execution path: unredacted, real credential
    const baselineCfg = JSON.parse(result.generatedConfigs.baseline) as { provider: { anthropic: { options: { apiKey: string } } } }
    expect(baselineCfg.provider.anthropic.options.apiKey).toBe('sk-ant-REAL-SECRET')

    // disk artifact: redacted
    const baselinePath = path.join(input.workspace.config, 'baseline.json')
    const onDiskText = await runP(readFile(baselinePath))
    expect(onDiskText).not.toContain('sk-ant-REAL-SECRET')
    const onDisk = JSON.parse(onDiskText) as { provider: { anthropic: { npm: string; options: { apiKey: string } } } }
    expect(onDisk.provider.anthropic.options.apiKey).toBe('[REDACTED]')
    expect(onDisk.provider.anthropic.npm).toBe('@ai-sdk/anthropic')
  })

  it('redacts an mcp server env secret on disk, keeps it real in generatedConfigs.new', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [
        {
          kind: 'config',
          section: 'mcp',
          name: 'myserver',
          json: { command: 'npx', args: ['-y', 'myserver'], env: { API_TOKEN: 'sk-mcp-REAL-SECRET' } },
        },
      ],
    }
    const input = buildInput({}, outcome)
    const result = await runP(homeIsolation(input))

    const newCfg = JSON.parse(result.generatedConfigs.new) as {
      mcp: { myserver: { env: { API_TOKEN: string } } }
    }
    expect(newCfg.mcp.myserver.env.API_TOKEN).toBe('sk-mcp-REAL-SECRET')

    const newPath = path.join(input.workspace.config, 'new.json')
    const onDiskText = await runP(readFile(newPath))
    expect(onDiskText).not.toContain('sk-mcp-REAL-SECRET')
    const onDisk = JSON.parse(onDiskText) as { mcp: { myserver: { env: { API_TOKEN: string } } } }
    expect(onDisk.mcp.myserver.env.API_TOKEN).toBe('[REDACTED]')
  })

  it('re-verify: a bare <VENDOR>_KEY and a URL with embedded userinfo stay real in generatedConfigs.new (the OPENCODE_CONFIG_CONTENT source), redacted only on disk', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [
        {
          kind: 'config',
          section: 'mcp',
          name: 'myserver',
          json: {
            command: 'npx',
            env: { GEMINI_KEY: 'sk-gemini-REAL-SECRET' },
            url: 'https://svcuser:svcpass@remote.example/sse',
          },
        },
      ],
    }
    const input = buildInput({}, outcome)
    const result = await runP(homeIsolation(input))

    // runtime path: real values, exactly what OPENCODE_CONFIG_CONTENT carries
    const newCfg = JSON.parse(result.generatedConfigs.new) as {
      mcp: { myserver: { env: { GEMINI_KEY: string }; url: string } }
    }
    expect(newCfg.mcp.myserver.env.GEMINI_KEY).toBe('sk-gemini-REAL-SECRET')
    expect(newCfg.mcp.myserver.url).toBe('https://svcuser:svcpass@remote.example/sse')

    // disk artifact: both shapes redacted
    const newPath = path.join(input.workspace.config, 'new.json')
    const onDiskText = await runP(readFile(newPath))
    expect(onDiskText).not.toContain('sk-gemini-REAL-SECRET')
    expect(onDiskText).not.toContain('svcuser:svcpass')
    const onDisk = JSON.parse(onDiskText) as {
      mcp: { myserver: { env: { GEMINI_KEY: string }; url: string } }
    }
    expect(onDisk.mcp.myserver.env.GEMINI_KEY).toBe('[REDACTED]')
    expect(onDisk.mcp.myserver.url).toBe('https://remote.example/sse')
  })

  it('smoke-test writes identical baseline.json and new.json (no pack metadata)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
      await runP(seedOpencodeAuth(h))
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
      await runP(seedOpencodeAuth(h))
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
      await runP(seedOpencodeAuth(h))
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

  it('mcp config instruction → writes mcp.<name> into opencode.json on new side', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [
        {
          kind: 'config',
          section: 'mcp',
          name: 'myserver',
          json: { command: 'npx', args: ['-y', 'myserver'] },
        },
      ],
    }
    const input = buildInput({}, outcome)
    const result = await runP(homeIsolation(input))
    const newCfgPath = path.join(
      input.workspace.homeNew[0]!,
      '.config',
      'opencode',
      'opencode.json',
    )
    const oldCfgPath = path.join(
      input.workspace.homeOld[0]!,
      '.config',
      'opencode',
      'opencode.json',
    )
    expect(await runP(exists(newCfgPath))).toBe(true)
    const newCfg = JSON.parse(await runP(readFile(newCfgPath))) as Record<string, unknown>
    const mcp = newCfg['mcp'] as Record<string, unknown>
    expect(mcp).toBeDefined()
    expect(mcp['myserver']).toEqual({ command: 'npx', args: ['-y', 'myserver'] })
    expect(await runP(exists(oldCfgPath))).toBe(false)
    const newJson = JSON.parse(result.generatedConfigs.new) as Record<string, unknown>
    expect((newJson['mcp'] as Record<string, unknown>)['myserver']).toBeDefined()
    const baselineJson = JSON.parse(result.generatedConfigs.baseline) as Record<string, unknown>
    expect(baselineJson['mcp']).toBeUndefined()
  })

  it('mcp config extends an existing opencode.json instead of overwriting', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const outcome: PackInstallOutcome = {
      packPath: '',
      detectedType: 'mcp',
      installLogPath: '/tmp/install.log',
      registeredIn: ['mcp'],
      instructions: [
        { kind: 'config', section: 'mcp', name: 'srv2', json: { command: 'node' } },
      ],
    }
    const input = buildInput({}, outcome)
    // pre-place an existing opencode.json with a prior mcp server on the new side
    const newHome = input.workspace.homeNew[0]!
    const cfgDir = path.join(newHome, '.config', 'opencode')
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

  it('docker isolation (v0.3) builds HOMEs and records isolation/dockerImage', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({ isolation: 'docker' }, undefined)
    const result = await runP(homeIsolation(input))
    expect(result.isolation).toBe('docker')
    expect(result.dockerImage).toBe(DEFAULT_OPENCODE_IMAGE)
    expect(result.homeTrees.old).toHaveLength(1)
    expect(result.homeTrees.new).toHaveLength(1)
  })

  it('docker isolation honours a custom --docker-image override', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input: HomeIsolationInputExt = {
      ...buildInput({ isolation: 'docker' }, undefined),
      dockerImage: 'registry.example/oc:dev',
    }
    const result = await runP(homeIsolation(input))
    expect(result.dockerImage).toBe('registry.example/oc:dev')
  })

  it('home isolation records isolation="home" and no dockerImage', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
    })
    const input = buildInput({ isolation: 'home' }, undefined)
    const result = await runP(homeIsolation(input))
    expect(result.isolation).toBe('home')
    expect(result.dockerImage).toBeUndefined()
  })

  it('build.md written into every HOME (for preflight gate 3)', async () => {
    await useFakeHome(async (h) => {
      await runP(seedOpencodeAuth(h))
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
