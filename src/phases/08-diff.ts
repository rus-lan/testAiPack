/**
 * Phase 08: diff
 *
 * For each (side, runIndex): stage the agent's working tree, capture
 * `git diff --cached` as full.patch, parse numstat into a DiffSummary, and
 * optionally render a side-by-side HTML. Writes per-run full.patch + summary.json
 * under results/diff/<side>/run-<n>/.
 *
 * @see docs/phases/08-diff.ru.md
 * @see contract/phases/08-diff.tsp
 */
import { Effect, Option } from 'effect'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { html as renderDiffHtml } from 'diff2html'
import type {
  DiffInput,
  DiffResult,
  DiffResultOutput,
  DiffRunResult,
  DiffRunState,
  DiffSummary,
  Side,
} from '@generated/types'
import { diffError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { copyDir, ensureDir, exists, moveDir, removeDir, writeFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { addAll, diffCached, diffStatFull, headState, headsMatch, readTreeHead } from '../util/git.js'
import type { GitError, HeadState } from '../util/git.js'
import { DIFF2HTML_CSS } from './08-diff-css.js'

/**
 * Same idea as `02-repo-clone.ts`'s classifier (an ENOSPC-shaped git/fs
 * failure is a machine-global full-disk problem, not this run's worktree
 * being broken), narrowed to reduce a griefing surface: the text tested here
 * can contain an agent-chosen path (e.g. from a permission error naming the
 * file), so a bare substring match would let a file literally named "ENOSPC"
 * or "no space left" abort the whole phase over an ordinary per-run failure.
 * `ENOSPC:` only ever leads a Node/libuv errno message (the path, if any,
 * comes after — never before); "no space left on device" only ever trails a
 * git error immediately after a colon, as the raw, unquoted `strerror()` text
 * — git quotes every path it embeds, so a spoofed path cannot land unquoted
 * right after that colon. Trailing content after the phrase is allowed (real
 * git sometimes appends `(28)`, the raw errno, e.g. `write error: No space
 * left on device (28)`), only the colon-led start of the phrase is anchored.
 * `execGit` (`util/git.ts`) forces the C locale on every git call, so this
 * text is stable regardless of the host's locale — without that, e.g. a
 * Russian-locale git prints "Нет места на устройстве" instead, matching
 * neither this nor the old bare-substring pattern, and a real full disk would
 * get contained as an ordinary broken worktree instead of aborting the phase.
 * Not airtight — an agent could still name a file so a *different*, unquoted
 * failure line happens to start with this exact phrase right after a colon —
 * but that only forces a loud whole-phase abort, not a silent wrong result,
 * so the residual risk is accepted rather than chased further.
 */
const DISK_FULL_RE = /^ENOSPC:|:\s*no space left on device\b/im

const EXTRA_CSS = `body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:1rem;color:#222;background:#fff}
h1{font-size:1rem;font-weight:600;margin:0 0 1rem}
.d2h-no-changes{color:#666;font-size:1.1rem}`

const renderSideHtml = (patch: string, runId: string, side: Side, runIndex: number): string => {
  const diffBody = renderDiffHtml(patch, {
    outputFormat: 'side-by-side',
    drawFileList: true,
    matching: 'lines',
    renderNothingWhenEmpty: true,
  })
  const body = diffBody === '' ? '<p class="d2h-no-changes">No changes</p>' : diffBody
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>testaipack diff: ${side} run-${String(runIndex)} (${runId})</title>
<style>
${DIFF2HTML_CSS}
${EXTRA_CSS}
</style>
</head>
<body>
<h1>testaipack diff — ${side} / run-${String(runIndex)} (${runId})</h1>
${body}
</body>
</html>`
}

const fsCauseText = (e: FsError): string => {
  const c = e.cause
  return typeof c === 'string' ? c : c instanceof Error ? c.message : `${e.operation} on ${e.path}`
}

const toDiskFull = (
  side: Side,
  runIndex: number,
  message: string,
  reason: string,
  cause?: unknown,
): PhaseError =>
  diffError(message, 'E_DISK_FULL', {
    side,
    runIndex,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })

const toWorktreeBroken = (
  side: Side,
  runIndex: number,
  message: string,
  reason: string,
  cause?: unknown,
): PhaseError =>
  diffError(message, 'E_WORKTREE_BROKEN', {
    side,
    runIndex,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })

/**
 * A git command can fail for a per-run reason (bad index, missing ref — worth
 * containing) or because the machine is out of disk (ENOSPC while git writes
 * its lock/object files — the same class `02-repo-clone.ts` already aborts
 * on). Only the latter gets `E_DISK_FULL`, so a full disk still aborts the
 * phase instead of every run being contained as a false "worktree broken".
 */
const toGitFailure = (side: Side, runIndex: number, what: string, e: GitError): PhaseError => {
  const message = `${what} failed (exit ${String(e.exitCode)}): ${e.stderr}`
  const code = DISK_FULL_RE.test(e.stderr) ? 'E_DISK_FULL' : 'E_WORKTREE_BROKEN'
  const reason = code === 'E_DISK_FULL' ? 'disk-full' : 'git-failure'
  return diffError(message, code, {
    side,
    runIndex,
    reason,
    command: e.command,
    exitCode: e.exitCode,
  })
}

const writeSideHtml = (
  htmlPath: string,
  patch: string,
  runId: string,
  side: Side,
  runIndex: number,
): Effect.Effect<string, FsError> =>
  Effect.gen(function* () {
    yield* writeFile(htmlPath, renderSideHtml(patch, runId, side, runIndex))
    return htmlPath
  })

/** Copies `apps/source/.git` into `destDir`, restoring a `.git` the agent deleted. */
const restoreGit = (
  side: Side,
  runIndex: number,
  appsSource: string,
  destDir: string,
): Effect.Effect<'git-restored', PhaseError> =>
  Effect.gen(function* () {
    const srcGit = path.join(appsSource, '.git')
    const hasSrc = yield* exists(srcGit)
    if (!hasSrc) {
      return yield* Effect.fail(
        toWorktreeBroken(side, runIndex, `no .git in ${destDir} and no ${srcGit} to restore from`, 'no-git-dir'),
      )
    }
    yield* copyDir(srcGit, path.join(destDir, '.git')).pipe(
      Effect.mapError((e: FsError) => {
        const text = fsCauseText(e)
        const message = `restore .git into ${destDir} failed: ${text}`
        return DISK_FULL_RE.test(text)
          ? toDiskFull(side, runIndex, message, 'disk-full', e)
          : toWorktreeBroken(side, runIndex, message, 'no-git-dir', e)
      }),
    )
    return 'git-restored' as const
  })

/**
 * Moves a foreign `.git` (agent ran `git init` or committed) out of the way
 * and restores the pristine one. The foreign `.git` is the only record of
 * what the agent did in git terms, so it is preserved under `agentGitDir`
 * rather than deleted — moved out of `destDir` itself (not renamed in place)
 * so it never shows up as untracked content in the very diff `git add -A`
 * is about to stage.
 */
const replaceGit = (
  side: Side,
  runIndex: number,
  appsSource: string,
  destDir: string,
  agentGitDir: string,
): Effect.Effect<'git-replaced', PhaseError> =>
  Effect.gen(function* () {
    yield* ensureDir(path.dirname(agentGitDir)).pipe(
      Effect.mapError((e: FsError) => {
        const text = fsCauseText(e)
        const message = `prepare ${agentGitDir} failed: ${text}`
        return DISK_FULL_RE.test(text)
          ? toDiskFull(side, runIndex, message, 'disk-full', e)
          : toWorktreeBroken(side, runIndex, message, 'foreign-git', e)
      }),
    )
    yield* moveDir(path.join(destDir, '.git'), agentGitDir).pipe(
      Effect.mapError((e: FsError) => {
        const text = fsCauseText(e)
        const message = `move foreign .git in ${destDir} to ${agentGitDir} failed: ${text}`
        return DISK_FULL_RE.test(text)
          ? toDiskFull(side, runIndex, message, 'disk-full', e)
          : toWorktreeBroken(side, runIndex, message, 'foreign-git', e)
      }),
    )
    yield* restoreGit(side, runIndex, appsSource, destDir)
    return 'git-replaced' as const
  })

/**
 * A present `.git` is not necessarily ours: the agent may have run `git init`
 * or committed its own work. `sourceHead` is `None` when `apps/source`'s own
 * HEAD could not be read — that makes the foreign-`.git` check unrunnable,
 * not passed: an agent that broke `apps/source` and then `git init`ed +
 * committed in its own tree would otherwise sail through as `state: "ok"`
 * with an empty patch (nothing left uncommitted to stage), silently reporting
 * "no changes" for a run that changed everything. The run is contained as
 * failed instead of guessing.
 *
 * `sourceHead` uses `HeadState`, not a bare sha string, so a legitimately
 * unborn `apps/source` (zero commits — e.g. testing an agent that bootstraps
 * a fresh project) compares equal to an equally-unborn `destDir` instead of
 * being treated the same as "unreadable" (see `resolveSourceHead`).
 */
const checkGitHead = (
  side: Side,
  runIndex: number,
  appsSource: string,
  destDir: string,
  sourceHead: Option.Option<HeadState>,
  agentGitDir: string,
): Effect.Effect<'ok' | 'git-replaced', PhaseError> =>
  Effect.gen(function* () {
    if (Option.isNone(sourceHead)) {
      return yield* Effect.fail(
        toWorktreeBroken(
          side,
          runIndex,
          `cannot verify ${destDir} against apps/source: apps/source HEAD is unreadable`,
          'source-head-unreadable',
        ),
      )
    }
    const destHead = yield* headState(destDir).pipe(Effect.option)
    if (Option.isSome(destHead) && headsMatch(destHead.value, sourceHead.value)) return 'ok' as const
    return yield* replaceGit(side, runIndex, appsSource, destDir, agentGitDir)
  })

const failedRun = (runIndex: number, e: PhaseError): DiffRunResult => ({
  runIndex,
  fullPatch: '',
  summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
  noChanges: false,
  state: 'failed',
  error: { code: 'E_WORKTREE_BROKEN', message: e.message },
})

/**
 * Protected runs (`--protect-git`) never reach `restoreGit`/`checkGitHead`/
 * `replaceGit`: the branch below is checked BEFORE any of them run, so
 * recovery can never copy a `.git` back into the mounted tree and silently
 * un-protect the run. The agent cannot reach `protectGitDir` at all — a
 * mismatch there means operator/host tampering, not agent behavior, so there
 * is nothing safer to fall back to; the run is just contained as failed.
 */
const resolveState = (
  side: Side,
  runIndex: number,
  appsSource: string,
  destDir: string,
  sourceHead: Option.Option<HeadState>,
  protectGitDir: string | undefined,
  agentGitDir: string,
): Effect.Effect<DiffRunState, PhaseError> =>
  Effect.gen(function* () {
    if (protectGitDir !== undefined) {
      const hasGitDir = yield* exists(protectGitDir)
      if (!hasGitDir) {
        return yield* Effect.fail(
          toWorktreeBroken(side, runIndex, `no protected git dir at ${protectGitDir}`, 'no-git-dir'),
        )
      }
      return 'ok' as const
    }
    const hasGit = yield* exists(path.join(destDir, '.git'))
    return hasGit
      ? yield* checkGitHead(side, runIndex, appsSource, destDir, sourceHead, agentGitDir)
      : yield* restoreGit(side, runIndex, appsSource, destDir)
  })

/**
 * A random-suffixed path under the OS temp dir, never reused across
 * invocations — a fresh path can never already carry a stale `index.lock`
 * from a killed process, unlike the agent's own `.git/index`. The random
 * suffix names its own directory (not just the file) so cleanup can remove
 * exactly that directory without risking a sibling run's still-in-use index —
 * `diffOneRun` calls never overlap today (see `diffSide`/`diff`), but nothing
 * here should quietly depend on that.
 */
const tempIndexFile = (runId: string, side: Side, runIndex: number): string =>
  path.join(
    os.tmpdir(),
    'testaipack-diff-index',
    runId,
    side,
    `run-${String(runIndex)}-${crypto.randomUUID()}`,
    'index',
  )

const diffOneRun = (
  side: Side,
  runIndex: number,
  destDir: string,
  appsSource: string,
  appsRoot: string,
  diffRoot: string,
  diffHtml: boolean,
  runId: string,
  sourceHead: Option.Option<HeadState>,
  protectGitDir: string | undefined,
): Effect.Effect<DiffRunResult, PhaseError> =>
  Effect.gen(function* () {
    const outDir = path.join(diffRoot, side, `run-${String(runIndex)}`)
    yield* ensureDir(outDir).pipe(
      Effect.mapError((e: FsError) =>
        toDiskFull(side, runIndex, `ensureDir failed: ${fsCauseText(e)}`, 'disk-full', e),
      ),
    )

    const agentGitDir = path.join(appsRoot, 'agent-git', side, `run-${String(runIndex)}`)
    const state = yield* resolveState(
      side, runIndex, appsSource, destDir, sourceHead, protectGitDir, agentGitDir,
    )

    // Staging into a temp index rather than destDir/.git's own index keeps
    // the agent's own staged state (if any survived recovery) undisturbed —
    // this tool observes agent behavior, and its own bookkeeping run
    // shouldn't overwrite what the agent staged.
    const indexFile = tempIndexFile(runId, side, runIndex)
    yield* ensureDir(path.dirname(indexFile)).pipe(
      Effect.mapError((e: FsError) => {
        const text = fsCauseText(e)
        const message = `create temp index dir failed: ${text}`
        return DISK_FULL_RE.test(text)
          ? toDiskFull(side, runIndex, message, 'disk-full', e)
          : toWorktreeBroken(side, runIndex, message, 'temp-index', e)
      }),
    )
    const cleanupIndex = removeDir(path.dirname(indexFile)).pipe(Effect.ignore)

    const { fullPatch, summary } = yield* Effect.gen(function* () {
      // Prime the fresh temp index from the run's own current HEAD before
      // `git add -A` runs against it. A brand-new index has zero entries, so
      // `add -A` cannot tell a committed-but-gitignored path (build output,
      // lockfiles, ...) apart from a plain untracked one — it skips it either
      // way, and the empty temp index then reads to `git diff --cached` as
      // that path having been deleted, even though the agent never touched
      // it. `read-tree HEAD` fails outright on an unborn HEAD (nothing to
      // read yet) — that is not an error, an empty index is already correct
      // for a repo with zero commits, so it is skipped rather than run.
      const runHead = yield* headState(destDir, protectGitDir).pipe(
        Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git rev-parse --verify -q HEAD', e)),
      )
      if (runHead._tag === 'commit') {
        yield* readTreeHead(destDir, protectGitDir, indexFile).pipe(
          Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git read-tree HEAD', e)),
        )
      }

      yield* addAll(destDir, protectGitDir, indexFile).pipe(
        Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git add -A', e)),
      )

      const patch = yield* diffCached(destDir, protectGitDir, indexFile).pipe(
        Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git diff --cached', e)),
      )
      const stat: DiffSummary = yield* diffStatFull(destDir, protectGitDir, indexFile).pipe(
        Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git diff --numstat', e)),
      )
      return { fullPatch: patch, summary: stat }
    }).pipe(Effect.ensuring(cleanupIndex))
    const noChanges = fullPatch.trim() === ''

    yield* writeFile(path.join(outDir, 'full.patch'), fullPatch).pipe(
      Effect.mapError((e: FsError) =>
        toDiskFull(side, runIndex, `write full.patch failed: ${fsCauseText(e)}`, 'disk-full', e),
      ),
    )
    yield* writeFile(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`).pipe(
      Effect.mapError((e: FsError) =>
        toDiskFull(side, runIndex, `write summary.json failed: ${fsCauseText(e)}`, 'disk-full', e),
      ),
    )

    const htmlPath =
      diffHtml
        ? yield* writeSideHtml(path.join(outDir, 'side.html'), fullPatch, runId, side, runIndex).pipe(
            Effect.mapError((e: FsError) =>
              toDiskFull(side, runIndex, `write side.html failed: ${fsCauseText(e)}`, 'disk-full', e),
            ),
          )
        : undefined

    return {
      runIndex,
      fullPatch,
      summary,
      noChanges,
      state,
      ...(htmlPath === undefined ? {} : { htmlPath }),
    }
  })

