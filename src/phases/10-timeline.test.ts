import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeJson } from '../util/fs.js'
import {
  timeline,
  extractEventsFromExport,
  collapseRepeats,
  renderTimelineHtml,
} from './10-timeline.js'
import { PhaseError } from '../errors.js'
import type {
  Manifest,
  OpencodeExport,
  RunInput,
  RunSideResult,
  Side,
  Timeline,
  TimelineEvent,
  TimelineMode,
  WorkspaceTree,
} from '@generated/types'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRunInput = (over: Partial<RunInput>): RunInput => ({
  repoUrl: '',
  prompt: 'p',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: false, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  pureBaseline: true,
  preflightEnabled: true,
  formats: ['md', 'html'],
  outputPath: './results',
  diffHtml: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60, runSeconds: 600, verifySeconds: 300,
    installSeconds: 300, watchdogSeconds: 1200,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  ...over,
})

const fakeManifest: Manifest = {
  runId: 'rid-tl',
  timestamp: '2026-07-21T00:00:00.000Z',
  repoUrl: '',
  prompt: 'p',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '1.0.0',
  flagDefaults: {},
}

const makeWorkspace = async (runs: number): Promise<WorkspaceTree> => {
  const root = makeTempDir()
  const range = Array.from({ length: runs }, (_, i) => i + 1)
  const tree: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'apps', 'source'),
    appsOld: range.map((n) => path.join(root, 'apps', 'oldVersion', `run-${String(n)}`)),
    appsNew: range.map((n) => path.join(root, 'apps', 'newVersion', `run-${String(n)}`)),
    pack: path.join(root, 'pack'),
    homeOld: [],
    homeNew: [],
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'results', 'raw'),
    diff: path.join(root, 'results', 'diff'),
  }
  await runP(ensureDir(path.join(tree.raw, 'old')))
  await runP(ensureDir(path.join(tree.raw, 'new')))
  await runP(ensureDir(tree.results))
  return tree
}

const sideResult = (side: Side, runIndex: number, successRank = 4): RunSideResult => ({
  side,
  runIndex,
  exportPath: '',
  eventsLogPath: '',
  successRank,
  finishCause: 'stop',
  exitCode: 0,
  durationMs: '0',
  watchdogTriggered: false,
})

type PartBuilder = Record<string, unknown>

const textPart = (text: string, id = 't1'): PartBuilder => ({ type: 'text', text, id })
const reasoningPart = (start: number, end: number, id = 'r1'): PartBuilder => ({
  type: 'reasoning', text: 'thinking', time: { start: String(start), end: String(end) }, id,
})
const toolPart = (
  tool: string,
  status: 'pending' | 'running' | 'completed' | 'error' = 'completed',
  start?: number,
  end?: number,
  id = 'tool1',
): PartBuilder => ({
  type: 'tool',
  tool,
  callID: 'c1',
  state: {
    status,
    input: {},
    ...(start !== undefined && end !== undefined ? { time: { start: String(start), end: String(end) } } : {}),
  },
  id,
})
const stepFinishPart = (total?: number, id = 'sf1'): PartBuilder => ({
  type: 'step-finish',
  id,
  ...(total !== undefined
    ? { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total } }
    : {}),
})

interface ExportOpts {
  readonly id?: string
  readonly created?: number
  readonly completed?: number
  readonly messages?: readonly { readonly role: 'user' | 'assistant'; readonly created: number; readonly completed?: number; readonly parts: readonly PartBuilder[] }[]
}

const makeExport = (o: ExportOpts): Record<string, unknown> => ({
  info: {
    id: o.id ?? 'sess-1',
    slug: 's',
    projectID: 'p',
    directory: '/x',
    title: 't',
    agent: 'build',
    model: { id: 'm', providerID: 'prov' },
    version: '1',
    summary: { additions: 0, deletions: 0, files: 0 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: String(o.created ?? 0), updated: String(o.created ?? 0) },
  },
  messages: (o.messages ?? []).map((m) => ({
    info: {
      role: m.role,
      time: {
        created: String(m.created),
        ...(m.completed !== undefined ? { completed: String(m.completed) } : {}),
      },
    },
    parts: m.parts,
  })),
})

const writeRaw = async (tree: WorkspaceTree, side: Side, runIndex: number, data: unknown): Promise<void> => {
  await runP(writeJson(path.join(tree.raw, side, `run-${String(runIndex)}.json`), data))
}

// ---------------------------------------------------------------------------
// extractEventsFromExport — pure
// ---------------------------------------------------------------------------

