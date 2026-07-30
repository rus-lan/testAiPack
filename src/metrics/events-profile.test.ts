import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { profileEvents, EDIT_TOOLS } from './events-profile.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ev = (type: string, timestamp: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, timestamp, sessionID: 's', ...extra })

const toolUse = (timestamp: number, tool: string): string =>
  ev('tool_use', timestamp, { part: { type: 'tool', tool } })

describe('profileEvents — synthetic', () => {
  it('first tool and first edit offsets from first event timestamp', () => {
    const lines = [
      ev('text', 1000, { part: { type: 'text', text: 'hi' } }),
      toolUse(1200, 'bash'),
      toolUse(1500, 'edit'),
    ]
    const p = profileEvents(lines.join('\n'))
    expect(p.timeToFirstToolMs).toBe(200)
    expect(p.timeToFirstEditMs).toBe(500)
  })

  it('max gap between consecutive timestamps (stall case)', () => {
    const lines = [
      toolUse(0, 'bash'),
      toolUse(1000, 'bash'),
      toolUse(241000, 'bash'), // 240s stall
      toolUse(241500, 'bash'),
    ]
    const p = profileEvents(lines.join('\n'))
    expect(p.maxEventGapMs).toBe(240000)
    expect(p.gapsMs).toEqual([1000, 240000, 500])
  })

  it('gapsMs carries every consecutive gap, in event order, for caller-side threshold analysis', () => {
    const lines = [toolUse(0, 'bash'), toolUse(100, 'bash'), toolUse(70_100, 'bash')]
    const p = profileEvents(lines.join('\n'))
    expect(p.gapsMs).toEqual([100, 70000])
    expect(p.gapsMs.filter((g) => g > 60_000)).toHaveLength(1)
  })

  it('no edit tools -> timeToFirstEditMs undefined', () => {
    const lines = [toolUse(0, 'bash'), toolUse(100, 'read')]
    const p = profileEvents(lines.join('\n'))
    expect(p.timeToFirstToolMs).toBe(0)
    expect(p.timeToFirstEditMs).toBeUndefined()
  })

  it('no tool_use -> timeToFirstToolMs and timeToFirstEditMs undefined', () => {
    const lines = [ev('text', 0, { part: { type: 'text', text: 'a' } }), ev('step_finish', 500)]
    const p = profileEvents(lines.join('\n'))
    expect(p.timeToFirstToolMs).toBeUndefined()
    expect(p.timeToFirstEditMs).toBeUndefined()
    expect(p.maxEventGapMs).toBe(500)
  })

  it('unparseable lines and events without a numeric timestamp are skipped', () => {
    const lines = [
      ev('text', 0),
      'not json at all',
      '{"type":"tool_use"}', // no timestamp field
      '{}', // safeStringify fallback shape (06-run-side.ts)
      toolUse(300, 'edit'),
    ]
    const p = profileEvents(lines.join('\n'))
    expect(p.timeToFirstToolMs).toBe(300)
    expect(p.timeToFirstEditMs).toBe(300)
    expect(p.maxEventGapMs).toBe(300)
  })

  it('empty string -> empty profile (undefined, undefined, 0, [])', () => {
    expect(profileEvents('')).toEqual({
      timeToFirstToolMs: undefined,
      timeToFirstEditMs: undefined,
      maxEventGapMs: 0,
      gapsMs: [],
    })
  })

  it('whitespace-only input -> empty profile', () => {
    expect(profileEvents('\n\n   \n')).toEqual({
      timeToFirstToolMs: undefined,
      timeToFirstEditMs: undefined,
      maxEventGapMs: 0,
      gapsMs: [],
    })
  })

  it('single event -> maxEventGapMs 0, gapsMs empty (no pair to measure)', () => {
    const p = profileEvents(toolUse(42, 'bash'))
    expect(p.timeToFirstToolMs).toBe(0)
    expect(p.maxEventGapMs).toBe(0)
    expect(p.gapsMs).toEqual([])
  })

  it('a non-tool_use event carrying a part.tool-shaped field is not mistaken for a tool call', () => {
    const lines = [ev('step_finish', 0, { part: { tool: 'edit' } }), toolUse(700, 'bash')]
    const p = profileEvents(lines.join('\n'))
    expect(p.timeToFirstToolMs).toBe(700)
    expect(p.timeToFirstEditMs).toBeUndefined()
  })

  it('EDIT_TOOLS covers edit, write, patch', () => {
    expect(EDIT_TOOLS).toEqual(['edit', 'write', 'patch'])
  })
})

// ---------------------------------------------------------------------------
// boundaryTs — task-phase scoping (metric-split spec §5.3)
// ---------------------------------------------------------------------------