interface RunDirs {
  readonly appDir: string
  readonly gitDir: string | undefined
}

/**
 * `appDirs` and `gitDirs` (`workspace.appsOld`/`gitDirsOld`, or the `new`
 * pair) are built together by index in `buildTreePaths` and so are the same
 * length today, but the `--protect-git` "recovery never runs" guarantee
 * (see `resolveState`) depends on that holding — a silent `gitDirs?.[i]`
 * lookup would degrade to `undefined` for a mismatched index and let a run
 * meant to be protected fall through to `restoreGit`, which copies `.git`
 * back into the mounted tree and un-protects it. Pairing the two arrays here
 * turns that assumption into a checked precondition instead of an implicit
 * one.
 */
const pairRunDirs = (
  side: Side,
  appDirs: readonly string[],
  gitDirs: readonly string[] | undefined,
): Effect.Effect<readonly RunDirs[], PhaseError> => {
  if (gitDirs === undefined) {
    return Effect.succeed(appDirs.map((appDir): RunDirs => ({ appDir, gitDir: undefined })))
  }
  if (gitDirs.length !== appDirs.length) {
    return Effect.fail(
      diffError(
        `protect-git dir count (${String(gitDirs.length)}) does not match run count (${String(appDirs.length)}) for side ${side}`,
        'E_WORKTREE_BROKEN',
        { side, reason: 'git-dirs-count-mismatch' },
      ),
    )
  }
  return Effect.succeed(appDirs.map((appDir, i): RunDirs => ({ appDir, gitDir: gitDirs[i] })))
}

