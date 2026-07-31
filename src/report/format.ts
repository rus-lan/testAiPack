/**
 * Shared formatting helpers for report renderers (md, html).
 *
 * Primary metrics carry int64 values as strings on the wire (see generated
 * types); these helpers normalise them for human-readable output.
 *
 * @see docs/phases/11-report-render.ru.md
 */
import type { MetricDelta, MetricsReport, PhaseDeltas, PhaseSlice, PrimaryDeltas, PrimaryMetrics } from '@generated/types'
import { toNum } from '../util/numeric.js'

export { toNum }

export type MetricKind = 'int' | 'cost' | 'rank'

export interface PrimaryMeta {
  readonly key: keyof PrimaryDeltas & keyof PrimaryMetrics
  readonly label: string
  readonly kind: MetricKind
}

export const PRIMARY_METRICS: readonly PrimaryMeta[] = [
  { key: 'totalTokens', label: 'Total tokens', kind: 'int' },
  { key: 'wallClockMs', label: 'Wall-clock (ms)', kind: 'int' },
  { key: 'costUsd', label: 'Cost ($)', kind: 'cost' },
  { key: 'stepCount', label: 'Steps', kind: 'int' },
  { key: 'toolCallCount', label: 'Tool calls', kind: 'int' },
  { key: 'successRank', label: 'Success rank', kind: 'rank' },
  { key: 'maxParallelism', label: 'Max parallelism', kind: 'int' },
]

export interface PhaseMeta {
  readonly key: keyof PhaseDeltas & keyof PhaseSlice
  readonly label: string
  readonly kind: MetricKind
}

/**
 * The five splittable primary metrics (metric-split spec §5.7) — same
 * key/label/kind as the first five `PRIMARY_METRICS` entries, kept as its
 * own literal list (not a `.slice()`) because `PhaseSlice`/`PhaseDeltas`
 * don't carry `successRank`/`maxParallelism`, so `PrimaryMeta['key']`
 * (7-key union) isn't assignable to `keyof PhaseSlice` (5-key union).
 */
export const PHASE_METRICS: readonly PhaseMeta[] = [
  { key: 'totalTokens', label: 'Total tokens', kind: 'int' },
  { key: 'wallClockMs', label: 'Wall-clock (ms)', kind: 'int' },
  { key: 'costUsd', label: 'Cost ($)', kind: 'cost' },
  { key: 'stepCount', label: 'Steps', kind: 'int' },
  { key: 'toolCallCount', label: 'Tool calls', kind: 'int' },
]

/** `successRank`/`maxParallelism` never split into init/task (spec §3: whole-run verdicts). */
const WHOLE_RUN_ONLY_METRICS = PRIMARY_METRICS.filter((m) => m.key === 'successRank' || m.key === 'maxParallelism')

export interface DeltaEntry {
  readonly key: string
  readonly label: string
  readonly kind: MetricKind
  readonly d: MetricDelta
}

/**
 * Entries feeding the headline and the improvement/regression/neutral
 * buckets for ONE (baseline, variant) pair, on whichever basis that pair
 * supports — task (metric-split spec §5.6, §6: decided, always, in every
 * configuration a split exists for) is the five phase deltas plus the two
 * metrics that never split, still read from the pair's whole-run `deltas`;
 * total (pre-split behavior) is all seven `PRIMARY_METRICS` read from
 * `deltas`, used only when no split is available at all. Basis is decided
 * PER PAIR (`03-hard-problems.md` §1.2) — a report can legitimately show one
 * variant on task basis and another on total basis. Shared by
 * `cli/summary.ts` (builds `ReportSummary`) and the md/html renderers
 * (render the Summary section), so both read the identical basis rule off
 * the same `MetricsReport`.
 */
export const deltaEntriesFor = (
  metrics: MetricsReport,
  variant: string,
): { readonly entries: readonly DeltaEntry[]; readonly basis: 'task' | 'total' } => {
  const delta = metrics.deltas.find((d) => d.variant === variant)
  if (delta === undefined) {
    return { basis: 'total', entries: [] }
  }
  if (delta.taskDeltas === undefined) {
    return {
      basis: 'total',
      entries: PRIMARY_METRICS.map((m) => ({ key: m.key, label: m.label, kind: m.kind, d: delta.deltas[m.key] })),
    }
  }
  const taskDeltas = delta.taskDeltas
  return {
    basis: 'task',
    entries: [
      ...PHASE_METRICS.map((m) => ({ key: m.key, label: m.label, kind: m.kind, d: taskDeltas[m.key] })),
      ...WHOLE_RUN_ONLY_METRICS.map((m) => ({ key: m.key, label: m.label, kind: m.kind, d: delta.deltas[m.key] })),
    ],
  }
}

export const trimTrailingZeros = (s: string): string => s.replace(/0+$/, '').replace(/\.$/, '')

export const fmtInt = (v: string | number): string => {
  const n = toNum(v)
  return Number.isFinite(n) ? String(Math.round(n)) : String(v)
}

export const fmtCost = (v: number): string => {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  return trimTrailingZeros(v.toFixed(4))
}

export const fmtValue = (v: string | number, kind: MetricKind): string =>
  kind === 'cost' ? fmtCost(toNum(v)) : fmtInt(v)

export const fmtSigned = (v: number, kind: MetricKind): string => {
  if (!Number.isFinite(v)) return String(v)
  const body =
    kind === 'cost' ? trimTrailingZeros(Math.abs(v).toFixed(4)) : String(Math.round(Math.abs(v)))
  if (v > 0) return `+${body}`
  if (v < 0) return `-${body}`
  return body
}

export const fmtPct = (v: number | undefined): string => {
  if (v === undefined) return 'n/a'
  if (!Number.isFinite(v)) return String(v)
  const body = v.toFixed(1)
  return v > 0 ? `+${body}%` : `${body}%`
}

/**
 * Millisecond duration with a minutes hint above one minute — plain "ms" at
 * six figures (e.g. "252915ms") does not read as "four minutes" on a skim.
 */
export const fmtDurationMs = (v: string | number): string => {
  const ms = toNum(v)
  const msPart = fmtInt(ms)
  if (!Number.isFinite(ms) || ms < 60_000) return `${msPart}ms`
  return `${msPart}ms (~${(ms / 60_000).toFixed(1)}min)`
}

const VERDICT_MAP: Record<MetricDelta['better'], string> = {
  better: '✓ better',
  worse: '⚠ worse',
  neutral: '= same',
  'context-dependent': '≈ ctx',
}

export const verdictFor = (d: MetricDelta): string => VERDICT_MAP[d.better]

export const sigLabel = (d: MetricDelta): string => {
  if (d.significant) {
    if (d.better === 'better') return '✓ significant'
    if (d.better === 'worse') return '⚠ significant'
    return 'significant'
  }
  return d.better === 'neutral' ? '—' : 'in noise'
}
