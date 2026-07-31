/**
 * Metrics: extract — turns a single opencode export into a PrimaryMetrics +
 * SecondaryMetrics snapshot. Pure function: pricing table (already loaded) is
 * passed in, successRank comes from the RunResult produced in phase 06.
 *
 * int64 wire fields are serialised as strings (see generated/types.ts); we
 * compute on numbers and stringify at the boundary.
 *
 * @see docs/phases/07-aggregate.ru.md
 * @see contract/main.tsp (OpencodeExport, PrimaryMetrics, SecondaryMetrics)
 */
import type {
  ExportMessage,
  ExportPart,
  ExportToolPart,
  OpencodeExport,
  PrimaryMetrics,
  RiskyCommand,
  SecondaryMetrics,
  SuccessRank,
  ToolStat,
} from '@generated/types'
import type { PricingTable } from '../pricing/lookup.js'
import { computeCost, lookupPrice } from '../pricing/lookup.js'
import { isRecord } from '../util/types.js'
import { isReasoning, isStepFinish, isText, isTool } from './parts.js'
import { findRiskyCommand } from './risky-commands.js'
import { findPackActivitySignals } from './baseline-contamination.js'
import type { UnindexedSignal } from './baseline-contamination.js'
import { percentile, toNum } from './stats.js'

/**
 * Per-run signals outside primary/secondary: pack usage, dangerous commands,
 * hallucinated/duplicate tool calls, bash failures, and the wave-2 latency/
 * context/output signals. Aggregation across runs (sum/median/max/concat)
 * lives in `metrics/aggregate.ts`.
 */
export interface ExtractedExtras {
  /** Keyed by pack name — one entry per name in the `packNames` option this run was extracted with. */
  readonly packCalls: Readonly<Record<string, number>>
  readonly packErrors: Readonly<Record<string, number>>
  /** Keyed by pack name; a name with no call at all has no key (mirrors the old single-pack `undefined`). */
  readonly firstPackCallMs: Readonly<Record<string, number>>
  readonly invalidToolCalls: number
  readonly duplicateToolCalls: number
  readonly bashFailCount: number
  readonly toolErrorTexts: readonly string[]
  readonly riskyCommands: readonly Omit<RiskyCommand, 'runIndex'>[]
  /**
   * Keyed by pack name — variant-neutral: this module scans for every pack
   * name it is given, regardless of which (if any) that variant declares.
   * Whether a name's signals count as contamination for a given variant is
   * a judgment `metrics/aggregate.ts` makes from that variant's foreign set
   * — see `baseline-contamination.ts`.
   */
  readonly packActivitySignals: Readonly<Record<string, readonly UnindexedSignal[]>>
  readonly opencodeVersion: string
  readonly firstStepInputTokens: number | undefined
  readonly lastStepInputTokens: number | undefined
  readonly textChars: number
  readonly reasoningChars: number
  readonly cacheWriteTokens: number
}

export interface ExtractedMetrics {
  readonly primary: PrimaryMetrics
  readonly secondary: SecondaryMetrics
  readonly extras: ExtractedExtras
  /**
   * Split of the five splittable primary metrics between the `--init` and
   * `--prompt` invocations that share this export (metric-split spec §2/§3).
   * `task` is always present — a run with no init IS the task, whole. `init`
   * only exists when the export's message list has a second user turn (a
   * boundary). Numbers, not wire strings — the caller stringifies at the
   * wire boundary, same convention as the rest of this module.
   */
  readonly phases: ExtractedPhases
}

