import { describe, it, expect } from 'vitest'
import { renderMd } from './md.js'
import {
  makeReport,
  makeMetricsDiff,
  makeSideAggregates,
  makeDiffResult,
  makeManifest,
  makeJudge,
  makeSidePhaseSplit,
  makePhaseDeltas,
  makePhaseSlice,
  makePhaseSliceStats,
} from '../../tests/report-fixture.js'
import type { FailedRun, JudgeResult, Manifest, MetricDelta, PackSetupReport, PrimaryDeltas, SidePhaseSplit } from '@generated/types'
import { redactUrlCredentials } from '../util/redact.js'
import { safeRefDisplay } from '../pack/detector.js'

describe('renderMd — header', () => {
  const md = renderMd(makeReport())

  it('includes the title with runId', () => {
    expect(md).toContain('# testaipack report: run-abc-001')
  })

  it('includes repo, runs, timestamp, opencode version', () => {
    expect(md).toContain('**Repo:** https://example.com/repo.git')
    expect(md).toContain('**Runs:** 1 per side')
    expect(md).toContain('**Timestamp:** 2025-01-01T00:00:00.000Z')
    expect(md).toContain('**Opencode version:** 0.5.0')
  })

  it('shows pack ref when present', () => {
    expect(md).toContain('**Pack:**')
  })

  it('shows smoke-test line when packRef absent', () => {
    const manifest: Manifest = makeManifest()
    const { packRef: _drop, ...withoutPack } = manifest
    const m = renderMd(makeReport({ manifest: withoutPack }))
    expect(m).toContain('_smoke-test (no pack)_')
  })

  it('never echoes a credential when given an already-redacted manifest (the shape buildManifest produces)', () => {
    const manifest: Manifest = {
      ...makeManifest(),
      repoUrl: redactUrlCredentials('https://user:ghp_secrettoken@github.com/org/repo.git'),
      packRef: safeRefDisplay(redactUrlCredentials('mcp:srv:{"env":{"API_KEY":"sk-fake-secret"}}')),
    }
    const md = renderMd(makeReport({ manifest }))
    expect(md).not.toContain('ghp_secrettoken')
    expect(md).not.toContain('user:')
    expect(md).not.toContain('sk-fake-secret')
    expect(md).not.toContain('API_KEY')
  })

  it('absent entirely when --init was not used', () => {
    expect(md).not.toContain('Init side:')
  })

  it("'both' is called out as the contamination mechanism", () => {
    const manifest = makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'both' } })
    const m = renderMd(makeReport({ manifest }))
    expect(m).toContain('**Init side:** both — sent to both sides; this is how a baseline can pick up the pack under test')
  })

  it("'new' discloses the metrics asymmetry (init cost lands only on that side) instead of the contamination note", () => {
    const manifest = makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'new' } })
    const m = renderMd(makeReport({ manifest }))
    expect(m).toContain(
      "**Init side:** new — only the NEW side's metrics carry the init call's cost (tokens, steps, tool calls, wall-clock); that asymmetry is expected, not a measurement error",
    )
    expect(m).not.toContain('sent to both sides')
  })

  it("'old' discloses the same asymmetry, naming OLD", () => {
    const manifest = makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'old' } })
    const m = renderMd(makeReport({ manifest }))
    expect(m).toContain("only the OLD side's metrics carry the init call's cost")
  })

  it('unknown when init is used but flagDefaults predates --init-side (older report.json)', () => {
    const manifest = makeManifest({ init: '/graphify .', flagDefaults: {} })
    const m = renderMd(makeReport({ manifest }))
    expect(m).toContain('**Init side:** unknown (report predates --init-side)')
  })

  it('absent entirely when --pack-hint was not used', () => {
    expect(md).not.toContain('Pack hint:')
  })

  it('shows the hint text and states plainly that it went to both sides', () => {
    const manifest = makeManifest({
      packHint: 'If .graphify/ contains a prepared index, use it. If not, work as usual.',
    })
    const m = renderMd(makeReport({ manifest }))
    expect(m).toContain('**Pack hint:** sent identically to both sides')
    expect(m).toContain('If .graphify/ contains a prepared index, use it. If not, work as usual.')
  })
})

describe('renderMd — summary', () => {
  it('headline appears at the top of the Summary section', () => {
    const md = renderMd(makeReport())
    const summaryIdx = md.indexOf('## Summary')
    const headlineIdx = md.indexOf('Pack improved token efficiency')
    expect(summaryIdx).toBeGreaterThan(-1)
    expect(headlineIdx).toBeGreaterThan(summaryIdx)
  })

  it('has Improvements, Regressions, Neutral subsections', () => {
    const md = renderMd(makeReport())
    expect(md).toContain('### Improvements')
    expect(md).toContain('### Regressions')
    expect(md).toContain('### Neutral')
  })

  it('improvements list contains named Total tokens', () => {
    const md = renderMd(makeReport())
    expect(md).toContain('**Total tokens**')
  })
})

