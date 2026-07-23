/**
 * Phase 02: repo-clone
 *
 * @see docs/phases/02-repo-clone.ru.md
 * @see contract/phases/02-repo-clone.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { RepoCloneInput, RepoCloneResult } from '@generated/types'
import { repoCloneError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { clone, revParseHead, lsFilesStage } from '../util/git.js'
import type { GitError } from '../util/git.js'
import { copyDir, exists } from '../util/fs.js'
import type { FsError } from '../util/fs.js'

const AUTH_HINT_RE = /Permission denied \(publickey\)|Authentication failed/i
const DISK_FULL_RE = /ENOSPC|no space left/i

const authHint = (stderr: string): string =>
  AUTH_HINT_RE.test(stderr) ? ' Use --ssh / --git to widen the credentials whitelist (phase 04).' : ''

const toCloneFailed = (repoUrl: string, e: GitError): PhaseError =>
  repoCloneError(`git clone failed: ${e.stderr}${authHint(e.stderr)}`, 'E_REPO_CLONE_FAILED', {
    repoUrl,
    exitCode: e.exitCode,
    stderr: e.stderr,
  })

const toCopyFailed = (repoUrl: string, dest: string, e: FsError): PhaseError => {
  const cause = e.cause
  const text = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : `${e.operation} on ${e.path}`
  const reason = DISK_FULL_RE.test(text) ? 'disk-full' : 'copy-failed'
  return repoCloneError(`copy to ${dest} failed: ${text}`, 'E_REPO_CLONE_FAILED', {
    repoUrl,
    dest,
    reason,
    cause: text,
  })
}

const fingerprint = (repoPath: string): Effect.Effect<string, GitError> =>
  Effect.gen(function* () {
    const head = yield* revParseHead(repoPath)
    const staged = yield* lsFilesStage(repoPath)
    return `${head}\n${staged}`
  })

const fingerprintError = (
  repoUrl: string,
  where: string,
  e: GitError,
): PhaseError =>
  repoCloneError(`cannot read ${where} fingerprint: ${e.stderr}`, 'E_REPO_CLONE_FAILED', {
    repoUrl,
    reason: 'non-deterministic',
    path: where,
  })

const checkDeterminism = (
  sourcePath: string,
  copies: readonly string[],
  repoUrl: string,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    const sourceFp = yield* fingerprint(sourcePath).pipe(
      Effect.mapError((e: GitError) => fingerprintError(repoUrl, sourcePath, e)),
    )
    for (const dest of copies) {
      const copyFp = yield* fingerprint(dest).pipe(
        Effect.mapError((e: GitError) => fingerprintError(repoUrl, dest, e)),
      )
      if (copyFp !== sourceFp) {
        return yield* Effect.fail(
          repoCloneError(
            'non-deterministic copy: rev-parse HEAD or ls-files differs',
            'E_REPO_CLONE_FAILED',
            {
              repoUrl,
              reason: 'non-deterministic',
              source: sourceFp,
              copy: copyFp,
              dest,
            },
          ),
        )
      }
    }
  })

export const repoClone = (
  input: RepoCloneInput,
): Effect.Effect<RepoCloneResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const repoUrl = runInput.repoUrl
    const sourcePath = workspace.appsSource
    const installSeconds = runInput.timeouts.installSeconds
    const installMs = installSeconds * 1000

    const start = Date.now()
    const cloneResult = yield* clone(repoUrl, sourcePath, { shallow: true }).pipe(
      Effect.timeoutOption(installMs),
      Effect.mapError((e: GitError) => toCloneFailed(repoUrl, e)),
    )
    if (cloneResult._tag === 'None') {
      return yield* Effect.fail(
        repoCloneError(`git clone timed out after ${installSeconds.toString()}s`, 'E_REPO_TIMEOUT', {
          repoUrl,
          timeoutSec: installSeconds,
        }),
      )
    }
    const cloneDurationMs = String(Date.now() - start)

    const hasGit = yield* exists(path.join(sourcePath, '.git'))
    if (!hasGit) {
      return yield* Effect.fail(
        repoCloneError('clone produced no .git directory', 'E_REPO_CLONE_FAILED', {
          repoUrl,
          reason: 'no-git-dir',
        }),
      )
    }

    const allDestinations = [...workspace.appsOld, ...workspace.appsNew]
    for (const dest of allDestinations) {
      yield* copyDir(sourcePath, dest).pipe(
        Effect.mapError((e: FsError) => toCopyFailed(repoUrl, dest, e)),
      )
    }

    yield* checkDeterminism(sourcePath, allDestinations, repoUrl)

    return {
      sourcePath,
      copyPaths: { old: [...workspace.appsOld], new: [...workspace.appsNew] },
      cloneDurationMs,
    }
  })
