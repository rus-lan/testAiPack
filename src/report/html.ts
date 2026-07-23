/**
 * Report: html — minimal self-contained HTML report.
 *
 * Renders the headline, the color-coded primary-metrics table, the
 * improvements/regressions buckets, the judge verdict, failed runs, a diff
 * summary with patch/side.html links, and an iframe pointing at
 * `timeline.html` (rendered separately by phase 10). All CSS is inline — the
 * document has no external dependencies.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type { Report, Side } from '@generated/types'
import { fmtPct, fmtSigned, fmtValue, PRIMARY_METRICS, verdictFor } from './format.js'
import type { PrimaryMeta } from './format.js'

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const VERDICT_CLASS: Readonly<Record<string, string>> = {
  better: 'better',
  worse: 'worse',
  neutral: 'neutral',
  'context-dependent': 'ctx',
}

const renderHeader = (report: Report): string => {
  const pack = report.manifest.packRef ?? '_smoke-test (no pack)_'
  return `<h1>testaipack report: ${escapeHtml(report.manifest.runId)}</h1>
<p class="meta"><strong>Repo:</strong> ${escapeHtml(report.manifest.repoUrl)}<br>
<strong>Pack:</strong> ${escapeHtml(pack)}<br>
<strong>Runs:</strong> ${escapeHtml(String(report.manifest.runs))} per side<br>
<strong>Opencode:</strong> ${escapeHtml(report.manifest.opencodeVersion)}<br>
<strong>Timestamp:</strong> ${escapeHtml(report.manifest.timestamp)}</p>`
}

const renderSummary = (report: Report): string => {
  const deltas = report.metricsDiff.deltas
  const bucket = (heading: string, metas: readonly PrimaryMeta[]): string => {
    const items =
      metas.length === 0
        ? '<li><em>none</em></li>'
        : metas
            .map((m) => {
              const d = deltas[m.key]
              return `<li><strong>${escapeHtml(m.label)}</strong>: ${escapeHtml(fmtSigned(d.absolute, m.kind))} (${escapeHtml(fmtPct(d.percent))}) — ${escapeHtml(verdictFor(d))}</li>`
            })
            .join('')
    return `<section><h2>${escapeHtml(heading)}</h2><ul>${items}</ul></section>`
  }
  const improvements = PRIMARY_METRICS.filter((m) => deltas[m.key].better === 'better')
  const regressions = PRIMARY_METRICS.filter((m) => deltas[m.key].better === 'worse')
  const neutral = PRIMARY_METRICS.filter(
    (m) => deltas[m.key].better === 'neutral' || deltas[m.key].better === 'context-dependent',
  )
  return `<section id="summary">
<h2>Summary</h2>
<p class="headline">${escapeHtml(report.summary.headlineResult)}</p>
<div class="buckets">
${bucket('Improvements', improvements)}
${bucket('Regressions', regressions)}
${bucket('Neutral', neutral)}
</div>
</section>`
}

const renderPrimary = (report: Report): string => {
  const rows = PRIMARY_METRICS.map((m) => {
    const d = report.metricsDiff.deltas[m.key]
    const oldV = fmtValue(report.metricsDiff.old.primary[m.key], m.kind)
    const newV = fmtValue(report.metricsDiff.new.primary[m.key], m.kind)
    const cls = VERDICT_CLASS[d.better] ?? 'neutral'
    return `<tr><td>${escapeHtml(m.label)}</td><td>${escapeHtml(oldV)}</td><td>${escapeHtml(newV)}</td><td>${escapeHtml(fmtSigned(d.absolute, m.kind))}</td><td>${escapeHtml(fmtPct(d.percent))}</td><td class="${cls}">${escapeHtml(verdictFor(d))}</td></tr>`
  }).join('')
  return `<section>
<h2>Primary metrics</h2>
<table>
<thead><tr><th>Metric</th><th>Old (median)</th><th>New (median)</th><th>Δ</th><th>Δ%</th><th>Verdict</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>`
}

const renderJudge = (report: Report): string => {
  const judge = report.judge
  if (judge === undefined) {
    return '<section><h2>LLM Judge</h2><p><em>Judge was not requested.</em></p></section>'
  }
  const note = judge.verdict === 'unclear' ? ' <em>(unclear)</em>' : ''
  return `<section><h2>LLM Judge</h2><p>Verdict: <strong>${escapeHtml(judge.verdict)}</strong>${note}; quality old=${escapeHtml(String(judge.oldQuality))} new=${escapeHtml(String(judge.newQuality))}; model <code>${escapeHtml(judge.modelUsed)}</code></p><p>${escapeHtml(judge.explanation)}</p></section>`
}

const renderFailures = (report: Report): string => {
  const oldF = report.metricsDiff.old.failedRuns
  const newF = report.metricsDiff.new.failedRuns
  if (oldF.length === 0 && newF.length === 0) return ''
  const rows = [
    ...oldF.map(
      (f) =>
        `<tr><td>old</td><td>${escapeHtml(String(f.runIndex))}</td><td><code>${escapeHtml(f.errorCode)}</code></td><td>${escapeHtml(f.errorMessage)}</td></tr>`,
    ),
    ...newF.map(
      (f) =>
        `<tr><td>new</td><td>${escapeHtml(String(f.runIndex))}</td><td><code>${escapeHtml(f.errorCode)}</code></td><td>${escapeHtml(f.errorMessage)}</td></tr>`,
    ),
  ].join('')
  return `<section><h2>Failed runs</h2><table><thead><tr><th>Side</th><th>Run</th><th>Code</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

const renderDiff = (report: Report): string => {
  const renderSide = (side: Side): string => {
    const runs = report.diff[side].runs
    const items = runs
      .map((r) => {
        const idx = String(r.runIndex)
        const patchHref = `diff/${side}/run-${idx}/full.patch`
        const htmlHref = r.htmlPath ?? `diff/${side}/run-${idx}/side.html`
        const htmlLink = r.noChanges
          ? ''
          : ` — <a href="${escapeHtml(htmlHref)}">html</a>`
        return `<li>run-${escapeHtml(idx)}: +${escapeHtml(String(r.summary.additions))} -${escapeHtml(String(r.summary.deletions))} (${escapeHtml(String(r.summary.filesChanged))} files) — <a href="${escapeHtml(patchHref)}">patch</a>${htmlLink}</li>`
      })
      .join('')
    return `<li><strong>${escapeHtml(side)}</strong>: ${escapeHtml(String(runs.length))} run(s)<ul>${items}</ul></li>`
  }
  return `<section><h2>Diff summary</h2><ul>${renderSide('old')}${renderSide('new')}</ul></section>`
}

export const renderHtml = (report: Report): string => {
  const title = `testaipack report: ${report.manifest.runId}`
  const bothFailedNote = report.metricsDiff.bothFailed
    ? '<p class="warn"><strong>⚠ Both sides failed — comparison unreliable.</strong></p>'
    : ''

  const body = [
    renderHeader(report),
    bothFailedNote,
    renderSummary(report),
    renderPrimary(report),
    renderJudge(report),
    renderFailures(report),
    renderDiff(report),
    '<section><h2>Timeline</h2><iframe src="timeline.html" width="100%" height="480">timeline.html unavailable</iframe></section>',
  ]
    .filter((s) => s !== '')
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light;
    --better-bg: #e6f4ea; --better-fg: #1e7e34;
    --worse-bg: #fdecea; --worse-fg: #c0392b;
    --neutral-bg: #f1f3f5; --neutral-fg: #6c757d;
    --ctx-bg: #fff8e1; --ctx-fg: #b8860b;
  }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 56rem; color: #222; line-height: 1.5; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  h2 { font-size: 1.2rem; margin-top: 1.75rem; border-bottom: 1px solid #e0e0e0; padding-bottom: .25rem; }
  .meta { color: #555; font-size: .9rem; }
  .headline { font-size: 1.1rem; font-weight: 600; }
  .warn { background: var(--worse-bg); color: var(--worse-fg); padding: .5rem .75rem; border-radius: .25rem; }
  .buckets { display: flex; flex-wrap: wrap; gap: 1rem; }
  .buckets section { flex: 1 1 14rem; }
  .buckets h2 { font-size: 1rem; border: 0; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
  td, th { border: 1px solid #ddd; padding: .35rem .6rem; text-align: left; }
  th { background: #f8f9fa; }
  code { background: #f4f4f4; padding: .1rem .3rem; border-radius: .2rem; }
  a { color: #2563eb; }
  ul { padding-left: 1.25rem; }
  .better { background: var(--better-bg); color: var(--better-fg); font-weight: 600; }
  .worse { background: var(--worse-bg); color: var(--worse-fg); font-weight: 600; }
  .neutral { background: var(--neutral-bg); color: var(--neutral-fg); }
  .ctx { background: var(--ctx-bg); color: var(--ctx-fg); }
  iframe { border: 1px solid #ddd; border-radius: .25rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`
}
