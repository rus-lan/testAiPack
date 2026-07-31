import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeJson, writeFile } from '../util/fs.js'
import { makeVariantAggregates } from '../../tests/helpers/variants.js'
import type { Manifest, MetricDelta, Report } from '@generated/types'
import {
  compare,
  selectVariant,
  buildCompareHeadline,
  renderCompareMd,
  compareResultToJson,
  executeCompare,
  isVariantSelector,
  isCompareFormat,
} from './compare.js'
import type { DeltaEntry } from '../report/format.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

// WP7's computeVariantDelta (src/metrics/aggregate.ts) and WP8's
// deltaEntriesFor(metrics, variant) (src/report/format.ts) are already
// merged with the signatures spec'd in 04-work-packages.md §WP7/§WP8 — used
// directly here, no mocks needed.

// ---------------------------------------------------------------------------
// Fixtures — `report1` is a 2-variant ("old"/"new") v2 report, `report2` a
// 3-variant v2 report with an arbitrarily-named variant "b" — most tests
// below run entirely in v2 shapes (compare.ts only ever sees v2 Report
// objects; WP13's readReport does the v1->v2 compat mapping before compare
// ever runs). The "cli/compare — v1 fixture through the real compat seam"
// describe block below is the one place that goes through the real seam
// end-to-end with a genuine v1-shaped report.json on disk.
//
// Numbers are hand-picked against baseSamples' documented IQRs in
// tests/helpers/variants.ts (totalTokens 300, wallClockMs 4500, costUsd
// 0.0045, stepCount 3, toolCallCount 3) so every delta below is verifiable
// by hand: significant iff |absolute| > 1.5 * iqr.
// ---------------------------------------------------------------------------

const TS1 = '2026-07-16T10:00:00.000Z'
const TS2 = '2026-07-23T10:00:00.000Z'

const buildManifest1 = (): Manifest => ({
  schemaVersion: 2,
  runId: 'run-one',
  timestamp: TS1,
  repoUrl: 'https://example.com/repo.git',
  runs: 1,
  parallel: 2,
  baseline: 'old',
  packs: [{ name: 'demo-pack', ref: 'https://example.com/demo-pack.git' }],
  variants: [
    { name: 'old', packs: [] },
    { name: 'new', packs: ['demo-pack'] },
  ],
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
})

// stats stay baseSamples-derived (iqr: totalTokens 300, wallClockMs 4500,
// costUsd .0045, stepCount 3, toolCallCount 3; successRank iqr 0.25).
const old1 = makeVariantAggregates('old', {
  primary: {
    totalTokens: '12000',
    wallClockMs: '50000',
    costUsd: 0.05,
    stepCount: 12,
    toolCallCount: 20,
    successRank: 2,
    maxParallelism: 1,
  },
})
const new1 = makeVariantAggregates('new', {
  primary: {
    totalTokens: '10000',
    wallClockMs: '40000',
    costUsd: 0.045,
    stepCount: 10,
    toolCallCount: 18,
    successRank: 3,
    maxParallelism: 1,
  },
})

const buildReport1 = (): Report => ({
  schemaVersion: 2,
  manifest: buildManifest1(),
  metrics: { baseline: 'old', variants: [old1, new1], deltas: [], allFailed: false },
  timeline: { lanes: [], mode: 'side-by-side' },
  diffs: [],
  summary: { headlineResult: '', perVariant: [], failures: [] },
})

const buildManifest2 = (): Manifest => ({
  schemaVersion: 2,
  runId: 'run-two',
  timestamp: TS2,
  repoUrl: 'https://example.com/other-repo.git',
  runs: 1,
  parallel: 3,
  baseline: 'base',
  packs: [
    { name: 'graphify', ref: 'https://example.com/graphify.git' },
    { name: 'b-pack', ref: 'https://example.com/b-pack.git' },
  ],
  variants: [
    { name: 'base', packs: [] },
    { name: 'graphify', packs: ['graphify'] },
    { name: 'b', packs: ['b-pack'] },
  ],
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
})

