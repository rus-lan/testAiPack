/**
 * Report: md — renders the final report as human-readable Markdown.
 *
 * Pure function: takes a Report, returns a Markdown string. Designed to be
 * readable directly in stdout, not a JSON dump wrapped in code fences.
 *
 * N-way layout (baseline vs 1..N-1 variants) follows
 * `.research/n-way-variants/03-hard-problems.md` §4.1 — metric-major long
 * tables (one row per metric/variant, baseline row first per group, marked
 * `*`), per-variant summary/stability/secondary/diff blocks, and the §1.3
 * multiple-comparisons caveat under the primary table.
 *
 * @see docs/phases/11-report-render.ru.md
 * @see contract/phases/11-report-render.tsp
 */
import type {
  AggregateStats,
  DiffResult,
  DiffRunResult,
  MetricDelta,
  MetricsReport,
  PackCmdResult,
  PackPrep,
  PackSetupMode,
  PhaseSlice,
  PhaseSliceStats,
  Report,
  SecondaryMetrics,
  TimelineEvent,
  ToolStat,
  VariantAggregates,
  VariantPrep,
  VariantSpec,
  VerifyStats,
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
import type { DeltaEntry, MetricKind, PhaseMeta, PrimaryMeta } from './format.js'
import { STALL_THRESHOLD_MS } from '../metrics/aggregate.js'
import { effectiveOf } from '../phases/00-cli-parse.js'

const escapeCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/** Russian count agreement: 1 → `one`, 2-4 → `few`, 0/5-20/... → `many` (standard mod-10/mod-100 rule; same pattern as `cli/summary.ts`). */
const pluralRu = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

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
  return ['', '<details>', '<summary>Исходный ответ модели</summary>', '', `${fence}text`, raw, fence, '', '</details>']
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

const quote = (s: string): string => `«${escapeCell(s)}»`

const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Interleaves per-variant blocks with a blank line, skipping nothing (callers already filter absent variants). */
const joinBlocks = (blocks: readonly (readonly string[])[]): readonly string[] =>
  blocks.flatMap((b, i) => (i === 0 ? b : ['', ...b]))

const variantAggFor = (metrics: MetricsReport, name: string): VariantAggregates | undefined =>
  metrics.variants.find((v) => v.variant === name)

/**
 * Baseline first, others in their original config order after it —
 * 03-hard-problems.md §4.1: "baseline row first per metric group". The
 * baseline is only the DEFAULT first entry; `--baseline` is a real flag
 * that can point at any variant without reordering `manifest.variants`, so
 * every per-metric-group table (primary, task, init) and Stability must
 * resolve the baseline's position explicitly rather than assume `[0]`.
 */
const orderedForTables = (report: Report): readonly VariantSpec[] => {
  const baseline = report.manifest.variants.find((v) => v.name === report.metrics.baseline)
  if (baseline === undefined) return report.manifest.variants
  return [baseline, ...report.manifest.variants.filter((v) => v.name !== baseline.name)]
}

// ---------------------------------------------------------------------------
// Header (variants line, init/hint disclosure, opencode version drift)
// ---------------------------------------------------------------------------

const versionDriftWarning = (report: Report): string | undefined => {
  const versions = report.metrics.variants.flatMap((v) => v.opencodeVersions ?? [])
  if (versions.length === 0) return undefined
  const manifestVersion = report.manifest.opencodeVersion
  if (!versions.some((v) => v !== manifestVersion)) return undefined
  const distinct = [...new Set(versions)].sort()
  return `> ⚠ версия opencode расходится с manifest: manifest указывает ${manifestVersion}, в запусках использовалась ${distinct.join(', ')} (manifest мог зафиксировать HOST-бинарник — см. первопричину ниже)`
}

/**
 * `pure` is D1: `variant.pure ?? variant.packs.length === 0` — the field
 * defaults to true for a packless variant, not to `false`/undefined. Native
 * variant mode stores config objects verbatim (phase 00), so a packless
 * variant with no explicit `pure` still runs with `OPENCODE_PURE` set even
 * though `v.pure` itself is `undefined` here.
 */
const isPure = (v: VariantSpec): boolean => v.pure ?? v.packs.length === 0

const variantDescriptor = (report: Report, v: VariantSpec): string => {
  const star = v.name === report.metrics.baseline ? '*' : ''
  const packsPart = v.packs.length === 0 ? 'без пакетов' : `пакеты: ${v.packs.join(', ')}`
  const pureSuffix = isPure(v) ? ', чистый' : ''
  return `${v.name}${star} (${packsPart}${pureSuffix})`
}

const variantsLine = (report: Report): string =>
  `**Варианты:** ${report.manifest.variants.map((v) => variantDescriptor(report, v)).join(', ')}`

/**
 * Groups variants by their init source: falling back to the global
 * `--init`, declaring their own, or explicitly disabling it (`init: ''`,
 * D7) — mirrors §4.1's header sample (`base, graphify — global init;
 * ast-grep — own init ("...")`).
 */
const initDisclosureLine = (report: Report): string | undefined => {
  const variants = report.manifest.variants
  const globalGroup = variants.filter((v) => v.init === undefined && report.manifest.init !== undefined)
  const ownVariants = variants.filter((v) => v.init !== undefined && v.init !== '')
  const disabledVariants = variants.filter((v) => v.init === '')
  if (globalGroup.length === 0 && ownVariants.length === 0 && disabledVariants.length === 0) return undefined
  const parts: readonly string[] = [
    ...(globalGroup.length === 0 ? [] : [`${globalGroup.map((v) => v.name).join(', ')} — глобальный init`]),
    ...ownVariants.map((v) => `${v.name} — свой init (${quote(v.init ?? '')})`),
    ...(disabledVariants.length === 0 ? [] : [`${disabledVariants.map((v) => v.name).join(', ')} — init отключён`]),
  ]
  return `**Init:** ${parts.join('; ')}`
}

/**
 * A per-variant hint/prompt changes what the comparison measures, unlike
 * the old two-sided harness where both were always identical — the
 * "variants differ" suffix is mandatory whenever any two variants end up
 * with a different effective value (03-hard-problems.md §4.1). Resolution
 * reuses `effectiveOf` (00-cli-parse.ts, D7): an explicit `''` disables the
 * inherited global outright rather than falling back to it — a naive
 * `own || global` would misclassify a disabled override as "uses the
 * global" and silently fail to flag a real divergence.
 */
const groupedDisclosureLine = (report: Report, label: string, key: 'hint' | 'prompt'): string | undefined => {
  const named = report.manifest.variants.map((v) => ({ name: v.name, value: effectiveOf(v, report.manifest[key], key) }))
  const withValue = named.filter(
    (e): e is { readonly name: string; readonly value: string } => e.value !== undefined && e.value !== '',
  )
  if (withValue.length === 0) return undefined
  const distinctSet = [...new Set(withValue.map((e) => e.value))]
  const parts = distinctSet.map(
    (value) => `${withValue.filter((e) => e.value === value).map((e) => e.name).join(', ')} — ${quote(value)}`,
  )
  const allValues = new Set(named.map((e) => e.value ?? ''))
  const differSuffix = allValues.size > 1 ? ' (варианты отличаются — сравнение измеряет промпт и пакет вместе)' : ''
  return `**${label}:** ${parts.join('; ')}${differSuffix}`
}

const hintDisclosureLine = (report: Report): string | undefined => groupedDisclosureLine(report, 'Подсказка', 'hint')
const promptDisclosureLine = (report: Report): string | undefined => groupedDisclosureLine(report, 'Промпт', 'prompt')

const renderHeader = (report: Report): string => {
  const warn = versionDriftWarning(report)
  const initLine = initDisclosureLine(report)
  const hintLine = hintDisclosureLine(report)
  const promptLine = promptDisclosureLine(report)
  return [
    `# Отчёт testaipack: ${report.manifest.runId}`,
    '',
    `**Репозиторий:** ${report.manifest.repoUrl}`,
    variantsLine(report),
    `**Запуски:** ${String(report.manifest.runs)} на вариант`,
    `**Время:** ${report.manifest.timestamp}`,
    `**Версия opencode:** ${report.manifest.opencodeVersion}`,
    ...(promptLine === undefined ? [] : [promptLine]),
    ...(initLine === undefined ? [] : [initLine]),
    ...(hintLine === undefined ? [] : [hintLine]),
    ...(warn === undefined ? [] : ['', warn]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Summary: alerts, headline (§1.4), per-variant improvement/regression/
// neutral buckets.
// ---------------------------------------------------------------------------

const allFailedWarning = (report: Report): string | undefined =>
  report.metrics.allFailed ? '> ⚠ **Все варианты провалились — сравнение недоступно.**' : undefined

/**
 * A pair is broken when either side produced zero samples (§1.2:
 * `pairIncomplete`) — the delta columns still render (absolute/percent),
 * forced non-significant, and read as an unremarkable "no difference"
 * unless flagged. `allFailed` already covers the all-N-empty case with its
 * own banner; this is the narrower "only this one variant" case.
 */
const pairIncompleteWarnings = (report: Report): readonly string[] =>
  report.metrics.allFailed
    ? []
    : report.metrics.deltas
        .filter((d) => d.pairIncomplete)
        .map(
          (d) =>
            `> ⚠ **${d.variant} — у базового варианта или у этого варианта получено ноль замеров; строка дельты ниже не является содержательным сравнением.**`,
        )

/**
 * True only when `pack` genuinely ran `--pack-exercise` FOR THIS VARIANT:
 * pack-level `mode === 'exercised'` is set once per pack (across every
 * variant declaring it), but the exercise command itself is a per-variant
 * field (`VariantSpec.exercise`) — a second variant sharing the same pack
 * without declaring its own exercise never ran one, so its zero direct
 * calls is a real noop, not the expected exercised-mode shape. The
 * evidence for "genuinely ran" is `report.prep.variants[name].exercises`
 * recording at least one successful (`exitCode === 0`) run.
 */
const variantExercisedFor = (report: Report, variantName: string, packName: string): boolean => {
  const pack = report.prep?.packs.find((p) => p.pack === packName)
  if (pack === undefined || pack.mode !== 'exercised') return false
  const exercises = report.prep?.variants.find((v) => v.variant === variantName)?.exercises ?? []
  return exercises.some((e) => e.exitCode === 0)
}

/**
 * Per non-baseline variant: every pack IT declares was visible but never
 * called directly — the pack contributed nothing to this variant's deltas.
 * Skipped only when EVERY one of its packs genuinely ran exercise mode FOR
 * THIS VARIANT (`variantExercisedFor`, D6): pack-level `mode === 'exercised'`
 * alone is not enough — that mode is set once per pack across every variant
 * declaring it, but `--pack-exercise` is a per-variant field, so a second
 * variant sharing the same pack without its own exercise still needs this
 * warning (see `packExercisedZeroCallsNote`).
 */
const packNoopWarning = (report: Report, spec: VariantSpec, agg: VariantAggregates): string | undefined => {
  if (spec.packs.length === 0) return undefined
  const declared = (agg.packUses ?? []).filter((p) => spec.packs.includes(p.pack) && p.canDetect)
  if (declared.length === 0 || declared.some((p) => p.calls !== 0)) return undefined
  if (spec.packs.every((p) => variantExercisedFor(report, spec.name, p))) return undefined
  const confirmed = declared.every((p) => p.visibilityConfirmed === true)
  return confirmed
    ? `> ⚠ **Пакет ни разу не вызван на варианте «${spec.name}» — preflight подтвердил, что он был виден, значит модель сознательно решила его не вызывать. Пакет не внёс никакого вклада в дельты этого варианта.**`
    : `> ⚠ **Пакет ни разу не вызван на варианте «${spec.name}» — пакет не внёс никакого вклада в дельты этого варианта.**`
}

/** Companion to `packNoopWarning`: informational, not a warning — zero direct calls is the expected shape once THIS variant's own exercise genuinely ran. */
const packExercisedZeroCallsNote = (report: Report, spec: VariantSpec, agg: VariantAggregates): string | undefined => {
  if (spec.packs.length === 0) return undefined
  const declared = (agg.packUses ?? []).filter((p) => spec.packs.includes(p.pack) && p.canDetect)
  if (declared.length === 0 || declared.some((p) => p.calls !== 0)) return undefined
  if (!spec.packs.every((p) => variantExercisedFor(report, spec.name, p))) return undefined
  return `_Пакет ни разу не был вызван напрямую на варианте «${spec.name}» — \`--pack-exercise\` уже прогнал его пайплайн до старта агента, так что вызывать было нечего. Ожидаемо в режиме exercised, это не дефект; см. раздел «Подготовка пакетов»._`
}

const riskyCommandAlert = (report: Report): string | undefined => {
  const n = report.metrics.variants.reduce((acc, v) => acc + (v.riskyCommands?.length ?? 0), 0)
  return n === 0
    ? undefined
    : `> ⚠ обнаружено: ${String(n)} ${pluralRu(n, 'опасная команда', 'опасные команды', 'опасных команд')} — см. раздел «Безопасность»`
}

const contaminationAlert = (report: Report): string | undefined => {
  const affected = report.metrics.variants.filter((v) => (v.contaminationSignals?.length ?? 0) > 0)
  if (affected.length === 0) return undefined
  const total = affected.reduce((acc, v) => acc + (v.contaminationSignals?.length ?? 0), 0)
  const names = affected.map((v) => v.variant).join(', ')
  return `> ⚠ **Контаминация: у ${names} обнаружено ${String(total)} ${pluralRu(total, 'сигнал', 'сигнала', 'сигналов')} того, что вариант получил или использовал пакет, который он не объявляет — дельты с участием ${names} могут оказаться сравнением не чистого базового варианта, а испытуемого.** См. «Контаминация».`
}

const bucketLine = (heading: string, es: readonly DeltaEntry[]): string => {
  const body =
    es.length === 0
      ? '_нет_'
      : es
          .map((e) => `**${e.label}**: ${fmtSigned(e.d.absolute, e.kind)} (${fmtPct(e.d.percent)}) — ${verdictFor(e.d)}`)
          .join('; ')
  return `- **${heading}**: ${body}`
}

const renderSummary = (report: Report): string => {
  const baseline = report.metrics.baseline
  const nonBaseline = report.manifest.variants.filter((v) => v.name !== baseline)

  const perVariantAlerts = nonBaseline.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    return agg === undefined ? [] : [packNoopWarning(report, spec, agg)]
  })
  const alerts = [
    allFailedWarning(report),
    ...pairIncompleteWarnings(report),
    ...perVariantAlerts,
    riskyCommandAlert(report),
    contaminationAlert(report),
  ].filter((s): s is string => s !== undefined)

  const exercisedNotes = nonBaseline.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    if (agg === undefined) return []
    const note = packExercisedZeroCallsNote(report, spec, agg)
    return note === undefined ? [] : [note]
  })

  const basisLine =
    report.summary.basis === 'task'
      ? ['_Основа: только фаза task (init исключён); стоимость init показана ниже, в разделе «Стоимость init»._', '']
      : []

  const perVariantBlocks = nonBaseline.map((spec) => {
    const { entries } = deltaEntriesFor(report.metrics, spec.name)
    const improvements = entries.filter((e) => e.d.better === 'better')
    const regressions = entries.filter((e) => e.d.better === 'worse')
    const neutral = entries.filter((e) => e.d.better === 'neutral' || e.d.better === 'context-dependent')
    return [
      `### vs база: ${spec.name}`,
      bucketLine('Улучшения', improvements),
      bucketLine('Регрессии', regressions),
      bucketLine('Нейтральные', neutral),
    ]
  })

  return [
    '## Сводка',
    '',
    ...(alerts.length === 0 ? [] : [...alerts, '']),
    ...(exercisedNotes.length === 0 ? [] : [...exercisedNotes, '']),
    report.summary.headlineResult,
    '',
    ...basisLine,
    ...joinBlocks(perVariantBlocks),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Primary metrics — metric-major long table (03-hard-problems.md §4.1):
// one row per (metric, variant), baseline row first per metric group,
// marked `*`, delta columns em-dash on the baseline row.
// ---------------------------------------------------------------------------

const PRIMARY_TABLE_HEADER = [
  '| Метрика | Вариант | Медиана | [мин–макс] | Δ vs база | Δ% | Значимо | Вердикт |',
  '|---|---|---|---|---|---|---|---|',
]

const hasStats = (key: PrimaryMeta['key']): key is keyof AggregateStats => key !== 'maxParallelism'

const primarySpreadCell = (agg: VariantAggregates, m: PrimaryMeta): string => {
  if (!hasStats(m.key)) return '—'
  const stat = agg.stats[m.key]
  const range = `${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}`
  return stat.iqr === undefined ? range : `${range} (IQR=${fmtValue(stat.iqr, m.kind)})`
}

/** Shared row shape for both the primary and phase-split (task/init) tables: baseline (or a pairing with no delta) renders em-dashes, everything else renders the real delta. */
const metricRow = (
  m: { readonly label: string; readonly kind: MetricKind },
  variantName: string,
  isBase: boolean,
  value: string,
  spread: string,
  d: MetricDelta | undefined,
): string => {
  const name = isBase ? `${variantName}*` : variantName
  if (isBase || d === undefined) return `| ${m.label} | ${name} | ${value} | ${spread} | — | — | — | — |`
  return `| ${m.label} | ${name} | ${value} | ${spread} | ${fmtSigned(d.absolute, m.kind)} | ${fmtPct(d.percent)} | ${sigLabel(d)} | ${verdictFor(d)} |`
}

const primaryRowsFor = (report: Report, m: PrimaryMeta): readonly string[] =>
  orderedForTables(report).flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    if (agg === undefined) return []
    const isBase = spec.name === report.metrics.baseline
    const value = fmtValue(agg.primary[m.key], m.kind)
    const spread = primarySpreadCell(agg, m)
    const vd = report.metrics.deltas.find((d) => d.variant === spec.name)
    return [metricRow(m, spec.name, isBase, value, spread, vd?.deltas[m.key])]
  })

