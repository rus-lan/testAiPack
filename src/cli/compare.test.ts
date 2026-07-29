import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeJson, writeFile } from '../util/fs.js'
import {
  makeManifest,
  makeReport,
  makeMetricsDiff,
  makeSideAggregates,
} from '../../tests/report-fixture.js'
import type {
  Manifest,
  MetricsDiff,
  PrimaryMetrics,
  Report,
  SideAggregates,
} from '@generated/types'
import {
  compare,
  resolvePerspective,
  selectSide,
  buildCompareHeadline,
  renderCompareMd,
  compareResultToJson,
} from './compare.js'
import { runCli } from './index.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const oldP1: PrimaryMetrics = {
  totalTokens: '12000',
  wallClockMs: '50000',
  costUsd: 0.05,
  stepCount: 12,
  toolCallCount: 20,
  successRank: 2,
  maxParallelism: 1,
}
const newP1: PrimaryMetrics = {
  totalTokens: '10000',
  wallClockMs: '40000',
  costUsd: 0.045,
  stepCount: 10,
  toolCallCount: 18,
  successRank: 3,
  maxParallelism: 1,
}
const oldP2: PrimaryMetrics = {
  totalTokens: '13000',
  wallClockMs: '60000',
  costUsd: 0.06,
  stepCount: 14,
  toolCallCount: 22,
  successRank: 3,
  maxParallelism: 1,
}
const newP2: PrimaryMetrics = {
  totalTokens: '11500',
  wallClockMs: '48000',
  costUsd: 0.055,
  stepCount: 11,
  toolCallCount: 21,
  successRank: 4,
  maxParallelism: 1,
}

interface SeedOpts {
  readonly runId: string
  readonly timestamp: string
  readonly packRef?: string
  readonly oldPrimary: PrimaryMetrics
  readonly newPrimary: PrimaryMetrics
}

const seedRun = async (ws: string, opts: SeedOpts): Promise<void> => {
  const dir = path.join(ws, opts.runId)
  await runP(ensureDir(path.join(dir, 'results')))
  const manifest: Manifest = makeManifest({
    runId: opts.runId,
    timestamp: opts.timestamp,
    ...(opts.packRef === undefined ? {} : { packRef: opts.packRef }),
  })
  const oldAgg: SideAggregates = makeSideAggregates('old', { primary: opts.oldPrimary })
  const newAgg: SideAggregates = makeSideAggregates('new', { primary: opts.newPrimary })
  const metricsDiff: MetricsDiff = makeMetricsDiff({ old: oldAgg, new: newAgg })
  const report: Report = makeReport({ manifest, metricsDiff })
  await runP(writeJson(path.join(dir, 'manifest.json'), manifest))
  await runP(writeJson(path.join(dir, 'results', 'report.json'), report))
}

const seedManifest = async (
  ws: string,
  runId: string,
  timestamp: string,
): Promise<string> => {
  const dir = path.join(ws, runId)
  await runP(ensureDir(path.join(dir, 'results')))
  const manifest = makeManifest({ runId, timestamp })
  await runP(writeJson(path.join(dir, 'manifest.json'), manifest))
  return dir
}

const seedPair = async (ws: string, packRef = 'git+pack-x'): Promise<void> => {
  await seedRun(ws, {
    runId: 'run-one',
    timestamp: '2026-07-16T10:00:00.000Z',
    packRef,
    oldPrimary: oldP1,
    newPrimary: newP1,
  })
  await seedRun(ws, {
    runId: 'run-two',
    timestamp: '2026-07-23T10:00:00.000Z',
    packRef,
    oldPrimary: oldP2,
    newPrimary: newP2,
  })
}

const TS1 = '2026-07-16T10:00:00.000Z'
const TS2 = '2026-07-23T10:00:00.000Z'

const compareOk = (ws: string, over: Partial<Parameters<typeof compare>[0]> = {}) =>
  runP(
    compare({
      runId1: 'run-one',
      runId2: 'run-two',
      workspace: ws,
      perspective: 'new-vs-new',
      format: 'md',
      ...over,
    }),
  )

describe('cli/compare — happy path (new-vs-new)', () => {
  it('computes deltas between the new sides of both runs', async () => {
    const ws = makeTempDir()
    await seedPair(ws)
    const result = await compareOk(ws)
    expect(result.perspective).toBe('new-vs-new')
    expect(result.run1.id).toBe('run-one')
    expect(result.run2.id).toBe('run-two')
    expect(result.run1.metrics.side).toBe('new')
    expect(result.run2.metrics.side).toBe('new')

    const tokens = result.diff[0]
    const rank = result.diff[5]
    expect(tokens?.absolute).toBe(1500)
    expect(tokens?.percent).toBeCloseTo(15.0, 1)
    expect(tokens?.better).toBe('worse')
    expect(rank?.absolute).toBe(1)
    expect(rank?.better).toBe('better')
  })

  it('headline mentions more tokens and higher success rank', async () => {
    const ws = makeTempDir()
    await seedPair(ws)
    const result = await compareOk(ws)
    expect(result.headlineResult).toContain('more tokens')
    expect(result.headlineResult).toContain('higher success rank')
  })
})

