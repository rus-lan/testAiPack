import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import {
  serializePhaseError,
  cliParseError,
  workspaceSetupError,
  repoCloneError,
  packInstallError,
  homeIsolationError,
  preflightError,
  runSideError,
  aggregateError,
  diffError,
  judgeError,
  timelineError,
  reportRenderError,
  reviewWorkspaceError,
  cleanupError,
  PHASE_NAMES,
} from './errors.js'
import type { ErrorCode } from '@generated'

describe('PhaseError', () => {
  it('has _tag "PhaseError"', () => {
    const e = cliParseError('boom', 'E_CONFIG_INVALID')
    expect(e._tag).toBe('PhaseError')
  })

  it('is a real Error (has stack, message)', () => {
    const e = runSideError('crashed', 'E_RUN_CRASH')
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toBe('crashed')
  })

  it('carries a valid ErrorCode from the contract enum', () => {
    const code: ErrorCode = 'E_REPO_CLONE_FAILED'
    const e = repoCloneError('x', code)
    expect(e.code).toBe('E_REPO_CLONE_FAILED')
  })

  it('each phase constructor stamps its phase name', () => {
    expect(cliParseError('m', 'E_CONFIG_INVALID').phase).toBe('cli-parse')
    expect(workspaceSetupError('m', 'E_HOME_SETUP_FAILED').phase).toBe('workspace-setup')
    expect(repoCloneError('m', 'E_REPO_CLONE_FAILED').phase).toBe('repo-clone')
    expect(packInstallError('m', 'E_PACK_INVALID_REF').phase).toBe('pack-install')
    expect(homeIsolationError('m', 'E_HOME_SETUP_FAILED').phase).toBe('home-isolation')
    expect(preflightError('m', 'E_PREFLIGHT_FAILED').phase).toBe('preflight')
    expect(runSideError('m', 'E_RUN_CRASH').phase).toBe('run-side')
    expect(aggregateError('m', 'E_EXPORT_INVALID').phase).toBe('aggregate')
    expect(diffError('m', 'E_DISK_FULL').phase).toBe('diff')
    expect(judgeError('m', 'E_MODEL_UNAVAILABLE').phase).toBe('judge')
    expect(timelineError('m', 'E_EXPORT_INVALID').phase).toBe('timeline')
    expect(reportRenderError('m', 'E_DISK_FULL').phase).toBe('report-render')
    expect(reviewWorkspaceError('m', 'E_CONFIG_INVALID').phase).toBe('review-workspace')
    expect(cleanupError('m', 'E_DISK_FULL').phase).toBe('cleanup')
  })

  it('PHASE_NAMES lists all 14 phases', () => {
    expect(PHASE_NAMES).toHaveLength(14)
  })

  it('serializes to a plain object with ISO timestamp matching the wire PhaseError', () => {
    const ctx = { runIndex: 2, side: 'old' as const }
    const e = runSideError('crashed', 'E_RUN_CRASH', ctx)
    const serialized = serializePhaseError(e)
    expect(serialized._tag).toBe('PhaseError')
    expect(serialized.code).toBe('E_RUN_CRASH')
    expect(serialized.phase).toBe('run-side')
    expect(serialized.message).toBe('crashed')
    expect(serialized.context).toEqual(ctx)
    expect(typeof serialized.timestamp).toBe('string')
    expect(() => new Date(serialized.timestamp).toISOString()).not.toThrow()
    // round-trips to the wire shape
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized)
  })

  it('omit context when not provided (exactOptionalPropertyTypes)', () => {
    const e = cliParseError('m', 'E_CONFIG_INVALID')
    expect(serializePhaseError(e).context).toBeUndefined()
  })

  it('acts as a typed Effect error channel', async () => {
    const e = diffError('disk full', 'E_DISK_FULL')
    const program = Effect.fail(e)
    const flipped = await Effect.runPromise(Effect.flip(program))
    expect(flipped).toBe(e)
    expect(flipped.phase).toBe('diff')
  })
})