/** `* baseline` footnote, plus the §1.3 multiple-comparisons caveat whenever more than one non-baseline variant shares the baseline. */
const primaryFootnote = (report: Report): string => {
  const k = report.metrics.deltas.length
  const caveat =
    k > 1
      ? ` N−1 = ${String(k)} ${pluralRu(k, 'сравнение', 'сравнения', 'сравнений')} делят один базовый вариант; при таком размере выборки возможны отдельные случайные пометки «значимо» — сигналом считайте разницу в количестве таких пометок между вариантами, а не единичную пометку.`
      : ''
  return `_* база.${caveat}_`
}

const rankHistogram = (samples: readonly number[]): string => {
  const counts = samples.reduce<Readonly<Record<number, number>>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {})
  return Object.entries(counts)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([rank, n]) => `ранг ${rank} ×${String(n)}`)
    .join(', ')
}

/**
 * Multiplier next to each unstable metric so "unstable" carries a magnitude,
 * not just a flag — max/min, since that is the two numbers already printed
 * in the [min–max] column right above this line. Omitted when min is 0
 * (ratio undefined, not "infinite").
 */
const unstableLabels = (agg: VariantAggregates): readonly string[] =>
  PRIMARY_METRICS.filter((m) => hasStats(m.key)).flatMap((m) => {
    if (!hasStats(m.key)) return []
    const stat = agg.stats[m.key]
    if (stat.iqr === undefined || stat.iqr <= stat.median) return []
    const ratio = stat.min > 0 ? ` (${(stat.max / stat.min).toFixed(1)}×)` : ''
    return [`${m.label}${ratio}`]
  })