const base2 = makeVariantAggregates('base') // successRank median 4 (baseSamples)
const graphify2 = makeVariantAggregates('graphify') // successRank median 4 (graphifySamples)
const b2 = makeVariantAggregates('b', {
  primary: {
    totalTokens: '9000',
    wallClockMs: '39500',
    costUsd: 0.04,
    stepCount: 9,
    toolCallCount: 19,
    successRank: 4, // ties base/graphify -> 'best' must resolve to 'b' (later in config order)
    maxParallelism: 2,
  },
})

const buildReport2 = (): Report => ({
  schemaVersion: 2,
  manifest: buildManifest2(),
  metrics: { baseline: 'base', variants: [base2, graphify2, b2], deltas: [], allFailed: false },
  timeline: { lanes: [], mode: 'side-by-side' },
  diffs: [],
  summary: { headlineResult: '', perVariant: [], failures: [] },
})

const seedRun = async (ws: string, runId: string, report: Report): Promise<void> => {
  const dir = path.join(ws, runId)
  await runP(ensureDir(path.join(dir, 'results')))
  await runP(writeJson(path.join(dir, 'manifest.json'), report.manifest))
  await runP(writeJson(path.join(dir, 'results', 'report.json'), report))
}

const seedBoth = async (ws: string): Promise<void> => {
  await seedRun(ws, 'run-one', buildReport1())
  await seedRun(ws, 'run-two', buildReport2())
}

describe('cli/compare — cross-report compare (2-variant report vs 3-variant report)', () => {
  it('run 1s selection (new) plays the baseline role for run 2s selection (b)', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const result = await runP(
      compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'new', variant2: 'b', format: 'md' }),
    )
    expect(result.run1.metrics.variant).toBe('new')
    expect(result.run2.metrics.variant).toBe('b')
    expect(result.delta.variant).toBe('b')
    expect(result.basis).toBe('total')

    const tokens = result.entries.find((e) => e.key === 'totalTokens')
    expect(tokens?.d.absolute).toBe(-1000) // 9000 - 10000
    expect(tokens?.d.significant).toBe(true) // |−1000| > 1.5*300
    expect(tokens?.d.better).toBe('better')

    const wall = result.entries.find((e) => e.key === 'wallClockMs')
    expect(wall?.d.absolute).toBe(-500) // 39500 - 40000
    expect(wall?.d.significant).toBe(false) // 500 < 1.5*4500

    const toolCalls = result.entries.find((e) => e.key === 'toolCallCount')
    expect(toolCalls?.d.absolute).toBe(1) // 19 - 18
    expect(toolCalls?.d.better).toBe('worse')
    expect(toolCalls?.d.significant).toBe(false)

    const rank = result.entries.find((e) => e.key === 'successRank')
    expect(rank?.d.absolute).toBe(1) // 4 - 3
    expect(rank?.d.significant).toBe(true) // 1 > 1.5*0.25
    expect(rank?.d.better).toBe('better')
  })

  it('headline mentions fewer tokens, less wall-clock and a higher success rank (old vs new, same run)', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const result = await runP(
      compare({ runId1: 'run-one', runId2: 'run-one', workspace: ws, variant1: 'old', variant2: 'new', format: 'md' }),
    )
    expect(result.headlineResult).toContain('меньше токенов')
    expect(result.headlineResult).toContain('меньше времени (wall-clock)')
    expect(result.headlineResult).toContain('более высокого ранга успеха')
  })
})

