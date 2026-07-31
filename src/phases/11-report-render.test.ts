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
import { makeReportV2, threeVariants } from '../../tests/helpers/variants.js'
import type { Report, ReportRenderInput, ReportSummary, RunInput } from '@generated/types'

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

const baseReport = (): Report => makeReportV2()

/** Report without `judge` — built by omitting the key, not setting it to `undefined` (exactOptionalPropertyTypes). */
const withoutJudge = (report: Report): Report => {
  const { judge: _judge, ...rest } = report
  return rest
}

const runInputFor = (over: Partial<RunInput> = {}): RunInput => ({
  ...threeVariants().runInput,
  outputPath: './results',
  ...over,
})

/** `ReportRenderInput` mirrors `Report` minus `schemaVersion` — built from the same fixture so md/json/yaml all see consistent data. */
const inputFrom = (report: Report, runInputOver: Partial<RunInput> = {}): ReportRenderInput => ({
  runInput: runInputFor(runInputOver),
  manifest: report.manifest,
  metrics: report.metrics,
  timeline: report.timeline,
  diffs: report.diffs,
  summary: report.summary,
  ...(report.judge === undefined ? {} : { judge: report.judge }),
  ...(report.prep === undefined ? {} : { prep: report.prep }),
})

describe('reportRender — format selection', () => {
  it('formats=["md"] writes report.md + report.json (canonical), no yaml/html', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['md'], outputPath: out })
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
    const input = inputFrom(baseReport(), { formats: ['md', 'json'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(existsSync(`${out}/report.json`)).toBe(true)
    expect(result.formats).toEqual(['md', 'json'])
  })

  it('formats=["md","html","json","yaml"] writes all four files', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['md', 'html', 'json', 'yaml'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(existsSync(`${out}/report.json`)).toBe(true)
    expect(existsSync(`${out}/report.yaml`)).toBe(true)
    expect(existsSync(`${out}/report.html`)).toBe(true)
    expect(result.paths.yaml).toBe(`${out}/report.yaml`)
    expect(result.paths.html).toBe(`${out}/report.html`)
    expect(result.formats).toEqual(['md', 'html', 'json', 'yaml'])
  })

  it('md is always written even when not requested, but stdout follows the user\'s actual request', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['json'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(existsSync(`${out}/report.md`)).toBe(true)
    expect(result.formats).toContain('md')
    expect(result.stdoutFormat).toBe('json')
    expect(result.stdoutMd).toBeUndefined()
  })
})

describe('reportRender — stdout Markdown', () => {
  it('result carries stdoutMd when md is in requested formats', async () => {
    const out = makeTempDir()
    const report = baseReport()
    const input = inputFrom(report, { formats: ['md'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(result.stdoutMd).toBeDefined()
    expect(typeof result.stdoutMd).toBe('string')
    expect(result.stdoutMd).toContain(`# Отчёт testaipack: ${report.manifest.runId}`)
    const onDisk = await runP(readFile(`${out}/report.md`))
    expect(result.stdoutMd).toBe(onDisk)
  })

  it('result omits stdoutMd when only json is requested', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['json'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(result.stdoutMd).toBeUndefined()
    expect(existsSync(`${out}/report.md`)).toBe(true)
  })

  it('stdoutMd is present when formats include md alongside others', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['md', 'yaml'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(result.stdoutMd).toBeDefined()
  })
})

describe('reportRender — stdout JSON', () => {
  it('result carries stdoutJson (matching report.json on disk) when only json is requested', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['json'], outputPath: out })
    const result = await runP(reportRender(input))
    expect(result.stdoutJson).toBeDefined()
    expect(result.stdoutMd).toBeUndefined()
    const onDisk = await runP(readFile(`${out}/report.json`))
    expect(result.stdoutJson).toBe(onDisk)
  })

  it('result omits stdoutJson when md is requested (alone or alongside json)', async () => {
    const out1 = makeTempDir()
    const mdOnly = await runP(reportRender(inputFrom(baseReport(), { formats: ['md'], outputPath: out1 })))
    expect(mdOnly.stdoutJson).toBeUndefined()

    const out2 = makeTempDir()
    const mdAndJson = await runP(reportRender(inputFrom(baseReport(), { formats: ['md', 'json'], outputPath: out2 })))
    expect(mdAndJson.stdoutJson).toBeUndefined()
    expect(mdAndJson.stdoutMd).toBeDefined()
  })
})