const verifyPart = (sec: VerifyStats | undefined): string => {
  if (sec === undefined) return ''
  const detail =
    sec.failed === 0 && sec.timedOut === 0 ? '' : ` (${String(sec.failed)} провалено, ${String(sec.timedOut)} по таймауту)`
  return `; verify: ${String(sec.passed)}/${String(sec.runCount)} пройдено${detail}`
}

const stabilityLine = (report: Report, spec: VariantSpec, agg: VariantAggregates): string => {
  const samples = agg.stats.successRank.samples
  // `report.manifest.runs` is every attempted run — samples only covers runs
  // that produced metrics, so a crashed run must still count against the
  // denominator or a variant that crashed every attempt reads as "0/0 (0%)"
  // instead of a visibly failed 0/N.
  const totalRuns = report.manifest.runs
  const okCount = samples.filter((r) => r >= 3).length
  const rate = totalRuns === 0 ? '0%' : `${String(Math.round((100 * okCount) / totalRuns))}%`
  const hist = rankHistogram(samples)
  const unstable = unstableLabels(agg)
  const unstablePart = unstable.length === 0 ? '' : `; нестабильно: ${unstable.join(', ')}`
  const star = spec.name === report.metrics.baseline ? '*' : ''
  return `- **${spec.name}${star}**: успешность ${String(okCount)}/${String(totalRuns)} (${rate}); ${hist}${unstablePart}${verifyPart(agg.verifyStats)}`
}

