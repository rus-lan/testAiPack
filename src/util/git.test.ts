import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import type * as ChildProcessModule from 'node:child_process'

// Real `execFile` by default (every existing test below runs against real
// git); only the credential-redaction test overrides it for one call, since
// this git version already sanitizes URLs in its own clone/network errors
// and cannot be used to reproduce the leaky-stderr shape the fix targets.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

import type { ChildProcess, ExecException, ExecFileOptions } from 'node:child_process'
import { execFile } from 'node:child_process'
import {
  GitError,
  appendInfoExclude,
  clone,
  addAll,
  diffCached,
  diffStat,
  diffStatFull,
  headState,
  init,
  lsFilesStage,
  revParseHead,
  statusPorcelain,
} from './git.js'

const execFileMock = vi.mocked(execFile)

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

  it('forces the C locale so git error text is stable regardless of the host locale', async () => {
    const repo = await buildSourceRepo()
    const { writeFile } = await import('./fs.js')
    // A garbled HEAD makes git report "not a git repository" for the exact
    // condition this sandbox's host locale renders as "fatal: не найден git
    // репозиторий..." (verified manually) — a classifier expecting English
    // text would silently miss it without the locale forced.
    await run(writeFile(path.join(repo, '.git', 'HEAD'), 'garbage not a ref\n'))
    const err = await runFlip(headState(repo))
    expect(err).toBeInstanceOf(GitError)
    expect(err.stderr.toLowerCase()).toContain('not a git repository')
    expect(err.stderr).not.toMatch(/[Ѐ-ӿ]/)
  })

  it('redacts a credentialed URL echoed in git stderr from the resulting GitError', async () => {
    const leakyStderr =
      "fatal: unable to access 'https://user:sk-fake-token@example.invalid/repo.git/': The requested URL returned error: 403"
    execFileMock.mockImplementationOnce(
      (
        (
          _file: string,
          _args: readonly string[] | null | undefined,
          _options: ExecFileOptions,
          callback: (error: ExecException | null, stdout: string, stderr: string) => void,
        ): ChildProcess => {
          callback(Object.assign(new Error('git failed'), { code: 128 }), '', leakyStderr)
          return {} as unknown as ChildProcess
        }
      ) as typeof execFile,
    )

    const err = await runFlip(clone('https://user:sk-fake-token@example.invalid/repo.git', makeTempDir()))
    expect(err).toBeInstanceOf(GitError)
    expect(err.stderr).not.toContain('sk-fake-token')
    expect(err.stderr).not.toContain('user:')
    expect(err.stderr).toContain('https://example.invalid/repo.git')
  })
})

