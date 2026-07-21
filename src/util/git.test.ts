import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import {
  GitError,
  clone,
  addAll,
  diffCached,
  diffStat,
  init,
  revParseHead,
} from './git.js'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

/** Build a tiny source repo with one commit; returns the repo path. */
const buildSourceRepo = async (): Promise<string> => {
  const repo = makeTempDir()
  await run(init(repo))
  const { writeFile } = await import('./fs.js')
  await run(writeFile(path.join(repo, 'README.md'), '# hello\n'))
  await run(addAll(repo))
  const { commit } = await import('./git.js')
  await run(commit(repo, 'init'))
  return repo
}

describe('git utils', () => {
  it('init creates a .git directory', async () => {
    const repo = makeTempDir()
    await run(init(repo))
    expect(existsSync(path.join(repo, '.git'))).toBe(true)
  })

  it('clone --depth 1 produces a working shallow repo with a single commit', async () => {
    const src = await buildSourceRepo()
    const dst = makeTempDir()
    await run(clone(`file://${src}`, dst, { shallow: true }))
    expect(await run(revParseHead(dst))).toBe(await run(revParseHead(dst)))
    expect(existsSync(path.join(dst, 'README.md'))).toBe(true)
    // shallow clone = exactly one commit in history
    expect((await run(diffStat(dst))).filesChanged).toBe(0)
  })

  it('addAll + diffCached surface staged changes', async () => {
    const repo = await buildSourceRepo()
    const { writeFile } = await import('./fs.js')
    await run(writeFile(path.join(repo, 'new.txt'), 'fresh\n'))
    await run(addAll(repo))
    const diff = await run(diffCached(repo))
    expect(diff).toContain('new.txt')
    expect(diff).toContain('+fresh')
    const stat = await run(diffStat(repo))
    expect(stat.filesChanged).toBe(1)
    expect(stat.additions).toBeGreaterThanOrEqual(1)
  })

  it('diffStat reports 0 / 0 / 0 when there are no staged changes', async () => {
    const repo = await buildSourceRepo()
    const stat = await run(diffStat(repo))
    expect(stat).toEqual({ filesChanged: 0, additions: 0, deletions: 0 })
  })

  it('revParseHead returns a 40-char SHA', async () => {
    const repo = await buildSourceRepo()
    const sha = await run(revParseHead(repo))
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('GitError is returned for an invalid clone URL', async () => {
    const dst = makeTempDir()
    const err = await runFlip(clone('file:///definitely/not/a/repo/xyzzy', dst))
    expect(err).toBeInstanceOf(GitError)
    expect(err.command).toBe('clone')
    expect(err.exitCode).not.toBe(0)
    expect(err.stderr.length).toBeGreaterThan(0)
  })
})