describe('cli/compare — errors', () => {
  it('fails with E_RUN_NOT_FOUND when run1 is missing', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'run-two', buildReport2())
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({ runId1: 'missing', runId2: 'run-two', workspace: ws, variant1: 'old', variant2: 'base', format: 'md' }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.code).toBe('E_RUN_NOT_FOUND')
      expect(outcome.left.message).toContain('missing')
    }
  })

  it('fails with E_RUN_NOT_FOUND when run2 is missing', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'run-one', buildReport1())
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({ runId1: 'run-one', runId2: 'nope', workspace: ws, variant1: 'old', variant2: 'best', format: 'md' }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.code).toBe('E_RUN_NOT_FOUND')
  })

  it('fails with E_REPORT_INVALID when report.json is malformed', async () => {
    const ws = makeTempDir()
    const dir1 = path.join(ws, 'run-one')
    await runP(ensureDir(path.join(dir1, 'results')))
    await runP(writeJson(path.join(dir1, 'manifest.json'), buildManifest1()))
    await runP(writeFile(path.join(dir1, 'results', 'report.json'), '{not-json'))
    await seedRun(ws, 'run-two', buildReport2())
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'old', variant2: 'base', format: 'md' }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.code).toBe('E_REPORT_INVALID')
  })

  it('fails with E_VARIANT_NOT_FOUND for an unknown selector on run1, listing run1s names', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'nope', variant2: 'base', format: 'md' }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.code).toBe('E_VARIANT_NOT_FOUND')
      expect(outcome.left.message).toContain('nope')
      expect(outcome.left.message).toContain('old, new')
    }
  })

  it('fails with E_VARIANT_NOT_FOUND for an unknown selector on run2, listing run2s names', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'old', variant2: 'nope', format: 'md' }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.code).toBe('E_VARIANT_NOT_FOUND')
      expect(outcome.left.message).toContain('base, graphify, b')
    }
  })

  it('fails cleanly (not a crash) when --variant best is asked of a report with no variants (F5)', async () => {
    const ws = makeTempDir()
    const report: Report = {
      ...buildReport1(),
      manifest: { ...buildManifest1(), variants: [] },
      metrics: { baseline: 'old', variants: [], deltas: [], allFailed: true },
    }
    await seedRun(ws, 'run-one', report)
    await seedRun(ws, 'run-two', buildReport2())
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'best', variant2: 'base', format: 'md' }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.code).toBe('E_VARIANT_NOT_FOUND')
      expect(outcome.left.message).toContain('run-one')
    }
  })
})

describe('cli/compare — pure helpers: selectVariant', () => {
  it('by name resolves the matching VariantAggregates', async () => {
    const picked = await runP(selectVariant(buildReport2(), 'graphify'))
    expect(picked.variant).toBe('graphify')
  })

  it('best resolves the highest median successRank, even mid-list', async () => {
    const x = makeVariantAggregates('x', { primary: { ...b2.primary, successRank: 2 } })
    const y = makeVariantAggregates('y', { primary: { ...b2.primary, successRank: 5 } })
    const z = makeVariantAggregates('z', { primary: { ...b2.primary, successRank: 3 } })
    const report: Report = {
      ...buildReport1(),
      metrics: { baseline: 'x', variants: [x, y, z], deltas: [], allFailed: false },
    }
    const picked = await runP(selectVariant(report, 'best'))
    expect(picked.variant).toBe('y')
  })

  it('best ties resolve to the later variant in config order', async () => {
    const picked = await runP(selectVariant(buildReport2(), 'best'))
    expect(picked.variant).toBe('b')
  })

  it('unknown name fails with E_VARIANT_NOT_FOUND listing available names', async () => {
    const outcome = await Effect.runPromise(Effect.either(selectVariant(buildReport2(), 'nope', 'run-two')))
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') {
      expect(outcome.left.code).toBe('E_VARIANT_NOT_FOUND')
      expect(outcome.left.message).toContain('nope')
      expect(outcome.left.message).toContain('base, graphify, b')
      expect(outcome.left.message).toContain('run-two')
    }
  })
})

