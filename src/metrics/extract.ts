/**
 * Metrics: extract — turns a single opencode export into a PrimaryMetrics +
 * SecondaryMetrics snapshot. Pure function: pricing table (already loaded) is
 * passed in, successRank comes from the RunSideResult produced in phase 06.
 *
 * int64 wire fields are serialised as strings (see generated/types.ts); we
 * compute on numbers and stringify at the boundary.
 *
 * @see docs/phases/07-aggregate.ru.md
 * @see contract/main.tsp (OpencodeExport, PrimaryMetrics, SecondaryMetrics)
 */
import type {
  ExportPart,
  ExportReasoningPart,
  ExportStepFinishPart,
  ExportToolPart,
  FileDiffStats,
  OpencodeExport,
  PrimaryMetrics,
  SecondaryMetrics,
  SuccessRank,
  ToolStat,
} from '@generated/types'
import type { PricingTable } from '../pricing/lookup.js'
import { computeCost, lookupPrice } from '../pricing/lookup.js'
import { percentile, toNum } from './stats.js'

export interface ExtractedMetrics {
  readonly primary: PrimaryMetrics
  readonly secondary: SecondaryMetrics
}

const isTool = (p: ExportPart): p is ExportToolPart => p.type === 'tool'
const isReasoning = (p: ExportPart): p is ExportReasoningPart => p.type === 'reasoning'
const isStepFinish = (p: ExportPart): p is ExportStepFinishPart => p.type === 'step-finish'

const durationOf = (start: string, end: string): number => {
  const d = toNum(end) - toNum(start)
  return d > 0 ? d : 0
}

const allParts = (exp: OpencodeExport): readonly ExportPart[] =>
  exp.messages.flatMap((m) => m.parts)

const toolPartsOf = (exp: OpencodeExport): readonly ExportToolPart[] =>
  allParts(exp).filter(isTool)

const reasoningTimeMs = (exp: OpencodeExport): number =>
  allParts(exp)
    .filter(isReasoning)
    .reduce((sum, p) => sum + durationOf(p.time.start, p.time.end), 0)

const toolLatencyAverage = (tools: readonly ExportToolPart[]): number => {
  const durations = tools.flatMap((p) => {
    const t = p.state.time
    return t === undefined ? [] : [durationOf(t.start, t.end)]
  })
  return durations.length === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / durations.length
}

interface PerToolAcc {
  readonly count: number
  readonly errors: number
  readonly durSum: number
  readonly durN: number
}

type ToolMap = Readonly<Record<string, PerToolAcc>>

const perToolStats = (tools: readonly ExportToolPart[]): Readonly<Record<string, ToolStat>> => {
  const acc = tools.reduce<ToolMap>((m, p) => {
    const name = p.tool
    const prev = m[name] ?? { count: 0, errors: 0, durSum: 0, durN: 0 }
    const t = p.state.time
    const dur = t === undefined ? 0 : durationOf(t.start, t.end)
    return {
      ...m,
      [name]: {
        count: prev.count + 1,
        errors: prev.errors + (p.state.status === 'error' ? 1 : 0),
        durSum: prev.durSum + dur,
        durN: prev.durN + (t === undefined ? 0 : 1),
      },
    }
  }, {})
  return Object.entries(acc).reduce<Readonly<Record<string, ToolStat>>>((out, [name, v]) => {
    const avg = v.durN === 0 ? 0 : v.durSum / v.durN
    return {
      ...out,
      [name]: {
        count: v.count,
        errorRate: v.count === 0 ? 0 : v.errors / v.count,
        avgDurationMs: String(Math.round(avg)),
      },
    }
  }, {})
}

const finishCauseDistribution = (exp: OpencodeExport): Readonly<Record<string, number>> =>
  exp.messages.reduce<Readonly<Record<string, number>>>((m, msg) => {
    const f = msg.info.finish
    if (f === undefined) return m
    return { ...m, [f]: (m[f] ?? 0) + 1 }
  }, {})

/**
 * Per-step latency: within each message, the region between a step-start and the
 * next step-finish is one step; its duration is the sum of timed parts (reasoning
 * + tool) inside that region. step-finish parts carry no timestamp in the export
 * schema, so we approximate from the parts they bracket.
 */
