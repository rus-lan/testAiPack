import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { OpencodeExport } from '@generated/types'
import { exportPartSchema, opencodeExportSchema } from '@generated/schemas'
import { extractMetrics, computeMaxParallelism, extractMetricsFromTree, findPhaseBoundary } from './extract.js'
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

/**
 * Message builder for phase-split tests: unlike {@link message}, this one
 * controls `role` and `time.created` (the boundary marker inputs) and an
 * optional message-level `tokens`/`cost` (the phase-slice inputs).
 */
const msg = (over: {
  readonly role?: 'user' | 'assistant'
  readonly created?: number
  readonly tokens?: { readonly input: number; readonly output: number; readonly reasoning?: number; readonly cacheRead?: number; readonly cacheWrite?: number }
  readonly cost?: number
  readonly parts?: readonly Record<string, unknown>[]
} = {}): OpencodeExport['messages'][number] => ({
  info: {
    role: over.role ?? 'assistant',
    time: { created: over.created ?? 0 },
    ...(over.tokens === undefined
      ? {}
      : {
          tokens: {
            input: over.tokens.input,
            output: over.tokens.output,
            reasoning: over.tokens.reasoning ?? 0,
            cache: { read: over.tokens.cacheRead ?? 0, write: over.tokens.cacheWrite ?? 0 },
          },
        }),
    ...(over.cost === undefined ? {} : { cost: over.cost }),
  },
  parts: (over.parts ?? []) as unknown as OpencodeExport['messages'][number]['parts'],
})

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

  it('finishCauseDistribution counts `unknown` like any other cause — no special-casing needed', () => {
    const exp = makeExport({
      messages: [
        message([], 'stop'),
        message([], 'unknown'),
        message([], 'unknown'),
      ],
    })
    const { secondary } = extractMetrics(exp, null, 4)
    expect(secondary.finishCauseDistribution['stop']).toBe(1)
    expect(secondary.finishCauseDistribution['unknown']).toBe(2)
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
// exportPartSchema / extractMetrics — interrupted/malformed parts (regression:
// an interrupted reasoning/tool part carries time.start with no end; a part
// failing its typed schema falls through to the tolerant catch-all, which
// strips every field except type/id)
// ---------------------------------------------------------------------------

describe('exportPartSchema — end-optional contract', () => {
  it('reasoning part with time.start but no time.end validates as ExportReasoningPart, not the catch-all', () => {
    const input = { type: 'reasoning', text: 'hello', time: { start: 100 }, id: 'r1' }
    const result = exportPartSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual(input)
  })

  it('tool part with state.time.start but no state.time.end validates as ExportToolPart, not the catch-all', () => {
    const input = {
      type: 'tool',
      tool: 'bash',
      callID: 'c1',
      state: { status: 'running', input: {}, time: { start: 100 } },
      id: 't1',
    }
    const result = exportPartSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual(input)
  })

  it('reasoning part missing time entirely still falls through to the catch-all (stripped to {type, id})', () => {
    const result = exportPartSchema.safeParse({ type: 'reasoning', id: 'r2' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ type: 'reasoning', id: 'r2' })
  })

  it('tool part missing state entirely still falls through to the catch-all (stripped to {type, id})', () => {
    const result = exportPartSchema.safeParse({ type: 'tool', id: 't2' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ type: 'tool', id: 't2' })
  })

  it('text part missing text entirely still falls through to the catch-all (stripped to {type, id})', () => {
    const result = exportPartSchema.safeParse({ type: 'text', id: 'x2' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ type: 'text', id: 'x2' })
  })

  it('tool part with a pending state and no input validates as ExportToolPart, not the catch-all', () => {
    const input = { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'pending' }, id: 't1' }
    const result = exportPartSchema.safeParse(input)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual(input)
  })
})

describe('extractMetrics — interrupted/malformed parts', () => {
  it('reasoning part with time.start but no time.end -> validates as reasoning (text kept), duration counted as 0', () => {
    const raw = makeExport({
      messages: [message([{ type: 'reasoning', text: 'hello', time: { start: 100 }, id: 'r-interrupted' }])],
    })
    const parsed = opencodeExportSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const exp = parsed.data as OpencodeExport
    expect(() => extractMetrics(exp, null, 4)).not.toThrow()
    const { secondary, extras } = extractMetrics(exp, null, 4)
    expect(extras.reasoningChars).toBe(5)
    expect(secondary.reasoningTimeMs).toBe('0')
  })

  it('reasoning part already stripped to {type, id} (no text/time) -> excluded, no throw', () => {
    const exp = makeExport({ messages: [message([{ type: 'reasoning', id: 'r-stripped' }])] })
    expect(() => extractMetrics(exp, null, 4)).not.toThrow()
    const { secondary, extras } = extractMetrics(exp, null, 4)
    expect(extras.reasoningChars).toBe(0)
    expect(secondary.reasoningTimeMs).toBe('0')
  })

  it('tool part with state.time.start but no state.time.end -> validates as tool (counted), duration excluded from the average', () => {
    const raw = makeExport({
      messages: [
        message([
          {
            type: 'tool',
            tool: 'bash',
            callID: 'call-interrupted',
            state: { status: 'error', input: {}, time: { start: 100 } },
            id: 'tool-interrupted',
          },
        ]),
      ],
    })
    const parsed = opencodeExportSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const exp = parsed.data as OpencodeExport
    expect(() => extractMetrics(exp, null, 4)).not.toThrow()
    const { primary, secondary } = extractMetrics(exp, null, 4)
    expect(primary.toolCallCount).toBe(1)
    expect(secondary.toolLatencyAvgMs).toBe('0')
  })

  it('tool part already stripped to {type, id} (no state) -> excluded from toolCallCount, no throw', () => {
    const exp = makeExport({ messages: [message([{ type: 'tool', id: 't-stripped' }])] })
    expect(() => extractMetrics(exp, null, 4)).not.toThrow()
    const { primary } = extractMetrics(exp, null, 4)
    expect(primary.toolCallCount).toBe(0)
  })

  it('text part already stripped to {type, id} (no text) -> excluded from textChars, no throw', () => {
    const exp = makeExport({ messages: [message([{ type: 'text', id: 'tx' }])] })
    expect(() => extractMetrics(exp, null, 4)).not.toThrow()
    const { extras } = extractMetrics(exp, null, 4)
    expect(extras.textChars).toBe(0)
  })

  it('an end-less tool call is excluded from the latency average, not counted as a 0ms sample', () => {
    const raw = makeExport({
      messages: [
        message([
          toolPart('bash', { id: 'done', start: 0, end: 200 }),
          {
            type: 'tool',
            tool: 'bash',
            callID: 'call-running',
            state: { status: 'running', input: {}, time: { start: 300 } },
            id: 'running',
          },
        ]),
      ],
    })
    const parsed = opencodeExportSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const exp = parsed.data as OpencodeExport
    const { secondary } = extractMetrics(exp, null, 4)
    // Only the measured 200ms call feeds the average; the unmeasured call is
    // excluded, not counted as a 0ms sample.
    expect(secondary.toolLatencyAvgMs).toBe('200')
    expect(secondary.perTool['bash']?.count).toBe(2)
    expect(secondary.perTool['bash']?.avgDurationMs).toBe('200')
  })

  it('pending tool call with no input validates as a real tool part, is counted, and creates no phantom duplicate', () => {
    const raw = makeExport({
      messages: [
        message([
          { type: 'tool', tool: 'bash', callID: 'call-pending-1', state: { status: 'pending' }, id: 'pending-1' },
          { type: 'tool', tool: 'bash', callID: 'call-pending-2', state: { status: 'pending' }, id: 'pending-2' },
        ]),
      ],
    })
    const parsed = opencodeExportSchema.safeParse(raw)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const exp = parsed.data as OpencodeExport
    expect(() => extractMetrics(exp, null, 4)).not.toThrow()
    const { primary, extras } = extractMetrics(exp, null, 4)
    expect(primary.toolCallCount).toBe(2)
    expect(extras.duplicateToolCalls).toBe(0)
  })

  it('well-formed text/reasoning/tool parts are unaffected (no shift from the stronger guards)', () => {
    const exp = makeExport({
      messages: [
        message([
          { type: 'text', text: 'hi', id: 'txt1' },
          reasoningPart(0, 100),
          toolPart('bash', { id: 'ok', start: 0, end: 200 }),
        ]),
      ],
    })
    const { primary, secondary, extras } = extractMetrics(exp, null, 4)
    expect(primary.toolCallCount).toBe(1)
    expect(secondary.reasoningTimeMs).toBe('100')
    expect(secondary.toolLatencyAvgMs).toBe('200')
    expect(extras.textChars).toBe(2)
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

// ---------------------------------------------------------------------------
// findPhaseBoundary — the init/task boundary marker (metric-split spec §2.1)
// ---------------------------------------------------------------------------

describe('findPhaseBoundary', () => {
  it('2 user messages -> boundary at the 2nd (its index and info.time.created)', () => {
    const exp = makeExport({
      messages: [
        msg({ role: 'user', created: 100 }),
        msg({ role: 'assistant', created: 150 }),
        msg({ role: 'user', created: 900 }),
        msg({ role: 'assistant', created: 950 }),
      ],
    })
    expect(findPhaseBoundary(exp)).toEqual({ boundaryIndex: 2, boundaryTs: 900 })
  })

  it('1 user message -> undefined (no init ran)', () => {
    const exp = makeExport({ messages: [msg({ role: 'user', created: 0 }), msg({ role: 'assistant', created: 10 })] })
    expect(findPhaseBoundary(exp)).toBeUndefined()
  })

  it('0 user messages -> undefined', () => {
    const exp = makeExport({ messages: [msg({ role: 'assistant', created: 10 })] })
    expect(findPhaseBoundary(exp)).toBeUndefined()
  })

  it('3+ user messages (defensive, never observed in practice) -> still U[1]', () => {
    const exp = makeExport({
      messages: [
        msg({ role: 'user', created: 0 }),
        msg({ role: 'user', created: 100 }),
        msg({ role: 'user', created: 200 }),
      ],
    })
    expect(findPhaseBoundary(exp)).toEqual({ boundaryIndex: 1, boundaryTs: 100 })
  })
})

// ---------------------------------------------------------------------------
// extractMetrics — phases (metric-split spec §2/§3): conservation + cost
// precedence, on synthetic exports.
// ---------------------------------------------------------------------------

describe('extractMetrics — phases: conservation', () => {
  it('init + task === whole for totalTokens/stepCount/toolCallCount/wallClockMs', () => {
    const exp = makeExport({
      tStart: 0,
      tEnd: 1000,
      messages: [
        msg({ role: 'user', created: 0 }),
        msg({
          role: 'assistant',
          created: 10,
          tokens: { input: 100, output: 20 },
          parts: [stepStart('a'), toolPart('bash', { id: 'i1' }), stepFinish('a')],
        }),
        msg({ role: 'user', created: 500 }),
        msg({
          role: 'assistant',
          created: 510,
          tokens: { input: 300, output: 50 },
          parts: [stepStart('b'), toolPart('ls', { id: 't1' }), toolPart('read', { id: 't2' }), stepFinish('b')],
        }),
      ],
    })
    const { phases } = extractMetrics(exp, null, 4)
    expect(phases.init).toBeDefined()
    const init = phases.init!
    expect(init.totalTokens + phases.task.totalTokens).toBe(100 + 20 + 300 + 50)
    expect(init.stepCount + phases.task.stepCount).toBe(2)
    expect(init.toolCallCount + phases.task.toolCallCount).toBe(3)
    expect(init.wallClockMs + phases.task.wallClockMs).toBe(1000)
    expect(init.totalTokens).toBe(120)
    expect(phases.task.totalTokens).toBe(350)
  })

  it('no boundary -> whole export is the task slice, init absent', () => {
    const exp = makeExport({
      tStart: 0,
      tEnd: 500,
      messages: [msg({ role: 'user', created: 0 }), msg({ role: 'assistant', created: 10, tokens: { input: 50, output: 10 } })],
    })
    const { phases } = extractMetrics(exp, null, 4)
    expect(phases.init).toBeUndefined()
    expect(phases.task.totalTokens).toBe(60)
    expect(phases.task.wallClockMs).toBe(500)
  })
})

describe('extractMetrics — phases: cost precedence (spec §3)', () => {
  const initTaskExport = (over: {
    readonly sessionCost?: number
    readonly initCost?: number
    readonly taskCost?: number
    readonly initTokens?: { readonly input: number; readonly output: number }
    readonly taskTokens?: { readonly input: number; readonly output: number }
  }): OpencodeExport =>
    makeExport({
      cost: over.sessionCost ?? 0,
      messages: [
        msg({ role: 'user', created: 0 }),
        msg({
          role: 'assistant',
          created: 10,
          ...(over.initCost === undefined ? {} : { cost: over.initCost }),
          ...(over.initTokens === undefined ? {} : { tokens: over.initTokens }),
        }),
        msg({ role: 'user', created: 500 }),
        msg({
          role: 'assistant',
          created: 510,
          ...(over.taskCost === undefined ? {} : { cost: over.taskCost }),
          ...(over.taskTokens === undefined ? {} : { tokens: over.taskTokens }),
        }),
      ],
    })

  it('per-message cost sum > 0 -> measured, not prorated', () => {
    const exp = initTaskExport({ initCost: 0.01, taskCost: 0.02 })
    const { phases } = extractMetrics(exp, null, 4)
    expect(phases.init!.costUsd).toBeCloseTo(0.01, 6)
    expect(phases.init!.costProrated).toBe(false)
    expect(phases.task.costUsd).toBeCloseTo(0.02, 6)
    expect(phases.task.costProrated).toBe(false)
  })

  it('session cost > 0, per-message costs all 0 -> prorated by slice token share, flagged', () => {
    const exp = initTaskExport({
      sessionCost: 1.0,
      initTokens: { input: 100, output: 0 },
      taskTokens: { input: 300, output: 0 },
    })
    const { phases } = extractMetrics(exp, null, 4)
    // whole totalTokens = 400; init share 100/400 = 0.25, task share 0.75
    expect(phases.init!.costUsd).toBeCloseTo(0.25, 6)
    expect(phases.init!.costProrated).toBe(true)
    expect(phases.task.costUsd).toBeCloseTo(0.75, 6)
    expect(phases.task.costProrated).toBe(true)
  })

  it('no session cost, pricing table present -> pricing applied to slice tokens, not prorated', () => {
    const exp = initTaskExport({
      initTokens: { input: 1_000_000, output: 0 },
      taskTokens: { input: 0, output: 1_000_000 },
    })
    const { phases } = extractMetrics(exp, PRICING, 4)
    expect(phases.init!.costUsd).toBeCloseTo(1.0, 6) // 1M input @ $1/M
    expect(phases.init!.costProrated).toBe(false)
    expect(phases.task.costUsd).toBeCloseTo(2.0, 6) // 1M output @ $2/M
    expect(phases.task.costProrated).toBe(false)
  })

  it('no session cost, no pricing table -> 0, not prorated', () => {
    const exp = initTaskExport({})
    const { phases } = extractMetrics(exp, null, 4)
    expect(phases.init!.costUsd).toBe(0)
    expect(phases.init!.costProrated).toBe(false)
    expect(phases.task.costUsd).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// extractMetricsFromTree — phase attribution over a session tree (spec §2.2/§5.2)
// ---------------------------------------------------------------------------

describe('extractMetricsFromTree — phase attribution', () => {
  it('non-root node created before the root boundary -> init; at/after -> task', () => {
    const root = makeExport({
      id: 'root',
      tStart: 0,
      tEnd: 1000,
      messages: [
        msg({ role: 'user', created: 0 }),
        msg({ role: 'assistant', created: 10, tokens: { input: 10, output: 0 } }),
        msg({ role: 'user', created: 500 }),
        msg({ role: 'assistant', created: 510, tokens: { input: 20, output: 0 } }),
      ],
    })
    const childInit = makeExport({
      id: 'child-init',
      tStart: 100,
      tEnd: 200,
      cost: 0.01,
      tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const childTask = makeExport({
      id: 'child-task',
      tStart: 600,
      tEnd: 700,
      cost: 0.02,
      tokens: { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const tree = [node(root, 0, null), node(childInit, 1, 'root'), node(childTask, 1, 'root')]
    const { phases } = extractMetricsFromTree(tree, null, 4)
    expect(phases.init).toBeDefined()
    const init = phases.init!
    // root's own init slice (10) + childInit's whole node total (5)
    expect(init.totalTokens).toBe(15)
    expect(init.costUsd).toBeCloseTo(0.01, 6)
    // root's own task slice (20) + childTask's whole node total (7)
    expect(phases.task.totalTokens).toBe(27)
    expect(phases.task.costUsd).toBeCloseTo(0.02, 6)
    // wall-clock stays root-only — a sub-agent's interval already sits inside
    // the root's window, so it is not added a second time.
    expect(init.wallClockMs).toBe(500)
    expect(phases.task.wallClockMs).toBe(500)
  })

  it('no boundary on the root -> every node lands in task, including non-root nodes', () => {
    const root = makeExport({
      id: 'root',
      tStart: 0,
      tEnd: 100,
      messages: [msg({ role: 'user', created: 0 }), msg({ role: 'assistant', created: 10, tokens: { input: 5, output: 0 } })],
    })
    const child = makeExport({
      id: 'child',
      tStart: 10,
      tEnd: 50,
      tokens: { input: 3, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    })
    const tree = [node(root, 0, null), node(child, 1, 'root')]
    const { phases } = extractMetricsFromTree(tree, null, 4)
    expect(phases.init).toBeUndefined()
    expect(phases.task.totalTokens).toBe(8)
  })

  it('empty tree -> zeroed task-only phases (no fabricated init)', () => {
    const { phases } = extractMetricsFromTree([], null, 2)
    expect(phases.init).toBeUndefined()
    expect(phases.task).toEqual({ totalTokens: 0, wallClockMs: 0, costUsd: 0, stepCount: 0, toolCallCount: 0, costProrated: false })
  })
})

// ---------------------------------------------------------------------------
// Real ground truth — evidence workspace from .research/metric-split/spec.md
// §2.3/§7.1 (10x2 runs, graphify pack, --init-side new). Read-only; the whole
// block skips cleanly when the workspace isn't present on this machine, same
// pattern as the GOLDEN_ROOT blocks in events-profile.test.ts / aggregate.test.ts.
// ---------------------------------------------------------------------------

const EVIDENCE_B348A2 = '/home/ruslan/.testaipack/2026-07-30_09-25-09_b348a2/results/raw'
const EVIDENCE_B10A40 = '/home/ruslan/.testaipack/2026-07-30_08-15-10_b10a40/results/raw'

describe.skipIf(!existsSync(EVIDENCE_B348A2))('phase split — real ground truth (b348a2)', () => {
  it('new/run-1: boundary at index 16; init/task sums equal the whole exactly', () => {
    const raw = JSON.parse(
      readFileSync(path.join(EVIDENCE_B348A2, 'new', 'run-1.json'), 'utf8'),
    ) as OpencodeExport
    const boundary = findPhaseBoundary(raw)
    expect(boundary).toEqual({ boundaryIndex: 16, boundaryTs: 1785403949677 })

    const { phases } = extractMetrics(raw, null, 4)
    expect(phases.init).toEqual({
      totalTokens: 256535,
      wallClockMs: 288911,
      costUsd: 0,
      stepCount: 15,
      toolCallCount: 14,
      costProrated: false,
    })
    expect(phases.task).toEqual({
      totalTokens: 405789,
      wallClockMs: 303490,
      costUsd: 0,
      stepCount: 15,
      toolCallCount: 14,
      costProrated: false,
    })
    // Conservation against the whole-run values extractMetrics also computes.
    const { primary } = extractMetrics(raw, null, 4)
    expect(phases.init!.totalTokens + phases.task.totalTokens).toBe(Number(primary.totalTokens))
    expect(phases.init!.stepCount + phases.task.stepCount).toBe(primary.stepCount)
    expect(phases.init!.toolCallCount + phases.task.toolCallCount).toBe(primary.toolCallCount)
    expect(phases.init!.wallClockMs + phases.task.wallClockMs).toBe(Number(primary.wallClockMs))
  })

  it('old/run-1: no init ran (--init-side new) -> 1 user message, whole export is task', () => {
    const raw = JSON.parse(
      readFileSync(path.join(EVIDENCE_B348A2, 'old', 'run-1.json'), 'utf8'),
    ) as OpencodeExport
    expect(findPhaseBoundary(raw)).toBeUndefined()
    const { phases, primary } = extractMetrics(raw, null, 4)
    expect(phases.init).toBeUndefined()
    expect(phases.task.totalTokens).toBe(Number(primary.totalTokens))
    expect(phases.task.wallClockMs).toBe(Number(primary.wallClockMs))
  })
})

describe.skipIf(!existsSync(EVIDENCE_B10A40))('phase split — real ground truth (b10a40)', () => {
  it('new/run-1: boundary at index 3; init/task sums equal the whole exactly', () => {
    const raw = JSON.parse(
      readFileSync(path.join(EVIDENCE_B10A40, 'new', 'run-1.json'), 'utf8'),
    ) as OpencodeExport
    const boundary = findPhaseBoundary(raw)
    expect(boundary).toEqual({ boundaryIndex: 3, boundaryTs: 1785399540254 })

    const { phases, primary } = extractMetrics(raw, null, 4)
    expect(phases.init).toEqual({
      totalTokens: 22696,
      wallClockMs: 79379,
      costUsd: 0,
      stepCount: 2,
      toolCallCount: 1,
      costProrated: false,
    })
    expect(phases.task.totalTokens).toBe(211633)
    expect(phases.init!.totalTokens + phases.task.totalTokens).toBe(Number(primary.totalTokens))
    expect(phases.init!.wallClockMs + phases.task.wallClockMs).toBe(Number(primary.wallClockMs))
  })
})
