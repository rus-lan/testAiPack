/**
 * Report: md — renders the final report as human-readable Markdown.
 *
 * Pure function: takes a Report, returns a Markdown string. Designed to be
 * readable directly in stdout, not a JSON dump wrapped in code fences.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type { AggregateStats, PackUse, Report, RiskyCommand, SecondaryMetrics, Side, TimelineEvent, ToolStat } from '@generated/types'
import {
  fmtDurationMs,
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtValue,
  PRIMARY_METRICS,
  sigLabel,
  toNum,
  verdictFor,
} from './format.js'
import type { PrimaryMeta } from './format.js'
import { STALL_THRESHOLD_MS } from '../metrics/aggregate.js'

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ---------------------------------------------------------------------------
// Header (P13: opencode version-drift warning)
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
  return `> ⚠ opencode version differs from manifest: manifest says ${manifestVersion}, runs used ${distinct.join(', ')} (manifest may record the HOST binary — see root cause below)`
}

const renderHeader = (report: Report): string => {
  const packLine = report.manifest.packRef
    ? report.manifest.packRef
    : '_smoke-test (no pack)_'
  const warn = versionDriftWarning(report)
  return [
    `# testaipack report: ${report.manifest.runId}`,
    '',
    `**Repo:** ${report.manifest.repoUrl}`,
    `**Pack:** ${packLine}`,
    `**Runs:** ${String(report.manifest.runs)} per side`,
    `**Timestamp:** ${report.manifest.timestamp}`,
    `**Opencode version:** ${report.manifest.opencodeVersion}`,
    ...(warn === undefined ? [] : ['', warn]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Summary (P1 pack-noop alert, P2 risky-command alert)
// ---------------------------------------------------------------------------

const packNoopWarning = (report: Report): string | undefined => {
  const pu = report.metricsDiff.new.packUse
  if (pu === undefined || !pu.canDetect || pu.calls !== 0) return undefined
  return '> ⚠ **Pack was never invoked on the NEW side — deltas compare baseline vs baseline.**'
}

const riskyCommandAlert = (report: Report): string | undefined => {
  const n = (report.metricsDiff.old.riskyCommands?.length ?? 0) + (report.metricsDiff.new.riskyCommands?.length ?? 0)
  return n === 0 ? undefined : `> ⚠ ${String(n)} risky command(s) detected — see Safety`
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
  const alerts = [packNoopWarning(report), riskyCommandAlert(report)].filter((s): s is string => s !== undefined)
  return [
    '## Summary',
    '',
    ...(alerts.length === 0 ? [] : [...alerts, '']),
    report.summary.headlineResult,
    '',
    ...bucket('### Improvements', improvements),
    '',
    ...bucket('### Regressions', regressions),
    '',
    ...bucket('### Neutral', neutral),
  ].join('\n')
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
  const bothFailed = report.metricsDiff.bothFailed
  const warn = bothFailed ? ['> ⚠ **Both sides failed — comparison unreliable.**', ''] : []
  const header = [
    '| Metric | Old (median) | Old [min–max] | New (median) | New [min–max] | Δ | Δ% | Significant | Verdict |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  const rows = PRIMARY_METRICS.map((m) => {
    const d = report.metricsDiff.deltas[m.key]
    const oldV = fmtValue(report.metricsDiff.old.primary[m.key], m.kind)
    const newV = fmtValue(report.metricsDiff.new.primary[m.key], m.kind)
    return `| ${m.label} | ${oldV} | ${spreadCell(report, 'old', m)} | ${newV} | ${spreadCell(report, 'new', m)} | ${fmtSigned(d.absolute, m.kind)} | ${fmtPct(d.percent)} | ${sigLabel(d)} | ${verdictFor(d)} |`
  })
  return ['## Primary metrics (delta)', '', ...warn, ...header, ...rows, '', ...renderStability(report)].join('\n')
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

const verifyPart = (sec: { readonly passed: number; readonly failed: number; readonly timedOut: number; readonly runCount: number } | undefined): string => {
  if (sec === undefined) return ''
  const detail = sec.failed === 0 && sec.timedOut === 0 ? '' : ` (${String(sec.failed)} failed, ${String(sec.timedOut)} timed out)`
  return `; verify: ${String(sec.passed)}/${String(sec.runCount)} passed${detail}`
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
  const hist = rankHistogram(samples)
  const unstable = unstableLabels(report, side)
  const unstablePart = unstable.length === 0 ? '' : `; unstable: ${unstable.join(', ')}`
  return `- **${side.toUpperCase()}**: success rate ${String(okCount)}/${String(totalRuns)} (${rate}); ${hist}${unstablePart}${verifyPart(report.metricsDiff[side].verifyStats)}`
}

const renderStability = (report: Report): readonly string[] => [
  '### Stability',
  stabilityLine(report, 'old'),
  stabilityLine(report, 'new'),
]

// ---------------------------------------------------------------------------
// Pack signal (P1, new section)
// ---------------------------------------------------------------------------

const packSignalLine = (side: Side, pu: PackUse | undefined): string => {
  if (pu === undefined) return `- **${side}**: _no data_`
  if (!pu.canDetect) return `- **${side}**: _pack use is not visible for this pack type_`
  const first = pu.firstCallMsMedian === undefined ? '' : `, first-call median ${fmtInt(pu.firstCallMsMedian)}ms`
  return `- **${side}**: ${String(pu.calls)} call(s), ${String(pu.errors)} error(s), ${String(pu.runsWithCall)}/${String(pu.runCount)} runs called the pack${first}`
}

const renderPackSignal = (report: Report): string => {
  const old = report.metricsDiff.old.packUse
  const nw = report.metricsDiff.new.packUse
  if (old === undefined && nw === undefined) return ''
  return ['## Pack signal', '', packSignalLine('old', old), packSignalLine('new', nw)].join('\n')
}

// ---------------------------------------------------------------------------
// Safety (P2, new section)
// ---------------------------------------------------------------------------

const riskyRows = (side: string, list: readonly RiskyCommand[]): readonly string[] =>
  list.map(
    (r) =>
      `| ${side} | ${String(r.runIndex)} | \`${escapeCell(r.command)}\` | ${String(r.completed)} | ${r.exitCode === undefined ? '—' : String(r.exitCode)} |`,
  )

const renderSafety = (report: Report): string => {
  const old = report.metricsDiff.old.riskyCommands ?? []
  const nw = report.metricsDiff.new.riskyCommands ?? []
  if (old.length === 0 && nw.length === 0) return ''
  const header = ['| Side | Run | Command | Completed | Exit |', '|---|---|---|---|---|']
  return [
    '## Safety',
    '',
    `${String(old.length)} risky command(s) on old, ${String(nw.length)} on new.`,
    '',
    ...header,
    ...riskyRows('old', old),
    ...riskyRows('new', nw),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Secondary metrics — four groups per side (P4/P5/P6/P7/P11/P12)
// ---------------------------------------------------------------------------

const toolRows = (perTool: Readonly<Record<string, ToolStat>>): readonly string[] => {
  const entries = Object.entries(perTool)
  if (entries.length === 0) return ['    - _no tools_']
  return [...entries]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .map(
      ([name, s]) =>
        `    - \`${escapeCell(name)}\`: count=${String(s.count)} errors=${(s.errorRate * 100).toFixed(0)}% avg=${fmtInt(s.avgDurationMs)}ms`,
    )
}

/**
 * Sums each run's `git diff --numstat`-derived summary (phase 08) for one
 * side — the only real source of file-change counts (an opencode export's
 * own `info.summary` is not populated with meaningful values, which is why
 * `SecondaryMetrics` no longer carries a file-diff field of its own).
 */
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

