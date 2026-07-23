import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import { existsSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { reportSchema } from '@generated/schemas'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile } from '../util/fs.js'
import { FsError } from '../util/fs.js'
import { PhaseError } from '../errors.js'
import { reportRender, buildReport } from './11-report-render.js'
import { renderJson } from '../report/json.js'
import {
  makeReportRenderInput,
  makeRunInput,
  makeReport,
} from '../../tests/report-fixture.js'

vi.mock('../util/fs.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

const writeFileMock = vi.mocked(writeFile)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../util/fs.js')>('../util/fs.js')
  writeFileMock.mockImplementation(actual.writeFile)
})

describe('reportRender — format selection', () => {
  it('formats=["md"] writes report.md + report.json (canonical), no yaml/html', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({ runInput: makeRunInput({ formats: ['md'], outputPath: out }) })
    const result = await runP(reportRender(input))

    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(existsSync(`${out}/report.json`)).toBe(true)
    expect(existsSync(`${out}/report.yaml`)).toBe(false)
    expect(existsSync(`${out}/report.html`)).toBe(false)
    expect(result.paths.md).toBe(`${out}/report.md`)
    expect(result.paths.json).toBe(`${out}/report.json`)
    expect(result.paths.yaml).toBeUndefined()
    expect(result.paths.html).toBeUndefined()
    expect(result.formats).toEqual(['md'])
    expect(result.stdoutFormat).toBe('md')
  })

  it('formats=["md","json"] writes md and json files', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md', 'json'], outputPath: out }),
    })
    const result = await runP(reportRender(input))
    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(existsSync(`${out}/report.json`)).toBe(true)
    expect(result.formats).toEqual(['md', 'json'])
  })

  it('formats=["md","html","json","yaml"] writes all four files', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md', 'html', 'json', 'yaml'], outputPath: out }),
    })
    const result = await runP(reportRender(input))
    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(existsSync(`${out}/report.json`)).toBe(true)
    expect(existsSync(`${out}/report.yaml`)).toBe(true)
    expect(existsSync(`${out}/report.html`)).toBe(true)
    expect(result.paths.yaml).toBe(`${out}/report.yaml`)
    expect(result.paths.html).toBe(`${out}/report.html`)
    expect(result.formats).toEqual(['md', 'html', 'json', 'yaml'])
  })

  it('md is always written even when not requested', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['json'], outputPath: out }),
    })
    const result = await runP(reportRender(input))
    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(result.formats).toContain('md')
  })
})

describe('reportRender — stdout Markdown', () => {
  it('result carries stdoutMd when md is in requested formats', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    const result = await runP(reportRender(input))
    expect(result.stdoutMd).toBeDefined()
    expect(typeof result.stdoutMd).toBe('string')
    expect(result.stdoutMd).toContain('# testaipack report: run-abc-001')
    // stdoutMd matches the file written to disk
    const onDisk = await runP(readFile(`${out}/report.md`))
    expect(result.stdoutMd).toBe(onDisk)
  })

  it('result omits stdoutMd when only json is requested', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['json'], outputPath: out }),
    })
    const result = await runP(reportRender(input))
    expect(result.stdoutMd).toBeUndefined()
    // report.md is still written to disk (always), just not surfaced to stdout
    expect(existsSync(`${out}/report.md`)).toBe(true)
  })

  it('stdoutMd is present when formats include md alongside others', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md', 'yaml'], outputPath: out }),
    })
    const result = await runP(reportRender(input))
    expect(result.stdoutMd).toBeDefined()
  })
})

