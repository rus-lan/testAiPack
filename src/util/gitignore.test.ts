import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile } from './fs.js'
import { updateGitignore } from './gitignore.js'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

describe('updateGitignore', () => {
  it('creates the file with the given entry when absent', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const filePath = path.join(dir, '.gitignore')
    await run(updateGitignore(filePath, 'myworkspace/'))
    const content = await run(readFile(filePath))
    expect(content).toBe('myworkspace/\n')
  })

  it('appends the entry to an existing gitignore that lacks it', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const filePath = path.join(dir, '.gitignore')
    await run(writeFile(filePath, 'node_modules/'))
    await run(updateGitignore(filePath, 'myworkspace/'))
    const content = await run(readFile(filePath))
    expect(content).toBe('node_modules/\nmyworkspace/\n')
  })

  it('does not duplicate an entry that is already present', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const filePath = path.join(dir, '.gitignore')
    await run(writeFile(filePath, 'node_modules/\nmyworkspace/\n'))
    await run(updateGitignore(filePath, 'myworkspace/'))
    const content = await run(readFile(filePath))
    const matches = content.match(/myworkspace\//g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('uses whatever entry the caller passes, not a hardcoded default', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const filePath = path.join(dir, '.gitignore')
    await run(updateGitignore(filePath, 'some-other-dir/'))
    const content = await run(readFile(filePath))
    expect(content).toContain('some-other-dir/')
    expect(content).not.toContain('.testaipack/')
  })
})
