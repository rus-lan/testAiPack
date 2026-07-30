import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile, writeJson } from '../util/fs.js'

vi.mock('../opencode/cli.js', () => ({
  exportSession: vi.fn(),
  dbQuery: vi.fn(),
}))

import { exportSession, dbQuery } from '../opencode/cli.js'
import {
  timeline,
  extractEventsFromExport,
  collapseRepeats,
  renderTimelineHtml,
  loadSessionTree,
} from './10-timeline.js'
import type { SessionTreeLoader } from './10-timeline.js'
import type { SessionTreeNode } from '../metrics/extract.js'
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

const exportMock = vi.mocked(exportSession)
const dbMock = vi.mocked(dbQuery)

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
  protectGit: false,
  allowBaselineTool: false,
  initSide: 'both',
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
    gitDirsOld: [],
    gitDirsNew: [],
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
  type: 'reasoning', text: 'thinking', time: { start, end }, id,
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
    ...(start !== undefined && end !== undefined ? { time: { start, end } } : {}),
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
    time: { created: o.created ?? 0, updated: o.created ?? 0 },
  },
  messages: (o.messages ?? []).map((m) => ({
    info: {
      role: m.role,
      time: {
        created: m.created,
        ...(m.completed !== undefined ? { completed: m.completed } : {}),
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

const resultAt = (
  tStart: number,
  tool = 'bash',
  status: 'completed' | 'error' = 'completed',
): TimelineEvent => ({
  tStart: String(tStart),
  tEnd: String(tStart),
  side: 'old',
  runIndex: 1,
  sessionId: 's',
  swimlaneDepth: 0,
  type: 'tool-result',
  tool,
  status,
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

  it('does not merge a tool-call with its own adjacent tool-result (same tool)', () => {
    const events: TimelineEvent[] = [callAt(100, 'bash'), resultAt(200, 'bash')]
    const out = collapseRepeats(events)
    expect(out).toHaveLength(2)
    expect(out[0]!.type).toBe('tool-call')
    expect(out[1]!.type).toBe('tool-result')
  })

  it('preserves an error status on tool-result instead of merging it away', () => {
    const events: TimelineEvent[] = [callAt(100, 'bash'), resultAt(200, 'bash', 'error')]
    const out = collapseRepeats(events)
    expect(out).toHaveLength(2)
    expect(out[1]!.status).toBe('error')
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

  it('sanitizes a tool name with unsafe characters before using it as a CSS class', () => {
    const tl: Timeline = {
      old: [
        {
          tStart: '0',
          tEnd: '10',
          side: 'old',
          runIndex: 1,
          sessionId: 's',
          swimlaneDepth: 0,
          type: 'tool-call',
          tool: '"><img src=x onerror=alert(1)>',
          status: 'completed',
        },
      ],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    expect(html).not.toContain('<img')
    const classAttr = /class="(event tool-call [^"]*)"/.exec(html)
    expect(classAttr).not.toBeNull()
    expect(classAttr![1]!).toMatch(/^[a-z0-9 -]+$/)
  })

  it('caps event width instead of rendering an unbounded pixel value', () => {
    const tl: Timeline = {
      old: [
        { tStart: '0', tEnd: '600000', side: 'old', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'bash', status: 'completed' },
      ],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    expect(html).not.toContain('width:300000px')
    expect(html).toContain('width:2000px')
  })

  it('embeds the timeline JSON so it survives a literal </script> in tool data', () => {
    const tl: Timeline = {
      old: [
        { tStart: '0', tEnd: '10', side: 'old', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'bash & "quoted" <b>', status: 'completed' },
      ],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    const match = /<script type="application\/json" id="timeline-data">([\s\S]*?)<\/script>/.exec(html)
    expect(match).not.toBeNull()
    const scriptContent = match![1]!
    expect(scriptContent).not.toMatch(/&amp;|&lt;|&quot;/)
    const parsed = JSON.parse(scriptContent) as Timeline
    expect(parsed.old[0]?.tool).toBe('bash & "quoted" <b>')
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

  it('tree-diff mode renders both sides without throwing', () => {
    const html = renderTimelineHtml(sampleTimeline('tree-diff'))
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('class="side old"')
    expect(html).toContain('class="side new"')
    expect(html).toContain('tree-diff')
  })

  it('tree-diff flags events present on only one side (by tool+type)', () => {
    const tl: Timeline = {
      // old has bash tool-call + reasoning; new has read tool-call + reasoning
      old: [
        { tStart: '0', tEnd: '10', side: 'old', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'reasoning' },
        { tStart: '10', tEnd: '20', side: 'old', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'bash', status: 'completed' },
      ],
      new: [
        { tStart: '0', tEnd: '10', side: 'new', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'reasoning' },
        { tStart: '10', tEnd: '20', side: 'new', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'read', status: 'completed' },
      ],
      mode: 'tree-diff',
    }
    const html = renderTimelineHtml(tl)
    // reasoning is on both sides → not flagged; bash/read are unique per side
    expect(html).toContain('only-old')
    expect(html).toContain('only-new')
    expect(html).toMatch(/tool-call bash only-old/)
    expect(html).toMatch(/tool-call read only-new/)
    expect(html).not.toMatch(/reasoning only/)
  })

  it('tree-diff with identical sides flags nothing', () => {
    const tl: Timeline = {
      old: [{ tStart: '0', tEnd: '5', side: 'old', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'bash', status: 'completed' }],
      new: [{ tStart: '0', tEnd: '5', side: 'new', runIndex: 1, sessionId: 's', swimlaneDepth: 0, type: 'tool-call', tool: 'bash', status: 'completed' }],
      mode: 'tree-diff',
    }
    const html = renderTimelineHtml(tl)
    // no event div carries an only-* flag (legend still lists the swatches)
    expect(html).not.toMatch(/event \w+[^"]* only-old/)
    expect(html).not.toMatch(/event \w+[^"]* only-new/)
  })

  it('empty tree-diff timeline still produces valid HTML', () => {
    const html = renderTimelineHtml({ old: [], new: [], mode: 'tree-diff' })
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('class="events"')
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

  it('collapseRepeats=true → consecutive same-tool calls collapsed in output', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, collapseRepeats: true })
    const parts: readonly PartBuilder[] = [
      toolPart('bash', 'running', 0, 10),
      toolPart('bash', 'running', 10, 20),
      toolPart('bash', 'running', 20, 30),
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
  it('corrupt run-N.json (invalid JSON) -> run contributes no events, phase succeeds', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await runP(writeFile(path.join(tree.raw, 'old', 'run-1.json'), '{"info":{"id":"trunc'))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const result = await runP(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(result.timeline.old).toEqual([])
    expect(result.timeline.new).toHaveLength(1)
  })

  it('run-N.json fails schema -> same (no events, phase succeeds)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, { not: 'a valid export' })
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const result = await runP(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(result.timeline.old).toEqual([])
    expect(result.timeline.new).toHaveLength(1)
  })

  it('invalid export on new side -> new contributes no events, old unaffected', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }))
    await writeRaw(tree, 'new', 1, { broken: true })
    const result = await runP(timeline({
      runInput, manifest: fakeManifest, workspace: tree,
      sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
    }))
    expect(result.timeline.old).toHaveLength(1)
    expect(result.timeline.new).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// loadSessionTree — walks parent_id tree (opencode cli mocked)
// ---------------------------------------------------------------------------

const setupTreeMocks = (
  exports: Readonly<Record<string, Record<string, unknown>>>,
  children: Readonly<Record<string, readonly string[]>>,
): void => {
  exportMock.mockImplementation((_h: string, sid: string) =>
    Effect.succeed(JSON.stringify(exports[sid] ?? makeExport({ id: sid }))),
  )
  dbMock.mockImplementation((_h: string, sql: string) => {
    const match = /parent_id = '([^']+)'/.exec(sql)
    const pid = match?.[1] ?? ''
    return Effect.succeed((children[pid] ?? []).map((id) => ({ id })))
  })
}

describe('loadSessionTree', () => {
  beforeEach(() => {
    exportMock.mockReset()
    dbMock.mockReset()
  })

  it('root with no children -> single root node, depth 0', async () => {
    setupTreeMocks({ root: makeExport({ id: 'root' }) }, {})
    const tree = await runP(loadSessionTree('/h', 'root'))
    expect(tree).toHaveLength(1)
    expect(tree[0]?.sessionId).toBe('root')
    expect(tree[0]?.depth).toBe(0)
    expect(tree[0]?.parentId).toBeNull()
  })

  it('root + 2 children -> 3 nodes, depths 0/1/1, parent=root', async () => {
    setupTreeMocks(
      {
        root: makeExport({ id: 'root' }),
        c1: makeExport({ id: 'c1' }),
        c2: makeExport({ id: 'c2' }),
      },
      { root: ['c1', 'c2'] },
    )
    const tree = await runP(loadSessionTree('/h', 'root'))
    expect(tree).toHaveLength(3)
    expect(tree.map((n) => n.depth)).toEqual([0, 1, 1])
    expect(tree.map((n) => n.parentId)).toEqual([null, 'root', 'root'])
  })

  it('root + child + grandchild -> depths 0/1/2', async () => {
    setupTreeMocks(
      {
        root: makeExport({ id: 'root' }),
        c: makeExport({ id: 'c' }),
        g: makeExport({ id: 'g' }),
      },
      { root: ['c'], c: ['g'] },
    )
    const tree = await runP(loadSessionTree('/h', 'root'))
    expect(tree.map((n) => n.depth)).toEqual([0, 1, 2])
    expect(tree.map((n) => n.sessionId)).toEqual(['root', 'c', 'g'])
  })

  it('cycle (A->B->A) -> visited set breaks it, returns [A, B]', async () => {
    setupTreeMocks(
      { A: makeExport({ id: 'A' }), B: makeExport({ id: 'B' }) },
      { A: ['B'], B: ['A'] },
    )
    const tree = await runP(loadSessionTree('/h', 'A'))
    expect(tree).toHaveLength(2)
    expect([...tree.map((n) => n.sessionId)].sort()).toEqual(['A', 'B'])
  })

  it('a session id with SQL-unsafe characters never reaches the DB query', async () => {
    setupTreeMocks({}, {})
    const tree = await runP(loadSessionTree('/h', "root' OR '1'='1"))
    expect(tree).toHaveLength(1)
    expect(dbMock).not.toHaveBeenCalled()
  })

  it('depth limit: a chain of 12 -> stops at depth 10 (≤11 nodes)', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `n${String(i)}`)
    const exports: Record<string, Record<string, unknown>> = {}
    const children: Record<string, readonly string[]> = {}
    ids.forEach((id, i) => {
      exports[id] = makeExport({ id })
      if (i < ids.length - 1) children[id] = [ids[i + 1]!]
    })
    setupTreeMocks(exports, children)
    const tree = await runP(loadSessionTree('/h', 'n0'))
    expect(tree.length).toBeLessThanOrEqual(11)
    expect(tree[tree.length - 1]?.depth).toBe(10)
  })

  it('dbQuery failure -> PhaseError E_EXPORT_INVALID', async () => {
    dbMock.mockImplementation(() => Effect.fail(new Error('db down') as never))
    exportMock.mockImplementation(() => Effect.succeed(JSON.stringify(makeExport({ id: 'root' }))))
    const err = await runFlip(loadSessionTree('/h', 'root'))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_EXPORT_INVALID')
  })
})

// ---------------------------------------------------------------------------
// extractEventsFromExport — depth / parentSessionId
// ---------------------------------------------------------------------------

describe('extractEventsFromExport — swimlane metadata', () => {
  it('accepts depth + parentSessionId and stamps them on every event', () => {
    const exp = makeExport({ id: 'child', created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }) as OpencodeExport
    const ev = extractEventsFromExport(exp, 'new', 2, 1, 'parent-1')
    expect(ev[0]!.swimlaneDepth).toBe(1)
    expect(ev[0]!.parentSessionId).toBe('parent-1')
    expect(ev[0]!.sessionId).toBe('child')
  })

  it('defaults to depth 0 and no parent (v0.1 root)', () => {
    const exp = makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }) as OpencodeExport
    const ev = extractEventsFromExport(exp, 'old', 1)
    expect(ev[0]!.swimlaneDepth).toBe(0)
    expect(ev[0]!.parentSessionId).toBeUndefined()
  })
})

describe('collapseRepeats — swimlane boundary', () => {
  it('does not merge identical tool-calls across swimlanes (different sessionId)', () => {
    const events: TimelineEvent[] = [
      { ...callAt(100), sessionId: 'root' },
      { ...callAt(200), sessionId: 'child' },
    ]
    expect(collapseRepeats(events)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// renderTimelineHtml — swimlane lanes
// ---------------------------------------------------------------------------

describe('renderTimelineHtml — swimlanes', () => {
  it('renders one lane per sessionId, tagged with its depth', () => {
    const tl: Timeline = {
      old: [
        { tStart: '0', tEnd: '10', side: 'old', runIndex: 1, sessionId: 'root', swimlaneDepth: 0, type: 'text' },
        { tStart: '5', tEnd: '15', side: 'old', runIndex: 1, sessionId: 'child', parentSessionId: 'root', swimlaneDepth: 1, type: 'tool-call', tool: 'bash', status: 'completed' },
      ],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    expect(html).toContain('class="swimlane"')
    expect(html).toContain('data-depth="0"')
    expect(html).toContain('data-depth="1"')
    expect(html).toContain('swimlane-label')
    expect(html).toContain('>main<')
    expect(html).toContain('>depth 1<')
  })

  it('indents depth-1 swimlane via its CSS data attribute', () => {
    const tl: Timeline = {
      old: [{ tStart: '0', tEnd: '1', side: 'old', runIndex: 1, sessionId: 'c', swimlaneDepth: 1, parentSessionId: 'r', type: 'text' }],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    expect(html).toContain('data-depth="1"')
  })

  it('preserves first-appearance session order even when interleaved and not alphabetical', () => {
    const evt = (
      sessionId: string,
      depth: number,
      tool: string,
      tStart: string,
      tEnd: string,
    ): TimelineEvent => ({
      tStart, tEnd, side: 'old', runIndex: 1, sessionId, swimlaneDepth: depth,
      type: 'tool-call', tool, status: 'completed',
    })
    const tl: Timeline = {
      old: [
        evt('zzz', 0, 'first', '0', '10'),
        evt('aaa', 1, 'second', '5', '15'),
        evt('zzz', 0, 'third', '10', '20'),
        evt('mmm', 1, 'fourth', '15', '25'),
      ],
      new: [],
      mode: 'side-by-side',
    }
    const html = renderTimelineHtml(tl)
    const zzzFirst = html.indexOf('data-tooltip="tool-call first')
    const zzzThird = html.indexOf('data-tooltip="tool-call third')
    const aaaIdx = html.indexOf('data-tooltip="tool-call second')
    const mmmIdx = html.indexOf('data-tooltip="tool-call fourth')
    expect(zzzFirst).toBeGreaterThan(-1)
    // zzz's own two (non-adjacent in the input) events land in one lane, together
    expect(zzzThird).toBeGreaterThan(zzzFirst)
    expect(zzzThird).toBeLessThan(aaaIdx)
    // session order follows first appearance (zzz, aaa, mmm), not alphabetical
    expect(aaaIdx).toBeGreaterThan(zzzThird)
    expect(mmmIdx).toBeGreaterThan(aaaIdx)
  })
})

// ---------------------------------------------------------------------------
// timeline phase — swimlane via injected tree loader (v0.2)
// ---------------------------------------------------------------------------

const asTreeLoader = (fn: SessionTreeLoader): SessionTreeLoader => fn

describe('timeline — swimlane (v0.2)', () => {
  it('injected tree -> child events carry depth 1 + parentSessionId', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    const rootExp = makeExport({ id: 'root', created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] })
    const childExp = makeExport({ id: 'child', created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('c')] }] })
    await writeRaw(tree, 'old', 1, rootExp)
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))

    const loadTree = asTreeLoader(() =>
      Effect.succeed<readonly SessionTreeNode[]>([
        { sessionId: 'root', parentId: null, depth: 0, export: rootExp as OpencodeExport, children: [] },
        { sessionId: 'child', parentId: 'root', depth: 1, export: childExp as OpencodeExport, children: [] },
      ]),
    )

    const result = await runP(timeline(
      {
        runInput, manifest: fakeManifest, workspace: tree,
        sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
      },
      { loadTree },
    ))

    const childEvents = result.timeline.old.filter((e) => e.sessionId === 'child')
    expect(childEvents.length).toBeGreaterThan(0)
    expect(childEvents.every((e) => e.swimlaneDepth === 1)).toBe(true)
    expect(childEvents.every((e) => e.parentSessionId === 'root')).toBe(true)
    // root lane still present
    expect(result.timeline.old.some((e) => e.sessionId === 'root' && e.swimlaneDepth === 0)).toBe(true)
  })

  it('injected loader failure -> degrades to root-only (no throw)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, makeExport({ id: 'root', created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('x')] }] }))
    await writeRaw(tree, 'new', 1, makeExport({ created: 0, messages: [{ role: 'assistant', created: 0, parts: [textPart('y')] }] }))
    const loadTree = asTreeLoader(() => Effect.fail(new PhaseError({
      code: 'E_EXPORT_INVALID', phase: 'timeline', message: 'boom', timestamp: new Date(),
    })))
    const result = await runP(timeline(
      {
        runInput, manifest: fakeManifest, workspace: tree,
        sideResults: { old: [sideResult('old', 1)], new: [sideResult('new', 1)] },
      },
      { loadTree },
    ))
    // root-only fallback: only sessionId 'root', depth 0
    expect(result.timeline.old.every((e) => e.swimlaneDepth === 0)).toBe(true)
  })
})
