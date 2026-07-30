import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, exists, readFile, symlink, writeFile } from '../util/fs.js'
import { captureOpencodeConfig } from './06-config-capture.js'
import type { InstalledJson, UsageJson } from './06-config-capture.js'
import type { VariantConfig, WorkspaceTree } from '@generated/types'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

interface Built {
  readonly workspace: WorkspaceTree
  readonly homeOld: readonly string[]
  readonly homeNew: readonly string[]
}

const buildWorkspace = async (runs: number): Promise<Built> => {
  const root = makeTempDir('config-capture-')
  const homeOld: string[] = []
  const homeNew: string[] = []
  for (let i = 1; i <= runs; i++) {
    const oldDir = path.join(root, 'home', 'old', `run-${String(i)}`)
    const newDir = path.join(root, 'home', 'new', `run-${String(i)}`)
    homeOld.push(oldDir)
    homeNew.push(newDir)
    await runP(ensureDir(path.join(oldDir, '.config/opencode')))
    await runP(ensureDir(path.join(newDir, '.config/opencode')))
  }
  const configDir = path.join(root, 'config')
  const rawDir = path.join(root, 'results', 'raw')
  await runP(ensureDir(path.join(rawDir, 'old')))
  await runP(ensureDir(path.join(rawDir, 'new')))
  await runP(ensureDir(configDir))
  const workspace: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'apps', 'source'),
    pack: path.join(root, 'pack'),
    variantTrees: [
      { name: 'old', apps: [], homes: homeOld, gitDirs: [] },
      { name: 'new', apps: [], homes: homeNew, gitDirs: [] },
    ],
    config: configDir,
    results: path.join(root, 'results'),
    raw: rawDir,
    diff: path.join(root, 'results', 'diff'),
  }
  return { workspace, homeOld, homeNew }
}

const GENERATED: readonly VariantConfig[] = [
  { name: 'old', config: JSON.stringify({ $schema: 'https://opencode.ai/config.json', agent: { build: {} } }, null, 2) },
  {
    name: 'new',
    config: JSON.stringify(
      { $schema: 'https://opencode.ai/config.json', agent: { build: {} }, mcp: { srv1: { command: 'a' } } },
      null,
      2,
    ),
  },
]

/** GENERATED with the 'new' entry's config text swapped out — for secret-redaction fixtures. */
const generatedWithNewConfig = (newConfig: string): readonly VariantConfig[] => [
  GENERATED[0]!,
  { name: 'new', config: newConfig },
]

const readInstalled = async (variant: string, root: string): Promise<InstalledJson> => {
  const raw = await runP(readFile(path.join(root, 'config/.config/opencode', variant, 'installed.json')))
  return JSON.parse(raw) as InstalledJson
}

const readUsage = async (variant: string, root: string): Promise<UsageJson> => {
  const raw = await runP(readFile(path.join(root, 'config/.config/opencode', variant, 'usage.json')))
  return JSON.parse(raw) as UsageJson
}

