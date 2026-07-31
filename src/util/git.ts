import { Data, Effect } from 'effect'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DiffSummary, FileChange } from '@generated/types'
import { redactUrlCredentials } from './redact.js'
import { appendFile, ensureDir, readFile } from './fs.js'
import type { FsError } from './fs.js'

export interface DiffStat {
  readonly filesChanged: number
  readonly additions: number
  readonly deletions: number
}

export class GitError extends Data.TaggedError('GitError')<{
  readonly command: string
  readonly exitCode: number
  readonly stderr: string
}> {}

const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Every git invocation goes through `execGit`, so forcing the C locale here
 * — the one shared point, not per call site — makes git's own stdout/stderr
 * text stable and parseable everywhere: the disk-full classifier below
 * (`08-diff.ts`, `02-repo-clone.ts`), the auth-failure hint
 * (`02-repo-clone.ts`), any future text match, all currently assume English
 * output. Without this, a git built against the host's locale (verified
 * directly: a Russian-locale git prints "Нет такого файла или каталога"
 * where a C-locale git prints "No such file or directory" for the exact same
 * error) silently defeats every one of them — worst case, a real full disk
 * gets contained as an ordinary broken worktree instead of aborting the
 * phase, the same failure mode this classifier exists to catch. Node's own
 * `fs` errors are unaffected either way — they carry the `ENOSPC` errno code
 * regardless of locale.
 */
const GIT_ENV: NodeJS.ProcessEnv = { LC_ALL: 'C', LANG: 'C' }

