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
import type {
  AggregateStats,
  ContaminationSignal,
  PackCmdResult,
  PackSetupMode,
  PackSetupReport,
  PackUse,
  PhaseDeltas,
  PhaseSlice,
  PhaseSliceStats,
  Report,
  RiskyCommand,
  SecondaryMetrics,
  Side,
  SidePhaseSplit,
  ToolStat,
} from '@generated/types'
import {
  deltaEntriesFor,
  fmtDurationMs,
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtValue,
  PHASE_METRICS,
  PRIMARY_METRICS,
  sigLabel,
  toNum,
  verdictFor,
} from './format.js'
import type { DeltaEntry, PrimaryMeta } from './format.js'
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

/**
 * `flagDefaults` is an untyped disclosure bag (same channel `dockerDowngraded`
 * uses) — `initSide` was added there, not as its own contract field, so this
 * reads it defensively. `both` is the mechanism by which a baseline can pick
 * up the pack under test (see the contamination alert), so it's called out.
 */
const hasPhaseSplit = (report: Report): boolean =>
  report.metricsDiff.old.phaseSplit !== undefined || report.metricsDiff.new.phaseSplit !== undefined

const initSideLine = (report: Report): string | undefined => {
  if (report.manifest.init === undefined) return undefined
  const raw = report.manifest.flagDefaults['initSide']
  if (typeof raw !== 'string') return '<strong>Init side:</strong> unknown (report predates --init-side)'
  if (raw === 'both') {
    return '<strong>Init side:</strong> both — sent to both sides; this is how a baseline can pick up the pack under test'
  }
  // One session/export per run — the init call's tokens/steps/tool-calls/wall-clock
  // land entirely on the side that received it, inflating that side's numbers
  // relative to the other. Honest cost of a scoped init, not noise, but only if
  // the reader knows to expect it. When the split exists, the Phase split
  // section already separates that cost out — point there instead.
  const tail = hasPhaseSplit(report)
    ? 'metrics below are split — the headline compares task vs task; init cost is reported separately'
    : 'that asymmetry is expected, not a measurement error'
  const note = ` — only the ${raw.toUpperCase()} side's metrics carry the init call's cost (tokens, steps, tool calls, wall-clock); ${tail}`
  return `<strong>Init side:</strong> ${escapeHtml(raw)}${escapeHtml(note)}`
}

/**
 * `--pack-hint` changes what the agent was told, so it changes what the
 * comparison measures — a reader needs to see both that a hint ran and what
 * it said. "Sent identically to both sides" is stated plainly: unlike
 * `--init`, there is no side-targeting flag for the hint (see
 * `effectiveTaskPrompt` in `06-run-side.ts`), so this line is always true.
 */
const hintLine = (report: Report): string | undefined => {
  const hint = report.manifest.packHint
  if (hint === undefined || hint === '') return undefined
  return `<strong>Pack hint:</strong> sent identically to both sides — <code>${escapeHtml(hint)}</code>`
}

const renderHeader = (report: Report): string => {
  const pack = report.manifest.packRef ?? '_smoke-test (no pack)_'
  const warn = versionDriftWarning(report)
  const warnHtml = warn === undefined ? '' : `<p class="warn">⚠ ${escapeHtml(warn)}</p>`
  const initLine = initSideLine(report)
  const initHtml = initLine === undefined ? '' : `<br>\n${initLine}`
  const hint = hintLine(report)
  const hintHtml = hint === undefined ? '' : `<br>\n${hint}`
  return `<h1>testaipack report: ${escapeHtml(report.manifest.runId)}</h1>
<p class="meta"><strong>Repo:</strong> ${escapeHtml(report.manifest.repoUrl)}<br>
<strong>Pack:</strong> ${escapeHtml(pack)}<br>
<strong>Runs:</strong> ${escapeHtml(String(report.manifest.runs))} per side<br>
<strong>Opencode:</strong> ${escapeHtml(report.manifest.opencodeVersion)}<br>
<strong>Timestamp:</strong> ${escapeHtml(report.manifest.timestamp)}${initHtml}${hintHtml}</p>
${warnHtml}`
}