const renderStability = (report: Report): readonly string[] => [
  '### Стабильность',
  ...orderedForTables(report).flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    return agg === undefined ? [] : [stabilityLine(report, spec, agg)]
  }),
]

const renderPrimary = (report: Report): string => {
  const warn = report.metrics.allFailed ? ['> ⚠ **Все варианты провалились — сравнение ненадёжно.**', ''] : []
  const rows = PRIMARY_METRICS.flatMap((m) => primaryRowsFor(report, m))
  return [
    '## Основные метрики — итого (init + task)',
    '',
    ...warn,
    ...PRIMARY_TABLE_HEADER,
    ...rows,
    '',
    primaryFootnote(report),
    '',
    ...renderStability(report),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Phase split (init vs task): same metric-major shape as primary, one table
// for the task phase and one for init cost; setup/lost-init lines per
// variant.
// ---------------------------------------------------------------------------

const hasAnyPhaseSplit = (report: Report): boolean => report.metrics.variants.some((v) => v.phaseSplit !== undefined)

const phaseSpreadCell = (stats: PhaseSliceStats, m: PhaseMeta): string => {
  const stat = stats[m.key]
  const range = `${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}`
  return stat.iqr === undefined ? range : `${range} (IQR=${fmtValue(stat.iqr, m.kind)})`
}

const phaseValue = (slice: PhaseSlice, m: PhaseMeta, prorated: boolean): string => {
  const mark = m.key === 'costUsd' && prorated ? '~' : ''
  return `${mark}${fmtValue(slice[m.key], m.kind)}`
}

const taskRowsFor = (report: Report, m: PhaseMeta): readonly string[] =>
  orderedForTables(report).flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    const split = agg?.phaseSplit
    if (split === undefined) return []
    const isBase = spec.name === report.metrics.baseline
    const vd = report.metrics.deltas.find((d) => d.variant === spec.name)
    const prorated = split.costProrated === true
    return [
      metricRow(m, spec.name, isBase, phaseValue(split.task, m, prorated), phaseSpreadCell(split.taskStats, m), vd?.taskDeltas?.[m.key]),
    ]
  })

/** `initDeltas` only exists when BOTH baseline and the variant ran init (spec §1.2/§4.1) — a variant with its own init but no matching pair still shows its own median, just no delta (em-dash). */
const initRowsFor = (report: Report, m: PhaseMeta): readonly string[] =>
  orderedForTables(report).flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    const split = agg?.phaseSplit
    if (split?.init === undefined || split.initStats === undefined) return []
    const isBase = spec.name === report.metrics.baseline
    const vd = report.metrics.deltas.find((d) => d.variant === spec.name)
    const prorated = split.costProrated === true
    return [
      metricRow(m, spec.name, isBase, phaseValue(split.init, m, prorated), phaseSpreadCell(split.initStats, m), vd?.initDeltas?.[m.key]),
    ]
  })

const anyProrated = (report: Report, phase: 'task' | 'init'): boolean =>
  report.manifest.variants.some((spec) => {
    const split = variantAggFor(report.metrics, spec.name)?.phaseSplit
    if (split === undefined || split.costProrated !== true) return false
    return phase === 'task' || split.init !== undefined
  })

const PRORATED_FOOTNOTE = '_~ стоимость распределена от суммарной стоимости сессии пропорционально доле токенов — расчётное значение, не измеренное._'

const setupLines = (report: Report): readonly string[] =>
  report.manifest.variants.flatMap((spec) => {
    const setup = variantAggFor(report.metrics, spec.name)?.phaseSplit?.setup
    return setup === undefined
      ? []
      : [`- **${spec.name}**: установка пакета (testaipack, без вызова модели) — медиана ${fmtInt(setup.wallClockMs)}ms`]
  })

const lostInitLines = (report: Report): readonly string[] =>
  report.manifest.variants.flatMap((spec) => {
    const n = variantAggFor(report.metrics, spec.name)?.phaseSplit?.runsWithLostInit ?? 0
    return n === 0
      ? []
      : [
          `> ⚠ ${spec.name}: ${String(n)} ${pluralRu(n, 'запуск', 'запуска', 'запусков')} ${n === 1 ? 'прогнал' : 'прогнали'} --init, но экспорт потерял init-сессию — стоимость init не измерена.`,
        ]
  })