const diffSide = (
  side: Side,
  appDirs: readonly string[],
  appsSource: string,
  appsRoot: string,
  diffRoot: string,
  diffHtml: boolean,
  runId: string,
  sourceHead: Option.Option<HeadState>,
  gitDirs: readonly string[] | undefined,
): Effect.Effect<DiffResult, PhaseError> =>
  Effect.gen(function* () {
    const pairs = yield* pairRunDirs(side, appDirs, gitDirs)
    const runs = yield* Effect.all(
      pairs.map(({ appDir, gitDir }, i) =>
        diffOneRun(side, i + 1, appDir, appsSource, appsRoot, diffRoot, diffHtml, runId, sourceHead, gitDir).pipe(
          Effect.catchAll((e: PhaseError) =>
            e.code === 'E_WORKTREE_BROKEN' ? Effect.succeed(failedRun(i + 1, e)) : Effect.fail(e),
          ),
        ),
      ),
      { concurrency: 1 },
    )
    return { side, runs }
  })

/**
 * The agent under `--protect-git` can never reach `apps/source`'s `.git`
 * either way, so its HEAD is not needed for the mismatch check `checkGitHead`
 * would otherwise run — that check itself never fires in protected mode.
 * `headState` (not `revParseHead`) so a legitimately unborn `apps/source`
 * (zero commits) does not collapse into the same `None` as a genuinely
 * unreadable one — only the latter should make every run fail loud.
 */
const resolveSourceHead = (
  protectGit: boolean,
  appsSource: string,
): Effect.Effect<Option.Option<HeadState>> =>
  protectGit ? Effect.succeed(Option.none()) : headState(appsSource).pipe(Effect.option)

export const diff = (
  input: DiffInput,
): Effect.Effect<DiffResultOutput, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const runId = input.manifest.runId
    const protectGit = runInput.protectGit
    const appsRoot = path.join(workspace.root, 'apps')
    const sourceHead = yield* resolveSourceHead(protectGit, workspace.appsSource)
    const oldResult = yield* diffSide(
      'old',
      workspace.appsOld,
      workspace.appsSource,
      appsRoot,
      workspace.diff,
      runInput.diffHtml,
      runId,
      sourceHead,
      protectGit ? workspace.gitDirsOld : undefined,
    )
    const newResult = yield* diffSide(
      'new',
      workspace.appsNew,
      workspace.appsSource,
      appsRoot,
      workspace.diff,
      runInput.diffHtml,
      runId,
      sourceHead,
      protectGit ? workspace.gitDirsNew : undefined,
    )
    return { diff: { old: oldResult, new: newResult } }
  })
