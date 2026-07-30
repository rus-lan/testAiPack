/**
 * Phase 10: timeline
 *
 * Builds a flat event timeline from `raw/<side>/run-N.json` exports: a
 * `timeline.json` (validated against `Timeline`) and a self-contained
 * `timeline.html` (vanilla, no server). v0.1 is linear (root session only);
 * swimlane tree-diff via `parent_id` is v0.2.
 *
 * @see docs/phases/10-timeline.ru.md
 * @see contract/phases/10-timeline.tsp
 */
import { Effect, Either } from 'effect'
import path from 'node:path'
import type {
  ExportPart,
  OpencodeExport,
  RunSideResult,
  Side,
  Timeline,
  TimelineEvent,
  TimelineInput,
  TimelineMode,
  TimelineResult,
} from '@generated/types'
import { opencodeExportSchema, timelineSchema } from '@generated/schemas'
import { timelineError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, readFile, writeFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { dbQuery, exportSession } from '../opencode/cli.js'
import type { OpencodeError } from '../opencode/cli.js'
import { isRecord } from '../util/types.js'
import { isReasoning, isStepFinish, isText, isTool } from '../metrics/parts.js'
import type { SessionTreeNode } from '../metrics/extract.js'

// ---------------------------------------------------------------------------
// Pure: event extraction from a single export
// ---------------------------------------------------------------------------

const toMs = (s: number | string | undefined, fallback: number): number => {
  if (s === undefined) return fallback
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

interface EventBase {
  readonly side: Side
  readonly runIndex: number
  readonly sessionId: string
  readonly swimlaneDepth: number
  readonly parentSessionId?: string
}

const eventBase = (
  side: Side,
  runIndex: number,
  sessionId: string,
  depth: number,
  parentSessionId: string | null,
): EventBase => ({
  side,
  runIndex,
  sessionId,
  swimlaneDepth: depth,
  ...(parentSessionId === null ? {} : { parentSessionId }),
})

/** Map one export part to 0..n timeline events (pre-normalization). */
const partToEvents = (
  part: ExportPart,
  msgCreated: number,
  msgCompleted: number | undefined,
  base: EventBase,
): readonly TimelineEvent[] => {
  if (isText(part)) {
    return [
      {
        ...base,
        tStart: String(msgCreated),
        tEnd: String(msgCreated),
        type: 'text',
      },
    ]
  }
  if (isReasoning(part)) {
    const start = toMs(part.time.start, msgCreated)
    return [
      {
        ...base,
        tStart: String(start),
        tEnd: String(toMs(part.time.end, start)),
        type: 'reasoning',
      },
    ]
  }
  if (isTool(part)) {
    const start = part.state.time !== undefined ? toMs(part.state.time.start, msgCreated) : msgCreated
    const end = part.state.time !== undefined ? toMs(part.state.time.end, start) : start
    const callEvent: TimelineEvent = {
      ...base,
      tStart: String(start),
      tEnd: String(end),
      type: 'tool-call',
      tool: part.tool,
      status: part.state.status,
    }
    if (part.state.status === 'completed' || part.state.status === 'error') {
      const resultEvent: TimelineEvent = {
        ...base,
        tStart: String(end),
        tEnd: String(end),
        type: 'tool-result',
        tool: part.tool,
        status: part.state.status,
      }
      return [callEvent, resultEvent]
    }
    return [callEvent]
  }
  if (isStepFinish(part)) {
    return [
      {
        ...base,
        tStart: String(msgCreated),
        tEnd: String(msgCompleted ?? msgCreated),
        type: 'step-finish',
        ...(part.tokens?.total !== undefined ? { tokens: part.tokens.total } : {}),
      },
    ]
  }
  // step-start, patch, and any unrecognised part kind contribute no events.
  return []
}

export const extractEventsFromExport = (
  exp: OpencodeExport,
  side: Side,
  runIndex: number,
  depth = 0,
  parentSessionId: string | null = null,
): readonly TimelineEvent[] => {
  const sessionId = exp.info.id
  const base = eventBase(side, runIndex, sessionId, depth, parentSessionId)

  const minCreated = exp.messages.reduce<number>((min, msg) => {
    const c = toMs(msg.info.time.created, min)
    return c < min ? c : min
  }, Number.POSITIVE_INFINITY)
  const norm = Number.isFinite(minCreated) ? minCreated : 0

  const raw = exp.messages.flatMap((msg) => {
    const msgCreated = toMs(msg.info.time.created, norm)
    const msgCompleted =
      msg.info.time.completed !== undefined ? toMs(msg.info.time.completed, msgCreated) : undefined
    return msg.parts.flatMap((part) => partToEvents(part, msgCreated, msgCompleted, base))
  })

  return raw.map((e) => ({
    ...e,
    tStart: String(Math.max(0, Math.floor(Number(e.tStart) - norm))),
    tEnd: String(Math.max(0, Math.floor(Number(e.tEnd) - norm))),
  }))
}

// ---------------------------------------------------------------------------
// Pure: collapse consecutive identical tool-call events
// ---------------------------------------------------------------------------

const sumTokens = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined && b === undefined) return undefined
  return (a ?? 0) + (b ?? 0)
}