describe('profileEvents — boundaryTs (task-phase scoping)', () => {
  it('with boundaryTs, timeToFirstToolMs is measured from the first post-boundary event, not the stream start', () => {
    const lines = [
      toolUse(0, 'bash'), // init tool — before the boundary
      ev('text', 500, { part: { type: 'text', text: 'prompt starts' } }),
      toolUse(700, 'ls'), // task tool
    ]
    const p = profileEvents(lines.join('\n'), 500)
    // baseline is the first event at/after boundaryTs (ts=500) -> 700-500=200
    expect(p.timeToFirstToolMs).toBe(200)
  })

  it('with boundaryTs, timeToFirstEditMs is scoped the same way', () => {
    const lines = [toolUse(0, 'edit'), ev('text', 500), toolUse(600, 'edit')]
    const p = profileEvents(lines.join('\n'), 500)
    expect(p.timeToFirstEditMs).toBe(100)
  })

  it('gapsMs / maxEventGapMs stay whole-stream regardless of boundaryTs', () => {
    const lines = [toolUse(0, 'bash'), toolUse(100, 'bash'), toolUse(70_100, 'bash')]
    const withoutBoundary = profileEvents(lines.join('\n'))
    const withBoundary = profileEvents(lines.join('\n'), 70_000)
    expect(withBoundary.gapsMs).toEqual(withoutBoundary.gapsMs)
    expect(withBoundary.maxEventGapMs).toBe(withoutBoundary.maxEventGapMs)
  })

  it('boundary beyond every event -> task signals are undefined, never 0', () => {
    const lines = [toolUse(0, 'bash'), toolUse(100, 'edit')]
    const p = profileEvents(lines.join('\n'), 10_000)
    expect(p.timeToFirstToolMs).toBeUndefined()
    expect(p.timeToFirstEditMs).toBeUndefined()
  })

  it('omitted boundaryTs keeps the old whole-stream behavior', () => {
    const lines = [ev('text', 1000, { part: { type: 'text', text: 'hi' } }), toolUse(1200, 'bash'), toolUse(1500, 'edit')]
    const p = profileEvents(lines.join('\n'))
    expect(p.timeToFirstToolMs).toBe(200)
    expect(p.timeToFirstEditMs).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// Real ground truth — .research/metrics-expansion/golden-values.md, per-run
// table. Reads the actual events.ndjson files from the sample workspace this
// data was hand-computed from. That workspace lives outside the repo (a real
// testaipack run under the user's home, not a checked-in fixture), so the
// whole block skips cleanly when it is absent — same pattern as
// tests/opencode-cli-contract.test.ts skipping without a reachable opencode
// binary.
// ---------------------------------------------------------------------------

const GOLDEN_ROOT = '/home/ruslan/.testaipack/2026-07-29_20-44-07_ed1eeb/results/raw'

interface GoldenRun {
  readonly runIndex: number
  readonly ttft: number
  readonly ttfe: number | undefined
  readonly maxGap: number
}

const GOLDEN: Record<'old' | 'new', readonly GoldenRun[]> = {
  old: [
    { runIndex: 1, ttft: 2165, ttfe: 130089, maxGap: 252915 },
    { runIndex: 2, ttft: 1054, ttfe: 204050, maxGap: 50733 },
    { runIndex: 3, ttft: 8985, ttfe: 51882, maxGap: 36514 },
    { runIndex: 4, ttft: 9657, ttfe: 26306, maxGap: 10140 },
    { runIndex: 5, ttft: 1592, ttfe: undefined, maxGap: 5168 },
  ],
  new: [
    { runIndex: 1, ttft: 7518, ttfe: 29291, maxGap: 21209 },
    { runIndex: 2, ttft: 1708, ttfe: undefined, maxGap: 240663 },
    { runIndex: 3, ttft: 2310, ttfe: 162313, maxGap: 49525 },
    { runIndex: 4, ttft: 7570, ttfe: 141983, maxGap: 50036 },
    { runIndex: 5, ttft: 12878, ttfe: 93489, maxGap: 21724 },
  ],
}

const hasGoldenWorkspace = existsSync(GOLDEN_ROOT)

describe.skipIf(!hasGoldenWorkspace)('profileEvents — real ground truth (golden-values.md)', () => {
  const sides = ['old', 'new'] as const
  for (const side of sides) {
    for (const run of GOLDEN[side]) {
      it(`${side}/run-${String(run.runIndex)} matches the hand-computed golden values`, () => {
        const file = path.join(GOLDEN_ROOT, side, `run-${String(run.runIndex)}.events.ndjson`)
        const ndjson = readFileSync(file, 'utf8')
        const p = profileEvents(ndjson)
        expect(p.timeToFirstToolMs).toBe(run.ttft)
        expect(p.timeToFirstEditMs).toBe(run.ttfe)
        expect(p.maxEventGapMs).toBe(run.maxGap)
        // gapsMs is the new field this run pins: its own max must match the
        // golden maxGap independently of maxEventGapMs's own computation.
        expect(Math.max(0, ...p.gapsMs)).toBe(run.maxGap)
        expect(p.gapsMs.length).toBeGreaterThan(0)
      })
    }
  }
})