export interface ExtractOptions {
  /**
   * The full pack registry for this run (every pack any variant declares,
   * not just this run's own variant) — extraction stays variant-neutral, so
   * it scans for every name it is given; `aggregate.ts` later decides which
   * names are this variant's own vs. foreign. Absent/empty for the
   * degenerate no-pack case (smoke test, `03-hard-problems.md §3.3`).
   */
  readonly packNames?: readonly string[]
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
  const swept = sorted.reduce<{ readonly cur: number; readonly max: number }>(
    (acc, e) => {
      const cur = acc.cur + e.delta
      return { cur, max: cur > acc.max ? cur : acc.max }
    },
    { cur: 0, max: 0 },
  ).max
  // At least one session is present, so at least one was active — the
  // close-before-open tiebreak (see above) can otherwise read a zero-duration
  // session (timeCreated === timeUpdated) as never having been open at all.
  return Math.max(1, swept)
}

const isInvalid = (p: ExportToolPart): boolean => p.tool === 'invalid'

const durationOf = (start: number | string, end: number | string | undefined): number => {
  const d = toNum(end) - toNum(start)
  return d > 0 ? d : 0
}

/**
 * A tool's `state.time.end` can be absent (an interrupted call). Distinguishes
 * "no measurement" from "0ms measurement" so an average's denominator counts
 * only calls that actually finished.
 */
const measuredToolDuration = (
  t: ExportToolPart['state']['time'],
): { readonly dur: number; readonly measured: boolean } =>
  t !== undefined && t.end !== undefined
    ? { dur: durationOf(t.start, t.end), measured: true }
    : { dur: 0, measured: false }

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
    const { dur, measured } = measuredToolDuration(p.state.time)
    return measured ? [dur] : []
  })
  return durations.length === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / durations.length
}

interface PerToolAcc {
  readonly count: number
  readonly errors: number
  readonly durSum: number
  readonly durN: number
}

interface ToolRunFold {
  readonly key: string | null
  readonly acc: PerToolAcc
  readonly out: readonly (readonly [string, PerToolAcc])[]
}

const EMPTY_TOOL_ACC: PerToolAcc = { count: 0, errors: 0, durSum: 0, durN: 0 }

const flushToolRun = (fold: ToolRunFold): readonly (readonly [string, PerToolAcc])[] =>
  fold.key === null ? fold.out : [...fold.out, [fold.key, fold.acc] as const]

/**
 * Groups tool parts by name in one pass over a copy sorted by name: the
 * output list only grows on a name change (bounded by distinct tool count),
 * not once per part, so this stays O(n log n) instead of the "spread the
 * whole map every part" O(n^2) shape.
 */
const groupToolRuns = (tools: readonly ExportToolPart[]): readonly (readonly [string, PerToolAcc])[] => {
  const sorted = [...tools].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0))
  const folded = sorted.reduce<ToolRunFold>((fold, p) => {
    const { dur, measured } = measuredToolDuration(p.state.time)
    const hasDur = measured ? 1 : 0
    const isError = p.state.status === 'error' ? 1 : 0
    if (fold.key === p.tool) {
      return {
        ...fold,
        acc: {
          count: fold.acc.count + 1,
          errors: fold.acc.errors + isError,
          durSum: fold.acc.durSum + dur,
          durN: fold.acc.durN + hasDur,
        },
      }
    }
    return {
      key: p.tool,
      acc: { count: 1, errors: isError, durSum: dur, durN: hasDur },
      out: flushToolRun(fold),
    }
  }, { key: null, acc: EMPTY_TOOL_ACC, out: [] })
  return flushToolRun(folded)
}

const perToolStats = (tools: readonly ExportToolPart[]): Readonly<Record<string, ToolStat>> =>
  Object.fromEntries(
    groupToolRuns(tools).map(([name, v]): readonly [string, ToolStat] => {
      const avg = v.durN === 0 ? 0 : v.durSum / v.durN
      return [
        name,
        {
          count: v.count,
          errorRate: v.count === 0 ? 0 : v.errors / v.count,
          avgDurationMs: String(Math.round(avg)),
        },
      ]
    }),
  )

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
      // No shared guard for step-start: this is its only reader anywhere in
      // the codebase, and it never reads a field off the part beyond `type`.
      if (p.type === 'step-start') return { open: true, current: 0, out: st.out }
      if (isStepFinish(p)) {
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
        if (!isTool(p)) return st
        const name = p.tool
        if (st.name === name) {
          const run = st.run + 1
          return { name, run, best: Math.max(st.best, run) }
        }
        return { name, run: 1, best: Math.max(st.best, 1) }
      },
      { name: null, run: 0, best: 0 },
    ).best

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