const toolNameOf = (e: TimelineEvent): string | undefined =>
  e.type === 'tool-call' || e.type === 'tool-result' ? e.tool : undefined

const sameToolRun = (a: TimelineEvent, b: TimelineEvent): boolean => {
  const ta = toolNameOf(a)
  const tb = toolNameOf(b)
  return (
    a.type === 'tool-call' &&
    b.type === 'tool-call' &&
    ta !== undefined &&
    tb !== undefined &&
    ta === tb &&
    a.runIndex === b.runIndex &&
    a.side === b.side &&
    a.sessionId === b.sessionId
  )
}

const mergeRun = (run: readonly TimelineEvent[]): TimelineEvent =>
  run.reduce((last, e) => {
    const mergedEnd = String(Math.max(Number(last.tEnd), Number(e.tEnd)))
    const tokens = e.type === 'tool-call' ? sumTokens(last.tokens, e.tokens) : last.tokens
    return { ...last, tEnd: mergedEnd, ...(tokens === undefined ? {} : { tokens }) }
  })

/**
 * Collapses each contiguous same-tool run via a single index-based scan
 * (a run's start indices, then one `slice` + `reduce` per run) instead of
 * rebuilding the whole output array on every event, which kept this O(n^2)
 * over a timeline with thousands of events.
 */
export const collapseRepeats = (events: readonly TimelineEvent[]): readonly TimelineEvent[] => {
  const runStarts = events.flatMap((e, i) => {
    const prev = events[i - 1]
    return prev !== undefined && sameToolRun(prev, e) ? [] : [i]
  })
  return runStarts.map((start, idx) => {
    const end = runStarts[idx + 1] ?? events.length
    return mergeRun(events.slice(start, end))
  })
}

// ---------------------------------------------------------------------------
// Session tree (v0.2): walk `session.parent_id` to discover sub-agents spawned
// via the `task` tool. Each child session becomes its own swimlane.
// ---------------------------------------------------------------------------

/** Cap recursion so a pathological (or cyclic) graph cannot exhaust the stack. */
const MAX_TREE_DEPTH = 10

const treeExportInvalid = (cause: unknown): PhaseError =>
  timelineError('session tree export invalid', 'E_EXPORT_INVALID', {
    reason: 'tree-export',
    cause: String(cause),
  })

const treeDbFailure = (e: OpencodeError): PhaseError =>
  timelineError(`session tree db query failed: ${e.stderr}`, 'E_EXPORT_INVALID', {
    reason: 'tree-db',
    cause: e,
  })

const parseChildIds = (rows: unknown): readonly string[] => {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((r): readonly string[] => {
    if (isRecord(r) && typeof r['id'] === 'string') return [r['id']]
    return []
  })
}

