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
  moveDir,
  writeFile,
  appendFile,
  readFile,
  writeJson,
  readJson,
  exists,
  symlink,
  readDir,
  copyFile,
  pathKind,
  isPathWithin,
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

  it('moveDir relocates a directory: source gone, contents present at the destination', async () => {
    const src = await freshDir()
    await run(ensureDir(path.join(src, 'sub')))
    await run(writeFile(path.join(src, 'root.txt'), 'root'))
    await run(writeFile(path.join(src, 'sub', 'child.txt'), 'child'))
    const dst = path.join(await freshDir(), 'moved')
    await run(moveDir(src, dst))
    expect(await run(exists(src))).toBe(false)
    expect(await run(readFile(path.join(dst, 'root.txt')))).toBe('root')
    expect(await run(readFile(path.join(dst, 'sub', 'child.txt')))).toBe('child')
  })

  it('moveDir returns FsError when the source is missing', async () => {
    const missing = path.join(makeTempDir(), 'nope')
    const err = await runFlip(moveDir(missing, path.join(makeTempDir(), 'dst')))
    expect(err).toBeInstanceOf(FsError)
    expect(err.operation).toBe('moveDir')
  })

  it('moveDir returns FsError when the destination parent does not exist', async () => {
    const src = await freshDir()
    const dst = path.join(makeTempDir(), 'no', 'such', 'parent', 'dst')
    const err = await runFlip(moveDir(src, dst))
    expect(err).toBeInstanceOf(FsError)
    expect(err.operation).toBe('moveDir')
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

  it('appendFile creates then extends a file', async () => {
    const p = path.join(await freshDir(), 'log.txt')
    await run(appendFile(p, 'a\n'))
    await run(appendFile(p, 'b\n'))
    expect(await run(readFile(p))).toBe('a\nb\n')
  })

  it('readDir lists immediate entry names', async () => {
    const d = await freshDir()
    await run(writeFile(path.join(d, 'x.txt'), 'x'))
    await run(ensureDir(path.join(d, 'sub')))
    const names = await run(readDir(d))
    expect([...names].sort()).toEqual(['sub', 'x.txt'])
  })

  it('readDir returns FsError for a missing directory', async () => {
    const err = await runFlip(readDir(path.join(makeTempDir(), 'nope')))
    expect(err).toBeInstanceOf(FsError)
    expect(err.operation).toBe('readDir')
  })

  it('copyFile duplicates a single file', async () => {
    const d = await freshDir()
    const src = path.join(d, 'a.md')
    const dst = path.join(d, 'b.md')
    await run(writeFile(src, 'body'))
    await run(copyFile(src, dst))
    expect(await run(readFile(dst))).toBe('body')
  })

  it('pathKind classifies file / dir / missing', async () => {
    const d = await freshDir()
    const f = path.join(d, 'f.txt')
    await run(writeFile(f, 'x'))
    expect(await run(pathKind(f))).toBe('file')
    expect(await run(pathKind(d))).toBe('dir')
    expect(await run(pathKind(path.join(d, 'absent')))).toBe('missing')
  })

  it('isPathWithin accepts a plain child directory', () => {
    expect(isPathWithin('/a/pack', '/a/pack/myskill')).toBe(true)
  })

  it('isPathWithin rejects the parent itself (not a child)', () => {
    expect(isPathWithin('/a/pack', '/a/pack')).toBe(false)
  })

  it('isPathWithin rejects a dest that escapes via ..', () => {
    expect(isPathWithin('/a/pack', '/a/pack/..')).toBe(false)
    expect(isPathWithin('/a/pack', '/a/pack/../..')).toBe(false)
  })

  it('isPathWithin rejects an unrelated sibling directory with a matching prefix', () => {
    expect(isPathWithin('/a/pack', '/a/pack-evil/myskill')).toBe(false)
  })
})
