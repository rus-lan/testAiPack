/**
 * Phase 11: report-render
 *
 * Assembles the Report object from upstream artifacts and renders it into the
 * requested formats. `report.md` (stdout + file) and `report.json` (file) are
 * always produced; `report.yaml` / `report.html` only when requested via
 * `runInput.formats`. The only failure mode is `E_DISK_FULL` (ENOSPC).
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type {
  Report,
  ReportRenderInput,
  ReportRenderResult,
} from '@generated/types'
import { reportRenderError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, writeFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { renderMd } from '../report/md.js'
import { renderJson } from '../report/json.js'
import { renderYaml } from '../report/yaml.js'
import { renderHtml } from '../report/html.js'

const isEnospc = (e: FsError): boolean => {
  const c = e.cause
  const msg = typeof c === 'string' ? c : c instanceof Error ? c.message : ''
  return /ENOSPC/i.test(msg)
}

const toDiskFull =
  (what: string, p: string) =>
  (e: FsError): PhaseError =>
    reportRenderError(`${what} failed: ${e.operation} on ${e.path}`, 'E_DISK_FULL', {
      path: p,
      reason: isEnospc(e) ? 'enospc' : 'write-failure',
      cause: e,
    })

const writeOptional = (
  wanted: boolean,
  filePath: string,
  render: () => string,
  what: string,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    if (!wanted) return
    yield* writeFile(filePath, render()).pipe(Effect.mapError(toDiskFull(what, filePath)))
  })

export const buildReport = (input: ReportRenderInput): Report => {
  const { manifest, metricsDiff, timeline, diff, judge, summary } = input
  return {
    manifest,
    metricsDiff,
    timeline,
    diff,
    summary,
    ...(judge === undefined ? {} : { judge }),
  }
}

export const reportRender = (
  input: ReportRenderInput,
): Effect.Effect<ReportRenderResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput } = input
    const report = buildReport(input)
    const resultsDir = path.resolve(runInput.outputPath)
    const formats: ReportRenderResult['formats'] = runInput.formats.includes('md')
      ? [...runInput.formats]
      : [...runInput.formats, 'md']

    yield* ensureDir(resultsDir).pipe(Effect.mapError(toDiskFull('ensureDir', resultsDir)))

    const mdPath = path.join(resultsDir, 'report.md')
    yield* writeFile(mdPath, renderMd(report)).pipe(
      Effect.mapError(toDiskFull('write report.md', mdPath)),
    )

    const jsonPath = path.join(resultsDir, 'report.json')
    yield* writeFile(jsonPath, renderJson(report)).pipe(
      Effect.mapError(toDiskFull('write report.json', jsonPath)),
    )

    const yamlWanted = formats.includes('yaml')
    const htmlWanted = formats.includes('html')
    const yamlPath = path.join(resultsDir, 'report.yaml')
    const htmlPath = path.join(resultsDir, 'report.html')

    yield* writeOptional(yamlWanted, yamlPath, () => renderYaml(report), 'write report.yaml')
    yield* writeOptional(htmlWanted, htmlPath, () => renderHtml(report), 'write report.html')

    const stdoutFormat: 'md' | 'json' = formats.includes('md') ? 'md' : 'json'

    const paths: ReportRenderResult['paths'] = {
      md: mdPath,
      json: jsonPath,
      ...(yamlWanted ? { yaml: yamlPath } : {}),
      ...(htmlWanted ? { html: htmlPath } : {}),
    }

    return { formats, paths, stdoutFormat }
  })
