import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeJson } from '../util/fs.js'
import {
  PricingError,
  loadPricing,
  lookupPrice,
  computeCost,
} from './lookup.js'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

const bundledPath = fileURLToPath(new URL('./pricing.json', import.meta.url))

const writePricing = async (
  name: string,
  data: unknown,
): Promise<string> => {
  const dir = makeTempDir()
  await run(ensureDir(dir))
  const p = path.join(dir, name)
  await run(writeJson(p, data))
  return p
}

describe('pricing/lookup', () => {
  it('loadPricing parses the bundled pricing.json', async () => {
    const table = await run(loadPricing(bundledPath))
    expect(table.version).toBe('0.1.0')
    expect(table.providers['anthropic']).toBeDefined()
  })

  it('lookupPrice finds a known provider/model pair', async () => {
    const table = await run(loadPricing(bundledPath))
    const price = lookupPrice(table, 'anthropic', 'claude-3-5-sonnet-20241022')
    expect(price.input).toBe(3.0)
    expect(price.output).toBe(15.0)
    expect(price.cacheRead).toBe(0.3)
    expect(price.cacheWrite).toBe(3.75)
  })

  it('lookupPrice returns the fallback for an unknown model', async () => {
    const table = await run(loadPricing(bundledPath))
    const price = lookupPrice(table, 'anthropic', 'nonexistent-model')
    expect(price).toEqual(table.fallback)
  })

  it('lookupPrice returns the fallback for an unknown provider', async () => {
    const table = await run(loadPricing(bundledPath))
    expect(lookupPrice(table, 'nope', 'x')).toEqual(table.fallback)
  })

  it('computeCost computes USD for given token counts (1M*3 + 0.5M*15 = 10.5)', () => {
    const cost = computeCost(
      { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      { input: 1_000_000, output: 500_000, cache: { read: 0, write: 0 } },
    )
    expect(cost).toBeCloseTo(10.5, 6)
  })

  it('computeCost accounts for cache read/write tokens', () => {
    const cost = computeCost(
      { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      { input: 0, output: 0, cache: { read: 2_000_000, write: 1_000_000 } },
    )
    // 2M * 0.3 + 1M * 3.75 = 0.6 + 3.75 = 4.35
    expect(cost).toBeCloseTo(4.35, 6)
  })

  it('loadPricing returns PricingError when the file is missing', async () => {
    const err = await runFlip(loadPricing(path.join(makeTempDir(), 'nope.json')))
    expect(err).toBeInstanceOf(PricingError)
  })

  it('loadPricing returns PricingError for invalid JSON', async () => {
    const dir = makeTempDir()
    await run(ensureDir(dir))
    const { writeFile } = await import('../util/fs.js')
    const p = path.join(dir, 'bad.json')
    await run(writeFile(p, '{ not json'))
    const err = await runFlip(loadPricing(p))
    expect(err).toBeInstanceOf(PricingError)
  })

  it('loadPricing returns PricingError for an invalid pricing shape', async () => {
    const p = await writePricing('no-providers.json', { version: '0.1.0' })
    const err = await runFlip(loadPricing(p))
    expect(err).toBeInstanceOf(PricingError)
  })

  it('loadPricing returns PricingError when a model price has wrong field types', async () => {
    const p = await writePricing('bad-model.json', {
      version: '0.1.0',
      providers: { anthropic: { 'm1': { input: 'cheap', output: 1, cacheRead: 1, cacheWrite: 1 } } },
      fallback: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    })
    const err = await runFlip(loadPricing(p))
    expect(err).toBeInstanceOf(PricingError)
  })
})
