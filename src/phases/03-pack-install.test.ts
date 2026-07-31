import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, readFile, exists } from '../util/fs.js'
import { GitError } from '../util/git.js'
import { packInstall } from './03-pack-install.js'
import type { PackInstallInput, RunInput, Manifest, WorkspaceTree, PackSpec, AuthWhitelist, TimeoutConfig } from '@generated/types'

vi.mock('../util/git.js', () => ({
  GitError: class extends Error {
    readonly _tag = 'GitError'
    readonly command: string
    readonly exitCode: number
    readonly stderr: string
    constructor(args: { command: string; exitCode: number; stderr: string }) {
      super(`git ${args.command} failed`)
      this.command = args.command
      this.exitCode = args.exitCode
      this.stderr = args.stderr
    }
  },
  clone: vi.fn(),
}))

const { clone } = await import('../util/git.js')
const cloneMock = vi.mocked(clone)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

const baseTimeouts: TimeoutConfig = {
  preflightSeconds: 30,
  runSeconds: 60,
  verifySeconds: 60,
  installSeconds: 5,
  watchdogSeconds: 60,
}

const baseAuth: AuthWhitelist = {
  opencode: false,
  npmrc: false,
  anthropic: false,
  openai: false,
  gemini: false,
  aws: false,
  ssh: false,
  git: false,
}

const makeRunInput = (packs: readonly PackSpec[], overrides: Partial<RunInput> = {}): RunInput => ({
  schemaVersion: 2,
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do thing',
  runs: 1,
  parallel: 2,
  baseline: 'v',
  packs: [...packs],
  variants: [{ name: 'v', packs: [] }],
  isolation: 'home',
  auth: baseAuth,
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

interface BuiltInput {
  readonly input: PackInstallInput
  readonly root: string
  readonly packDir: string
  readonly resultsDir: string
}

const buildInput = async (
  packs: readonly PackSpec[],
  runInputOverrides: Partial<RunInput> = {},
): Promise<BuiltInput> => {
  const root = makeTempDir()
  const packDir = path.join(root, 'pack')
  const resultsDir = path.join(root, 'results')
  await runP(ensureDir(packDir))
  await runP(ensureDir(resultsDir))
  const workspace: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'src'),
    pack: packDir,
    variantTrees: [],
    config: path.join(root, 'config'),
    results: resultsDir,
    raw: path.join(root, 'raw'),
    diff: path.join(root, 'diff'),
  }
  const manifest: Manifest = {
    schemaVersion: 2,
    runId: 'rid',
    timestamp: new Date().toISOString(),
    repoUrl: 'https://example.com/repo.git',
    prompt: 'do thing',
    runs: 1,
    parallel: 2,
    baseline: 'v',
    packs: [...packs],
    variants: [{ name: 'v', packs: [] }],
    isolation: 'home',
    opencodeVersion: '1.0.0',
    flagDefaults: {},
  }
  return {
    input: {
      runInput: makeRunInput(packs, runInputOverrides),
      manifest,
      workspace,
    },
    root,
    packDir,
    resultsDir,
  }
}

const singlePack = (over: Partial<PackSpec> = {}): PackSpec => ({
  name: 'demo',
  ref: 'github:owner/myskill',
  ...over,
})

const materializeClone =
  (files: Record<string, string>, delayMs = 0) =>
  (_url: string, dst: string): Effect.Effect<void, GitError> =>
    Effect.gen(function* () {
      if (delayMs > 0) yield* Effect.sleep(delayMs)
      yield* ensureDir(dst)
      for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dst, rel)
        yield* ensureDir(path.dirname(p))
        yield* writeFile(p, content)
      }
    }).pipe(
      Effect.mapError(
        (e: unknown) =>
          new GitError({
            command: 'clone',
            exitCode: 1,
            stderr: e instanceof Error ? e.message : String(e),
          }),
      ),
    )

const failingClone =
  (stderr: string, exitCode = 128) =>
  (_url: string, _dst: string): Effect.Effect<void, GitError> =>
    Effect.fail(new GitError({ command: 'clone', exitCode, stderr }))

