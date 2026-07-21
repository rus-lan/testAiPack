import { describe, it, expect } from 'vitest'
import pkg from '../package.json' with { type: 'json' }

describe('testaipack smoke', () => {
  it('package.json is valid', () => {
    expect(pkg.name).toBe('testaipack')
    expect(pkg.bin).toBeDefined()
  })

  it('contract exports main types', async () => {
    const generated = await import('@generated')
    expect(generated).toBeDefined()
  })
})