const behaviorGroup = (sec: SecondaryMetrics): readonly string[] => {
  const finish = Object.entries(sec.finishCauseDistribution)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
  const lines: readonly string[] = [
    `Finish causes: ${finish || '_none_'}`,
    `Max same-tool streak: ${String(sec.maxConsecutiveSameTool)}`,
    ...(sec.bashFailCount === undefined
      ? []
      : [`Bash fails (exit != 0): ${String(sec.bashFailCount)} of ${String(sec.perTool['bash']?.count ?? 0)} calls (sum over runs)`]),
    ...(sec.invalidToolCalls === undefined || sec.duplicateToolCalls === undefined
      ? []
      : [`Invalid tool calls: ${String(sec.invalidToolCalls)}; duplicate calls: ${String(sec.duplicateToolCalls)} (sums over runs)`]),
    ...(sec.toolErrorTexts === undefined || sec.toolErrorTexts.length === 0
      ? []
      : [`Tool errors (top): ${sec.toolErrorTexts.map(escapeCell).join('; ')}`]),
  ]
  return [
    ...lines.map((l) => `  - ${l}`),
    '  - Tools (top 20):',
    ...toolRows(sec.perTool),
  ]
}

const STALL_LABEL = `${String(STALL_THRESHOLD_MS / 1000)}s`