const renderPhaseSplit = (report: Report): string => {
  if (!hasAnyPhaseSplit(report)) return ''
  const taskRows = PHASE_METRICS.flatMap((m) => taskRowsFor(report, m))
  const initRows = PHASE_METRICS.flatMap((m) => initRowsFor(report, m))
  const initSection: readonly string[] =
    initRows.length === 0
      ? ['### Стоимость init', '', '_Ни один вариант не запускал `--init`._']
      : [
          '### Стоимость init',
          '',
          ...PRIMARY_TABLE_HEADER,
          ...initRows,
          ...(anyProrated(report, 'init') ? ['', PRORATED_FOOTNOTE] : []),
        ]
  const setups = setupLines(report)
  const lost = lostInitLines(report)
  return [
    '## Разбивка по фазам (init vs task)',
    '',
    'Заголовок сравнивает task с task — при равных условиях. Стоимость init (вызов `--init`, если он был) и установка пакета (testaipack, до сессии агента) показаны отдельно ниже.',
    '',
    '### Фаза task (при равных условиях)',
    '',
    ...PRIMARY_TABLE_HEADER,
    ...taskRows,
    ...(anyProrated(report, 'task') ? ['', PRORATED_FOOTNOTE] : []),
    '',
    ...(setups.length === 0 ? [] : [...setups, '']),
    ...initSection,
    ...(lost.length === 0 ? [] : ['', ...lost]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Harness preparation: one banner block per pack (mode explanation), one
// combined evidence table across every pack + variant (Pack column added).
// ---------------------------------------------------------------------------

const MODE_BANNER: Readonly<Record<Exclude<PackSetupMode, 'installed-only'>, string>> = {
  exercised:
    'testaipack установил пакет, check пройден в изолированном HOME, и пайплайн пакета прогнан перед каждым измеряемым запуском — интеграция на уровне рабочей директории (workspace) этим не проверяется. Варианты, объявляющие пакет, измеряют работу агента с доступной зависимостью и её выводом. Это не измеряет, нашёл бы и выбрал ли этот пакет агент сам.',
  'delivered-only':
    'пакет был доставлен, но не установлен и не проверен testaipack; сработал ли лежащий в его основе инструмент в конкретном запуске, зависело от агента. Считайте сравнимость между запусками низкой.',
}

/**
 * `installed-only` is not one story: it is reached both when `--pack-check`
 * genuinely ran and passed (setup + check, nothing to exercise) and when it
 * never ran at all (setup only, or preflight was disabled so gate 6 never
 * executed) — two very different claims about the copied homes. `checks`
 * only ever contains PASSING results (gate 6 aborts the whole preflight
 * outright on a failing one, before any report exists) — so a non-empty
 * array is sufficient proof a check genuinely ran.
 */
const installedOnlyBanner = (p: PackPrep): string =>
  p.checkDeclared && p.checks.length > 0
    ? 'пакет установлен и его check прошёл; сам пакет не предоставляет ничего, что testaipack мог бы запустить. Варианты, объявляющие его, измеряют работу агента с установленной и подтверждённо рабочей зависимостью.'
    : 'пакет установлен, но testaipack ни разу не запустил --pack-check, чтобы подтвердить его работоспособность — скопированные HOME являются непроверенной копией первого, поэтому незаметно сломанная установка может исказить каждую медиану ниже. Варианты, объявляющие пакет, измеряют работу агента с установленной, но не проверенной зависимостью.'

const modeBanner = (p: PackPrep): string => (p.mode === 'installed-only' ? installedOnlyBanner(p) : MODE_BANNER[p.mode])

const COMPARISON_LINE =
  'Сравнение: каждый вариант, объявляющий пакет, измеряет работу агента с установленной зависимостью и её доступным выводом; варианты, не объявляющие его, служат для него контролем.'

const declaresPack = (report: Report, variantName: string, packName: string): boolean =>
  report.manifest.variants.find((v) => v.name === variantName)?.packs.includes(packName) === true

/** `runIndex === 0` marks the one-shot experiment-global setup command, not a real run. Declared-vs-foreign (not new-vs-old): expected-pass where the row's variant declares the pack, expected-fail elsewhere. */
const cmdStatus = (report: Report, r: PackCmdResult, packName: string): string => {
  const wantsZero = declaresPack(report, r.variant, packName)
  const ok = wantsZero ? r.exitCode === 0 : r.exitCode !== 0
  if (ok) return '✓'
  return wantsZero ? `✗ (код ${String(r.exitCode)})` : `✗ инструмент присутствует на чужом варианте (код ${String(r.exitCode)})`
}

const setupRows = (report: Report, p: PackPrep): readonly string[] =>
  p.setups.map((s) => `| setup | ${p.pack} | ${s.variant} | — | ${cmdStatus(report, s, p.pack)} | ${fmtDurationMs(s.durationMs)} | — |`)

const checkRows = (report: Report, p: PackPrep): readonly string[] =>
  p.checks.map(
    (c) =>
      `| check | ${p.pack} | ${c.variant} | ${c.runIndex === 0 ? '—' : String(c.runIndex)} | ${cmdStatus(report, c, p.pack)} | ${fmtDurationMs(c.durationMs)} | — |`,
  )

const exerciseStatus = (e: PackCmdResult): string => (e.exitCode === 0 ? '✓' : `✗ (код ${String(e.exitCode)})`)

const exerciseRows = (v: VariantPrep): readonly string[] =>
  v.exercises.map(
    (e) =>
      `| exercise | — | ${e.variant} | ${String(e.runIndex)} | ${exerciseStatus(e)} | ${fmtDurationMs(e.durationMs)} | ${e.artifactHash === undefined ? '—' : escapeCell(e.artifactHash.slice(0, 12))} |`,
  )

/** All hashes recorded must agree — a pack pipeline is supposed to be deterministic given the same input tree. */
const artifactDivergenceLine = (exercises: readonly PackCmdResult[]): string | undefined => {
  const hashes = exercises.flatMap((e) => (e.artifactHash === undefined ? [] : [e.artifactHash]))
  const distinct = new Set(hashes)
  if (distinct.size <= 1) return undefined
  return `> ⚠ **Результат exercise не детерминирован**: ${String(distinct.size)} ${pluralRu(distinct.size, 'разный хеш', 'разных хеша', 'разных хешей')} артефакта среди ${String(hashes.length)} ${pluralRu(hashes.length, 'запуска', 'запусков', 'запусков')}, зафиксировавших хеш, — собственный пайплайн пакета выдал разный результат на одинаковых входных деревьях.`
}

/**
 * An exercise that exits 0 but leaves no tracked artifact behind is
 * indistinguishable from a no-op — the table row above renders a plain ✓
 * with an empty artifact-hash column, which reads as success with nothing
 * to hint otherwise.
 */
const noArtifactLine = (exercises: readonly PackCmdResult[]): string | undefined => {
  if (exercises.length === 0) return undefined
  const withArtifact = exercises.filter((e) => e.artifactHash !== undefined)
  if (withArtifact.length > 0) return undefined
  return `> ⚠ **Exercise не оставил артефакта ни в одном из ${String(exercises.length)} ${pluralRu(exercises.length, 'запуска', 'запусков', 'запусков')}**: выход 0 без отслеживаемого результата неотличим от no-op — проверьте, что \`--pack-exercise\` действительно прогнал пайплайн пакета.`
}

const declaredCommandLines = (report: Report): readonly string[] => [
  ...report.manifest.packs.flatMap((p) => [
    ...(p.setup === undefined ? [] : [`- ${p.name} setup: ${codeSpan(escapeCell(p.setup))}`]),
    ...(p.check === undefined ? [] : [`- ${p.name} check: ${codeSpan(escapeCell(p.check))}`]),
  ]),
  ...report.manifest.variants.flatMap((v) =>
    v.exercise === undefined ? [] : [`- ${v.name} exercise: ${codeSpan(escapeCell(v.exercise))}`],
  ),
]

const renderHarnessPrep = (report: Report): string => {
  const prep = report.prep
  if (prep === undefined) return ''
  const banners = prep.packs.flatMap((p) => [
    ...(p.undeclaredDepWarning === undefined ? [] : [`> ⚠ ${p.undeclaredDepWarning}`]),
    `> **${p.pack}**: ${modeBanner(p)}`,
  ])
  const commands = declaredCommandLines(report)
  const allExercises = prep.variants.flatMap((v) => v.exercises)
  const rows = [
    ...prep.packs.flatMap((p) => setupRows(report, p)),
    ...prep.packs.flatMap((p) => checkRows(report, p)),
    ...prep.variants.flatMap((v) => exerciseRows(v)),
  ]
  const divergence = artifactDivergenceLine(allExercises)
  const noArtifact = noArtifactLine(allExercises)
  const exerciseCaveat = prep.variants.some((v) => v.exerciseDeclared)
    ? ["_Любое использование API/LLM внутри собственного CLI пакета во время exercise — внешний процесс, который testaipack не измеряет; фиксируется только его wall-clock._"]
    : []
  return [
    '## Подготовка пакетов',
    '',
    ...banners,
    '',
    COMPARISON_LINE,
    '',
    ...(commands.length === 0 ? [] : [...commands, '']),
    '| Шаг | Пакет | Вариант | Запуск | Результат | Wall-clock | Хеш артефакта |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    ...(divergence === undefined ? [] : ['', divergence]),
    ...(noArtifact === undefined ? [] : ['', noArtifact]),
    ...(exerciseCaveat.length === 0 ? [] : ['', ...exerciseCaveat]),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Pack signal: nested per (pack, variant); foreign rows only render when
// non-zero (a zero foreign reading is the expected, silent state).
// ---------------------------------------------------------------------------

const packSignalLines = (report: Report): readonly string[] =>
  report.manifest.variants.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    const uses = agg?.packUses ?? []
    return uses.flatMap((pu) => {
      const declared = spec.packs.includes(pu.pack)
      if (!declared && pu.calls === 0) return []
      if (!pu.canDetect) return [`- **${pu.pack}** (вариант ${spec.name}): _использование пакета не видно для этого типа пакета_`]
      if (!declared) {
        return [
          `- **${pu.pack}** (вариант ${spec.name}): ${String(pu.calls)} ${pluralRu(pu.calls, 'вызов', 'вызова', 'вызовов')} — чужой; любой вызов означал бы контаминацию`,
        ]
      }
      const first = pu.firstCallMsMedian === undefined ? '' : `, медиана первого вызова ${fmtInt(pu.firstCallMsMedian)}ms`
      const visibility =
        pu.calls !== 0 ? '' : pu.visibilityConfirmed ? ' (подтверждённо виден, не вызван)' : ' (видимость не подтверждена)'
      const without =
        pu.runsWithoutCall === undefined || pu.runsWithoutCall.length === 0
          ? ''
          : `; ни разу не вызван в ${pu.runsWithoutCall.length === 1 ? 'запуске' : 'запусках'} ${pu.runsWithoutCall.join(', ')}`
      return [
        `- **${pu.pack}** (вариант ${spec.name}): ${String(pu.calls)} ${pluralRu(pu.calls, 'вызов', 'вызова', 'вызовов')}, ${String(pu.errors)} ${pluralRu(pu.errors, 'ошибка', 'ошибки', 'ошибок')}, ${String(pu.runsWithCall)}/${String(pu.runCount)} запусков вызвали пакет${first}${visibility}${without}`,
      ]
    })
  })

const renderPackSignal = (report: Report): string => {
  const lines = packSignalLines(report)
  if (lines.length === 0) return ''
  const footnote = (report.prep?.packs ?? []).some((p) => p.mode !== 'delivered-only')
    ? '_Вызовы пакета со стороны агента фиксируются только для контекста; в режиме exercise/installed-only они не являются мерой результата._'
    : undefined
  return ['## Использование пакетов', '', ...lines, ...(footnote === undefined ? [] : ['', footnote])].join('\n')
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const renderSafety = (report: Report): string => {
  const rows = report.manifest.variants.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    return (agg?.riskyCommands ?? []).map(
      (r) =>
        `| ${spec.name} | ${String(r.runIndex)} | ${codeSpan(escapeCell(r.command))} | ${String(r.completed)} | ${r.exitCode === undefined ? '—' : String(r.exitCode)} |`,
    )
  })
  if (rows.length === 0) return ''
  return [
    '## Безопасность',
    '',
    `Обнаружено: ${String(rows.length)} ${pluralRu(rows.length, 'опасная команда', 'опасные команды', 'опасных команд')}.`,
    '',
    '| Вариант | Запуск | Команда | Завершено | Выход |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Contamination — signs a variant acquired or used a pack it does
// not declare, which would silently invalidate deltas involving it.
// ---------------------------------------------------------------------------

/** `pack === ''` is WP7's sentinel for a variant-level signal (e.g. `install-drift`) that isn't attributable to one pack — render as "not pack-specific", not an empty-looking cell. */
const contaminationPackCell = (pack: string): string => (pack === '' ? '—' : escapeCell(pack))

const contaminationRows = (report: Report): readonly string[] =>
  report.manifest.variants.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    return (agg?.contaminationSignals ?? []).map(
      (s) =>
        `| ${escapeCell(s.kind)} | ${spec.name} | ${contaminationPackCell(s.pack)} | ${s.runIndex === undefined ? '—' : String(s.runIndex)} | ${codeSpan(escapeCell(s.detail))} |`,
    )
  })

const renderContamination = (report: Report): string => {
  const rows = contaminationRows(report)
  if (rows.length === 0) return ''
  return [
    '## Контаминация',
    '',
    `Обнаружено: ${String(rows.length)} ${pluralRu(rows.length, 'сигнал', 'сигнала', 'сигналов')} того, что вариант получил или использовал пакет, который он не объявляет. Это эвристическая проверка по наблюдаемым действиям, а не доказательство — она может пропустить пути, не оставляющие здесь следа; сама по себе она не означает, что запуск недействителен. См. \`src/metrics/baseline-contamination.ts\`.`,
    '',
    '| Тип | Вариант | Пакет | Запуск | Детали |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Secondary metrics — four groups per variant
// ---------------------------------------------------------------------------

const toolRows = (perTool: Readonly<Record<string, ToolStat>>): readonly string[] => {
  const entries = Object.entries(perTool)
  if (entries.length === 0) return ['    - _нет инструментов_']
  return [...entries]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .map(
      ([name, s]) =>
        `    - \`${escapeCell(name)}\`: count=${String(s.count)} errors=${(s.errorRate * 100).toFixed(0)}% avg=${fmtInt(s.avgDurationMs)}ms`,
    )
}

const diffResultFor = (report: Report, variant: string): DiffResult | undefined =>
  report.diffs.find((d) => d.variant === variant)

/**
 * Sums each run's `git diff --numstat`-derived summary (phase 08) for one
 * variant — the only real source of file-change counts (an opencode
 * export's own `info.summary` is not populated with meaningful values).
 */
const diffTotalsFor = (report: Report, variant: string): { readonly files: number; readonly add: number; readonly del: number } =>
  (diffResultFor(report, variant)?.runs ?? [])
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
    `Причины завершения: ${finish || '_нет_'}`,
    `Макс. серия одного инструмента подряд: ${String(sec.maxConsecutiveSameTool)}`,
    ...(sec.bashFailCount === undefined
      ? []
      : [`Провалы bash (exit != 0): ${String(sec.bashFailCount)} из ${String(sec.perTool['bash']?.count ?? 0)} вызовов (сумма по запускам)`]),
    ...(sec.invalidToolCalls === undefined || sec.duplicateToolCalls === undefined
      ? []
      : [`Невалидные вызовы инструментов: ${String(sec.invalidToolCalls)}; дублирующиеся вызовы: ${String(sec.duplicateToolCalls)} (суммы по запускам)`]),
    ...(sec.toolErrorTexts === undefined || sec.toolErrorTexts.length === 0
      ? []
      : [`Ошибки инструментов (топ): ${sec.toolErrorTexts.map(escapeCell).join('; ')}`]),
  ]
  return [...lines.map((l) => `  - ${l}`), '  - Инструменты (топ 20):', ...toolRows(sec.perTool)]
}

const STALL_LABEL = `${String(STALL_THRESHOLD_MS / 1000)}s`

const stallSuffix = (sec: SecondaryMetrics): string =>
  sec.stallCount === undefined || sec.stalledRunCount === undefined
    ? ''
    : `; ${String(sec.stallCount)} ${pluralRu(sec.stallCount, 'простой', 'простоя', 'простоев')} дольше ${STALL_LABEL} в ${String(sec.stalledRunCount)} ${sec.stalledRunCount === 1 ? 'запуске' : 'запусках'}`

const latencyGroup = (sec: SecondaryMetrics, wallClockMs: string): readonly string[] => {
  const share = toNum(wallClockMs) > 0 ? ` (${String(Math.round((100 * toNum(sec.reasoningTimeMs)) / toNum(wallClockMs)))}% от wall-clock)` : ''
  const pieces: readonly string[] = [
    ...(sec.timeToFirstToolMs === undefined ? [] : [`первый инструмент: +${fmtDurationMs(sec.timeToFirstToolMs)}`]),
    ...(sec.timeToFirstEditMs === undefined ? [] : [`первое редактирование: +${fmtDurationMs(sec.timeToFirstEditMs)}`]),
    ...(sec.maxEventGapMs === undefined
      ? []
      : [`худший простой: ${fmtDurationMs(sec.maxEventGapMs)} (максимум по запускам)${stallSuffix(sec)}`]),
  ]
  const lines: readonly string[] = [
    `Задержка шага: p50=${fmtInt(sec.stepLatencyP50Ms)}ms, p95=${fmtInt(sec.stepLatencyP95Ms)}ms`,
    `Время рассуждений: ${fmtInt(sec.reasoningTimeMs)}ms${share}; среднее по инструментам: ${fmtInt(sec.toolLatencyAvgMs)}ms`,
    ...(pieces.length === 0 ? [] : [capFirst(pieces.join('; '))]),
  ]
  return lines.map((l) => `  - ${l}`)
}

const tokensContextGroup = (sec: SecondaryMetrics): readonly string[] => {
  const cacheWrite = sec.cacheWriteTokens === undefined ? '' : `, cacheWrite=${fmtInt(sec.cacheWriteTokens)}`
  const first = sec.firstStepInputTokens === undefined ? 'н/д' : `${fmtInt(sec.firstStepInputTokens)} tok`
  const last = sec.lastStepInputTokens === undefined ? 'н/д' : `${fmtInt(sec.lastStepInputTokens)} tok`
  const lines: readonly string[] = [
    `Разбивка по токенам: input=${fmtInt(sec.inputTokens)}, output=${fmtInt(sec.outputTokens)}, reasoning=${fmtInt(sec.reasoningTokens)}, cacheRead=${fmtInt(sec.cacheReadTokens)}${cacheWrite}`,
    ...(sec.firstStepInputTokens === undefined && sec.lastStepInputTokens === undefined
      ? []
      : [`Контекст: вход первого шага=${first}, вход последнего шага=${last}`]),
  ]
  return lines.map((l) => `  - ${l}`)
}

const outputVolumeGroup = (report: Report, variant: string, sec: SecondaryMetrics): readonly string[] => {
  const fds = diffTotalsFor(report, variant)
  const lines: readonly string[] = [
    `Изменения файлов: +${String(fds.add)} -${String(fds.del)} (${String(fds.files)} ${pluralRu(fds.files, 'файл', 'файла', 'файлов')})`,
    ...(sec.textChars === undefined
      ? []
      : [`Вывод: текст ${fmtInt(sec.textChars)} симв., рассуждения ${fmtInt(sec.reasoningChars ?? '0')} симв.`]),
  ]
  return lines.map((l) => `  - ${l}`)
}

const secondaryBlockFor = (report: Report, spec: VariantSpec, agg: VariantAggregates): readonly string[] => [
  `### ${spec.name}: дополнительные метрики`,
  '- **Поведение**',
  ...behaviorGroup(agg.secondary),
  '- **Задержки**',
  ...latencyGroup(agg.secondary, agg.primary.wallClockMs),
  '- **Токены и контекст**',
  ...tokensContextGroup(agg.secondary),
  '- **Объём вывода**',
  ...outputVolumeGroup(report, spec.name, agg.secondary),
]

const renderSecondary = (report: Report): string => {
  const blocks = report.manifest.variants.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    return agg === undefined ? [] : [secondaryBlockFor(report, spec, agg)]
  })
  const wholeRunNote = hasAnyPhaseSplit(report)
    ? ['', '_Весь запуск (init + task) — без разбивки; см. неразбиваемые метрики в `docs/phases/07-aggregate.ru.md`._']
    : []
  return ['## Дополнительные метрики', ...wholeRunNote, '', ...joinBlocks(blocks)].join('\n')
}