describe('extractEventsFromExport — event types', () => {
  const baseExport = (parts: readonly PartBuilder[]): OpencodeExport =>
    makeExport({ id: 'sess-x', created: 1000, messages: [{ role: 'assistant', created: 1000, completed: 2000, parts }] }) as OpencodeExport

  it('text part → text event at message created time', () => {
    const ev = extractEventsFromExport(baseExport([textPart('hello')]), 'old', 1)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.type).toBe('text')
    expect(ev[0]!.side).toBe('old')
    expect(ev[0]!.runIndex).toBe(1)
  })

  it('reasoning part → reasoning event with tStart/tEnd from part.time', () => {
    const ev = extractEventsFromExport(baseExport([reasoningPart(1100, 1400)]), 'old', 1)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.type).toBe('reasoning')
    expect(ev[0]!.tStart).toBe('100')
    expect(ev[0]!.tEnd).toBe('400')
  })

  it('tool part pending → only tool-call event, no tool-result', () => {
    const ev = extractEventsFromExport(baseExport([toolPart('bash', 'pending', 1100, 1200)]), 'old', 1)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.type).toBe('tool-call')
    expect(ev[0]!.tool).toBe('bash')
    expect(ev[0]!.status).toBe('pending')
  })

  it('tool part completed → tool-call + tool-result', () => {
    const ev = extractEventsFromExport(baseExport([toolPart('edit', 'completed', 1100, 1500)]), 'old', 1)
    expect(ev).toHaveLength(2)
    expect(ev[0]!.type).toBe('tool-call')
    expect(ev[0]!.tool).toBe('edit')
    expect(ev[0]!.tStart).toBe('100')
    expect(ev[0]!.tEnd).toBe('500')
    expect(ev[1]!.type).toBe('tool-result')
    expect(ev[1]!.tool).toBe('edit')
  })

  it('tool part error → tool-call + tool-result with error status', () => {
    const ev = extractEventsFromExport(baseExport([toolPart('read', 'error', 1100, 1300)]), 'old', 1)
    expect(ev).toHaveLength(2)
    expect(ev[1]!.type).toBe('tool-result')
    expect(ev[1]!.status).toBe('error')
  })

  it('tool part without state.time → uses message created for both endpoints', () => {
    const ev = extractEventsFromExport(baseExport([toolPart('bash', 'completed')]), 'old', 1)
    expect(ev).toHaveLength(2)
    expect(ev[0]!.tStart).toBe('0')
    expect(ev[0]!.tEnd).toBe('0')
  })

  it('step-finish part → step-finish event with tokens.total', () => {
    const ev = extractEventsFromExport(baseExport([stepFinishPart(1234)]), 'old', 1)
    expect(ev).toHaveLength(1)
    expect(ev[0]!.type).toBe('step-finish')
    expect(ev[0]!.tokens).toBe(1234)
  })

  it('step-start part → no event emitted', () => {
    const ev = extractEventsFromExport(baseExport([{ type: 'step-start', id: 'ss1' }]), 'old', 1)
    expect(ev).toHaveLength(0)
  })

  it('mixed parts → all represented, in order', () => {
    const parts: readonly PartBuilder[] = [
      textPart('a'),
      reasoningPart(1100, 1200),
      toolPart('bash', 'completed', 1200, 1300),
      stepFinishPart(500),
    ]
    const ev = extractEventsFromExport(baseExport(parts), 'new', 2)
    const types = ev.map((e) => e.type)
    expect(types).toEqual(['text', 'reasoning', 'tool-call', 'tool-result', 'step-finish'])
    expect(ev.every((e) => e.side === 'new')).toBe(true)
    expect(ev.every((e) => e.runIndex === 2)).toBe(true)
  })
})