describe('cli/compare — errors', () => {
  it('fails with E_RUN_NOT_FOUND when run1 is missing', async () => {
    const ws = makeTempDir()
    await seedRun(ws, {
      runId: 'run-two',
      timestamp: TS2,
      packRef: 'git+pack-x',
      oldPrimary: oldP2,
      newPrimary: newP2,
    })
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({
          runId1: 'missing',
          runId2: 'run-two',
          workspace: ws,
          perspective: 'auto',
          format: 'md',
        }),
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
    await seedRun(ws, {
      runId: 'run-one',
      timestamp: TS1,
      packRef: 'git+pack-x',
      oldPrimary: oldP1,
      newPrimary: newP1,
    })
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({
          runId1: 'run-one',
          runId2: 'nope',
          workspace: ws,
          perspective: 'auto',
          format: 'md',
        }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.code).toBe('E_RUN_NOT_FOUND')
  })

  it('fails with E_REPORT_INVALID when report.json is malformed', async () => {
    const ws = makeTempDir()
    const dir1 = await seedManifest(ws, 'run-one', TS1)
    await runP(writeFile(path.join(dir1, 'results', 'report.json'), '{not-json'))
    await seedRun(ws, {
      runId: 'run-two',
      timestamp: TS2,
      packRef: 'git+pack-x',
      oldPrimary: oldP2,
      newPrimary: newP2,
    })
    const outcome = await Effect.runPromise(
      Effect.either(
        compare({
          runId1: 'run-one',
          runId2: 'run-two',
          workspace: ws,
          perspective: 'auto',
          format: 'md',
        }),
      ),
    )
    expect(outcome._tag).toBe('Left')
    if (outcome._tag === 'Left') expect(outcome.left.code).toBe('E_REPORT_INVALID')
  })
})

describe('cli/compare — perspectives', () => {
  it('old-vs-old compares the baseline sides', async () => {
    const ws = makeTempDir()
    await seedPair(ws)
    const result = await compareOk(ws, { perspective: 'old-vs-old' })
    expect(result.run1.metrics.side).toBe('old')
    expect(result.run2.metrics.side).toBe('old')
    expect(result.run1.metrics.primary.totalTokens).toBe('12000')
    expect(result.run2.metrics.primary.totalTokens).toBe('13000')
    expect(result.diff[0]?.absolute).toBe(1000)
  })

  it('best picks the higher-successRank side of each run', async () => {
    const ws = makeTempDir()
    await seedRun(ws, {
      runId: 'run-one',
      timestamp: TS1,
      packRef: 'git+pack-x',
      oldPrimary: { ...oldP1, successRank: 5 },
      newPrimary: { ...newP1, successRank: 3 },
    })
    await seedRun(ws, {
      runId: 'run-two',
      timestamp: TS2,
      packRef: 'git+pack-x',
      oldPrimary: { ...oldP2, successRank: 2 },
      newPrimary: { ...newP2, successRank: 4 },
    })
    const result = await compareOk(ws, { perspective: 'best' })
    expect(result.perspective).toBe('best')
    expect(result.run1.metrics.side).toBe('old')
    expect(result.run2.metrics.side).toBe('new')
  })

  it('auto → old-vs-old when both runs are smoke-tests', async () => {
    const ws = makeTempDir()
    await seedRun(ws, {
      runId: 'run-one',
      timestamp: TS1,
      oldPrimary: oldP1,
      newPrimary: newP1,
    })
    await seedRun(ws, {
      runId: 'run-two',
      timestamp: TS2,
      oldPrimary: oldP2,
      newPrimary: newP2,
    })
    const result = await compareOk(ws, { perspective: 'auto' })
    expect(result.perspective).toBe('old-vs-old')
    expect(result.run1.metrics.side).toBe('old')
  })

  it('auto → new-vs-new when both runs have a pack', async () => {
    const ws = makeTempDir()
    await seedPair(ws, 'git+pack-x')
    const result = await compareOk(ws, { perspective: 'auto' })
    expect(result.perspective).toBe('new-vs-new')
    expect(result.run1.metrics.side).toBe('new')
  })

  it('delta is computed for every primary metric', async () => {
    const ws = makeTempDir()
    await seedPair(ws)
    const result = await compareOk(ws)
    expect(result.diff.length).toBe(7)
    for (const d of result.diff) {
      expect(d).toBeDefined()
      expect(typeof d.absolute).toBe('number')
    }
  })
})