describe('cli/compare — pure helpers: buildCompareHeadline', () => {
  const entry = (key: string, d: MetricDelta): DeltaEntry => ({ key, label: key, kind: 'int', d })

  it('signals fewer tokens, less wall-clock and a lower success rank', () => {
    const entries: DeltaEntry[] = [
      entry('totalTokens', { absolute: -1000, percent: -10, significant: true, better: 'better' }),
      entry('wallClockMs', { absolute: -1000, percent: -5, significant: false, better: 'better' }),
      entry('successRank', { absolute: -1, percent: -20, significant: true, better: 'worse' }),
    ]
    const headline = buildCompareHeadline(entries)
    expect(headline).toContain('меньше токенов')
    expect(headline).toContain('более низкого ранга успеха')
  })

  it('handles an omitted percent (0 -> non-zero change) without "NaN%"', () => {
    const entries: DeltaEntry[] = [
      entry('totalTokens', { absolute: 500, significant: true, better: 'worse' }),
      entry('wallClockMs', { absolute: -1000, percent: -5, significant: false, better: 'better' }),
      entry('successRank', { absolute: 0, percent: 0, significant: false, better: 'neutral' }),
    ]
    const headline = buildCompareHeadline(entries)
    expect(headline).not.toContain('NaN')
    expect(headline).toContain('больше токенов')
  })

  it('falls back gracefully when a headline key is missing from entries', () => {
    const headline = buildCompareHeadline([])
    expect(headline).toContain('неизмеримое')
  })
})

describe('cli/compare — selector/format guards', () => {
  it('isVariantSelector accepts any non-empty string, rejects the empty string', () => {
    expect(isVariantSelector('best')).toBe(true)
    expect(isVariantSelector('graphify')).toBe(true)
    expect(isVariantSelector('')).toBe(false)
  })

  it('isCompareFormat accepts md/json only', () => {
    expect(isCompareFormat('md')).toBe(true)
    expect(isCompareFormat('json')).toBe(true)
    expect(isCompareFormat('yaml')).toBe(false)
  })
})

describe('cli/compare — renderers', () => {
  const makeResult = async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    return runP(
      compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'new', variant2: 'b', format: 'md' }),
    )
  }

  it('renderCompareMd emits header, summary and the metrics table', async () => {
    const result = await makeResult()
    const md = renderCompareMd(result)
    expect(md).toContain('# testaipack compare')
    expect(md).toContain('**Запуск 1:** run-one')
    expect(md).toContain('**Запуск 2:** run-two')
    expect(md).toContain('вариант: new')
    expect(md).toContain('вариант: b')
    expect(md).toContain('**Основа:** total')
    expect(md).toContain('## Summary')
    expect(md).toContain(result.headlineResult)
    expect(md).toContain('| Метрика | Запуск 1 | Запуск 2 | Δ | Δ% | Значимо | Вердикт |')
    // raw per-run values (F4) — run1=new (totalTokens 10000), run2=b (totalTokens 9000)
    expect(md).toContain('| Всего токенов | 10000 | 9000 | -1000 | -10.0% | ✓ значимо | ✓ лучше |')
  })

  it('renderCompareMd adds a warning note when the pair is incomplete (one side has no samples)', async () => {
    const emptyStats = {
      totalTokens: { median: 0, min: 0, max: 0, samples: [] },
      wallClockMs: { median: 0, min: 0, max: 0, samples: [] },
      costUsd: { median: 0, min: 0, max: 0, samples: [] },
      stepCount: { median: 0, min: 0, max: 0, samples: [] },
      toolCallCount: { median: 0, min: 0, max: 0, samples: [] },
      successRank: { median: 0, min: 0, max: 0, samples: [] },
    }
    const emptyVariant = makeVariantAggregates('empty', {
      primary: { totalTokens: '0', wallClockMs: '0', costUsd: 0, stepCount: 0, toolCallCount: 0, successRank: 0, maxParallelism: 0 },
      stats: emptyStats,
      rawRunIds: [],
    })
    const ws = makeTempDir()
    const report: Report = {
      ...buildReport1(),
      manifest: {
        ...buildManifest1(),
        runId: 'run-incomplete',
        variants: [{ name: 'old', packs: [] }, { name: 'empty', packs: [] }],
      },
      metrics: { baseline: 'old', variants: [old1, emptyVariant], deltas: [], allFailed: false },
    }
    await seedRun(ws, 'run-incomplete', report)
    const result = await runP(
      compare({ runId1: 'run-incomplete', runId2: 'run-incomplete', workspace: ws, variant1: 'old', variant2: 'empty', format: 'md' }),
    )
    expect(result.delta.pairIncomplete).toBe(true)
    expect(renderCompareMd(result)).toContain('не дала ни одной выборки')
  })

  it('renderCompareMd shows the no-packs label for a smoke-test variant', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const result = await runP(
      compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'old', variant2: 'base', format: 'md' }),
    )
    expect(renderCompareMd(result)).toContain('_нет пакетов (smoke-test)_')
  })

  it('renderCompareMd flags a best selection as "(requested: best)"', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const result = await runP(
      compare({ runId1: 'run-one', runId2: 'run-two', workspace: ws, variant1: 'best', variant2: 'b', format: 'md' }),
    )
    expect(result.run1.metrics.variant).toBe('new') // old=2, new=3 -> new wins, no tie
    expect(renderCompareMd(result)).toContain('(запрошено: best)')
  })

  it('compareResultToJson returns keyed delta entries', async () => {
    const result = await makeResult()
    const json = compareResultToJson(result)
    expect(json.run1.id).toBe('run-one')
    expect(json.run1.variant).toBe('new')
    expect(json.run2.variant).toBe('b')
    expect(json.headlineResult).toBe(result.headlineResult)
    expect(json.entries.length).toBe(7)
    const tokens = json.entries.find((e) => e.key === 'totalTokens')
    expect(tokens?.d.absolute).toBe(-1000)
  })
})

