import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, symlink, removeDir } from '../util/fs.js'
import { preflight } from './05-preflight.js'
import type { PreflightInputExt } from './05-preflight.js'
import type { RunInput, Manifest, PreflightCheck } from '@generated/types'
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

const { version, run, OpencodeError } = await import('../opencode/cli.js')
const versionMock = vi.mocked(version)
const runMock = vi.mocked(run)
const { ensureImage, dockerRun, DockerError, DEFAULT_OPENCODE_IMAGE } = await import('../isolation/docker-runner.js')
const ensureImageMock = vi.mocked(ensureImage)
const dockerRunMock = vi.mocked(dockerRun)
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
  runId: 'rid',
  timestamp: new Date().toISOString(),
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

/** Build a real pair of HOMEs with the build agent in place (as phase 04 leaves them). */
const buildHomes = async (): Promise<{ old: string; new: string; root: string }> => {
  const root = makeTempDir()
  const oldHome = path.join(root, 'home', 'old', 'run-1')
  const newHome = path.join(root, 'home', 'new', 'run-1')
  for (const h of [oldHome, newHome]) {
    await runP(ensureDir(path.join(h, '.config', 'opencode', 'skills')))
    await runP(ensureDir(path.join(h, '.config', 'opencode', 'agents')))
    await runP(ensureDir(path.join(h, '.config', 'opencode', 'plugins')))
    await runP(ensureDir(path.join(h, '.config', 'opencode', 'command')))
    await runP(writeFile(path.join(h, '.config', 'opencode', 'agents', 'build.md'), '# build\n'))
  }
  return { old: oldHome, new: newHome, root }
}

const buildInput = (
  homes: { old: string; new: string; root: string },
  runInputOverrides: Partial<RunInput>,
  packInstall: PackInstallOutcome | undefined,
): PreflightInputExt => ({
  runInput: makeRunInput({
    workspacePath: homes.root,
    outputPath: path.join(homes.root, 'out'),
    ...runInputOverrides,
  }),
  manifest: { ...fakeManifest, ...(packInstall === undefined ? {} : { packRef: 'github:o/myskill', packType: 'skill' }) },
  homePaths: { old: homes.old, new: homes.new },
  ...(packInstall === undefined ? {} : { packInstall }),
})

const expectedLogPath = (input: PreflightInputExt): string =>
  path.join(input.runInput.outputPath, 'preflight.log')

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

const configOutcome = (name = 'myserver'): PackInstallOutcome => ({
  packPath: '',
  detectedType: 'mcp',
  installLogPath: '/tmp/install.log',
  registeredIn: ['mcp'],
  instructions: [{ kind: 'config', section: 'mcp', name, json: { command: 'npx' } }],
})

const writeMcpConfig = async (homeDir: string, name: string): Promise<void> => {
  const cfgDir = path.join(homeDir, '.config', 'opencode')
  await runP(ensureDir(cfgDir))
  await runP(
    writeFile(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({ mcp: { [name]: { command: 'npx' } } }),
    ),
  )
}

