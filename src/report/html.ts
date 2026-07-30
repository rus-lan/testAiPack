/**
 * Report: html — minimal self-contained HTML report.
 *
 * Renders the headline, the color-coded primary-metrics table, the
 * improvements/regressions buckets, the pack signal and safety sections, the
 * judge verdict, failed runs, secondary metrics as collapsible groups, a diff
 * summary with patch/side.html links, and an iframe pointing at
 * `timeline.html` (rendered separately by phase 10). All CSS is inline — the
 * document has no external dependencies.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type { AggregateStats, PackUse, Report, RiskyCommand, SecondaryMetrics, Side, ToolStat } from '@generated/types'
import { fmtDurationMs, fmtInt, fmtPct, fmtSigned, fmtValue, PRIMARY_METRICS, sigLabel, toNum, verdictFor } from './format.js'
import type { PrimaryMeta } from './format.js'
import { STALL_THRESHOLD_MS } from '../metrics/aggregate.js'

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const VERDICT_CLASS: Readonly<Record<string, string>> = {
  better: 'better',
  worse: 'worse',
  neutral: 'neutral',
  'context-dependent': 'ctx',
}

// ---------------------------------------------------------------------------
// Header (P13)
// ---------------------------------------------------------------------------

const versionDriftWarning = (report: Report): string | undefined => {
  const versions = [
    ...(report.metricsDiff.old.opencodeVersions ?? []),
    ...(report.metricsDiff.new.opencodeVersions ?? []),
  ]
  if (versions.length === 0) return undefined
  const manifestVersion = report.manifest.opencodeVersion
  if (!versions.some((v) => v !== manifestVersion)) return undefined
  const distinct = [...new Set(versions)].sort()
  return `opencode version differs from manifest: manifest says ${manifestVersion}, runs used ${distinct.join(', ')} (manifest may record the HOST binary — see root cause below)`
}

const renderHeader = (report: Report): string => {
  const pack = report.manifest.packRef ?? '_smoke-test (no pack)_'
  const warn = versionDriftWarning(report)
  const warnHtml = warn === undefined ? '' : `<p class="warn">⚠ ${escapeHtml(warn)}</p>`
  return `<h1>testaipack report: ${escapeHtml(report.manifest.runId)}</h1>
<p class="meta"><strong>Repo:</strong> ${escapeHtml(report.manifest.repoUrl)}<br>
<strong>Pack:</strong> ${escapeHtml(pack)}<br>
<strong>Runs:</strong> ${escapeHtml(String(report.manifest.runs))} per side<br>
<strong>Opencode:</strong> ${escapeHtml(report.manifest.opencodeVersion)}<br>
<strong>Timestamp:</strong> ${escapeHtml(report.manifest.timestamp)}</p>
${warnHtml}`
}

// ---------------------------------------------------------------------------
// Summary (P1 pack-noop alert, P2 risky-command alert)
// ---------------------------------------------------------------------------

const packNoopWarning = (report: Report): string | undefined => {
  const pu = report.metricsDiff.new.packUse
  if (pu === undefined || !pu.canDetect || pu.calls !== 0) return undefined
  return 'Pack was never invoked on the NEW side — deltas compare baseline vs baseline.'
}

const riskyCommandAlert = (report: Report): string | undefined => {
  const n = (report.metricsDiff.old.riskyCommands?.length ?? 0) + (report.metricsDiff.new.riskyCommands?.length ?? 0)
  return n === 0 ? undefined : `${String(n)} risky command(s) detected — see Safety`
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
  const alerts = [packNoopWarning(report), riskyCommandAlert(report)].filter((s): s is string => s !== undefined)
  const alertsHtml = alerts.map((a) => `<p class="warn">⚠ ${escapeHtml(a)}</p>`).join('')
  return `<section id="summary">
<h2>Summary</h2>
${alertsHtml}
<p class="headline">${escapeHtml(report.summary.headlineResult)}</p>
<div class="buckets">
${bucket('Improvements', improvements)}
${bucket('Regressions', regressions)}
${bucket('Neutral', neutral)}
</div>
</section>`
}

// ---------------------------------------------------------------------------
// Primary metrics (P3: spread columns + Stability block)
// ---------------------------------------------------------------------------

const hasStats = (key: PrimaryMeta['key']): key is keyof AggregateStats => key !== 'maxParallelism'

const spreadCell = (report: Report, side: Side, m: PrimaryMeta): string => {
  if (!hasStats(m.key)) return '—'
  const stat = report.metricsDiff[side].stats[m.key]
  const range = `${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}`
  return stat.iqr === undefined ? range : `${range} (IQR=${fmtValue(stat.iqr, m.kind)})`
}

const renderPrimary = (report: Report): string => {
  const rows = PRIMARY_METRICS.map((m) => {
    const d = report.metricsDiff.deltas[m.key]
    const oldV = fmtValue(report.metricsDiff.old.primary[m.key], m.kind)
    const newV = fmtValue(report.metricsDiff.new.primary[m.key], m.kind)
    const cls = VERDICT_CLASS[d.better] ?? 'neutral'
    return `<tr><td>${escapeHtml(m.label)}</td><td>${escapeHtml(oldV)}</td><td>${escapeHtml(spreadCell(report, 'old', m))}</td><td>${escapeHtml(newV)}</td><td>${escapeHtml(spreadCell(report, 'new', m))}</td><td>${escapeHtml(fmtSigned(d.absolute, m.kind))}</td><td>${escapeHtml(fmtPct(d.percent))}</td><td>${escapeHtml(sigLabel(d))}</td><td class="${cls}">${escapeHtml(verdictFor(d))}</td></tr>`
  }).join('')
  return `<section>
<h2>Primary metrics</h2>
<table>
<thead><tr><th>Metric</th><th>Old (median)</th><th>Old [min–max]</th><th>New (median)</th><th>New [min–max]</th><th>Δ</th><th>Δ%</th><th>Significant</th><th>Verdict</th></tr></thead>
<tbody>${rows}</tbody>
</table>
${renderStability(report)}
</section>`
}

const rankHistogram = (samples: readonly number[]): string => {
  const counts = samples.reduce<Readonly<Record<number, number>>>(
    (m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }),
    {},
  )
  return Object.entries(counts)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([rank, n]) => `rank ${rank} ×${String(n)}`)
    .join(', ')
}

/**
 * Multiplier next to each unstable metric so "unstable" carries a magnitude,
 * not just a flag — max/min, since that is the two numbers already printed in
 * the [min–max] column right above this line. Omitted when min is 0 (ratio
 * undefined, not "infinite").
 */