// ---------------------------------------------------------------------------
// Summary (P1 pack-noop alert, P2 risky-command alert)
// ---------------------------------------------------------------------------

/**
 * "Chose not to call it" and "deltas compare baseline vs baseline" are both
 * false under exercised mode: the harness ran the pack's pipeline BEFORE the
 * agent started, so the agent never had a reason to call it itself, and the
 * new side genuinely differs from baseline (the dependency's output was
 * present) even with zero direct tool calls — a real run showed the agent
 * reading and delegating a subagent to use exactly that output while this
 * banner still claimed the comparison was worthless. Reserved for
 * installed-only/delivered-only, where the agent genuinely had the option
 * and skipped it — see `packExercisedZeroCallsNote` for the exercised case.
 */
const packNoopWarning = (report: Report): string | undefined => {
  const pu = report.metricsDiff.new.packUse
  if (pu === undefined || !pu.canDetect || pu.calls !== 0) return undefined
  if (report.packSetup?.mode === 'exercised') return undefined
  return pu.visibilityConfirmed
    ? 'Pack was never invoked on the NEW side — preflight confirmed it was visible, so the model chose not to call it. Deltas compare baseline vs baseline.'
    : 'Pack was never invoked on the NEW side — deltas compare baseline vs baseline.'
}

/** Companion to `packNoopWarning` for exercised mode: informational, not a warning — zero direct calls is the expected shape here, not a red flag. */
const packExercisedZeroCallsNote = (report: Report): string | undefined => {
  const pu = report.metricsDiff.new.packUse
  if (pu === undefined || !pu.canDetect || pu.calls !== 0) return undefined
  if (report.packSetup?.mode !== 'exercised') return undefined
  return 'Pack was never called directly on the NEW side — <code>--pack-exercise</code> already ran its pipeline before the agent started, so there was nothing left to trigger. Expected under exercised mode, not a defect; see Harness preparation.'
}

const riskyCommandAlert = (report: Report): string | undefined => {
  const n = (report.metricsDiff.old.riskyCommands?.length ?? 0) + (report.metricsDiff.new.riskyCommands?.length ?? 0)
  return n === 0 ? undefined : `${String(n)} risky command(s) detected — see Safety`
}

const contaminationSignalsOf = (report: Report): readonly ContaminationSignal[] =>
  report.metricsDiff.old.contaminationSignals ?? []

const contaminationAlert = (report: Report): string | undefined => {
  const n = contaminationSignalsOf(report).length
  return n === 0
    ? undefined
    : `Baseline contamination: the OLD side shows ${String(n)} sign(s) of having acquired or used the pack under test — deltas below may not compare a clean baseline against a treatment. See Baseline contamination.`
}

