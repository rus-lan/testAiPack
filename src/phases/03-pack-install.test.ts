import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile, readFile, exists } from '../util/fs.js'
import { GitError } from '../util/git.js'
import { packInstall } from './03-pack-install.js'
import type { PackInstallInput, RunInput, Manifest, WorkspaceTree } from '@generated/types'

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
    opencode: false,
    npmrc: false,
    anthropic: false,
    openai: false,
    gemini: false,
    aws: false,
    ssh: false,
    git: false,
  },
  pureBaseline: false,
  protectGit: false,
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

interface BuiltInput {
  readonly input: PackInstallInput
  readonly root: string
  readonly packDir: string
  readonly resultsDir: string
}

const buildInput = async (runInputOverrides: Partial<RunInput>): Promise<BuiltInput> => {
  const root = makeTempDir()
  const packDir = path.join(root, 'pack')
  const resultsDir = path.join(root, 'results')
  await runP(ensureDir(packDir))
  await runP(ensureDir(resultsDir))
  const workspace: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'src'),
    appsOld: [],
    appsNew: [],
    pack: packDir,
    homeOld: [],
    homeNew: [],
    gitDirsOld: [],
    gitDirsNew: [],
    config: path.join(root, 'config'),
    results: resultsDir,
    raw: path.join(root, 'raw'),
    diff: path.join(root, 'diff'),
  }
  const manifest: Manifest = {
    runId: 'rid',
    timestamp: new Date().toISOString(),
    repoUrl: 'https://example.com/repo.git',
    prompt: 'do thing',
    runs: 1,
    isolation: 'home',
    opencodeVersion: '1.0.0',
    flagDefaults: {},
  }
  return {
    input: {
      runInput: makeRunInput(runInputOverrides),
      manifest,
      workspace,
    },
    root,
    packDir,
    resultsDir,
  }
}

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

  it('smoke-test: no packRef → detectedType null, registeredIn [], not an error', async () => {
    const built = await buildInput({})
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBeNull()
    expect(result.packPath).toBe('')
    expect(result.registeredIn).toEqual([])
    expect(result.instructions).toEqual([])
    const log = await runP(readFile(result.installLogPath))
    expect(log).toContain('smoke-test')
  })

  it('skill (git): detect → clone → SKILL.md present → symlink instruction', async () => {
    cloneMock.mockImplementation(
      materializeClone({ 'SKILL.md': '# skill\n', 'README.md': 'r' }),
    )
    const built = await buildInput({ packRef: 'github:owner/myskill' })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('skill')
    expect(result.registeredIn).toEqual(['skills'])
    const expected = path.join(built.packDir, 'myskill')
    expect(result.packPath).toBe(expected)
    expect(await runP(exists(path.join(expected, 'SKILL.md')))).toBe(true)
    expect(result.instructions).toEqual([
      { kind: 'symlink', name: 'myskill', target: expected },
    ])
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
    const built = await buildInput({ packRef: src })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('skill')
    expect(result.registeredIn).toEqual(['skills'])
    const expected = path.join(built.packDir, path.basename(src))
    expect(result.packPath).toBe(expected)
    expect(await runP(exists(path.join(expected, 'SKILL.md')))).toBe(true)
    expect(result.instructions[0]!.kind).toBe('symlink')
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('plugin (npm): no clone, plugin instruction, registeredIn=["plugins"]', async () => {
    const built = await buildInput({ packRef: 'npm:myplugin' })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('plugin')
    expect(result.packPath).toBe('')
    expect(result.registeredIn).toEqual(['plugins'])
    expect(result.instructions).toEqual([{ kind: 'plugin', name: 'myplugin' }])
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('agent (local .md): file instruction section="agents"', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    const md = path.join(src, 'build.md')
    await runP(writeFile(md, '# agent\n'))
    const built = await buildInput({ packRef: `agent:${md}` })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('agent')
    expect(result.registeredIn).toEqual(['agents'])
    expect(result.packPath).toBe(path.join(built.packDir, 'build.md'))
    expect(result.instructions[0]!.kind).toBe('file')
    if (result.instructions[0]!.kind === 'file') {
      expect(result.instructions[0]!.section).toBe('agents')
      expect(result.instructions[0]!.name).toBe('build')
      expect(await runP(exists(result.instructions[0]!.target))).toBe(true)
    }
  })

  it('command (local .md): file instruction section="commands"', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    const md = path.join(src, 'run.md')
    await runP(writeFile(md, '# command\n'))
    const built = await buildInput({ packRef: `command:${md}` })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('command')
    expect(result.registeredIn).toEqual(['commands'])
    expect(result.instructions[0]!.kind).toBe('file')
    if (result.instructions[0]!.kind === 'file') {
      expect(result.instructions[0]!.section).toBe('commands')
      expect(result.instructions[0]!.name).toBe('run')
    }
  })

  it('mcp (inline json): config instruction with parsed json, registeredIn=["mcp"]', async () => {
    const built = await buildInput({
      packRef: 'mcp:myserver:{"command":"npx","args":["-y","myserver"]}',
    })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('mcp')
    expect(result.registeredIn).toEqual(['mcp'])
    expect(result.packPath).toBe(path.join(built.packDir, 'myserver'))
    expect(result.instructions).toHaveLength(1)
    expect(result.instructions[0]!.kind).toBe('config')
    if (result.instructions[0]!.kind === 'config') {
      expect(result.instructions[0]!.section).toBe('mcp')
      expect(result.instructions[0]!.name).toBe('myserver')
      expect(result.instructions[0]!.json).toEqual({ command: 'npx', args: ['-y', 'myserver'] })
    }
    expect(await runP(exists(path.join(built.packDir, 'myserver', 'mcp.json')))).toBe(true)
    expect(cloneMock).not.toHaveBeenCalled()
  })

  it('mcp (@file): reads config file, parses json', async () => {
    const cfgSrc = makeTempDir()
    await runP(ensureDir(cfgSrc))
    const cfgPath = path.join(cfgSrc, 'mcp.json')
    await runP(writeFile(cfgPath, '{"command":"node","args":["srv.js"]}'))
    const built = await buildInput({ packRef: `mcp:filesrv:@${cfgPath}` })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('mcp')
    expect(result.registeredIn).toEqual(['mcp'])
    if (result.instructions[0]!.kind === 'config') {
      expect(result.instructions[0]!.name).toBe('filesrv')
      expect(result.instructions[0]!.json).toEqual({ command: 'node', args: ['srv.js'] })
    }
  })

  it('mcp (@file missing) → E_PACK_INVALID_REF', async () => {
    const built = await buildInput({ packRef: 'mcp:myserver:@/nope/missing.json' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('mcp (invalid json) → E_PACK_INVALID_REF', async () => {
    const built = await buildInput({ packRef: 'mcp:myserver:{not json}' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('mcp ref with an unsafe name and an inline secret → detectPack failure leaks neither the secret nor the JSON body', async () => {
    const secret = 'sk-fake-secret'
    const built = await buildInput({ packRef: `mcp:../evil:{"env":{"KEY":"${secret}"}}` })
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
    const built = await buildInput({
      packRef: `mcp:myserver:{"command":"npx","env":{"API_KEY":"${secret}"} not json}`,
    })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(err.message).not.toContain(secret)
    expect(err.message).not.toContain('API_KEY')
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain(secret)
    expect(contextStr).not.toContain('API_KEY')
  })

  it('mcp (invalid json starting with a secret, no JSON structure at all) → still leaks nothing', async () => {
    // JSON.parse itself quotes a snippet of the input when the bad token is
    // at position 0 (no valid JSON recognized yet) — this must not leak either.
    const secret = 'sk-test-FAKESECRET-startofstring'
    const built = await buildInput({ packRef: `mcp:myserver:${secret}-not-json-at-all` })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(err.message).not.toContain(secret)
    const contextStr = JSON.stringify(err.context ?? {})
    expect(contextStr).not.toContain(secret)
  })

  it('mcp (no config, no standard file) → E_PACK_INVALID_REF', async () => {
    const built = await buildInput({ packRef: 'mcp:myserver' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('mcp (no config in ref, standard mcp.json present) → reads it', async () => {
    const built = await buildInput({ packRef: 'mcp:std' })
    const packDir = path.join(built.packDir, 'std')
    await runP(ensureDir(packDir))
    await runP(writeFile(path.join(packDir, 'mcp.json'), '{"command":"x"}'))
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('mcp')
    if (result.instructions[0]!.kind === 'config') {
      expect(result.instructions[0]!.json).toEqual({ command: 'x' })
    }
  })

  it('all: repo with skills/ + commands/ → multiple sections + mixed instructions', async () => {
    cloneMock.mockImplementation(
      materializeClone({
        'skills/cool/SKILL.md': '# cool\n',
        'commands/deploy.md': '# deploy\n',
      }),
    )
    const built = await buildInput({
      packRef: 'github:owner/megapack',
      packType: 'all',
    })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('all')
    expect(result.registeredIn).toContain('skills')
    expect(result.registeredIn).toContain('commands')
    const kinds = result.instructions.map((i) => i.kind)
    expect(kinds).toContain('symlink')
    expect(kinds).toContain('file')
    const symlinkInst = result.instructions.find((i) => i.kind === 'symlink')
    expect(symlinkInst).toBeDefined()
    if (symlinkInst?.kind === 'symlink') {
      expect(symlinkInst.name).toBe('cool')
    }
  })

  it('all with no standard subdirs → empty registeredIn (warning, not error)', async () => {
    cloneMock.mockImplementation(materializeClone({ 'README.md': 'r' }))
    const built = await buildInput({
      packRef: 'github:owner/empty',
      packType: 'all',
    })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('all')
    expect(result.registeredIn).toEqual([])
  })

  it('pack-type override forces a type without re-detecting', async () => {
    cloneMock.mockImplementation(materializeClone({ 'SKILL.md': '# x\n' }))
    const built = await buildInput({
      packRef: 'github:owner/repo',
      packType: 'skill',
    })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('skill')
    expect(result.registeredIn).toEqual(['skills'])
  })

  it('clone timeout → E_INSTALL_TIMEOUT', async () => {
    cloneMock.mockImplementation(materializeClone({ 'SKILL.md': '# x\n' }, 200))
    const built = await buildInput({
      packRef: 'github:owner/slow',
      timeouts: { ...baseTimeouts, installSeconds: 0.05 },
    })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_INSTALL_TIMEOUT')
  })

  it('clone failure → E_INSTALL_FAILED', async () => {
    cloneMock.mockImplementation(failingClone('fatal: not found'))
    const built = await buildInput({ packRef: 'github:owner/missing' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_INSTALL_FAILED')
  })

  it('clone failure with credentials in the URL → error leaks neither the token nor the userinfo', async () => {
    const url = 'https://user:sk-fake-token@example.invalid/repo.git'
    cloneMock.mockImplementation(
      failingClone(`fatal: unable to access '${url}/': The requested URL returned error: 403`),
    )
    const built = await buildInput({ packRef: url })
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
    const built = await buildInput({ packRef: 'github:owner/noskillmd' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('skill without SKILL.md, cloned from a URL with credentials → error leaks neither the token nor the userinfo', async () => {
    const url = 'https://user:sk-fake-token@example.invalid/repo.git'
    cloneMock.mockImplementation(materializeClone({ 'README.md': 'no skill' }))
    const built = await buildInput({ packRef: url })
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
    const built = await buildInput({ packRef: 'github:owner/lower' })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('skill')
    const expected = path.join(built.packDir, 'lower')
    expect(result.packPath).toBe(expected)
    expect(await runP(exists(path.join(expected, 'SKILL.md')))).toBe(true)
    expect(await runP(readFile(path.join(expected, 'SKILL.md')))).toBe('# lower\n')
    expect(result.instructions).toEqual([
      { kind: 'symlink', name: 'lower', target: expected },
    ])
  })

  it('skill: SKILL.md nested in subdir named after pack → symlink targets subdir', async () => {
    cloneMock.mockImplementation(
      materializeClone({ 'graphify/SKILL.md': '# nested\n', 'README.md': 'r' }),
    )
    const built = await buildInput({ packRef: 'github:owner/graphify' })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('skill')
    const nested = path.join(built.packDir, 'graphify', 'graphify')
    expect(result.packPath).toBe(nested)
    expect(await runP(exists(path.join(nested, 'SKILL.md')))).toBe(true)
    expect(result.instructions).toEqual([
      { kind: 'symlink', name: 'graphify', target: nested },
    ])
  })

  it('skill: lowercase skill.md nested in subdir → mirrored + symlink targets subdir', async () => {
    cloneMock.mockImplementation(
      materializeClone({ 'graphify/skill.md': '# lower nested\n' }),
    )
    const built = await buildInput({ packRef: 'github:owner/gfnested' })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('skill')
    const nested = path.join(built.packDir, 'gfnested', 'graphify')
    expect(result.packPath).toBe(nested)
    expect(await runP(exists(path.join(nested, 'SKILL.md')))).toBe(true)
    expect(await runP(readFile(path.join(nested, 'SKILL.md')))).toBe('# lower nested\n')
    expect(result.instructions[0]!.kind).toBe('symlink')
    if (result.instructions[0]!.kind === 'symlink') {
      expect(result.instructions[0]!.target).toBe(nested)
    }
  })

  it('invalid packRef format → E_PACK_INVALID_REF', async () => {
    const built = await buildInput({ packRef: 'foo bar baz garbage' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('local path missing → E_PACK_INVALID_REF', async () => {
    const built = await buildInput({ packRef: '/definitely/not/here/xyz' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })

  it('pack ref whose name resolves to ".." → E_PACK_INVALID_REF, workspace untouched', async () => {
    const built = await buildInput({ packRef: '../..' })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
    expect(await runP(exists(built.root))).toBe(true)
    expect(await runP(exists(built.packDir))).toBe(true)
    expect(await runP(exists(built.resultsDir))).toBe(true)
  })

  it('result exposes installLogPath inside workspace.results', async () => {
    const built = await buildInput({ packRef: 'npm:plug' })
    const result = await runP(packInstall(built.input))
    expect(result.installLogPath).toBe(path.join(built.resultsDir, 'install.log'))
  })

  it('agent (git): clones repo and finds <name>.md inside', async () => {
    cloneMock.mockImplementation(
      materializeClone({ 'myagent.md': '# agent from git\n' }),
    )
    const built = await buildInput({ packRef: 'agent:https://github.com/foo/myagent.git' })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('agent')
    expect(result.registeredIn).toEqual(['agents'])
    expect(result.packPath).toBe(path.join(built.packDir, 'myagent'))
    expect(result.instructions[0]!.kind).toBe('file')
    if (result.instructions[0]!.kind === 'file') {
      expect(result.instructions[0]!.target).toBe(path.join(built.packDir, 'myagent', 'myagent.md'))
    }
  })

  it('agent (local dir): copies dir and finds <name>.md inside', async () => {
    const parent = makeTempDir()
    const src = path.join(parent, 'packagent')
    await runP(ensureDir(src))
    await runP(writeFile(path.join(src, 'packagent.md'), '# dir agent\n'))
    const built = await buildInput({ packRef: `agent:${src}` })
    const result = await runP(packInstall(built.input))
    expect(result.detectedType).toBe('agent')
    expect(result.instructions[0]!.kind).toBe('file')
    if (result.instructions[0]!.kind === 'file') {
      expect(result.instructions[0]!.name).toBe('packagent')
      expect(await runP(exists(result.instructions[0]!.target))).toBe(true)
    }
  })

  it('agent local dir without <name>.md → E_PACK_INVALID_REF', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    await runP(writeFile(path.join(src, 'other.md'), '# other\n'))
    const built = await buildInput({ packRef: `agent:${src}` })
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
    const built = await buildInput({ packRef: 'github:owner/megapack', packType: 'all' })
    const result = await runP(packInstall(built.input))
    expect(result.registeredIn).toContain('plugins')
    const pluginInst = result.instructions.find((i) => i.kind === 'plugin')
    expect(pluginInst).toBeDefined()
    if (pluginInst?.kind === 'plugin') {
      expect(pluginInst.name).toBe('myplugin')
      expect(pluginInst.target).toBe(
        path.join(built.packDir, 'megapack', 'plugins', 'myplugin.js'),
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
    const built = await buildInput({ packRef: 'github:owner/pluginjunk', packType: 'all' })
    const result = await runP(packInstall(built.input))
    const pluginNames = result.instructions.filter((i) => i.kind === 'plugin').map((i) => i.name)
    expect(pluginNames).toEqual(['myplugin'])
  })

  it('skill local pointing at a file (not a dir) → E_PACK_INVALID_REF', async () => {
    const src = makeTempDir()
    await runP(ensureDir(src))
    const file = path.join(src, 'notadir.txt')
    await runP(writeFile(file, 'x'))
    const built = await buildInput({ packRef: file })
    const err = await runFlip(packInstall(built.input))
    expect(err.code).toBe('E_PACK_INVALID_REF')
  })
})