const unstableLabels = (report: Report, side: Side): readonly string[] =>
  PRIMARY_METRICS.filter((m) => hasStats(m.key)).flatMap((m) => {
    if (!hasStats(m.key)) return []
    const stat = report.metricsDiff[side].stats[m.key]
    if (stat.iqr === undefined || stat.iqr <= stat.median) return []
    const ratio = stat.min > 0 ? ` (${(stat.max / stat.min).toFixed(1)}×)` : ''
    return [`${m.label}${ratio}`]
  })

const verifyPart = (v: { readonly passed: number; readonly failed: number; readonly timedOut: number; readonly runCount: number } | undefined): string => {
  if (v === undefined) return ''
  const detail = v.failed === 0 && v.timedOut === 0 ? '' : ` (${String(v.failed)} failed, ${String(v.timedOut)} timed out)`
  return `; verify: ${String(v.passed)}/${String(v.runCount)} passed${detail}`
}

const stabilityLine = (report: Report, side: Side): string => {
  const samples = report.metricsDiff[side].stats.successRank.samples
  // `report.manifest.runs` is every attempted run — samples only covers runs
  // that produced metrics, so a crashed run must still count against the
  // denominator or a side that crashed every attempt reads as "0/0 (0%)"
  // instead of a visibly failed 0/N.
  const totalRuns = report.manifest.runs
  const okCount = samples.filter((r) => r >= 3).length
  const rate = totalRuns === 0 ? '0%' : `${String(Math.round((100 * okCount) / totalRuns))}%`
  const unstable = unstableLabels(report, side)
  const unstablePart = unstable.length === 0 ? '' : `; unstable: ${unstable.join(', ')}`
  return `<li><strong>${escapeHtml(side.toUpperCase())}</strong>: success rate ${String(okCount)}/${String(totalRuns)} (${rate}); ${escapeHtml(rankHistogram(samples))}${escapeHtml(unstablePart)}${escapeHtml(verifyPart(report.metricsDiff[side].verifyStats))}</li>`
}

