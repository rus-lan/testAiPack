/**
 * Report: html — minimal self-contained HTML report.
 *
 * Mirrors `md.ts` 1:1 structurally (same sections, same data, same
 * metric-major N-way layout from `.research/n-way-variants/03-hard-problems.md`
 * §4.2) but rendered as HTML with color-coded verdict cells and collapsible
 * secondary-metrics groups. All CSS is inline — the document has no
 * external dependencies.
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

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const capFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const quote = (s: string): string => `«${escapeHtml(s)}»`

/** Russian count agreement: 1 → `one`, 2-4 → `few`, 0/5-20/... → `many` (standard mod-10/mod-100 rule; same pattern as `md.ts`/`cli/summary.ts`). */
const pluralRu = (n: number, one: string, few: string, many: string): string => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

const VERDICT_CLASS: Readonly<Record<string, string>> = {
  better: 'better',
  worse: 'worse',
  neutral: 'neutral',
  'context-dependent': 'ctx',
}

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
// Header
// ---------------------------------------------------------------------------

const versionDriftWarning = (report: Report): string | undefined => {
  const versions = report.metrics.variants.flatMap((v) => v.opencodeVersions ?? [])
  if (versions.length === 0) return undefined
  const manifestVersion = report.manifest.opencodeVersion
  if (!versions.some((v) => v !== manifestVersion)) return undefined
  const distinct = [...new Set(versions)].sort()
  return `версия opencode расходится с manifest: manifest указывает ${manifestVersion}, в запусках использовалась ${distinct.join(', ')} (manifest мог зафиксировать HOST-бинарник — см. первопричину ниже)`
}

/** `pure` is D1: `variant.pure ?? variant.packs.length === 0` — see md.ts's `isPure` for the full rationale. */
const isPure = (v: VariantSpec): boolean => v.pure ?? v.packs.length === 0

const variantDescriptor = (report: Report, v: VariantSpec): string => {
  const star = v.name === report.metrics.baseline ? '*' : ''
  const packsPart = v.packs.length === 0 ? 'без пакетов' : `пакеты: ${v.packs.join(', ')}`
  const pureSuffix = isPure(v) ? ', чистый' : ''
  return `${v.name}${star} (${packsPart}${pureSuffix})`
}

/** Mirrors md.ts's `initDisclosureLine` — global/own/disabled (`init: ''`, D7) states. */
const initDisclosureLine = (report: Report): string | undefined => {
  const variants = report.manifest.variants
  const globalGroup = variants.filter((v) => v.init === undefined && report.manifest.init !== undefined)
  const ownVariants = variants.filter((v) => v.init !== undefined && v.init !== '')
  const disabledVariants = variants.filter((v) => v.init === '')
  if (globalGroup.length === 0 && ownVariants.length === 0 && disabledVariants.length === 0) return undefined
  const parts: readonly string[] = [
    ...(globalGroup.length === 0 ? [] : [`${escapeHtml(globalGroup.map((v) => v.name).join(', '))} — глобальный init`]),
    ...ownVariants.map((v) => `${escapeHtml(v.name)} — свой init (${quote(v.init ?? '')})`),
    ...(disabledVariants.length === 0
      ? []
      : [`${escapeHtml(disabledVariants.map((v) => v.name).join(', '))} — init отключён`]),
  ]
  return `<strong>Init:</strong> ${parts.join('; ')}`
}

/**
 * Mirrors md.ts's `groupedDisclosureLine` — resolution via `effectiveOf`
 * (00-cli-parse.ts, D7: an explicit `''` disables the global outright
 * rather than falling back to it) so the "variants differ" suffix cannot
 * silently fail to fire on a disabled override.
 */
const groupedDisclosureLine = (report: Report, label: string, key: 'hint' | 'prompt'): string | undefined => {
  const named = report.manifest.variants.map((v) => ({ name: v.name, value: effectiveOf(v, report.manifest[key], key) }))
  const withValue = named.filter(
    (e): e is { readonly name: string; readonly value: string } => e.value !== undefined && e.value !== '',
  )
  if (withValue.length === 0) return undefined
  const distinctSet = [...new Set(withValue.map((e) => e.value))]
  const parts = distinctSet.map(
    (value) =>
      `${escapeHtml(withValue.filter((e) => e.value === value).map((e) => e.name).join(', '))} — ${quote(value)}`,
  )
  const allValues = new Set(named.map((e) => e.value ?? ''))
  const differSuffix = allValues.size > 1 ? ' (варианты отличаются — сравнение измеряет промпт и пакет вместе)' : ''
  return `<strong>${label}:</strong> ${parts.join('; ')}${differSuffix}`
}

const hintDisclosureLine = (report: Report): string | undefined => groupedDisclosureLine(report, 'Подсказка', 'hint')
const promptDisclosureLine = (report: Report): string | undefined => groupedDisclosureLine(report, 'Промпт', 'prompt')

