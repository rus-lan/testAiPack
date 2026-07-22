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
import { Effect } from 'effect'
import path from 'node:path'
import { html as renderDiffHtml } from 'diff2html'
import type {
  DiffInput,
  DiffResult,
  DiffResultOutput,
  DiffRunResult,
  DiffSummary,
  Side,
} from '@generated/types'
import { diffError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, exists, writeFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { addAll, diffCached, diffStatFull } from '../util/git.js'
import type { GitError } from '../util/git.js'

const BASE_CSS = `body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:1rem;color:#222}
.d2h-no-changes{color:#666;font-size:1.1rem}`

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

const toGitFailure = (side: Side, runIndex: number, what: string, e: GitError): PhaseError =>
  diffError(`${what} failed (exit ${String(e.exitCode)}): ${e.stderr}`, 'E_DISK_FULL', {
    side,
    runIndex,
    reason: 'git-failure',
    command: e.command,
    exitCode: e.exitCode,
  })

const writeSideHtml = (htmlPath: string, patch: string): Effect.Effect<string, FsError> =>
  Effect.gen(function* () {
    const body =
      patch.trim() === ''
        ? '<p class="d2h-no-changes">No changes</p>'
        : renderDiffHtml(patch, { drawFileList: true, outputFormat: 'side-by-side' })
    const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>testaipack diff</title>
<style>${BASE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`
    yield* writeFile(htmlPath, doc)
    return htmlPath
  })

const diffOneRun = (
  side: Side,
  runIndex: number,
  destDir: string,
  diffRoot: string,
  diffHtml: boolean,
): Effect.Effect<DiffRunResult, PhaseError> =>
  Effect.gen(function* () {
    const outDir = path.join(diffRoot, side, `run-${String(runIndex)}`)
    yield* ensureDir(outDir).pipe(
      Effect.mapError((e: FsError) =>
        toDiskFull(side, runIndex, `ensureDir failed: ${fsCauseText(e)}`, 'disk-full', e),
      ),
    )

    const hasGit = yield* exists(path.join(destDir, '.git'))
    if (!hasGit) {
      return yield* Effect.fail(
        toDiskFull(side, runIndex, `no .git in ${destDir}`, 'no-git-dir'),
      )
    }

    yield* addAll(destDir).pipe(
      Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git add -A', e)),
    )

    const fullPatch = yield* diffCached(destDir).pipe(
      Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git diff --cached', e)),
    )
    const summary: DiffSummary = yield* diffStatFull(destDir).pipe(
      Effect.mapError((e: GitError) => toGitFailure(side, runIndex, 'git diff --numstat', e)),
    )
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
        ? yield* writeSideHtml(path.join(outDir, 'side.html'), fullPatch).pipe(
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
      ...(htmlPath === undefined ? {} : { htmlPath }),
    }
  })

const diffSide = (
  side: Side,
  appDirs: readonly string[],
  diffRoot: string,
  diffHtml: boolean,
): Effect.Effect<DiffResult, PhaseError> =>
  Effect.gen(function* () {
    const runs = yield* Effect.all(
      appDirs.map((dir, i) =>
        diffOneRun(side, i + 1, dir, diffRoot, diffHtml),
      ),
      { concurrency: 1 },
    )
    return { side, runs }
  })

export const diff = (
  input: DiffInput,
): Effect.Effect<DiffResultOutput, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const oldResult = yield* diffSide('old', workspace.appsOld, workspace.diff, runInput.diffHtml)
    const newResult = yield* diffSide('new', workspace.appsNew, workspace.diff, runInput.diffHtml)
    return { diff: { old: oldResult, new: newResult } }
  })
