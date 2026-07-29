import { describe, it, expect } from 'vitest'
import pkg from '../package.json' with { type: 'json' }

describe('testaipack smoke', () => {
  it('package.json is valid', () => {
    expect(pkg.name).toBe('testaipack')
    // No `bin` field: testaipack ships as standalone binaries via GitHub
    // Releases (bun build --compile), never through npm's bin-linking.
    expect('bin' in pkg).toBe(false)
  })

  it('contract exports main types', async () => {
    const generated = await import('@generated')
    expect(generated).toBeDefined()
  })
})