describe('renderMd — primary metrics table', () => {
  const md = renderMd(makeReport())

  it('has the table header row with spread columns (P3)', () => {
    expect(md).toContain('| Metric | Old (median) | Old [min–max] | New (median) | New [min–max] | Δ | Δ% | Significant | Verdict |')
    expect(md).toContain('|---|---|---|---|---|---|---|---|---|')
  })

  it('renders total tokens row with better verdict and significant', () => {
    expect(md).toContain('| Total tokens | 12345 | 100–100 | 10987 | 100–100 | -1358 | -11.0% | ✓ significant | ✓ better |')
  })

  it('renders wall-clock row as worse in noise', () => {
    expect(md).toContain('| Wall-clock (ms) | 45000 | 100–100 | 52000 | 100–100 | +7000 | +15.6% | in noise | ⚠ worse |')
  })

  it('renders tool-call row as significant worse', () => {
    expect(md).toContain('| Tool calls | 25 | 100–100 | 30 | 100–100 | +5 | +20.0% | ⚠ significant | ⚠ worse |')
  })

  it('renders neutral success rank with dash significance', () => {
    expect(md).toContain('| Success rank | 4 | 100–100 | 4 | 100–100 | 0 | 0.0% | — | = same |')
  })

  it('maxParallelism has no stats entry -> spread column renders a dash', () => {
    expect(md).toContain('| Max parallelism | 1 | — | 1 | — | 0 | 0.0% | — | = same |')
  })

  it('emits all seven primary metric rows', () => {
    const labels = [
      'Total tokens',
      'Wall-clock (ms)',
      'Cost ($)',
      'Steps',
      'Tool calls',
      'Success rank',
      'Max parallelism',
    ]
    for (const label of labels) {
      const matching = md.split('\n').filter((l) => l.startsWith(`| ${label} |`))
      expect(matching).toHaveLength(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Phase split (metric-split spec §5.7)
// ---------------------------------------------------------------------------

const PHASE_TABLE_HEADER_LINE = '| Metric | Old (median) | Old [min–max] | New (median) | New [min–max] | Δ | Δ% | Significant | Verdict |'

describe('renderMd — phase split: absent on pre-split reports (regression guard)', () => {
  const md = renderMd(makeReport())

  it('no Phase split section, no basis line, whole-run table still retitled', () => {
    expect(md).not.toContain('## Phase split')
    expect(md).not.toContain('_Basis: task phase only')
    expect(md).toContain('## Primary metrics — total (init + task)')
  })

  it('secondary metrics carries no whole-run note when there is no split to disambiguate from', () => {
    expect(md).not.toContain('Whole-run (init + task) — not split')
  })

  it('init side line keeps the old wording when no split exists', () => {
    const manifest = makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'new' } })
    const m = renderMd(makeReport({ manifest }))
    expect(m).toContain('that asymmetry is expected, not a measurement error')
  })
})

describe('renderMd — phase split: one-sided init (cost figure, never a delta)', () => {
  const oldNoInitSplit: SidePhaseSplit = {
    runsWithInit: 0,
    runsWithLostInit: 0,
    task: makePhaseSlice({ totalTokens: '500', wallClockMs: '2000', costUsd: 0.005, stepCount: 2, toolCallCount: 1 }),
    taskStats: makePhaseSliceStats(500),
  }
  const newWithInitSplit = makeSidePhaseSplit({ runsWithInit: 3 })
  const metricsDiff = makeMetricsDiff({
    old: makeSideAggregates('old', { phaseSplit: oldNoInitSplit }),
    new: makeSideAggregates('new', { phaseSplit: newWithInitSplit }),
    taskDeltas: makePhaseDeltas(),
  })
  const md = renderMd(makeReport({ metricsDiff }))

  it('renders the Phase split section with a Task phase table and an Init cost block', () => {
    expect(md).toContain('## Phase split (init vs task)')
    expect(md).toContain('### Task phase (like-for-like)')
    expect(md).toContain('### Init cost')
  })

  it('the side without init reads "no init phase"; the side with init shows median + range, no delta table', () => {
    expect(md).toContain('- **OLD**: no init phase')
    expect(md).toContain('- **NEW** (3 run(s) with init):')
    expect(md).toContain('Total tokens')
  })

  it('the Init cost block never renders a delta table for one-sided init (only the whole-run table and the Task table use the 9-col header)', () => {
    const occurrences = md.split(PHASE_TABLE_HEADER_LINE).length - 1
    expect(occurrences).toBe(2)
  })

  it('basis line prints under the headline because taskDeltas is present', () => {
    expect(md).toContain('_Basis: task phase only (init excluded); init cost shown in "Init cost" below._')
  })

  it('init side line points at the phase-split section instead of the plain asymmetry note', () => {
    const manifest = makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'new' } })
    const m = renderMd(makeReport({ manifest, metricsDiff }))
    expect(m).toContain('metrics below are split — the headline compares task vs task; init cost is reported separately')
    expect(m).not.toContain('that asymmetry is expected, not a measurement error')
  })

  it('secondary metrics section carries the whole-run label', () => {
    expect(md).toContain('Whole-run (init + task) — not split')
  })
})

describe('renderMd — phase split: two-sided init renders initDeltas as a delta table', () => {
  const metricsDiff = makeMetricsDiff({
    old: makeSideAggregates('old', { phaseSplit: makeSidePhaseSplit({ runsWithInit: 2 }) }),
    new: makeSideAggregates('new', { phaseSplit: makeSidePhaseSplit({ runsWithInit: 2 }) }),
    taskDeltas: makePhaseDeltas(),
    initDeltas: makePhaseDeltas({ totalTokens: { absolute: 100, percent: 10, significant: false, better: 'worse' } }),
  })
  const md = renderMd(makeReport({ metricsDiff }))

  it('both the Task table and the Init cost table use the 9-column delta layout (plus the whole-run table)', () => {
    const occurrences = md.split(PHASE_TABLE_HEADER_LINE).length - 1
    expect(occurrences).toBe(3)
  })

  it('never renders the one-sided "no init phase" / "run(s) with init" bullet lines', () => {
    expect(md).not.toContain('no init phase')
    expect(md).not.toContain('run(s) with init')
  })
})

describe('renderMd — phase split: setup segment (wall-clock only, never a token/step/cost figure)', () => {
  const metricsDiff = makeMetricsDiff({
    old: makeSideAggregates('old', { phaseSplit: makeSidePhaseSplit({ setup: { wallClockMs: '4000' } }) }),
    new: makeSideAggregates('new', { phaseSplit: makeSidePhaseSplit() }),
    taskDeltas: makePhaseDeltas(),
  })
  const md = renderMd(makeReport({ metricsDiff }))

  it('renders one line with the median wall-clock, no token/step/cost figures', () => {
    expect(md).toContain('- **OLD**: pack setup (harness, no model call) — median 4000ms')
    expect(md).not.toContain('- **NEW**: pack setup')
  })
})

describe('renderMd — phase split: costProrated marks the value as derived', () => {
  const metricsDiff = makeMetricsDiff({
    old: makeSideAggregates('old', { phaseSplit: makeSidePhaseSplit({ costProrated: true }) }),
    new: makeSideAggregates('new', { phaseSplit: makeSidePhaseSplit() }),
    taskDeltas: makePhaseDeltas(),
  })
  const md = renderMd(makeReport({ metricsDiff }))

  it('prefixes the prorated cost cell with ~ and adds the derived footnote', () => {
    expect(md).toContain('_~ cost prorated from the session total by token share — derived, not measured._')
  })
})