// ---------------------------------------------------------------------------
// Failed runs / LLM judge / timeline
// ---------------------------------------------------------------------------

const renderFailures = (report: Report): string => {
  const failures = report.summary.failures
  if (failures.length === 0) return ''
  const warn = report.metrics.allFailed ? ['> ⚠ **Все варианты провалились — сравнение ненадёжно.**', ''] : []
  const rows = failures.map((f) => `| ${f.variant} | ${String(f.runIndex)} | \`${f.errorCode}\` | ${escapeCell(f.errorMessage)} |`)
  return ['## Проваленные запуски', '', ...warn, '| Вариант | Запуск | Код | Сообщение |', '|---|---|---|---|', ...rows].join('\n')
}

const renderJudge = (report: Report): string => {
  const j = report.judge
  if (j === undefined) {
    return ['## LLM-судья', '', '_Судья не запрошен (--judge не задан)_'].join('\n')
  }
  if (j.ran === false) {
    return ['## LLM-судья', '', `_Судья не был запущен: ${j.explanation}_`].join('\n')
  }
  const note = j.verdict === 'unclear' ? ' _(неясно)_' : ''
  const contaminated = report.metrics.variants.filter((v) => (v.contaminationSignals?.length ?? 0) > 0)
  const contaminationWarn =
    contaminated.length === 0
      ? []
      : [
          `> ⚠ **Контаминация обнаружена (${contaminated.map((v) => v.variant).join(', ')}) — этот вердикт может сравнивать варианты, использовавшие пакет, который они не объявляют.**`,
          '',
        ]
  const qualityLine = `- Качество: ${report.manifest.variants
    .map((v) => {
      const score = j.scores.find((s) => s.variant === v.name)
      return `${v.name}=${score === undefined ? 'н/д' : String(score.quality)}`
    })
    .join(', ')}`
  const pairwiseNote =
    j.pairwiseFallback === true
      ? ['', '_Баллы получены через попарные вызовы каждого варианта против базового варианта (промпт превысил бюджет одного вызова)._']
      : []
  return [
    '## LLM-судья',
    '',
    ...contaminationWarn,
    `- Вердикт: **${j.verdict}**${note}`,
    `- Ранжирование: ${j.ranking.join(' > ')}`,
    qualityLine,
    `- Модель: \`${j.modelUsed}\``,
    `- Объяснение: ${j.explanation}`,
    ...pairwiseNote,
    ...renderRawResponse(j.rawResponse),
  ].join('\n')
}