describe('git utils — two-path (--git-dir/--work-tree) form', () => {
  it('single-path calls (no gitDir) are unaffected: addAll/diffCached/diffStatFull/revParseHead/lsFilesStage still work exactly as before', async () => {
    const repo = await buildSourceRepo()
    const { writeFile } = await import('./fs.js')
    await run(writeFile(path.join(repo, 'plain.txt'), 'x\n'))
    await run(addAll(repo))
    expect(await run(diffCached(repo))).toContain('plain.txt')
    expect((await run(diffStatFull(repo))).filesChanged).toBe(1)
    expect(await run(revParseHead(repo))).toMatch(/^[0-9a-f]{40}$/)
    expect(await run(lsFilesStage(repo))).toContain('plain.txt')
  })

  it('after moving .git out, the two-path form reproduces every value the in-tree form produced on the same repo', async () => {
    const repo = await buildSourceRepo()
    const { writeFile, moveDir } = await import('./fs.js')
    await run(writeFile(path.join(repo, 'new.txt'), 'fresh\n'))
    await run(addAll(repo))

    const beforeDiff = await run(diffCached(repo))
    const beforeStat = await run(diffStatFull(repo))
    const beforeHead = await run(revParseHead(repo))
    const beforeLsFiles = await run(lsFilesStage(repo))

    const gitDir = makeTempDir('git-dir-')
    await run(moveDir(path.join(repo, '.git'), gitDir))
    expect(existsSync(path.join(repo, '.git'))).toBe(false)

    expect(await run(diffCached(repo, gitDir))).toBe(beforeDiff)
    expect(await run(diffStatFull(repo, gitDir))).toEqual(beforeStat)
    expect(await run(revParseHead(repo, gitDir))).toBe(beforeHead)
    expect(await run(lsFilesStage(repo, gitDir))).toBe(beforeLsFiles)
  })

  it('addAll with a gitDir stages a working-tree change made after the move', async () => {
    const repo = await buildSourceRepo()
    const { writeFile, moveDir } = await import('./fs.js')
    const gitDir = makeTempDir('git-dir-')
    await run(moveDir(path.join(repo, '.git'), gitDir))
    await run(writeFile(path.join(repo, 'after-move.txt'), 'x\n'))
    await run(addAll(repo, gitDir))
    const diff = await run(diffCached(repo, gitDir))
    expect(diff).toContain('after-move.txt')
    expect(diff).toContain('+x')
  })

  it('revParseHead succeeds against a moved gitDir even though cwd/.git no longer exists', async () => {
    const repo = await buildSourceRepo()
    const { moveDir } = await import('./fs.js')
    const gitDir = makeTempDir('git-dir-')
    await run(moveDir(path.join(repo, '.git'), gitDir))
    expect(await run(revParseHead(repo, gitDir))).toMatch(/^[0-9a-f]{40}$/)
  })

  it('revParseHead fails when the given gitDir does not exist (guard checks gitDir, not cwd/.git)', async () => {
    const repo = await buildSourceRepo()
    const bogusGitDir = path.join(makeTempDir(), 'nope')
    const err = await runFlip(revParseHead(repo, bogusGitDir))
    expect(err).toBeInstanceOf(GitError)
  })

  it('lsFilesStage fails when the given gitDir does not exist', async () => {
    const repo = await buildSourceRepo()
    const bogusGitDir = path.join(makeTempDir(), 'nope')
    const err = await runFlip(lsFilesStage(repo, bogusGitDir))
    expect(err).toBeInstanceOf(GitError)
  })
})