/** opencode session ids are alphanumeric with `-`/`_`; anything else cannot be a real id. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

const fetchChildIds = (
  homeDir: string,
  parentId: string,
): Effect.Effect<readonly string[], PhaseError> =>
  Effect.gen(function* () {
    if (!SESSION_ID_PATTERN.test(parentId)) return []
    const rows = yield* dbQuery(
      homeDir,
      `SELECT id FROM session WHERE parent_id = '${parentId}'`,
    ).pipe(Effect.mapError(treeDbFailure))
    return parseChildIds(rows)
  })

const exportOne = (
  homeDir: string,
  sessionId: string,
): Effect.Effect<OpencodeExport, PhaseError> =>
  Effect.gen(function* () {
    const raw = yield* exportSession(homeDir, sessionId).pipe(Effect.mapError(treeDbFailure))
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) => treeExportInvalid(e),
    })
    const result = opencodeExportSchema.safeParse(parsed)
    if (!result.success) return yield* Effect.fail(treeExportInvalid(result.error))
    return result.data as OpencodeExport
  })

/**
 * Recursive core shared by {@link loadSessionTree} and {@link loadTreeForRun}:
 * returns the subtree of all DESCENDANTS of `parentId` (never `parentId`
 * itself). Each child is exported exactly once; the root's own export is the
 * caller's responsibility (loaded from disk by the phase, re-exported by
 * `loadSessionTree`). A `visited` set breaks cycles; depth is capped.
 */
const fetchChildSubtree = (
  homeDir: string,
  parentId: string,
  parentDepth: number,
  visited: ReadonlySet<string>,
): Effect.Effect<readonly SessionTreeNode[], PhaseError> =>
  Effect.gen(function* () {
    if (parentDepth >= MAX_TREE_DEPTH) return []
    const childIds = yield* fetchChildIds(homeDir, parentId)
    const childTrees = yield* Effect.forEach(
      childIds,
      (cid): Effect.Effect<readonly SessionTreeNode[], PhaseError> =>
        Effect.gen(function* () {
          if (visited.has(cid)) return []
          const nextVisited: ReadonlySet<string> = new Set([...visited, cid])
          const exp = yield* exportOne(homeDir, cid)
          const node: SessionTreeNode = {
            sessionId: cid,
            parentId,
            depth: parentDepth + 1,
            export: exp,
            children: [],
          }
          const descendants = yield* fetchChildSubtree(homeDir, cid, parentDepth + 1, nextVisited)
          return [node, ...descendants]
        }),
      { concurrency: 1 },
    )
    return childTrees.flat()
  })

/**
 * Load the full session tree rooted at `rootSessionId` as a flat DFS list
 * (root first, then its children recursively). The root is re-exported via
 * `opencode export`; a `visited` set breaks cycles along `parent_id`; depth is
 * capped at {@link MAX_TREE_DEPTH}. Each node carries its own validated export.
 */
export const loadSessionTree = (
  homeDir: string,
  rootSessionId: string,
): Effect.Effect<readonly SessionTreeNode[], PhaseError> =>
  Effect.gen(function* () {
    const visited: ReadonlySet<string> = new Set([rootSessionId])
    const rootExp = yield* exportOne(homeDir, rootSessionId)
    const rootNode: SessionTreeNode = {
      sessionId: rootSessionId,
      parentId: null,
      depth: 0,
      export: rootExp,
      children: [],
    }
    const descendants = yield* fetchChildSubtree(homeDir, rootSessionId, 0, visited)
    return [rootNode, ...descendants]
  })

export type SessionTreeLoader = (
  homeDir: string,
  rootSessionId: string,
) => Effect.Effect<readonly SessionTreeNode[], PhaseError>

const rootOnly = (exp: OpencodeExport): SessionTreeNode => ({
  sessionId: exp.info.id,
  parentId: null,
  depth: 0,
  export: exp,
  children: [],
})

/** Best-effort tree from the on-disk root + DB-descended sub-agents (no re-export of root). */
const defaultTreeForRun = (
  homeDir: string,
  rootExport: OpencodeExport,
): Effect.Effect<readonly SessionTreeNode[], PhaseError> =>
  Effect.gen(function* () {
    const root = rootOnly(rootExport)
    if (homeDir === '') return [root]
    const visited: ReadonlySet<string> = new Set([rootExport.info.id])
    const either = yield* fetchChildSubtree(homeDir, rootExport.info.id, 0, visited).pipe(
      Effect.either,
      Effect.catchAllDefect(
        (d): Effect.Effect<Either.Either<readonly SessionTreeNode[], PhaseError>> =>
          Effect.succeed(Either.left(d as PhaseError)),
      ),
    )
    if (either._tag === 'Left') return [root]
    return [root, ...either.right]
  })