const renderSummary = (report: Report): string => {
  const { entries, basis } = deltaEntriesFor(report.metricsDiff)
  const bucket = (heading: string, es: readonly DeltaEntry[]): string => {
    const items =
      es.length === 0
        ? '<li><em>none</em></li>'
        : es
            .map(
              (e) =>
                `<li><strong>${escapeHtml(e.label)}</strong>: ${escapeHtml(fmtSigned(e.d.absolute, e.kind))} (${escapeHtml(fmtPct(e.d.percent))}) — ${escapeHtml(verdictFor(e.d))}</li>`,
            )
            .join('')
    return `<section><h2>${escapeHtml(heading)}</h2><ul>${items}</ul></section>`
  }
  const improvements = entries.filter((e) => e.d.better === 'better')
  const regressions = entries.filter((e) => e.d.better === 'worse')
  const neutral = entries.filter((e) => e.d.better === 'neutral' || e.d.better === 'context-dependent')
  const alerts = [packNoopWarning(report), riskyCommandAlert(report), contaminationAlert(report)].filter(
    (s): s is string => s !== undefined,
  )
  const alertsHtml = alerts.map((a) => `<p class="warn">⚠ ${escapeHtml(a)}</p>`).join('')
  const exercisedNote = packExercisedZeroCallsNote(report)
  const exercisedNoteHtml = exercisedNote === undefined ? '' : `<p class="basis"><em>${exercisedNote}</em></p>`
  const basisHtml =
    basis === 'task'
      ? '<p class="basis"><em>Basis: task phase only (init excluded); init cost shown in "Init cost" below.</em></p>'
      : ''
  return `<section id="summary">
<h2>Summary</h2>
${alertsHtml}
${exercisedNoteHtml}
<p class="headline">${escapeHtml(report.summary.headlineResult)}</p>
${basisHtml}
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
<h2>Primary metrics — total (init + task)</h2>
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
// Phase split (metric-split spec §5.7) — mirrors md.ts's renderPhaseSplit.
// ---------------------------------------------------------------------------

const PHASE_TABLE_HEAD =
  '<thead><tr><th>Metric</th><th>Old (median)</th><th>Old [min–max]</th><th>New (median)</th><th>New [min–max]</th><th>Δ</th><th>Δ%</th><th>Significant</th><th>Verdict</th></tr></thead>'

interface ResolvedPhaseDelta {
  readonly oldSlice: PhaseSlice
  readonly oldStats: PhaseSliceStats
  readonly oldProrated: boolean
  readonly newSlice: PhaseSlice
  readonly newStats: PhaseSliceStats
  readonly newProrated: boolean
  readonly deltas: PhaseDeltas
}

const resolveTask = (
  oldSplit: SidePhaseSplit | undefined,
  newSplit: SidePhaseSplit | undefined,
  taskDeltas: PhaseDeltas | undefined,
): ResolvedPhaseDelta | undefined => {
  if (oldSplit === undefined || newSplit === undefined || taskDeltas === undefined) return undefined
  return {
    oldSlice: oldSplit.task,
    oldStats: oldSplit.taskStats,
    oldProrated: oldSplit.costProrated === true,
    newSlice: newSplit.task,
    newStats: newSplit.taskStats,
    newProrated: newSplit.costProrated === true,
    deltas: taskDeltas,
  }
}

/** Only defined when BOTH sides ran init — never a one-sided delta (spec §4.1). */
const resolveInit = (
  oldSplit: SidePhaseSplit | undefined,
  newSplit: SidePhaseSplit | undefined,
  initDeltas: PhaseDeltas | undefined,
): ResolvedPhaseDelta | undefined => {
  if (oldSplit?.init === undefined || oldSplit.initStats === undefined) return undefined
  if (newSplit?.init === undefined || newSplit.initStats === undefined) return undefined
  if (initDeltas === undefined) return undefined
  return {
    oldSlice: oldSplit.init,
    oldStats: oldSplit.initStats,
    oldProrated: oldSplit.costProrated === true,
    newSlice: newSplit.init,
    newStats: newSplit.initStats,
    newProrated: newSplit.costProrated === true,
    deltas: initDeltas,
  }
}

const phaseSpreadCell = (stats: PhaseSliceStats, m: (typeof PHASE_METRICS)[number]): string => {
  const stat = stats[m.key]
  const range = `${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}`
  return stat.iqr === undefined ? range : `${range} (IQR=${fmtValue(stat.iqr, m.kind)})`
}

const phaseDeltaRows = (r: ResolvedPhaseDelta): string =>
  PHASE_METRICS.map((m) => {
    const d = r.deltas[m.key]
    const oldMark = m.key === 'costUsd' && r.oldProrated ? '~' : ''
    const newMark = m.key === 'costUsd' && r.newProrated ? '~' : ''
    const oldV = `${oldMark}${fmtValue(r.oldSlice[m.key], m.kind)}`
    const newV = `${newMark}${fmtValue(r.newSlice[m.key], m.kind)}`
    const cls = VERDICT_CLASS[d.better] ?? 'neutral'
    return `<tr><td>${escapeHtml(m.label)}</td><td>${escapeHtml(oldV)}</td><td>${escapeHtml(phaseSpreadCell(r.oldStats, m))}</td><td>${escapeHtml(newV)}</td><td>${escapeHtml(phaseSpreadCell(r.newStats, m))}</td><td>${escapeHtml(fmtSigned(d.absolute, m.kind))}</td><td>${escapeHtml(fmtPct(d.percent))}</td><td>${escapeHtml(sigLabel(d))}</td><td class="${cls}">${escapeHtml(verdictFor(d))}</td></tr>`
  }).join('')

const proratedFootnote = (r: ResolvedPhaseDelta): string =>
  r.oldProrated || r.newProrated
    ? '<p class="prorated-note"><em>~ cost prorated from the session total by token share — derived, not measured.</em></p>'
    : ''

const setupLine = (split: SidePhaseSplit | undefined, sideLabel: string): string =>
  split?.setup === undefined
    ? ''
    : `<li><strong>${escapeHtml(sideLabel)}</strong>: pack setup (harness, no model call) — median ${escapeHtml(fmtInt(split.setup.wallClockMs))}ms</li>`

/** One-sided (or no-init) rendering: a cost figure only, never a delta. */
const initCostLines = (split: SidePhaseSplit | undefined, sideLabel: string): string => {
  if (split?.init === undefined || split.initStats === undefined) {
    return `<li><strong>${escapeHtml(sideLabel)}</strong>: no init phase</li>`
  }
  const init = split.init
  const stats = split.initStats
  const metricsLine = PHASE_METRICS.map((m) => {
    const mark = m.key === 'costUsd' && split.costProrated === true ? '~' : ''
    const stat = stats[m.key]
    return `${m.label} ${mark}${fmtValue(init[m.key], m.kind)} [${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}]`
  }).join(', ')
  return `<li><strong>${escapeHtml(sideLabel)}</strong> (${String(split.runsWithInit)} run(s) with init): ${escapeHtml(metricsLine)}</li>`
}

const lostInitLines = (report: Report): string => {
  const oldN = report.metricsDiff.old.phaseSplit?.runsWithLostInit ?? 0
  const newN = report.metricsDiff.new.phaseSplit?.runsWithLostInit ?? 0
  const lines: readonly string[] = [
    ...(oldN === 0
      ? []
      : [`<p class="warn">⚠ OLD: ${String(oldN)} run(s) ran --init but the export lost the init session — init cost unmeasured.</p>`]),
    ...(newN === 0
      ? []
      : [`<p class="warn">⚠ NEW: ${String(newN)} run(s) ran --init but the export lost the init session — init cost unmeasured.</p>`]),
  ]
  return lines.join('')
}

const renderPhaseSplit = (report: Report): string => {
  const oldSplit = report.metricsDiff.old.phaseSplit
  const newSplit = report.metricsDiff.new.phaseSplit
  if (oldSplit === undefined && newSplit === undefined) return ''

  const task = resolveTask(oldSplit, newSplit, report.metricsDiff.taskDeltas)
  const taskHtml =
    task === undefined
      ? ''
      : `<h3>Task phase (like-for-like)</h3><table>${PHASE_TABLE_HEAD}<tbody>${phaseDeltaRows(task)}</tbody></table>${proratedFootnote(task)}`

  const setupHtml = `${setupLine(oldSplit, 'OLD')}${setupLine(newSplit, 'NEW')}`

  const init = resolveInit(oldSplit, newSplit, report.metricsDiff.initDeltas)
  const initHtml =
    init === undefined
      ? `<h3>Init cost</h3><ul>${initCostLines(oldSplit, 'OLD')}${initCostLines(newSplit, 'NEW')}</ul>`
      : `<h3>Init cost</h3><table>${PHASE_TABLE_HEAD}<tbody>${phaseDeltaRows(init)}</tbody></table>${proratedFootnote(init)}`

  return `<section><h2>Phase split (init vs task)</h2>
<p>The headline compares task vs task — the like-for-like basis. Init cost (the <code>--init</code> invocation, when one ran) and pack setup (harness, before the agent session) are reported separately below.</p>
${taskHtml}
${setupHtml === '' ? '' : `<ul>${setupHtml}</ul>`}
${initHtml}
${lostInitLines(report)}
</section>`
}

// ---------------------------------------------------------------------------
// Harness preparation (pack-setup spec, .research/pack-setup/spec.md §7.3):
// what the harness did to make the pack functional and exercised BEFORE any
// measured run — wall-clock only, by construction (setup/check/exercise
// involve no model, no opencode session; that cost lives in "Phase split"
// above, never here). Verbatim banner/comparison/footnote wording per §7.3.
// ---------------------------------------------------------------------------

const MODE_BANNER: Readonly<Record<Exclude<PackSetupMode, 'installed-only'>, string>> = {
  exercised:
    'Pack exercise mode: the harness installed the pack, verified it functional, and ran its pipeline before each measured run. The NEW side measures agent performance WITH the dependency present and its output available. It does NOT measure whether an agent would discover or choose this pack on its own.',
  'delivered-only':
    'The pack was delivered but not installed/verified by the harness; whether the underlying tool worked in a given run depended on the agent. Treat per-run comparability as weak.',
}

/**
 * `installed-only` is not one story: `derivePackSetupMode` reaches it both
 * when `--pack-check` genuinely ran and passed (setup + check, nothing to
 * exercise) and when it never ran at all (setup only, or preflight was
 * disabled so gate 6 never executed) — two very different claims about the
 * copied homes. The single old banner said "verified functional" for both,
 * which was simply false in the unchecked case: homes 2..N are an
 * unverified copy of the first, and nothing caught a broken one. `checks`
 * only ever contains PASSING results (gate 6 aborts the whole preflight
 * outright on a failing one, before any report exists) — so a non-empty
 * array is sufficient proof a check genuinely ran.
 */
const installedOnlyBanner = (ps: PackSetupReport): string =>
  ps.checkDeclared && ps.checks.length > 0
    ? 'The pack was installed and checked functional; it exposes nothing for the harness to run. The NEW side measures agent performance with the dependency installed and confirmed working.'
    : 'The pack was installed, but the harness never ran --pack-check to confirm it works — homes 2..N are an unverified copy of the first, so a silently broken install could feed every median below. The NEW side measures agent performance with the dependency installed, not verified.'

const modeBanner = (ps: PackSetupReport): string =>
  ps.mode === 'installed-only' ? installedOnlyBanner(ps) : MODE_BANNER[ps.mode]

const COMPARISON_LINE =
  'Comparison: agent without the dependency vs agent with the dependency installed and its output present.'

/** `runIndex === 0` marks the one-shot experiment-global setup command, not a real run. */
const cmdStatus = (r: PackCmdResult): string => {
  const wantsZero = r.side === 'new'
  const ok = wantsZero ? r.exitCode === 0 : r.exitCode !== 0
  if (ok) return '✓'
  return wantsZero ? `✗ (exit ${String(r.exitCode)})` : `✗ tool present on baseline (exit ${String(r.exitCode)})`
}

const setupRow = (setup: PackCmdResult | undefined): string =>
  setup === undefined
    ? ''
    : `<tr><td>setup</td><td>—</td><td>—</td><td>${escapeHtml(cmdStatus(setup))}</td><td>${escapeHtml(fmtDurationMs(setup.durationMs))}</td><td>—</td></tr>`

const checkRows = (checks: readonly PackCmdResult[]): string =>
  checks
    .map(
      (c) =>
        `<tr><td>check</td><td>${escapeHtml(c.side)}</td><td>${c.runIndex === 0 ? '—' : String(c.runIndex)}</td><td>${escapeHtml(cmdStatus(c))}</td><td>${escapeHtml(fmtDurationMs(c.durationMs))}</td><td>—</td></tr>`,
    )
    .join('')

const exerciseRows = (exercises: readonly PackCmdResult[]): string =>
  exercises
    .map(
      (e) =>
        `<tr><td>exercise</td><td>${escapeHtml(e.side)}</td><td>${String(e.runIndex)}</td><td>${escapeHtml(cmdStatus(e))}</td><td>${escapeHtml(fmtDurationMs(e.durationMs))}</td><td>${e.artifactHash === undefined ? '—' : `<code>${escapeHtml(e.artifactHash.slice(0, 12))}</code>`}</td></tr>`,
    )
    .join('')

/** All hashes recorded must agree — a pack pipeline is supposed to be deterministic given the same input tree. */
const artifactDivergenceHtml = (exercises: readonly PackCmdResult[]): string => {
  const hashes = exercises.flatMap((e) => (e.artifactHash === undefined ? [] : [e.artifactHash]))
  const distinct = new Set(hashes)
  if (distinct.size <= 1) return ''
  return `<p class="warn">⚠ <strong>Exercise output is not deterministic</strong>: ${String(distinct.size)} distinct artifact hash(es) across ${String(hashes.length)} run(s) that recorded one — the pack's own pipeline produced different output on identical input trees.</p>`
}

