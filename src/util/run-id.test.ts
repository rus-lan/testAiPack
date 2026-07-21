import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { generateRunId } from './run-id.js'

const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{6}$/

describe('generateRunId', () => {
  it('matches the canonical regex', async () => {
    const id = await Effect.runPromise(generateRunId())
    expect(id).toMatch(RUN_ID_RE)
  })

  it('produces distinct ids on successive calls (hex part is random)', async () => {
    const a = await Effect.runPromise(generateRunId())
    const b = await Effect.runPromise(generateRunId())
    expect(a).not.toBe(b)
  })

  it('keeps a deterministic timestamp prefix for a fixed Date', async () => {
    const fixed = new Date('2026-07-21T17:30:00.000Z')
    // interpret the fixed Date in UTC for a stable, locale-independent prefix
    const id = await Effect.runPromise(generateRunId(fixed))
    expect(id).toMatch(/^2026-07-21_17-30-00_[a-f0-9]{6}$/)
  })

  it('default parameter is new Date() (no throw, valid format)', async () => {
    const id = await Effect.runPromise(generateRunId())
    const hex = id.split('_')[2]
    expect(hex).toHaveLength(6)
  })
})