describe('extractEventsFromExport — metadata', () => {
  it('sessionId = export.info.id', () => {
    const exp = makeExport({ id: 'sess-42', created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }) as OpencodeExport
    const ev = extractEventsFromExport(exp, 'old', 1)
    expect(ev[0]!.sessionId).toBe('sess-42')
  })

  it('swimlaneDepth = 0 (root, v0.1)', () => {
    const exp = makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }) as OpencodeExport
    const ev = extractEventsFromExport(exp, 'old', 1)
    expect(ev[0]!.swimlaneDepth).toBe(0)
    expect(ev[0]!.parentSessionId).toBeUndefined()
  })

  it('timestamps normalized so min(tStart) = 0', () => {
    const exp = makeExport({
      created: 5000,
      messages: [
        { role: 'assistant', created: 5000, parts: [reasoningPart(5000, 5100)] },
        { role: 'assistant', created: 5200, parts: [textPart('x')] },
      ],
    }) as OpencodeExport
    const ev = extractEventsFromExport(exp, 'old', 1)
    expect(ev[0]!.tStart).toBe('0')
    expect(ev[1]!.tStart).toBe('200')
  })

  it('empty messages → empty events', () => {
    const exp = makeExport({ created: 0, messages: [] }) as OpencodeExport
    expect(extractEventsFromExport(exp, 'old', 1)).toEqual([])
  })

  it('message with no parts → no events', () => {
    const exp = makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [] }] }) as OpencodeExport
    expect(extractEventsFromExport(exp, 'old', 1)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// collapseRepeats — pure
// ---------------------------------------------------------------------------

const callAt = (tStart: number, tool = 'bash'): TimelineEvent => ({
  tStart: String(tStart),
  tEnd: String(tStart + 100),
  side: 'old',
  runIndex: 1,
  sessionId: 's',
  swimlaneDepth: 0,
  type: 'tool-call',
  tool,
})

describe('collapseRepeats', () => {
  it('5 identical tool-call events → 1 (merged tEnd = max)', () => {
    const events = [100, 200, 300, 400, 500].map((t) => callAt(t))
    const out = collapseRepeats(events)
    expect(out).toHaveLength(1)
    expect(out[0]!.tStart).toBe('100')
    expect(out[0]!.tEnd).toBe('600')
  })

  it('keeps non-repeating events separate', () => {
    const events: TimelineEvent[] = [
      callAt(100, 'bash'),
      callAt(200, 'bash'),
      { ...callAt(300, 'read') },
      callAt(400, 'bash'),
    ]
    const out = collapseRepeats(events)
    expect(out).toHaveLength(3)
    expect(out[0]!.tool).toBe('bash')
    expect(out[0]!.tEnd).toBe('300')
    expect(out[1]!.tool).toBe('read')
    expect(out[2]!.tool).toBe('bash')
  })

  it('does not merge across different sides / runIndex', () => {
    const events: TimelineEvent[] = [
      { ...callAt(100), side: 'old', runIndex: 1 },
      { ...callAt(200), side: 'new', runIndex: 1 },
      { ...callAt(300), side: 'old', runIndex: 2 },
    ]
    const out = collapseRepeats(events)
    expect(out).toHaveLength(3)
  })

  it('sums tokens when present', () => {
    const events: TimelineEvent[] = [
      { ...callAt(100), tokens: 10 },
      { ...callAt(200), tokens: 20 },
    ]
    const out = collapseRepeats(events)
    expect(out).toHaveLength(1)
    expect(out[0]!.tokens).toBe(30)
  })

  it('empty input → empty output', () => {
    expect(collapseRepeats([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// renderTimelineHtml — pure
// ---------------------------------------------------------------------------

const sampleTimeline = (mode: TimelineMode): Timeline => ({
  old: [
    { tStart: '0', tEnd: '100', side: 'old', runIndex: 1, sessionId: 's1', swimlaneDepth: 0, type: 'reasoning' },
    { tStart: '100', tEnd: '200', side: 'old', runIndex: 1, sessionId: 's1', swimlaneDepth: 0, type: 'tool-call', tool: 'bash', status: 'completed' },
    { tStart: '200', tEnd: '200', side: 'old', runIndex: 1, sessionId: 's1', swimlaneDepth: 0, type: 'tool-result', tool: 'bash', status: 'completed' },
  ],
  new: [
    { tStart: '0', tEnd: '50', side: 'new', runIndex: 1, sessionId: 's2', swimlaneDepth: 0, type: 'text' },
    { tStart: '50', tEnd: '150', side: 'new', runIndex: 1, sessionId: 's2', swimlaneDepth: 0, type: 'step-finish', tokens: 99 },
  ],
  mode,
})

describe('renderTimelineHtml', () => {
  it('contains DOCTYPE, title, and inline style', () => {
    const html = renderTimelineHtml(sampleTimeline('side-by-side'))
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>')
    expect(html).toContain('<style>')
  })

  it('renders both OLD and NEW sides', () => {
    const html = renderTimelineHtml(sampleTimeline('side-by-side'))
    expect(html).toContain('OLD')
    expect(html).toContain('NEW')
    expect(html).toContain('class="side old"')
    expect(html).toContain('class="side new"')
  })

  it('emits event divs with type-based classes and tooltips', () => {
    const html = renderTimelineHtml(sampleTimeline('side-by-side'))
    expect(html).toContain('event reasoning')
    expect(html).toContain('event tool-call')
    expect(html).toContain('data-tooltip')
  })

  it('tool events get tool-specific class (bash)', () => {
    const html = renderTimelineHtml(sampleTimeline('side-by-side'))
    expect(html).toContain('tool-call bash')
  })

  it('is self-contained: no external resources', () => {
    const html = renderTimelineHtml(sampleTimeline('side-by-side'))
    expect(html).not.toMatch(/src\s*=\s*["']https?:/)
    expect(html).not.toMatch(/href\s*=\s*["']https?:/)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/<script\s+src/i)
  })

  it('error status is flagged on the event element', () => {
    const tl: Timeline = {
      old: [{ tStart: '0', tEnd: '10', side: 'old', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'read', status: 'error' }],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    expect(html).toContain('data-status="error"')
  })

  it('merged mode renders a single combined axis', () => {
    const html = renderTimelineHtml(sampleTimeline('merged'))
    expect(html).toContain('merged')
  })

  it('empty timeline still produces valid HTML', () => {
    const html = renderTimelineHtml({ old: [], new: [], mode: 'side-by-side' })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('class="events"')
  })
})

// ---------------------------------------------------------------------------
// timeline phase
// ---------------------------------------------------------------------------

describe('timeline — happy path', () => {
  it('2x3 runs → both arrays filled, json + html written', async () => {
    const tree = await makeWorkspace(3)
    const runInput = makeRunInput({ runs: 3, formats: ['md', 'html'], collapseRepeats: false })
    const parts: readonly PartBuilder[] = [reasoningPart(0, 100), toolPart('bash', 'completed', 100, 200), stepFinishPart(50)]
    for (const n of [1, 2, 3]) {
      await writeRaw(tree, 'old', n, makeExport({ id: `old-${String(n)}`, created: 0, messages: [{ role: 'assistant', created: 0, completed: 300, parts }] }))
      await writeRaw(tree, 'new', n, makeExport({ id: `new-${String(n)}`, created: 0, messages: [{ role: 'assistant', created: 0, completed: 250, parts }] }))
    }
    const result = await runP(timeline({
      runInput,
      manifest: fakeManifest,
      workspace: tree,
      sideResults: {
        old: [1, 2, 3].map((n) => sideResult('old', n)),
        new: [1, 2, 3].map((n) => sideResult('new', n)),
      },
    }))
    expect(result.timeline.old.length).toBeGreaterThan(0)
    expect(result.timeline.new.length).toBeGreaterThan(0)
    expect(result.timeline.mode).toBe('side-by-side')
    expect(result.jsonPath).toBe(path.join(tree.results, 'timeline.json'))
    expect(result.htmlPath).toBe(path.join(tree.results, 'timeline.html'))
    expect(existsSync(result.jsonPath)).toBe(true)
    expect(existsSync(result.htmlPath!)).toBe(true)
    expect(result.timeline.old.every((e) => e.side === 'old')).toBe(true)
    expect(result.timeline.new.every((e) => e.side === 'new')).toBe(true)
  })

  it('no html format → htmlPath omitted, json still written', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, formats: ['md'] })
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const result = await runP(timeline({
      runInput,
      manifest: fakeManifest,
      workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(result.htmlPath).toBeUndefined()
    expect(existsSync(result.jsonPath)).toBe(true)
  })

  it('collapseRepeats=true → consecutive same-tool collapsed in output', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, collapseRepeats: true })
    const parts: readonly PartBuilder[] = [
      toolPart('bash', 'completed', 0, 10),
      toolPart('bash', 'completed', 10, 20),
      toolPart('bash', 'completed', 20, 30),
    ]
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts }] }))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const result = await runP(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    const oldCalls = result.timeline.old.filter((e) => e.type === 'tool-call')
    expect(oldCalls).toHaveLength(1)
  })

  it('empty parts in export → valid timeline with empty events for that run', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [] }))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const result = await runP(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(result.timeline.old).toEqual([])
    expect(result.timeline.new).toHaveLength(1)
  })

  it('all modes pass through to timeline.mode', async () => {
    const tree = await makeWorkspace(1)
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    for (const mode of ['side-by-side', 'tree-diff', 'merged'] as const) {
      const result = await runP(timeline({
        runInput: makeRunInput({ runs: 1, timelineMode: mode }),
        manifest: fakeManifest, workspace: tree,
        sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
      }))
      expect(result.timeline.mode).toBe(mode)
    }
  })

  it('timeline.json validates against Timeline schema (round-trip)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [reasoningPart(0, 100), stepFinishPart(10)] }] }))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const result = await runP(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    const raw = await runP(readFile(result.jsonPath))
    expect(() => { JSON.parse(raw) }).not.toThrow()
    const parsed = JSON.parse(raw) as Timeline
    expect(parsed.old.length).toBeGreaterThan(0)
    expect(parsed.mode).toBe('side-by-side')
  })
})

describe('timeline — errors', () => {
  it('invalid export (schema mismatch) → E_EXPORT_INVALID with side + runIndex', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, { not: 'a valid export' })
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [] }))
    const err = await runFlip(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.context?.['side']).toBe('old')
    expect(err.context?.['runIndex']).toBe(1)
  })

  it('invalid export on new side → E_EXPORT_INVALID side=new', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [] }))
    await writeRaw(tree, 'new', 1, { broken: true })
    const err = await runFlip(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.context?.['side']).toBe('new')
  })
})
