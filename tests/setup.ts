import { afterEach, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const TMP_DIRS: string[] = []

afterEach(async () => {
  while (TMP_DIRS.length) {
    const dir = TMP_DIRS.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  vi.restoreAllMocks()
})

export function makeTempDir(prefix = 'testaipack-test-'): string {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  TMP_DIRS.push(dir)
  return dir
}
