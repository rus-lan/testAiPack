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
import { Effect } from 'effect'
import path from 'node:path'
import type {
  ExportPart,
  OpencodeExport,
  RunSideResult,
  Side,
  Timeline,
  TimelineEvent,
  TimelineInput,
  TimelineResult,
} from '@generated/types'
import { opencodeExportSchema, timelineSchema } from '@generated/schemas'
import { timelineError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { ensureDir, readFile, writeFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'

// ---------------------------------------------------------------------------
// Pure: event extraction from a single export
// ---------------------------------------------------------------------------

const toMs = (s: string | undefined, fallback: number): number => {
  if (s === undefined) return fallback
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

interface EventBase {
  readonly side: Side
  readonly runIndex: number
  readonly sessionId: string
  readonly swimlaneDepth: number
}

const eventBase = (side: Side, runIndex: number, sessionId: string): EventBase => ({
  side,
  runIndex,
  sessionId,
  swimlaneDepth: 0,
})

/** Map one export part to 0..n timeline events (pre-normalization). */
const partToEvents = (
  part: ExportPart,
  msgCreated: number,
  msgCompleted: number | undefined,
  base: EventBase,
): readonly TimelineEvent[] => {
  switch (part.type) {
    case 'text':
      return [
        {
          ...base,
          tStart: String(msgCreated),
          tEnd: String(msgCreated),
          type: 'text',
        },
      ]
    case 'reasoning':
      return [
        {
          ...base,
          tStart: String(toMs(part.time.start, msgCreated)),
          tEnd: String(toMs(part.time.end, msgCreated)),
          type: 'reasoning',
        },
      ]
    case 'tool': {
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
    case 'step-finish':
      return [
        {
          ...base,
          tStart: String(msgCreated),
          tEnd: String(msgCompleted ?? msgCreated),
          type: 'step-finish',
          ...(part.tokens?.total !== undefined ? { tokens: part.tokens.total } : {}),
        },
      ]
    case 'step-start':
      return []
  }
}

export const extractEventsFromExport = (
  exp: OpencodeExport,
  side: Side,
  runIndex: number,
): readonly TimelineEvent[] => {
  const sessionId = exp.info.id
  const base = eventBase(side, runIndex, sessionId)

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
    ta !== undefined &&
    tb !== undefined &&
    ta === tb &&
    a.runIndex === b.runIndex &&
    a.side === b.side
  )
}

export const collapseRepeats = (events: readonly TimelineEvent[]): readonly TimelineEvent[] =>
  events.reduce<readonly TimelineEvent[]>((acc, e) => {
    const last = acc[acc.length - 1]
    if (last !== undefined && sameToolRun(last, e)) {
      const mergedEnd = String(Math.max(Number(last.tEnd), Number(e.tEnd)))
      const tokens = e.type === 'tool-call' ? sumTokens(last.tokens, e.tokens) : last.tokens
      const merged: TimelineEvent = {
        ...last,
        tEnd: mergedEnd,
        ...(tokens === undefined ? {} : { tokens }),
      }
      return [...acc.slice(0, -1), merged]
    }
    return [...acc, e]
  }, [])

// ---------------------------------------------------------------------------
// Pure: HTML rendering
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const toolClass = (tool: string | undefined): string => (tool === undefined ? '' : tool.toLowerCase())

const PX_PER_MS = 0.5
const MIN_PX = 4

const eventWidth = (e: TimelineEvent): number => {
  const duration = Math.max(0, Number(e.tEnd) - Number(e.tStart))
  return Math.max(MIN_PX, Math.round(duration * PX_PER_MS))
}

const eventTooltip = (e: TimelineEvent): string => {
  const duration = Math.max(0, Number(e.tEnd) - Number(e.tStart))
  const parts = [e.type, e.tool ?? '', `${String(duration)}ms`].filter((p) => p !== '')
  return escapeHtml(parts.join(' '))
}

const eventClasses = (e: TimelineEvent): string => {
  const baseClasses = ['event', e.type]
  if (e.type === 'tool-call' || e.type === 'tool-result') {
    const tc = toolClass(e.tool)
    if (tc !== '') return [...baseClasses, tc].join(' ')
  }
  return baseClasses.join(' ')
}

const renderEvent = (e: TimelineEvent): string => {
  const width = eventWidth(e)
  const cls = eventClasses(e)
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

const renderEventRow = (events: readonly TimelineEvent[]): string =>
  events.map(renderEvent).join('')

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
.event:hover::after{content:attr(data-tooltip);position:absolute;bottom:100%;left:0;background:#000;padding:4px;border-radius:3px;white-space:nowrap;z-index:10;color:#fff}
.legend{margin:10px 0;font-size:12px}
.legend span{display:inline-block;padding:2px 6px;margin-right:8px;color:#fff;border-radius:3px}
.mode-badge{display:inline-block;background:#333;color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;margin-left:8px}`

const renderLegend = (): string =>
  '<div class="legend">' +
  '<span class="event reasoning">reasoning</span>' +
  '<span class="event tool-call bash">bash</span>' +
  '<span class="event tool-call skill">skill</span>' +
  '<span class="event tool-call edit">edit/write</span>' +
  '<span class="event tool-call read">read</span>' +
  '<span class="event tool-call">other tool</span>' +
  '<span class="event step-finish">step-finish</span>' +
  '</div>'

const renderSideBySide = (tl: Timeline): string =>
  `<div class="timeline">` +
  `<div class="side old"><h2>OLD (baseline)</h2><div class="events">${renderEventRow(tl.old)}</div></div>` +
  `<div class="side new"><h2>NEW (with pack)</h2><div class="events">${renderEventRow(tl.new)}</div></div>` +
  `</div>`

const renderMerged = (tl: Timeline): string => {
  const all = [...tl.old, ...tl.new].sort(
    (a, b) => Number(a.tStart) - Number(b.tStart),
  )
  return `<div class="timeline"><div class="side merged"><h2>MERGED (old + new)</h2><div class="events">${renderEventRow(all)}</div></div></div>`
}

export const renderTimelineHtml = (tl: Timeline): string => {
  const body =
    tl.mode === 'merged'
      ? renderMerged(tl)
      : renderSideBySide(tl)
  const dataJson = escapeHtml(JSON.stringify(tl))
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>testaipack timeline</title>
<style>${TIMELINE_CSS}</style>
</head>
<body>
<h1>testaipack timeline<span class="mode-badge">${escapeHtml(tl.mode)}</span></h1>
${renderLegend()}
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
      return yield* Effect.fail(toExportInvalid(side, r.runIndex, jsonEither.left))
    }
    const parsed = opencodeExportSchema.safeParse(jsonEither.right)
    if (!parsed.success) {
      return yield* Effect.fail(toExportInvalid(side, r.runIndex, parsed.error))
    }
    const data = parsed.data as OpencodeExport
    return extractEventsFromExport(data, side, r.runIndex)
  })

const collectSide = (
  side: Side,
  results: readonly RunSideResult[],
  rawDir: string,
): Effect.Effect<readonly TimelineEvent[], PhaseError> =>
  Effect.gen(function* () {
    const perRun = yield* Effect.forEach(
      results,
      (r) => readOneRun(side, r, rawDir),
      { concurrency: 1 },
    )
    return perRun.flat()
  })

export const timeline = (
  input: TimelineInput,
): Effect.Effect<TimelineResult, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace, sideResults } = input

    const oldEvents = yield* collectSide('old', sideResults.old, workspace.raw)
    const newEvents = yield* collectSide('new', sideResults.new, workspace.raw)

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