describe('renderMd — phase split: runsWithLostInit warns, never silently drops the run', () => {
  const metricsDiff = makeMetricsDiff({
    old: makeSideAggregates('old', { phaseSplit: makeSidePhaseSplit({ runsWithLostInit: 2 }) }),
    new: makeSideAggregates('new', { phaseSplit: makeSidePhaseSplit() }),
    taskDeltas: makePhaseDeltas(),
  })
  const md = renderMd(makeReport({ metricsDiff }))

  it('warns with the exact run count for the affected side only', () => {
    expect(md).toContain('> ⚠ OLD: 2 run(s) ran --init but the export lost the init session — init cost unmeasured.')
    expect(md).not.toContain('⚠ NEW:')
  })
})

describe('renderMd — failed runs', () => {
  it('omits Failed runs section when there are none', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('## Failed runs')
  })

  it('shows Failed runs section with error code when failures exist', () => {
    const failed: FailedRun = {
      runIndex: 1,
      errorCode: 'E_RUN_CRASH',
      errorMessage: 'boom | went | the | pipe',
      timestamp: '2025-01-01T00:02:00.000Z',
    }
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', { failedRuns: [failed] }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('## Failed runs')
    expect(md).toContain('E_RUN_CRASH')
    expect(md).toContain('old | 1 |')
    // pipe characters in the message are escaped so the table is not broken
    expect(md).toContain('boom \\| went \\| the \\| pipe')
  })

  it('emits both-failed warning when metricsDiff.bothFailed', () => {
    const md = renderMd(
      makeReport({
        metricsDiff: makeMetricsDiff({
          bothFailed: true,
          old: makeSideAggregates('old', {
            failedRuns: [
              {
                runIndex: 1,
                errorCode: 'E_RUN_CRASH',
                errorMessage: 'x',
                timestamp: '2025-01-01T00:02:00.000Z',
              },
            ],
          }),
        }),
      }),
    )
    expect(md).toContain('Both sides failed — comparison unreliable')
  })
})

describe('renderMd — LLM judge', () => {
  it('shows judge verdict, quality, model and explanation', () => {
    const md = renderMd(makeReport({ judge: makeJudge() }))
    expect(md).toContain('## LLM Judge')
    expect(md).toContain('Verdict: **ok**')
    expect(md).toContain('Quality: old=7, new=8')
    expect(md).toContain('gpt-test')
    expect(md).toContain('New side produces cleaner output.')
  })

  it('shows "not requested" note when judge is omitted', () => {
    const { judge: _drop, ...withoutJudge } = makeReport()
    const md = renderMd(withoutJudge)
    expect(md).toContain('## LLM Judge')
    expect(md).toContain('_Judge was not requested (--judge not set)_')
  })

  it('omits the raw-response block when rawResponse is absent', () => {
    const md = renderMd(makeReport({ judge: makeJudge() }))
    expect(md).not.toContain('Raw model response')
  })

  it('shows the raw response in a collapsible block when present, so a parse failure is not just "Failed to parse" with nothing to look at', () => {
    const md = renderMd(
      makeReport({
        judge: makeJudge({
          verdict: 'unclear',
          oldQuality: 0,
          newQuality: 0,
          explanation: 'Failed to parse judge response',
          rawResponse: 'I really cannot decide this one.',
        }),
      }),
    )
    expect(md).toContain('<details>')
    expect(md).toContain('<summary>Raw model response</summary>')
    expect(md).toContain('I really cannot decide this one.')
    expect(md).toContain('</details>')
  })

  it('fences the raw response with more backticks than any run already inside it, so the content cannot break out of its own code block', () => {
    const raw = 'prose\n```json\n{"a":1}\n```\nmore prose'
    const md = renderMd(makeReport({ judge: makeJudge({ rawResponse: raw }) }))
    expect(md).toContain('````text')
    expect(md).toContain(raw)
  })

  it('flags unclear verdict', () => {
    const unclear: JudgeResult = {
      verdict: 'unclear',
      oldQuality: 5,
      newQuality: 5,
      explanation: 'cannot decide',
      modelUsed: 'gpt-test',
      timestamp: '2025-01-01T00:05:00.000Z',
    }
    const md = renderMd(makeReport({ judge: unclear }))
    expect(md).toContain('Verdict: **unclear** _(unclear)_')
  })

  it('judge.ran === false renders "did not run" without verdict block', () => {
    const didNotRun: JudgeResult = {
      verdict: 'unclear',
      oldQuality: 0,
      newQuality: 0,
      explanation: 'judge model unavailable (bogus/model): 401 unauthorized',
      modelUsed: '',
      timestamp: '2025-01-01T00:05:00.000Z',
      ran: false,
    }
    const md = renderMd(makeReport({ judge: didNotRun }))
    expect(md).toContain('## LLM Judge')
    expect(md).toContain('_Judge did not run: judge model unavailable (bogus/model): 401 unauthorized_')
    expect(md).not.toContain('Verdict:')
    expect(md).not.toContain('Quality:')
  })

  it('judge without ran field renders as today', () => {
    const md = renderMd(makeReport({ judge: makeJudge() }))
    expect(md).toContain('Verdict: **ok**')
    expect(md).not.toContain('did not run')
  })
})

describe('renderMd — timeline summary', () => {
  it('lists longest events and references timeline.html', () => {
    const md = renderMd(makeReport())
    expect(md).toContain('## Timeline summary')
    expect(md).toContain('[new/run-1]')
    expect(md).toContain('`tool-call` (write)')
    expect(md).toContain('results/timeline.html')
  })

  it('handles empty timeline gracefully', () => {
    const md = renderMd(makeReport({ timeline: { old: [], new: [], mode: 'side-by-side' } }))
    expect(md).toContain('_No timeline events._')
  })
})