const stallSuffix = (sec: SecondaryMetrics): string =>
  sec.stallCount === undefined || sec.stalledRunCount === undefined
    ? ''
    : `; ${String(sec.stallCount)} stall(s) over ${STALL_LABEL} across ${String(sec.stalledRunCount)} run(s)`

const latencyGroup = (sec: SecondaryMetrics, wallClockMs: string): readonly string[] => {
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
  return lines.map((l) => `  - ${l}`)
}

const tokensContextGroup = (sec: SecondaryMetrics): readonly string[] => {
  const cacheWrite = sec.cacheWriteTokens === undefined ? '' : `, cacheWrite=${fmtInt(sec.cacheWriteTokens)}`
  const first = sec.firstStepInputTokens === undefined ? 'n/a' : `${fmtInt(sec.firstStepInputTokens)} tok`
  const last = sec.lastStepInputTokens === undefined ? 'n/a' : `${fmtInt(sec.lastStepInputTokens)} tok`
  const lines: readonly string[] = [
    `Token breakdown: input=${fmtInt(sec.inputTokens)}, output=${fmtInt(sec.outputTokens)}, reasoning=${fmtInt(sec.reasoningTokens)}, cacheRead=${fmtInt(sec.cacheReadTokens)}${cacheWrite}`,
    ...(sec.firstStepInputTokens === undefined && sec.lastStepInputTokens === undefined
      ? []
      : [`Context: first step in=${first}, last step in=${last}`]),
  ]
  return lines.map((l) => `  - ${l}`)
}

const outputVolumeGroup = (report: Report, side: Side): readonly string[] => {
  const sec = report.metricsDiff[side].secondary
  const fds = diffTotalsFor(report, side)
  const lines: readonly string[] = [
    `File diff: +${String(fds.add)} -${String(fds.del)} (${String(fds.files)} files)`,
    ...(sec.textChars === undefined
      ? []
      : [`Output: text ${fmtInt(sec.textChars)} ch, reasoning ${fmtInt(sec.reasoningChars ?? '0')} ch`]),
  ]
  return lines.map((l) => `  - ${l}`)
}

const renderSecondary = (report: Report): string => {
  const renderSide = (side: Side): readonly string[] => {
    const sec = report.metricsDiff[side].secondary
    const wallClockMs = report.metricsDiff[side].primary.wallClockMs
    return [
      `### ${side.toUpperCase()} secondary`,
      '- **Behavior**',
      ...behaviorGroup(sec),
      '- **Latency**',
      ...latencyGroup(sec, wallClockMs),
      '- **Tokens & context**',
      ...tokensContextGroup(sec),
      '- **Output volume**',
      ...outputVolumeGroup(report, side),
    ]
  }
  return ['## Secondary metrics', '', ...renderSide('old'), '', ...renderSide('new')].join('\n')
}