/**
 * Resolve the session tree for one run, resiliently:
 * - an injected `loader` (tests / explicit wiring) is always preferred;
 * - otherwise {@link defaultTreeForRun} builds the tree from the on-disk root
 *   plus DB-descended sub-agents (the root is never re-exported). With no home
 *   dir, on any DB/export failure, OR when `opencode db query` is unavailable
 *   (old opencode / mock), the run degrades to a root-only tree, identical to
 *   v0.1. Defects are caught too, so a tree problem never fails the whole phase.
 */
export const loadTreeForRun = (
  homeDir: string,
  rootExport: OpencodeExport,
  loader?: SessionTreeLoader,
): Effect.Effect<readonly SessionTreeNode[], PhaseError> =>
  Effect.gen(function* () {
    if (loader !== undefined) {
      const either = yield* loader(homeDir, rootExport.info.id).pipe(
        Effect.either,
        Effect.catchAllDefect(
          (d): Effect.Effect<Either.Either<readonly SessionTreeNode[], PhaseError>> =>
            Effect.succeed(Either.left(d as PhaseError)),
        ),
      )
      if (either._tag === 'Left') return [rootOnly(rootExport)]
      return either.right.length > 0 ? either.right : [rootOnly(rootExport)]
    }
    return yield* defaultTreeForRun(homeDir, rootExport)
  })

export interface TimelineDeps {
  /** Override the session-tree loader (tests inject a stub tree here). */
  readonly loadTree?: SessionTreeLoader
}

// ---------------------------------------------------------------------------
// Pure: HTML rendering
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

type DiffFlag = 'only-old' | 'only-new' | null

const toolClass = (tool: string | undefined): string =>
  tool === undefined ? '' : escapeHtml(tool.toLowerCase().replace(/[^a-z0-9-]/g, ''))

const PX_PER_MS = 0.5
const MIN_PX = 4
const MAX_PX = 2000

const eventWidth = (e: TimelineEvent): number => {
  const duration = Math.max(0, Number(e.tEnd) - Number(e.tStart))
  return Math.min(MAX_PX, Math.max(MIN_PX, Math.round(duration * PX_PER_MS)))
}

const eventTooltip = (e: TimelineEvent): string => {
  const duration = Math.max(0, Number(e.tEnd) - Number(e.tStart))
  const parts = [e.type, e.tool ?? '', `${String(duration)}ms`].filter((p) => p !== '')
  return escapeHtml(parts.join(' '))
}

const eventClasses = (e: TimelineEvent, flag: DiffFlag = null): string => {
  const baseClasses: readonly string[] = ['event', e.type]
  const withTool =
    e.type === 'tool-call' || e.type === 'tool-result'
      ? (() => {
          const tc = toolClass(e.tool)
          return tc === '' ? baseClasses : [...baseClasses, tc]
        })()
      : baseClasses
  const withFlag = flag === null ? withTool : [...withTool, flag]
  return withFlag.join(' ')
}

const renderEvent = (e: TimelineEvent, flag: DiffFlag = null): string => {
  const width = eventWidth(e)
  const cls = eventClasses(e, flag)
  const tooltip = eventTooltip(e)
  const statusAttr = e.status === 'error' ? ' data-status="error"' : ''
  const label =
    e.type === 'tool-call' || e.type === 'tool-result'
      ? (e.tool ?? '?').slice(0, 1)
      : e.type === 'reasoning'
        ? 'R'
        : e.type === 'step-finish'
          ? 'F'
          : 'T'
  return `<div class="${cls}" style="width:${String(width)}px" data-tooltip="${tooltip}"${statusAttr}>${escapeHtml(label)}</div>`
}

const renderEventRow = (
  events: readonly TimelineEvent[],
  otherKeys?: ReadonlySet<string>,
  side?: Side,
): string =>
  events
    .map((e) => {
      const flag: DiffFlag =
        otherKeys !== undefined && side !== undefined
          ? otherKeys.has(eventDiffKey(e))
            ? null
            : side === 'old'
              ? 'only-old'
              : 'only-new'
          : null
      return renderEvent(e, flag)
    })
    .join('')

