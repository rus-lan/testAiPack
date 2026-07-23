import { Effect } from 'effect'
import { exists, readFile, writeFile } from './fs.js'

const GITIGNORE_LINE = '.testaipack/'

/**
 * Ensure the workspace marker (`.testaipack/`) is present in the project's
 * `.gitignore`. Appends it when missing, creates the file when absent. Errors
 * are swallowed: gitignore hygiene is best-effort and must never fail a run.
 */
export const updateGitignore = (filePath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const present = yield* exists(filePath)
    if (present) {
      const content = yield* readFile(filePath)
      if (content.split('\n').includes(GITIGNORE_LINE)) return
      const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n'
      yield* writeFile(filePath, `${content}${sep}${GITIGNORE_LINE}\n`)
      return
    }
    yield* writeFile(filePath, `${GITIGNORE_LINE}\n`)
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
