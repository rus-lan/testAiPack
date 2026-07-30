/**
 * Metrics: events profile — per-run latency signals folded from the streamed
 * `events.ndjson` log (`raw/<side>/run-N.events.ndjson`, written by phase 06).
 * Pure: takes the raw ndjson text, no file IO, no Effect wiring. Aggregation
 * across runs (median, max) is the caller's concern, not this module's.
 *
 * Scope: the profile covers the streamed root run only (`--init` and
 * `--prompt` share one event stream) — sub-agent internals are not in this
 * stream. `timeToFirstToolMs`/`timeToFirstEditMs` are task-phase signals: pass
 * `boundaryTs` (the export phase boundary, `extract.ts#findPhaseBoundary`) so
 * they measure the `--prompt` session's first tool/edit, not the `--init`
 * session's — on an init-bearing run, measuring from the very first event
 * would otherwise report the init call's latency under a "first tool" label.
 * `gapsMs`/`maxEventGapMs` stay whole-stream regardless — a stall is a run-
 * health signal, not a phase-scoped one (metric-split spec §5.3).
 */
import { isRecord } from '../util/types.js'

export interface EventsProfile {
  /** First `tool_use` event timestamp minus the first event's timestamp. */
  readonly timeToFirstToolMs: number | undefined
  /** First `tool_use` event whose tool is in {@link EDIT_TOOLS}, same baseline as above. */
  readonly timeToFirstEditMs: number | undefined
  /** Largest gap between two consecutive (parsed) event timestamps. */
  readonly maxEventGapMs: number
  /**
   * Every gap between two consecutive (parsed) event timestamps, in event
   * order. Callers decide what counts as a "stall" (the threshold is not
   * this module's concern) — e.g. `gapsMs.filter((g) => g > 60_000).length`.
   * Empty when the run had 0 or 1 events (nothing to have a gap between);
   * that is a real "no gaps" fact, not "could not measure" — the latter is
   * the caller not calling {@link profileEvents} at all (missing file).
   */
  readonly gapsMs: readonly number[]
}

/** Tool names counted as an edit for `timeToFirstEditMs`. */
export const EDIT_TOOLS: readonly string[] = ['edit', 'write', 'patch']

const EMPTY_PROFILE: EventsProfile = {
  timeToFirstToolMs: undefined,
  timeToFirstEditMs: undefined,
  maxEventGapMs: 0,
  gapsMs: [],
}

interface TimedEvent {
  readonly timestamp: number
  readonly isToolUse: boolean
  readonly tool: string | undefined
}

/**
 * Parses one ndjson line into a {@link TimedEvent}, or `undefined` when the
 * line cannot yield one: not JSON, not an object, or no numeric `timestamp`
 * (the writer's `safeStringify` fallback can emit `{}`).
 */
const parseLine = (line: string): TimedEvent | undefined => {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const value: unknown = (() => {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return undefined
    }
  })()
  if (!isRecord(value)) return undefined
  const timestamp = value['timestamp']
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined
  const isToolUse = value['type'] === 'tool_use'
  const part = value['part']
  const tool = isToolUse && isRecord(part) && typeof part['tool'] === 'string' ? part['tool'] : undefined
  return { timestamp, isToolUse, tool }
}

/**
 * Folds a raw `events.ndjson` string into a latency profile. Unparseable
 * lines and events without a usable numeric `timestamp` are skipped, never
 * thrown on. A signal that cannot be measured (no tool call, no edit call,
 * an empty or fully-degenerate stream) is `undefined`, never a fabricated
 * `0` — `0` on the wire would read as "measured, instant", which is a
 * different fact from "could not measure".
 *
 * `boundaryTs`, when given, scopes `timeToFirstToolMs`/`timeToFirstEditMs` to
 * events at or after it (the task phase; baseline = the first such event) —
 * omitted, they measure from the very first event in the stream, as before.
 * `gapsMs`/`maxEventGapMs` always cover the whole stream regardless.
 */
export const profileEvents = (ndjson: string, boundaryTs?: number): EventsProfile => {
  const events = ndjson.split('\n').flatMap((line) => {
    const parsed = parseLine(line)
    return parsed === undefined ? [] : [parsed]
  })

  const first = events[0]
  if (first === undefined) return EMPTY_PROFILE

  const taskEvents = boundaryTs === undefined ? events : events.filter((e) => e.timestamp >= boundaryTs)
  const taskBaseline = boundaryTs === undefined ? first : taskEvents[0]

  const firstTool = taskBaseline === undefined ? undefined : taskEvents.find((e) => e.isToolUse)
  const firstEdit =
    taskBaseline === undefined
      ? undefined
      : taskEvents.find((e) => e.isToolUse && e.tool !== undefined && EDIT_TOOLS.includes(e.tool))

  const gaps = events.slice(1).map((e, i) => {
    const prev = events[i]
    return prev === undefined ? 0 : e.timestamp - prev.timestamp
  })

  return {
    timeToFirstToolMs:
      firstTool === undefined || taskBaseline === undefined ? undefined : firstTool.timestamp - taskBaseline.timestamp,
    timeToFirstEditMs:
      firstEdit === undefined || taskBaseline === undefined ? undefined : firstEdit.timestamp - taskBaseline.timestamp,
    maxEventGapMs: Math.max(0, ...gaps),
    gapsMs: gaps,
  }
}