describe('renderMd — diff summary', () => {
  it('emits per-side totals and patch links', () => {
    const md = renderMd(makeReport())
    expect(md).toContain('## Diff summary')
    expect(md).toContain('diff/old/run-1/full.patch')
    expect(md).toContain('diff/new/run-1/full.patch')
  })

  it('includes side.html link when htmlPath set', () => {
    const diff = {
      old: makeDiffResult('old', {
        runs: [
          {
            runIndex: 1,
            fullPatch: 'p',
            summary: { filesChanged: 1, additions: 1, deletions: 1, perFile: [] },
            noChanges: false,
            htmlPath: '/abs/old/side.html',
          },
        ],
      }),
      new: makeDiffResult('new'),
    }
    const md = renderMd(makeReport({ diff }))
    expect(md).toContain('diff/old/run-1/side.html')
  })

  it('failed diff run renders "diff failed" line without patch link', () => {
    const diff = {
      old: makeDiffResult('old', {
        runs: [
          {
            runIndex: 1,
            fullPatch: '',
            summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
            noChanges: false,
            state: 'failed' as const,
            error: { code: 'E_WORKTREE_BROKEN' as const, message: 'git add -A failed (exit 128): bad index' },
          },
        ],
      }),
      new: makeDiffResult('new'),
    }
    const md = renderMd(makeReport({ diff }))
    expect(md).toContain('diff failed')
    expect(md).toContain('git add -A failed (exit 128): bad index')
    expect(md).not.toContain('[patch](diff/old/run-1')
    expect(md).toContain('1 failed')
  })

  it('git-restored / git-replaced runs render normal lines with markers', () => {
    const diff = {
      old: makeDiffResult('old', {
        runs: [
          {
            runIndex: 1,
            fullPatch: 'p',
            summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] },
            noChanges: false,
            state: 'git-restored' as const,
          },
        ],
      }),
      new: makeDiffResult('new', {
        runs: [
          {
            runIndex: 1,
            fullPatch: 'p',
            summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] },
            noChanges: false,
            state: 'git-replaced' as const,
          },
        ],
      }),
    }
    const md = renderMd(makeReport({ diff }))
    expect(md).toContain('(agent deleted .git, restored from clean clone)')
    expect(md).toContain('(agent replaced .git, diff includes agent commits)')
  })

  it('run without state field renders as ok', () => {
    const diff = {
      old: makeDiffResult('old', {
        runs: [
          {
            runIndex: 1,
            fullPatch: 'p',
            summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] },
            noChanges: false,
          },
        ],
      }),
      new: makeDiffResult('new'),
    }
    const md = renderMd(makeReport({ diff }))
    expect(md).toContain('diff/old/run-1/full.patch')
    expect(md).not.toContain('diff failed')
  })
})

describe('renderMd — secondary metrics', () => {
  it('includes per-tool and finish-cause lines for both sides', () => {
    const md = renderMd(makeReport())
    expect(md).toContain('### OLD secondary')
    expect(md).toContain('### NEW secondary')
    expect(md).toContain('`read`')
    expect(md).toContain('stop=10')
  })

  it('the File diff line reflects the real git diff totals (phase 08)', () => {
    // fixture default: diff.old.runs[0].summary = {additions:8, deletions:3, filesChanged:2}
    const md = renderMd(makeReport())
    expect(md).toContain('- File diff: +8 -3 (2 files)')
  })

  it('matches the Diff summary section exactly, since both read the same phase-08 data (the reported bug)', () => {
    const diff = {
      old: makeDiffResult('old', {
        runs: [
          { runIndex: 1, fullPatch: 'p', summary: { filesChanged: 2, additions: 957, deletions: 0, perFile: [] }, noChanges: false },
        ],
      }),
      new: makeDiffResult('new', {
        runs: [
          { runIndex: 1, fullPatch: 'p', summary: { filesChanged: 2, additions: 772, deletions: 0, perFile: [] }, noChanges: false },
        ],
      }),
    }
    const md = renderMd(makeReport({ diff }))
    expect(md).toContain('- File diff: +957 -0 (2 files)')
    expect(md).toContain('- File diff: +772 -0 (2 files)')
    expect(md).not.toContain('- File diff: +0 -0 (0 files)')
    // the Diff summary section (further down) reports the exact same per-side totals
    expect(md).toContain('**old**: +957 -0 (2 files across 1 run(s))')
    expect(md).toContain('**new**: +772 -0 (2 files across 1 run(s))')
  })

  it('lists tools by count descending, not insertion order', () => {
    const base = makeSideAggregates('old')
    const secondary = {
      ...base.secondary,
      perTool: {
        rare: { count: 1, errorRate: 0, avgDurationMs: '10' },
        common: { count: 99, errorRate: 0, avgDurationMs: '10' },
      },
    }
    const metricsDiff = makeMetricsDiff({ old: makeSideAggregates('old', { secondary }) })
    const md = renderMd(makeReport({ metricsDiff }))
    const commonIdx = md.indexOf('`common`')
    const rareIdx = md.indexOf('`rare`')
    expect(commonIdx).toBeGreaterThan(-1)
    expect(rareIdx).toBeGreaterThan(-1)
    expect(commonIdx).toBeLessThan(rareIdx)
  })
})

describe('renderMd — neutral delta bucket', () => {
  it('groups context-dependent deltas into Neutral', () => {
    const deltas: PrimaryDeltas = {
      totalTokens: { absolute: -1, percent: -1, significant: true, better: 'better' },
      wallClockMs: { absolute: 1, percent: 1, significant: true, better: 'worse' },
      costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      stepCount: { absolute: 0, percent: 0, significant: false, better: 'context-dependent' },
      toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      successRank: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
    }
    const delta: MetricDelta = deltas.stepCount
    expect(delta.better).toBe('context-dependent')
    const md = renderMd(makeReport({ metricsDiff: makeMetricsDiff({ deltas }) }))
    // context-dependent → ≈ ctx verdict in the table
    expect(md).toContain('≈ ctx')
  })
})

describe('renderMd — stability: unstable flag carries a max/min ratio', () => {
  it('appends (N.N×) next to an unstable metric label', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        stats: {
          ...makeSideAggregates('old').stats,
          wallClockMs: { median: 168791, min: 73730, max: 723560, iqr: 602674, samples: [73730, 168791, 168791, 723560] },
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('unstable: Wall-clock (ms) (9.8×)')
  })

  it('omits the ratio when min is 0 (no divide-by-zero)', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        stats: {
          ...makeSideAggregates('old').stats,
          stepCount: { median: 5, min: 0, max: 20, iqr: 12, samples: [0, 5, 5, 20] },
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('unstable: Steps')
    expect(md).not.toMatch(/Steps \(\d/)
  })
})

describe('renderMd — backcompat', () => {
  it('a Report fixture without ANY new field renders without throwing, no new sections', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('## Pack signal')
    expect(md).not.toContain('## Safety')
    expect(md).not.toContain('version differs from manifest')
  })
})

