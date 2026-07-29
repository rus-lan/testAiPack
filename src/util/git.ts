import { Data, Effect } from 'effect'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DiffSummary, FileChange } from '@generated/types'
import { redactUrlCredentials } from './redact.js'

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

interface GitRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const execGit = (args: readonly string[], cwd: string): Effect.Effect<GitRunResult> =>
  Effect.async<GitRunResult>((resume) => {
    const controller = new AbortController()
    let settled = false
    execFile(
      'git',
      [...args],
      { cwd, maxBuffer: GIT_MAX_BUFFER, signal: controller.signal },
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
): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, GitError> =>
  Effect.gen(function* () {
    const result = yield* execGit(args, cwd)
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

export const addAll = (cwd: string): Effect.Effect<void, GitError> =>
  Effect.as(runGit('add', ['add', '-A'], cwd), undefined)

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

export const diffCached = (cwd: string): Effect.Effect<string, GitError> =>
  Effect.map(runGit('diff', ['diff', '--cached'], cwd), (r) => r.stdout)

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
export const diffStatFull = (cwd: string): Effect.Effect<DiffSummary, GitError> =>
  Effect.gen(function* () {
    const { stdout } = yield* runGit('numstat-full', ['diff', '--cached', '--numstat'], cwd)
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

export const revParseHead = (cwd: string): Effect.Effect<string, GitError> => {
  if (!existsSync(cwd) || !existsSync(path.join(cwd, '.git'))) {
    return Effect.fail(
      new GitError({ command: 'rev-parse', exitCode: -1, stderr: 'cwd does not exist or is not a git repo' }),
    )
  }
  return Effect.map(runGit('rev-parse', ['rev-parse', 'HEAD'], cwd), (r) => r.stdout.trim())
}

export const lsFilesStage = (cwd: string): Effect.Effect<string, GitError> => {
  if (!existsSync(cwd) || !existsSync(path.join(cwd, '.git'))) {
    return Effect.fail(
      new GitError({ command: 'ls-files', exitCode: -1, stderr: 'cwd does not exist or is not a git repo' }),
    )
  }
  return Effect.map(runGit('ls-files', ['ls-files', '-s'], cwd), (r) => r.stdout)
}