const TIMELINE_CSS = `body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:20px;color:#222}
h1{font-size:16px}
.timeline{display:flex;flex-direction:column;gap:10px}
.side{border:1px solid #ccc;padding:10px}
.side.old{background:#fafafa}
.side.new{background:#f0fff0}
.side.merged{background:#f4f4ff}
.side h2{margin:0 0 10px 0;font-size:13px}
.events{display:flex;flex-direction:row;overflow-x:auto;gap:2px;align-items:stretch;min-height:30px}
.event{padding:4px 6px;border-radius:3px;font-size:11px;color:#fff;min-width:4px;position:relative;text-align:center}
.event.reasoning{background:#888}
.event.tool-call.bash,.event.tool-call.exec{background:#1565c0}
.event.tool-call.skill{background:#2e7d32}
.event.tool-call.edit,.event.tool-call.write,.event.tool-call.applypatch{background:#e65100}
.event.tool-call.read,.event.tool-call.glob,.event.tool-call.grep{background:#6a1b9a}
.event.tool-call{background:#555}
.event.tool-result{background:#aaa;min-width:2px}
.event.step-finish{background:#000;min-width:2px}
.event.text{background:#ddd;color:#000}
.event[data-status="error"]{border:2px solid #d32f2f}
.event.only-old{outline:2px solid #d32f2f;outline-offset:-1px}
.event.only-new{outline:2px solid #2e7d32;outline-offset:-1px}
.event:hover::after{content:attr(data-tooltip);position:absolute;bottom:100%;left:0;background:#000;padding:4px;border-radius:3px;white-space:nowrap;z-index:10;color:#fff}
.legend{margin:10px 0;font-size:12px}
.legend span{display:inline-block;padding:2px 6px;margin-right:8px;color:#fff;border-radius:3px}
.mode-badge{display:inline-block;background:#333;color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;margin-left:8px}
.swimlane{display:flex;align-items:stretch;gap:2px;min-height:24px;border-left:2px dashed transparent;padding-left:4px;margin-bottom:2px}
.swimlane[data-depth="1"]{border-left-color:#888;margin-left:20px}
.swimlane[data-depth="2"]{border-left-color:#aaa;margin-left:40px}
.swimlane[data-depth="3"]{border-left-color:#bbb;margin-left:60px}
.swimlane-label{font-size:10px;color:#555;min-width:60px;padding:4px 0;align-self:center;flex-shrink:0}`

const renderLegend = (mode: TimelineMode): string =>
  '<div class="legend">' +
  '<span class="event reasoning">reasoning</span>' +
  '<span class="event tool-call bash">bash</span>' +
  '<span class="event tool-call skill">skill</span>' +
  '<span class="event tool-call edit">edit/write</span>' +
  '<span class="event tool-call read">read</span>' +
  '<span class="event tool-call">other tool</span>' +
  '<span class="event step-finish">step-finish</span>' +
  (mode === 'tree-diff'
    ? '<span class="event only-old">OLD only</span><span class="event only-new">NEW only</span>'
    : '') +
  '</div>'

interface Swimlane {
  readonly sessionId: string
  readonly depth: number
  readonly parentSessionId: string | null
  readonly events: readonly TimelineEvent[]
}

/**
 * Group a side's flat event list into one swimlane per `sessionId`, preserving
 * first-appearance order (the events arrive already sorted by runIndex/tStart,
 * so the root lane surfaces before its children). Each lane carries the depth
 * and parent of its first event — these describe the session-tree position.
 *
 * `Set` dedupes sessionIds while keeping first-appearance order without
 * rebuilding a growing per-session array on every event (the O(n^2) shape a
 * timeline with thousands of events used to hit); one `filter` per distinct
 * session (typically a handful) reassembles each lane's own events in order.
 */
const groupSwimlanes = (events: readonly TimelineEvent[]): readonly Swimlane[] => {
  const orderedSessionIds = [...new Set(events.map((e) => e.sessionId))]
  return orderedSessionIds.flatMap((sessionId): readonly Swimlane[] => {
    const evs = events.filter((e) => e.sessionId === sessionId)
    const first = evs[0]
    if (first === undefined) return []
    return [
      {
        sessionId,
        depth: first.swimlaneDepth,
        parentSessionId: first.parentSessionId ?? null,
        events: evs,
      },
    ]
  })
}