const renderTimeline = (report: Report): string => {
  const all: readonly TimelineEvent[] = report.timeline.lanes.flatMap((l) => l.events)
  if (all.length === 0) {
    return ['## Сводка по таймлайну', '', '_Нет событий таймлайна._'].join('\n')
  }
  const ranked = [...all]
    .map((e) => ({ e, dur: Number(e.tEnd) - Number(e.tStart) }))
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 5)
  const rows = ranked.map(({ e, dur }) => {
    const tool = e.tool ? ` (${e.tool})` : ''
    return `- [${e.variant}/run-${String(e.runIndex)}] \`${e.type}\`${tool}: ${fmtInt(dur)}ms`
  })
  return ['## Сводка по таймлайну', '', ...rows, '', '_Полный интерактивный таймлайн — в `results/timeline.html`._'].join('\n')
}

// ---------------------------------------------------------------------------
// Diff summary — per-variant totals/efficiency, overlap vs baseline per
// non-baseline variant.
// ---------------------------------------------------------------------------

const stateMarker = (state: DiffRunResult['state']): string =>
  state === 'git-restored'
    ? ' (агент удалил .git, восстановлено из чистого клона)'
    : state === 'git-replaced'
      ? ' (агент заменил .git, diff включает коммиты агента)'
      : ''

