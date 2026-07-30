import { describe, it, expect } from 'vitest'
import {
  diffFailureStatus,
  diffFailureWarning,
  dockerDowngradeWarning,
  initPackContaminationWarning,
  packShortName,
  protectGitHomeWarning,
  redactRunInput,
  resolvePackVisibilityConfirmed,
  warnFsFailure,
} from './pipeline.js'
import { FsError } from '../util/fs.js'
import type { DiffResultOutput, DiffRunResult, DiffRunState, PreflightCheck, RunInput, Side } from '@generated/types'

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
  initSide: 'both',
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
// packShortName
// ---------------------------------------------------------------------------

describe('cli/pipeline — packShortName', () => {
  it('strips a scoped npm: prefix down to the trailing name', () => {
    expect(packShortName('npm:@sentropic/graphify')).toBe('graphify')
  })

  it('strips a bare scoped npm name (no prefix) down to the trailing name', () => {
    expect(packShortName('@sentropic/graphify')).toBe('graphify')
  })

  it('takes the repo name from a git URL, dropping .git', () => {
    expect(packShortName('https://github.com/sentropic/graphify.git')).toBe('graphify')
  })

  it('takes the last segment of a local path', () => {
    expect(packShortName('./local/packs/graphify')).toBe('graphify')
  })

  it('mcp: ref stops at the config-payload colon', () => {
    expect(packShortName('mcp:myserver:{"cmd":"x"}')).toBe('myserver')
  })

  it('lowercases the result', () => {
    expect(packShortName('NPM:GraphiFy')).toBe('graphify')
  })
})

// ---------------------------------------------------------------------------
// initPackContaminationWarning
// ---------------------------------------------------------------------------

describe('cli/pipeline — initPackContaminationWarning', () => {
  it('warns when a pure baseline gets an init that names the pack, initSide=both (default)', () => {
    const msg = initPackContaminationWarning(
      baseRunInput({ pureBaseline: true, initSide: 'both', init: '/graphify .', packRef: 'npm:@sentropic/graphify' }),
    )
    expect(msg).toBeDefined()
    expect(msg).toContain('graphify')
    expect(msg).toContain('--init-side new')
  })

  it('warns for initSide=old too — the baseline still receives it', () => {
    const msg = initPackContaminationWarning(
      baseRunInput({ pureBaseline: true, initSide: 'old', init: '/graphify .', packRef: 'npm:@sentropic/graphify' }),
    )
    expect(msg).toBeDefined()
  })

  it('stays undefined once --init-side new is set — the foot-gun is already fixed', () => {
    expect(
      initPackContaminationWarning(
        baseRunInput({ pureBaseline: true, initSide: 'new', init: '/graphify .', packRef: 'npm:@sentropic/graphify' }),
      ),
    ).toBeUndefined()
  })

  it('stays undefined when --pure-baseline is off — no pure baseline to contaminate', () => {
    expect(
      initPackContaminationWarning(
        baseRunInput({ pureBaseline: false, initSide: 'both', init: '/graphify .', packRef: 'npm:@sentropic/graphify' }),
      ),
    ).toBeUndefined()
  })

  it('stays undefined when init text does not mention the pack — genuine env-setup init', () => {
    expect(
      initPackContaminationWarning(
        baseRunInput({ pureBaseline: true, initSide: 'both', init: 'npm ci', packRef: 'npm:@sentropic/graphify' }),
      ),
    ).toBeUndefined()
  })

  it('stays undefined for a smoke-test run (no packRef)', () => {
    expect(
      initPackContaminationWarning(
        baseRunInput({ pureBaseline: true, initSide: 'both', init: '/graphify .' }),
      ),
    ).toBeUndefined()
  })

  it('stays undefined when there is no init text at all', () => {
    expect(
      initPackContaminationWarning(
        baseRunInput({ pureBaseline: true, initSide: 'both', init: '', packRef: 'npm:@sentropic/graphify' }),
      ),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolvePackVisibilityConfirmed
// ---------------------------------------------------------------------------

const preflightCheck = (over: Partial<PreflightCheck>): PreflightCheck => ({
  name: 'pack-visibility',
  side: 'new',
  passed: true,
  durationMs: '0',
  ...over,
})

describe('cli/pipeline — resolvePackVisibilityConfirmed', () => {
  it('true on a real passing pack-visibility check', () => {
    expect(resolvePackVisibilityConfirmed([preflightCheck({})])).toBe(true)
  })

  it('false when the check failed', () => {
    expect(resolvePackVisibilityConfirmed([preflightCheck({ passed: false })])).toBe(false)
  })

  it('false on "skipped (no pack)" — passed:true there means "not applicable", not "confirmed"', () => {
    expect(
      resolvePackVisibilityConfirmed([preflightCheck({ details: 'skipped (no pack)' })]),
    ).toBe(false)
  })

  it('false when there is no pack-visibility check at all (e.g. --no-preflight)', () => {
    expect(resolvePackVisibilityConfirmed([])).toBe(false)
  })

  it('ignores checks with a different name', () => {
    expect(
      resolvePackVisibilityConfirmed([preflightCheck({ name: 'auth-ping' })]),
    ).toBe(false)
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