interface GitRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const execGit = (
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<GitRunResult> =>
  Effect.async<GitRunResult>((resume) => {
    const controller = new AbortController()
    let settled = false
    execFile(
      'git',
      [...args],
      {
        cwd,
        maxBuffer: GIT_MAX_BUFFER,
        signal: controller.signal,
        env: { ...process.env, ...GIT_ENV, ...env },
      },
      (err, stdout, stderr) => {
        if (settled) return
        settled = true
        const exitCode = err === null ? 0 : typeof err.code === 'number' ? err.code : -1
        resume(Effect.succeed({ stdout, stderr, exitCode }))
      },
    )
    return Effect.sync(() => {
      settled = true
      controller.abort()
    })
  })

const runGit = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, GitError> =>
  Effect.gen(function* () {
    const result = yield* execGit(args, cwd, env)
    if (result.exitCode !== 0) {
      yield* Effect.fail(
        new GitError({
          command,
          exitCode: result.exitCode,
          stderr: redactUrlCredentials(result.stderr),
        }),
      )
    }
    return { stdout: result.stdout, stderr: result.stderr }
  })

/**
 * `--git-dir`/`--work-tree` global options, prefixed before the subcommand
 * args so a helper can run against a git dir moved outside its work tree
 * (`--protect-git`). Both paths are passed explicitly rather than relying on
 * git's cwd-defaulting rule, so behavior is pinned regardless of process cwd.
 * Omitted entirely when `gitDir` is absent — the single-path form this
 * produces is byte-identical to what every helper sent before this existed.
 */
const gitDirArgs = (cwd: string, gitDir: string | undefined): readonly string[] =>
  gitDir === undefined ? [] : ['--git-dir', gitDir, '--work-tree', cwd]

/**
 * `GIT_INDEX_FILE` is env-based, not arg-based like `--git-dir`/`--work-tree`
 * above, so it is threaded as an env override rather than an extra arg.
 * Pointing a caller at a fresh index file sidesteps a stale `.git/index.lock`
 * from a killed process (a fresh path can never already hold one) and keeps
 * the caller's own index file untouched — useful when the caller's index is
 * itself evidence, not scratch state.
 */
const indexEnv = (indexFile: string | undefined): NodeJS.ProcessEnv | undefined =>
  indexFile === undefined ? undefined : { GIT_INDEX_FILE: indexFile }

export const init = (cwd: string): Effect.Effect<void, GitError> =>
  Effect.as(runGit('init', ['init', '--quiet', cwd], process.cwd()), undefined)

export const clone = (
  url: string,
  dst: string,
  opts: { readonly shallow?: boolean } = {},
): Effect.Effect<void, GitError> => {
  const args: readonly string[] = [
    'clone',
    ...(opts.shallow === true ? ['--depth', '1'] : []),
    url,
    dst,
  ]
  return Effect.as(runGit('clone', args, process.cwd()), undefined)
}

export const addAll = (cwd: string, gitDir?: string, indexFile?: string): Effect.Effect<void, GitError> =>
  Effect.as(
    runGit('add', [...gitDirArgs(cwd, gitDir), 'add', '-A'], cwd, indexEnv(indexFile)),
    undefined,
  )

export const commit = (
  cwd: string,
  message: string,
): Effect.Effect<void, GitError> =>
  Effect.as(
    runGit(
      'commit',
      ['-c', 'user.email=t@t', '-c', 'user.name=testaipack', 'commit', '-m', message, '--quiet'],
      cwd,
    ),
    undefined,
  )

export const diffCached = (cwd: string, gitDir?: string, indexFile?: string): Effect.Effect<string, GitError> =>
  Effect.map(
    runGit('diff', [...gitDirArgs(cwd, gitDir), 'diff', '--cached'], cwd, indexEnv(indexFile)),
    (r) => r.stdout,
  )

const parseNumStatField = (field: string | undefined): number => {
  if (field === undefined || field === '-') return 0
  return Number.parseInt(field, 10) || 0
}

export const diffStat = (cwd: string): Effect.Effect<DiffStat, GitError> =>
  Effect.gen(function* () {
    const { stdout } = yield* runGit('numstat', ['diff', '--cached', '--numstat'], cwd)
    return stdout.split('\n').reduce<DiffStat>(
      (acc, line) => {
        const trimmed = line.trim()
        if (trimmed === '') return acc
        const parts = trimmed.split('\t')
        if (parts.length < 2) return acc
        return {
          filesChanged: acc.filesChanged + 1,
          additions: acc.additions + parseNumStatField(parts[0]),
          deletions: acc.deletions + parseNumStatField(parts[1]),
        }
      },
      { filesChanged: 0, additions: 0, deletions: 0 },
    )
  })

/**
 * Like diffStat but also returns a per-file breakdown. `git diff --numstat`
 * emits `additions\tdeletions\tpath` per line; binary files show `-` for both
 * counts (mapped to 0 — the contract FileChange has no binary flag).
 */
export const diffStatFull = (
  cwd: string,
  gitDir?: string,
  indexFile?: string,
): Effect.Effect<DiffSummary, GitError> =>
  Effect.gen(function* () {
    const { stdout } = yield* runGit(
      'numstat-full',
      [...gitDirArgs(cwd, gitDir), 'diff', '--cached', '--numstat'],
      cwd,
      indexEnv(indexFile),
    )
    return stdout.split('\n').reduce<DiffSummary>(
      (acc, line) => {
        const trimmed = line.trim()
        if (trimmed === '') return acc
        const parts = trimmed.split('\t')
        if (parts[0] === undefined || parts[1] === undefined) return acc
        const additions = parseNumStatField(parts[0])
        const deletions = parseNumStatField(parts[1])
        const filePath = parts.slice(2).join('\t') || '(unknown)'
        const perFile: FileChange = { path: filePath, additions, deletions }
        return {
          filesChanged: acc.filesChanged + 1,
          additions: acc.additions + additions,
          deletions: acc.deletions + deletions,
          perFile: [...acc.perFile, perFile],
        }
      },
      { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
    )
  })

export const revParseHead = (cwd: string, gitDir?: string): Effect.Effect<string, GitError> => {
  if (!existsSync(cwd) || !existsSync(gitDir ?? path.join(cwd, '.git'))) {
    return Effect.fail(
      new GitError({ command: 'rev-parse', exitCode: -1, stderr: 'cwd does not exist or is not a git repo' }),
    )
  }
  return Effect.map(
    runGit('rev-parse', [...gitDirArgs(cwd, gitDir), 'rev-parse', 'HEAD'], cwd),
    (r) => r.stdout.trim(),
  )
}

export type HeadState = { readonly _tag: 'commit'; readonly sha: string } | { readonly _tag: 'unborn' }

/**
 * `git rev-parse --verify -q HEAD` exits 0 with the sha for a normal repo,
 * exits exactly 1 (silently — `-q` suppresses the "ambiguous argument"
 * message) for a repo with zero commits yet ("unborn" HEAD, a legitimate
 * state — e.g. testing an agent's ability to bootstrap a fresh project), and
 * exits with a different code (128, verified against real git) for anything
 * actually broken (missing `.git`, corrupted refs). `revParseHead` above
 * cannot make this distinction — it surfaces both as the same plain failure.
 */
export const headState = (cwd: string, gitDir?: string): Effect.Effect<HeadState, GitError> =>
  Effect.gen(function* () {
    if (!existsSync(cwd) || !existsSync(gitDir ?? path.join(cwd, '.git'))) {
      return yield* Effect.fail(
        new GitError({ command: 'rev-parse --verify -q HEAD', exitCode: -1, stderr: 'cwd does not exist or is not a git repo' }),
      )
    }
    const result = yield* execGit([...gitDirArgs(cwd, gitDir), 'rev-parse', '--verify', '-q', 'HEAD'], cwd)
    if (result.exitCode === 0) return { _tag: 'commit' as const, sha: result.stdout.trim() }
    if (result.exitCode === 1) return { _tag: 'unborn' as const }
    return yield* Effect.fail(
      new GitError({
        command: 'rev-parse --verify -q HEAD',
        exitCode: result.exitCode,
        stderr: redactUrlCredentials(result.stderr),
      }),
    )
  })

export const headsMatch = (a: HeadState, b: HeadState): boolean =>
  a._tag === 'unborn' ? b._tag === 'unborn' : b._tag === 'commit' && a.sha === b.sha

/**
 * Primes an index (normally a scratch `GIT_INDEX_FILE`) with HEAD's tree
 * before `git add -A` runs against it. A brand-new index starts with zero
 * entries, and `git add -A` only re-adds a path that is *already tracked but
 * gitignored* if the index already carries an entry for it — otherwise it
 * silently skips the working-tree copy (still gitignored, still untracked as
 * far as this empty index knows), so `git diff --cached` reports that
 * committed-but-ignored path as deleted. `read-tree HEAD` fails on an unborn
 * HEAD (nothing to read) — callers must check `headState` first and skip
 * this call entirely in that case, where an empty index is already correct.
 */
export const readTreeHead = (cwd: string, gitDir?: string, indexFile?: string): Effect.Effect<void, GitError> =>
  Effect.as(
    runGit('read-tree', [...gitDirArgs(cwd, gitDir), 'read-tree', 'HEAD'], cwd, indexEnv(indexFile)),
    undefined,
  )

export interface StatusEntry {
  /** Two-letter porcelain status code, e.g. `' M'`, `'??'`, `'A '`. */
  readonly code: string
  readonly path: string
}

/**
 * `git status --porcelain` — used by `--pack-exercise` diff hygiene to tell a
 * tracked-file modification (the exercise wrote over agent-visible source,
 * `E_PACK_EXERCISE_DIRTY`, abort) apart from a brand-new untracked path (the
 * exercise's own output artifacts, excluded from the measured diff instead).
 * `--porcelain` (v1, not `=v2`) keeps the two-char code + path format stable
 * across git versions; each line is `XY path` with a single space separator,
 * a renamed entry's `path` carries the `old -> new` text verbatim.
 *
 * `includeIgnored` adds `--ignored` (default git behavior, not
 * `--ignored=matching`: an ignored directory collapses to one `!!ignored-dir/`
 * line, same granularity plain status already gives untracked directories).
 * Without it, a path the target repo's own `.gitignore` already covers is
 * invisible to this call — `04b-pack-setup.ts` needs `!!` entries too, or a
 * `setup` that writes into a gitignored path (npm's `node_modules/`, a
 * tool's own `.env`) silently never gets detected at all.
 */
export const statusPorcelain = (
  cwd: string,
  gitDir?: string,
  includeIgnored = false,
): Effect.Effect<readonly StatusEntry[], GitError> =>
  Effect.gen(function* () {
    const { stdout } = yield* runGit(
      'status',
      // `-c core.quotePath=false` — otherwise a path with non-ASCII bytes
      // (verified against real git: a Cyrillic filename) comes back
      // C-quoted (`"\320\276..."`), and the caller writes that quoted text
      // itself into `.git/info/exclude` as a pattern, which then matches
      // nothing real — the artifact it was meant to hide leaks straight
      // into the measured diff instead.
      [
        ...gitDirArgs(cwd, gitDir),
        '-c', 'core.quotePath=false',
        'status', '--porcelain',
        ...(includeIgnored ? ['--ignored'] : []),
      ],
      cwd,
    )
    return stdout.split('\n').flatMap((line) => {
      if (line.trim() === '') return []
      const code = line.slice(0, 2)
      const path = line.slice(3)
      return path === '' ? [] : [{ code, path }]
    })
  })

/**
 * Turns a `git status` path into a literal, root-anchored exclude pattern.
 * A bare path written as-is is an *unanchored* gitignore pattern — it
 * matches at any depth, so a root-level `GRAPH_REPORT.md` artifact would
 * also hide an unrelated `src/GRAPH_REPORT.md` (verified against real git).
 * The leading `/` fixes that. Backslash-escaping `\ * ? [ ]` stops a literal
 * filename that happens to contain a gitignore metacharacter from being
 * read as a glob instead of matched literally.
 */
const toExcludePattern = (relPath: string): string => `/${relPath.replace(/[\\*?[\]]/g, '\\$&')}`

/**
 * Appends paths to `<gitDir>/info/exclude` — the per-repo, never-committed
 * sibling of `.gitignore` (git honors both for `git add -A`/`git status`).
 * Used to keep `--pack-exercise` artifacts out of the measured diff without
 * touching any tracked file (a `.gitignore` edit would itself show up as a
 * change). Idempotent: a path already present is not duplicated. Creates
 * `info/exclude` (and its parent dir) if the repo has never used it.
 */
export const appendInfoExclude = (
  gitDir: string,
  paths: readonly string[],
): Effect.Effect<void, FsError> =>
  Effect.gen(function* () {
    if (paths.length === 0) return
    const excludePath = path.join(gitDir, 'info', 'exclude')
    const existing = yield* readFile(excludePath).pipe(Effect.orElseSucceed(() => ''))
    const already = new Set(existing.split('\n').map((l) => l.trim()).filter((l) => l !== ''))
    const toAdd = paths.map(toExcludePattern).filter((p) => !already.has(p))
    if (toAdd.length === 0) return
    yield* ensureDir(path.dirname(excludePath))
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    yield* appendFile(excludePath, `${prefix}${toAdd.join('\n')}\n`)
  })

/** Reads `<gitDir>/info/exclude` back, one path per line — empty array when absent. */
export const readInfoExclude = (gitDir: string): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const excludePath = path.join(gitDir, 'info', 'exclude')
    const content = yield* readFile(excludePath).pipe(Effect.orElseSucceed(() => ''))
    return content.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  })

export const lsFilesStage = (cwd: string, gitDir?: string): Effect.Effect<string, GitError> => {
  if (!existsSync(cwd) || !existsSync(gitDir ?? path.join(cwd, '.git'))) {
    return Effect.fail(
      new GitError({ command: 'ls-files', exitCode: -1, stderr: 'cwd does not exist or is not a git repo' }),
    )
  }
  return Effect.map(runGit('ls-files', [...gitDirArgs(cwd, gitDir), 'ls-files', '-s'], cwd), (r) => r.stdout)
}