describe('cli/compare — executeCompare (CLI glue)', () => {
  it('writes the md table to stdout and exits 0', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const code = await executeCompare({
        runId1: 'run-one',
        runId2: 'run-two',
        workspace: ws,
        variant1: 'new',
        variant2: 'b',
        format: 'md',
      })
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(chunks.join('')).toContain('# testaipack compare')
  })

  it('writes JSON to stdout when format is json', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const code = await executeCompare({
        runId1: 'run-one',
        runId2: 'run-two',
        workspace: ws,
        variant1: 'old',
        variant2: 'graphify',
        format: 'json',
      })
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const parsed: unknown = JSON.parse(chunks.join(''))
    expect((parsed as { run2: { variant: string } }).run2.variant).toBe('graphify')
  })

  it('exits 1 and logs the error code for an unknown variant', async () => {
    const ws = makeTempDir()
    await seedBoth(ws)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const code = await executeCompare({
        runId1: 'run-one',
        runId2: 'run-two',
        workspace: ws,
        variant1: 'old',
        variant2: 'nope',
        format: 'md',
      })
      expect(code).toBe(1)
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('E_VARIANT_NOT_FOUND'))
    } finally {
      spy.mockRestore()
    }
  })
})

describe('cli/compare — significance is judged against run 1s IQR, not run 2s (F6)', () => {
  it('a wide spread on run 2 does not suppress significance judged against run 1s narrow IQR', async () => {
    // Every tests/helpers/variants.ts fixture is an arithmetic progression
    // with the same step, so base/graphify/astgrep all yield near-identical
    // IQRs — an implementation that read run2's IQR instead of run1's would
    // still pass every other test in this file. This fixture deliberately
    // gives run1 (the baseline) a narrow IQR and run2 a huge one so the two
    // readings disagree on significance.
    const narrowBase = makeVariantAggregates('narrow-base', {
      primary: {
        totalTokens: '10000', wallClockMs: '40000', costUsd: 0.03, stepCount: 10, toolCallCount: 20, successRank: 3, maxParallelism: 1,
      },
      stats: {
        totalTokens: { median: 10000, min: 9950, max: 10050, iqr: 50, samples: [9950, 10000, 10000, 10050] },
        wallClockMs: { median: 40000, min: 39000, max: 41000, iqr: 500, samples: [39000, 40000, 40000, 41000] },
        costUsd: { median: 0.03, min: 0.029, max: 0.031, iqr: 0.001, samples: [0.029, 0.03, 0.03, 0.031] },
        stepCount: { median: 10, min: 9, max: 11, iqr: 1, samples: [9, 10, 10, 11] },
        toolCallCount: { median: 20, min: 19, max: 21, iqr: 1, samples: [19, 20, 20, 21] },
        successRank: { median: 3, min: 2, max: 4, iqr: 1, samples: [2, 3, 3, 4] },
      },
    })
    const wideV = makeVariantAggregates('wide-v', {
      // totalTokens absolute delta is +100 — significant against narrowBase's
      // iqr=50 (threshold 75), NOT significant against wideV's own iqr=10000
      // (threshold 15000). Only the correct (run1/baseline) reading passes.
      primary: {
        totalTokens: '10100', wallClockMs: '40000', costUsd: 0.03, stepCount: 10, toolCallCount: 20, successRank: 3, maxParallelism: 1,
      },
      stats: {
        totalTokens: { median: 10100, min: 0, max: 20000, iqr: 10000, samples: [0, 5000, 15000, 20000] },
        wallClockMs: { median: 40000, min: 39000, max: 41000, iqr: 500, samples: [39000, 40000, 40000, 41000] },
        costUsd: { median: 0.03, min: 0.029, max: 0.031, iqr: 0.001, samples: [0.029, 0.03, 0.03, 0.031] },
        stepCount: { median: 10, min: 9, max: 11, iqr: 1, samples: [9, 10, 10, 11] },
        toolCallCount: { median: 20, min: 19, max: 21, iqr: 1, samples: [19, 20, 20, 21] },
        successRank: { median: 3, min: 2, max: 4, iqr: 1, samples: [2, 3, 3, 4] },
      },
    })
    const ws = makeTempDir()
    const report: Report = {
      ...buildReport1(),
      manifest: {
        ...buildManifest1(),
        runId: 'run-sig',
        variants: [{ name: 'narrow-base', packs: [] }, { name: 'wide-v', packs: [] }],
      },
      metrics: { baseline: 'narrow-base', variants: [narrowBase, wideV], deltas: [], allFailed: false },
    }
    await seedRun(ws, 'run-sig', report)
    const result = await runP(
      compare({
        runId1: 'run-sig',
        runId2: 'run-sig',
        workspace: ws,
        variant1: 'narrow-base',
        variant2: 'wide-v',
        format: 'md',
      }),
    )
    const tokens = result.entries.find((e) => e.key === 'totalTokens')
    expect(tokens?.d.absolute).toBe(100)
    expect(tokens?.d.significant).toBe(true) // would be false if run2's iqr (10000) were used instead of run1's (50)
  })
})