const TOOL_ERROR_TEXT_MAX = 200
const RISKY_COMMAND_MAX = 300

const metadataExit = (state: ExportToolPart['state']): number | undefined => {
  const exit = isRecord(state.metadata) ? state.metadata['exit'] : undefined
  return typeof exit === 'number' ? exit : undefined
}

const isSkillCall = (p: ExportToolPart, packName: string): boolean =>
  p.tool === 'skill' && isRecord(p.state.input) && p.state.input['name'] === packName

interface PackUseRaw {
  readonly calls: number
  readonly errors: number
  readonly firstMs: number | undefined
}

const packUseOfName = (exp: OpencodeExport, tools: readonly ExportToolPart[], packName: string): PackUseRaw => {
  const matches = tools.filter((p) => isSkillCall(p, packName))
  const first = matches[0]
  const firstMs =
    first?.state.time === undefined ? undefined : toNum(first.state.time.start) - toNum(exp.info.time.created)
  return {
    calls: matches.length,
    errors: matches.filter((p) => p.state.status === 'error').length,
    firstMs,
  }
}

/** One pass per pack name in the registry — extraction itself stays variant-neutral (see `ExtractOptions.packNames`). */
const packUsesOf = (
  exp: OpencodeExport,
  tools: readonly ExportToolPart[],
  packNames: readonly string[],
): {
  readonly calls: Readonly<Record<string, number>>
  readonly errors: Readonly<Record<string, number>>
  readonly firstMs: Readonly<Record<string, number>>
} => {
  const perName = packNames.map((name) => ({ name, raw: packUseOfName(exp, tools, name) }))
  return {
    calls: Object.fromEntries(perName.map(({ name, raw }) => [name, raw.calls])),
    errors: Object.fromEntries(perName.map(({ name, raw }) => [name, raw.errors])),
    firstMs: Object.fromEntries(
      perName.flatMap(({ name, raw }) => (raw.firstMs === undefined ? [] : [[name, raw.firstMs] as const])),
    ),
  }
}

/**
 * `p.state.input` can be absent (a pending call has no input yet).
 * `JSON.stringify(undefined)` is the JS value `undefined`, not a string, so
 * interpolating it would render every input-less call as the literal text
 * `undefined` — two different input-less calls of the same tool would then
 * collide into a false duplicate. Keying on `callID` instead (unique per
 * call) keeps each one distinct.
 */
const duplicateKeyOf = (p: ExportToolPart): string =>
  p.state.input === undefined
    ? `${p.tool}\x00no-input\x00${p.callID}`
    : `${p.tool}\x00${JSON.stringify(p.state.input)}`

const duplicateToolCallsOf = (tools: readonly ExportToolPart[]): number => {
  const counts = tools.reduce<Readonly<Record<string, number>>>((m, p) => {
    const key = duplicateKeyOf(p)
    return { ...m, [key]: (m[key] ?? 0) + 1 }
  }, {})
  return Object.values(counts).reduce((sum, c) => sum + Math.max(0, c - 1), 0)
}

