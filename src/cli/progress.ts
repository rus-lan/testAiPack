/**
 * Progress reporter for the CLI pipeline. Writes one line per completed
 * phase (with elapsed time) plus indented sub-lines for the parallel run-side
 * executions. No animated spinner: every line is a complete, deterministic
 * record so output is stable in tests and CI logs.
 *
 * The reporter is a thin sink-based abstraction: callers pass a `write` function
 * (production wires `process.stderr.write`, tests capture into an array). A
 * `silent` flag disables info output while still allowing error lines through.
 */
import type { LogLevel } from '@generated/types'

export type ProgressSink = (line: string) => void

export interface PhaseDone {
  readonly index: number
  readonly total: number
  readonly label: string
  readonly durationMs: number
  readonly detail?: string
}

export interface ProgressReporter {
  readonly header: (runId: string) => void
  readonly phaseDone: (phase: PhaseDone) => void
  readonly sub: (label: string, durationMs?: number, detail?: string) => void
  readonly log: (msg: string) => void
  readonly error: (msg: string) => void
  readonly done: (summary: string) => void
}

const RULE = '\u2500'.repeat(57)

const padRight = (s: string, n: number): string =>
  s.length >= n ? `${s} ` : `${s}${' '.repeat(n - s.length + 1)}`

const fmtTime = (ms: number): string => {
  const seconds = ms / 1000
  return `${seconds.toFixed(1)}s`
}

export const formatPhaseLine = (phase: PhaseDone): string => {
  const prefix = `[${String(phase.index + 1)}/${String(phase.total)}] ${phase.label}`
  const dotted = padRight(prefix, 28)
  const detail = phase.detail === undefined ? '' : `  ${phase.detail}`
  return `${dotted}done (${fmtTime(phase.durationMs)})${detail}`
}

export const createProgressReporter = (
  sink: ProgressSink,
  silent: boolean,
): ProgressReporter => {
  const emit = (line: string): void => {
    if (!silent) {
      sink(`${line}\n`)
    }
  }
  return {
    header: (runId) => {
      emit(`testaipack run ${runId}\n${RULE}`)
    },
    phaseDone: (phase) => {
      emit(formatPhaseLine(phase))
    },
    sub: (label, durationMs, detail) => {
      const body =
        durationMs === undefined
          ? label
          : `${padRight(label, 24)}done (${fmtTime(durationMs)})`
      const tail = detail === undefined ? '' : `  ${detail}`
      emit(`        ${body}${tail}`)
    },
    log: (msg) => {
      emit(msg)
    },
    error: (msg) => {
      sink(`error: ${msg}\n`)
    },
    done: (summary) => {
      emit(`${RULE}\nDone. ${summary}`)
    },
  }
}

/**
 * Severity each reporter method carries, and the rank `--log-level` filters
 * against (message shown when the configured level's rank <= the message's
 * rank — the usual leveled-logger model):
 * - `header`/`phaseDone`/`sub` are per-phase progress chatter → `info`.
 * - `log` (warnings, e.g. the docker-downgrade notice) and `done` (the final
 *   result line) → `warn`.
 * - `error` is always shown, at every configured level.
 *
 * `debug` and `info` end up identical: nothing the reporter emits today is
 * held back at `info` and only unlocked at `debug` — there is no extra detail
 * to show. `debug` is accepted and behaves like `info` rather than inventing
 * a distinction the reporter cannot express.
 */
const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const MESSAGE_RANK = {
  progress: LOG_LEVEL_RANK.info,
  result: LOG_LEVEL_RANK.warn,
} as const

/** Wraps a reporter so each method only forwards when `level` allows it. */
export const withLogLevel = (reporter: ProgressReporter, level: LogLevel): ProgressReporter => {
  const configured = LOG_LEVEL_RANK[level]
  const allow = (msgRank: number): boolean => configured <= msgRank
  return {
    header: (runId) => {
      if (allow(MESSAGE_RANK.progress)) reporter.header(runId)
    },
    phaseDone: (phase) => {
      if (allow(MESSAGE_RANK.progress)) reporter.phaseDone(phase)
    },
    sub: (label, durationMs, detail) => {
      if (allow(MESSAGE_RANK.progress)) reporter.sub(label, durationMs, detail)
    },
    log: (msg) => {
      if (allow(MESSAGE_RANK.result)) reporter.log(msg)
    },
    error: (msg) => {
      reporter.error(msg)
    },
    done: (summary) => {
      if (allow(MESSAGE_RANK.result)) reporter.done(summary)
    },
  }
}

export const stderrSink: ProgressSink = (line): void => {
  void process.stderr.write(line)
}
