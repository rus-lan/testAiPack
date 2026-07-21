import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { z } from 'zod'
import { readlink } from 'node:fs/promises'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import {
  FsError,
  ParseError,
  ensureDir,
  removeDir,
  copyDir,
  writeFile,
  readFile,
  writeJson,
  readJson,
  exists,
  symlink,
} from './fs.js'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))
const freshDir = async (): Promise<string> => {
  const d = makeTempDir()
  await run(ensureDir(d))
  return d
}

describe('fs utils', () => {
  it('ensureDir creates nested directories', async () => {
    const base = makeTempDir()
    const deep = path.join(base, 'a', 'b', 'c', 'd')
    await run(ensureDir(deep))
    expect(await run(exists(deep))).toBe(true)
  })

  it('removeDir does not fail when the directory is missing', async () => {
    const missing = path.join(makeTempDir(), 'nope')
    await expect(run(removeDir(missing))).resolves.toBeUndefined()
  })

  it('copyDir recursively copies contents', async () => {
    const src = await freshDir()
    const dst = makeTempDir()
    await run(ensureDir(path.join(src, 'sub')))
    await run(writeFile(path.join(src, 'root.txt'), 'root'))
    await run(writeFile(path.join(src, 'sub', 'child.txt'), 'child'))
    await run(copyDir(src, dst))
    expect(await run(readFile(path.join(dst, 'root.txt')))).toBe('root')
    expect(await run(readFile(path.join(dst, 'sub', 'child.txt')))).toBe('child')
  })

  it('writeFile + readFile round-trip a string', async () => {
    const p = path.join(await freshDir(), 'note.txt')
    await run(writeFile(p, 'hello\nworld'))
    expect(await run(readFile(p))).toBe('hello\nworld')
  })

  it('writeJson + readJson round-trip through a Zod schema', async () => {
    const p = path.join(await freshDir(), 'data.json')
    const schema = z.object({ runId: z.string(), runs: z.number().int() })
    await run(writeJson(p, { runId: 'r1', runs: 3 }))
    const parsed = await run(readJson(p, schema))
    expect(parsed).toEqual({ runId: 'r1', runs: 3 })
  })

  it('readJson returns ParseError when the JSON does not match the schema', async () => {
    const p = path.join(await freshDir(), 'bad.json')
    const schema = z.object({ runId: z.string() })
    await run(writeJson(p, { wrong: 'shape' }))
    const err = await runFlip(readJson(p, schema))
    expect(err).toBeInstanceOf(ParseError)
  })

  it('symlink creates a symbolic link verified by readlink', async () => {
    const dir = await freshDir()
    const target = path.join(dir, 'target.txt')
    const link = path.join(dir, 'link.txt')
    await run(writeFile(target, 'payload'))
    await run(symlink(target, link))
    expect(await readlink(link)).toBe(target)
  })

  it('exists returns false for a missing path', async () => {
    expect(await run(exists(path.join(makeTempDir(), 'missing')))).toBe(false)
  })

  it('exists returns true for an existing path', async () => {
    expect(await run(exists(await freshDir()))).toBe(true)
  })

  it('FsError is returned for an invalid path (writeFile with no parent dir)', async () => {
    const p = path.join(makeTempDir(), 'no', 'deep', 'file.txt')
    const err = await runFlip(writeFile(p, 'x'))
    expect(err).toBeInstanceOf(FsError)
    expect(err.operation).toBe('writeFile')
  })

  it('readFile returns FsError for a missing file', async () => {
    const err = await runFlip(readFile(path.join(await freshDir(), 'absent.txt')))
    expect(err).toBeInstanceOf(FsError)
  })
})