describe('phase 03 — packInstall', () => {
  beforeEach(() => {
    cloneMock.mockReset()
    cloneMock.mockImplementation(() => Effect.succeed(undefined))
  })

  it('empty registry → deliveries [], smoke-test log line, not an error', async () => {
    const built = await buildInput([])
    const result = await runP(packInstall(built.input))
    expect(result.deliveries).toEqual([])
    const log = await runP(readFile(result.installLogPath))
    expect(log).toContain('smoke-test')
  })

  it('registry of 2 packs (skill + command) delivers both under distinct pack/<name>/ dirs with per-pack instruction lists', async () => {
    cloneMock.mockImplementation((url: string, dst: string) => {
      if (url.includes('myskill')) return materializeClone({ 'SKILL.md': '# skill\n' })(url, dst)
      return materializeClone({ 'run.md': '# run command\n' })(url, dst)
    })
    const packs: PackSpec[] = [
      { name: 'my-skill-pack', ref: 'github:owner/myskill' },
      { name: 'my-cmd-pack', ref: 'command:github:owner/run' },
    ]
    const built = await buildInput(packs)
    const result = await runP(packInstall(built.input))
    expect(result.deliveries).toHaveLength(2)
    const skillDelivery = result.deliveries.find((d) => d.pack === 'my-skill-pack')!
    const cmdDelivery = result.deliveries.find((d) => d.pack === 'my-cmd-pack')!
    expect(skillDelivery.detectedType).toBe('skill')
    expect(cmdDelivery.detectedType).toBe('command')
    expect(skillDelivery.packPath.startsWith(path.join(built.packDir, 'my-skill-pack'))).toBe(true)
    expect(cmdDelivery.packPath.startsWith(path.join(built.packDir, 'my-cmd-pack'))).toBe(true)
    expect(skillDelivery.instructions).toEqual([
      { kind: 'skill', name: 'myskill', target: skillDelivery.packPath },
    ])
    expect(cmdDelivery.instructions[0]!.kind).toBe('file')
  })

  it('two packs sharing the same underlying ref name still land in distinct pack/<packName>/ dirs (registry name wins)', async () => {
    cloneMock.mockImplementation(materializeClone({ 'SKILL.md': '# skill\n' }))
    const packs: PackSpec[] = [
      { name: 'alpha', ref: 'github:owner/shared' },
      { name: 'beta', ref: 'github:owner/shared' },
    ]
    const built = await buildInput(packs)
    const result = await runP(packInstall(built.input))
    const alpha = result.deliveries.find((d) => d.pack === 'alpha')!
    const beta = result.deliveries.find((d) => d.pack === 'beta')!
    expect(alpha.packPath).not.toBe(beta.packPath)
    expect(alpha.packPath.startsWith(path.join(built.packDir, 'alpha'))).toBe(true)
    expect(beta.packPath.startsWith(path.join(built.packDir, 'beta'))).toBe(true)
  })

  it('one pack failing to install does not stop the log line naming which pack failed', async () => {
    cloneMock.mockImplementation(failingClone('fatal: not found'))
    const built = await buildInput([singlePack({ name: 'broken', ref: 'github:owner/missing' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_INSTALL_FAILED')
    expect(err.context?.['pack']).toBe('broken')
  })

  it('skill (git): detect → clone → SKILL.md present → skill instruction', async () => {
    cloneMock.mockImplementation(
      materializeClone({ 'SKILL.md': '# skill\n', 'README.md': 'r' }),
    )
    const built = await buildInput([singlePack({ name: 'demo', ref: 'github:owner/myskill' })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.pack).toBe('demo')
    expect(d.detectedType).toBe('skill')
    expect(d.registeredIn).toEqual(['skills'])
    const expected = path.join(built.packDir, 'demo', 'myskill')
    expect(d.packPath).toBe(expected)
    expect(await runP(exists(path.join(expected, 'SKILL.md')))).toBe(true)
    expect(d.instructions).toEqual([{ kind: 'skill', name: 'myskill', target: expected }])
    expect(cloneMock).toHaveBeenCalledWith(
      'https://github.com/owner/myskill.git',
      expected,
      { shallow: true },
    )
  })

  it('skill (local): copies dir, verifies SKILL.md, no clone', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    await runP(writeFile(path.join(src, 'SKILL.md'), '# local\n'))
    const built = await buildInput([singlePack({ ref: src })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('skill')
    expect(d.registeredIn).toEqual(['skills'])
    const expected = path.join(built.packDir, 'demo', path.basename(src))
    expect(d.packPath).toBe(expected)
    expect(await runP(exists(path.join(expected, 'SKILL.md')))).toBe(true)
    expect(d.instructions[0]!.kind).toBe('skill')
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('plugin (npm): no clone, plugin instruction, registeredIn=["plugins"]', async () => {
    const built = await buildInput([singlePack({ ref: 'npm:myplugin' })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('plugin')
    expect(d.packPath).toBe('')
    expect(d.registeredIn).toEqual(['plugins'])
    expect(d.instructions).toEqual([{ kind: 'plugin', name: 'myplugin' }])
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('agent (local .md): file instruction section="agents"', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    const md = path.join(src, 'build.md')
    await runP(writeFile(md, '# agent\n'))
    const built = await buildInput([singlePack({ ref: `agent:${md}` })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('agent')
    expect(d.registeredIn).toEqual(['agents'])
    expect(d.packPath).toBe(path.join(built.packDir, 'demo', 'build.md'))
    expect(d.instructions[0]!.kind).toBe('file')
    if (d.instructions[0]!.kind === 'file') {
      expect(d.instructions[0]!.section).toBe('agents')
      expect(d.instructions[0]!.name).toBe('build')
      expect(await runP(exists(d.instructions[0]!.target))).toBe(true)
    }
  })

  it('command (local .md): file instruction section="commands"', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    const md = path.join(src, 'run.md')
    await runP(writeFile(md, '# command\n'))
    const built = await buildInput([singlePack({ ref: `command:${md}` })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('command')
    expect(d.registeredIn).toEqual(['commands'])
    expect(d.instructions[0]!.kind).toBe('file')
    if (d.instructions[0]!.kind === 'file') {
      expect(d.instructions[0]!.section).toBe('commands')
      expect(d.instructions[0]!.name).toBe('run')
    }
  })

  it('mcp (inline json): config instruction with parsed json, registeredIn=["mcp"]', async () => {
    const built = await buildInput([
      singlePack({ ref: 'mcp:myserver:{"command":"npx","args":["-y","myserver"]}' }),
    ])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('mcp')
    expect(d.registeredIn).toEqual(['mcp'])
    expect(d.packPath).toBe(path.join(built.packDir, 'demo', 'myserver'))
    expect(d.instructions).toHaveLength(1)
    expect(d.instructions[0]!.kind).toBe('config')
    if (d.instructions[0]!.kind === 'config') {
      expect(d.instructions[0]!.section).toBe('mcp')
      expect(d.instructions[0]!.name).toBe('myserver')
      expect(d.instructions[0]!.json).toEqual({ command: 'npx', args: ['-y', 'myserver'] })
    }
    expect(await runP(exists(path.join(built.packDir, 'demo', 'myserver', 'mcp.json')))).toBe(true)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('mcp (@file): reads config file, parses json', async () => {
    const cfgSrc = makeTempDir()
    await runP(ensureDir(cfgSrc))
    const cfgPath = path.join(cfgSrc, 'mcp.json')
    await runP(writeFile(cfgPath, '{"command":"node","args":["srv.js"]}'))
    const built = await buildInput([singlePack({ ref: `mcp:filesrv:@${cfgPath}` })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('mcp')
    expect(d.registeredIn).toEqual(['mcp'])
    if (d.instructions[0]!.kind === 'config') {
      expect(d.instructions[0]!.name).toBe('filesrv')
      expect(d.instructions[0]!.json).toEqual({ command: 'node', args: ['srv.js'] })
    }
  })

  it('mcp (@file missing) → E_PACK_INVALID_REF', async () => {
    const built = await buildInput([singlePack({ ref: 'mcp:myserver:@/nope/missing.json' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('mcp (invalid json) → E_PACK_INVALID_REF', async () => {
    const built = await buildInput([singlePack({ ref: 'mcp:myserver:{not json}' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('mcp ref with an unsafe name and an inline secret → detectPack failure leaks neither the secret nor the JSON body', async () => {
    const secret = 'sk-fake-secret'
    const built = await buildInput([
      singlePack({ ref: `mcp:../evil:{"env":{"KEY":"${secret}"}}` }),
    ])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(err.message).not.toContain(secret)
    expect(err.message).not.toContain('KEY')
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain(secret)
    expect(contextStr).not.toContain('KEY')
  })

  it('mcp (invalid json with an embedded secret) → error leaks neither the secret nor the raw config', async () => {
    const secret = 'sk-test-FAKESECRET-1234567890'
    const built = await buildInput([
      singlePack({
        ref: `mcp:myserver:{"command":"npx","env":{"API_KEY":"${secret}"} not json}`,
      }),
    ])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(err.message).not.toContain(secret)
    expect(err.message).not.toContain('API_KEY')
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain(secret)
    expect(contextStr).not.toContain('API_KEY')
  })

  it('mcp (invalid json starting with a secret, no JSON structure at all) → still leaks nothing', async () => {
    const secret = 'sk-test-FAKESECRET-startofstring'
    const built = await buildInput([singlePack({ ref: `mcp:myserver:${secret}-not-json-at-all` })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(err.message).not.toContain(secret)
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain(secret)
  })

  it('mcp (no config, no standard file) → E_PACK_INVALID_REF', async () => {
    const built = await buildInput([singlePack({ ref: 'mcp:myserver' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('mcp (no config in ref, standard mcp.json present) → reads it', async () => {
    const built = await buildInput([singlePack({ ref: 'mcp:std' })])
    const packDir = path.join(built.packDir, 'demo', 'std')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'mcp.json'), '{"command":"x"}'))
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('mcp')
    if (d.instructions[0]!.kind === 'config') {
      expect(d.instructions[0]!.json).toEqual({ command: 'x' })
    }
  })

  it('all: repo with skills/ + commands/ → multiple sections + mixed instructions', async () => {
    cloneMock.mockImplementation(
      materializeClone({
        'skills/cool/SKILL.md': '# cool\n',
        'commands/deploy.md': '# deploy\n',
      }),
    )
    const built = await buildInput([
      singlePack({ ref: 'github:owner/megapack', type: 'all' }),
    ])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('all')
    expect(d.registeredIn).toContain('skills')
    expect(d.registeredIn).toContain('commands')
    const kinds = d.instructions.map((i) => i.kind)
    expect(kinds).toContain('skill')
    expect(kinds).toContain('file')
    const skillInst = d.instructions.find((i) => i.kind === 'skill')
    expect(skillInst).toBeDefined()
    if (skillInst?.kind === 'skill') {
      expect(skillInst.name).toBe('cool')
    }
  })

  it('all with no standard subdirs → empty registeredIn (warning, not error)', async () => {
    cloneMock.mockImplementation(materializeClone({ 'README.md': 'r' }))
    const built = await buildInput([
      singlePack({ ref: 'github:owner/empty', type: 'all' }),
    ])
    const result = await runP(packInstall(built.input))
    expect(result.deliveries[0]!.detectedType).toBe('all')
    expect(result.deliveries[0]!.registeredIn).toEqual([])
  })

  it('pack-type override forces a type without re-detecting', async () => {
    cloneMock.mockImplementation(materializeClone({ 'SKILL.md': '# x\n' }))
    const built = await buildInput([
      singlePack({ ref: 'github:owner/repo', type: 'skill' }),
    ])
    const result = await runP(packInstall(built.input))
    expect(result.deliveries[0]!.detectedType).toBe('skill')
    expect(result.deliveries[0]!.registeredIn).toEqual(['skills'])
  })

  it('clone timeout → E_INSTALL_TIMEOUT', async () => {
    cloneMock.mockImplementation(materializeClone({ 'SKILL.md': '# x\n' }, 200))
    const built = await buildInput(
      [singlePack({ ref: 'github:owner/slow' })],
      { timeouts: { ...baseTimeouts, installSeconds: 0.05 } },
    )
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_INSTALL_TIMEOUT')
  })

  it('clone failure → E_INSTALL_FAILED', async () => {
    cloneMock.mockImplementation(failingClone('fatal: not found'))
    const built = await buildInput([singlePack({ ref: 'github:owner/missing' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_INSTALL_FAILED')
  })

  it('clone failure with credentials in the URL → error leaks neither the token nor the userinfo', async () => {
    const url = 'https://user:sk-fake-token@example.invalid/repo.git'
    cloneMock.mockImplementation(
      failingClone(`fatal: unable to access '${url}/': The requested URL returned error: 403`),
    )
    const built = await buildInput([singlePack({ ref: url })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_INSTALL_FAILED')
    expect(err.message).not.toContain('sk-fake-token')
    expect(err.message).not.toContain('user:')
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain('sk-fake-token')
    expect(contextStr).not.toContain('user:')
  })

  it('skill without SKILL.md → E_PACK_INVALID_REF', async () => {
    cloneMock.mockImplementation(materializeClone({ 'README.md': 'no skill' }))
    const built = await buildInput([singlePack({ ref: 'github:owner/noskillmd' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('skill without SKILL.md, cloned from a URL with credentials → error leaks neither the token nor the userinfo', async () => {
    const url = 'https://user:sk-fake-token@example.invalid/repo.git'
    cloneMock.mockImplementation(materializeClone({ 'README.md': 'no skill' }))
    const built = await buildInput([singlePack({ ref: url })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(err.message).not.toContain('sk-fake-token')
    expect(err.message).not.toContain('user:')
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain('sk-fake-token')
    expect(contextStr).not.toContain('user:')
  })

  it('skill: lowercase skill.md at root → mirrored to uppercase SKILL.md', async () => {
    cloneMock.mockImplementation(materializeClone({ 'skill.md': '# lower\n' }))
    const built = await buildInput([singlePack({ ref: 'github:owner/lower' })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('skill')
    const expected = path.join(built.packDir, 'demo', 'lower')
    expect(d.packPath).toBe(expected)
    expect(await runP(exists(path.join(expected, 'SKILL.md')))).toBe(true)
    expect(await runP(readFile(path.join(expected, 'SKILL.md')))).toBe('# lower\n')
    expect(d.instructions).toEqual([{ kind: 'skill', name: 'lower', target: expected }])
  })

  it('skill: SKILL.md nested in subdir named after pack → skill instruction targets subdir', async () => {
    cloneMock.mockImplementation(
      materializeClone({ 'graphify/SKILL.md': '# nested\n', 'README.md': 'r' }),
    )
    const built = await buildInput([singlePack({ ref: 'github:owner/graphify' })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('skill')
    const nested = path.join(built.packDir, 'demo', 'graphify', 'graphify')
    expect(d.packPath).toBe(nested)
    expect(await runP(exists(path.join(nested, 'SKILL.md')))).toBe(true)
    expect(d.instructions).toEqual([{ kind: 'skill', name: 'graphify', target: nested }])
  })

  it('skill: lowercase skill.md nested in subdir → mirrored + skill instruction targets subdir', async () => {
    cloneMock.mockImplementation(materializeClone({ 'graphify/skill.md': '# lower nested\n' }))
    const built = await buildInput([singlePack({ ref: 'github:owner/gfnested' })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('skill')
    const nested = path.join(built.packDir, 'demo', 'gfnested', 'graphify')
    expect(d.packPath).toBe(nested)
    expect(await runP(exists(path.join(nested, 'SKILL.md')))).toBe(true)
    expect(await runP(readFile(path.join(nested, 'SKILL.md')))).toBe('# lower nested\n')
    expect(d.instructions[0]!.kind).toBe('skill')
    if (d.instructions[0]!.kind === 'skill') {
      expect(d.instructions[0]!.target).toBe(nested)
    }
  })

  it('invalid packRef format → E_PACK_INVALID_REF', async () => {
    const built = await buildInput([singlePack({ ref: 'foo bar baz garbage' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('local path missing → E_PACK_INVALID_REF', async () => {
    const built = await buildInput([singlePack({ ref: '/definitely/not/here/xyz' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('pack ref whose name resolves to ".." → E_PACK_INVALID_REF, workspace untouched', async () => {
    const built = await buildInput([singlePack({ ref: '../..' })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(await runP(exists(built.root))).toBe(true)
    expect(await runP(exists(built.packDir))).toBe(true)
    expect(await runP(exists(built.resultsDir))).toBe(true)
  })

  it('result exposes installLogPath inside workspace.results', async () => {
    const built = await buildInput([singlePack({ ref: 'npm:plug' })])
    const result = await runP(packInstall(built.input))
    expect(result.installLogPath).toBe(path.join(built.resultsDir, 'install.log'))
  })

  it('agent (git): clones repo and finds <name>.md inside', async () => {
    cloneMock.mockImplementation(materializeClone({ 'myagent.md': '# agent from git\n' }))
    const built = await buildInput([
      singlePack({ ref: 'agent:https://github.com/foo/myagent.git' }),
    ])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('agent')
    expect(d.registeredIn).toEqual(['agents'])
    expect(d.packPath).toBe(path.join(built.packDir, 'demo', 'myagent'))
    expect(d.instructions[0]!.kind).toBe('file')
    if (d.instructions[0]!.kind === 'file') {
      expect(d.instructions[0]!.target).toBe(path.join(built.packDir, 'demo', 'myagent', 'myagent.md'))
    }
  })

  it('agent (local dir): copies dir and finds <name>.md inside', async () => {
    const parent = makeTempDir()
    const src = path.join(parent, 'packagent')
    await runP(ensureDir(src))
    await runP(writeFile(path.join(src, 'packagent.md'), '# dir agent\n'))
    const built = await buildInput([singlePack({ ref: `agent:${src}` })])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.detectedType).toBe('agent')
    expect(d.instructions[0]!.kind).toBe('file')
    if (d.instructions[0]!.kind === 'file') {
      expect(d.instructions[0]!.name).toBe('packagent')
      expect(await runP(exists(d.instructions[0]!.target))).toBe(true)
    }
  })

  it('agent local dir without <name>.md → E_PACK_INVALID_REF', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    await runP(writeFile(path.join(src, 'other.md'), '# other\n'))
    const built = await buildInput([singlePack({ ref: `agent:${src}` })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('all with plugins/ subdir → plugins section + plugin instruction with target', async () => {
    cloneMock.mockImplementation(
      materializeClone({
        'skills/cool/SKILL.md': '# cool\n',
        'plugins/myplugin.js': 'module.exports={}',
      }),
    )
    const built = await buildInput([
      singlePack({ ref: 'github:owner/megapack', type: 'all' }),
    ])
    const result = await runP(packInstall(built.input))
    const d = result.deliveries[0]!
    expect(d.registeredIn).toContain('plugins')
    const pluginInst = d.instructions.find((i) => i.kind === 'plugin')
    expect(pluginInst).toBeDefined()
    if (pluginInst?.kind === 'plugin') {
      expect(pluginInst.name).toBe('myplugin')
      expect(pluginInst.target).toBe(
        path.join(built.packDir, 'demo', 'megapack', 'plugins', 'myplugin.js'),
      )
      expect(await runP(exists(pluginInst.target!))).toBe(true)
    }
  })

  it('all: plugins/ subdir ignores non-plugin files (README.md, .DS_Store, no-extension)', async () => {
    cloneMock.mockImplementation(
      materializeClone({
        'plugins/myplugin.js': 'module.exports={}',
        'plugins/README.md': '# plugins\n',
        'plugins/.DS_Store': '',
        'plugins/notes': 'no extension',
      }),
    )
    const built = await buildInput([
      singlePack({ ref: 'github:owner/pluginjunk', type: 'all' }),
    ])
    const result = await runP(packInstall(built.input))
    const pluginNames = result.deliveries[0]!.instructions
      .filter((i) => i.kind === 'plugin')
      .map((i) => i.name)
    expect(pluginNames).toEqual(['myplugin'])
  })

  it('skill local pointing at a file (not a dir) → E_PACK_INVALID_REF', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    const file = path.join(src, 'notadir.txt')
    await runP(writeFile(file, 'x'))
    const built = await buildInput([singlePack({ ref: file })])
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })
})
