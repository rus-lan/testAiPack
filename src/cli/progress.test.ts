import { describe, it, expect } from 'vitest'
import {
  createProgressReporter,
  formatPhaseLine,
  withLogLevel,
  type PhaseDone,
} from './progress.js'
import type { LogLevel } from '@generated/types'

const collect = (): { readonly sink: (l: string) => void; readonly lines: string[] } => {
  const lines: string[] = []
  return { sink: (l) => lines.push(l), lines }
}

describe('cli/progress — formatPhaseLine', () => {
  it('formats index/total, label, time', () => {
    const line = formatPhaseLine({ index: 2, total: 14, label: 'repo-clone', durationMs: 2300 })
    expect(line).toContain('[3/14]')
    expect(line).toContain('repo-clone')
    expect(line).toContain('(2.3s)')
    expect(line).toContain('done')
  })

  it('appends detail when present', () => {
    const line = formatPhaseLine({
      index: 0,
      total: 14,
      label: 'cli-parse',
      durationMs: 100,
      detail: 'configSource=cli',
    })
    expect(line).toContain('configSource=cli')
  })

  it('omits detail slot when absent', () => {
    const line = formatPhaseLine({ index: 0, total: 14, label: 'x', durationMs: 0 })
    expect(line).not.toContain('configSource')
  })
})

describe('cli/progress — reporter', () => {
  it('header prints runId and a rule', () => {
    const c = collect()
    const r = createProgressReporter(c.sink, false)
    r.header('run-xyz')
    expect(c.lines.join('')).toContain('testaipack run run-xyz')
  })

  it('phaseDone emits a formatted line', () => {
    const c = collect()
    const r = createProgressReporter(c.sink, false)
    const phase: PhaseDone = { index: 5, total: 14, label: 'preflight', durationMs: 1100, detail: '5 checks passed' }
    r.phaseDone(phase)
    expect(c.lines.join('')).toContain('[6/14]')
    expect(c.lines.join('')).toContain('5 checks passed')
  })

  it('sub emits an indented line with timing', () => {
    const c = collect()
    const r = createProgressReporter(c.sink, false)
    r.sub('old/run-1/3', 45200)
    const out = c.lines.join('')
    expect(out).toContain('old/run-1/3')
    expect(out).toContain('(45.2s)')
    expect(out.startsWith('        ')).toBe(true)
  })

  it('silent=true suppresses info but not errors', () => {
    const c = collect()
    const r = createProgressReporter(c.sink, true)
    r.header('x')
    r.phaseDone({ index: 0, total: 14, label: 'cli-parse', durationMs: 1 })
    r.error('boom')
    const out = c.lines.join('')
    expect(out).not.toContain('testaipack run')
    expect(out).toContain('error: boom')
  })

  it('done prints a closing rule + summary', () => {
    const c = collect()
    const r = createProgressReporter(c.sink, false)
    r.done('2 improvements')
    const out = c.lines.join('')
    expect(out).toContain('Done.')
    expect(out).toContain('2 improvements')
  })
})

describe('cli/progress — withLogLevel', () => {
  const phase: PhaseDone = { index: 0, total: 14, label: 'cli-parse', durationMs: 1 }

  const fireAll = (r: ReturnType<typeof createProgressReporter>): void => {
    r.header('run-xyz')
    r.phaseDone(phase)
    r.sub('old/run-1/3', 100)
    r.log('warning: docker downgraded')
    r.done('1 improvement(s)')
    r.error('boom')
  }

  it('info (unset default) is byte-identical to the unwrapped reporter', () => {
    const plain = collect()
    fireAll(createProgressReporter(plain.sink, false))

    const leveled = collect()
    fireAll(withLogLevel(createProgressReporter(leveled.sink, false), 'info'))

    expect(leveled.lines).toEqual(plain.lines)
  })

  it('debug behaves exactly like info — nothing extra to unlock today', () => {
    const info = collect()
    fireAll(withLogLevel(createProgressReporter(info.sink, false), 'info'))

    const debug = collect()
    fireAll(withLogLevel(createProgressReporter(debug.sink, false), 'debug'))

    expect(debug.lines).toEqual(info.lines)
  })

  it('warn: no per-phase progress chatter, but warnings/result/error still show', () => {
    const c = collect()
    fireAll(withLogLevel(createProgressReporter(c.sink, false), 'warn'))
    const out = c.lines.join('')
    expect(out).not.toContain('testaipack run')
    expect(out).not.toContain('[1/14]')
    expect(out).not.toContain('old/run-1/3')
    expect(out).toContain('warning: docker downgraded')
    expect(out).toContain('1 improvement(s)')
    expect(out).toContain('error: boom')
  })

  it('error: only the error line, nothing else — including on a successful run', () => {
    const c = collect()
    fireAll(withLogLevel(createProgressReporter(c.sink, false), 'error'))
    const out = c.lines.join('')
    expect(out).not.toContain('testaipack run')
    expect(out).not.toContain('[1/14]')
    expect(out).not.toContain('old/run-1/3')
    expect(out).not.toContain('warning: docker downgraded')
    expect(out).not.toContain('improvement')
    expect(out).toBe('error: boom\n')
  })

  it('error is never suppressed, at every level', () => {
    const levels: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
    for (const level of levels) {
      const c = collect()
      withLogLevel(createProgressReporter(c.sink, false), level).error('boom')
      expect(c.lines.join('')).toContain('error: boom')
    }
  })
})
