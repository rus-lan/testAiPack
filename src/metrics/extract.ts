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

/**
 * One node of a session tree (root + sub-agents spawned via the `task` tool,
 * linked through the opencode `session.parent_id` column). Carries the node's
 * own export so metric extraction can fold over the whole tree. `depth`/`parentId`
 * mirror the `TimelineEvent` swimlane fields; `children` is left empty by the
 * loader because the flat list + `parentId` already encode the structure.
 */
export interface SessionTreeNode {
  readonly sessionId: string
  readonly parentId: string | null
  readonly depth: number
  readonly export: OpencodeExport
  readonly children: readonly SessionTreeNode[]
}

/**
 * Max number of sessions simultaneously active across the tree, via a sweep
 * line over `[timeCreated, timeUpdated]` intervals. The sort tiebreaker puts
 * closes (delta -1) before opens (delta +1) at the same timestamp, so a session
 * that ends exactly when another starts counts as non-overlapping (end = start
 * → parallelism 1, not 2). Pure; table-tested.
 */
export const computeMaxParallelism = (
  sessions: readonly { readonly timeCreated: number; readonly timeUpdated: number }[],
): number => {
  if (sessions.length === 0) return 0
  const events = sessions.flatMap((s): readonly { readonly t: number; readonly delta: number }[] => [
    { t: s.timeCreated, delta: 1 },
    { t: s.timeUpdated, delta: -1 },
  ])
  const sorted = [...events].sort((a, b) => a.t - b.t || a.delta - b.delta)
  return sorted.reduce<{ readonly cur: number; readonly max: number }>(
    (acc, e) => {
      const cur = acc.cur + e.delta
      return { cur, max: cur > acc.max ? cur : acc.max }
    },
    { cur: 0, max: 0 },
  ).max
}

const isTool = (p: ExportPart): p is ExportToolPart => p.type === 'tool'
const isReasoning = (p: ExportPart): p is ExportReasoningPart => p.type === 'reasoning'
const isStepFinish = (p: ExportPart): p is ExportStepFinishPart => p.type === 'step-finish'

