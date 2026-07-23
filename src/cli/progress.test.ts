import { describe, it, expect } from 'vitest'
import {
  createProgressReporter,
  formatPhaseLine,
  type PhaseDone,
} from './progress.js'

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