describe('cli/compare — pure helpers', () => {
  it('resolvePerspective passes through explicit values', () => {
    const m = makeManifest({ packRef: 'p' })
    expect(resolvePerspective(m, m, 'new-vs-new')).toBe('new-vs-new')
    expect(resolvePerspective(m, m, 'old-vs-old')).toBe('old-vs-old')
    expect(resolvePerspective(m, m, 'best')).toBe('best')
  })

  it('resolvePerspective auto: mixed pack/smoke → best', () => {
    const withPack = makeManifest({ packRef: 'p' })
    const { packRef: _drop, ...smoke } = makeManifest({ packRef: 'p' })
    expect(resolvePerspective(withPack, smoke, 'auto')).toBe('best')
  })

  it('selectSide returns the requested side, or higher rank for best', () => {
    const oldAgg = makeSideAggregates('old', { primary: { ...oldP1, successRank: 5 } })
    const newAgg = makeSideAggregates('new', { primary: { ...newP1, successRank: 3 } })
    const report = makeReport({
      metricsDiff: makeMetricsDiff({ old: oldAgg, new: newAgg }),
    })
    expect(selectSide(report, 'new-vs-new').side).toBe('new')
    expect(selectSide(report, 'old-vs-old').side).toBe('old')
    expect(selectSide(report, 'best').side).toBe('old')
  })

  it('buildCompareHeadline signals fewer tokens and lower rank', () => {
    const headline = buildCompareHeadline({
      totalTokens: { absolute: -1000, percent: -10, significant: true, better: 'better' },
      wallClockMs: { absolute: -1000, percent: -5, significant: false, better: 'better' },
      costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      stepCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      successRank: { absolute: -1, percent: -20, significant: true, better: 'worse' },
      maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
    })
    expect(headline).toContain('fewer tokens')
    expect(headline).toContain('lower success rank')
  })

  it('buildCompareHeadline handles an omitted percent (0 -> non-zero change) without "NaN%"', () => {
    const headline = buildCompareHeadline({
      totalTokens: { absolute: 500, significant: true, better: 'worse' },
      wallClockMs: { absolute: -1000, percent: -5, significant: false, better: 'better' },
      costUsd: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      stepCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      toolCallCount: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      successRank: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
      maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
    })
    expect(headline).not.toContain('NaN')
    expect(headline).toContain('more tokens')
  })
})

describe('cli/compare — renderers', () => {
  const makeResult = async (): Promise<Parameters<typeof renderCompareMd>[0]> => {
    const ws = makeTempDir()
    await seedPair(ws)
    return compareOk(ws)
  }

  it('renderCompareMd emits header, summary and the metrics table', async () => {
    const result = await makeResult()
    const md = renderCompareMd(result)
    expect(md).toContain('# testaipack compare')
    expect(md).toContain('**Run 1:** run-one')
    expect(md).toContain('**Run 2:** run-two')
    expect(md).toContain('**Perspective:** new-vs-new')
    expect(md).toContain('## Summary')
    expect(md).toContain(result.headlineResult)
    expect(md).toContain('| Metric | Run 1 | Run 2 | Δ | Δ% | Significant | Verdict |')
    expect(md).toContain('| Total tokens |')
  })

  it('renderCompareMd shows smoke-test label when packRef is absent', async () => {
    const ws = makeTempDir()
    await seedRun(ws, {
      runId: 'run-one',
      timestamp: TS1,
      oldPrimary: oldP1,
      newPrimary: newP1,
    })
    await seedRun(ws, {
      runId: 'run-two',
      timestamp: TS2,
      oldPrimary: oldP2,
      newPrimary: newP2,
    })
    const result = await runP(
      compare({
        runId1: 'run-one',
        runId2: 'run-two',
        workspace: ws,
        perspective: 'old-vs-old',
        format: 'md',
      }),
    )
    expect(renderCompareMd(result)).toContain('_smoke-test (no pack)_')
  })

  it('compareResultToJson returns keyed diff entries', async () => {
    const result = await makeResult()
    const json = compareResultToJson(result)
    expect(json.run1.id).toBe('run-one')
    expect(json.run2.id).toBe('run-two')
    expect(json.perspective).toBe('new-vs-new')
    expect(json.headlineResult).toBe(result.headlineResult)
    expect(json.diff.length).toBe(7)
    const tokens = json.diff.find((e) => e.key === 'totalTokens')
    expect(tokens?.delta.absolute).toBe(1500)
  })
})

describe('cli/compare — CLI registration', () => {
  it('runCli compare prints the md table to stdout and exits 0', async () => {
    const ws = makeTempDir()
    await seedPair(ws)
    const chunks: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    })
    try {
      const code = await runCli(['compare', 'run-one', 'run-two', '--workspace', ws])
      expect(code).toBe(0)
    } finally {
      spy.mockRestore()
    }
    const out = chunks.join('')
    expect(out).toContain('# testaipack compare')
    expect(out).toContain('| Metric | Run 1 | Run 2 |')
    expect(out).toContain('run-one')
    expect(out).toContain('run-two')
  })

  it('runCli compare rejects an invalid --perspective', async () => {
    const ws = makeTempDir()
    await seedPair(ws)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const code = await runCli([
        'compare',
        'run-one',
        'run-two',
        '--workspace',
        ws,
        '--perspective',
        'bogus',
      ])
      expect(code).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})
