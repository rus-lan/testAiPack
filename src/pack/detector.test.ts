import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir } from '../util/fs.js'
import { detectPack, PackDetectError, type PackRef } from './detector.js'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

describe('detectPack', () => {
  it('npm:<name> → Plugin/npm', async () => {
    const r = await run(detectPack('npm:lodash'))
    expect(r).toMatchObject({ type: 'plugin', source: 'npm', name: 'lodash' })
    expect(r.raw).toBe('npm:lodash')
  })

  it('bare single word → Plugin/npm', async () => {
    const r = await run(detectPack('lodash'))
    expect(r).toMatchObject({ type: 'plugin', source: 'npm', name: 'lodash' })
  })

  it('https://….git → Skill/git with url + name', async () => {
    const r = await run(detectPack('https://github.com/foo/bar.git'))
    expect(r).toMatchObject({
      type: 'skill',
      source: 'git',
      name: 'bar',
      url: 'https://github.com/foo/bar.git',
    })
  })

  it('github:owner/repo → Skill/git, url normalized to .git', async () => {
    const r = await run(detectPack('github:foo/bar'))
    expect(r).toMatchObject({
      type: 'skill',
      source: 'git',
      name: 'bar',
      url: 'https://github.com/foo/bar.git',
    })
  })

  it('git@github.com:owner/repo.git → Skill/git', async () => {
    const r = await run(detectPack('git@github.com:foo/bar.git'))
    expect(r).toMatchObject({ type: 'skill', source: 'git', name: 'bar' })
    expect(r.url).toBe('git@github.com:foo/bar.git')
  })

  it('git+https:// → Skill/git', async () => {
    const r = await run(detectPack('git+https://github.com/foo/bar.git'))
    expect(r).toMatchObject({ type: 'skill', source: 'git', name: 'bar' })
  })

  it.each<[string, Partial<PackRef>]>([
    ['git+https://github.com/Graphify-Labs/graphify', { type: 'skill', source: 'git', name: 'graphify', url: 'https://github.com/Graphify-Labs/graphify' }],
    ['git+https://github.com/Graphify-Labs/graphify.git', { type: 'skill', source: 'git', name: 'graphify', url: 'https://github.com/Graphify-Labs/graphify.git' }],
    ['https://github.com/owner/repo', { type: 'skill', source: 'git', name: 'repo' }],
    ['https://github.com/owner/repo.git', { type: 'skill', source: 'git', name: 'repo' }],
    ['git+ssh://git@github.com/owner/repo', { type: 'skill', source: 'git', name: 'repo' }],
    ['ssh://git@git.ecom.tech:5022/owner/repo', { type: 'skill', source: 'git', name: 'repo' }],
    ['ssh://git@git.ecom.tech:5022/owner/repo.git', { type: 'skill', source: 'git', name: 'repo' }],
    ['git@github.com:owner/repo', { type: 'skill', source: 'git', name: 'repo' }],
    ['git@github.com:owner/repo.git', { type: 'skill', source: 'git', name: 'repo' }],
    ['github:owner/repo', { type: 'skill', source: 'git', name: 'repo', url: 'https://github.com/owner/repo.git' }],
  ])('%s → Skill/git (no .git suffix required)', async (ref, expected) => {
    const r = await run(detectPack(ref))
    expect(r).toMatchObject(expected)
    expect(r.source).toBe('git')
  })

  it('absolute path → Skill/local (path preserved)', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const r = await run(detectPack(dir))
    expect(r).toMatchObject({ type: 'skill', source: 'local', path: dir })
    expect(r.name).toBe(path.basename(dir))
  })

  it('relative ./path → Skill/local', async () => {
    const r = await run(detectPack('./relative/skill'))
    expect(r).toMatchObject({ type: 'skill', source: 'local', path: './relative/skill' })
    expect(r.name).toBe('skill')
  })

  it('mcp:<name> → Mcp/inline', async () => {
    const r = await run(detectPack('mcp:myserver'))
    expect(r).toMatchObject({ type: 'mcp', source: 'inline', name: 'myserver' })
    expect(r.config).toBeUndefined()
  })

  it('mcp:<name>:<json> → Mcp/inline with config payload', async () => {
    const r = await run(detectPack('mcp:myserver:{"command":"npx"}'))
    expect(r).toMatchObject({ type: 'mcp', source: 'inline', name: 'myserver' })
    expect(r.config).toBe('{"command":"npx"}')
  })

  it('mcp:<name>:@<file> → Mcp/inline with config file ref', async () => {
    const r = await run(detectPack('mcp:myserver:@./cfg/mcp.json'))
    expect(r).toMatchObject({ type: 'mcp', source: 'inline', name: 'myserver' })
    expect(r.config).toBe('@./cfg/mcp.json')
  })

  it('mcp: (empty name) → PackDetectError', async () => {
    const err = await runFlip(detectPack('mcp::{"command":"npx"}'))
    expect(err).toBeInstanceOf(PackDetectError)
  })

  it('mcp:<name>: (empty config) → PackDetectError', async () => {
    const err = await runFlip(detectPack('mcp:myserver:'))
    expect(err).toBeInstanceOf(PackDetectError)
  })

  it('agent:<git url> → Agent/git', async () => {
    const r = await run(detectPack('agent:https://github.com/foo/myagent.git'))
    expect(r).toMatchObject({ type: 'agent', source: 'git', name: 'myagent' })
    expect(r.url).toBe('https://github.com/foo/myagent.git')
  })

  it('agent:<local path> → Agent/local', async () => {
    const r = await run(detectPack('agent:./local/agent'))
    expect(r).toMatchObject({ type: 'agent', source: 'local', path: './local/agent' })
  })

  it('command:<git url> → Command/git', async () => {
    const r = await run(detectPack('command:https://github.com/foo/cmd.git'))
    expect(r).toMatchObject({ type: 'command', source: 'git', name: 'cmd' })
  })

  it('empty string → PackDetectError', async () => {
    const err = await runFlip(detectPack(''))
    expect(err).toBeInstanceOf(PackDetectError)
  })

  it('whitespace-only string → PackDetectError', async () => {
    const err = await runFlip(detectPack('   '))
    expect(err).toBeInstanceOf(PackDetectError)
  })

  it('invalid format → PackDetectError', async () => {
    const err = await runFlip(detectPack('foo bar baz'))
    expect(err).toBeInstanceOf(PackDetectError)
  })

  it('bare owner/repo without prefix → PackDetectError', async () => {
    const err = await runFlip(detectPack('foo/bar'))
    expect(err).toBeInstanceOf(PackDetectError)
  })

  describe('graphify pack URL formats (3 git-source formats)', () => {
    it('https://github.com/Graphify-Labs/graphify (HTTPS, no .git) → Skill/git', async () => {
      const r = await run(detectPack('https://github.com/Graphify-Labs/graphify'))
      expect(r).toMatchObject({
        type: 'skill',
        source: 'git',
        name: 'graphify',
        url: 'https://github.com/Graphify-Labs/graphify',
      })
    })

    it('github:Graphify-Labs/graphify (github short form) → Skill/git, url normalized to .git', async () => {
      const r = await run(detectPack('github:Graphify-Labs/graphify'))
      expect(r).toMatchObject({
        type: 'skill',
        source: 'git',
        name: 'graphify',
        url: 'https://github.com/Graphify-Labs/graphify.git',
      })
    })

    it('https://github.com/Graphify-Labs/graphify.git (HTTPS with .git) → Skill/git', async () => {
      const r = await run(detectPack('https://github.com/Graphify-Labs/graphify.git'))
      expect(r).toMatchObject({
        type: 'skill',
        source: 'git',
        name: 'graphify',
        url: 'https://github.com/Graphify-Labs/graphify.git',
      })
    })
  })
})