const renderStability = (report: Report): string =>
  `<div class="stability"><h3>Stability</h3><ul>${stabilityLine(report, 'old')}${stabilityLine(report, 'new')}</ul></div>`

// ---------------------------------------------------------------------------
// Pack signal (P1, new section)
// ---------------------------------------------------------------------------

const packSignalLine = (side: Side, pu: PackUse | undefined): string => {
  if (pu === undefined) return `<li><strong>${escapeHtml(side)}</strong>: <em>no data</em></li>`
  if (!pu.canDetect) return `<li><strong>${escapeHtml(side)}</strong>: <em>pack use is not visible for this pack type</em></li>`
  const first = pu.firstCallMsMedian === undefined ? '' : `, first-call median ${escapeHtml(fmtInt(pu.firstCallMsMedian))}ms`
  return `<li><strong>${escapeHtml(side)}</strong>: ${String(pu.calls)} call(s), ${String(pu.errors)} error(s), ${String(pu.runsWithCall)}/${String(pu.runCount)} runs called the pack${first}</li>`
}

const renderPackSignal = (report: Report): string => {
  const old = report.metricsDiff.old.packUse
  const nw = report.metricsDiff.new.packUse
  if (old === undefined && nw === undefined) return ''
  return `<section><h2>Pack signal</h2><ul>${packSignalLine('old', old)}${packSignalLine('new', nw)}</ul></section>`
}

// ---------------------------------------------------------------------------
// Safety (P2, new section)
// ---------------------------------------------------------------------------

const riskyRows = (side: string, list: readonly RiskyCommand[]): string =>
  list
    .map(
      (r) =>
        `<tr><td>${escapeHtml(side)}</td><td>${String(r.runIndex)}</td><td><code>${escapeHtml(r.command)}</code></td><td>${String(r.completed)}</td><td>${r.exitCode === undefined ? '—' : String(r.exitCode)}</td></tr>`,
    )
    .join('')