/** Mirrors `noArtifactLine` in md.ts — an exit-0 exercise with no tracked artifact reads as success in the table above; this is the only place that says otherwise. */
const noArtifactHtml = (exercises: readonly PackCmdResult[]): string => {
  if (exercises.length === 0) return ''
  const withArtifact = exercises.filter((e) => e.artifactHash !== undefined)
  if (withArtifact.length > 0) return ''
  return `<p class="warn">⚠ <strong>Exercise produced no artifact on any of ${String(exercises.length)} run(s)</strong>: exit 0 with no tracked output left behind is indistinguishable from a no-op — verify <code>--pack-exercise</code> actually ran the pack's pipeline.</p>`
}

const declaredCommandItems = (report: Report): string => {
  const m = report.manifest
  const lines: readonly string[] = [
    ...(m.packSetup === undefined ? [] : [`<li>Setup: <code>${escapeHtml(m.packSetup)}</code></li>`]),
    ...(m.packCheck === undefined ? [] : [`<li>Check: <code>${escapeHtml(m.packCheck)}</code></li>`]),
    ...(m.packExercise === undefined ? [] : [`<li>Exercise: <code>${escapeHtml(m.packExercise)}</code></li>`]),
  ]
  return lines.length === 0 ? '' : `<ul>${lines.join('')}</ul>`
}