const riskyCommandsOf = (tools: readonly ExportToolPart[]): readonly Omit<RiskyCommand, 'runIndex'>[] =>
  tools.flatMap((p) => {
    if (p.tool !== 'bash' || !isRecord(p.state.input)) return []
    const command = p.state.input['command']
    if (typeof command !== 'string' || !findRiskyCommand(command)) return []
    const exitCode = metadataExit(p.state)
    return [
      {
        command: command.slice(0, RISKY_COMMAND_MAX),
        completed: p.state.status === 'completed',
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    ]
  })

/**
 * First/last `step-finish` `tokens.input` in message order. Last skips a
 * trailing zero-usage step (real data: a final step-finish can carry
 * `tokens.input: 0`, which is not a real "final context size" reading) and
 * falls back to the literal last part when every one is zero/undefined.
 */
const stepInputTokensOf = (
  exp: OpencodeExport,
): { readonly first: number | undefined; readonly last: number | undefined } => {
  const steps = allParts(exp).filter(isStepFinish)
  const first = steps[0]?.tokens?.input
  const lastPositive = [...steps].reverse().find((p) => (p.tokens?.input ?? 0) > 0)
  const lastFallback = steps[steps.length - 1]
  const last = (lastPositive ?? lastFallback)?.tokens?.input
  return { first, last }
}

// ---------------------------------------------------------------------------
// Phase split (metric-split spec §2/§3): the boundary between the `--init`
// and `--prompt` opencode invocations that share one export.
// ---------------------------------------------------------------------------

export interface ExportPhaseBoundary {
  /** Index of the export's 2nd `user`-role message (`U[1]`). */
  readonly boundaryIndex: number
  /** That message's `info.time.created`. */
  readonly boundaryTs: number
}

/**
 * The boundary marker: the second `user`-role message of the export (spec
 * §2.1). `undefined` for 0 or 1 user messages (no init ran, or the export
 * only ever saw one CLI invocation) — the whole export is then the task
 * slice. A 3rd+ user message (never observed; the harness only ever issues
 * two CLI turns) still yields `U[1]` — everything from the 2nd turn onward
 * belongs to the `--prompt` invocation.
 */
export const findPhaseBoundary = (exp: OpencodeExport): ExportPhaseBoundary | undefined => {
  const userIndexes = exp.messages.flatMap((m, i) => (m.info.role === 'user' ? [i] : []))
  const boundaryIndex = userIndexes[1]
  if (boundaryIndex === undefined) return undefined
  const boundaryTs = toNum(exp.messages[boundaryIndex]?.info.time.created ?? 0)
  return { boundaryIndex, boundaryTs }
}

/** One phase's share of the five splittable primary metrics — numbers, stringified at the wire boundary by the caller. */
export interface PhaseSliceNum {
  readonly totalTokens: number
  readonly wallClockMs: number
  readonly costUsd: number
  readonly stepCount: number
  readonly toolCallCount: number
  /** True when `costUsd` came from prorating the session's reported cost by token share, not from measured per-message costs. */
  readonly costProrated: boolean
}

export interface ExtractedPhases {
  readonly init?: PhaseSliceNum
  readonly task: PhaseSliceNum
}

const ZERO_PHASE_SLICE: PhaseSliceNum = {
  totalTokens: 0,
  wallClockMs: 0,
  costUsd: 0,
  stepCount: 0,
  toolCallCount: 0,
  costProrated: false,
}

interface SliceTokenSums {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

const ZERO_SLICE_TOKENS: SliceTokenSums = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

/** Per-message `info.tokens` is optional (only assistant messages carry usage) — absent sums as zero. */
const sumMessageTokens = (messages: readonly ExportMessage[]): SliceTokenSums =>
  messages.reduce<SliceTokenSums>((acc, m) => {
    const t = m.info.tokens
    return t === undefined
      ? acc
      : {
          input: acc.input + t.input,
          output: acc.output + t.output,
          reasoning: acc.reasoning + t.reasoning,
          cacheRead: acc.cacheRead + t.cache.read,
          cacheWrite: acc.cacheWrite + t.cache.write,
        }
  }, ZERO_SLICE_TOKENS)

interface SliceRaw {
  readonly totalTokens: number
  readonly stepCount: number
  readonly toolCallCount: number
  /** Sum of per-message `info.cost` — 0 when every message in the slice carries none (or all zero). */
  readonly messageCostSum: number
  readonly tokens: SliceTokenSums
}

/** Same total-tokens formula as the whole-run one (`extractMetrics`): input + output + reasoning + cache.read, no cache.write. */
const sliceRawOf = (messages: readonly ExportMessage[]): SliceRaw => {
  const parts = messages.flatMap((m) => m.parts)
  const tokens = sumMessageTokens(messages)
  return {
    totalTokens: tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead,
    stepCount: parts.filter(isStepFinish).length,
    toolCallCount: parts.filter(isTool).length,
    messageCostSum: messages.reduce((sum, m) => sum + (m.info.cost ?? 0), 0),
    tokens,
  }
}

/**
 * Slice cost precedence (spec §3): measured per-message costs first; else,
 * when the session as a whole has a real provider-reported cost but the
 * per-message breakdown is all zero, prorate that real total by the slice's
 * share of the whole-run token count (flagged `costProrated` — a derived
 * figure, never presented as measured); else fall back to the pricing table
 * over the slice's own token sums (same as the whole-run `resolveCost`);
 * else 0.
 */
const resolveSliceCost = (
  exp: OpencodeExport,
  pricing: PricingTable | null,
  raw: SliceRaw,
  wholeTotalTokens: number,
): { readonly costUsd: number; readonly prorated: boolean } => {
  if (raw.messageCostSum > 0) return { costUsd: raw.messageCostSum, prorated: false }
  const sessionCost = exp.info.cost
  if (sessionCost > 0) {
    const share = wholeTotalTokens > 0 ? raw.totalTokens / wholeTotalTokens : 0
    return { costUsd: sessionCost * share, prorated: true }
  }
  if (pricing) {
    const price = lookupPrice(pricing, exp.info.model.providerID, exp.info.model.id)
    const costUsd = computeCost(price, {
      input: raw.tokens.input,
      output: raw.tokens.output,
      cache: { read: raw.tokens.cacheRead, write: raw.tokens.cacheWrite },
    })
    return { costUsd, prorated: false }
  }
  return { costUsd: 0, prorated: false }
}

const sliceOf = (
  exp: OpencodeExport,
  pricing: PricingTable | null,
  messages: readonly ExportMessage[],
  wallClockMs: number,
  wholeTotalTokens: number,
): PhaseSliceNum => {
  const raw = sliceRawOf(messages)
  const cost = resolveSliceCost(exp, pricing, raw, wholeTotalTokens)
  return {
    totalTokens: raw.totalTokens,
    wallClockMs,
    costUsd: cost.costUsd,
    stepCount: raw.stepCount,
    toolCallCount: raw.toolCallCount,
    costProrated: cost.prorated,
  }
}

/**
 * Splits one export's messages at the phase boundary (spec §2). No boundary
 * (0–1 user messages) -> the whole export is the task slice, `init` absent.
 * Wall-clock partitions exactly by construction: `boundaryTs − created` +
 * `updated − boundaryTs` = `updated − created` (spec §2.3); the inter-
 * invocation CLI-startup gap lands in the task slice by the same convention
 * the whole-run `wallClockMs` already uses.
 */
const buildPhaseSlices = (exp: OpencodeExport, pricing: PricingTable | null): ExtractedPhases => {
  const boundary = findPhaseBoundary(exp)
  const whole = sliceRawOf(exp.messages)
  if (boundary === undefined) {
    const wallClockMs = durationOf(exp.info.time.created, exp.info.time.updated)
    return { task: sliceOf(exp, pricing, exp.messages, wallClockMs, whole.totalTokens) }
  }
  const initMessages = exp.messages.slice(0, boundary.boundaryIndex)
  const taskMessages = exp.messages.slice(boundary.boundaryIndex)
  const initWallClockMs = durationOf(exp.info.time.created, boundary.boundaryTs)
  const taskWallClockMs = durationOf(boundary.boundaryTs, exp.info.time.updated)
  return {
    init: sliceOf(exp, pricing, initMessages, initWallClockMs, whole.totalTokens),
    task: sliceOf(exp, pricing, taskMessages, taskWallClockMs, whole.totalTokens),
  }
}

const extractExtras = (exp: OpencodeExport, opts: ExtractOptions): ExtractedExtras => {
  const tools = toolPartsOf(exp)
  const packNames = opts.packNames ?? []
  const pack = packUsesOf(exp, tools, packNames)
  const { first: firstStepInputTokens, last: lastStepInputTokens } = stepInputTokensOf(exp)
  const parts = allParts(exp)
  return {
    packCalls: pack.calls,
    packErrors: pack.errors,
    firstPackCallMs: pack.firstMs,
    invalidToolCalls: tools.filter(isInvalid).length,
    duplicateToolCalls: duplicateToolCallsOf(tools),
    bashFailCount: tools.filter(
      (p) => p.tool === 'bash' && metadataExit(p.state) !== undefined && metadataExit(p.state) !== 0,
    ).length,
    toolErrorTexts: tools.flatMap((p) =>
      typeof p.state.error === 'string' ? [p.state.error.slice(0, TOOL_ERROR_TEXT_MAX)] : [],
    ),
    riskyCommands: riskyCommandsOf(tools),
    packActivitySignals: Object.fromEntries(packNames.map((name) => [name, findPackActivitySignals(tools, name)])),
    opencodeVersion: exp.info.version,
    firstStepInputTokens,
    lastStepInputTokens,
    textChars: parts.filter(isText).reduce((sum, p) => sum + p.text.length, 0),
    reasoningChars: parts.filter(isReasoning).reduce((sum, p) => sum + p.text.length, 0),
    cacheWriteTokens: exp.info.tokens.cache.write,
  }
}

export const extractMetrics = (
  exp: OpencodeExport,
  pricing: PricingTable | null,
  successRank: SuccessRank,
  opts: ExtractOptions = {},
): ExtractedMetrics => {
  const t = exp.info.tokens
  const totalTokens = t.input + t.output + t.reasoning + t.cache.read
  const wallClockMs = durationOf(exp.info.time.created, exp.info.time.updated)
  const tools = toolPartsOf(exp)
  const realTools = tools.filter((p) => !isInvalid(p))
  const stepDur = stepDurations(exp)
  const parts = allParts(exp)
  const realParts = parts.filter((p) => !(isTool(p) && isInvalid(p)))

  const primary: PrimaryMetrics = {
    totalTokens: String(totalTokens),
    wallClockMs: String(Math.round(wallClockMs)),
    costUsd: resolveCost(exp, pricing),
    stepCount: parts.filter(isStepFinish).length,
    toolCallCount: tools.length,
    successRank,
    // A single export is a single session — parallelism (sessions running at
    // once) is a tree-level concept, only meaningful across siblings. See
    // extractMetricsFromTree's own computeMaxParallelism call for that case.
    maxParallelism: 1,
  }

  const secondary: SecondaryMetrics = {
    inputTokens: String(t.input),
    outputTokens: String(t.output),
    reasoningTokens: String(t.reasoning),
    cacheReadTokens: String(t.cache.read),
    // Hallucinated tool calls ("invalid") are not real tools — excluded here
    // and from maxConsecutiveSameTool; invalidToolCalls (extras) counts them.
    perTool: perToolStats(realTools),
    reasoningTimeMs: String(Math.round(reasoningTimeMs(exp))),
    stepLatencyP50Ms: String(Math.round(percentile(stepDur, 50))),
    stepLatencyP95Ms: String(Math.round(percentile(stepDur, 95))),
    toolLatencyAvgMs: String(Math.round(toolLatencyAverage(tools))),
    finishCauseDistribution: finishCauseDistribution(exp),
    maxConsecutiveSameTool: maxConsecutiveSameTool(realParts),
  }

  return { primary, secondary, extras: extractExtras(exp, opts), phases: buildPhaseSlices(exp, pricing) }
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
    maxConsecutiveSameTool: list.reduce((m, s) => Math.max(m, s.maxConsecutiveSameTool), 0),
  }
}

const emptyExtras = (): ExtractedExtras => ({
  packCalls: {},
  packErrors: {},
  firstPackCallMs: {},
  invalidToolCalls: 0,
  duplicateToolCalls: 0,
  bashFailCount: 0,
  toolErrorTexts: [],
  riskyCommands: [],
  packActivitySignals: {},
  opencodeVersion: '',
  firstStepInputTokens: undefined,
  lastStepInputTokens: undefined,
  textChars: 0,
  reasoningChars: 0,
  cacheWriteTokens: 0,
})

/** Sums same-named entries across records — used to fold per-pack call/error counts across tree nodes. */
const sumRecordsByKey = (records: readonly Readonly<Record<string, number>>[]): Readonly<Record<string, number>> =>
  records.reduce<Record<string, number>>(
    (out, rec) =>
      Object.entries(rec).reduce<Record<string, number>>((inner, [k, v]) => ({ ...inner, [k]: (inner[k] ?? 0) + v }), out),
    {},
  )

/** Earliest same-named entry across records — used for `firstPackCallMs` per pack name across tree nodes. */
const minRecordsByKey = (records: readonly Readonly<Record<string, number>>[]): Readonly<Record<string, number>> =>
  records.reduce<Record<string, number>>(
    (out, rec) =>
      Object.entries(rec).reduce<Record<string, number>>(
        (inner, [k, v]) => ({ ...inner, [k]: inner[k] === undefined ? v : Math.min(inner[k], v) }),
        out,
      ),
    {},
  )

/** Concatenates same-named signal lists across records — used to fold `packActivitySignals` per pack name across tree nodes. */
const concatSignalsByKey = (
  records: readonly Readonly<Record<string, readonly UnindexedSignal[]>>[],
): Readonly<Record<string, readonly UnindexedSignal[]>> =>
  records.reduce<Record<string, readonly UnindexedSignal[]>>(
    (out, rec) =>
      Object.entries(rec).reduce<Record<string, readonly UnindexedSignal[]>>(
        (inner, [k, v]) => ({ ...inner, [k]: [...(inner[k] ?? []), ...v] }),
        out,
      ),
    {},
  )

/**
 * Folds extras over a session tree. Count-like fields (pack/invalid/duplicate/
 * bashFail, plus textChars/reasoningChars/cacheWriteTokens per spec) sum
 * across nodes, same as the rest of the tree fold; lists concatenate.
 * `firstPackCallMs` takes the earliest defined value (spec is silent on the
 * multi-node case; nodes are sub-agent sessions with their own time origin,
 * so "earliest across the tree" is the closest match to "first call").
 * `opencodeVersion`/`firstStepInputTokens`/`lastStepInputTokens` come from the
 * ROOT node only — sub-agent context sizes are separate conversations.
 */
const mergeExtrasAcrossNodes = (
  tree: readonly SessionTreeNode[],
  list: readonly ExtractedExtras[],
): ExtractedExtras => {
  if (list.length === 0) return emptyExtras()
  const rootIndex = tree.findIndex((n) => n.parentId === null)
  const root = list[rootIndex === -1 ? 0 : rootIndex] ?? emptyExtras()
  const sumOf = (sel: (e: ExtractedExtras) => number): number => list.reduce((a, e) => a + sel(e), 0)
  return {
    packCalls: sumRecordsByKey(list.map((e) => e.packCalls)),
    packErrors: sumRecordsByKey(list.map((e) => e.packErrors)),
    firstPackCallMs: minRecordsByKey(list.map((e) => e.firstPackCallMs)),
    invalidToolCalls: sumOf((e) => e.invalidToolCalls),
    duplicateToolCalls: sumOf((e) => e.duplicateToolCalls),
    bashFailCount: sumOf((e) => e.bashFailCount),
    toolErrorTexts: list.flatMap((e) => e.toolErrorTexts),
    riskyCommands: list.flatMap((e) => e.riskyCommands),
    packActivitySignals: concatSignalsByKey(list.map((e) => e.packActivitySignals)),
    opencodeVersion: root.opencodeVersion,
    firstStepInputTokens: root.firstStepInputTokens,
    lastStepInputTokens: root.lastStepInputTokens,
    textChars: sumOf((e) => e.textChars),
    reasoningChars: sumOf((e) => e.reasoningChars),
    cacheWriteTokens: sumOf((e) => e.cacheWriteTokens),
  }
}

/** A node created before the root's boundary belongs to init, at/after it belongs to task; every node belongs to task when the root has no boundary (spec §2.2). */
const attributePhase = (node: SessionTreeNode, boundaryTs: number | undefined): 'init' | 'task' =>
  boundaryTs !== undefined && toNum(node.export.info.time.created) < boundaryTs ? 'init' : 'task'

/**
 * A sub-agent node is attributed WHOLLY to one phase, so only the count-like
 * fields accumulate — its own wall-clock interval already sits inside the
 * root's phase window (spec §5.2), and its cost is a normal whole-node
 * figure, never a proration, so `wallClockMs`/`costProrated` stay root-owned.
 */
const addNodeToPhaseSlice = (slice: PhaseSliceNum, p: PrimaryMetrics): PhaseSliceNum => ({
  ...slice,
  totalTokens: slice.totalTokens + toNum(p.totalTokens),
  costUsd: slice.costUsd + p.costUsd,
  stepCount: slice.stepCount + p.stepCount,
  toolCallCount: slice.toolCallCount + p.toolCallCount,
})

/**
 * Folds the phase split over a tree: the ROOT's own export supplies the
 * boundary and its own message-level init/task slice (`buildPhaseSlices`,
 * already computed per-node by `extractMetrics`); every non-root node is
 * attributed wholly to init or task by its own `info.time.created` vs the
 * root's boundary, then folded in (spec §5.2).
 */
const mergePhasesAcrossTree = (
  tree: readonly SessionTreeNode[],
  perNode: readonly ExtractedMetrics[],
): ExtractedPhases => {
  const rootIndex = tree.findIndex((n) => n.parentId === null)
  const rootIdx = rootIndex === -1 ? 0 : rootIndex
  const rootNode = tree[rootIdx]
  const rootPhases = perNode[rootIdx]?.phases
  if (rootNode === undefined || rootPhases === undefined) return { task: ZERO_PHASE_SLICE }
  const boundaryTs = findPhaseBoundary(rootNode.export)?.boundaryTs
  return tree.reduce<ExtractedPhases>((acc, node, i) => {
    if (i === rootIdx) return acc
    const p = perNode[i]?.primary
    if (p === undefined) return acc
    return attributePhase(node, boundaryTs) === 'init'
      ? { ...acc, init: addNodeToPhaseSlice(acc.init ?? ZERO_PHASE_SLICE, p) }
      : { ...acc, task: addNodeToPhaseSlice(acc.task, p) }
  }, rootPhases)
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
  opts: ExtractOptions = {},
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
      extras: emptyExtras(),
      phases: { task: ZERO_PHASE_SLICE },
    }
  }
  const perNode = tree.map((n) => extractMetrics(n.export, pricing, successRank, opts))
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

  return {
    primary,
    secondary: mergeSecondaryAcrossNodes(perNode.map((p) => p.secondary)),
    extras: mergeExtrasAcrossNodes(tree, perNode.map((p) => p.extras)),
    phases: mergePhasesAcrossTree(tree, perNode),
  }
}
