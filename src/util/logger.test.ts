import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { Logger, LoggerLive, type LoggerService } from './logger.js'

const LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(debug|info|warn|error)\] .*$/

const collectLines = (): { sink: (line: string) => void; lines: string[] } => {
  const lines: string[] = []
  return { sink: (line: string) => lines.push(line), lines }
}

const runWith = <A, E>(
  level: 'debug' | 'info' | 'warn' | 'error',
  sink: (line: string) => void,
  fa: Effect.Effect<A, E, LoggerService>,
): Promise<A> => Effect.runPromise(Effect.provide(fa, LoggerLive(level, sink)))

describe('Logger', () => {
  it('writes a well-formed line for each emitted level', async () => {
    const { sink, lines } = collectLines()
    await runWith('debug', sink,
      Effect.gen(function* () {
        const log = yield* Logger
        yield* log.info('hello')
      }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(LINE_RE)
    expect(lines[0]).toContain('[info] hello')
  })

  it('filters out messages below the configured level', async () => {
    const { sink, lines } = collectLines()
    await runWith('error', sink,
      Effect.gen(function* () {
        const log = yield* Logger
        yield* log.debug('d')
        yield* log.info('i')
        yield* log.warn('w')
        yield* log.error('e')
      }),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[error] e')
  })

  it('serializes ctx as JSON at the end of the line', async () => {
    const { sink, lines } = collectLines()
    await runWith('debug', sink,
      Effect.gen(function* () {
        const log = yield* Logger
        yield* log.info('starting', { runId: 'abc', side: 'old' })
      }),
    )
    expect(lines[0]).toMatch(/ \{"runId":"abc","side":"old"\}$/)
  })

  it('sink is called for each emitted line', async () => {
    const { sink, lines } = collectLines()
    await runWith('info', sink,
      Effect.gen(function* () {
        const log = yield* Logger
        yield* log.info('one')
        yield* log.info('two')
        yield* log.warn('three')
      }),
    )
    expect(lines).toHaveLength(3)
  })

  it('does not emit when level filtering excludes it (warn at level=error)', async () => {
    const { sink, lines } = collectLines()
    await runWith('error', sink,
      Effect.gen(function* () {
        const log = yield* Logger
        yield* log.warn('hidden')
      }),
    )
    expect(lines).toHaveLength(0)
  })
})