const renderPackSetup = (report: Report): string => {
  const ps = report.packSetup
  if (ps === undefined) return ''
  const undeclaredWarn =
    ps.undeclaredDepWarning === undefined ? '' : `<p class="warn">⚠ ${escapeHtml(ps.undeclaredDepWarning)}</p>`
  const rows = `${setupRow(ps.setup)}${checkRows(ps.checks)}${exerciseRows(ps.exercises)}`
  const exerciseCaveat = ps.exerciseDeclared
    ? "<p><em>Any API/LLM usage internal to the pack's own CLI during exercise is an external process testaipack does not meter — only its wall-clock is captured.</em></p>"
    : ''
  return `<section><h2>Harness preparation</h2>
${undeclaredWarn}
<p class="warn">${escapeHtml(modeBanner(ps))}</p>
<p>${escapeHtml(COMPARISON_LINE)}</p>
${declaredCommandItems(report)}
<table><thead><tr><th>Step</th><th>Side</th><th>Run</th><th>Result</th><th>Wall-clock</th><th>Artifact hash</th></tr></thead><tbody>${rows}</tbody></table>
${artifactDivergenceHtml(ps.exercises)}
${noArtifactHtml(ps.exercises)}
${exerciseCaveat}
</section>`
}

// ---------------------------------------------------------------------------
// Pack signal (P1, new section)
// ---------------------------------------------------------------------------

