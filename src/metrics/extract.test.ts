import { describe, it, expect } from 'vitest'
import type { OpencodeExport } from '@generated/types'
import { extractMetrics } from './extract.js'
import type { PricingTable } from '../pricing/lookup.js'

const toolPart = (
  name: string,
  opts: { readonly status?: 'completed' | 'error'; readonly start?: number; readonly end?: number; readonly id?: string } = {},
) => ({
  type: 'tool' as const,
  tool: name,
  callID: `call-${opts.id ?? name}`,
  state: {
    status: opts.status ?? 'completed',
    input: {},
    ...(opts.start === undefined || opts.end === undefined
      ? {}
      : { time: { start: String(opts.start), end: String(opts.end) } }),
  },
  id: opts.id ?? `id-${name}`,
})

const reasoningPart = (start: number, end: number, id = 'r1') => ({
  type: 'reasoning' as const,
  text: 'think',
  time: { start: String(start), end: String(end) },
  id,
})

const stepStart = (id = 'ss1') => ({ type: 'step-start' as const, id })
const stepFinish = (id = 'sf1') => ({ type: 'step-finish' as const, id })

const message = (parts: readonly Record<string, unknown>[], finish?: string): OpencodeExport['messages'][number] => {
  const info =
    finish === undefined
      ? { role: 'assistant' as const, time: { created: '0' } }
      : { role: 'assistant' as const, time: { created: '0' }, finish }
  return {
    info,
    parts: parts as unknown as OpencodeExport['messages'][number]['parts'],
  } as OpencodeExport['messages'][number]
}

const makeExport = (over: {
  readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number }
  readonly cost?: number
  readonly tStart?: number
  readonly tEnd?: number
  readonly messages?: OpencodeExport['messages'][number][]
  readonly summary?: { readonly additions: number; readonly deletions: number; readonly files: number }
}): OpencodeExport => ({
  info: {
    id: 'sess-1',
    slug: 's',
    projectID: 'p',
    directory: '/x',
    title: 't',
    agent: 'a',
    model: { id: 'm', providerID: 'prov' },
    version: '1',
    summary: over.summary ?? { additions: 3, deletions: 1, files: 2 },
    cost: over.cost ?? 0,
    tokens: {
      input: over.tokens?.input ?? 100,
      output: over.tokens?.output ?? 200,
      reasoning: over.tokens?.reasoning ?? 50,
      cache: { read: over.tokens?.cacheRead ?? 10, write: over.tokens?.cacheWrite ?? 5 },
    },
    time: { created: String(over.tStart ?? 1000), updated: String(over.tEnd ?? 4000) },
  },
  messages: over.messages ?? [],
})

const PRICING: PricingTable = {
  version: '1',
  providers: {
    prov: {
      m: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
    },
  },
  fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

describe('extractMetrics — primary', () => {
  it('totalTokens = input + output + reasoning + cache.read + cache.write', () => {
    const exp = makeExport({ tokens: { input: 100, output: 200, reasoning: 50, cacheRead: 10, cacheWrite: 5 } })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.totalTokens).toBe(String(100 + 200 + 50 + 10 + 5))
  })

  it('wallClockMs = updated - created', () => {
    const exp = makeExport({ tStart: 1000, tEnd: 4000 })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.wallClockMs).toBe('3000')
  })

  it('stepCount counts step-finish parts across all messages', () => {
    const exp = makeExport({ messages: [message([stepStart('a'), stepFinish('a'), stepStart('b'), stepFinish('b')])] })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.stepCount).toBe(2)
  })

  it('toolCallCount counts tool parts across all messages', () => {
    const exp = makeExport({ messages: [message([toolPart('bash', { id: '1' }), toolPart('ls', { id: '2' })])] })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.toolCallCount).toBe(2)
  })

  it('maxParallelism is always 1 in v0.1', () => {
    const { primary } = extractMetrics(makeExport({}), null, 4)
    expect(primary.maxParallelism).toBe(1)
  })

  it('successRank is taken from the RunSideResult', () => {
    const { primary } = extractMetrics(makeExport({}), null, 3)
    expect(primary.successRank).toBe(3)
  })

  it('cost falls back to info.cost when no pricing table', () => {
    const exp = makeExport({ cost: 0.0123 })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.costUsd).toBeCloseTo(0.0123, 5)
  })

  it('cost is computed from the pricing table when provided', () => {
    const exp = makeExport({ tokens: { input: 1000000, output: 1000000, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    const { primary } = extractMetrics(exp, PRICING, 4)
    // 1M input @1 + 1M output @2 = 3.0
    expect(primary.costUsd).toBeCloseTo(3.0, 6)
  })
})

describe('extractMetrics — secondary', () => {
  it('perTool: 3 bash (1 error) -> count 3, errorRate ~0.333', () => {
    const exp = makeExport({
      messages: [
        message([
          toolPart('bash', { id: 'a', start: 0, end: 100 }),
          toolPart('bash', { id: 'b', start: 0, end: 200, status: 'error' }),
          toolPart('bash', { id: 'c', start: 0, end: 300 }),
        ]),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    const bash = secondary.perTool['bash']
    expect(bash?.count).toBe(3)
    expect(bash?.errorRate).toBeCloseTo(1 / 3, 3)
    // avg duration = (100 + 200 + 300) / 3 = 200
    expect(bash?.avgDurationMs).toBe('200')
  })

  it('maxConsecutiveSameTool: 5 identical bash in a row -> 5', () => {
    const exp = makeExport({
      messages: [
        message([
          toolPart('bash', { id: '1' }),
          toolPart('bash', { id: '2' }),
          toolPart('bash', { id: '3' }),
          toolPart('bash', { id: '4' }),
          toolPart('bash', { id: '5' }),
        ]),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.maxConsecutiveSameTool).toBe(5)
  })

  it('a different tool resets the consecutive run', () => {
    const exp = makeExport({
      messages: [message([toolPart('bash', { id: '1' }), toolPart('ls', { id: '2' }), toolPart('bash', { id: '3' })])],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.maxConsecutiveSameTool).toBe(1)
  })

  it('finishCauseDistribution counts per finish cause', () => {
    const exp = makeExport({
      messages: [
        message([], 'stop'),
        message([], 'tool-calls'),
        message([], 'stop'),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.finishCauseDistribution['stop']).toBe(2)
    expect(secondary.finishCauseDistribution['tool-calls']).toBe(1)
  })

  it('stepLatency sums timed parts inside each step region; P50/P95 reflect it', () => {
    const exp = makeExport({
      messages: [
        message([
          stepStart('a'),
          reasoningPart(0, 100), // 100ms reasoning
          toolPart('bash', { id: 'x', start: 100, end: 400 }), // 300ms tool
          stepFinish('a'),
        ]),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.stepLatencyP50Ms).toBe('400')
    expect(secondary.stepLatencyP95Ms).toBe('400')
    expect(secondary.reasoningTimeMs).toBe('100')
    expect(secondary.toolLatencyAvgMs).toBe('300')
  })

  it('fileDiffStats mirrors info.summary', () => {
    const exp = makeExport({ summary: { additions: 42, deletions: 7, files: 3 } })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.fileDiffStats).toEqual({ additions: 42, deletions: 7, filesChanged: 3 })
  })
})