/** As phase 04's `applyInstruction` would register a local plugin file. */
const writePluginConfig = async (homeDir: string, registeredPath: string): Promise<void> => {
  const cfgDir = path.join(homeDir, '.config', 'opencode')
  await runP(ensureDir(cfgDir))
  await runP(
    writeFile(path.join(cfgDir, 'opencode.json'), JSON.stringify({ plugin: [registeredPath] })),
  )
}

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
  })

  it('--no-preflight → checks=[], allPassed=true, exitCode=0', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, { preflightEnabled: false }, undefined)
    const result = await runP(preflight(input))
    expect(result.checks).toEqual([])
    expect(result.allPassed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.logPath).toBe(expectedLogPath(input))
  })

  it('all-pass (skill pack) → 9 checks (gates 1-3 per side + gate 4 + gate 5 + gate 6 skipped), exitCode=0', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    // skill visible on new side: create the symlink phase 04 would have made
    await runP(symlink(packDir, path.join(homes.new, '.config', 'opencode', 'skills', 'myskill')))
    // probe response mentions the pack name
    runMock.mockImplementation((_opts) =>
      Effect.succeed({
        exitCode: 0,
        stdout: 'Available skills: myskill',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    )
    const input = buildInput(homes, {}, skillOutcome(packDir))
    const result = await runP(preflight(input))
    expect(result.allPassed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.checks.length).toBe(9)
    expect(result.checks.every((c) => c.passed)).toBe(true)
    const byName = (name: string, side: string): PreflightCheck | undefined =>
      result.checks.find((c) => c.name === name && c.side === side)
    expect(byName('opencode-launch', 'old')).toBeDefined()
    expect(byName('opencode-launch', 'new')).toBeDefined()
    expect(byName('auth-ping', 'old')).toBeDefined()
    expect(byName('auth-ping', 'new')).toBeDefined()
    expect(byName('build-agent', 'old')).toBeDefined()
    expect(byName('build-agent', 'new')).toBeDefined()
    expect(byName('pack-visibility', 'new')).toBeDefined()
    expect(byName('baseline-identical', 'old')).toBeDefined()
    expect(byName('pack-functional', 'new')).toBeDefined()
  })

  it('opencode-launch fail → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const homes = await buildHomes()
    versionMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({
          command: 'version',
          exitCode: 1,
          stderr: 'command not found',
          stdout: '',
          timedOut: false,
        }),
      ),
    )
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('opencode-launch')
  })

  it('auth-ping timeout → E_PREFLIGHT_TIMEOUT, exitCode=2', async () => {
    const homes = await buildHomes()
    runMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({
          command: 'run',
          exitCode: null,
          stderr: '',
          stdout: '',
          timedOut: true,
        }),
      ),
    )
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_TIMEOUT')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('auth-ping')
  })

  it('auth-ping no credentials → E_AUTH_MISSING, exitCode=2', async () => {
    const homes = await buildHomes()
    runMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({
          command: 'run',
          exitCode: 1,
          stderr: 'ANTHROPIC_API_KEY is not set',
          stdout: '',
          timedOut: false,
        }),
      ),
    )
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_AUTH_MISSING')
    expect(err.context?.['exitCode']).toBe(2)
  })

  it('gate 2 (auth-ping) targets runInput.model when set, not preflightModel', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, { model: 'x/y', preflightModel: 'a/b' }, undefined)
    await runP(preflight(input))
    expect(runMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of runMock.mock.calls) {
      expect(call[0].model).toBe('x/y')
    }
  })

  it('gate 2 (auth-ping) passes no explicit model when runInput.model is unset, even with preflightModel set', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, { preflightModel: 'a/b' }, undefined)
    await runP(preflight(input))
    expect(runMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of runMock.mock.calls) {
      expect(call[0].model).toBeUndefined()
    }
  })

  it('gate 5 (baseline-identical) re-run also targets runInput.model, not preflightModel', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes.new, '.config', 'opencode', 'skills', 'myskill')))
    const input = buildInput(homes, { model: 'x/y', preflightModel: 'a/b' }, skillOutcome(packDir))
    const result = await runP(preflight(input))
    expect(result.allPassed).toBe(true)
    // gate 2 pings old+new, gate 5 re-pings old — at least 3 auth-ping calls total.
    expect(runMock.mock.calls.length).toBeGreaterThanOrEqual(3)
    for (const call of runMock.mock.calls) {
      expect(call[0].model).toBe('x/y')
    }
  })

  it('build-agent absent → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const homes = await buildHomes()
    await runP(removeDir(path.join(homes.new, '.config', 'opencode', 'agents', 'build.md')))
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('build-agent')
  })

  it('pack-visibility skill fail (no SKILL.md) → E_PREFLIGHT_PACK_INVISIBLE, exitCode=3', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    // no SKILL.md created
    const input = buildInput(homes, {}, skillOutcome(packDir))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['check']).toBe('pack-visibility')
  })

  it('pack-visibility skill fail when the NEW-home symlink was never created (pack source has SKILL.md)', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    // deliberately skip creating .config/opencode/skills/myskill in homes.new:
    // the pack source is fine, but registration into the new HOME never happened
    const input = buildInput(homes, {}, skillOutcome(packDir))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['check']).toBe('pack-visibility')
  })

  it('pack-visibility skill success (SKILL.md present) → visible regardless of LLM output', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes.new, '.config', 'opencode', 'skills', 'myskill')))
    runMock.mockImplementation((_opts) =>
      Effect.succeed({
        exitCode: 0,
        stdout: 'no skills here',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    )
    const input = buildInput(homes, {}, skillOutcome(packDir))
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.allPassed).toBe(true)
  })

  it('pack-visibility plugin success (plugin file present on new side)', async () => {
    const homes = await buildHomes()
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.js'), 'module.exports={}'))
    const input = buildInput(homes, {}, pluginOutcome('myplugin'))
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.allPassed).toBe(true)
  })

  it('pack-visibility plugin invisible → E_PREFLIGHT_PACK_INVISIBLE, exitCode=3', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, {}, pluginOutcome('myplugin'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
  })

  it('pack-visibility local plugin (target set) success — checks the exact delivered filename, not <name>.js', async () => {
    const homes = await buildHomes()
    // target's basename is myplugin.mjs, not <name>.js — proves the check
    // uses the delivered filename, not a `${name}.js` guess.
    const srcFile = path.join(homes.root, 'src', 'myplugin.mjs')
    const dstFile = path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.mjs')
    await runP(writeFile(dstFile, 'export default {}'))
    await writePluginConfig(homes.new, dstFile)
    const input = buildInput(homes, {}, localPluginOutcome(srcFile, 'myplugin'))
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.allPassed).toBe(true)
  })

  it('pack-visibility local plugin: file copied but opencode.json never registered it → E_PREFLIGHT_PACK_INVISIBLE (the file-present-but-unregistered bug)', async () => {
    const homes = await buildHomes()
    const srcFile = path.join(homes.root, 'src', 'myplugin.mjs')
    // file is delivered, but no opencode.json entry points at it — exactly
    // what a stale/wrong registered path would also look like from gate 4's
    // point of view: present on disk, never actually loadable.
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.mjs'), 'export default {}'))
    const input = buildInput(homes, {}, localPluginOutcome(srcFile, 'myplugin'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
  })

  it('pack-visibility local plugin: opencode.json registers a path that does not resolve (stale/host-only path) → E_PREFLIGHT_PACK_INVISIBLE', async () => {
    const homes = await buildHomes()
    const srcFile = path.join(homes.root, 'src', 'myplugin.mjs')
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.mjs'), 'export default {}'))
    // registered entry points somewhere that does not exist — reproduces a
    // stale or environment-mismatched path (e.g. a host path under docker).
    await writePluginConfig(homes.new, '/nowhere/myplugin.mjs')
    const input = buildInput(homes, {}, localPluginOutcome(srcFile, 'myplugin'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
  })

  it('pack-visibility local plugin (target set) invisible when the file was never delivered → E_PREFLIGHT_PACK_INVISIBLE', async () => {
    const homes = await buildHomes()
    const srcFile = path.join(homes.root, 'src-myplugin.js')
    const input = buildInput(homes, {}, localPluginOutcome(srcFile, 'myplugin'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
  })

  it('pack-visibility mcp visible (opencode.json has mcp.<name> on new side) → exitCode=0', async () => {
    const homes = await buildHomes()
    await writeMcpConfig(homes.new, 'myserver')
    const input = buildInput(homes, {}, configOutcome('myserver'))
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.allPassed).toBe(true)
  })

  it('pack-visibility mcp absent (no opencode.json on new side) → E_PREFLIGHT_PACK_INVISIBLE, exitCode=3', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, {}, configOutcome('myserver'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['check']).toBe('pack-visibility')
  })

  it('smoke-test (no packInstall): gate 4 skipped, exitCode=0 if rest ok', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, {}, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const gate4 = result.checks.find((c) => c.name === 'pack-visibility')
    expect(gate4).toBeDefined()
    expect(gate4?.details).toContain('skipped')
  })

  it('baseline-identical leak (pack symlink on old side) → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    await runP(symlink(packDir, path.join(homes.new, '.config', 'opencode', 'skills', 'myskill')))
    // leak: same symlink accidentally on old side
    await runP(symlink(packDir, path.join(homes.old, '.config', 'opencode', 'skills', 'myskill')))
    runMock.mockImplementation((_opts) =>
      Effect.succeed({
        exitCode: 0,
        stdout: 'myskill',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    )
    const input = buildInput(homes, {}, skillOutcome(packDir))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('baseline-identical')
    expect(err.context?.['exitCode']).toBe(2)
  })

  it('baseline-identical leak (plugin .js file on old side) → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const homes = await buildHomes()
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.js'), 'module.exports={}'))
    // leak: same plugin file (with its .js extension) accidentally on old side
    await runP(writeFile(path.join(homes.old, '.config', 'opencode', 'plugins', 'myplugin.js'), 'module.exports={}'))
    runMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: 'OK', stderr: '', durationMs: 5, timedOut: false }),
    )
    const input = buildInput(homes, {}, pluginOutcome('myplugin'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('baseline-identical')
    expect(err.context?.['exitCode']).toBe(2)
  })

  it('baseline-identical leak (local plugin file, target set) on old side → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const homes = await buildHomes()
    const srcFile = path.join(homes.root, 'src', 'myplugin.js')
    const dstFile = path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.js')
    await runP(writeFile(dstFile, 'module.exports={}'))
    await writePluginConfig(homes.new, dstFile)
    // leak: same delivered filename accidentally on old side
    await runP(writeFile(path.join(homes.old, '.config', 'opencode', 'plugins', 'myplugin.js'), 'module.exports={}'))
    runMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: 'OK', stderr: '', durationMs: 5, timedOut: false }),
    )
    const input = buildInput(homes, {}, localPluginOutcome(srcFile, 'myplugin'))
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('baseline-identical')
    expect(err.context?.['exitCode']).toBe(2)
  })

  it('agent pack visible on new side → exitCode=0', async () => {
    const homes = await buildHomes()
    const mdSrc = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(mdSrc))
    await runP(writeFile(path.join(mdSrc, 'deploy.md'), '# deploy\n'))
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'agents', 'deploy.md'), '# deploy\n'))
    const outcome: PackInstallOutcome = {
      packPath: path.join(mdSrc, 'deploy.md'),
      detectedType: 'agent',
      installLogPath: '/tmp/install.log',
      registeredIn: ['agents'],
      instructions: [{ kind: 'file', section: 'agents', name: 'deploy', target: path.join(mdSrc, 'deploy.md') }],
    }
    const input = buildInput(homes, {}, outcome)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
  })

  it('docker mode: gate 1 calls ensureImage then version with the image', async () => {
    const homes = await buildHomes()
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, undefined),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(ensureImageMock).toHaveBeenCalledWith(DEFAULT_OPENCODE_IMAGE)
    // version invoked with the docker exec spec for both sides
    const dockerCalls = versionMock.mock.calls.filter(
      (c) => (c[1] as { image?: string } | undefined)?.image !== undefined,
    )
    expect(dockerCalls.length).toBeGreaterThanOrEqual(2)
    expect((dockerCalls[0]?.[1] as { image: string }).image).toBe(DEFAULT_OPENCODE_IMAGE)
  })

  it('docker mode: ensureImage failure → E_PREFLIGHT_FAILED (image unavailable)', async () => {
    const homes = await buildHomes()
    ensureImageMock.mockImplementation(() =>
      Effect.fail(
        new DockerError({ command: 'pull', exitCode: 1, stderr: 'manifest unknown', timedOut: false }),
      ),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, undefined),
      dockerImage: 'opencode/missing:latest',
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('opencode-launch')
    expect(err.message).toContain('unavailable')
    expect(err.message).toContain('build-docker-image.sh')
    expect(err.message).toContain('manifest unknown')
    expect(err.context?.['image']).toBe('opencode/missing:latest')
  })

  it('docker mode: auth-ping runs through the container (run called with docker spec)', async () => {
    const homes = await buildHomes()
    runMock.mockImplementation((opts: { docker?: { image: string } }) =>
      Effect.succeed({
        exitCode: 0,
        stdout: opts.docker !== undefined ? 'OK-docker' : 'OK',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, undefined),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const dockerRunCalls = runMock.mock.calls.filter(
      (c) => (c[0] as { docker?: { image: string } } | undefined)?.docker !== undefined,
    )
    expect(dockerRunCalls.length).toBeGreaterThan(0)
    expect((dockerRunCalls[0]?.[0] as { docker: { image: string } }).docker.image).toBe(
      DEFAULT_OPENCODE_IMAGE,
    )
  })

  it('docker mode with --docker-network: auth-ping runs with the network in the docker spec', async () => {
    const homes = await buildHomes()
    runMock.mockImplementation((opts: { docker?: { image: string; network?: string } }) =>
      Effect.succeed({
        exitCode: 0,
        stdout: opts.docker !== undefined ? 'OK-docker' : 'OK',
        stderr: '',
        durationMs: 5,
        timedOut: false,
      }),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker', dockerNetwork: 'host' }, undefined),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const dockerRunCalls = runMock.mock.calls.filter(
      (c) => (c[0] as { docker?: { image: string; network?: string } } | undefined)?.docker !== undefined,
    )
    expect(dockerRunCalls.length).toBeGreaterThan(0)
    expect(
      (dockerRunCalls[0]?.[0] as { docker: { image: string; network?: string } }).docker.network,
    ).toBe('host')
  })

  it('docker mode: gate 4 trusts the container, not the host — host has no SKILL.md but the container check succeeds → visible', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    // deliberately no file under homes.new/.config/opencode/skills/myskill —
    // the host filesystem alone would say "not visible". Gate 5 also
    // re-checks the SAME instruction against homes.old (must stay absent
    // there), so the mock discriminates by which HOME it was asked about.
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes.new
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, skillOutcome(packDir)),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(dockerRunMock).toHaveBeenCalled()
  })

  it('docker mode: gate 4 rejects a HOST-only match — file exists on host but the container check fails → E_PREFLIGHT_PACK_INVISIBLE (the exact dangling-symlink-outside-the-mount bug)', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    // present on the host (as a dangling-symlink-outside-any-mount would
    // resolve pre-fix), but the container itself cannot see it.
    await runP(ensureDir(path.join(homes.new, '.config', 'opencode', 'skills', 'myskill')))
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'skills', 'myskill', 'SKILL.md'), '# myskill\n'))
    dockerRunMock.mockImplementation(() =>
      Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, skillOutcome(packDir)),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['check']).toBe('pack-visibility')
  })

  it('docker mode: local plugin visible when opencode.json registers a container path (/home/opencode/...), not the host path', async () => {
    const homes = await buildHomes()
    const srcFile = path.join(homes.root, 'src', 'myplugin.js')
    await runP(writeFile(path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.js'), 'module.exports={}'))
    await writePluginConfig(homes.new, '/home/opencode/.config/opencode/plugins/myplugin.js')
    // only the NEW home has the file; a /home/opencode/... target is only
    // "real" when the mount backing it is homes.new (the leak-check re-runs
    // the same relative path against homes.old, which must stay absent).
    dockerRunMock.mockImplementation((opts: { homeDir: string; command: readonly string[] }) => {
      const target = opts.command[2] ?? ''
      return opts.homeDir === homes.new && target.startsWith('/home/opencode/')
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false }))
    })
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, localPluginOutcome(srcFile, 'myplugin')),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
  })

  it('docker mode: local plugin invisible when opencode.json still registers the HOST-absolute path — reproduces the stale-registration bug that survives even after the file is copied correctly', async () => {
    const homes = await buildHomes()
    const srcFile = path.join(homes.root, 'src', 'myplugin.js')
    const hostDstPath = path.join(homes.new, '.config', 'opencode', 'plugins', 'myplugin.js')
    await runP(writeFile(hostDstPath, 'module.exports={}'))
    // the bug: registers the path our own process wrote to, not the path
    // opencode will see when it reads this config from inside the container.
    await writePluginConfig(homes.new, hostDstPath)
    dockerRunMock.mockImplementation((opts: { command: readonly string[] }) => {
      const target = opts.command[2] ?? ''
      return target.startsWith('/home/opencode/')
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false }))
    })
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, localPluginOutcome(srcFile, 'myplugin')),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
  })

  it('docker mode: baseline-leak check fails loudly on a docker infra error (e.g. missing image) instead of silently reporting "no leak"', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes.new
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        // old-side leak check: an infra failure, NOT a legitimate "file
        // absent" (exitCode 1) — e.g. exitCode 125 "no such image".
        : Effect.fail(
            new DockerError({ command: 'run', exitCode: 125, stderr: 'Error: No such image', timedOut: false }),
          ),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, skillOutcome(packDir)),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('baseline-identical')
    expect(err.message).toContain('cannot verify')
  })

  it('docker mode: baseline-leak check still treats a plain exit-1 "file not found" as no-leak, not an error', async () => {
    const homes = await buildHomes()
    const packDir = makeTempDir('testaipack-pack-src-')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'SKILL.md'), '# myskill\n'))
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes.new
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker' }, skillOutcome(packDir)),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
  })

  it('gate 6: no --pack-check → skipped, exitCode=0', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, {}, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const gate6 = result.checks.find((c) => c.name === 'pack-functional')
    expect(gate6?.details).toContain('skipped')
    expect(gate6?.passed).toBe(true)
  })

  it('gate 6: new side exit 0, old side exit 1 (expected) → passes, exitCode=0, packChecks recorded', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new ? 0 : 1,
        stdout: '', stderr: '', durationMs: 3, timedOut: false,
      }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks).toHaveLength(2)
    expect(result.packChecks?.find((c) => c.side === 'new')?.exitCode).toBe(0)
    expect(result.packChecks?.find((c) => c.side === 'old')?.exitCode).toBe(1)
  })

  it('gate 6: new side check fails (tool not functional) → E_PACK_CHECK_FAILED, exitCode=3', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new ? 1 : 1,
        stdout: '', stderr: '', durationMs: 3, timedOut: false,
      }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('new-side-not-functional')
  })

  it('gate 6: old side unexpectedly has the tool (exit 0) → E_PACK_CHECK_FAILED, exitCode=3, baseline-already-has-tool', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('baseline-already-has-tool')
  })

  it('gate 6: --allow-baseline-tool overrides the old-side-has-tool hard fail, with a details note', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation(() =>
      Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version', allowBaselineTool: true }, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    const oldCheck = result.checks.find((c) => c.name === 'pack-functional' && c.side === 'old')
    expect(oldCheck?.passed).toBe(true)
    expect(oldCheck?.details).toContain('allow-baseline-tool')
  })

  // Review-gate regression: a missing command exits 127 via the shell
  // (`sh: 1: graphify: not found`), not 1 — on the OLD side that IS the
  // expected, required outcome (the baseline correctly lacks the tool), not
  // an infra fault. This used to abort the whole experiment.
  it('gate 6: baseline check exits 127 (command not found) → PASS, the invariant holds', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new ? 0 : 127,
        stdout: '', stderr: 'sh: 1: graphify: not found', durationMs: 3, timedOut: false,
      }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks?.find((c) => c.side === 'old')?.exitCode).toBe(127)
  })

  it('gate 6: baseline check exits 1 (ordinary absent) → PASS', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new ? 0 : 1,
        stdout: '', stderr: '', durationMs: 3, timedOut: false,
      }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
  })

  it('gate 6: new side check exits 127 (command not found) → FAIL, new-side-not-functional', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new ? 127 : 1,
        stdout: '', stderr: 'sh: 1: mytool: not found', durationMs: 3, timedOut: false,
      }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('new-side-not-functional')
  })

  it('gate 6: the check itself times out (runner-level failure) on either side → fails loudly, exitCode=2', async () => {
    const homes = await buildHomes()
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new ? -1 : 0,
        stdout: '', stderr: '', durationMs: 3, timedOut: opts.cwd === homes.new,
      }),
    )
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['timedOut']).toBe(true)
  })

  it('gate 6 (docker mode): a docker-level execution error (timeout) on the old side fails loudly, not read as "tool absent"', async () => {
    const homes = await buildHomes()
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes.new
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: null, stderr: 'docker daemon unreachable', timedOut: true })),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker', packCheck: 'mytool --version' }, undefined),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
  })

  it('gate 6 (docker mode): runs through dockerRun, same pass/fail semantics', async () => {
    const homes = await buildHomes()
    dockerRunMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes.new
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false })),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker', packCheck: 'mytool --version' }, undefined),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks).toHaveLength(2)
  })

  it('gate 6 (home mode): forwards homePathEnv.new/.old as PATH to --pack-check, one value per side', async () => {
    const homes = await buildHomes()
    const seenPaths: Record<string, string | undefined> = {}
    spawnMock.mockImplementation((opts: { cwd: string; env?: Record<string, string> }) => {
      seenPaths[opts.cwd] = opts.env?.['PATH']
      return Effect.succeed({
        exitCode: opts.cwd === homes.new ? 0 : 1,
        stdout: '', stderr: '', durationMs: 3, timedOut: false,
      })
    })
    const input: PreflightInputExt = {
      ...buildInput(homes, { packCheck: 'mytool --version' }, undefined),
      homePathEnv: { new: '/new/.local/bin:/usr/bin', old: '/old/.local/bin:/usr/bin' },
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(seenPaths[homes.new]).toBe('/new/.local/bin:/usr/bin')
    expect(seenPaths[homes.old]).toBe('/old/.local/bin:/usr/bin')
  })

  it('gate 6 (docker mode): forwards homePathEnv.new/.old as -e PATH=<value>, one value per side', async () => {
    const homes = await buildHomes()
    const seenPaths: Record<string, string | undefined> = {}
    dockerRunMock.mockImplementation((opts: { homeDir: string; env?: Record<string, string> }) => {
      seenPaths[opts.homeDir] = opts.env?.['PATH']
      return opts.homeDir === homes.new
        ? Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false })
        : Effect.fail(new DockerError({ command: 'run', exitCode: 1, stderr: '', timedOut: false }))
    })
    const input: PreflightInputExt = {
      ...buildInput(homes, { isolation: 'docker', packCheck: 'mytool --version' }, undefined),
      dockerImage: DEFAULT_OPENCODE_IMAGE,
      homePathEnv: { new: '/home/opencode/.local/bin:/usr/bin', old: '/home/opencode/.local/bin:/usr/bin' },
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(seenPaths[homes.new]).toBe('/home/opencode/.local/bin:/usr/bin')
    expect(seenPaths[homes.old]).toBe('/home/opencode/.local/bin:/usr/bin')
  })

  it('gate 6: without homePathEnv, PATH is left undefined — inherits the image/host default', async () => {
    const homes = await buildHomes()
    let sawPath: string | undefined = 'unset'
    spawnMock.mockImplementation((opts: { cwd: string; env?: Record<string, string> }) => {
      if (opts.cwd === homes.new) sawPath = opts.env?.['PATH']
      return Effect.succeed({
        exitCode: opts.cwd === homes.new ? 0 : 1,
        stdout: '', stderr: '', durationMs: 3, timedOut: false,
      })
    })
    const input = buildInput(homes, { packCheck: 'mytool --version' }, undefined)
    await runP(preflight(input))
    expect(sawPath).toBe(process.env['PATH'])
  })

  // Real-incident regression (testaipack run b7d56c): 04b-pack-setup copies
  // the one HOME it installed into over every other new HOME, and until now
  // gate 6 only ever checked `homePaths.new`/`.old` (run-1's HOME) — proving
  // nothing about the rest. `homesForCheck` makes the gate check every HOME.
  const buildSecondHomes = async (root: string): Promise<{ old2: string; new2: string }> => {
    const oldHome2 = path.join(root, 'home', 'old', 'run-2')
    const newHome2 = path.join(root, 'home', 'new', 'run-2')
    for (const h of [oldHome2, newHome2]) {
      await runP(ensureDir(path.join(h, '.config', 'opencode', 'skills')))
      await runP(ensureDir(path.join(h, '.config', 'opencode', 'agents')))
      await runP(ensureDir(path.join(h, '.config', 'opencode', 'plugins')))
      await runP(ensureDir(path.join(h, '.config', 'opencode', 'command')))
      await runP(writeFile(path.join(h, '.config', 'opencode', 'agents', 'build.md'), '# build\n'))
    }
    return { old2: oldHome2, new2: newHome2 }
  }

  it('gate 6 (multi-HOME): run-2 new HOME fails while run-1 passes (incomplete copy) → fails loudly before any run/exercise, exitCode=3, runIndex=2', async () => {
    const homes = await buildHomes()
    const { old2, new2 } = await buildSecondHomes(homes.root)
    spawnMock.mockImplementation((opts: { cwd: string }) => {
      if (opts.cwd === homes.new) {
        return Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false })
      }
      if (opts.cwd === new2) {
        return Effect.succeed({
          exitCode: 127,
          stdout: '', stderr: 'sh: 1: graphify: not found', durationMs: 3, timedOut: false,
        })
      }
      return Effect.succeed({ exitCode: 1, stdout: '', stderr: '', durationMs: 3, timedOut: false })
    })
    const input: PreflightInputExt = {
      ...buildInput(homes, { packCheck: 'graphify --version' }, undefined),
      homesForCheck: {
        new: [{ homeDir: homes.new, pathOverride: undefined }, { homeDir: new2, pathOverride: undefined }],
        old: [{ homeDir: homes.old, pathOverride: undefined }, { homeDir: old2, pathOverride: undefined }],
      },
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['exitCode']).toBe(3)
    expect(err.context?.['reason']).toBe('new-side-not-functional')
    expect(err.context?.['runIndex']).toBe(2)
  })

  it('gate 6 (multi-HOME): run-2 old HOME unexpectedly has the tool (leaked copy) while run-1 correctly lacks it → fails loudly, runIndex=2', async () => {
    const homes = await buildHomes()
    const { old2, new2 } = await buildSecondHomes(homes.root)
    spawnMock.mockImplementation((opts: { cwd: string }) => {
      if (opts.cwd === homes.new || opts.cwd === new2) {
        return Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false })
      }
      if (opts.cwd === old2) {
        return Effect.succeed({ exitCode: 0, stdout: '', stderr: '', durationMs: 3, timedOut: false })
      }
      return Effect.succeed({ exitCode: 1, stdout: '', stderr: '', durationMs: 3, timedOut: false })
    })
    const input: PreflightInputExt = {
      ...buildInput(homes, { packCheck: 'graphify --version' }, undefined),
      homesForCheck: {
        new: [{ homeDir: homes.new, pathOverride: undefined }, { homeDir: new2, pathOverride: undefined }],
        old: [{ homeDir: homes.old, pathOverride: undefined }, { homeDir: old2, pathOverride: undefined }],
      },
    }
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PACK_CHECK_FAILED')
    expect(err.context?.['reason']).toBe('baseline-already-has-tool')
    expect(err.context?.['runIndex']).toBe(2)
  })

  it('gate 6 (multi-HOME): every HOME on both sides passes its invariant → packChecks carries one entry per HOME with the right runIndex', async () => {
    const homes = await buildHomes()
    const { old2, new2 } = await buildSecondHomes(homes.root)
    spawnMock.mockImplementation((opts: { cwd: string }) =>
      Effect.succeed({
        exitCode: opts.cwd === homes.new || opts.cwd === new2 ? 0 : 1,
        stdout: '', stderr: '', durationMs: 3, timedOut: false,
      }),
    )
    const input: PreflightInputExt = {
      ...buildInput(homes, { packCheck: 'graphify --version' }, undefined),
      homesForCheck: {
        new: [{ homeDir: homes.new, pathOverride: undefined }, { homeDir: new2, pathOverride: undefined }],
        old: [{ homeDir: homes.old, pathOverride: undefined }, { homeDir: old2, pathOverride: undefined }],
      },
    }
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    expect(result.packChecks).toHaveLength(4)
    expect(result.packChecks?.filter((c) => c.side === 'new').map((c) => c.runIndex).sort()).toEqual([1, 2])
    expect(result.packChecks?.filter((c) => c.side === 'old').map((c) => c.runIndex).sort()).toEqual([1, 2])
  })
})