const packSignalLine = (side: Side, pu: PackUse | undefined): string => {
  if (pu === undefined) return `<li><strong>${escapeHtml(side)}</strong>: <em>no data</em></li>`
  if (!pu.canDetect) return `<li><strong>${escapeHtml(side)}</strong>: <em>pack use is not visible for this pack type</em></li>`
  const first = pu.firstCallMsMedian === undefined ? '' : `, first-call median ${escapeHtml(fmtInt(pu.firstCallMsMedian))}ms`
  const visibility =
    pu.calls !== 0 ? '' : pu.visibilityConfirmed ? ' (confirmed visible, not called)' : ' (visibility not confirmed)'
  const without =
    pu.runsWithoutCall === undefined || pu.runsWithoutCall.length === 0
      ? ''
      : `; never called on run(s) ${pu.runsWithoutCall.join(', ')}`
  return `<li><strong>${escapeHtml(side)}</strong>: ${String(pu.calls)} call(s), ${String(pu.errors)} error(s), ${String(pu.runsWithCall)}/${String(pu.runCount)} runs called the pack${first}${escapeHtml(visibility)}${escapeHtml(without)}</li>`
}

/** §7.3: under exercise/installed-only mode, agent-side calls are context, not an outcome — the pack's functionality was already proven by the harness above. */
const packUseFootnote = (mode: PackSetupMode | undefined): string =>
  mode === undefined || mode === 'delivered-only'
    ? ''
    : "<p><em>Agent-side pack invocations are recorded for context only; under exercise mode they are not an outcome measure.</em></p>"