describe('renderMd — header (P13 version drift)', () => {
  it('warns when runs used a different opencode version than the manifest', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', { opencodeVersions: ['1.18.4'] }),
      new: makeSideAggregates('new', { opencodeVersions: ['1.18.4'] }),
    })
    const md = renderMd(makeReport({ metricsDiff, manifest: makeManifest({ opencodeVersion: '1.18.3' }) }))
    expect(md).toContain('opencode version differs from manifest: manifest says 1.18.3, runs used 1.18.4')
  })

  it('silent when versions match', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', { opencodeVersions: ['1.18.4'] }),
      new: makeSideAggregates('new', { opencodeVersions: ['1.18.4'] }),
    })
    const md = renderMd(makeReport({ metricsDiff, manifest: makeManifest({ opencodeVersion: '1.18.4' }) }))
    expect(md).not.toContain('version differs from manifest')
  })

  it('silent when opencodeVersions absent (old report.json)', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('version differs from manifest')
  })
})

describe('renderMd — pack signal (P1)', () => {
  it('renders counts per side; warns when new side never invoked a detectable pack', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        packUse: { calls: 1, errors: 1, runsWithCall: 1, runCount: 5, firstCallMsMedian: '64043', canDetect: true, visibilityConfirmed: false },
      }),
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: false },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('## Pack signal')
    expect(md).toContain('1 call(s), 1 error(s), 1/5 runs')
    expect(md).toContain('0 call(s), 0 error(s), 0/5 runs')
    expect(md).toContain('Pack was never invoked on the NEW side — deltas compare baseline vs baseline')
  })

  it('says "not visible" when canDetect is false; absent entirely when packUse is absent on both sides', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', { packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: false, visibilityConfirmed: false } }),
      new: makeSideAggregates('new', { packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: false, visibilityConfirmed: false } }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('_pack use is not visible for this pack type_')
    expect(md).not.toContain('Pack was never invoked')

    const noPackMd = renderMd(makeReport())
    expect(noPackMd).not.toContain('## Pack signal')
  })

  it('when preflight confirmed visibility and calls=0, warns that the model chose not to call it, not just "never invoked"', () => {
    const metricsDiff = makeMetricsDiff({
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: true },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('preflight confirmed it was visible, so the model chose not to call it')
    expect(md).toContain('0 call(s), 0 error(s), 0/5 runs called the pack (confirmed visible, not called)')
  })

  it('when calls=0 and visibility was not confirmed, the signal line says so instead of implying it was reachable', () => {
    const metricsDiff = makeMetricsDiff({
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: false },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('0 call(s), 0 error(s), 0/5 runs called the pack (visibility not confirmed)')
  })

  it('visibilityConfirmed entirely absent (old report.json, pre-dates the field) degrades to "not confirmed", not a crash or "undefined"', () => {
    const metricsDiff = makeMetricsDiff({
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('0 call(s), 0 error(s), 0/5 runs called the pack (visibility not confirmed)')
    expect(md).not.toContain('undefined')
  })

  it('exercised mode + zero calls: no "chose not to call it" claim, no "deltas compare baseline vs baseline" claim — informational note instead of a warning', () => {
    const metricsDiff = makeMetricsDiff({
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 2, canDetect: true, visibilityConfirmed: true },
      }),
    })
    const packSetup: PackSetupReport = {
      mode: 'exercised',
      setupDeclared: true,
      checkDeclared: true,
      exerciseDeclared: true,
      checks: [],
      exercises: [{ side: 'new', runIndex: 1, exitCode: 0, durationMs: '10', artifactHash: 'abc' }],
    }
    const md = renderMd(makeReport({ metricsDiff, packSetup }))
    expect(md).not.toContain('chose not to call it')
    expect(md).not.toContain('Deltas compare baseline vs baseline')
    expect(md).not.toContain('⚠ **Pack was never invoked')
    expect(md).toContain('Pack was never called directly on the NEW side')
    expect(md).toContain('nothing left to trigger')
    expect(md).toContain('Expected under exercised mode, not a defect')
  })

  it('exercised mode + at least one call: neither the warning nor the exercised-mode note appears', () => {
    const metricsDiff = makeMetricsDiff({
      new: makeSideAggregates('new', {
        packUse: { calls: 1, errors: 0, runsWithCall: 1, runCount: 2, canDetect: true, visibilityConfirmed: true },
      }),
    })
    const packSetup: PackSetupReport = {
      mode: 'exercised',
      setupDeclared: true,
      checkDeclared: true,
      exerciseDeclared: true,
      checks: [],
      exercises: [],
    }
    const md = renderMd(makeReport({ metricsDiff, packSetup }))
    expect(md).not.toContain('Pack was never invoked')
    expect(md).not.toContain('Pack was never called directly')
  })

  it('installed-only mode + zero calls: keeps the original "chose not to call it" warning — the agent genuinely had the option here', () => {
    const metricsDiff = makeMetricsDiff({
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: true },
      }),
    })
    const packSetup: PackSetupReport = {
      mode: 'installed-only',
      setupDeclared: true,
      checkDeclared: false,
      exerciseDeclared: false,
      checks: [],
      exercises: [],
    }
    const md = renderMd(makeReport({ metricsDiff, packSetup }))
    expect(md).toContain('chose not to call it')
    expect(md).not.toContain('Pack was never called directly')
  })
})

