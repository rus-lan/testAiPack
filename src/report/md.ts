/**
 * Report: md — renders the final report as human-readable Markdown.
 *
 * Pure function: takes a Report, returns a Markdown string. Designed to be
 * readable directly in stdout, not a JSON dump wrapped in code fences.
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
  TimelineEvent,
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

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/** A fence at least one backtick longer than any run already in `content`, so the raw text can never break out of its own code block. */
const safeFence = (content: string): string => {
  const runs = content.match(/`+/g) ?? []
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * The model's raw response, collapsed by default. Shown whenever present —
 * not only on a parse failure — so a reader can check the structured verdict
 * above against what the model actually said, instead of only "Failed to
 * parse judge response" with nothing to look at.
 */
const renderRawResponse = (raw: string | undefined): readonly string[] => {
  if (raw === undefined) return []
  const fence = safeFence(raw)
  return ['', '<details>', '<summary>Raw model response</summary>', '', `${fence}text`, raw, fence, '', '</details>']
}

/**
 * Wraps `text` in a Markdown inline code span that carries a literal
 * backtick through byte-identical — this quotes an agent's actual command or
 * a contamination `detail`, where substituting or escaping a character would
 * misrepresent evidence a reader may copy, search for, or judge severity by.
 * Per CommonMark: the fence must be longer than the longest backtick run
 * already inside the text, and a single space pads both ends when the text
 * itself starts or ends with a backtick — otherwise the fence and the text's
 * own edge backtick would read as one longer run and the span would not
 * close where intended.
 */
const codeSpan = (text: string): string => {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0)
  const fence = '`'.repeat(longest + 1)
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text
  return `${fence}${padded}${fence}`
}

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
  if (typeof raw !== 'string') return '**Init side:** unknown (report predates --init-side)'
  if (raw === 'both') {
    return '**Init side:** both — sent to both sides; this is how a baseline can pick up the pack under test'
  }
  // One session/export per run — the init call's tokens/steps/tool-calls/wall-clock
  // land entirely on the side that received it, inflating that side's numbers
  // relative to the other. Honest cost of a scoped init, not noise, but only if
  // the reader knows to expect it. When the split exists, "Phase split"
  // already separates that cost out — point there instead of just naming the
  // asymmetry.
  const tail = hasPhaseSplit(report)
    ? 'metrics below are split — the headline compares task vs task; init cost is reported separately'
    : 'that asymmetry is expected, not a measurement error'
  return `**Init side:** ${raw} — only the ${raw.toUpperCase()} side's metrics carry the init call's cost (tokens, steps, tool calls, wall-clock); ${tail}`
}

/**
 * `--pack-hint` changes what the agent was told, so it changes what the
 * comparison measures — a reader needs to see both that a hint ran and what
 * it said. "Sent identically to both sides" is stated plainly rather than
 * implied: unlike `--init`, there is no side-targeting flag for the hint (see
 * `effectiveTaskPrompt` in `06-run-side.ts`), so this line is always true.
 */
const hintLine = (report: Report): string | undefined => {
  const hint = report.manifest.packHint
  if (hint === undefined || hint === '') return undefined
  return `**Pack hint:** sent identically to both sides — ${codeSpan(escapeCell(hint))}`
}

const renderHeader = (report: Report): string => {
  const packLine = report.manifest.packRef
    ? report.manifest.packRef
    : '_smoke-test (no pack)_'
  const warn = versionDriftWarning(report)
  const initLine = initSideLine(report)
  const hint = hintLine(report)
  return [
    `# testaipack report: ${report.manifest.runId}`,
    '',
    `**Repo:** ${report.manifest.repoUrl}`,
    `**Pack:** ${packLine}`,
    `**Runs:** ${String(report.manifest.runs)} per side`,
    `**Timestamp:** ${report.manifest.timestamp}`,
    `**Opencode version:** ${report.manifest.opencodeVersion}`,
    ...(initLine === undefined ? [] : [initLine]),
    ...(hint === undefined ? [] : [hint]),
    ...(warn === undefined ? [] : ['', warn]),
  ].join('\n')
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
    ? '> ⚠ **Pack was never invoked on the NEW side — preflight confirmed it was visible, so the model chose not to call it. Deltas compare baseline vs baseline.**'
    : '> ⚠ **Pack was never invoked on the NEW side — deltas compare baseline vs baseline.**'
}