// ---------------------------------------------------------------------------
// Failed runs / LLM judge / timeline — unchanged
// ---------------------------------------------------------------------------

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
  if (j.ran === false) {
    return ['## LLM Judge', '', `_Judge did not run: ${j.explanation}_`].join('\n')
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

// ---------------------------------------------------------------------------
// Diff summary (+ P8 efficiency ratios, P9 per-file overlap)
// ---------------------------------------------------------------------------

const stateMarker = (state: Report['diff']['old']['runs'][number]['state']): string =>
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
const efficiencyLine = (report: Report, side: Side): string => {
  const t = diffTotalsFor(report, side)
  const diffedRunCount = report.diff[side].runs.filter((r) => r.state !== 'failed').length
  const changedLines = t.add + t.del
  const tokensPerRun = toNum(report.metricsDiff[side].primary.totalTokens)
  const costPerRun = report.metricsDiff[side].primary.costUsd
  const tokensPerLine = changedLines === 0 ? 'n/a' : fmtInt((tokensPerRun * diffedRunCount) / changedLines)
  const costPerFile = t.files === 0 ? 'n/a' : fmtValue((costPerRun * diffedRunCount) / t.files, 'cost')
  return `  - Efficiency: tokens per changed line ${tokensPerLine}, cost per file ${costPerFile} (scaled from the per-run median over ${String(diffedRunCount)} diffed run(s))`
}

const overlapLines = (report: Report): readonly string[] => {
  const pathsOf = (side: Side): ReadonlySet<string> =>
    new Set(report.diff[side].runs.flatMap((r) => r.summary.perFile.map((f) => f.path)))
  const oldPaths = pathsOf('old')
  const newPaths = pathsOf('new')
  const both = [...oldPaths].filter((p) => newPaths.has(p)).sort()
  const onlyOld = [...oldPaths].filter((p) => !newPaths.has(p)).sort()
  const onlyNew = [...newPaths].filter((p) => !oldPaths.has(p)).sort()
  if (both.length === 0 && onlyOld.length === 0 && onlyNew.length === 0) return []
  const cap = (list: readonly string[]): string => (list.length === 0 ? '_none_' : list.slice(0, 15).map(escapeCell).join(', '))
  return [
    '- **Per-file overlap**',
    `  - Both sides: ${cap(both)}`,
    `  - Only old: ${cap(onlyOld)}`,
    `  - Only new: ${cap(onlyNew)}`,
  ]
}

const renderDiff = (report: Report): string => {
  const renderSide = (side: Side): readonly string[] => {
    const t = diffTotalsFor(report, side)
    const runs = report.diff[side].runs
    const failedCount = runs.filter((r) => r.state === 'failed').length
    const failedSuffix = failedCount === 0 ? '' : `, ${String(failedCount)} failed`
    const runLines = runs.map((r) => {
      if (r.state === 'failed') {
        return `  - run-${String(r.runIndex)}: diff failed — ${r.error?.message ?? 'unknown'}`
      }
      const patch = `diff/${side}/run-${String(r.runIndex)}/full.patch`
      const html =
        r.htmlPath !== undefined ? `, [html](diff/${side}/run-${String(r.runIndex)}/side.html)` : ''
      return `  - run-${String(r.runIndex)}: +${String(r.summary.additions)} -${String(r.summary.deletions)} (${String(r.summary.filesChanged)} files) — [patch](${patch})${html}${stateMarker(r.state)}`
    })
    return [
      `- **${side}**: +${String(t.add)} -${String(t.del)} (${String(t.files)} files across ${String(runs.length)} run(s)${failedSuffix})`,
      ...runLines,
      efficiencyLine(report, side),
    ]
  }
  const overlap = overlapLines(report)
  return [
    '## Diff summary',
    '',
    ...renderSide('old'),
    '',
    ...renderSide('new'),
    ...(overlap.length === 0 ? [] : ['', ...overlap]),
  ].join('\n')
}

export const renderMd = (report: Report): string =>
  [
    renderHeader(report),
    renderSummary(report),
    renderPrimary(report),
    renderPackSignal(report),
    renderSafety(report),
    renderSecondary(report),
    renderFailures(report),
    renderJudge(report),
    renderTimeline(report),
    renderDiff(report),
  ]
    .filter((s) => s !== '')
    .join('\n\n---\n\n') + '\n'
