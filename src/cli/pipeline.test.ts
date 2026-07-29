import { describe, it, expect } from 'vitest'
import { dockerDowngradeWarning } from './pipeline.js'

describe('cli/pipeline — dockerDowngradeWarning', () => {
  it('returns a warning when flagDefaults.dockerDowngraded is true', () => {
    const msg = dockerDowngradeWarning({ dockerDowngraded: true, configSource: 'cli' })
    expect(msg).toBeDefined()
    expect(msg).toContain('--isolation docker')
    expect(msg).toContain('--isolation home')
  })

  it('returns undefined when dockerDowngraded is false', () => {
    expect(dockerDowngradeWarning({ dockerDowngraded: false, configSource: 'cli' })).toBeUndefined()
  })

  it('returns undefined when dockerDowngraded is absent', () => {
    expect(dockerDowngradeWarning({ configSource: 'cli' })).toBeUndefined()
  })
})