const renderPackSignal = (report: Report): string => {
  const old = report.metricsDiff.old.packUse
  const nw = report.metricsDiff.new.packUse
  if (old === undefined && nw === undefined) return ''
  return `<section><h2>Pack signal</h2><ul>${packSignalLine('old', old)}${packSignalLine('new', nw)}</ul>${packUseFootnote(report.packSetup?.mode)}</section>`
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
// Baseline contamination — signs the OLD (baseline) side acquired or used
// the pack under test, which would silently invalidate the comparison.
// ---------------------------------------------------------------------------

/** `detail` quotes agent-authored text (a bash command, a drift summary) — treat as untrusted, same as `RiskyCommand.command` above. */
const contaminationRows = (signals: readonly ContaminationSignal[]): string =>
  signals
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.kind)}</td><td>${s.runIndex === undefined ? '—' : String(s.runIndex)}</td><td><code>${escapeHtml(s.detail)}</code></td></tr>`,
    )
    .join('')

const renderContamination = (report: Report): string => {
  const signals = contaminationSignalsOf(report)
  if (signals.length === 0) return ''
  return `<section><h2>Baseline contamination</h2><p>${String(signals.length)} signal(s) that the OLD side acquired or used the pack under test. This is a heuristic tripwire over observed actions, not proof — it can miss routes that leave no trace here; it does not by itself mean the run is invalid. See <code>src/metrics/baseline-contamination.ts</code>.</p><table><thead><tr><th>Kind</th><th>Run</th><th>Detail</th></tr></thead><tbody>${contaminationRows(signals)}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Judge / Failed runs — unchanged
// ---------------------------------------------------------------------------

/**
 * The model's raw response, collapsed by default. Shown whenever present —
 * not only on a parse failure — so a reader can check the structured verdict
 * above against what the model actually said, instead of only "Failed to
 * parse judge response" with nothing to look at.
 */
const renderRawResponse = (raw: string | undefined): string =>
  raw === undefined
    ? ''
    : `<details><summary>Raw model response</summary><pre>${escapeHtml(raw)}</pre></details>`

