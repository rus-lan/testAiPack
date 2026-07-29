import { Effect } from 'effect'
import { exists, readFile, writeFile } from './fs.js'

/**
 * Ensure `entry` (the workspace dir name, e.g. `.testaipack/`) is present in
 * the project's `.gitignore`. Appends it when missing, creates the file when
 * absent. Errors are swallowed: gitignore hygiene is best-effort and must
 * never fail a run.
 */
export const updateGitignore = (filePath: string, entry = '.testaipack/'): Effect.Effect<void> =>
  Effect.gen(function* () {
    const present = yield* exists(filePath)
    if (present) {
      const content = yield* readFile(filePath)
      if (content.split('\n').includes(entry)) return
      const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n'
      yield* writeFile(filePath, `${content}${sep}${entry}\n`)
      return
    }
    yield* writeFile(filePath, `${entry}\n`)
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