describe('renderMd — safety (P2)', () => {
  it('lists risky commands with escaped pipe characters; absent when empty', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        riskyCommands: [
          { runIndex: 1, command: 'rm -rf /workspace/.git | echo done', completed: true, exitCode: 0 },
        ],
      }),
      new: makeSideAggregates('new', { riskyCommands: [] }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('## Safety')
    expect(md).toContain('rm -rf /workspace/.git \\| echo done')
    expect(md).toContain('1 risky command(s) on old, 0 on new')
    expect(md).toContain('⚠ 1 risky command(s) detected — see Safety')

    const emptyMd = renderMd(makeReport())
    expect(emptyMd).not.toContain('## Safety')
  })

  it('backticks in the command survive byte-identical — the fence widens instead of altering the text', () => {
    const render = (command: string): string | undefined => {
      const metricsDiff = makeMetricsDiff({
        old: makeSideAggregates('old', { riskyCommands: [{ runIndex: 1, command, completed: true, exitCode: 0 }] }),
      })
      const md = renderMd(makeReport({ metricsDiff }))
      return md.split('\n').find((l) => l.startsWith('| old | 1 |'))
    }

    // one backtick, mid-string: a 2-backtick fence is enough
    expect(render('echo a`b')).toContain('| ``echo a`b`` |')

    // several — a run of 3 backticks: fence widens to 4 to stay longer than the run
    expect(render('echo before ``` after')).toContain('| ````echo before ``` after```` |')

    // backtick adjacent to the string's edges: a padding space keeps the
    // fence and the text's own edge backtick from reading as one run —
    // CommonMark strips that single shared space back out on render, so the
    // displayed text is still exactly `cmd`, not ` `cmd` ` with visible padding.
    expect(render('`cmd`')).toContain('| `` `cmd` `` |')
  })
})

describe('renderMd — baseline contamination', () => {
  it('lists signals with escaped pipe characters; absent when empty', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        contaminationSignals: [
          { kind: 'bash-install', detail: 'npm install -g | echo done', runIndex: 2 },
          { kind: 'install-drift', detail: "captured config differs across this side's own runs in: skills" },
        ],
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('## Baseline contamination')
    expect(md).toContain('npm install -g \\| echo done')
    expect(md).toContain('| bash-install | 2 |')
    // install-drift has no runIndex — renders as an em dash, not a fabricated 0
    expect(md).toContain('| install-drift | — |')
    expect(md).toContain('2 signal(s) that the OLD side acquired or used the pack under test')
    expect(md).toContain('⚠ **Baseline contamination: the OLD side shows 2 sign(s)')

    const emptyMd = renderMd(makeReport())
    expect(emptyMd).not.toContain('## Baseline contamination')
    expect(emptyMd).not.toContain('Baseline contamination:')
  })

  it('backticks in detail survive byte-identical — the fence widens instead of altering the text', () => {
    const render = (detail: string): string | undefined => {
      const metricsDiff = makeMetricsDiff({
        old: makeSideAggregates('old', { contaminationSignals: [{ kind: 'bash-install', detail, runIndex: 1 }] }),
      })
      const md = renderMd(makeReport({ metricsDiff }))
      return md.split('\n').find((l) => l.startsWith('| bash-install | 1 |'))
    }

    // one backtick, mid-string
    expect(render('npm install a`b')).toContain('| ``npm install a`b`` |')

    // several — a run of 3 backticks
    expect(render('npm install ``` evil')).toContain('| ````npm install ``` evil```` |')

    // backtick adjacent to the string's edges
    expect(render('`evil`')).toContain('| `` `evil` `` |')
  })

  it('warns on the LLM Judge section when contamination is detected, without altering the verdict itself', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        contaminationSignals: [{ kind: 'skill-call', detail: 'skill tool call succeeded for "graphify"' }],
      }),
    })
    const md = renderMd(makeReport({ metricsDiff, judge: makeJudge() }))
    const judgeIdx = md.indexOf('## LLM Judge')
    const warnIdx = md.indexOf('Baseline contamination detected (1 sign(s))', judgeIdx)
    expect(warnIdx).toBeGreaterThan(judgeIdx)
    expect(md).toContain(`Verdict: **${makeJudge().verdict}**`)

    const cleanMd = renderMd(makeReport({ judge: makeJudge() }))
    expect(cleanMd).not.toContain('Baseline contamination detected')
  })
})

describe('renderMd — secondary metrics: four groups, P4/P5/P6/P7/P11/P12 lines', () => {
  it('renders Behavior/Latency/Tokens & context/Output volume group labels per side', () => {
    const md = renderMd(makeReport())
    expect(md).toContain('- **Behavior**')
    expect(md).toContain('- **Latency**')
    expect(md).toContain('- **Tokens & context**')
    expect(md).toContain('- **Output volume**')
  })

  it('behavior lines: bash fails, invalid/duplicate, tool errors, max same-tool streak', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          bashFailCount: 5,
          invalidToolCalls: 1,
          duplicateToolCalls: 5,
          toolErrorTexts: ['boom | pipe'],
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('Bash fails (exit != 0): 5 of')
    expect(md).toContain('(sum over runs)')
    expect(md).toContain('Invalid tool calls: 1; duplicate calls: 5 (sums over runs)')
    expect(md).toContain('Tool errors (top): boom \\| pipe')
    expect(md).toContain('Max same-tool streak:')
  })

  it('wave-1 fields skipped when undefined (old report.json)', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('Bash fails')
    expect(md).not.toContain('Invalid tool calls')
    expect(md).not.toContain('Tool errors (top)')
  })

  it('latency line renders P5 values; stall labeled "max over runs"', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          timeToFirstToolMs: '200',
          timeToFirstEditMs: '500',
          maxEventGapMs: '252915',
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('First tool: +200ms; first edit: +500ms; worst stall: 252915ms (~4.2min) (max over runs)')
  })

  it('large first-tool/first-edit offsets read as minutes too, not just the stall line', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          timeToFirstToolMs: '2165',
          timeToFirstEditMs: '90986',
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('First tool: +2165ms; first edit: +90986ms (~1.5min)')
  })

  it('stall count and threshold label appear beside the max', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          maxEventGapMs: '252915',
          stallCount: 3,
          stalledRunCount: 2,
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('Worst stall: 252915ms (~4.2min) (max over runs); 3 stall(s) over 60s across 2 run(s)')
  })

  it('stall suffix omitted when stallCount/stalledRunCount absent (old report.json)', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('stall(s) over')
  })

  it('latency line omitted when no P5 data (old report.json)', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('First tool:')
    expect(md).not.toContain('worst stall')
  })

  it('reasoning share appended as percent of wall-clock; skipped when wallClockMs is 0', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        primary: { ...makeSideAggregates('old').primary, wallClockMs: '0' },
      }),
    })
    const withShare = renderMd(makeReport())
    expect(withShare).toMatch(/Reasoning time: \d+ms \(\d+% of wall-clock\)/)
    const noShare = renderMd(makeReport({ metricsDiff }))
    // old side wallClockMs=0 -> no share fragment for old
    const oldSection = noShare.slice(noShare.indexOf('### OLD secondary'), noShare.indexOf('### NEW secondary'))
    expect(oldSection).not.toMatch(/% of wall-clock/)
  })

  it('context line renders first/last step tokens; volume line renders chars (P11/P12)', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          firstStepInputTokens: '5491',
          lastStepInputTokens: '18184',
          textChars: '1003',
          reasoningChars: '4107',
          cacheWriteTokens: '0',
        },
      }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('Context: first step in=5491 tok, last step in=18184 tok')
    expect(md).toContain('cacheWrite=0')
    expect(md).toContain('Output: text 1003 ch, reasoning 4107 ch')
  })

  it('context/volume lines omitted when undefined (old report.json)', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('Context: first step in')
    expect(md).not.toContain('Output: text')
  })
})

