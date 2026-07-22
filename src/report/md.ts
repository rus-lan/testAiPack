/**
 * Report: md — renders the final report as human-readable Markdown.
 *
 * Pure function: takes a Report, returns a Markdown string. Designed to be
 * readable directly in stdout, not a JSON dump wrapped in code fences.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type { Report, Side, TimelineEvent, ToolStat } from '@generated/types'
import {
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtValue,
  PRIMARY_METRICS,
  sigLabel,
  verdictFor,
} from './format.js'
import type { PrimaryMeta } from './format.js'

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const renderHeader = (report: Report): string => {
  const packLine = report.manifest.packRef
    ? report.manifest.packRef
    : '_smoke-test (no pack)_'
  return [
    `# testaipack report: ${report.manifest.runId}`,
    '',
    `**Repo:** ${report.manifest.repoUrl}`,
    `**Pack:** ${packLine}`,
    `**Runs:** ${String(report.manifest.runs)} per side`,
    `**Timestamp:** ${report.manifest.timestamp}`,
    `**Opencode version:** ${report.manifest.opencodeVersion}`,
  ].join('\n')
}

const renderSummary = (report: Report): string => {
  const deltas = report.metricsDiff.deltas
  const bucket = (
    heading: string,
    metas: readonly PrimaryMeta[],
  ): readonly string[] => {
    const rows =
      metas.length === 0
        ? ['- _none_']
        : metas.map((m) => {
            const d = deltas[m.key]
            return `- **${m.label}**: ${fmtSigned(d.absolute, m.kind)} (${fmtPct(d.percent)}) — ${verdictFor(d)}`
          })
    return [heading, ...rows]
  }
  const improvements = PRIMARY_METRICS.filter((m) => deltas[m.key].better === 'better')
  const regressions = PRIMARY_METRICS.filter((m) => deltas[m.key].better === 'worse')
  const neutral = PRIMARY_METRICS.filter(
    (m) => deltas[m.key].better === 'neutral' || deltas[m.key].better === 'context-dependent',
  )
  return [
    '## Summary',
    '',
    report.summary.headlineResult,
    '',
    ...bucket('### Improvements', improvements),
    '',
    ...bucket('### Regressions', regressions),
    '',
    ...bucket('### Neutral', neutral),
  ].join('\n')
}

const renderPrimary = (report: Report): string => {
  const bothFailed = report.metricsDiff.bothFailed
  const warn = bothFailed ? ['> ⚠ **Both sides failed — comparison unreliable.**', ''] : []
  const header = [
    '| Metric | Old (median) | New (median) | Δ | Δ% | Significant | Verdict |',
    '|---|---|---|---|---|---|---|',
  ]
  const rows = PRIMARY_METRICS.map((m) => {
    const d = report.metricsDiff.deltas[m.key]
    const oldV = fmtValue(report.metricsDiff.old.primary[m.key], m.kind)
    const newV = fmtValue(report.metricsDiff.new.primary[m.key], m.kind)
    return `| ${m.label} | ${oldV} | ${newV} | ${fmtSigned(d.absolute, m.kind)} | ${fmtPct(d.percent)} | ${sigLabel(d)} | ${verdictFor(d)} |`
  })
  return ['## Primary metrics (delta)', '', ...warn, ...header, ...rows].join('\n')
}

const toolRows = (perTool: Readonly<Record<string, ToolStat>>): readonly string[] => {
  const entries = Object.entries(perTool)
  if (entries.length === 0) return ['  - _no tools_']
  return entries
    .slice(0, 20)
    .map(
      ([name, s]) =>
        `  - \`${escapeCell(name)}\`: count=${String(s.count)} errors=${(s.errorRate * 100).toFixed(0)}% avg=${fmtInt(s.avgDurationMs)}ms`,
    )
}

const renderSecondary = (report: Report): string => {
  const renderSide = (side: Side): readonly string[] => {
    const sec = report.metricsDiff[side].secondary
    const finish = Object.entries(sec.finishCauseDistribution)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
    const fds = sec.fileDiffStats
    return [
      `### ${side.toUpperCase()} secondary`,
      `- Finish causes: ${finish || '_none_'}`,
      `- Step latency: p50=${fmtInt(sec.stepLatencyP50Ms)}ms, p95=${fmtInt(sec.stepLatencyP95Ms)}ms`,
      `- Reasoning time: ${fmtInt(sec.reasoningTimeMs)}ms; tool avg: ${fmtInt(sec.toolLatencyAvgMs)}ms`,
      `- File diff: +${String(fds.additions)} -${String(fds.deletions)} (${String(fds.filesChanged)} files)`,
      `- Token breakdown: input=${fmtInt(sec.inputTokens)}, output=${fmtInt(sec.outputTokens)}, reasoning=${fmtInt(sec.reasoningTokens)}, cacheRead=${fmtInt(sec.cacheReadTokens)}`,
      '- Tools (top 20):',
      ...toolRows(sec.perTool),
    ]
  }
  return ['## Secondary metrics', '', ...renderSide('old'), '', ...renderSide('new')].join('\n')
}

const renderFailures = (report: Report): string => {
  const oldF = report.metricsDiff.old.failedRuns
  const newF = report.metricsDiff.new.failedRuns
  if (oldF.length === 0 && newF.length === 0) return ''
  const warn = report.metricsDiff.bothFailed
    ? ['> ⚠ **Both sides failed — comparison unreliable.**', '']
    : []
  const header = ['| Side | Run | Code | Message |', '|---|---|---|---|']
  const rows = [
    ...oldF.map(
      (f) =>
        `| old | ${String(f.runIndex)} | \`${f.errorCode}\` | ${escapeCell(f.errorMessage)} |`,
    ),
    ...newF.map(
      (f) =>
        `| new | ${String(f.runIndex)} | \`${f.errorCode}\` | ${escapeCell(f.errorMessage)} |`,
    ),
  ]
  return ['## Failed runs', '', ...warn, ...header, ...rows].join('\n')
}

const renderJudge = (report: Report): string => {
  const j = report.judge
  if (j === undefined) {
    return ['## LLM Judge', '', '_Judge was not requested (--judge not set)_'].join('\n')
  }
  const note = j.verdict === 'unclear' ? ' _(unclear)_' : ''
  return [
    '## LLM Judge',
    '',
    `- Verdict: **${j.verdict}**${note}`,
    `- Quality: old=${String(j.oldQuality)}, new=${String(j.newQuality)}`,
    `- Model: \`${j.modelUsed}\``,
    `- Explanation: ${j.explanation}`,
  ].join('\n')
}

const renderTimeline = (report: Report): string => {
  const all: readonly TimelineEvent[] = [...report.timeline.old, ...report.timeline.new]
  if (all.length === 0) {
    return ['## Timeline summary', '', '_No timeline events._'].join('\n')
  }
  const ranked = [...all]
    .map((e) => ({ e, dur: Number(e.tEnd) - Number(e.tStart) }))
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 5)
  const rows = ranked.map(({ e, dur }) => {
    const tool = e.tool ? ` (${e.tool})` : ''
    return `- [${e.side}/run-${String(e.runIndex)}] \`${e.type}\`${tool}: ${fmtInt(dur)}ms`
  })
  return [
    '## Timeline summary',
    '',
    ...rows,
    '',
    '_See `results/timeline.html` for the full interactive timeline._',
  ].join('\n')
}

const renderDiff = (report: Report): string => {
  const totalsFor = (side: Side): { readonly files: number; readonly add: number; readonly del: number } =>
    report.diff[side].runs.reduce(
      (acc, r) => ({
        files: acc.files + r.summary.filesChanged,
        add: acc.add + r.summary.additions,
        del: acc.del + r.summary.deletions,
      }),
      { files: 0, add: 0, del: 0 },
    )
  const renderSide = (side: Side): readonly string[] => {
    const t = totalsFor(side)
    const runs = report.diff[side].runs
    const runLines = runs.map((r) => {
      const patch = `diff/${side}/run-${String(r.runIndex)}/full.patch`
      const html =
        r.htmlPath !== undefined ? `, [html](diff/${side}/run-${String(r.runIndex)}/side.html)` : ''
      return `  - run-${String(r.runIndex)}: +${String(r.summary.additions)} -${String(r.summary.deletions)} (${String(r.summary.filesChanged)} files) — [patch](${patch})${html}`
    })
    return [
      `- **${side}**: +${String(t.add)} -${String(t.del)} (${String(t.files)} files across ${String(runs.length)} run(s))`,
      ...runLines,
    ]
  }
  return ['## Diff summary', '', ...renderSide('old'), '', ...renderSide('new')].join('\n')
}

export const renderMd = (report: Report): string =>
  [
    renderHeader(report),
    renderSummary(report),
    renderPrimary(report),
    renderSecondary(report),
    renderFailures(report),
    renderJudge(report),
    renderTimeline(report),
    renderDiff(report),
  ]
    .filter((s) => s !== '')
    .join('\n\n---\n\n') + '\n'