/** Companion to `packNoopWarning` for exercised mode: informational, not a warning — zero direct calls is the expected shape here, not a red flag. */
const packExercisedZeroCallsNote = (report: Report): string | undefined => {
  const pu = report.metricsDiff.new.packUse
  if (pu === undefined || !pu.canDetect || pu.calls !== 0) return undefined
  if (report.packSetup?.mode !== 'exercised') return undefined
  return '_Pack was never called directly on the NEW side — `--pack-exercise` already ran its pipeline before the agent started, so there was nothing left to trigger. Expected under exercised mode, not a defect; see Harness preparation._'
}

const riskyCommandAlert = (report: Report): string | undefined => {
  const n = (report.metricsDiff.old.riskyCommands?.length ?? 0) + (report.metricsDiff.new.riskyCommands?.length ?? 0)
  return n === 0 ? undefined : `> ⚠ ${String(n)} risky command(s) detected — see Safety`
}

const contaminationSignalsOf = (report: Report): readonly ContaminationSignal[] =>
  report.metricsDiff.old.contaminationSignals ?? []

const contaminationAlert = (report: Report): string | undefined => {
  const n = contaminationSignalsOf(report).length
  return n === 0
    ? undefined
    : `> ⚠ **Baseline contamination: the OLD side shows ${String(n)} sign(s) of having acquired or used the pack under test — deltas below may not compare a clean baseline against a treatment.** See Baseline contamination.`
}