describe('reportRender — markdown content', () => {
  it('written report.md contains all mandatory sections', async () => {
    const out = makeTempDir()
    await runP(ensureDir(out))
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('# testaipack report: run-abc-001')
    expect(md).toContain('## Summary')
    expect(md).toContain('## Primary metrics (delta)')
    expect(md).toContain('## Secondary metrics')
    expect(md).toContain('## LLM Judge')
    expect(md).toContain('## Timeline summary')
    expect(md).toContain('## Diff summary')
  })

  it('primary metrics table is correctly formatted in the written file', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('| Total tokens | 12345 | 10987 | -1358 | -11.0% | ✓ significant | ✓ better |')
  })

  it('headline result appears near the top of Summary', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    const summaryIdx = md.indexOf('## Summary')
    const headlineIdx = md.indexOf('Pack improved token efficiency')
    expect(headlineIdx).toBeGreaterThan(summaryIdx)
  })

  it('failed runs section appears when failures exist', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
      metricsDiff: {
        old: {
          side: 'old',
          primary: {
            totalTokens: '12345',
            wallClockMs: '45000',
            costUsd: 0.045,
            stepCount: 12,
            toolCallCount: 25,
            successRank: 4,
            maxParallelism: 1,
          },
          secondary: {
            inputTokens: '6000',
            outputTokens: '4000',
            reasoningTokens: '1500',
            cacheReadTokens: '845',
            perTool: {},
            reasoningTimeMs: '6000',
            stepLatencyP50Ms: '2000',
            stepLatencyP95Ms: '5000',
            toolLatencyAvgMs: '200',
            finishCauseDistribution: {},
            fileDiffStats: { additions: 0, deletions: 0, filesChanged: 0 },
            maxConsecutiveSameTool: 0,
          },
          stats: {
            totalTokens: { median: 12345, min: 12345, max: 12345, samples: [12345] },
            wallClockMs: { median: 45000, min: 45000, max: 45000, samples: [45000] },
            costUsd: { median: 0.045, min: 0.045, max: 0.045, samples: [0.045] },
            stepCount: { median: 12, min: 12, max: 12, samples: [12] },
            toolCallCount: { median: 25, min: 25, max: 25, samples: [25] },
            successRank: { median: 4, min: 4, max: 4, samples: [4] },
          },
          failedRuns: [
            {
              runIndex: 1,
              errorCode: 'E_RUN_CRASH',
              errorMessage: 'boom',
              timestamp: '2025-01-01T00:02:00.000Z',
            },
          ],
          rawRunIds: ['s-old-1'],
        },
        new: {
          side: 'new',
          primary: {
            totalTokens: '10987',
            wallClockMs: '52000',
            costUsd: 0.041,
            stepCount: 14,
            toolCallCount: 30,
            successRank: 4,
            maxParallelism: 1,
          },
          secondary: {
            inputTokens: '6000',
            outputTokens: '4000',
            reasoningTokens: '1500',
            cacheReadTokens: '845',
            perTool: {},
            reasoningTimeMs: '6000',
            stepLatencyP50Ms: '2000',
            stepLatencyP95Ms: '5000',
            toolLatencyAvgMs: '200',
            finishCauseDistribution: {},
            fileDiffStats: { additions: 0, deletions: 0, filesChanged: 0 },
            maxConsecutiveSameTool: 0,
          },
          stats: {
            totalTokens: { median: 10987, min: 10987, max: 10987, samples: [10987] },
            wallClockMs: { median: 52000, min: 52000, max: 52000, samples: [52000] },
            costUsd: { median: 0.041, min: 0.041, max: 0.041, samples: [0.041] },
            stepCount: { median: 14, min: 14, max: 14, samples: [14] },
            toolCallCount: { median: 30, min: 30, max: 30, samples: [30] },
            successRank: { median: 4, min: 4, max: 4, samples: [4] },
          },
          failedRuns: [],
          rawRunIds: ['s-new-1'],
        },
        deltas: {
          totalTokens: { absolute: -1358, percent: -11.0, significant: true, better: 'better' },
          wallClockMs: { absolute: 7000, percent: 15.6, significant: false, better: 'worse' },
          costUsd: { absolute: -0.004, percent: -8.9, significant: false, better: 'better' },
          stepCount: { absolute: 2, percent: 16.7, significant: false, better: 'worse' },
          toolCallCount: { absolute: 5, percent: 20.0, significant: true, better: 'worse' },
          successRank: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
          maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
        },
        bothFailed: false,
      },
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('## Failed runs')
    expect(md).toContain('E_RUN_CRASH')
  })

  it('failed runs section is skipped when there are none', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).not.toContain('## Failed runs')
  })

  it('judge section shows "not requested" when judge omitted', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
      judge: null,
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('_Judge was not requested (--judge not set)_')
  })

  it('bothFailed emits the comparison-unreliable warning', async () => {
    const out = makeTempDir()
    const report = makeReport()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
      metricsDiff: { ...report.metricsDiff, bothFailed: true },
    })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('Both sides failed — comparison unreliable')
  })
})

describe('reportRender — json canonical', () => {
  it('report.json validates against reportSchema and contains metricsDiff + runId', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    await runP(reportRender(input))
    const raw = await runP(readFile(`${out}/report.json`))
    const parsed = JSON.parse(raw) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
    expect((parsed as { manifest: { runId: string } }).manifest.runId).toBe('run-abc-001')
    expect((parsed as { metricsDiff: unknown }).metricsDiff).toBeDefined()
  })
})

describe('reportRender — yaml round-trip', () => {
  it('report.yaml parses back into a schema-valid report', async () => {
    const out = makeTempDir()
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md', 'yaml'], outputPath: out }),
    })
    await runP(reportRender(input))
    const raw = await runP(readFile(`${out}/report.yaml`))
    const parsed = parseYaml(raw) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
  })
})

describe('reportRender — disk full', () => {
  it('ENOSPC on write → E_DISK_FULL', async () => {
    const out = makeTempDir()
    writeFileMock.mockImplementation(() =>
      Effect.fail(
        new FsError({
          path: 'report.md',
          operation: 'writeFile',
          cause: new Error('ENOSPC: no space left on device'),
        }),
      ),
    )
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    const err = await runFlip(reportRender(input))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('enospc')
  })

  it('generic write failure still maps to E_DISK_FULL (only error code in contract)', async () => {
    const out = makeTempDir()
    writeFileMock.mockImplementation(() =>
      Effect.fail(new FsError({ path: 'report.md', operation: 'writeFile', cause: new Error('EACCES') })),
    )
    const input = makeReportRenderInput({
      runInput: makeRunInput({ formats: ['md'], outputPath: out }),
    })
    const err = await runFlip(reportRender(input))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('write-failure')
  })
})

describe('renderJson — pure round-trip', () => {
  it('renderJson output parses back into the same report', () => {
    const report = makeReport()
    const text = renderJson(report)
    const parsed = JSON.parse(text) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
    expect((parsed as { manifest: { runId: string } }).manifest.runId).toBe(report.manifest.runId)
  })

  it('buildReport omits judge when undefined and includes it when present', () => {
    const withJudge = makeReportRenderInput()
    const r1 = buildReport(withJudge)
    expect(r1.judge).toBeDefined()
    const withoutJudge = makeReportRenderInput({ judge: null })
    const r2 = buildReport(withoutJudge)
    expect(r2.judge).toBeUndefined()
  })
})