describe('phase 05 — preflight (gates 1-3 for old AND new)', () => {
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
  })

  it('gate 1 fail for new (opencode --version fails in new HOME) → E_PREFLIGHT_FAILED, exit 2', async () => {
    const homes = await buildHomes()
    versionMock.mockImplementation((homeDir: string) =>
      homeDir === homes.new
        ? Effect.fail(
            new OpencodeError({
              command: 'version',
              exitCode: 1,
              stderr: 'crash in new HOME',
              stdout: '',
              timedOut: false,
            }),
          )
        : Effect.succeed('1.0.0'),
    )
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('opencode-launch')
    expect(err.context?.['side']).toBe('new')
  })

  it('gate 2 fail for new (auth-ping fails in new HOME) → E_PREFLIGHT_FAILED, exit 2', async () => {
    const homes = await buildHomes()
    runMock.mockImplementation((opts: { homeDir: string }) =>
      opts.homeDir === homes.new
        ? Effect.fail(
            new OpencodeError({
              command: 'run',
              exitCode: 1,
              stderr: 'HTTP 429 rate limited in new HOME',
              stdout: '',
              timedOut: false,
            }),
          )
        : Effect.succeed({
            exitCode: 0,
            stdout: '{"role":"assistant","text":"OK"}',
            stderr: '',
            durationMs: 5,
            timedOut: false,
          }),
    )
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['exitCode']).toBe(2)
    expect(err.context?.['check']).toBe('auth-ping')
    expect(err.context?.['side']).toBe('new')
  })

  it('gate 3 fail for new (build.md absent in new HOME) → E_PREFLIGHT_FAILED, exit 2', async () => {
    const homes = await buildHomes()
    await runP(removeDir(path.join(homes.new, '.config', 'opencode', 'agents', 'build.md')))
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_FAILED')
    expect(err.context?.['check']).toBe('build-agent')
    expect(err.context?.['side']).toBe('new')
  })

  it('gate 5 re-runs gates 1-3 for old (auth-ping invoked twice for old HOME) + pack-leak check', async () => {
    const homes = await buildHomes()
    const input = buildInput(homes, {}, undefined)
    const result = await runP(preflight(input))
    expect(result.exitCode).toBe(0)
    // gate 2 runs auth-ping for old once; gate 5 re-runs it for old again → ≥2 calls with homeDir=old
    const oldCalls = runMock.mock.calls.filter(
      (c) => (c[0] as { homeDir: string } | undefined)?.homeDir === homes.old,
    )
    expect(oldCalls.length).toBeGreaterThanOrEqual(2)
    // baseline-identical check present and passed
    const gate5 = result.checks.find((c) => c.name === 'baseline-identical')
    expect(gate5).toBeDefined()
    expect(gate5?.passed).toBe(true)
  })
})