describe('renderMd — stability line includes verify pass rate (P10)', () => {
  it('shows verify: X/Y passed when verifyStats present', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', { verifyStats: { passed: 3, failed: 1, timedOut: 1, runCount: 5 } }),
    })
    const md = renderMd(makeReport({ metricsDiff }))
    expect(md).toContain('verify: 3/5 passed (1 failed, 1 timed out)')
  })

  it('absent otherwise (no --verify)', () => {
    const md = renderMd(makeReport())
    expect(md).not.toContain('verify:')
  })
})

describe('renderMd — success-rate denominator counts crashed runs', () => {
  const statFor = (median: number, min: number, max: number, samples: readonly number[]) => ({
    median, min, max, samples: [...samples],
  })

  it('crashed runs never enter successRank.samples, but must still count against the denominator', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        stats: {
          ...makeSideAggregates('old').stats,
          // 3 successful runs (all rank >= 3); the other 2 of 5 attempted
          // runs crashed and never produced a successRank sample at all.
          successRank: statFor(4, 3, 4, [4, 4, 3]),
        },
      }),
    })
    const manifest = makeManifest({ runs: 5 })
    const md = renderMd(makeReport({ metricsDiff, manifest }))
    expect(md).toContain('success rate 3/5 (60%)')
    expect(md).not.toContain('success rate 3/3')
  })

  it('every run crashed -> 0/N (visibly failed), not the vanishing 0/0', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        stats: {
          ...makeSideAggregates('old').stats,
          successRank: statFor(0, 0, 0, []),
        },
      }),
    })
    const manifest = makeManifest({ runs: 4 })
    const md = renderMd(makeReport({ metricsDiff, manifest }))
    expect(md).toContain('success rate 0/4 (0%)')
  })
})

describe('renderMd — diff efficiency ratio: denominator is the agent-session count, not the diffed-run count', () => {
  it('a run whose exercise failed (agent session skipped, diffs as an ordinary +0/-0 with state "ok") does not inflate the denominator', () => {
    // Reproduces the real incident: 3 diffed runs, only 2 had an agent
    // session (stats.totalTokens.samples has 2 entries) — the 3rd's
    // --pack-exercise failed, so its worktree stayed pristine and phase 08
    // diffed it as an ordinary +0/-0 with state "ok", not "failed". The old
    // denominator (diff-state !== 'failed') counted all 3 and inflated the
    // ratio; the fix counts only the 2 that actually produced tokens.
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        primary: { ...makeSideAggregates('old').primary, totalTokens: '1000', costUsd: 2 },
        stats: {
          ...makeSideAggregates('old').stats,
          totalTokens: { median: 1000, min: 1000, max: 1000, samples: [1000, 1000] },
        },
      }),
    })
    const report = makeReport({
      metricsDiff,
      diff: {
        old: makeDiffResult('old', {
          runs: [
            { runIndex: 1, fullPatch: '', summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] }, noChanges: true },
            { runIndex: 2, fullPatch: 'p', summary: { filesChanged: 2, additions: 50, deletions: 50, perFile: [] }, noChanges: false },
            { runIndex: 3, fullPatch: 'p', summary: { filesChanged: 2, additions: 50, deletions: 50, perFile: [] }, noChanges: false },
          ],
        }),
        new: makeDiffResult('new'),
      },
    })
    const md = renderMd(report)
    // 2 session runs x median 1000 tokens / 200 changed lines = 10
    // 2 session runs x median $2 / 4 files = 1 — NOT scaled by 3 (the diffed-run count)
    expect(md).toContain('Efficiency: tokens per changed line 10, cost per file 1 (scaled from the per-run median over 2 run(s) with an agent session)')
  })

  it('a run whose diff computation itself failed (state "failed") is irrelevant to the denominator — only stats.totalTokens.samples is', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        primary: { ...makeSideAggregates('old').primary, totalTokens: '1000', costUsd: 2 },
        stats: {
          ...makeSideAggregates('old').stats,
          totalTokens: { median: 1000, min: 1000, max: 1000, samples: [1000, 1000] },
        },
      }),
    })
    const report = makeReport({
      metricsDiff,
      diff: {
        old: makeDiffResult('old', {
          runs: [
            { runIndex: 1, fullPatch: 'p', summary: { filesChanged: 2, additions: 50, deletions: 50, perFile: [] }, noChanges: false },
            { runIndex: 2, fullPatch: 'p', summary: { filesChanged: 2, additions: 50, deletions: 50, perFile: [] }, noChanges: false },
            {
              runIndex: 3,
              fullPatch: '',
              summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
              noChanges: false,
              state: 'failed',
              error: { code: 'E_WORKTREE_BROKEN', message: 'boom' },
            },
          ],
        }),
        new: makeDiffResult('new'),
      },
    })
    const md = renderMd(report)
    expect(md).toContain('Efficiency: tokens per changed line 10, cost per file 1 (scaled from the per-run median over 2 run(s) with an agent session)')
  })
})

