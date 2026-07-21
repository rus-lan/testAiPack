import { Data, Effect } from 'effect'
import {
  access as fsAccess,
  cp as fsCp,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readlink,
  rm as fsRm,
  symlink as fsSymlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
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

export const copyDir = (src: string, dst: string): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsCp(src, dst, { recursive: true }),
    catch: wrap('copyDir', src),
  })

export const writeFile = (
  path: string,
  content: string,
): Effect.Effect<void, FsError> =>
  Effect.tryPromise({
    try: () => fsWriteFile(path, content, 'utf8'),
    catch: wrap('writeFile', path),
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