const swimlaneLabel = (lane: Swimlane): string =>
  lane.depth === 0 ? 'main' : `depth ${String(lane.depth)}`

const renderSwimlane = (
  lane: Swimlane,
  otherKeys?: ReadonlySet<string>,
  side?: Side,
): string =>
  `<div class="swimlane" data-depth="${String(lane.depth)}">` +
  `<div class="swimlane-label">${escapeHtml(swimlaneLabel(lane))}</div>` +
  `<div class="events">${renderEventRow(lane.events, otherKeys, side)}</div>` +
  `</div>`

const renderSideLanes = (
  events: readonly TimelineEvent[],
  otherKeys?: ReadonlySet<string>,
  side?: Side,
): string => {
  const lanes = groupSwimlanes(events)
  if (lanes.length === 0) return '<div class="events"></div>'
  return lanes.map((l) => renderSwimlane(l, otherKeys, side)).join('')
}

const renderSideBySide = (tl: Timeline): string =>
  `<div class="timeline">` +
  `<div class="side old"><h2>OLD (baseline)</h2>${renderSideLanes(tl.old)}</div>` +
  `<div class="side new"><h2>NEW (with pack)</h2>${renderSideLanes(tl.new)}</div>` +
  `</div>`

const eventDiffKey = (e: TimelineEvent): string =>
  e.tool === undefined ? e.type : `${e.type}:${e.tool}`

const diffKeysOf = (events: readonly TimelineEvent[]): ReadonlySet<string> =>
  new Set(events.map(eventDiffKey))

/**
 * tree-diff: side-by-side lanes, but events whose `type(+tool)` appears on only
 * one side are outlined — red for OLD-only, green for NEW-only. Comparison is
 * coarse on purpose (tool+type), so a renamed/swapped tool still surfaces as a
 * diff without false-precision on timing.
 */
const renderTreeDiff = (tl: Timeline): string => {
  const oldKeys = diffKeysOf(tl.old)
  const newKeys = diffKeysOf(tl.new)
  return `<div class="timeline">` +
    `<div class="side old"><h2>OLD (baseline)</h2>${renderSideLanes(tl.old, newKeys, 'old')}</div>` +
    `<div class="side new"><h2>NEW (with pack)</h2>${renderSideLanes(tl.new, oldKeys, 'new')}</div>` +
    `</div>`
}

const renderMerged = (tl: Timeline): string => {
  const all = [...tl.old, ...tl.new].sort(
    (a, b) => Number(a.tStart) - Number(b.tStart),
  )
  return `<div class="timeline"><div class="side merged"><h2>MERGED (old + new)</h2><div class="events">${renderEventRow(all)}</div></div></div>`
}

/**
 * Embed JSON inside a `<script>` element without corrupting it: `<script>` content
 * is not HTML-entity-decoded, so entity-escaping (as for normal HTML text) would
 * leave literal `&amp;`/`&lt;` in the string a reader later `JSON.parse`s. Instead
 * escape the few characters that could confuse the HTML parser (chiefly a literal
 * `</script`) as JSON-valid `\u` sequences, which `JSON.parse` decodes back exactly.
 */
const toScriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')

