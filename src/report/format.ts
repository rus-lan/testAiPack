/**
 * Shared formatting helpers for report renderers (md, html).
 *
 * Primary metrics carry int64 values as strings on the wire (see generated
 * types); these helpers normalise them for human-readable output.
 *
 * @see docs/phases/11-report-render.ru.md
 */
import type { MetricDelta, PrimaryDeltas, PrimaryMetrics } from '@generated/types'
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

export const fmtPct = (v: number): string => {
  if (!Number.isFinite(v)) return String(v)
  const body = v.toFixed(1)
  return v > 0 ? `+${body}%` : `${body}%`
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