const durationOf = (start: number | string, end: number | string): number => {
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
      const dur = isReasoning(p)
        ? durationOf(p.time.start, p.time.end)
        : isTool(p) && p.state.time
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
        if (!isTool(p)) return { name: null, run: 0, best: st.best }
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
    maxParallelism: computeMaxParallelism([
      { timeCreated: toNum(exp.info.time.created), timeUpdated: toNum(exp.info.time.updated) },
    ]),
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

// ---------------------------------------------------------------------------
// Tree aggregation (v0.2): fold primary/secondary metrics over a session tree
// ---------------------------------------------------------------------------

const emptySecondaryMetrics = (): SecondaryMetrics => ({
  inputTokens: '0',
  outputTokens: '0',
  reasoningTokens: '0',
  cacheReadTokens: '0',
  perTool: {},
  reasoningTimeMs: '0',
  stepLatencyP50Ms: '0',
  stepLatencyP95Ms: '0',
  toolLatencyAvgMs: '0',
  finishCauseDistribution: {},
  fileDiffStats: { additions: 0, deletions: 0, filesChanged: 0 },
  maxConsecutiveSameTool: 0,
})

interface PerToolMerge {
  readonly count: number
  readonly errors: number
  readonly durSum: number
}

/** Sum per-tool counts across nodes; errorRate/avgDuration become count-weighted. */
const mergePerToolNodes = (
  records: readonly Readonly<Record<string, ToolStat>>[],
): Readonly<Record<string, ToolStat>> => {
  const acc = records.reduce<Readonly<Record<string, PerToolMerge>>>(
    (out, rec) =>
      Object.entries(rec).reduce<Readonly<Record<string, PerToolMerge>>>(
        (inner, [name, stat]) => {
          const prev = inner[name] ?? { count: 0, errors: 0, durSum: 0 }
          return {
            ...inner,
            [name]: {
              count: prev.count + stat.count,
              errors: prev.errors + Math.round(stat.errorRate * stat.count),
              durSum: prev.durSum + toNum(stat.avgDurationMs) * stat.count,
            },
          }
        },
        out,
      ),
    {},
  )
  return Object.entries(acc).reduce<Readonly<Record<string, ToolStat>>>(
    (out, [name, v]) => ({
      ...out,
      [name]: {
        count: v.count,
        errorRate: v.count === 0 ? 0 : v.errors / v.count,
        avgDurationMs: String(v.count === 0 ? 0 : Math.round(v.durSum / v.count)),
      },
    }),
    {},
  )
}

const mergeFinishCauseNodes = (
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> =>
  records.reduce<Record<string, number>>(
    (out, rec) =>
      Object.entries(rec).reduce<Record<string, number>>(
        (inner, [k, v]) => ({ ...inner, [k]: (inner[k] ?? 0) + v }),
        out,
      ),
    {},
  )

const sumStr = (list: readonly SecondaryMetrics[], sel: (s: SecondaryMetrics) => string): string =>
  String(list.reduce((a, s) => a + toNum(sel(s)), 0))

const maxStr = (list: readonly SecondaryMetrics[], sel: (s: SecondaryMetrics) => string): string =>
  String(Math.round(list.reduce((m, s) => Math.max(m, toNum(sel(s))), 0)))

const mergeSecondaryAcrossNodes = (list: readonly SecondaryMetrics[]): SecondaryMetrics => {
  if (list.length === 0) return emptySecondaryMetrics()
  return {
    inputTokens: sumStr(list, (s) => s.inputTokens),
    outputTokens: sumStr(list, (s) => s.outputTokens),
    reasoningTokens: sumStr(list, (s) => s.reasoningTokens),
    cacheReadTokens: sumStr(list, (s) => s.cacheReadTokens),
    perTool: mergePerToolNodes(list.map((s) => s.perTool)),
    reasoningTimeMs: sumStr(list, (s) => s.reasoningTimeMs),
    stepLatencyP50Ms: maxStr(list, (s) => s.stepLatencyP50Ms),
    stepLatencyP95Ms: maxStr(list, (s) => s.stepLatencyP95Ms),
    toolLatencyAvgMs: maxStr(list, (s) => s.toolLatencyAvgMs),
    finishCauseDistribution: mergeFinishCauseNodes(list.map((s) => s.finishCauseDistribution)),
    fileDiffStats: {
      additions: list.reduce((a, s) => a + s.fileDiffStats.additions, 0),
      deletions: list.reduce((a, s) => a + s.fileDiffStats.deletions, 0),
      filesChanged: list.reduce((a, s) => a + s.fileDiffStats.filesChanged, 0),
    },
    maxConsecutiveSameTool: list.reduce((m, s) => Math.max(m, s.maxConsecutiveSameTool), 0),
  }
}

/**
 * Fold metrics over a whole session tree (root + sub-agents):
 * - totalTokens / costUsd / stepCount / toolCallCount: SUM across nodes.
 * - wallClockMs: outer envelope (max updated − min created over the tree).
 * - maxParallelism: sweep-line over node intervals.
 * - successRank: taken from the argument (root-owned; a crashed root sinks the tree).
 * - secondary: token counts / reasoning time / perTool / finishCause / fileDiff
 *   summed, latencies maxed.
 *
 * For a single-node tree this is identical to {@link extractMetrics}.
 */
export const extractMetricsFromTree = (
  tree: readonly SessionTreeNode[],
  pricing: PricingTable | null,
  successRank: SuccessRank,
): ExtractedMetrics => {
  if (tree.length === 0) {
    return {
      primary: {
        totalTokens: '0',
        wallClockMs: '0',
        costUsd: 0,
        stepCount: 0,
        toolCallCount: 0,
        successRank,
        maxParallelism: 0,
      },
      secondary: emptySecondaryMetrics(),
    }
  }
  const perNode = tree.map((n) => extractMetrics(n.export, pricing, successRank))
  const intervals = tree.map((n) => ({
    timeCreated: toNum(n.export.info.time.created),
    timeUpdated: toNum(n.export.info.time.updated),
  }))
  const minCreated = Math.min(...intervals.map((i) => i.timeCreated))
  const maxUpdated = Math.max(...intervals.map((i) => i.timeUpdated))
  const envelopeMs = Math.max(0, maxUpdated - minCreated)

  const primary: PrimaryMetrics = {
    totalTokens: String(perNode.reduce((a, p) => a + toNum(p.primary.totalTokens), 0)),
    wallClockMs: String(Math.round(envelopeMs)),
    costUsd: perNode.reduce((a, p) => a + p.primary.costUsd, 0),
    stepCount: perNode.reduce((a, p) => a + p.primary.stepCount, 0),
    toolCallCount: perNode.reduce((a, p) => a + p.primary.toolCallCount, 0),
    successRank,
    maxParallelism: computeMaxParallelism(intervals),
  }

  return { primary, secondary: mergeSecondaryAcrossNodes(perNode.map((p) => p.secondary)) }
}
