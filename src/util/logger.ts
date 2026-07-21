import { Context, Effect, Layer } from 'effect'
import type { LogLevel } from '@generated/types'

export interface LoggerService {
  readonly debug: (msg: string, ctx?: Record<string, unknown>) => Effect.Effect<void>
  readonly info: (msg: string, ctx?: Record<string, unknown>) => Effect.Effect<void>
  readonly warn: (msg: string, ctx?: Record<string, unknown>) => Effect.Effect<void>
  readonly error: (msg: string, ctx?: Record<string, unknown>) => Effect.Effect<void>
}

export const Logger = Context.GenericTag<LoggerService>('@testaipack/Logger')

const rank = (l: LogLevel): number =>
  l === 'debug' ? 10 : l === 'info' ? 20 : l === 'warn' ? 30 : 40

const formatLine = (
  level: LogLevel,
  msg: string,
  ctx: Record<string, unknown> | undefined,
): string => {
  const ts = new Date().toISOString()
  const base = `${ts} [${level}] ${msg}`
  return ctx === undefined ? base : `${base} ${JSON.stringify(ctx)}`
}

export const makeLogger = (level: LogLevel, sink: (line: string) => void): LoggerService => {
  const emit = (
    lvl: LogLevel,
    msg: string,
    ctx: Record<string, unknown> | undefined,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (rank(lvl) >= rank(level)) {
        sink(formatLine(lvl, msg, ctx))
      }
    })
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  }
}

const defaultSink = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

export const LoggerLive = (
  level: LogLevel,
  sink: (line: string) => void = defaultSink,
) => Layer.succeed(Logger, makeLogger(level, sink))