describe('cli/compare — same variant name on both sides (F7: "pack-X a week ago vs pack-X now")', () => {
  it('selects "new" from both runs when variant1 and variant2 share a name', async () => {
    const ws = makeTempDir()
    await seedRun(ws, 'run-a', buildReport1())
    const laterNew = makeVariantAggregates('new', {
      primary: { ...new1.primary, totalTokens: '9500' },
    })
    const reportB: Report = {
      ...buildReport1(),
      manifest: { ...buildManifest1(), runId: 'run-b', timestamp: TS2 },
      metrics: { baseline: 'old', variants: [old1, laterNew], deltas: [], allFailed: false },
    }
    await seedRun(ws, 'run-b', reportB)

    const result = await runP(
      compare({ runId1: 'run-a', runId2: 'run-b', workspace: ws, variant1: 'new', variant2: 'new', format: 'md' }),
    )
    expect(result.run1.metrics.variant).toBe('new')
    expect(result.run2.metrics.variant).toBe('new')
    const tokens = result.entries.find((e) => e.key === 'totalTokens')
    expect(tokens?.d.absolute).toBe(-500) // 9500 - 10000, "new" now vs "new" a week ago
  })
})

describe('cli/compare — task basis (F8, pairs with F4s raw-value columns)', () => {
  const dist = (median: number, iqr: number): { median: number; min: number; max: number; iqr: number; samples: number[] } => ({
    median,
    min: median,
    max: median,
    iqr,
    samples: [median],
  })

  it('reads task-slice raw values for splittable metrics and primary for whole-run-only ones', async () => {
    const taskBase = makeVariantAggregates('old', {
      primary: {
        totalTokens: '12000', wallClockMs: '50000', costUsd: 0.05, stepCount: 12, toolCallCount: 20, successRank: 2, maxParallelism: 1,
      },
      phaseSplit: {
        runsWithInit: 0,
        runsWithLostInit: 0,
        task: { totalTokens: '8000', wallClockMs: '30000', costUsd: 0.03, stepCount: 8, toolCallCount: 14 },
        taskStats: {
          totalTokens: dist(8000, 200),
          wallClockMs: dist(30000, 3000),
          costUsd: dist(0.03, 0.002),
          stepCount: dist(8, 2),
          toolCallCount: dist(14, 2),
        },
      },
    })
    const taskNew = makeVariantAggregates('new', {
      primary: {
        totalTokens: '10000', wallClockMs: '40000', costUsd: 0.045, stepCount: 10, toolCallCount: 18, successRank: 3, maxParallelism: 1,
      },
      phaseSplit: {
        runsWithInit: 0,
        runsWithLostInit: 0,
        task: { totalTokens: '7000', wallClockMs: '29000', costUsd: 0.028, stepCount: 7, toolCallCount: 15 },
        taskStats: {
          totalTokens: dist(7000, 150),
          wallClockMs: dist(29000, 2000),
          costUsd: dist(0.028, 0.001),
          stepCount: dist(7, 1),
          toolCallCount: dist(15, 1),
        },
      },
    })
    const ws = makeTempDir()
    const report: Report = {
      ...buildReport1(),
      manifest: { ...buildManifest1(), runId: 'run-task' },
      metrics: { baseline: 'old', variants: [taskBase, taskNew], deltas: [], allFailed: false },
    }
    await seedRun(ws, 'run-task', report)
    const result = await runP(
      compare({ runId1: 'run-task', runId2: 'run-task', workspace: ws, variant1: 'old', variant2: 'new', format: 'md' }),
    )
    expect(result.basis).toBe('task')

    const tokens = result.entries.find((e) => e.key === 'totalTokens')
    expect(tokens?.d.absolute).toBe(-1000) // 7000 - 8000 (task slice), not 10000 - 12000 (primary)

    const md = renderCompareMd(result)
    // splittable metric: raw columns show the task slice (8000/7000), not primary (12000/10000)
    expect(md).toContain('| Всего токенов | 8000 | 7000 |')
    // whole-run-only metric: raw columns still show primary (2/3), never split
    expect(md).toContain('| Ранг успеха | 2 | 3 |')
  })
})

