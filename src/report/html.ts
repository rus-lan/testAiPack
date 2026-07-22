/**
 * Report: html — minimal self-contained HTML report.
 *
 * Renders the headline, the primary-metrics table, the judge verdict and an
 * iframe pointing at `timeline.html` (rendered separately by phase 10).
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type { Report } from '@generated/types'
import { fmtPct, fmtSigned, fmtValue, PRIMARY_METRICS, verdictFor } from './format.js'

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export const renderHtml = (report: Report): string => {
  const title = `testaipack report: ${report.manifest.runId}`
  const rows = PRIMARY_METRICS.map((m) => {
    const d = report.metricsDiff.deltas[m.key]
    const oldV = fmtValue(report.metricsDiff.old.primary[m.key], m.kind)
    const newV = fmtValue(report.metricsDiff.new.primary[m.key], m.kind)
    return `<tr><td>${escapeHtml(m.label)}</td><td>${escapeHtml(oldV)}</td><td>${escapeHtml(newV)}</td><td>${escapeHtml(fmtSigned(d.absolute, m.kind))}</td><td>${escapeHtml(fmtPct(d.percent))}</td><td>${escapeHtml(verdictFor(d))}</td></tr>`
  }).join('')

  const judge = report.judge
  const judgeBlock =
    judge === undefined
      ? '<section><h2>LLM Judge</h2><p><em>Judge was not requested.</em></p></section>'
      : `<section><h2>LLM Judge</h2><p>Verdict: <strong>${escapeHtml(judge.verdict)}</strong>${judge.verdict === 'unclear' ? ' <em>(unclear)</em>' : ''}; quality old=${String(judge.oldQuality)} new=${String(judge.newQuality)}; model <code>${escapeHtml(judge.modelUsed)}</code></p><p>${escapeHtml(judge.explanation)}</p></section>`

  const bothFailedNote = report.metricsDiff.bothFailed
    ? '<p><strong>⚠ Both sides failed — comparison unreliable.</strong></p>'
    : ''

  const failures =
    report.metricsDiff.old.failedRuns.length === 0 &&
    report.metricsDiff.new.failedRuns.length === 0
      ? ''
      : `<section><h2>Failed runs</h2><p>old: ${String(report.metricsDiff.old.failedRuns.length)}, new: ${String(report.metricsDiff.new.failedRuns.length)}</p></section>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.3rem .6rem}code{background:#f4f4f4;padding:.1rem .3rem}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p><strong>${escapeHtml(report.summary.headlineResult)}</strong></p>
${bothFailedNote}
<section>
<h2>Primary metrics</h2>
<table>
<thead><tr><th>Metric</th><th>Old (median)</th><th>New (median)</th><th>Δ</th><th>Δ%</th><th>Verdict</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>
${failures}
${judgeBlock}
<section>
<h2>Timeline</h2>
<iframe src="timeline.html" width="100%" height="480">timeline.html unavailable</iframe>
</section>
</body>
</html>
`
}
