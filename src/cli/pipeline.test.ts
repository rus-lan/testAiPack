import { describe, it, expect } from 'vitest'
import {
  diffFailureStatus,
  diffFailureWarning,
  dockerDowngradeWarning,
  protectGitHomeWarning,
  redactRunInput,
  warnFsFailure,
} from './pipeline.js'
import { FsError } from '../util/fs.js'
import type { DiffResultOutput, DiffRunResult, DiffRunState, RunInput, Side } from '@generated/types'

describe('cli/pipeline — dockerDowngradeWarning', () => {
  it('returns a warning when flagDefaults.dockerDowngraded is true', () => {
    const msg = dockerDowngradeWarning({ dockerDowngraded: true, configSource: 'cli' })
    expect(msg).toBeDefined()
    expect(msg).toContain('--isolation docker')
    expect(msg).toContain('--isolation home')
  })

  it('returns undefined when dockerDowngraded is false', () => {
    expect(dockerDowngradeWarning({ dockerDowngraded: false, configSource: 'cli' })).toBeUndefined()
  })

  it('returns undefined when dockerDowngraded is absent', () => {
    expect(dockerDowngradeWarning({ configSource: 'cli' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// redactRunInput
// ---------------------------------------------------------------------------

const baseRunInput = (overrides: Partial<RunInput> = {}): RunInput => ({
  repoUrl: 'https://example.com/repo.git',
  prompt: 'build the thing',
  init: 'set up first',
  verify: 'npm test',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: true,
    npmrc: false,
    anthropic: false,
    openai: false,
    gemini: false,
    aws: false,
    ssh: false,
    git: false,
  },
  pureBaseline: true,
  protectGit: false,
  preflightEnabled: false,
  formats: ['md'],
  outputPath: '/out',
  diffHtml: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 30,
    runSeconds: 60,
    verifySeconds: 60,
    installSeconds: 5,
    watchdogSeconds: 90,
  },
  workspacePath: '/ws',
  logLevel: 'info',
  ...overrides,
})

describe('cli/pipeline — redactRunInput', () => {
  it('strips userinfo from repoUrl', () => {
    const out = redactRunInput(baseRunInput({ repoUrl: 'https://user:s3cr3t@example.com/repo.git' }))
    expect(out.repoUrl).toBe('https://example.com/repo.git')
    expect(out.repoUrl).not.toContain('s3cr3t')
  })

  it('strips userinfo from a git-URL packRef', () => {
    const out = redactRunInput(
      baseRunInput({ packRef: 'https://user:token@github.com/org/pack.git' }),
    )
    expect(out.packRef).toBe('https://github.com/org/pack.git')
    expect(out.packRef).not.toContain('token')
  })

  it('truncates an inline mcp: packRef to mcp:<name>, dropping the config payload', () => {
    const out = redactRunInput(
      baseRunInput({ packRef: 'mcp:my-server:{"env":{"API_KEY":"leak-me"}}' }),
    )
    expect(out.packRef).toBe('mcp:my-server')
    expect(out.packRef).not.toContain('leak-me')
  })

  it('leaves packRef absent when the input has none', () => {
    const out = redactRunInput(baseRunInput())
    expect(out.packRef).toBeUndefined()
  })

  it('leaves prompt, init, verify and every other field untouched', () => {
    const input = baseRunInput()
    const out = redactRunInput(input)
    expect(out.prompt).toBe(input.prompt)
    expect(out.init).toBe(input.init)
    expect(out.verify).toBe(input.verify)
    expect(out.runs).toBe(input.runs)
    expect(out.auth).toEqual(input.auth)
    expect(out.outputPath).toBe(input.outputPath)
  })
})

// ---------------------------------------------------------------------------
// warnFsFailure — used to log the best-effort writes (run-input.json etc.)
// without failing the run
// ---------------------------------------------------------------------------

describe('cli/pipeline — warnFsFailure', () => {
  it('formats a warning line naming the artifact, operation, path and cause', () => {
    const e = new FsError({ path: '/ws/run-input.json', operation: 'writeFile', cause: new Error('ENOSPC') })
    const msg = warnFsFailure('run-input.json', e)
    expect(msg).toContain('run-input.json')
    expect(msg).toContain('writeFile')
    expect(msg).toContain('/ws/run-input.json')
    expect(msg).toContain('ENOSPC')
  })
})

// ---------------------------------------------------------------------------
// protectGitHomeWarning
// ---------------------------------------------------------------------------

describe('cli/pipeline — protectGitHomeWarning', () => {
  it('warns when protectGit is combined with isolation=home', () => {
    const msg = protectGitHomeWarning(baseRunInput({ protectGit: true, isolation: 'home' }))
    expect(msg).toBeDefined()
    expect(msg).toContain('--protect-git')
    expect(msg).toContain('--isolation home')
  })

  it('stays undefined when protectGit is true under isolation=docker', () => {
    expect(protectGitHomeWarning(baseRunInput({ protectGit: true, isolation: 'docker' }))).toBeUndefined()
  })

  it('stays undefined when protectGit is false, regardless of isolation', () => {
    expect(protectGitHomeWarning(baseRunInput({ protectGit: false, isolation: 'home' }))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// diffFailureStatus / diffFailureWarning
// ---------------------------------------------------------------------------

const makeDiffRun = (state: DiffRunState): DiffRunResult => ({
  runIndex: 1,
  fullPatch: '',
  summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
  noChanges: false,
  state,
})

const makeDiffSide = (side: Side, states: readonly DiffRunState[]): DiffResultOutput['diff']['old'] => ({
  side,
  runs: states.map((s) => makeDiffRun(s)),
})

const makeDiff = (
  oldStates: readonly DiffRunState[],
  newStates: readonly DiffRunState[],
): DiffResultOutput['diff'] => ({
  old: makeDiffSide('old', oldStates),
  new: makeDiffSide('new', newStates),
})

describe('cli/pipeline — diffFailureStatus', () => {
  it('does not escalate when every run on both sides is ok', () => {
    const status = diffFailureStatus(makeDiff(['ok', 'ok'], ['ok', 'ok']))
    expect(status.escalate).toBe(false)
    expect(status.oldSideFailed).toBe(false)
    expect(status.newSideFailed).toBe(false)
  })

  it('does not escalate when a side has a mix of failed and ok runs (containment already handled it)', () => {
    const status = diffFailureStatus(makeDiff(['failed', 'ok'], ['ok', 'ok']))
    expect(status.escalate).toBe(false)
    expect(status.oldFailed).toBe(1)
    expect(status.oldTotal).toBe(2)
  })

  it('escalates when every run on one side failed', () => {
    const status = diffFailureStatus(makeDiff(['failed', 'failed'], ['ok', 'ok']))
    expect(status.escalate).toBe(true)
    expect(status.oldSideFailed).toBe(true)
    expect(status.newSideFailed).toBe(false)
  })

  it('escalates when every run on both sides failed', () => {
    const status = diffFailureStatus(makeDiff(['failed'], ['failed']))
    expect(status.escalate).toBe(true)
    expect(status.oldSideFailed).toBe(true)
    expect(status.newSideFailed).toBe(true)
  })

  it('does not escalate on an empty side (0 runs is not "all failed")', () => {
    const status = diffFailureStatus(makeDiff([], ['ok']))
    expect(status.oldSideFailed).toBe(false)
    expect(status.escalate).toBe(false)
  })
})

describe('cli/pipeline — diffFailureWarning', () => {
  it('returns undefined when nothing escalated', () => {
    expect(diffFailureWarning(diffFailureStatus(makeDiff(['ok'], ['ok'])))).toBeUndefined()
  })

  it('names the failed side and the failure count when one side fully failed', () => {
    const msg = diffFailureWarning(diffFailureStatus(makeDiff(['failed', 'failed'], ['ok'])))
    expect(msg).toBeDefined()
    expect(msg).toContain('old side')
    expect(msg).toContain('2/2')
    expect(msg).not.toContain('new side')
  })

  it('names both sides when both fully failed', () => {
    const msg = diffFailureWarning(diffFailureStatus(makeDiff(['failed'], ['failed'])))
    expect(msg).toContain('old side')
    expect(msg).toContain('new side')
  })
})