describe('git utils — statusPorcelain / appendInfoExclude (pack-exercise exclude hygiene)', () => {
  it('anchors the written pattern, so a root-level artifact does not also hide an agent file of the same name in a subdirectory', async () => {
    const repo = await buildSourceRepo()
    const { writeFile, ensureDir } = await import('./fs.js')
    // Simulate `--pack-exercise` running before the agent: only the
    // root-level artifact exists untracked at exclude time.
    await run(writeFile(path.join(repo, 'GRAPH_REPORT.md'), 'pack output\n'))
    const statuses = await run(statusPorcelain(repo))
    const untracked = statuses.filter((s) => s.code === '??').map((s) => s.path)
    expect(untracked).toEqual(['GRAPH_REPORT.md'])
    await run(appendInfoExclude(path.join(repo, '.git'), untracked))

    // The agent then writes its own, unrelated file of the same basename
    // in a subdirectory.
    await run(ensureDir(path.join(repo, 'src')))
    await run(writeFile(path.join(repo, 'src', 'GRAPH_REPORT.md'), 'agent work\n'))
    await run(addAll(repo))
    const diff = await run(diffCached(repo))
    expect(diff).toContain('src/GRAPH_REPORT.md')
    expect(diff).not.toContain('+pack output')
    expect(diff).toContain('+agent work')

    const staged = await run(lsFilesStage(repo))
    expect(staged).toContain('src/GRAPH_REPORT.md')
    expect(staged).not.toContain('\tGRAPH_REPORT.md\n')
  })

  it('escapes gitignore metacharacters so a literal filename is matched exactly, not read as a glob', async () => {
    const repo = await buildSourceRepo()
    const { writeFile } = await import('./fs.js')
    await run(writeFile(path.join(repo, 'report[1].md'), 'artifact\n'))
    // An unrelated file that a naive (unescaped) `report[1].md` glob would
    // also match, since `[1]` is a valid one-character character class.
    await run(writeFile(path.join(repo, 'report1.md'), 'unrelated\n'))

    const statuses = await run(statusPorcelain(repo))
    const untracked = statuses.filter((s) => s.code === '??').map((s) => s.path)
    expect(untracked.sort()).toEqual(['report1.md', 'report[1].md'])
    await run(appendInfoExclude(path.join(repo, '.git'), ['report[1].md']))

    await run(addAll(repo))
    const staged = await run(lsFilesStage(repo))
    expect(staged).toContain('report1.md')
    expect(staged).not.toContain('report[1].md')
  })

  it('keeps a non-ASCII path byte-exact end to end, so the written exclude pattern actually matches the real file', async () => {
    const repo = await buildSourceRepo()
    const { writeFile } = await import('./fs.js')
    const cyrillicName = 'отчёт.md'
    await run(writeFile(path.join(repo, cyrillicName), 'artifact\n'))

    const statuses = await run(statusPorcelain(repo))
    const untracked = statuses.filter((s) => s.code === '??').map((s) => s.path)
    // Raw, unquoted bytes back from git — not the C-quoted
    // `"\320\276..."` form core.quotePath produces by default.
    expect(untracked).toEqual([cyrillicName])
    await run(appendInfoExclude(path.join(repo, '.git'), untracked))

    await run(addAll(repo))
    const staged = await run(lsFilesStage(repo))
    expect(staged).not.toContain(cyrillicName)
    const afterStatus = await run(statusPorcelain(repo))
    expect(afterStatus).toEqual([])
  })

  it('includeIgnored=false (default) never reports a gitignored path — it stays invisible to plain status', async () => {
    const repo = await buildSourceRepo()
    const { writeFile, ensureDir } = await import('./fs.js')
    await run(writeFile(path.join(repo, '.gitignore'), 'ignored-dir/\n'))
    await run(addAll(repo))
    const { commit } = await import('./git.js')
    await run(commit(repo, 'add gitignore'))
    await run(ensureDir(path.join(repo, 'ignored-dir')))
    await run(writeFile(path.join(repo, 'ignored-dir', 'file.txt'), 'x\n'))
    await run(writeFile(path.join(repo, 'plain-untracked.txt'), 'y\n'))

    const statuses = await run(statusPorcelain(repo))
    expect(statuses.map((s) => s.code)).not.toContain('!!')
    expect(statuses.map((s) => s.path)).toEqual(['plain-untracked.txt'])
  })

  it('includeIgnored=true reports gitignored paths as `!!`, collapsing an ignored directory to one entry (same granularity plain status already gives untracked directories)', async () => {
    const repo = await buildSourceRepo()
    const { writeFile, ensureDir } = await import('./fs.js')
    await run(writeFile(path.join(repo, '.gitignore'), 'ignored-dir/\nrun.log\n'))
    await run(addAll(repo))
    const { commit } = await import('./git.js')
    await run(commit(repo, 'add gitignore'))
    await run(ensureDir(path.join(repo, 'ignored-dir')))
    await run(writeFile(path.join(repo, 'ignored-dir', 'file.txt'), 'x\n'))
    await run(writeFile(path.join(repo, 'run.log'), 'log\n'))
    await run(writeFile(path.join(repo, 'plain-untracked.txt'), 'y\n'))

    const statuses = await run(statusPorcelain(repo, undefined, true))
    const byCode = (code: string): readonly string[] =>
      statuses.filter((s) => s.code === code).map((s) => s.path).sort()
    expect(byCode('??')).toEqual(['plain-untracked.txt'])
    expect(byCode('!!')).toEqual(['ignored-dir/', 'run.log'])
  })
})