describe('phase 06 (sibling) — captureOpencodeConfig', () => {
  it('happy path: both variant dirs, opencode.json byte-equals generatedConfigs[name], home/ copies, installed.json fields', async () => {
    const { workspace, homeOld, homeNew } = await buildWorkspace(1)
    const oldCfg = path.join(homeOld[0]!, '.config/opencode')
    const newCfg = path.join(homeNew[0]!, '.config/opencode')

    await runP(writeFile(path.join(oldCfg, 'opencode.jsonc'), '{"$schema":"https://opencode.ai/config.json"}'))
    await runP(writeFile(path.join(newCfg, 'opencode.jsonc'), '{"$schema":"https://opencode.ai/config.json"}'))
    await runP(ensureDir(path.join(newCfg, 'agents')))
    await runP(writeFile(path.join(newCfg, 'agents/build.md'), '# build agent\n'))
    await runP(writeFile(path.join(newCfg, 'package.json'), '{"dependencies":{"@opencode-ai/plugin":"1.18.4"}}'))
    await runP(writeFile(path.join(newCfg, 'package-lock.json'), '{"lockfileVersion":3}'))
    const skillTarget = makeTempDir('config-capture-skill-src-')
    await runP(ensureDir(skillTarget))
    await runP(writeFile(path.join(skillTarget, 'SKILL.md'), '# graphify\n'))
    await runP(ensureDir(path.join(newCfg, 'skills')))
    await runP(symlink(skillTarget, path.join(newCfg, 'skills/graphify')))

    const result = await runP(
      captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }),
    )
    expect(result.capturedDirs).toHaveLength(2)

    const oldOpencodeJson = await runP(
      readFile(path.join(workspace.config, '.config/opencode/old/opencode.json')),
    )
    expect(oldOpencodeJson).toBe(`${GENERATED[0]!.config}\n`)
    const newOpencodeJson = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/opencode.json')),
    )
    expect(newOpencodeJson).toBe(`${GENERATED[1]!.config}\n`)

    const copiedJsonc = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/home/opencode.jsonc')),
    )
    expect(copiedJsonc).toBe(await runP(readFile(path.join(newCfg, 'opencode.jsonc'))))
    const copiedPkg = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/home/package.json')),
    )
    expect(copiedPkg).toBe(await runP(readFile(path.join(newCfg, 'package.json'))))

    const installed = await readInstalled('new', workspace.root)
    expect(installed.variant).toBe('new')
    expect(installed.skills).toEqual([{ name: 'graphify', target: skillTarget }])
    expect(installed.agents).toEqual(['build'])
    expect(installed.npmDependencies).toEqual({ '@opencode-ai/plugin': '1.18.4' })
    expect(installed.identicalAcrossRuns).toBe(true)
    expect(installed.driftFiles).toEqual([])
    expect(installed.mcpServers).toEqual(['srv1'])
    expect(installed.configMergeOrder).toEqual(['home/opencode.jsonc', 'opencode.json'])

    const oldInstalled = await readInstalled('old', workspace.root)
    expect(oldInstalled.variant).toBe('old')
    expect(oldInstalled.skills).toEqual([])
    expect(oldInstalled.mcpServers).toEqual([])
  })

  it('usage parsing: tool_use/export-shape mix, one skill error call, unparseable line skipped', async () => {
    const { workspace } = await buildWorkspace(1)
    const eventsPath = path.join(workspace.raw, 'old', 'run-1.events.ndjson')
    const lines = [
      JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'bash', state: { status: 'completed' } },
      }),
      JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed' } }),
      JSON.stringify({
        type: 'tool_use',
        part: {
          type: 'tool',
          tool: 'skill',
          state: { status: 'error', input: { name: 'graphify' }, error: 'Skill "graphify" not found' },
        },
      }),
      'not valid json {',
    ]
    await runP(writeFile(eventsPath, `${lines.join('\n')}\n`))

    await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }))
    const usage = await readUsage('old', workspace.root)
    expect(usage.variant).toBe('old')
    expect(usage.toolCalls).toEqual({ bash: 1, read: 1, skill: 1 })
    expect(usage.skillCalls).toEqual([
      { run: 1, name: 'graphify', status: 'error', error: 'Skill "graphify" not found' },
    ])
    expect(usage.notKnowable).toContain('plugin hook execution')
    expect(usage.notKnowable).toContain('npm package usage')
  })

  it('drift: run-2 package.json differs from run-1 → identicalAcrossRuns false, driftFiles lists it; home/ still copies run-1', async () => {
    const { workspace, homeNew } = await buildWorkspace(2)
    const run1Cfg = path.join(homeNew[0]!, '.config/opencode')
    const run2Cfg = path.join(homeNew[1]!, '.config/opencode')
    await runP(writeFile(path.join(run1Cfg, 'package.json'), '{"dependencies":{"a":"1.0.0"}}'))
    await runP(writeFile(path.join(run2Cfg, 'package.json'), '{"dependencies":{"a":"2.0.0"}}'))
    await runP(writeFile(path.join(run1Cfg, 'package-lock.json'), '{"same":true}'))
    await runP(writeFile(path.join(run2Cfg, 'package-lock.json'), '{"same":true}'))

    await runP(captureOpencodeConfig({ workspace, runs: 2, generatedConfigs: GENERATED }))
    const installed = await readInstalled('new', workspace.root)
    expect(installed.identicalAcrossRuns).toBe(false)
    expect(installed.driftFiles).toEqual(['package.json'])
    const copiedPkg = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/home/package.json')),
    )
    expect(copiedPkg).toBe('{"dependencies":{"a":"1.0.0"}}')
  })

  it('sparse HOME (nothing under .config/opencode): capture succeeds, home/ empty, npmDependencies {}', async () => {
    const { workspace } = await buildWorkspace(1)
    const result = await runP(
      captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }),
    )
    expect(result.capturedDirs).toHaveLength(2)
    const installed = await readInstalled('new', workspace.root)
    expect(installed.npmDependencies).toEqual({})
    expect(installed.skills).toEqual([])
    expect(installed.agents).toEqual([])
    expect(installed.commands).toEqual([])
    expect(installed.configMergeOrder).toEqual(['opencode.json'])
    expect(await runP(exists(path.join(workspace.config, '.config/opencode/new/home/package.json')))).toBe(false)
  })

  it('missing events files: usage.json written with empty toolCalls/skillCalls', async () => {
    const { workspace } = await buildWorkspace(1)
    await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }))
    const usage = await readUsage('new', workspace.root)
    expect(usage.toolCalls).toEqual({})
    expect(usage.skillCalls).toEqual([])
  })

  it('on-disk opencode.json present (local-plugin shape): copied into home/, plugins.configSpecs and mcpServers populated', async () => {
    const { workspace, homeNew } = await buildWorkspace(1)
    const newCfg = path.join(homeNew[0]!, '.config/opencode')
    await runP(
      writeFile(
        path.join(newCfg, 'opencode.json'),
        `${JSON.stringify({ plugin: ['/abs/path/myplugin.js'] }, null, 2)}\n`,
      ),
    )
    await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }))
    const copied = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/home/opencode.json')),
    )
    expect(copied).toBe(await runP(readFile(path.join(newCfg, 'opencode.json'))))
    const installed = await readInstalled('new', workspace.root)
    expect(installed.plugins.configSpecs).toEqual(['/abs/path/myplugin.js'])
    expect(installed.mcpServers).toEqual(['srv1'])
    expect(installed.configMergeOrder).toEqual(['home/opencode.json', 'opencode.json'])
  })

  it('top-level opencode.json: redacts a provider apiKey and an mcp env secret, keeps the key names', async () => {
    const { workspace } = await buildWorkspace(1)
    const secretConfigs = generatedWithNewConfig(
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: { anthropic: { options: { apiKey: 'sk-ant-REAL-SECRET' } } },
          mcp: { srv1: { command: 'npx', env: { API_TOKEN: 'sk-mcp-REAL-SECRET' } } },
        },
        null,
        2,
      ),
    )
    await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: secretConfigs }))
    const captured = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/opencode.json')),
    )
    expect(captured).not.toContain('sk-ant-REAL-SECRET')
    expect(captured).not.toContain('sk-mcp-REAL-SECRET')
    const parsed = JSON.parse(captured) as {
      provider: { anthropic: { options: { apiKey: string } } }
      mcp: { srv1: { command: string; env: { API_TOKEN: string } } }
    }
    expect(parsed.provider.anthropic.options.apiKey).toBe('[REDACTED]')
    expect(parsed.mcp.srv1.env.API_TOKEN).toBe('[REDACTED]')
    expect(parsed.mcp.srv1.command).toBe('npx')
  })

  it('home/opencode.json: redacts an mcp env secret in the captured copy, original on-disk file stays real', async () => {
    const { workspace, homeNew } = await buildWorkspace(1)
    const newCfg = path.join(homeNew[0]!, '.config/opencode')
    const onDisk = {
      mcp: { srv1: { command: 'npx', env: { API_TOKEN: 'sk-mcp-REAL-SECRET' } } },
    }
    await runP(writeFile(path.join(newCfg, 'opencode.json'), `${JSON.stringify(onDisk, null, 2)}\n`))

    await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }))

    const captured = await runP(
      readFile(path.join(workspace.config, '.config/opencode/new/home/opencode.json')),
    )
    expect(captured).not.toContain('sk-mcp-REAL-SECRET')
    const parsed = JSON.parse(captured) as { mcp: { srv1: { env: { API_TOKEN: string } } } }
    expect(parsed.mcp.srv1.env.API_TOKEN).toBe('[REDACTED]')

    // the original file opencode itself reads every run is untouched
    const original = await runP(readFile(path.join(newCfg, 'opencode.json')))
    expect(original).toContain('sk-mcp-REAL-SECRET')
  })

  it('drift honesty: a single run reports runsCompared 0 — identicalAcrossRuns is not a verified claim', async () => {
    const { workspace } = await buildWorkspace(1)
    await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: GENERATED }))
    const installed = await readInstalled('new', workspace.root)
    expect(installed.runsCompared).toBe(0)
    expect(installed.identicalAcrossRuns).toBe(true)
  })

  it('drift honesty: an agent present only in run-2 is caught, even though the 4 tracked files are identical', async () => {
    const { workspace, homeNew } = await buildWorkspace(2)
    const run1Cfg = path.join(homeNew[0]!, '.config/opencode')
    const run2Cfg = path.join(homeNew[1]!, '.config/opencode')
    await runP(ensureDir(path.join(run1Cfg, 'agents')))
    await runP(ensureDir(path.join(run2Cfg, 'agents')))
    await runP(writeFile(path.join(run1Cfg, 'agents/build.md'), '# build\n'))
    await runP(writeFile(path.join(run2Cfg, 'agents/build.md'), '# build\n'))
    await runP(writeFile(path.join(run2Cfg, 'agents/extra.md'), '# extra\n'))

    await runP(captureOpencodeConfig({ workspace, runs: 2, generatedConfigs: GENERATED }))
    const installed = await readInstalled('new', workspace.root)
    expect(installed.runsCompared).toBe(1)
    expect(installed.identicalAcrossRuns).toBe(false)
    expect(installed.driftFiles).toContain('agents')
    // installed.json itself still only lists run-1's agents
    expect(installed.agents).toEqual(['build'])
  })

  it('drift honesty: a skill present only in run-2 is caught', async () => {
    const { workspace, homeNew } = await buildWorkspace(2)
    const run1Cfg = path.join(homeNew[0]!, '.config/opencode')
    const run2Cfg = path.join(homeNew[1]!, '.config/opencode')
    const target = makeTempDir('config-capture-skill-src-')
    await runP(ensureDir(target))
    await runP(ensureDir(path.join(run1Cfg, 'skills')))
    await runP(ensureDir(path.join(run2Cfg, 'skills')))
    await runP(symlink(target, path.join(run1Cfg, 'skills/graphify')))
    await runP(symlink(target, path.join(run2Cfg, 'skills/graphify')))
    await runP(symlink(target, path.join(run2Cfg, 'skills/extra')))

    await runP(captureOpencodeConfig({ workspace, runs: 2, generatedConfigs: GENERATED }))
    const installed = await readInstalled('new', workspace.root)
    expect(installed.identicalAcrossRuns).toBe(false)
    expect(installed.driftFiles).toContain('skills')
  })

  it('generatedConfigs missing an entry for a variant (phase 04/06 mismatch) → fails loud with E_HOME_SETUP_FAILED instead of fabricating an empty config', async () => {
    const { workspace } = await buildWorkspace(1)
    const incompleteConfigs: readonly VariantConfig[] = [GENERATED[0]!] // no entry for 'new'
    const err = await runFlip(
      captureOpencodeConfig({ workspace, runs: 1, generatedConfigs: incompleteConfigs }),
    )
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
    // no capture dir was written for the mismatched variant
    expect(await runP(exists(path.join(workspace.config, '.config/opencode/new/opencode.json')))).toBe(false)
  })

  it('N-way: three variants each capture into their own config/.config/opencode/<name>/ dir', async () => {
    const root = makeTempDir('config-capture-nway-')
    const homes: Record<string, string> = {}
    for (const name of ['base', 'graphify', 'astgrep']) {
      const homeDir = path.join(root, 'home', name, 'run-1')
      homes[name] = homeDir
      await runP(ensureDir(path.join(homeDir, '.config/opencode')))
      await runP(ensureDir(path.join(root, 'results', 'raw', name)))
    }
    await runP(ensureDir(path.join(root, 'config')))
    const workspace: WorkspaceTree = {
      root,
      appsSource: path.join(root, 'apps', 'source'),
      pack: path.join(root, 'pack'),
      variantTrees: [
        { name: 'base', apps: [], homes: [homes['base']!], gitDirs: [] },
        { name: 'graphify', apps: [], homes: [homes['graphify']!], gitDirs: [] },
        { name: 'astgrep', apps: [], homes: [homes['astgrep']!], gitDirs: [] },
      ],
      config: path.join(root, 'config'),
      results: path.join(root, 'results'),
      raw: path.join(root, 'results', 'raw'),
      diff: path.join(root, 'results', 'diff'),
    }
    const generatedConfigs: readonly VariantConfig[] = [
      { name: 'base', config: '{}' },
      { name: 'graphify', config: '{"mcp":{"g":{}}}' },
      { name: 'astgrep', config: '{"mcp":{"a":{}}}' },
    ]
    const result = await runP(captureOpencodeConfig({ workspace, runs: 1, generatedConfigs }))
    expect(result.capturedDirs).toHaveLength(3)
    const base = await readInstalled('base', root)
    const graphify = await readInstalled('graphify', root)
    const astgrep = await readInstalled('astgrep', root)
    expect(base.variant).toBe('base')
    expect(graphify.variant).toBe('graphify')
    expect(astgrep.variant).toBe('astgrep')
    expect(graphify.mcpServers).toEqual(['g'])
    expect(astgrep.mcpServers).toEqual(['a'])
  })

  it('unwritable config target (config path is a file) → PhaseError with E_HOME_SETUP_FAILED', async () => {
    const { workspace } = await buildWorkspace(1)
    const fileAsConfig = path.join(workspace.root, 'config-is-a-file')
    await runP(writeFile(fileAsConfig, 'not a directory'))
    const brokenWorkspace: WorkspaceTree = { ...workspace, config: fileAsConfig }
    const err = await runFlip(
      captureOpencodeConfig({ workspace: brokenWorkspace, runs: 1, generatedConfigs: GENERATED }),
    )
    expect(err.code).toBe('E_HOME_SETUP_FAILED')
  })
})
