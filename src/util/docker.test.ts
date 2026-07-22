import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { isDockerAvailable, DOCKER_PROBE_TIMEOUT_MS } from './docker.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

describe('isDockerAvailable', () => {
  it('returns a boolean within the probe budget', async () => {
    const start = Date.now()
    const result = await runP(isDockerAvailable())
    const elapsed = Date.now() - start
    expect(typeof result).toBe('boolean')
    expect(elapsed).toBeLessThan(DOCKER_PROBE_TIMEOUT_MS + 2000)
  })

  it('respects a custom timeout', async () => {
    const result = await runP(isDockerAvailable(500))
    expect(typeof result).toBe('boolean')
  })
})