export const renderTimelineHtml = (tl: Timeline): string => {
  const body =
    tl.mode === 'merged'
      ? renderMerged(tl)
      : tl.mode === 'tree-diff'
        ? renderTreeDiff(tl)
        : renderSideBySide(tl)
  const dataJson = toScriptJson(tl)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>testaipack timeline</title>
<style>${TIMELINE_CSS}</style>
</head>
<body>
<h1>testaipack timeline<span class="mode-badge">${escapeHtml(tl.mode)}</span></h1>
${renderLegend(tl.mode)}
${body}
<script type="application/json" id="timeline-data">${dataJson}</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

const toExportInvalid = (side: Side, runIndex: number, cause: unknown): PhaseError =>
  timelineError(
    `export invalid for ${side}/run-${String(runIndex)}: schema mismatch`,
    'E_EXPORT_INVALID',
    { side, runIndex, reason: 'invalid-export', cause: String(cause) },
  )

const toWriteFailure = (what: string, e: FsError): PhaseError =>
  timelineError(`failed to write ${what}: ${e.operation} on ${e.path}`, 'E_EXPORT_INVALID', {
    reason: 'write-timeline',
    what,
    path: e.path,
    operation: e.operation,
  })

const readOneRun = (
  side: Side,
  r: RunSideResult,
  rawDir: string,
  homeDirs: readonly string[],
  loader?: SessionTreeLoader,
): Effect.Effect<readonly TimelineEvent[], PhaseError> =>
  Effect.gen(function* () {
    const file = path.join(rawDir, side, `run-${String(r.runIndex)}.json`)
    const readEither = yield* readFile(file).pipe(Effect.either)
    if (readEither._tag === 'Left') {
      return []
    }
    const jsonEither = yield* Effect.try({
      try: () => JSON.parse(readEither.right) as unknown,
      catch: (e) => e,
    }).pipe(Effect.either)
    if (jsonEither._tag === 'Left') {
      console.warn(toExportInvalid(side, r.runIndex, jsonEither.left).message)
      return []
    }
    const parsed = opencodeExportSchema.safeParse(jsonEither.right)
    if (!parsed.success) {
      console.warn(toExportInvalid(side, r.runIndex, parsed.error).message)
      return []
    }
    const data = parsed.data as OpencodeExport
    const homeDir = homeDirs[r.runIndex - 1] ?? ''
    const tree = yield* loadTreeForRun(homeDir, data, loader)
    return tree.flatMap((node) =>
      extractEventsFromExport(node.export, side, r.runIndex, node.depth, node.parentId),
    )
  })

const byRunStartDepth = (a: TimelineEvent, b: TimelineEvent): number => {
  if (a.runIndex !== b.runIndex) return a.runIndex - b.runIndex
  const ta = Number(a.tStart)
  const tb = Number(b.tStart)
  if (ta !== tb) return ta - tb
  return a.swimlaneDepth - b.swimlaneDepth
}

const collectSide = (
  side: Side,
  results: readonly RunSideResult[],
  rawDir: string,
  homeDirs: readonly string[],
  loader?: SessionTreeLoader,
): Effect.Effect<readonly TimelineEvent[], PhaseError> =>
  Effect.gen(function* () {
    const perRun = yield* Effect.forEach(
      results,
      (r) => readOneRun(side, r, rawDir, homeDirs, loader),
      { concurrency: 1 },
    )
    return [...perRun.flat()].sort(byRunStartDepth)
  })

export const timeline = (
  input: TimelineInput,
  deps?: TimelineDeps,
): Effect.Effect<TimelineResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace, sideResults } = input
    const loader = deps?.loadTree

    const oldEvents = yield* collectSide(
      'old',
      sideResults.old,
      workspace.raw,
      workspace.homeOld,
      loader,
    )
    const newEvents = yield* collectSide(
      'new',
      sideResults.new,
      workspace.raw,
      workspace.homeNew,
      loader,
    )

    const oldFinal = runInput.collapseRepeats ? collapseRepeats(oldEvents) : oldEvents
    const newFinal = runInput.collapseRepeats ? collapseRepeats(newEvents) : newEvents

    const tl: Timeline = {
      old: [...oldFinal],
      new: [...newFinal],
      mode: runInput.timelineMode,
    }

    const check = timelineSchema.safeParse(tl)
    if (!check.success) {
      return yield* Effect.fail(
        timelineError('timeline schema mismatch', 'E_EXPORT_INVALID', {
          reason: 'schema',
          issues: check.error.issues,
        }),
      )
    }

    yield* ensureDir(workspace.results).pipe(
      Effect.mapError((e: FsError) => toWriteFailure('results dir', e)),
    )

    const jsonPath = path.join(workspace.results, 'timeline.json')
    yield* writeJson(jsonPath, tl).pipe(
      Effect.mapError((e: FsError) => toWriteFailure('timeline.json', e)),
    )

    if (runInput.formats.includes('html')) {
      const htmlPath = path.join(workspace.results, 'timeline.html')
      yield* writeFile(htmlPath, renderTimelineHtml(tl)).pipe(
        Effect.mapError((e: FsError) => toWriteFailure('timeline.html', e)),
      )
      return { timeline: tl, jsonPath, htmlPath }
    }

    return { timeline: tl, jsonPath }
  })
