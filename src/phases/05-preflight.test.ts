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
  version: vi.fn(),
  run: vi.fn(),
  installPlugin: vi.fn(),
  exportSession: vi.fn(),
  listMcp: vi.fn(),
}))

const { version, run, OpencodeError } = await import('../opencode/cli.js')
const versionMock = vi.mocked(version)
const runMock = vi.mocked(run)

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
  runInput: makeRunInput({ workspacePath: homes.root, ...runInputOverrides }),
  manifest: { ...fakeManifest, ...(packInstall === undefined ? {} : { packRef: 'github:o/myskill', packType: 'skill' }) },
  homePaths: { old: homes.old, new: homes.new },
  ...(packInstall === undefined ? {} : { packInstall }),
})

const expectedLogPath = (homes: { root: string }): string =>
  path.join(homes.root, fakeManifest.runId, 'results', 'preflight.log')

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

describe('phase 05 — preflight', () => {
  beforeEach(() => {
    versionMock.mockReset()
    runMock.mockReset()
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
    expect(result.logPath).toBe(expectedLogPath(homes))
  })

  it('all-pass (skill pack) → 8 checks (gates 1-3 per side + gate 4 + gate 5), exitCode=0', async () => {
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
    expect(result.checks.length).toBe(8)
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
  })

  it('opencode-launch fail → E_PREFLIGHT_FAILED, exitCode=2', async () => {
    const homes = await buildHomes()
    versionMock.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({
          command: 'version',
          exitCode: 1,
          stderr: 'command not found',
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
          timedOut: false,
        }),
      ),
    )
    const input = buildInput(homes, {}, undefined)
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_AUTH_MISSING')
    expect(err.context?.['exitCode']).toBe(2)
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

  it('pack-visibility skill fail (probe does not mention name) → E_PREFLIGHT_PACK_INVISIBLE', async () => {
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
    const err = await runFlip(preflight(input))
    expect(err.code).toBe('E_PREFLIGHT_PACK_INVISIBLE')
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
})

describe('phase 05 — preflight (gates 1-3 for old AND new)', () => {
  beforeEach(() => {
    versionMock.mockReset()
    runMock.mockReset()
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