describe('renderMd — incident-shaped fixture (acceptance criterion, golden-values.md)', () => {
  it('reproduces every named fact from the real incident workspace in one report', () => {
    const statFor = (median: number, min: number, max: number, samples: readonly number[]) => ({
      median, min, max, samples: [...samples],
    })
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        packUse: { calls: 1, errors: 1, runsWithCall: 1, runCount: 5, firstCallMsMedian: '64043', canDetect: true, visibilityConfirmed: false },
        riskyCommands: [
          {
            runIndex: 1,
            command: 'rm -rf /workspace/.git && echo "Removed git repo" && ls -la /workspace/',
            completed: true,
            exitCode: 0,
          },
        ],
        opencodeVersions: ['1.18.4'],
        secondary: {
          ...makeSideAggregates('old').secondary,
          bashFailCount: 5,
          maxEventGapMs: '252915',
          stallCount: 1,
          stalledRunCount: 1,
        },
        stats: {
          totalTokens: statFor(161654, 17450, 588578, [17450, 588578, 161654, 100000]),
          wallClockMs: statFor(168791, 73730, 723560, [73730, 723560, 168791, 100000]),
          costUsd: statFor(0, 0, 0, [0, 0, 0, 0]),
          stepCount: statFor(15, 3, 29, [3, 29, 15, 10]),
          toolCallCount: statFor(18, 1, 33, [1, 33, 18, 10]),
          successRank: statFor(4, 4, 4, [4, 4, 4, 4, 4]),
        },
      }),
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: false },
        riskyCommands: [],
        opencodeVersions: ['1.18.4'],
        stats: {
          ...makeSideAggregates('new').stats,
          successRank: statFor(4, 3, 4, [4, 4, 4, 4, 3]),
        },
      }),
    })
    const manifest = makeManifest({ opencodeVersion: '1.18.3', runs: 5 })
    const md = renderMd(makeReport({ metricsDiff, manifest }))

    // Safety: 1 risky command on OLD
    expect(md).toContain('## Safety')
    expect(md).toContain('rm -rf /workspace/.git && echo "Removed git repo" && ls -la /workspace/')

    // Pack signal: NEW calls 0 with baseline-vs-baseline warning
    expect(md).toContain('0 call(s), 0 error(s), 0/5 runs')
    expect(md).toContain('Pack was never invoked on the NEW side — deltas compare baseline vs baseline')

    // secondary: OLD bashFailCount 5
    expect(md).toContain('Bash fails (exit != 0): 5 of')

    // header: drift warning 1.18.3 vs 1.18.4
    expect(md).toContain('manifest says 1.18.3, runs used 1.18.4')

    // primary table shows [min-max] spread
    expect(md).toContain('Old [min–max]')

    // success rate 5/5 per side
    expect(md).toContain('success rate 5/5')

    // latency line shows OLD worst stall 252915ms (~4.2 minutes, human-readable),
    // with the stall count and affected-run count beside the max
    expect(md).toContain('Worst stall: 252915ms (~4.2min) (max over runs); 1 stall(s) over 60s across 1 run(s)')

    // no verify line (run had no --verify)
    expect(md).not.toContain('verify:')
  })
})

// ---------------------------------------------------------------------------
// Harness preparation — installed-only banner must not overclaim
// verification it never performed (review-gate: "verified functional" was
// shown for setup-only too, where --pack-check never ran)
// ---------------------------------------------------------------------------

describe('renderMd — Harness preparation: installed-only banner splits "installed" from "installed and checked"', () => {
  const base = {
    mode: 'installed-only' as const,
    setupDeclared: true,
    exerciseDeclared: false,
    exercises: [],
  }

  it('--pack-setup only, no --pack-check: banner says "installed" and states plainly that nothing checked it', () => {
    const packSetup: PackSetupReport = { ...base, checkDeclared: false, checks: [] }
    const md = renderMd(makeReport({ packSetup }))
    expect(md).not.toContain('installed and verified functional')
    expect(md).not.toContain('installed and checked functional')
    expect(md).toContain('The pack was installed, but the harness never ran --pack-check to confirm it works')
    expect(md).toContain('unverified copy')
  })

  it('--pack-check declared but never actually ran (e.g. preflight disabled, checks stayed empty): still the unchecked wording, not "checked"', () => {
    const packSetup: PackSetupReport = { ...base, checkDeclared: true, checks: [] }
    const md = renderMd(makeReport({ packSetup }))
    expect(md).toContain('the harness never ran --pack-check to confirm it works')
    expect(md).not.toContain('installed and checked functional')
  })

  it('--pack-check genuinely ran and passed: banner says "installed and checked functional", not just "installed"', () => {
    const packSetup: PackSetupReport = {
      ...base,
      checkDeclared: true,
      checks: [{ side: 'new', runIndex: 1, exitCode: 0, durationMs: '400' }],
    }
    const md = renderMd(makeReport({ packSetup }))
    expect(md).toContain('The pack was installed and checked functional')
    expect(md).not.toContain('harness never ran --pack-check')
  })
})

// ---------------------------------------------------------------------------
// Harness preparation — no-artifact warning (review-gate: an exit-0 exercise
// with no tracked artifact must not read as a silent success)
// ---------------------------------------------------------------------------

describe('renderMd — Harness preparation: no-artifact warning', () => {
  const basePackSetup: PackSetupReport = {
    mode: 'installed-only',
    setupDeclared: false,
    checkDeclared: false,
    exerciseDeclared: true,
    checks: [],
    exercises: [],
  }

  it('every exercise exits 0 but leaves no artifact → warned, not silently rendered as plain success', () => {
    const packSetup: PackSetupReport = {
      ...basePackSetup,
      exercises: [
        { side: 'new', runIndex: 1, exitCode: 0, durationMs: '10' },
        { side: 'new', runIndex: 2, exitCode: 0, durationMs: '12' },
      ],
    }
    const md = renderMd(makeReport({ packSetup }))
    expect(md).toContain('Exercise produced no artifact on any of 2 run(s)')
  })

  it('at least one run recorded an artifact → no warning', () => {
    const packSetup: PackSetupReport = {
      ...basePackSetup,
      exercises: [
        { side: 'new', runIndex: 1, exitCode: 0, durationMs: '10', artifactHash: 'abc' },
        { side: 'new', runIndex: 2, exitCode: 0, durationMs: '12' },
      ],
    }
    const md = renderMd(makeReport({ packSetup }))
    expect(md).not.toContain('produced no artifact')
  })

  it('no exercises at all → no warning (nothing to be suspicious about)', () => {
    const packSetup: PackSetupReport = { ...basePackSetup, exerciseDeclared: false, exercises: [] }
    const md = renderMd(makeReport({ packSetup }))
    expect(md).not.toContain('produced no artifact')
  })
})