const renderSummary = (report: Report): string => {
  const { entries, basis } = deltaEntriesFor(report.metricsDiff)
  const bucket = (heading: string, es: readonly DeltaEntry[]): readonly string[] => {
    const rows =
      es.length === 0
        ? ['- _none_']
        : es.map((e) => `- **${e.label}**: ${fmtSigned(e.d.absolute, e.kind)} (${fmtPct(e.d.percent)}) — ${verdictFor(e.d)}`)
    return [heading, ...rows]
  }
  const improvements = entries.filter((e) => e.d.better === 'better')
  const regressions = entries.filter((e) => e.d.better === 'worse')
  const neutral = entries.filter((e) => e.d.better === 'neutral' || e.d.better === 'context-dependent')
  const alerts = [packNoopWarning(report), riskyCommandAlert(report), contaminationAlert(report)].filter(
    (s): s is string => s !== undefined,
  )
  const exercisedNote = packExercisedZeroCallsNote(report)
  const basisLine =
    basis === 'task'
      ? ['_Basis: task phase only (init excluded); init cost shown in "Init cost" below._', '']
      : []
  return [
    '## Summary',
    '',
    ...(alerts.length === 0 ? [] : [...alerts, '']),
    ...(exercisedNote === undefined ? [] : [exercisedNote, '']),
    report.summary.headlineResult,
    '',
    ...basisLine,
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
  return ['## Primary metrics — total (init + task)', '', ...warn, ...header, ...rows, '', ...renderStability(report)].join('\n')
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
// Phase split (metric-split spec §5.7): task-vs-task like-for-like table,
// init cost (cost figure when one-sided, delta when two-sided), setup
// wall-clock. Absent entirely when neither side ever ran a split-eligible
// export.
// ---------------------------------------------------------------------------

const PHASE_TABLE_HEADER = [
  '| Metric | Old (median) | Old [min–max] | New (median) | New [min–max] | Δ | Δ% | Significant | Verdict |',
  '|---|---|---|---|---|---|---|---|---|',
]

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

/** Only defined when BOTH sides ran init (spec §4.1: `initDeltas` present iff `runsWithInit > 0` on both) — never a one-sided delta. */
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

const phaseDeltaRows = (r: ResolvedPhaseDelta): readonly string[] =>
  PHASE_METRICS.map((m) => {
    const d = r.deltas[m.key]
    const oldMark = m.key === 'costUsd' && r.oldProrated ? '~' : ''
    const newMark = m.key === 'costUsd' && r.newProrated ? '~' : ''
    const oldV = `${oldMark}${fmtValue(r.oldSlice[m.key], m.kind)}`
    const newV = `${newMark}${fmtValue(r.newSlice[m.key], m.kind)}`
    return `| ${m.label} | ${oldV} | ${phaseSpreadCell(r.oldStats, m)} | ${newV} | ${phaseSpreadCell(r.newStats, m)} | ${fmtSigned(d.absolute, m.kind)} | ${fmtPct(d.percent)} | ${sigLabel(d)} | ${verdictFor(d)} |`
  })

const proratedFootnote = (r: ResolvedPhaseDelta): readonly string[] =>
  r.oldProrated || r.newProrated
    ? ['', '_~ cost prorated from the session total by token share — derived, not measured._']
    : []

const setupLine = (split: SidePhaseSplit | undefined, sideLabel: string): readonly string[] =>
  split?.setup === undefined
    ? []
    : [`- **${sideLabel}**: pack setup (harness, no model call) — median ${fmtInt(split.setup.wallClockMs)}ms`]

/** One-sided (or no-init) rendering: a cost figure only, never a delta. */
const initCostLines = (split: SidePhaseSplit | undefined, sideLabel: string): readonly string[] => {
  if (split?.init === undefined || split.initStats === undefined) {
    return [`- **${sideLabel}**: no init phase`]
  }
  const init = split.init
  const stats = split.initStats
  const metricsLine = PHASE_METRICS.map((m) => {
    const mark = m.key === 'costUsd' && split.costProrated === true ? '~' : ''
    const stat = stats[m.key]
    return `${m.label} ${mark}${fmtValue(init[m.key], m.kind)} [${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}]`
  }).join(', ')
  return [`- **${sideLabel}** (${String(split.runsWithInit)} run(s) with init): ${metricsLine}`]
}

const lostInitLines = (report: Report): readonly string[] => {
  const oldN = report.metricsDiff.old.phaseSplit?.runsWithLostInit ?? 0
  const newN = report.metricsDiff.new.phaseSplit?.runsWithLostInit ?? 0
  return [
    ...(oldN === 0
      ? []
      : [`> ⚠ OLD: ${String(oldN)} run(s) ran --init but the export lost the init session — init cost unmeasured.`]),
    ...(newN === 0
      ? []
      : [`> ⚠ NEW: ${String(newN)} run(s) ran --init but the export lost the init session — init cost unmeasured.`]),
  ]
}

const renderPhaseSplit = (report: Report): string => {
  const oldSplit = report.metricsDiff.old.phaseSplit
  const newSplit = report.metricsDiff.new.phaseSplit
  if (oldSplit === undefined && newSplit === undefined) return ''

  const task = resolveTask(oldSplit, newSplit, report.metricsDiff.taskDeltas)
  const taskTable: readonly string[] =
    task === undefined
      ? []
      : ['### Task phase (like-for-like)', '', ...PHASE_TABLE_HEADER, ...phaseDeltaRows(task), ...proratedFootnote(task)]

  const setupLines: readonly string[] = [...setupLine(oldSplit, 'OLD'), ...setupLine(newSplit, 'NEW')]

  const init = resolveInit(oldSplit, newSplit, report.metricsDiff.initDeltas)
  const initSection: readonly string[] =
    init === undefined
      ? ['### Init cost', '', ...initCostLines(oldSplit, 'OLD'), ...initCostLines(newSplit, 'NEW')]
      : ['### Init cost', '', ...PHASE_TABLE_HEADER, ...phaseDeltaRows(init), ...proratedFootnote(init)]

  const lost = lostInitLines(report)

  return [
    '## Phase split (init vs task)',
    '',
    'The headline compares task vs task — the like-for-like basis. Init cost (the `--init` invocation, when one ran) and pack setup (harness, before the agent session) are reported separately below.',
    '',
    ...taskTable,
    '',
    ...(setupLines.length === 0 ? [] : [...setupLines, '']),
    ...initSection,
    ...(lost.length === 0 ? [] : ['', ...lost]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Harness preparation (pack-setup spec, .research/pack-setup/spec.md §7.3):
// what the harness did to make the pack functional and exercised BEFORE any
// measured run — wall-clock only, by construction (setup/check/exercise
// involve no model, no opencode session; that cost lives in "Phase split"
// above, never here). Verbatim banner/comparison/footnote wording per §7.3 —
// this is the sentence a reader uses to know what the numbers mean, so the
// wording is not paraphrased.
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

const setupRow = (setup: PackCmdResult | undefined): readonly string[] =>
  setup === undefined
    ? []
    : [`| setup | — | — | ${cmdStatus(setup)} | ${fmtDurationMs(setup.durationMs)} | — |`]

const checkRows = (checks: readonly PackCmdResult[]): readonly string[] =>
  checks.map((c) => `| check | ${c.side} | ${c.runIndex === 0 ? '—' : String(c.runIndex)} | ${cmdStatus(c)} | ${fmtDurationMs(c.durationMs)} | — |`)

const exerciseRows = (exercises: readonly PackCmdResult[]): readonly string[] =>
  exercises.map(
    (e) =>
      `| exercise | ${e.side} | ${String(e.runIndex)} | ${cmdStatus(e)} | ${fmtDurationMs(e.durationMs)} | ${e.artifactHash === undefined ? '—' : escapeCell(e.artifactHash.slice(0, 12))} |`,
  )

/** All hashes recorded must agree — a pack pipeline is supposed to be deterministic given the same input tree. */
const artifactDivergenceLine = (exercises: readonly PackCmdResult[]): string | undefined => {
  const hashes = exercises.flatMap((e) => (e.artifactHash === undefined ? [] : [e.artifactHash]))
  const distinct = new Set(hashes)
  if (distinct.size <= 1) return undefined
  return `> ⚠ **Exercise output is not deterministic**: ${String(distinct.size)} distinct artifact hash(es) across ${String(hashes.length)} run(s) that recorded one — the pack's own pipeline produced different output on identical input trees.`
}

/**
 * An exercise that exits 0 but leaves no tracked artifact behind is
 * indistinguishable from a no-op — the table row above renders a plain ✓
 * with an empty artifact-hash column, which reads as success with nothing
 * to hint otherwise. The reader who most needs this warning is the one
 * deciding whether the NEW side's "after" measurement means anything.
 */
const noArtifactLine = (exercises: readonly PackCmdResult[]): string | undefined => {
  if (exercises.length === 0) return undefined
  const withArtifact = exercises.filter((e) => e.artifactHash !== undefined)
  if (withArtifact.length > 0) return undefined
  return `> ⚠ **Exercise produced no artifact on any of ${String(exercises.length)} run(s)**: exit 0 with no tracked output left behind is indistinguishable from a no-op — verify \`--pack-exercise\` actually ran the pack's pipeline.`
}

const declaredCommandLines = (report: Report): readonly string[] => {
  const m = report.manifest
  const lines: readonly string[] = [
    ...(m.packSetup === undefined ? [] : [`- Setup: ${codeSpan(escapeCell(m.packSetup))}`]),
    ...(m.packCheck === undefined ? [] : [`- Check: ${codeSpan(escapeCell(m.packCheck))}`]),
    ...(m.packExercise === undefined ? [] : [`- Exercise: ${codeSpan(escapeCell(m.packExercise))}`]),
  ]
  return lines
}

const renderPackSetup = (report: Report): string => {
  const ps = report.packSetup
  if (ps === undefined) return ''
  const commands = declaredCommandLines(report)
  const exerciseCaveat: readonly string[] = ps.exerciseDeclared
    ? [
        "_Any API/LLM usage internal to the pack's own CLI during exercise is an external process testaipack does not meter — only its wall-clock is captured._",
      ]
    : []
  const undeclaredWarn = ps.undeclaredDepWarning === undefined ? [] : [`> ⚠ ${ps.undeclaredDepWarning}`, '']
  const divergence = artifactDivergenceLine(ps.exercises)
  const noArtifact = noArtifactLine(ps.exercises)
  const rows = [...setupRow(ps.setup), ...checkRows(ps.checks), ...exerciseRows(ps.exercises)]
  return [
    '## Harness preparation',
    '',
    ...undeclaredWarn,
    `> ${modeBanner(ps)}`,
    '',
    COMPARISON_LINE,
    '',
    ...(commands.length === 0 ? [] : [...commands, '']),
    '| Step | Side | Run | Result | Wall-clock | Artifact hash |',
    '|---|---|---|---|---|---|',
    ...rows,
    ...(divergence === undefined ? [] : ['', divergence]),
    ...(noArtifact === undefined ? [] : ['', noArtifact]),
    ...(exerciseCaveat.length === 0 ? [] : ['', ...exerciseCaveat]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Pack signal (P1, new section)
// ---------------------------------------------------------------------------

const packSignalLine = (side: Side, pu: PackUse | undefined): string => {
  if (pu === undefined) return `- **${side}**: _no data_`
  if (!pu.canDetect) return `- **${side}**: _pack use is not visible for this pack type_`
  const first = pu.firstCallMsMedian === undefined ? '' : `, first-call median ${fmtInt(pu.firstCallMsMedian)}ms`
  const visibility =
    pu.calls !== 0
      ? ''
      : pu.visibilityConfirmed
        ? ' (confirmed visible, not called)'
        : ' (visibility not confirmed)'
  const without =
    pu.runsWithoutCall === undefined || pu.runsWithoutCall.length === 0
      ? ''
      : `; never called on run(s) ${pu.runsWithoutCall.join(', ')}`
  return `- **${side}**: ${String(pu.calls)} call(s), ${String(pu.errors)} error(s), ${String(pu.runsWithCall)}/${String(pu.runCount)} runs called the pack${first}${visibility}${without}`
}

/** §7.3: under exercise/installed-only mode, agent-side calls are context, not an outcome — the pack's functionality was already proven by the harness above. */
const packUseFootnote = (mode: PackSetupMode | undefined): string | undefined =>
  mode === undefined || mode === 'delivered-only'
    ? undefined
    : '_Agent-side pack invocations are recorded for context only; under exercise mode they are not an outcome measure._'

const renderPackSignal = (report: Report): string => {
  const old = report.metricsDiff.old.packUse
  const nw = report.metricsDiff.new.packUse
  if (old === undefined && nw === undefined) return ''
  const footnote = packUseFootnote(report.packSetup?.mode)
  return [
    '## Pack signal',
    '',
    packSignalLine('old', old),
    packSignalLine('new', nw),
    ...(footnote === undefined ? [] : ['', footnote]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Safety (P2, new section)
// ---------------------------------------------------------------------------

const riskyRows = (side: string, list: readonly RiskyCommand[]): readonly string[] =>
  list.map(
    (r) =>
      `| ${side} | ${String(r.runIndex)} | ${codeSpan(escapeCell(r.command))} | ${String(r.completed)} | ${r.exitCode === undefined ? '—' : String(r.exitCode)} |`,
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
// Baseline contamination — signs the OLD (baseline) side acquired or used
// the pack under test, which would silently invalidate the comparison.
// ---------------------------------------------------------------------------

/** `detail` quotes agent-authored text (a bash command, a drift summary) — treat as untrusted, same as `RiskyCommand.command` above. */
const contaminationRows = (signals: readonly ContaminationSignal[]): readonly string[] =>
  signals.map(
    (s) =>
      `| ${escapeCell(s.kind)} | ${s.runIndex === undefined ? '—' : String(s.runIndex)} | ${codeSpan(escapeCell(s.detail))} |`,
  )

const renderContamination = (report: Report): string => {
  const signals = contaminationSignalsOf(report)
  if (signals.length === 0) return ''
  const header = ['| Kind | Run | Detail |', '|---|---|---|']
  return [
    '## Baseline contamination',
    '',
    `${String(signals.length)} signal(s) that the OLD side acquired or used the pack under test. This is a heuristic tripwire over observed actions, not proof — it can miss routes that leave no trace here; it does not by itself mean the run is invalid. See \`src/metrics/baseline-contamination.ts\`.`,
    '',
    ...header,
    ...contaminationRows(signals),
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
  const wholeRunNote = hasPhaseSplit(report)
    ? ['', '_Whole-run (init + task) — not split; see known-unsplit metrics in `docs/phases/07-aggregate.ru.md`._']
    : []
  return ['## Secondary metrics', ...wholeRunNote, '', ...renderSide('old'), '', ...renderSide('new')].join('\n')
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
  const contamination = contaminationSignalsOf(report)
  const contaminationWarn =
    contamination.length === 0
      ? []
      : [
          `> ⚠ **Baseline contamination detected (${String(contamination.length)} sign(s)) — this verdict may be comparing two sides that both used the pack under test.**`,
          '',
        ]
  return [
    '## LLM Judge',
    '',
    ...contaminationWarn,
    `- Verdict: **${j.verdict}**${note}`,
    `- Quality: old=${String(j.oldQuality)}, new=${String(j.newQuality)}`,
    `- Model: \`${j.modelUsed}\``,
    `- Explanation: ${j.explanation}`,
    ...renderRawResponse(j.rawResponse),
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
 * A run contained as failed (`successRank 0` — an exercise failure, crash,
 * timeout, ...) still gets diffed by phase 08 like any other, most often as
 * an ordinary-looking `+0/-0` (its agent session was skipped, so the
 * worktree stayed pristine — see `efficiencyLine`). Rendered identically to
 * a run where the agent genuinely made zero changes, a reader cannot tell
 * the two apart from this line alone. This suffix makes the contained case
 * visibly distinct instead.
 */
const containedRunSuffix = (report: Report, side: Side, runIndex: number): string => {
  const failed = report.metricsDiff[side].failedRuns.find((f) => f.runIndex === runIndex)
  return failed === undefined
    ? ''
    : ` — **contained as failed** (\`${failed.errorCode}\`; excluded from the Efficiency ratio below — see Failed runs)`
}

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
const efficiencyLine = (report: Report, side: Side): string => {
  const t = diffTotalsFor(report, side)
  const sessionRunCount = report.metricsDiff[side].stats.totalTokens.samples.length
  const changedLines = t.add + t.del
  const tokensPerRun = toNum(report.metricsDiff[side].primary.totalTokens)
  const costPerRun = report.metricsDiff[side].primary.costUsd
  const tokensPerLine = changedLines === 0 ? 'n/a' : fmtInt((tokensPerRun * sessionRunCount) / changedLines)
  const costPerFile = t.files === 0 ? 'n/a' : fmtValue((costPerRun * sessionRunCount) / t.files, 'cost')
  return `  - Efficiency: tokens per changed line ${tokensPerLine}, cost per file ${costPerFile} (scaled from the per-run median over ${String(sessionRunCount)} run(s) with an agent session)`
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
      return `  - run-${String(r.runIndex)}: +${String(r.summary.additions)} -${String(r.summary.deletions)} (${String(r.summary.filesChanged)} files) — [patch](${patch})${html}${stateMarker(r.state)}${containedRunSuffix(report, side, r.runIndex)}`
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
    renderPhaseSplit(report),
    renderPackSetup(report),
    renderPackSignal(report),
    renderSafety(report),
    renderContamination(report),
    renderSecondary(report),
    renderFailures(report),
    renderJudge(report),
    renderTimeline(report),
    renderDiff(report),
  ]
    .filter((s) => s !== '')
    .join('\n\n---\n\n') + '\n'