/**
 * A run contained as failed (`successRank 0`) still gets diffed by phase 08
 * like any other, most often as an ordinary-looking `+0/-0` (its agent
 * session was skipped, so the worktree stayed pristine — see
 * `efficiencyLine`). Rendered identically to a run where the agent
 * genuinely made zero changes, a reader cannot tell the two apart from this
 * line alone. This suffix makes the contained case visibly distinct.
 */
const containedRunSuffix = (report: Report, variant: string, runIndex: number): string => {
  const failed = variantAggFor(report.metrics, variant)?.failedRuns.find((f) => f.runIndex === runIndex)
  return failed === undefined
    ? ''
    : ` — **учтён как проваленный** (\`${failed.errorCode}\`; исключён из показателя «Эффективность» ниже — см. «Проваленные запуски»)`
}

/**
 * `stats.totalTokens.samples` and `primary.totalTokens` (the numerator
 * below) come from the exact same population — a run whose exercise failed
 * (successRank 0, contained in `failedRuns`) leaves the worktree pristine
 * and still diffs as `+0/-0`; crediting it with a full median's worth of
 * tokens it never spent would inflate the numerator while the denominator
 * (`changedLines`) stays correctly untouched. `samples.length` is the only
 * count this ratio can honestly scale by — the exact set of runs the
 * numerator was averaged over.
 */
const efficiencyLine = (report: Report, variant: string): string => {
  const agg = variantAggFor(report.metrics, variant)
  if (agg === undefined) return '  - Эффективность: н/д'
  const t = diffTotalsFor(report, variant)
  const sessionRunCount = agg.stats.totalTokens.samples.length
  const changedLines = t.add + t.del
  const tokensPerRun = toNum(agg.primary.totalTokens)
  const costPerRun = agg.primary.costUsd
  const tokensPerLine = changedLines === 0 ? 'н/д' : fmtInt((tokensPerRun * sessionRunCount) / changedLines)
  const costPerFile = t.files === 0 ? 'н/д' : fmtValue((costPerRun * sessionRunCount) / t.files, 'cost')
  return `  - Эффективность: токенов на изменённую строку ${tokensPerLine}, стоимость на файл ${costPerFile} (пересчитано из медианы на запуск, по ${String(sessionRunCount)} ${sessionRunCount === 1 ? 'запуску' : 'запускам'} с сессией агента)`
}

const pathsForVariant = (report: Report, variant: string): ReadonlySet<string> =>
  new Set((diffResultFor(report, variant)?.runs ?? []).flatMap((r) => r.summary.perFile.map((f) => f.path)))

const overlapLinesFor = (report: Report, variant: string): readonly string[] => {
  const basePaths = pathsForVariant(report, report.metrics.baseline)
  const vPaths = pathsForVariant(report, variant)
  const both = [...basePaths].filter((p) => vPaths.has(p)).sort()
  const onlyBase = [...basePaths].filter((p) => !vPaths.has(p)).sort()
  const onlyV = [...vPaths].filter((p) => !basePaths.has(p)).sort()
  if (both.length === 0 && onlyBase.length === 0 && onlyV.length === 0) return []
  const cap = (list: readonly string[]): string => (list.length === 0 ? '_нет_' : list.slice(0, 15).map(escapeCell).join(', '))
  return [
    `- **Пересечение с базой (${variant})**`,
    `  - Общие: ${cap(both)}`,
    `  - Только база: ${cap(onlyBase)}`,
    `  - Только ${variant}: ${cap(onlyV)}`,
  ]
}

const diffBlockFor = (report: Report, variant: string): readonly string[] => {
  const t = diffTotalsFor(report, variant)
  const runs = diffResultFor(report, variant)?.runs ?? []
  const failedCount = runs.filter((r) => r.state === 'failed').length
  const failedSuffix = failedCount === 0 ? '' : `, из них ${String(failedCount)} ${failedCount === 1 ? 'провалился' : 'провалились'}`
  const runLines = runs.map((r) => {
    if (r.state === 'failed') {
      return `  - run-${String(r.runIndex)}: diff не удался — ${r.error?.message ?? 'неизвестно'}`
    }
    const patch = `diff/${variant}/run-${String(r.runIndex)}/full.patch`
    const html = r.htmlPath !== undefined ? `, [html](diff/${variant}/run-${String(r.runIndex)}/side.html)` : ''
    return `  - run-${String(r.runIndex)}: +${String(r.summary.additions)} -${String(r.summary.deletions)} (${String(r.summary.filesChanged)} ${pluralRu(r.summary.filesChanged, 'файл', 'файла', 'файлов')}) — [патч](${patch})${html}${stateMarker(r.state)}${containedRunSuffix(report, variant, r.runIndex)}`
  })
  return [
    `- **${variant}**: +${String(t.add)} -${String(t.del)} (${String(t.files)} ${pluralRu(t.files, 'файл', 'файла', 'файлов')}, ${String(runs.length)} ${pluralRu(runs.length, 'запуск', 'запуска', 'запусков')}${failedSuffix})`,
    ...runLines,
    efficiencyLine(report, variant),
  ]
}

const renderDiff = (report: Report): string => {
  const blocks = report.manifest.variants.map((spec) => diffBlockFor(report, spec.name))
  const overlaps = report.manifest.variants
    .filter((spec) => spec.name !== report.metrics.baseline)
    .flatMap((spec) => overlapLinesFor(report, spec.name))
  return ['## Сводка по diff', '', ...joinBlocks(blocks), ...(overlaps.length === 0 ? [] : ['', ...overlaps])].join('\n')
}

export const renderMd = (report: Report): string =>
  [
    renderHeader(report),
    renderSummary(report),
    renderPrimary(report),
    renderPhaseSplit(report),
    renderHarnessPrep(report),
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
