import { describe, it, expect } from 'vitest'
import { renderMd } from './md.js'
import {
  makeReport,
  makeMetricsDiff,
  makeSideAggregates,
  makeDiffResult,
  makeManifest,
  makeJudge,
} from '../../tests/report-fixture.js'
import type { FailedRun, JudgeResult, Manifest, MetricDelta, PrimaryDeltas } from '@generated/types'
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

  it('has the table header row', () => {
    expect(md).toContain('| Metric | Old (median) | New (median) | Δ | Δ% | Significant | Verdict |')
    expect(md).toContain('|---|---|---|---|---|---|---|')
  })

  it('renders total tokens row with better verdict and significant', () => {
    expect(md).toContain('| Total tokens | 12345 | 10987 | -1358 | -11.0% | ✓ significant | ✓ better |')
  })

  it('renders wall-clock row as worse in noise', () => {
    expect(md).toContain('| Wall-clock (ms) | 45000 | 52000 | +7000 | +15.6% | in noise | ⚠ worse |')
  })

  it('renders tool-call row as significant worse', () => {
    expect(md).toContain('| Tool calls | 25 | 30 | +5 | +20.0% | ⚠ significant | ⚠ worse |')
  })

  it('renders neutral success rank with dash significance', () => {
    expect(md).toContain('| Success rank | 4 | 4 | 0 | 0.0% | — | = same |')
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