describe('reportRender — markdown content (3-variant N-way report)', () => {
  it('written report.md contains all mandatory sections', async () => {
    const out = makeTempDir()
    await runP(ensureDir(out))
    const input = inputFrom(baseReport(), { formats: ['md'], outputPath: out })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('## Сводка')
    expect(md).toContain('## Основные метрики — итого (init + task)')
    expect(md).toContain('## Дополнительные метрики')
    expect(md).toContain('## LLM-судья')
    expect(md).toContain('## Сводка по таймлайну')
    expect(md).toContain('## Сводка по diff')
  })

  it('primary metrics table shows the metric-major header and baseline row', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['md'], outputPath: out })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('| Метрика | Вариант | Медиана | [мин–макс] | Δ vs база | Δ% | Значимо | Вердикт |')
    expect(md).toContain('| Всего токенов | base* |')
  })

  it('headline result appears near the top of Summary', async () => {
    const out = makeTempDir()
    const report = baseReport()
    const input = inputFrom(report, { formats: ['md'], outputPath: out })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    const summaryIdx = md.indexOf('## Summary')
    const headlineIdx = md.indexOf(report.summary.headlineResult)
    expect(headlineIdx).toBeGreaterThan(summaryIdx)
  })

  it('failed runs section appears when the summary carries failures', async () => {
    const out = makeTempDir()
    const report = baseReport()
    const withFailure: Report = {
      ...report,
      summary: {
        ...report.summary,
        failures: [{ variant: 'graphify', runIndex: 1, errorCode: 'E_RUN_CRASH', errorMessage: 'boom', timestamp: '2025-01-01T00:02:00.000Z' }],
      },
    }
    await runP(reportRender(inputFrom(withFailure, { formats: ['md'], outputPath: out })))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('## Проваленные запуски')
    expect(md).toContain('E_RUN_CRASH')
  })

  it('failed runs section is skipped when there are none', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['md'], outputPath: out })
    await runP(reportRender(input))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).not.toContain('## Проваленные запуски')
  })

  it('judge section shows "not requested" when judge omitted', async () => {
    const out = makeTempDir()
    const report = withoutJudge(baseReport())
    await runP(reportRender(inputFrom(report, { formats: ['md'], outputPath: out })))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('_Судья не запрошен (--judge не задан)_')
  })

  it('allFailed emits the comparison-unreliable warning', async () => {
    const out = makeTempDir()
    const report = baseReport()
    const failed: Report = { ...report, metrics: { ...report.metrics, allFailed: true } }
    await runP(reportRender(inputFrom(failed, { formats: ['md'], outputPath: out })))
    const md = await runP(readFile(`${out}/report.md`))
    expect(md).toContain('Все варианты провалились — сравнение ненадёжно')
  })
})

describe('reportRender — json canonical', () => {
  it('report.json validates against reportSchema and contains metrics + runId', async () => {
    const out = makeTempDir()
    const report = baseReport()
    await runP(reportRender(inputFrom(report, { formats: ['md'], outputPath: out })))
    const raw = await runP(readFile(`${out}/report.json`))
    const parsed = JSON.parse(raw) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
    expect((parsed as { manifest: { runId: string } }).manifest.runId).toBe(report.manifest.runId)
    expect((parsed as { metrics: unknown }).metrics).toBeDefined()
    expect((parsed as { schemaVersion: number }).schemaVersion).toBe(2)
  })
})

describe('reportRender — yaml round-trip', () => {
  it('report.yaml parses back into a schema-valid report', async () => {
    const out = makeTempDir()
    const input = inputFrom(baseReport(), { formats: ['md', 'yaml'], outputPath: out })
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
      Effect.fail(new FsError({ path: 'report.md', operation: 'writeFile', cause: new Error('ENOSPC: no space left on device') })),
    )
    const input = inputFrom(baseReport(), { formats: ['md'], outputPath: out })
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
    const input = inputFrom(baseReport(), { formats: ['md'], outputPath: out })
    const err = await runFlip(reportRender(input))
    expect(err.code).toBe('E_DISK_FULL')
    expect(err.context?.['reason']).toBe('write-failure')
  })
})

describe('reportRender — invalid report schema', () => {
  it('a Report that fails its own schema fails the phase with E_EXPORT_INVALID, not an uncaught defect', async () => {
    const out = makeTempDir()
    const report = baseReport()
    const badSummary = { ...report.summary, headlineResult: 123 } as unknown as ReportSummary
    const input = inputFrom({ ...report, summary: badSummary }, { formats: ['md'], outputPath: out })
    const err = await runFlip(reportRender(input))
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.phase).toBe('report-render')
  })
})

describe('renderJson — pure round-trip', () => {
  it('renderJson output parses back into the same report', async () => {
    const report = baseReport()
    const text = await runP(renderJson(report))
    const parsed = JSON.parse(text) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
    expect((parsed as { manifest: { runId: string } }).manifest.runId).toBe(report.manifest.runId)
  })

  it('buildReport omits judge/prep when undefined and includes them when present', () => {
    const report = baseReport()
    const withJudge = inputFrom(report)
    const r1 = buildReport(withJudge)
    expect(r1.judge).toBeDefined()
    expect(r1.schemaVersion).toBe(2)

    const withoutJudgeInput = inputFrom(withoutJudge(report))
    const r2 = buildReport(withoutJudgeInput)
    expect(r2.judge).toBeUndefined()
    expect(r2.prep).toBeUndefined()
  })
})