describe('cli/compare — v1 fixture through the real compat seam (F3)', () => {
  // Pattern copied from src/compat/legacy.test.ts:120-173 (v1Manifest /
  // v1SideAggregates / v1Report) — that file and tests/report-fixture.ts are
  // shared/off-limits per orchestrator ruling, so this is a local, minimal
  // duplicate exercising the real seam: readReport -> parseReportCompat ->
  // mapReportV1ToV2, not a v2 hand-rolled approximation of a v1 report.
  const v1Primary = {
    totalTokens: '10000', wallClockMs: '40000', costUsd: 0.03, stepCount: 10, toolCallCount: 20, successRank: 4, maxParallelism: 1,
  }
  const v1Secondary = {
    inputTokens: '6000', outputTokens: '4000', reasoningTokens: '0', cacheReadTokens: '0',
    perTool: {}, reasoningTimeMs: '0', stepLatencyP50Ms: '100', stepLatencyP95Ms: '200', toolLatencyAvgMs: '50',
    finishCauseDistribution: { stop: 1 }, maxConsecutiveSameTool: 1,
  }
  const v1Dist = (median: number): Record<string, unknown> => ({
    median, min: median, max: median, samples: [median, median, median, median],
  })
  const v1Stats = {
    totalTokens: v1Dist(10000), wallClockMs: v1Dist(40000), costUsd: v1Dist(0.03), stepCount: v1Dist(10), toolCallCount: v1Dist(20), successRank: v1Dist(4),
  }
  const v1SideAggregates = (side: 'old' | 'new'): Record<string, unknown> => ({
    side,
    primary: side === 'new' ? { ...v1Primary, totalTokens: '9000' } : v1Primary,
    secondary: v1Secondary,
    stats: v1Stats,
    failedRuns: [],
    rawRunIds: [`session-${side}-1`],
  })
  const v1MetricDelta = { absolute: -1000, percent: -10, significant: true, better: 'better' as const }
  const v1PrimaryDeltas = {
    totalTokens: v1MetricDelta, wallClockMs: v1MetricDelta, costUsd: v1MetricDelta, stepCount: v1MetricDelta,
    toolCallCount: v1MetricDelta, successRank: v1MetricDelta, maxParallelism: v1MetricDelta,
  }
  const v1TimelineEvent = (side: 'old' | 'new'): Record<string, unknown> => ({
    tStart: '0', tEnd: '1000', side, runIndex: 1, sessionId: `sess-${side}-1`, swimlaneDepth: 0, type: 'tool-call', tool: 'read',
  })
  const v1DiffResult = (side: 'old' | 'new'): Record<string, unknown> => ({
    side,
    runs: [{ runIndex: 1, fullPatch: 'diff --git a/x b/x\n', summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] }, noChanges: false }],
  })
  const v1Manifest = (): Record<string, unknown> => ({
    runId: 'run-v1',
    timestamp: '2025-06-01T00:00:00.000Z',
    repoUrl: 'https://example.com/repo.git',
    packRef: 'https://example.com/graphify.git',
    packType: 'skill',
    prompt: 'do the thing',
    init: '/graphify .',
    verify: 'npm test',
    runs: 3,
    isolation: 'home',
    opencodeVersion: '1.18.3',
    flagDefaults: {},
  })
  const v1Report = (): Record<string, unknown> => ({
    manifest: v1Manifest(),
    metricsDiff: {
      old: v1SideAggregates('old'),
      new: v1SideAggregates('new'),
      deltas: v1PrimaryDeltas,
      bothFailed: false,
    },
    timeline: { old: [v1TimelineEvent('old')], new: [v1TimelineEvent('new')], mode: 'side-by-side' },
    diff: { old: v1DiffResult('old'), new: v1DiffResult('new') },
    summary: {
      headlineResult: 'new is faster',
      improvements: [v1MetricDelta],
      regressions: [],
      neutral: [],
      failures: [],
    },
  })

  const seedRawRun = async (ws: string, runId: string, manifest: unknown, report: unknown): Promise<void> => {
    const dir = path.join(ws, runId)
    await runP(ensureDir(path.join(dir, 'results')))
    await runP(writeJson(path.join(dir, 'manifest.json'), manifest))
    await runP(writeJson(path.join(dir, 'results', 'report.json'), report))
  }

  it('compares a v1-shaped report (compat-mapped by readReport) against a v2 3-variant report', async () => {
    const ws = makeTempDir()
    await seedRawRun(ws, 'run-v1', v1Manifest(), v1Report())
    await seedRun(ws, 'run-two', buildReport2())
    const result = await runP(
      compare({ runId1: 'run-v1', runId2: 'run-two', workspace: ws, variant1: 'new', variant2: 'b', format: 'md' }),
    )
    expect(result.run1.metrics.variant).toBe('new')
    expect(result.run2.metrics.variant).toBe('b')
    const md = renderCompareMd(result)
    expect(md).toContain('# testaipack compare')
    expect(md).toContain('| Метрика | Запуск 1 | Запуск 2 |')
  })
})