const stepDurations = (exp: OpencodeExport): readonly number[] =>
  exp.messages.flatMap((m) => {
    const folded = m.parts.reduce<{
      readonly open: boolean
      readonly current: number
      readonly out: readonly number[]
    }>((st, p) => {
      if (p.type === 'step-start') return { open: true, current: 0, out: st.out }
      if (p.type === 'step-finish') {
        return st.open
          ? { open: false, current: 0, out: [...st.out, st.current] }
          : { open: false, current: 0, out: st.out }
      }
      if (!st.open) return st
      const dur =
        p.type === 'reasoning'
          ? durationOf(p.time.start, p.time.end)
          : p.type === 'tool' && p.state.time
            ? durationOf(p.state.time.start, p.state.time.end)
            : 0
      return { open: st.open, current: st.current + dur, out: st.out }
    }, { open: false, current: 0, out: [] as readonly number[] })
    return folded.out
  })

const maxConsecutiveSameTool = (parts: readonly ExportPart[]): number =>
  parts
    .reduce<{ readonly name: string | null; readonly run: number; readonly best: number }>(
      (st, p) => {
        if (p.type !== 'tool') return { name: null, run: 0, best: st.best }
        const name = p.tool
        if (st.name === name) {
          const run = st.run + 1
          return { name, run, best: Math.max(st.best, run) }
        }
        return { name, run: 1, best: Math.max(st.best, 1) }
      },
      { name: null, run: 0, best: 0 },
    ).best

const fileDiffStats = (exp: OpencodeExport): FileDiffStats => ({
  additions: exp.info.summary.additions,
  deletions: exp.info.summary.deletions,
  filesChanged: exp.info.summary.files,
})

const costFromPricing = (exp: OpencodeExport, pricing: PricingTable): number => {
  const price = lookupPrice(pricing, exp.info.model.providerID, exp.info.model.id)
  const t = exp.info.tokens
  return computeCost(price, {
    input: t.input,
    output: t.output,
    cache: { read: t.cache.read, write: t.cache.write },
  })
}

/**
 * Cost precedence (per phase 07 spec): provider-reported `info.cost` first when
 * present (> 0); otherwise compute from the pricing table (if configured and
 * loadable); otherwise 0. The caller resolves pricing into a table (or null)
 * once and passes it in.
 */
const resolveCost = (exp: OpencodeExport, pricing: PricingTable | null): number => {
  const infoCost = exp.info.cost
  return infoCost > 0 ? infoCost : pricing ? costFromPricing(exp, pricing) : 0
}

export const extractMetrics = (
  exp: OpencodeExport,
  pricing: PricingTable | null,
  successRank: SuccessRank,
): ExtractedMetrics => {
  const t = exp.info.tokens
  const totalTokens = t.input + t.output + t.reasoning + t.cache.read
  const wallClockMs = durationOf(exp.info.time.created, exp.info.time.updated)
  const tools = toolPartsOf(exp)
  const stepDur = stepDurations(exp)
  const parts = allParts(exp)

  const primary: PrimaryMetrics = {
    totalTokens: String(totalTokens),
    wallClockMs: String(Math.round(wallClockMs)),
    costUsd: resolveCost(exp, pricing),
    stepCount: parts.filter(isStepFinish).length,
    toolCallCount: tools.length,
    successRank,
    maxParallelism: 1,
  }

  const secondary: SecondaryMetrics = {
    inputTokens: String(t.input),
    outputTokens: String(t.output),
    reasoningTokens: String(t.reasoning),
    cacheReadTokens: String(t.cache.read),
    perTool: perToolStats(tools),
    reasoningTimeMs: String(Math.round(reasoningTimeMs(exp))),
    stepLatencyP50Ms: String(Math.round(percentile(stepDur, 50))),
    stepLatencyP95Ms: String(Math.round(percentile(stepDur, 95))),
    toolLatencyAvgMs: String(Math.round(toolLatencyAverage(tools))),
    finishCauseDistribution: finishCauseDistribution(exp),
    fileDiffStats: fileDiffStats(exp),
    maxConsecutiveSameTool: maxConsecutiveSameTool(parts),
  }

  return { primary, secondary }
}
