import { Data, Effect } from 'effect'
import { readFile } from '../util/fs.js'

export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface PricingTable {
  readonly version: string
  readonly providers: Readonly<Record<string, Readonly<Record<string, ModelPrice>>>>
  readonly fallback: ModelPrice
}

export class PricingError extends Data.TaggedError('PricingError')<{
  readonly path: string
  readonly reason: string
  readonly cause?: unknown
}> {}

const isNumber = (u: unknown): u is number => typeof u === 'number' && !Number.isNaN(u)

const isModelPrice = (u: unknown): u is ModelPrice => {
  if (typeof u !== 'object' || u === null) return false
  const o = u as Record<string, unknown>
  return (
    isNumber(o['input']) &&
    isNumber(o['output']) &&
    isNumber(o['cacheRead']) &&
    isNumber(o['cacheWrite'])
  )
}

const validateTable = (raw: unknown, filePath: string): PricingTable => {
  if (typeof raw !== 'object' || raw === null) {
    throw new PricingError({ path: filePath, reason: 'pricing root must be an object' })
  }
  const root = raw as Record<string, unknown>
  if (typeof root['version'] !== 'string') {
    throw new PricingError({ path: filePath, reason: 'pricing.version must be a string' })
  }
  if (typeof root['providers'] !== 'object' || root['providers'] === null) {
    throw new PricingError({ path: filePath, reason: 'pricing.providers must be an object' })
  }
  const providers = root['providers'] as Record<string, unknown>
  for (const [provider, models] of Object.entries(providers)) {
    if (typeof models !== 'object' || models === null) {
      throw new PricingError({
        path: filePath,
        reason: `provider "${provider}" must be an object`,
      })
    }
    const modelMap = models as Record<string, unknown>
    for (const [model, price] of Object.entries(modelMap)) {
      if (!isModelPrice(price)) {
        throw new PricingError({
          path: filePath,
          reason: `price for ${provider}/${model} must have numeric input/output/cacheRead/cacheWrite`,
        })
      }
    }
  }
  if (!isModelPrice(root['fallback'])) {
    throw new PricingError({ path: filePath, reason: 'pricing.fallback must be a ModelPrice' })
  }
  return {
    version: root['version'],
    providers: root['providers'] as PricingTable['providers'],
    fallback: root['fallback'],
  }
}

export const loadPricing = (
  path: string,
): Effect.Effect<PricingTable, PricingError> =>
  Effect.gen(function* () {
    const content = yield* readFile(path).pipe(
      Effect.mapError(
        (e) =>
          new PricingError({
            path,
            reason: 'file-not-readable',
            cause: e,
          }),
      ),
    )
    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (e) => new PricingError({ path, reason: 'invalid-json', cause: e }),
    })
    return yield* Effect.try({
      try: () => validateTable(parsed, path),
      catch: (e) =>
        e instanceof PricingError
          ? e
          : new PricingError({ path, reason: 'unexpected', cause: e }),
    })
  })

export const lookupPrice = (
  table: PricingTable,
  provider: string,
  model: string,
): ModelPrice => {
  const models = table.providers[provider]
  if (models === undefined) return table.fallback
  const price = models[model]
  if (price === undefined) return table.fallback
  return price
}

export const computeCost = (
  price: ModelPrice,
  tokens: {
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  },
): number => {
  const million = 1_000_000
  return (
    (tokens.input / million) * price.input +
    (tokens.output / million) * price.output +
    (tokens.cache.read / million) * price.cacheRead +
    (tokens.cache.write / million) * price.cacheWrite
  )
}