const renderSafety = (report: Report): string => {
  const old = report.metricsDiff.old.riskyCommands ?? []
  const nw = report.metricsDiff.new.riskyCommands ?? []
  if (old.length === 0 && nw.length === 0) return ''
  return `<section><h2>Safety</h2><p>${String(old.length)} risky command(s) on old, ${String(nw.length)} on new.</p><table><thead><tr><th>Side</th><th>Run</th><th>Command</th><th>Completed</th><th>Exit</th></tr></thead><tbody>${riskyRows('old', old)}${riskyRows('new', nw)}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Judge / Failed runs — unchanged
// ---------------------------------------------------------------------------

const renderJudge = (report: Report): string => {
  const judge = report.judge
  if (judge === undefined) {
    return '<section><h2>LLM Judge</h2><p><em>Judge was not requested.</em></p></section>'
  }
  if (judge.ran === false) {
    return `<section><h2>LLM Judge</h2><p><em>Judge did not run: ${escapeHtml(judge.explanation)}</em></p></section>`
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

// ---------------------------------------------------------------------------
// Secondary metrics — four collapsible groups per side (P4/P5/P6/P7/P11/P12)
// ---------------------------------------------------------------------------

const toolRows = (perTool: Readonly<Record<string, ToolStat>>): string => {
  const entries = Object.entries(perTool)
  if (entries.length === 0) return '<li><em>no tools</em></li>'
  return [...entries]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .map(
      ([name, s]) =>
        `<li><code>${escapeHtml(name)}</code>: count=${String(s.count)} errors=${(s.errorRate * 100).toFixed(0)}% avg=${escapeHtml(fmtInt(s.avgDurationMs))}ms</li>`,
    )
    .join('')
}

const diffTotalsFor = (
  report: Report,
  side: Side,
): { readonly files: number; readonly add: number; readonly del: number } =>
  report.diff[side].runs
    .filter((r) => r.state !== 'failed')
    .reduce(
      (acc, r) => ({
        files: acc.files + r.summary.filesChanged,
        add: acc.add + r.summary.additions,
        del: acc.del + r.summary.deletions,
      }),
      { files: 0, add: 0, del: 0 },
    )

const behaviorGroup = (sec: SecondaryMetrics): string => {
  const finish = Object.entries(sec.finishCauseDistribution)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
  const lines: readonly string[] = [
    `Finish causes: ${finish || 'none'}`,
    `Max same-tool streak: ${String(sec.maxConsecutiveSameTool)}`,
    ...(sec.bashFailCount === undefined
      ? []
      : [`Bash fails (exit != 0): ${String(sec.bashFailCount)} of ${String(sec.perTool['bash']?.count ?? 0)} calls (sum over runs)`]),
    ...(sec.invalidToolCalls === undefined || sec.duplicateToolCalls === undefined
      ? []
      : [`Invalid tool calls: ${String(sec.invalidToolCalls)}; duplicate calls: ${String(sec.duplicateToolCalls)} (sums over runs)`]),
    ...(sec.toolErrorTexts === undefined || sec.toolErrorTexts.length === 0
      ? []
      : [`Tool errors (top): ${sec.toolErrorTexts.join('; ')}`]),
  ]
  const items = lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
  return `${items}<li>Tools (top 20):<ul>${toolRows(sec.perTool)}</ul></li>`
}

const STALL_LABEL = `${String(STALL_THRESHOLD_MS / 1000)}s`

const stallSuffix = (sec: SecondaryMetrics): string =>
  sec.stallCount === undefined || sec.stalledRunCount === undefined
    ? ''
    : `; ${String(sec.stallCount)} stall(s) over ${STALL_LABEL} across ${String(sec.stalledRunCount)} run(s)`

const latencyGroup = (sec: SecondaryMetrics, wallClockMs: string): string => {
  const share = toNum(wallClockMs) > 0 ? ` (${String(Math.round((100 * toNum(sec.reasoningTimeMs)) / toNum(wallClockMs)))}% of wall-clock)` : ''
  const pieces: readonly string[] = [
    ...(sec.timeToFirstToolMs === undefined ? [] : [`First tool: +${fmtDurationMs(sec.timeToFirstToolMs)}`]),
    ...(sec.timeToFirstEditMs === undefined ? [] : [`first edit: +${fmtDurationMs(sec.timeToFirstEditMs)}`]),
    ...(sec.maxEventGapMs === undefined
      ? []
      : [`worst stall: ${fmtDurationMs(sec.maxEventGapMs)} (max over runs)${stallSuffix(sec)}`]),
  ]
  const lines: readonly string[] = [
    `Step latency: p50=${fmtInt(sec.stepLatencyP50Ms)}ms, p95=${fmtInt(sec.stepLatencyP95Ms)}ms`,
    `Reasoning time: ${fmtInt(sec.reasoningTimeMs)}ms${share}; tool avg: ${fmtInt(sec.toolLatencyAvgMs)}ms`,
    ...(pieces.length === 0 ? [] : [capFirst(pieces.join('; '))]),
  ]
  return lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
}

const tokensContextGroup = (sec: SecondaryMetrics): string => {
  const cacheWrite = sec.cacheWriteTokens === undefined ? '' : `, cacheWrite=${fmtInt(sec.cacheWriteTokens)}`
  const first = sec.firstStepInputTokens === undefined ? 'n/a' : `${fmtInt(sec.firstStepInputTokens)} tok`
  const last = sec.lastStepInputTokens === undefined ? 'n/a' : `${fmtInt(sec.lastStepInputTokens)} tok`
  const lines: readonly string[] = [
    `Token breakdown: input=${fmtInt(sec.inputTokens)}, output=${fmtInt(sec.outputTokens)}, reasoning=${fmtInt(sec.reasoningTokens)}, cacheRead=${fmtInt(sec.cacheReadTokens)}${cacheWrite}`,
    ...(sec.firstStepInputTokens === undefined && sec.lastStepInputTokens === undefined
      ? []
      : [`Context: first step in=${first}, last step in=${last}`]),
  ]
  return lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
}

const outputVolumeGroup = (report: Report, side: Side): string => {
  const sec = report.metricsDiff[side].secondary
  const fds = diffTotalsFor(report, side)
  const lines: readonly string[] = [
    `File diff: +${String(fds.add)} -${String(fds.del)} (${String(fds.files)} files)`,
    ...(sec.textChars === undefined
      ? []
      : [`Output: text ${fmtInt(sec.textChars)} ch, reasoning ${fmtInt(sec.reasoningChars ?? '0')} ch`]),
  ]
  return lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
}

const group = (label: string, body: string, open: boolean): string =>
  `<details${open ? ' open' : ''}><summary>${escapeHtml(label)}</summary><ul>${body}</ul></details>`

const renderSecondarySide = (report: Report, side: Side): string => {
  const sec = report.metricsDiff[side].secondary
  const wallClockMs = report.metricsDiff[side].primary.wallClockMs
  const groups = [
    group('Behavior', behaviorGroup(sec), true),
    group('Latency', latencyGroup(sec, wallClockMs), false),
    group('Tokens & context', tokensContextGroup(sec), false),
    group('Output volume', outputVolumeGroup(report, side), false),
  ].join('')
  return `<div class="secondary-side"><h3>${escapeHtml(side.toUpperCase())} secondary</h3>${groups}</div>`
}

const renderSecondary = (report: Report): string =>
  `<section><h2>Secondary metrics</h2>${renderSecondarySide(report, 'old')}${renderSecondarySide(report, 'new')}</section>`

// ---------------------------------------------------------------------------
// Diff summary (+ P8 efficiency ratios, P9 per-file overlap)
// ---------------------------------------------------------------------------

const stateSuffix = (state: Report['diff']['old']['runs'][number]['state']): string =>
  state === 'git-restored'
    ? ' (agent deleted .git, restored from clean clone)'
    : state === 'git-replaced'
      ? ' (agent replaced .git, diff includes agent commits)'
      : ''

/**
 * `stats.totalTokens.samples` covers every run with a successful metric
 * extraction; `diffTotalsFor` only covers runs whose diff also succeeded —
 * a different, often smaller population. Summing both raw drifts with the
 * diff-failure count (same token total, fewer diffed runs -> an inflated,
 * unlabeled ratio). Scaling the per-run median by the diffed-run count keeps
 * both sides on a "typical single diffed run" basis, so the ratio stays
 * stable as the failure count changes, and the label says what it is.
 */
const efficiencyItem = (report: Report, side: Side): string => {
  const t = diffTotalsFor(report, side)
  const diffedRunCount = report.diff[side].runs.filter((r) => r.state !== 'failed').length
  const changedLines = t.add + t.del
  const tokensPerRun = toNum(report.metricsDiff[side].primary.totalTokens)
  const costPerRun = report.metricsDiff[side].primary.costUsd
  const tokensPerLine = changedLines === 0 ? 'n/a' : fmtInt((tokensPerRun * diffedRunCount) / changedLines)
  const costPerFile = t.files === 0 ? 'n/a' : fmtValue((costPerRun * diffedRunCount) / t.files, 'cost')
  return `<li>Efficiency: tokens per changed line ${escapeHtml(tokensPerLine)}, cost per file ${escapeHtml(costPerFile)} (scaled from the per-run median over ${String(diffedRunCount)} diffed run(s))</li>`
}

const overlapSection = (report: Report): string => {
  const pathsOf = (side: Side): ReadonlySet<string> =>
    new Set(report.diff[side].runs.flatMap((r) => r.summary.perFile.map((f) => f.path)))
  const oldPaths = pathsOf('old')
  const newPaths = pathsOf('new')
  const both = [...oldPaths].filter((p) => newPaths.has(p)).sort()
  const onlyOld = [...oldPaths].filter((p) => !newPaths.has(p)).sort()
  const onlyNew = [...newPaths].filter((p) => !oldPaths.has(p)).sort()
  if (both.length === 0 && onlyOld.length === 0 && onlyNew.length === 0) return ''
  const cap = (list: readonly string[]): string => (list.length === 0 ? '<em>none</em>' : list.slice(0, 15).map(escapeHtml).join(', '))
  return `<li><strong>Per-file overlap</strong><ul><li>Both sides: ${cap(both)}</li><li>Only old: ${cap(onlyOld)}</li><li>Only new: ${cap(onlyNew)}</li></ul></li>`
}

const renderDiff = (report: Report): string => {
  const renderSide = (side: Side): string => {
    const t = diffTotalsFor(report, side)
    const runs = report.diff[side].runs
    const failedCount = runs.filter((r) => r.state === 'failed').length
    const failedSuffix = failedCount === 0 ? '' : `, ${String(failedCount)} failed`
    const items = runs
      .map((r) => {
        const idx = String(r.runIndex)
        if (r.state === 'failed') {
          return `<li>run-${escapeHtml(idx)}: diff failed — <code>${escapeHtml(r.error?.message ?? 'unknown')}</code></li>`
        }
        const patchHref = `diff/${side}/run-${idx}/full.patch`
        // `r.htmlPath`, when set, is an absolute filesystem path (phase 08
        // writes it there) — not a link usable from report.html. Only its
        // presence matters; the href always uses the conventional relative
        // path, same as md.ts.
        const htmlLink =
          r.htmlPath !== undefined
            ? ` — <a href="${escapeHtml(`diff/${side}/run-${idx}/side.html`)}">html</a>`
            : ''
        return `<li>run-${escapeHtml(idx)}: +${escapeHtml(String(r.summary.additions))} -${escapeHtml(String(r.summary.deletions))} (${escapeHtml(String(r.summary.filesChanged))} files) — <a href="${escapeHtml(patchHref)}">patch</a>${htmlLink}${escapeHtml(stateSuffix(r.state))}</li>`
      })
      .join('')
    const totalsLine = `+${String(t.add)} -${String(t.del)} (${String(t.files)} files across ${String(runs.length)} run(s)${failedSuffix})`
    return `<li><strong>${escapeHtml(side)}</strong>: ${escapeHtml(totalsLine)}<ul>${items}${efficiencyItem(report, side)}</ul></li>`
  }
  return `<section><h2>Diff summary</h2><ul>${renderSide('old')}${renderSide('new')}${overlapSection(report)}</ul></section>`
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
    renderPackSignal(report),
    renderSafety(report),
    renderSecondary(report),
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
  h3 { font-size: 1rem; margin-top: 1.25rem; }
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
  .stability { margin-top: 1rem; }
  details { margin: .5rem 0; }
  summary { cursor: pointer; font-weight: 600; }
  iframe { border: 1px solid #ddd; border-radius: .25rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`
}