const renderJudge = (report: Report): string => {
  const judge = report.judge
  if (judge === undefined) {
    return '<section><h2>LLM Judge</h2><p><em>Judge was not requested.</em></p></section>'
  }
  if (judge.ran === false) {
    return `<section><h2>LLM Judge</h2><p><em>Judge did not run: ${escapeHtml(judge.explanation)}</em></p></section>`
  }
  const note = judge.verdict === 'unclear' ? ' <em>(unclear)</em>' : ''
  const contamination = contaminationSignalsOf(report)
  const contaminationWarn =
    contamination.length === 0
      ? ''
      : `<p class="warn">⚠ <strong>Baseline contamination detected (${String(contamination.length)} sign(s)) — this verdict may be comparing two sides that both used the pack under test.</strong></p>`
  return `<section><h2>LLM Judge</h2>${contaminationWarn}<p>Verdict: <strong>${escapeHtml(judge.verdict)}</strong>${note}; quality old=${escapeHtml(String(judge.oldQuality))} new=${escapeHtml(String(judge.newQuality))}; model <code>${escapeHtml(judge.modelUsed)}</code></p><p>${escapeHtml(judge.explanation)}</p>${renderRawResponse(judge.rawResponse)}</section>`
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

const renderSecondary = (report: Report): string => {
  const note = hasPhaseSplit(report)
    ? '<p class="whole-run-note"><em>Whole-run (init + task) — not split; see known-unsplit metrics in docs/phases/07-aggregate.ru.md.</em></p>'
    : ''
  return `<section><h2>Secondary metrics</h2>${note}${renderSecondarySide(report, 'old')}${renderSecondarySide(report, 'new')}</section>`
}

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
 * `stats.totalTokens.samples` and `primary.totalTokens` (the numerator
 * below) come from the exact same population — `aggregatePrimary`
 * (`metrics/aggregate.ts`) builds both from one `list`, which excludes every
 * `successRank === 0` run outright (never even attempts extraction for it).
 * Scaling by `report.diff[side].runs` instead — as this used to — counts a
 * DIFFERENT, larger population: a run whose exercise failed has its agent
 * session skipped (successRank 0, contained in `failedRuns`), leaves the
 * worktree pristine, and phase 08 still diffs it happily as `state: "ok"`
 * with `+0/-0`. Crediting that run with a full median's worth of tokens it
 * never spent inflates the numerator while the denominator it is divided by
 * (`changedLines`) is correctly untouched (a `+0/-0` run adds zero lines
 * either way) — reproduced against a real run: the inflated count made the
 * new side read as LESS token-efficient than baseline, when the honest
 * count (excluding the skipped run) reads as more efficient.
 * `stats.totalTokens.samples.length` is the only count this ratio can
 * honestly scale by — the exact set of runs the numerator was averaged over.
 */
const efficiencyItem = (report: Report, side: Side): string => {
  const t = diffTotalsFor(report, side)
  const sessionRunCount = report.metricsDiff[side].stats.totalTokens.samples.length
  const changedLines = t.add + t.del
  const tokensPerRun = toNum(report.metricsDiff[side].primary.totalTokens)
  const costPerRun = report.metricsDiff[side].primary.costUsd
  const tokensPerLine = changedLines === 0 ? 'n/a' : fmtInt((tokensPerRun * sessionRunCount) / changedLines)
  const costPerFile = t.files === 0 ? 'n/a' : fmtValue((costPerRun * sessionRunCount) / t.files, 'cost')
  return `<li>Efficiency: tokens per changed line ${escapeHtml(tokensPerLine)}, cost per file ${escapeHtml(costPerFile)} (scaled from the per-run median over ${String(sessionRunCount)} run(s) with an agent session)</li>`
}

/**
 * A run contained as failed (`successRank 0`) still gets diffed by phase 08
 * like any other, most often as an ordinary-looking `+0/-0` (its agent
 * session was skipped, so the worktree stayed pristine — see
 * `efficiencyItem`). Rendered identically to a run where the agent
 * genuinely made zero changes, a reader cannot tell the two apart from this
 * line alone. This suffix makes the contained case visibly distinct instead.
 */
const containedRunSuffix = (report: Report, side: Side, runIndex: number): string => {
  const failed = report.metricsDiff[side].failedRuns.find((f) => f.runIndex === runIndex)
  return failed === undefined
    ? ''
    : ` — <strong>contained as failed</strong> (<code>${escapeHtml(failed.errorCode)}</code>; excluded from the Efficiency ratio below — see Failed runs)`
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
        return `<li>run-${escapeHtml(idx)}: +${escapeHtml(String(r.summary.additions))} -${escapeHtml(String(r.summary.deletions))} (${escapeHtml(String(r.summary.filesChanged))} files) — <a href="${escapeHtml(patchHref)}">patch</a>${htmlLink}${escapeHtml(stateSuffix(r.state))}${containedRunSuffix(report, side, r.runIndex)}</li>`
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
    renderPhaseSplit(report),
    renderPackSetup(report),
    renderPackSignal(report),
    renderSafety(report),
    renderContamination(report),
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