const renderHeader = (report: Report): string => {
  const warn = versionDriftWarning(report)
  const warnHtml = warn === undefined ? '' : `<p class="warn">⚠ ${escapeHtml(warn)}</p>`
  const promptLine = promptDisclosureLine(report)
  const promptHtml = promptLine === undefined ? '' : `<br>\n${promptLine}`
  const initLine = initDisclosureLine(report)
  const initHtml = initLine === undefined ? '' : `<br>\n${initLine}`
  const hintLine = hintDisclosureLine(report)
  const hintHtml = hintLine === undefined ? '' : `<br>\n${hintLine}`
  const variantsHtml = report.manifest.variants.map((v) => escapeHtml(variantDescriptor(report, v))).join(', ')
  return `<h1>Отчёт testaipack: ${escapeHtml(report.manifest.runId)}</h1>
<p class="meta"><strong>Репозиторий:</strong> ${escapeHtml(report.manifest.repoUrl)}<br>
<strong>Варианты:</strong> ${variantsHtml}<br>
<strong>Запуски:</strong> ${escapeHtml(String(report.manifest.runs))} на вариант<br>
<strong>Версия opencode:</strong> ${escapeHtml(report.manifest.opencodeVersion)}<br>
<strong>Время:</strong> ${escapeHtml(report.manifest.timestamp)}${promptHtml}${initHtml}${hintHtml}</p>
${warnHtml}`
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const allFailedWarning = (report: Report): string | undefined =>
  report.metrics.allFailed ? 'Все варианты провалились — сравнение недоступно.' : undefined

/** Mirrors md.ts's `pairIncompleteWarnings` (§1.2 `pairIncomplete`). */
const pairIncompleteWarnings = (report: Report): readonly string[] =>
  report.metrics.allFailed
    ? []
    : report.metrics.deltas
        .filter((d) => d.pairIncomplete)
        .map(
          (d) =>
            `${d.variant} — у базового варианта или у этого варианта получено ноль замеров; строка дельты ниже не является содержательным сравнением.`,
        )

/** Mirrors md.ts's `variantExercisedFor` — per-variant exercise evidence, not just pack-level mode. */
const variantExercisedFor = (report: Report, variantName: string, packName: string): boolean => {
  const pack = report.prep?.packs.find((p) => p.pack === packName)
  if (pack === undefined || pack.mode !== 'exercised') return false
  const exercises = report.prep?.variants.find((v) => v.variant === variantName)?.exercises ?? []
  return exercises.some((e) => e.exitCode === 0)
}

const packNoopWarning = (report: Report, spec: VariantSpec, agg: VariantAggregates): string | undefined => {
  if (spec.packs.length === 0) return undefined
  const declared = (agg.packUses ?? []).filter((p) => spec.packs.includes(p.pack) && p.canDetect)
  if (declared.length === 0 || declared.some((p) => p.calls !== 0)) return undefined
  if (spec.packs.every((p) => variantExercisedFor(report, spec.name, p))) return undefined
  // Not pre-escaped: this message is escaped once, as a whole, by the `alertsHtml` caller.
  const confirmed = declared.every((p) => p.visibilityConfirmed === true)
  return confirmed
    ? `Пакет ни разу не вызван на варианте «${spec.name}» — preflight подтвердил, что он был виден, значит модель сознательно решила его не вызывать. Пакет не внёс никакого вклада в дельты этого варианта.`
    : `Пакет ни разу не вызван на варианте «${spec.name}» — пакет не внёс никакого вклада в дельты этого варианта.`
}

const packExercisedZeroCallsNote = (report: Report, spec: VariantSpec, agg: VariantAggregates): string | undefined => {
  if (spec.packs.length === 0) return undefined
  const declared = (agg.packUses ?? []).filter((p) => spec.packs.includes(p.pack) && p.canDetect)
  if (declared.length === 0 || declared.some((p) => p.calls !== 0)) return undefined
  if (!spec.packs.every((p) => variantExercisedFor(report, spec.name, p))) return undefined
  return `Пакет ни разу не был вызван напрямую на варианте «${spec.name}» — <code>--pack-exercise</code> уже прогнал его пайплайн до старта агента, так что вызывать было нечего. Ожидаемо в режиме exercised, это не дефект; см. раздел «Подготовка пакетов».`
}

const riskyCommandAlert = (report: Report): string | undefined => {
  const n = report.metrics.variants.reduce((acc, v) => acc + (v.riskyCommands?.length ?? 0), 0)
  return n === 0
    ? undefined
    : `обнаружено: ${String(n)} ${pluralRu(n, 'опасная команда', 'опасные команды', 'опасных команд')} — см. раздел «Безопасность»`
}

const contaminationAlert = (report: Report): string | undefined => {
  const affected = report.metrics.variants.filter((v) => (v.contaminationSignals?.length ?? 0) > 0)
  if (affected.length === 0) return undefined
  const total = affected.reduce((acc, v) => acc + (v.contaminationSignals?.length ?? 0), 0)
  const names = affected.map((v) => v.variant).join(', ')
  return `Контаминация: у ${names} обнаружено ${String(total)} ${pluralRu(total, 'сигнал', 'сигнала', 'сигналов')} того, что вариант получил или использовал пакет, который он не объявляет — дельты с участием ${names} могут оказаться сравнением не чистого базового варианта, а испытуемого. См. «Контаминация».`
}

const bucketHtml = (heading: string, es: readonly DeltaEntry[]): string => {
  const body =
    es.length === 0
      ? '<em>нет</em>'
      : es
          .map(
            (e) =>
              `<strong>${escapeHtml(e.label)}</strong>: ${escapeHtml(fmtSigned(e.d.absolute, e.kind))} (${escapeHtml(fmtPct(e.d.percent))}) — ${escapeHtml(verdictFor(e.d))}`,
          )
          .join('; ')
  return `<li><strong>${escapeHtml(heading)}</strong>: ${body}</li>`
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
  const alertsHtml = alerts.map((a) => `<p class="warn">⚠ ${escapeHtml(a)}</p>`).join('')

  const exercisedNotes = nonBaseline.flatMap((spec) => {
    const agg = variantAggFor(report.metrics, spec.name)
    if (agg === undefined) return []
    const note = packExercisedZeroCallsNote(report, spec, agg)
    return note === undefined ? [] : [note]
  })
  const exercisedHtml = exercisedNotes.map((n) => `<p class="basis"><em>${n}</em></p>`).join('')

  const basisHtml =
    report.summary.basis === 'task'
      ? '<p class="basis"><em>Основа: только фаза task (init исключён); стоимость init показана ниже, в разделе «Стоимость init».</em></p>'
      : ''

  const perVariantHtml = nonBaseline
    .map((spec) => {
      const { entries } = deltaEntriesFor(report.metrics, spec.name)
      const improvements = entries.filter((e) => e.d.better === 'better')
      const regressions = entries.filter((e) => e.d.better === 'worse')
      const neutral = entries.filter((e) => e.d.better === 'neutral' || e.d.better === 'context-dependent')
      return `<div class="vs-base"><h3>vs база: ${escapeHtml(spec.name)}</h3><ul>${bucketHtml('Улучшения', improvements)}${bucketHtml('Регрессии', regressions)}${bucketHtml('Нейтральные', neutral)}</ul></div>`
    })
    .join('')

  return `<section id="summary">
<h2>Сводка</h2>
${alertsHtml}
${exercisedHtml}
<p class="headline">${escapeHtml(report.summary.headlineResult)}</p>
${basisHtml}
${perVariantHtml}
</section>`
}

// ---------------------------------------------------------------------------
// Primary metrics — metric-major long table, baseline row marked, `.baseline-row` class.
// ---------------------------------------------------------------------------

const PRIMARY_TABLE_HEAD =
  '<thead><tr><th>Метрика</th><th>Вариант</th><th>Медиана</th><th>[мин–макс]</th><th>Δ vs база</th><th>Δ%</th><th>Значимо</th><th>Вердикт</th></tr></thead>'

const hasStats = (key: PrimaryMeta['key']): key is keyof AggregateStats => key !== 'maxParallelism'

const primarySpreadCell = (agg: VariantAggregates, m: PrimaryMeta): string => {
  if (!hasStats(m.key)) return '—'
  const stat = agg.stats[m.key]
  const range = `${fmtValue(stat.min, m.kind)}–${fmtValue(stat.max, m.kind)}`
  return stat.iqr === undefined ? range : `${range} (IQR=${fmtValue(stat.iqr, m.kind)})`
}

const metricRow = (
  m: { readonly label: string; readonly kind: MetricKind },
  variantName: string,
  isBase: boolean,
  value: string,
  spread: string,
  d: MetricDelta | undefined,
): string => {
  const name = isBase ? `${variantName}*` : variantName
  const rowClass = isBase ? ' class="baseline-row"' : ''
  if (isBase || d === undefined) {
    return `<tr${rowClass}><td>${escapeHtml(m.label)}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(spread)}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`
  }
  const cls = VERDICT_CLASS[d.better] ?? 'neutral'
  return `<tr><td>${escapeHtml(m.label)}</td><td>${escapeHtml(name)}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(spread)}</td><td>${escapeHtml(fmtSigned(d.absolute, m.kind))}</td><td>${escapeHtml(fmtPct(d.percent))}</td><td>${escapeHtml(sigLabel(d))}</td><td class="${cls}">${escapeHtml(verdictFor(d))}</td></tr>`
}

const primaryRowsFor = (report: Report, m: PrimaryMeta): string =>
  orderedForTables(report)
    .flatMap((spec) => {
      const agg = variantAggFor(report.metrics, spec.name)
      if (agg === undefined) return []
      const isBase = spec.name === report.metrics.baseline
      const value = fmtValue(agg.primary[m.key], m.kind)
      const spread = primarySpreadCell(agg, m)
      const vd = report.metrics.deltas.find((d) => d.variant === spec.name)
      return [metricRow(m, spec.name, isBase, value, spread, vd?.deltas[m.key])]
    })
    .join('')

const primaryFootnote = (report: Report): string => {
  const k = report.metrics.deltas.length
  const caveat =
    k > 1
      ? ` N−1 = ${String(k)} ${pluralRu(k, 'сравнение', 'сравнения', 'сравнений')} делят один базовый вариант; при таком размере выборки возможны отдельные случайные пометки «значимо» — сигналом считайте разницу в количестве таких пометок между вариантами, а не единичную пометку.`
      : ''
  return `<p class="footnote"><em>* база.${escapeHtml(caveat)}</em></p>`
}

const rankHistogram = (samples: readonly number[]): string => {
  const counts = samples.reduce<Readonly<Record<number, number>>>((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {})
  return Object.entries(counts)
    .sort(([a], [b]) => Number(b) - Number(a))
    .map(([rank, n]) => `ранг ${rank} ×${String(n)}`)
    .join(', ')
}

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
  const totalRuns = report.manifest.runs
  const okCount = samples.filter((r) => r >= 3).length
  const rate = totalRuns === 0 ? '0%' : `${String(Math.round((100 * okCount) / totalRuns))}%`
  const unstable = unstableLabels(agg)
  const unstablePart = unstable.length === 0 ? '' : `; нестабильно: ${unstable.join(', ')}`
  const star = spec.name === report.metrics.baseline ? '*' : ''
  return `<li><strong>${escapeHtml(spec.name)}${star}</strong>: успешность ${String(okCount)}/${String(totalRuns)} (${rate}); ${escapeHtml(rankHistogram(samples))}${escapeHtml(unstablePart)}${escapeHtml(verifyPart(agg.verifyStats))}</li>`
}

const renderStability = (report: Report): string => {
  const items = orderedForTables(report)
    .flatMap((spec) => {
      const agg = variantAggFor(report.metrics, spec.name)
      return agg === undefined ? [] : [stabilityLine(report, spec, agg)]
    })
    .join('')
  return `<div class="stability"><h3>Стабильность</h3><ul>${items}</ul></div>`
}

const renderPrimary = (report: Report): string => {
  const warnHtml = report.metrics.allFailed
    ? '<p class="warn">⚠ <strong>Все варианты провалились — сравнение ненадёжно.</strong></p>'
    : ''
  const rows = PRIMARY_METRICS.map((m) => primaryRowsFor(report, m)).join('')
  return `<section>
<h2>Основные метрики — итого (init + task)</h2>
${warnHtml}
<table>
${PRIMARY_TABLE_HEAD}
<tbody>${rows}</tbody>
</table>
${primaryFootnote(report)}
${renderStability(report)}
</section>`
}

// ---------------------------------------------------------------------------
// Phase split
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

const taskRowsFor = (report: Report, m: PhaseMeta): string =>
  orderedForTables(report)
    .flatMap((spec) => {
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
    .join('')

const initRowsFor = (report: Report, m: PhaseMeta): string =>
  orderedForTables(report)
    .flatMap((spec) => {
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
    .join('')

const anyProrated = (report: Report, phase: 'task' | 'init'): boolean =>
  report.manifest.variants.some((spec) => {
    const split = variantAggFor(report.metrics, spec.name)?.phaseSplit
    if (split === undefined || split.costProrated !== true) return false
    return phase === 'task' || split.init !== undefined
  })

const PRORATED_FOOTNOTE_HTML =
  '<p class="prorated-note"><em>~ стоимость распределена от суммарной стоимости сессии пропорционально доле токенов — расчётное значение, не измеренное.</em></p>'

const setupLines = (report: Report): string =>
  report.manifest.variants
    .flatMap((spec) => {
      const setup = variantAggFor(report.metrics, spec.name)?.phaseSplit?.setup
      return setup === undefined
        ? []
        : [`<li><strong>${escapeHtml(spec.name)}</strong>: установка пакета (testaipack, без вызова модели) — медиана ${escapeHtml(fmtInt(setup.wallClockMs))}ms</li>`]
    })
    .join('')

const lostInitLines = (report: Report): string =>
  report.manifest.variants
    .flatMap((spec) => {
      const n = variantAggFor(report.metrics, spec.name)?.phaseSplit?.runsWithLostInit ?? 0
      return n === 0
        ? []
        : [
            `<p class="warn">⚠ ${escapeHtml(spec.name)}: ${String(n)} ${pluralRu(n, 'запуск', 'запуска', 'запусков')} ${n === 1 ? 'прогнал' : 'прогнали'} --init, но экспорт потерял init-сессию — стоимость init не измерена.</p>`,
          ]
    })
    .join('')

const renderPhaseSplit = (report: Report): string => {
  if (!hasAnyPhaseSplit(report)) return ''
  const taskRows = PHASE_METRICS.map((m) => taskRowsFor(report, m)).join('')
  const initRows = PHASE_METRICS.map((m) => initRowsFor(report, m)).join('')
  const initHtml =
    initRows === ''
      ? '<h3>Стоимость init</h3><p><em>Ни один вариант не запускал <code>--init</code>.</em></p>'
      : `<h3>Стоимость init</h3><table>${PRIMARY_TABLE_HEAD}<tbody>${initRows}</tbody></table>${anyProrated(report, 'init') ? PRORATED_FOOTNOTE_HTML : ''}`
  const setupsHtml = setupLines(report)
  return `<section><h2>Разбивка по фазам (init vs task)</h2>
<p>Заголовок сравнивает task с task — при равных условиях. Стоимость init (вызов <code>--init</code>, если он был) и установка пакета (testaipack, до сессии агента) показаны отдельно ниже.</p>
<h3>Фаза task (при равных условиях)</h3><table>${PRIMARY_TABLE_HEAD}<tbody>${taskRows}</tbody></table>${anyProrated(report, 'task') ? PRORATED_FOOTNOTE_HTML : ''}
${setupsHtml === '' ? '' : `<ul>${setupsHtml}</ul>`}
${initHtml}
${lostInitLines(report)}
</section>`
}

// ---------------------------------------------------------------------------
// Harness preparation
// ---------------------------------------------------------------------------

const MODE_BANNER: Readonly<Record<Exclude<PackSetupMode, 'installed-only'>, string>> = {
  exercised:
    'testaipack установил пакет, check пройден в изолированном HOME, и пайплайн пакета прогнан перед каждым измеряемым запуском — интеграция на уровне рабочей директории (workspace) этим не проверяется. Варианты, объявляющие пакет, измеряют работу агента с доступной зависимостью и её выводом. Это не измеряет, нашёл бы и выбрал ли этот пакет агент сам.',
  'delivered-only':
    'пакет был доставлен, но не установлен и не проверен testaipack; сработал ли лежащий в его основе инструмент в конкретном запуске, зависело от агента. Считайте сравнимость между запусками низкой.',
}

const installedOnlyBanner = (p: PackPrep): string =>
  p.checkDeclared && p.checks.length > 0
    ? 'пакет установлен и его check прошёл; сам пакет не предоставляет ничего, что testaipack мог бы запустить. Варианты, объявляющие его, измеряют работу агента с установленной и подтверждённо рабочей зависимостью.'
    : 'пакет установлен, но testaipack ни разу не запустил --pack-check, чтобы подтвердить его работоспособность — скопированные HOME являются непроверенной копией первого, поэтому незаметно сломанная установка может исказить каждую медиану ниже. Варианты, объявляющие пакет, измеряют работу агента с установленной, но не проверенной зависимостью.'

const modeBanner = (p: PackPrep): string => (p.mode === 'installed-only' ? installedOnlyBanner(p) : MODE_BANNER[p.mode])

const COMPARISON_LINE =
  'Сравнение: каждый вариант, объявляющий пакет, измеряет работу агента с установленной зависимостью и её доступным выводом; варианты, не объявляющие его, служат для него контролем.'

const declaresPack = (report: Report, variantName: string, packName: string): boolean =>
  report.manifest.variants.find((v) => v.name === variantName)?.packs.includes(packName) === true

const cmdStatus = (report: Report, r: PackCmdResult, packName: string): string => {
  const wantsZero = declaresPack(report, r.variant, packName)
  const ok = wantsZero ? r.exitCode === 0 : r.exitCode !== 0
  if (ok) return '✓'
  return wantsZero ? `✗ (код ${String(r.exitCode)})` : `✗ инструмент присутствует на чужом варианте (код ${String(r.exitCode)})`
}

const setupRows = (report: Report, p: PackPrep): string =>
  p.setups
    .map(
      (s) =>
        `<tr><td>setup</td><td>${escapeHtml(p.pack)}</td><td>${escapeHtml(s.variant)}</td><td>—</td><td>${escapeHtml(cmdStatus(report, s, p.pack))}</td><td>${escapeHtml(fmtDurationMs(s.durationMs))}</td><td>—</td></tr>`,
    )
    .join('')

const checkRows = (report: Report, p: PackPrep): string =>
  p.checks
    .map(
      (c) =>
        `<tr><td>check</td><td>${escapeHtml(p.pack)}</td><td>${escapeHtml(c.variant)}</td><td>${c.runIndex === 0 ? '—' : String(c.runIndex)}</td><td>${escapeHtml(cmdStatus(report, c, p.pack))}</td><td>${escapeHtml(fmtDurationMs(c.durationMs))}</td><td>—</td></tr>`,
    )
    .join('')

const exerciseStatus = (e: PackCmdResult): string => (e.exitCode === 0 ? '✓' : `✗ (код ${String(e.exitCode)})`)

const exerciseRows = (v: VariantPrep): string =>
  v.exercises
    .map(
      (e) =>
        `<tr><td>exercise</td><td>—</td><td>${escapeHtml(e.variant)}</td><td>${String(e.runIndex)}</td><td>${escapeHtml(exerciseStatus(e))}</td><td>${escapeHtml(fmtDurationMs(e.durationMs))}</td><td>${e.artifactHash === undefined ? '—' : `<code>${escapeHtml(e.artifactHash.slice(0, 12))}</code>`}</td></tr>`,
    )
    .join('')

const artifactDivergenceHtml = (exercises: readonly PackCmdResult[]): string => {
  const hashes = exercises.flatMap((e) => (e.artifactHash === undefined ? [] : [e.artifactHash]))
  const distinct = new Set(hashes)
  if (distinct.size <= 1) return ''
  return `<p class="warn">⚠ <strong>Результат exercise не детерминирован</strong>: ${String(distinct.size)} ${pluralRu(distinct.size, 'разный хеш', 'разных хеша', 'разных хешей')} артефакта среди ${String(hashes.length)} ${pluralRu(hashes.length, 'запуска', 'запусков', 'запусков')}, зафиксировавших хеш, — собственный пайплайн пакета выдал разный результат на одинаковых входных деревьях.</p>`
}

const noArtifactHtml = (exercises: readonly PackCmdResult[]): string => {
  if (exercises.length === 0) return ''
  const withArtifact = exercises.filter((e) => e.artifactHash !== undefined)
  if (withArtifact.length > 0) return ''
  return `<p class="warn">⚠ <strong>Exercise не оставил артефакта ни в одном из ${String(exercises.length)} ${pluralRu(exercises.length, 'запуска', 'запусков', 'запусков')}</strong>: выход 0 без отслеживаемого результата неотличим от no-op — проверьте, что <code>--pack-exercise</code> действительно прогнал пайплайн пакета.</p>`
}

const declaredCommandItems = (report: Report): string => {
  const lines: readonly string[] = [
    ...report.manifest.packs.flatMap((p) => [
      ...(p.setup === undefined ? [] : [`<li>${escapeHtml(p.name)} setup: <code>${escapeHtml(p.setup)}</code></li>`]),
      ...(p.check === undefined ? [] : [`<li>${escapeHtml(p.name)} check: <code>${escapeHtml(p.check)}</code></li>`]),
    ]),
    ...report.manifest.variants.flatMap((v) =>
      v.exercise === undefined ? [] : [`<li>${escapeHtml(v.name)} exercise: <code>${escapeHtml(v.exercise)}</code></li>`],
    ),
  ]
  return lines.length === 0 ? '' : `<ul>${lines.join('')}</ul>`
}

const renderHarnessPrep = (report: Report): string => {
  const prep = report.prep
  if (prep === undefined) return ''
  const banners = prep.packs
    .flatMap((p) => [
      ...(p.undeclaredDepWarning === undefined ? [] : [`<p class="warn">⚠ ${escapeHtml(p.undeclaredDepWarning)}</p>`]),
      `<p class="warn"><strong>${escapeHtml(p.pack)}</strong>: ${escapeHtml(modeBanner(p))}</p>`,
    ])
    .join('')
  const allExercises = prep.variants.flatMap((v) => v.exercises)
  const rows = `${prep.packs.map((p) => setupRows(report, p)).join('')}${prep.packs.map((p) => checkRows(report, p)).join('')}${prep.variants.map((v) => exerciseRows(v)).join('')}`
  const exerciseCaveat = prep.variants.some((v) => v.exerciseDeclared)
    ? '<p><em>Любое использование API/LLM внутри собственного CLI пакета во время exercise — внешний процесс, который testaipack не измеряет; фиксируется только его wall-clock.</em></p>'
    : ''
  return `<section><h2>Подготовка пакетов</h2>
${banners}
<p>${escapeHtml(COMPARISON_LINE)}</p>
${declaredCommandItems(report)}
<table><thead><tr><th>Шаг</th><th>Пакет</th><th>Вариант</th><th>Запуск</th><th>Результат</th><th>Wall-clock</th><th>Хеш артефакта</th></tr></thead><tbody>${rows}</tbody></table>
${artifactDivergenceHtml(allExercises)}
${noArtifactHtml(allExercises)}
${exerciseCaveat}
</section>`
}

// ---------------------------------------------------------------------------
// Pack signal
// ---------------------------------------------------------------------------

const packSignalLines = (report: Report): string =>
  report.manifest.variants
    .flatMap((spec) => {
      const agg = variantAggFor(report.metrics, spec.name)
      const uses = agg?.packUses ?? []
      return uses.flatMap((pu) => {
        const declared = spec.packs.includes(pu.pack)
        if (!declared && pu.calls === 0) return []
        if (!pu.canDetect) {
          return [`<li><strong>${escapeHtml(pu.pack)}</strong> (вариант ${escapeHtml(spec.name)}): <em>использование пакета не видно для этого типа пакета</em></li>`]
        }
        if (!declared) {
          return [
            `<li><strong>${escapeHtml(pu.pack)}</strong> (вариант ${escapeHtml(spec.name)}): ${String(pu.calls)} ${pluralRu(pu.calls, 'вызов', 'вызова', 'вызовов')} — чужой; любой вызов означал бы контаминацию</li>`,
          ]
        }
        const first = pu.firstCallMsMedian === undefined ? '' : `, медиана первого вызова ${escapeHtml(fmtInt(pu.firstCallMsMedian))}ms`
        const visibility =
          pu.calls !== 0 ? '' : pu.visibilityConfirmed ? ' (подтверждённо виден, не вызван)' : ' (видимость не подтверждена)'
        const without =
          pu.runsWithoutCall === undefined || pu.runsWithoutCall.length === 0
            ? ''
            : `; ни разу не вызван в ${pu.runsWithoutCall.length === 1 ? 'запуске' : 'запусках'} ${pu.runsWithoutCall.join(', ')}`
        return [
          `<li><strong>${escapeHtml(pu.pack)}</strong> (вариант ${escapeHtml(spec.name)}): ${String(pu.calls)} ${pluralRu(pu.calls, 'вызов', 'вызова', 'вызовов')}, ${String(pu.errors)} ${pluralRu(pu.errors, 'ошибка', 'ошибки', 'ошибок')}, ${String(pu.runsWithCall)}/${String(pu.runCount)} запусков вызвали пакет${first}${escapeHtml(visibility)}${escapeHtml(without)}</li>`,
        ]
      })
    })
    .join('')

const renderPackSignal = (report: Report): string => {
  const lines = packSignalLines(report)
  if (lines === '') return ''
  const footnote = (report.prep?.packs ?? []).some((p) => p.mode !== 'delivered-only')
    ? '<p><em>Вызовы пакета со стороны агента фиксируются только для контекста; в режиме exercise/installed-only они не являются мерой результата.</em></p>'
    : ''
  return `<section><h2>Использование пакетов</h2><ul>${lines}</ul>${footnote}</section>`
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const renderSafety = (report: Report): string => {
  const rows = report.manifest.variants
    .flatMap((spec) => {
      const agg = variantAggFor(report.metrics, spec.name)
      return (agg?.riskyCommands ?? []).map(
        (r) =>
          `<tr><td>${escapeHtml(spec.name)}</td><td>${String(r.runIndex)}</td><td><code>${escapeHtml(r.command)}</code></td><td>${String(r.completed)}</td><td>${r.exitCode === undefined ? '—' : String(r.exitCode)}</td></tr>`,
      )
    })
    .join('')
  if (rows === '') return ''
  return `<section><h2>Безопасность</h2><table><thead><tr><th>Вариант</th><th>Запуск</th><th>Команда</th><th>Завершено</th><th>Выход</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Contamination
// ---------------------------------------------------------------------------

/** `pack === ''` is WP7's sentinel for a variant-level signal (e.g. `install-drift`) that isn't attributable to one pack — render as "not pack-specific", not an empty-looking cell. */
const contaminationPackCell = (pack: string): string => (pack === '' ? '—' : escapeHtml(pack))

const contaminationRows = (report: Report): string =>
  report.manifest.variants
    .flatMap((spec) => {
      const agg = variantAggFor(report.metrics, spec.name)
      return (agg?.contaminationSignals ?? []).map(
        (s) =>
          `<tr><td>${escapeHtml(s.kind)}</td><td>${escapeHtml(spec.name)}</td><td>${contaminationPackCell(s.pack)}</td><td>${s.runIndex === undefined ? '—' : String(s.runIndex)}</td><td><code>${escapeHtml(s.detail)}</code></td></tr>`,
      )
    })
    .join('')

const renderContamination = (report: Report): string => {
  const rows = contaminationRows(report)
  if (rows === '') return ''
  return `<section><h2>Контаминация</h2><table><thead><tr><th>Тип</th><th>Вариант</th><th>Пакет</th><th>Запуск</th><th>Детали</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Judge / Failed runs
// ---------------------------------------------------------------------------

const renderRawResponse = (raw: string | undefined): string =>
  raw === undefined ? '' : `<details><summary>Исходный ответ модели</summary><pre>${escapeHtml(raw)}</pre></details>`

const renderJudge = (report: Report): string => {
  const j = report.judge
  if (j === undefined) {
    return '<section><h2>LLM-судья</h2><p><em>Судья не запрошен (--judge не задан)</em></p></section>'
  }
  if (j.ran === false) {
    return `<section><h2>LLM-судья</h2><p><em>Судья не был запущен: ${escapeHtml(j.explanation)}</em></p></section>`
  }
  const note = j.verdict === 'unclear' ? ' <em>(неясно)</em>' : ''
  const contaminated = report.metrics.variants.filter((v) => (v.contaminationSignals?.length ?? 0) > 0)
  const contaminationWarn =
    contaminated.length === 0
      ? ''
      : `<p class="warn">⚠ <strong>Контаминация обнаружена (${escapeHtml(contaminated.map((v) => v.variant).join(', '))}) — этот вердикт может сравнивать варианты, использовавшие пакет, который они не объявляют.</strong></p>`
  const quality = report.manifest.variants
    .map((v) => {
      const score = j.scores.find((s) => s.variant === v.name)
      return `${v.name}=${score === undefined ? 'н/д' : String(score.quality)}`
    })
    .join(', ')
  const pairwiseHtml =
    j.pairwiseFallback === true
      ? '<p class="basis"><em>Баллы получены через попарные вызовы каждого варианта против базового варианта (промпт превысил бюджет одного вызова).</em></p>'
      : ''
  return `<section><h2>LLM-судья</h2>${contaminationWarn}<p>Вердикт: <strong>${escapeHtml(j.verdict)}</strong>${note}</p><p>Ранжирование: ${escapeHtml(j.ranking.join(' > '))}</p><p>Качество: ${escapeHtml(quality)}; модель <code>${escapeHtml(j.modelUsed)}</code></p><p>${escapeHtml(j.explanation)}</p>${pairwiseHtml}${renderRawResponse(j.rawResponse)}</section>`
}

const renderFailures = (report: Report): string => {
  const failures = report.summary.failures
  if (failures.length === 0) return ''
  const warnHtml = report.metrics.allFailed
    ? '<p class="warn"><strong>⚠ Все варианты провалились — сравнение ненадёжно.</strong></p>'
    : ''
  const rows = failures
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.variant)}</td><td>${escapeHtml(String(f.runIndex))}</td><td><code>${escapeHtml(f.errorCode)}</code></td><td>${escapeHtml(f.errorMessage)}</td></tr>`,
    )
    .join('')
  return `<section><h2>Проваленные запуски</h2>${warnHtml}<table><thead><tr><th>Вариант</th><th>Запуск</th><th>Код</th><th>Сообщение</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

// ---------------------------------------------------------------------------
// Secondary metrics
// ---------------------------------------------------------------------------

const toolRows = (perTool: Readonly<Record<string, ToolStat>>): string => {
  const entries = Object.entries(perTool)
  if (entries.length === 0) return '<li><em>нет инструментов</em></li>'
  return [...entries]
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 20)
    .map(
      ([name, s]) =>
        `<li><code>${escapeHtml(name)}</code>: count=${String(s.count)} errors=${(s.errorRate * 100).toFixed(0)}% avg=${escapeHtml(fmtInt(s.avgDurationMs))}ms</li>`,
    )
    .join('')
}

const diffResultFor = (report: Report, variant: string): DiffResult | undefined =>
  report.diffs.find((d) => d.variant === variant)

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

const behaviorGroup = (sec: SecondaryMetrics): string => {
  const finish = Object.entries(sec.finishCauseDistribution)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ')
  const lines: readonly string[] = [
    `Причины завершения: ${finish || 'нет'}`,
    `Макс. серия одного инструмента подряд: ${String(sec.maxConsecutiveSameTool)}`,
    ...(sec.bashFailCount === undefined
      ? []
      : [`Провалы bash (exit != 0): ${String(sec.bashFailCount)} из ${String(sec.perTool['bash']?.count ?? 0)} вызовов (сумма по запускам)`]),
    ...(sec.invalidToolCalls === undefined || sec.duplicateToolCalls === undefined
      ? []
      : [`Невалидные вызовы инструментов: ${String(sec.invalidToolCalls)}; дублирующиеся вызовы: ${String(sec.duplicateToolCalls)} (суммы по запускам)`]),
    ...(sec.toolErrorTexts === undefined || sec.toolErrorTexts.length === 0
      ? []
      : [`Ошибки инструментов (топ): ${sec.toolErrorTexts.join('; ')}`]),
  ]
  const items = lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
  return `${items}<li>Инструменты (топ 20):<ul>${toolRows(sec.perTool)}</ul></li>`
}

const STALL_LABEL = `${String(STALL_THRESHOLD_MS / 1000)}s`

const stallSuffix = (sec: SecondaryMetrics): string =>
  sec.stallCount === undefined || sec.stalledRunCount === undefined
    ? ''
    : `; ${String(sec.stallCount)} ${pluralRu(sec.stallCount, 'простой', 'простоя', 'простоев')} дольше ${STALL_LABEL} в ${String(sec.stalledRunCount)} ${sec.stalledRunCount === 1 ? 'запуске' : 'запусках'}`

const latencyGroup = (sec: SecondaryMetrics, wallClockMs: string): string => {
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
  return lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
}

const tokensContextGroup = (sec: SecondaryMetrics): string => {
  const cacheWrite = sec.cacheWriteTokens === undefined ? '' : `, cacheWrite=${fmtInt(sec.cacheWriteTokens)}`
  const first = sec.firstStepInputTokens === undefined ? 'н/д' : `${fmtInt(sec.firstStepInputTokens)} tok`
  const last = sec.lastStepInputTokens === undefined ? 'н/д' : `${fmtInt(sec.lastStepInputTokens)} tok`
  const lines: readonly string[] = [
    `Разбивка по токенам: input=${fmtInt(sec.inputTokens)}, output=${fmtInt(sec.outputTokens)}, reasoning=${fmtInt(sec.reasoningTokens)}, cacheRead=${fmtInt(sec.cacheReadTokens)}${cacheWrite}`,
    ...(sec.firstStepInputTokens === undefined && sec.lastStepInputTokens === undefined
      ? []
      : [`Контекст: вход первого шага=${first}, вход последнего шага=${last}`]),
  ]
  return lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
}

const outputVolumeGroup = (report: Report, variant: string, sec: SecondaryMetrics): string => {
  const fds = diffTotalsFor(report, variant)
  const lines: readonly string[] = [
    `Изменения файлов: +${String(fds.add)} -${String(fds.del)} (${String(fds.files)} ${pluralRu(fds.files, 'файл', 'файла', 'файлов')})`,
    ...(sec.textChars === undefined
      ? []
      : [`Вывод: текст ${fmtInt(sec.textChars)} симв., рассуждения ${fmtInt(sec.reasoningChars ?? '0')} симв.`]),
  ]
  return lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
}

const group = (label: string, body: string, open: boolean): string =>
  `<details${open ? ' open' : ''}><summary>${escapeHtml(label)}</summary><ul>${body}</ul></details>`

const renderSecondaryVariant = (report: Report, spec: VariantSpec, agg: VariantAggregates): string => {
  const groups = [
    group('Поведение', behaviorGroup(agg.secondary), true),
    group('Задержки', latencyGroup(agg.secondary, agg.primary.wallClockMs), false),
    group('Токены и контекст', tokensContextGroup(agg.secondary), false),
    group('Объём вывода', outputVolumeGroup(report, spec.name, agg.secondary), false),
  ].join('')
  return `<div class="secondary-variant"><h3>${escapeHtml(spec.name)}: дополнительные метрики</h3>${groups}</div>`
}

const renderSecondary = (report: Report): string => {
  const note = hasAnyPhaseSplit(report)
    ? '<p class="whole-run-note"><em>Весь запуск (init + task) — без разбивки; см. неразбиваемые метрики в <code>docs/phases/07-aggregate.ru.md</code>.</em></p>'
    : ''
  const blocks = report.manifest.variants
    .flatMap((spec) => {
      const agg = variantAggFor(report.metrics, spec.name)
      return agg === undefined ? [] : [renderSecondaryVariant(report, spec, agg)]
    })
    .join('')
  return `<section><h2>Дополнительные метрики</h2>${note}${blocks}</section>`
}

// ---------------------------------------------------------------------------
// Diff summary
// ---------------------------------------------------------------------------

const stateSuffix = (state: DiffRunResult['state']): string =>
  state === 'git-restored'
    ? ' (агент удалил .git, восстановлено из чистого клона)'
    : state === 'git-replaced'
      ? ' (агент заменил .git, diff включает коммиты агента)'
      : ''

const containedRunSuffix = (report: Report, variant: string, runIndex: number): string => {
  const failed = variantAggFor(report.metrics, variant)?.failedRuns.find((f) => f.runIndex === runIndex)
  return failed === undefined
    ? ''
    : ` — <strong>учтён как проваленный</strong> (<code>${escapeHtml(failed.errorCode)}</code>; исключён из показателя «Эффективность» ниже — см. «Проваленные запуски»)`
}

const efficiencyItem = (report: Report, variant: string): string => {
  const agg = variantAggFor(report.metrics, variant)
  if (agg === undefined) return '<li>Эффективность: н/д</li>'
  const t = diffTotalsFor(report, variant)
  const sessionRunCount = agg.stats.totalTokens.samples.length
  const changedLines = t.add + t.del
  const tokensPerRun = toNum(agg.primary.totalTokens)
  const costPerRun = agg.primary.costUsd
  const tokensPerLine = changedLines === 0 ? 'н/д' : fmtInt((tokensPerRun * sessionRunCount) / changedLines)
  const costPerFile = t.files === 0 ? 'н/д' : fmtValue((costPerRun * sessionRunCount) / t.files, 'cost')
  return `<li>Эффективность: токенов на изменённую строку ${escapeHtml(tokensPerLine)}, стоимость на файл ${escapeHtml(costPerFile)} (пересчитано из медианы на запуск, по ${String(sessionRunCount)} ${sessionRunCount === 1 ? 'запуску' : 'запускам'} с сессией агента)</li>`
}

const pathsForVariant = (report: Report, variant: string): ReadonlySet<string> =>
  new Set((diffResultFor(report, variant)?.runs ?? []).flatMap((r) => r.summary.perFile.map((f) => f.path)))

const overlapItem = (report: Report, variant: string): string => {
  const basePaths = pathsForVariant(report, report.metrics.baseline)
  const vPaths = pathsForVariant(report, variant)
  const both = [...basePaths].filter((p) => vPaths.has(p)).sort()
  const onlyBase = [...basePaths].filter((p) => !vPaths.has(p)).sort()
  const onlyV = [...vPaths].filter((p) => !basePaths.has(p)).sort()
  if (both.length === 0 && onlyBase.length === 0 && onlyV.length === 0) return ''
  const cap = (list: readonly string[]): string => (list.length === 0 ? '<em>нет</em>' : list.slice(0, 15).map(escapeHtml).join(', '))
  return `<li><strong>Пересечение с базой (${escapeHtml(variant)})</strong><ul><li>Общие: ${cap(both)}</li><li>Только база: ${cap(onlyBase)}</li><li>Только ${escapeHtml(variant)}: ${cap(onlyV)}</li></ul></li>`
}

const diffItemFor = (report: Report, variant: string): string => {
  const t = diffTotalsFor(report, variant)
  const runs = diffResultFor(report, variant)?.runs ?? []
  const failedCount = runs.filter((r) => r.state === 'failed').length
  const failedSuffix = failedCount === 0 ? '' : `, из них ${String(failedCount)} ${failedCount === 1 ? 'провалился' : 'провалились'}`
  const items = runs
    .map((r) => {
      const idx = String(r.runIndex)
      if (r.state === 'failed') {
        return `<li>run-${escapeHtml(idx)}: diff не удался — <code>${escapeHtml(r.error?.message ?? 'неизвестно')}</code></li>`
      }
      const patchHref = `diff/${variant}/run-${idx}/full.patch`
      const htmlLink =
        r.htmlPath !== undefined ? ` — <a href="${escapeHtml(`diff/${variant}/run-${idx}/side.html`)}">html</a>` : ''
      return `<li>run-${escapeHtml(idx)}: +${escapeHtml(String(r.summary.additions))} -${escapeHtml(String(r.summary.deletions))} (${escapeHtml(String(r.summary.filesChanged))} ${pluralRu(r.summary.filesChanged, 'файл', 'файла', 'файлов')}) — <a href="${escapeHtml(patchHref)}">патч</a>${htmlLink}${escapeHtml(stateSuffix(r.state))}${containedRunSuffix(report, variant, r.runIndex)}</li>`
    })
    .join('')
  const totalsLine = `+${String(t.add)} -${String(t.del)} (${String(t.files)} ${pluralRu(t.files, 'файл', 'файла', 'файлов')}, ${String(runs.length)} ${pluralRu(runs.length, 'запуск', 'запуска', 'запусков')}${failedSuffix})`
  return `<li><strong>${escapeHtml(variant)}</strong>: ${escapeHtml(totalsLine)}<ul>${items}${efficiencyItem(report, variant)}</ul></li>`
}

const renderDiff = (report: Report): string => {
  const items = report.manifest.variants.map((spec) => diffItemFor(report, spec.name)).join('')
  const overlaps = report.manifest.variants
    .filter((spec) => spec.name !== report.metrics.baseline)
    .map((spec) => overlapItem(report, spec.name))
    .join('')
  return `<section><h2>Сводка по diff</h2><ul>${items}${overlaps}</ul></section>`
}

export const renderHtml = (report: Report): string => {
  const title = `Отчёт testaipack: ${report.manifest.runId}`

  const body = [
    renderHeader(report),
    renderSummary(report),
    renderPrimary(report),
    renderPhaseSplit(report),
    renderHarnessPrep(report),
    renderPackSignal(report),
    renderSafety(report),
    renderContamination(report),
    renderSecondary(report),
    renderJudge(report),
    renderFailures(report),
    renderDiff(report),
    '<section><h2>Сводка по таймлайну</h2><iframe src="timeline.html" width="100%" height="480">timeline.html недоступен</iframe></section>',
  ]
    .filter((s) => s !== '')
    .join('\n')

  return `<!doctype html>
<html lang="ru">
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
    --baseline-bg: #f5f5f7;
  }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 56rem; color: #222; line-height: 1.5; }
  h1 { font-size: 1.6rem; margin-bottom: .25rem; }
  h2 { font-size: 1.2rem; margin-top: 1.75rem; border-bottom: 1px solid #e0e0e0; padding-bottom: .25rem; }
  h3 { font-size: 1rem; margin-top: 1.25rem; }
  .meta { color: #555; font-size: .9rem; }
  .headline { font-size: 1.1rem; font-weight: 600; }
  .warn { background: var(--worse-bg); color: var(--worse-fg); padding: .5rem .75rem; border-radius: .25rem; }
  .vs-base { margin-top: .75rem; }
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
  .baseline-row { background: var(--baseline-bg); font-weight: 600; }
  .footnote { color: #555; font-size: .85rem; }
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
