import { describe, it, expect } from 'vitest'
import type { OpencodeExport } from '@generated/types'
import { extractMetrics, computeMaxParallelism, extractMetricsFromTree } from './extract.js'
import type { SessionTreeNode } from './extract.js'
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
      : { time: { start: opts.start, end: opts.end } }),
  },
  id: opts.id ?? `id-${name}`,
})

const reasoningPart = (start: number, end: number, id = 'r1') => ({
  type: 'reasoning' as const,
  text: 'think',
  time: { start, end },
  id,
})

const stepStart = (id = 'ss1') => ({ type: 'step-start' as const, id })
const stepFinish = (id = 'sf1') => ({ type: 'step-finish' as const, id })

const message = (parts: readonly Record<string, unknown>[], finish?: string): OpencodeExport['messages'][number] => {
  const info =
    finish === undefined
      ? { role: 'assistant' as const, time: { created: 0 } }
      : { role: 'assistant' as const, time: { created: 0 }, finish }
  return {
    info,
    parts: parts as unknown as OpencodeExport['messages'][number]['parts'],
  } as OpencodeExport['messages'][number]
}

const makeExport = (over: {
  readonly id?: string
  readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cacheRead: number; readonly cacheWrite: number }
  readonly cost?: number
  readonly tStart?: number
  readonly tEnd?: number
  readonly messages?: OpencodeExport['messages'][number][]
  readonly summary?: { readonly additions: number; readonly deletions: number; readonly files: number }
}): OpencodeExport => ({
  info: {
    id: over.id ?? 'sess-1',
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
    time: { created: over.tStart ?? 1000, updated: over.tEnd ?? 4000 },
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
  it('totalTokens = input + output + reasoning + cache.read (no cache.write)', () => {
    const exp = makeExport({ tokens: { input: 100, output: 200, reasoning: 50, cacheRead: 10, cacheWrite: 5 } })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.totalTokens).toBe(String(100 + 200 + 50 + 10))
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

  it('maxParallelism for a single session is 1', () => {
    const { primary } = extractMetrics(makeExport({}), null, 4)
    expect(primary.maxParallelism).toBe(1)
  })

  it('successRank is taken from the RunSideResult', () => {
    const { primary } = extractMetrics(makeExport({}), null, 3)
    expect(primary.successRank).toBe(3)
  })

  it('cost uses info.cost when no pricing table', () => {
    const exp = makeExport({ cost: 0.0123 })
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.costUsd).toBeCloseTo(0.0123, 5)
  })

  it('info.cost takes precedence over pricing when present (> 0)', () => {
    const exp = makeExport({
      cost: 0.5,
      tokens: { input: 1000000, output: 1000000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const { primary } = extractMetrics(exp, PRICING, 4)
    // pricing would yield 3.0, but info.cost (0.5) wins
    expect(primary.costUsd).toBeCloseTo(0.5, 6)
  })

  it('cost is computed from the pricing table when info.cost is 0', () => {
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

  it('perTool: interleaved tool names (not pre-grouped) still aggregate per name', () => {
    const exp = makeExport({
      messages: [
        message([
          toolPart('bash', { id: 'a', start: 0, end: 100 }),
          toolPart('read', { id: 'b', start: 0, end: 40, status: 'error' }),
          toolPart('bash', { id: 'c', start: 0, end: 300 }),
          toolPart('read', { id: 'd', start: 0, end: 60 }),
          toolPart('bash', { id: 'e', start: 0, end: 200 }),
        ]),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    const bash = secondary.perTool['bash']
    const read = secondary.perTool['read']
    expect(bash?.count).toBe(3)
    expect(bash?.avgDurationMs).toBe('200')
    expect(read?.count).toBe(2)
    expect(read?.errorRate).toBeCloseTo(0.5, 3)
    expect(read?.avgDurationMs).toBe('50')
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

  it('non-tool parts between same-tool calls do not break the run', () => {
    const exp = makeExport({
      messages: [
        message([
          toolPart('bash', { id: '1' }),
          stepFinish('sf1'),
          stepStart('ss2'),
          toolPart('bash', { id: '2' }),
          reasoningPart(0, 10, 'r1'),
          toolPart('bash', { id: '3' }),
        ]),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.maxConsecutiveSameTool).toBe(3)
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

})

// ---------------------------------------------------------------------------
// computeMaxParallelism — pure, table-tested
// ---------------------------------------------------------------------------

interface ParallelCase {
  readonly name: string
  readonly sessions: readonly { readonly timeCreated: number; readonly timeUpdated: number }[]
  readonly expected: number
}

const PARALLEL_CASES: readonly ParallelCase[] = [
  { name: 'empty -> 0', sessions: [], expected: 0 },
  { name: 'single session -> 1', sessions: [{ timeCreated: 0, timeUpdated: 100 }], expected: 1 },
  {
    name: 'two disjoint -> 1',
    sessions: [{ timeCreated: 0, timeUpdated: 100 }, { timeCreated: 200, timeUpdated: 300 }],
    expected: 1,
  },
  {
    name: 'two overlapping -> 2',
    sessions: [{ timeCreated: 0, timeUpdated: 200 }, { timeCreated: 100, timeUpdated: 300 }],
    expected: 2,
  },
  {
    name: 'three fully parallel -> 3',
    sessions: [
      { timeCreated: 0, timeUpdated: 300 },
      { timeCreated: 0, timeUpdated: 300 },
      { timeCreated: 0, timeUpdated: 300 },
    ],
    expected: 3,
  },
  {
    name: 'edge: end of one = start of next -> 1',
    sessions: [{ timeCreated: 0, timeUpdated: 100 }, { timeCreated: 100, timeUpdated: 200 }],
    expected: 1,
  },
  {
    name: 'edge: zero-duration single session (created === updated) -> 1, not 0',
    sessions: [{ timeCreated: 500, timeUpdated: 500 }],
    expected: 1,
  },
]

describe('computeMaxParallelism', () => {
  it.each(PARALLEL_CASES)('$name', ({ sessions, expected }) => {
    expect(computeMaxParallelism(sessions)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// extractMetricsFromTree — fold over a session tree
// ---------------------------------------------------------------------------

const node = (exp: OpencodeExport, depth: number, parentId: string | null): SessionTreeNode => ({
  sessionId: exp.info.id,
  parentId,
  depth,
  export: exp,
  children: [],
})

describe('extractMetricsFromTree', () => {
  it('single-node tree -> identical to extractMetrics (maxParallelism 1)', () => {
    const exp = makeExport({ tokens: { input: 360, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    const single = extractMetrics(exp, null, 4)
    const tree = extractMetricsFromTree([node(exp, 0, null)], null, 4)
    expect(tree.primary).toEqual(single.primary)
    expect(tree.primary.maxParallelism).toBe(1)
    expect(tree.primary.totalTokens).toBe('360')
  })

  it('sums totalTokens / stepCount / toolCallCount across nodes', () => {
    const root = makeExport({ id: 'root', tokens: { input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    const child = makeExport({ id: 'child', tokens: { input: 50, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } })
    const { primary } = extractMetricsFromTree([node(root, 0, null), node(child, 1, 'root')], null, 4)
    expect(primary.totalTokens).toBe('150')
    expect(primary.stepCount).toBe(0)
    expect(primary.toolCallCount).toBe(0)
  })

  it('wallClockMs is the outer envelope, not the sum', () => {
    const root = makeExport({ id: 'root', tStart: 0, tEnd: 1000 })
    const child = makeExport({ id: 'child', tStart: 200, tEnd: 800 })
    const { primary } = extractMetricsFromTree([node(root, 0, null), node(child, 1, 'root')], null, 4)
    expect(primary.wallClockMs).toBe('1000')
  })

  it('maxParallelism reflects overlapping child intervals', () => {
    const root = makeExport({ id: 'root', tStart: 0, tEnd: 1000 })
    const child = makeExport({ id: 'child', tStart: 200, tEnd: 800 })
    const { primary } = extractMetricsFromTree([node(root, 0, null), node(child, 1, 'root')], null, 4)
    expect(primary.maxParallelism).toBe(2)
  })

  it('non-overlapping nodes -> maxParallelism 1', () => {
    const root = makeExport({ id: 'root', tStart: 0, tEnd: 100 })
    const child = makeExport({ id: 'child', tStart: 200, tEnd: 300 })
    const { primary } = extractMetricsFromTree([node(root, 0, null), node(child, 1, 'root')], null, 4)
    expect(primary.maxParallelism).toBe(1)
  })

  it('single-node tree with a zero-duration session (created === updated) -> maxParallelism 1, not 0', () => {
    const exp = makeExport({ id: 'root', tStart: 500, tEnd: 500 })
    const { primary } = extractMetricsFromTree([node(exp, 0, null)], null, 4)
    expect(primary.maxParallelism).toBe(1)
  })

  it('costUsd sums info.cost across nodes', () => {
    const root = makeExport({ id: 'root', cost: 0.01 })
    const child = makeExport({ id: 'child', cost: 0.02 })
    const { primary } = extractMetricsFromTree([node(root, 0, null), node(child, 1, 'root')], null, 4)
    expect(primary.costUsd).toBeCloseTo(0.03, 5)
  })

  it('successRank comes from the argument (root-owned)', () => {
    const root = makeExport({})
    const { primary } = extractMetricsFromTree([node(root, 0, null)], null, 3)
    expect(primary.successRank).toBe(3)
  })

  it('empty tree -> zeroed metrics with the given successRank', () => {
    const tree = extractMetricsFromTree([], null, 2)
    expect(tree.primary.totalTokens).toBe('0')
    expect(tree.primary.maxParallelism).toBe(0)
    expect(tree.primary.successRank).toBe(2)
  })

  it('secondary sums token counts and merges perTool across nodes', () => {
    const root = makeExport({
      id: 'root',
      tokens: { input: 100, output: 200, reasoning: 50, cacheRead: 10, cacheWrite: 0 },
      messages: [message([toolPart('bash', { id: 'a', start: 0, end: 100 })])],
    })
    const child = makeExport({
      id: 'child',
      tokens: { input: 30, output: 40, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      messages: [message([toolPart('bash', { id: 'b', start: 0, end: 200, status: 'error' })])],
    })
    const { secondary } = extractMetricsFromTree([node(root, 0, null), node(child, 1, 'root')], null, 4)
    expect(secondary.inputTokens).toBe('130')
    expect(secondary.outputTokens).toBe('240')
    // bash: 2 calls, 1 error -> 0.5
    expect(secondary.perTool['bash']?.count).toBe(2)
    expect(secondary.perTool['bash']?.errorRate).toBeCloseTo(0.5, 3)
  })
})
