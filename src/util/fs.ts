import { Data, Effect } from 'effect'
import {
  access as fsAccess,
  appendFile as fsAppendFile,
  copyFile as fsCopyFile,
  cp as fsCp,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  readlink,
  rename as fsRename,
  rm as fsRm,
  stat as fsStat,
  symlink as fsSymlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { ZodType } from 'zod'

export class FsError extends Data.TaggedError('FsError')<{
  readonly path: string
  readonly operation: string
  readonly cause: unknown
}> {}

export class ParseError extends Data.TaggedError('ParseError')<{
  readonly path: string
  readonly reason: string
  readonly issues: unknown
}> {}

const wrap =
  (operation: string, p: string) =>
  (e: unknown): FsError =>
    new FsError({ path: p, operation, cause: e })

export const ensureDir = (path: string): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsMkdir(path, { recursive: true }),
    catch: wrap('ensureDir', path),
  })

export const removeDir = (path: string): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsRm(path, { recursive: true, force: true }),
    catch: wrap('removeDir', path),
  })

/**
 * `verbatimSymlinks: true` is load-bearing, not cosmetic: `fs.cp`'s default
 * (`false`) resolves every symlink it copies against its position in `src`
 * and writes the resolved path as the new link target — a RELATIVE symlink
 * inside a copied tree (e.g. npm's `bin/<name> -> ../lib/node_modules/...`)
 * comes out the other end as an ABSOLUTE path still pointing back at `src`,
 * not at the copy. Confirmed empirically (`fs.cpSync` on a relative symlink
 * without the flag). That silently breaks any caller copying a self-contained
 * directory tree to a new location and expecting internal relative symlinks
 * to keep resolving inside the copy — verbatim preserves the exact link text
 * instead, which is correct for every current caller (repo clones, pack
 * files, HOME trees, `.git` duplication).
 */
export const copyDir = (src: string, dst: string): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsCp(src, dst, { recursive: true, verbatimSymlinks: true }),
    catch: wrap('copyDir', src),
  })

/**
 * `src` and `dst` must be on the same filesystem (one run tree, one mount) —
 * a cross-device move would throw `EXDEV`, which surfaces as a plain FsError
 * like any other move failure rather than a silent copy+delete fallback.
 */
export const moveDir = (src: string, dst: string): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsRename(src, dst),
    catch: wrap('moveDir', src),
  })

export const writeFile = (
  path: string,
  content: string,
): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsWriteFile(path, content, 'utf8'),
    catch: wrap('writeFile', path),
  })

export const appendFile = (
  path: string,
  content: string,
): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsAppendFile(path, content, 'utf8'),
    catch: wrap('appendFile', path),
  })

export const readFile = (path: string): Effect.Effect<string, FsError> =>
  Effect.tryPromise({
    try: () => fsReadFile(path, 'utf8'),
    catch: wrap('readFile', path),
  })

export const writeJson = (
  path: string,
  data: unknown,
): Effect.Effect<void, FsError> => writeFile(path, JSON.stringify(data, null, 2))

export const readJson = <T>(
  path: string,
  schema: ZodType<T>,
): Effect.Effect<T, FsError | ParseError> =>
  Effect.gen(function* () {
    const raw = yield* readFile(path)
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) => new ParseError({ path, reason: 'invalid-json', issues: e }),
    })
    const result = schema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
    return yield* Effect.fail(
      new ParseError({ path, reason: 'schema-mismatch', issues: result.error.issues }),
    )
  })

export const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => fsAccess(path).then<boolean>(() => true)).pipe(
    Effect.orElseSucceed(() => false),
  )

export const symlink = (
  target: string,
  linkPath: string,
): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsSymlink(target, linkPath),
    catch: wrap('symlink', linkPath),
  })

export const readSymlink = (linkPath: string): Effect.Effect<string, FsError> =>
  Effect.tryPromise({
    try: () => readlink(linkPath),
    catch: wrap('readSymlink', linkPath),
  })

export const readDir = (path: string): Effect.Effect<readonly string[], FsError> =>
  Effect.tryPromise({
    try: () => fsReaddir(path),
    catch: wrap('readDir', path),
  })

export const copyFile = (
  src: string,
  dst: string,
): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsCopyFile(src, dst),
    catch: wrap('copyFile', src),
  })

/** True when `target` resolves to strictly inside `parent` (not equal to it). */
export const isPathWithin = (parent: string, target: string): boolean => {
  const resolvedParent = path.resolve(parent)
  const resolvedTarget = path.resolve(target)
  return resolvedTarget !== resolvedParent && resolvedTarget.startsWith(`${resolvedParent}${path.sep}`)
}

export type PathKind = 'file' | 'dir' | 'missing'

export const pathKind = (path: string): Effect.Effect<PathKind> =>
  Effect.tryPromise({
    try: async () => {
      const s = await fsStat(path)
      return s.isDirectory() ? 'dir' : 'file'
    },
    catch: (): PathKind => 'missing',
  }).pipe(Effect.catchAll((e) => Effect.succeed(e)))
