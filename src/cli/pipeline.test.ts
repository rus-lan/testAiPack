import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import {
  checkExerciseIntegrity,
  diffFailureStatus,
  diffFailureWarning,
  dockerDowngradeWarning,
  excludeFailedExerciseArtifacts,
  initPackContaminationWarnings,
  packExerciseWithoutCheckWarnings,
  protectGitHomeWarning,
  redactRunInput,
  resolvePackVisibilityConfirmed,
  runPipeline,
  warnFsFailure,
} from './pipeline.js'
import type { PipelineOptions } from './pipeline.js'
import type { ProgressReporter } from './progress.js'
import { FsError, ensureDir, readJson, writeFile } from '../util/fs.js'
import { addAll, commit, init, lsFilesStage } from '../util/git.js'
import { makeTempDir } from '../../tests/setup.js'
import { threeVariants } from '../../tests/helpers/variants.js'
import { z } from 'zod'
import type {
  DiffResult,
  DiffRunResult,
  DiffRunState,
  PackCmdResult,
  PreflightCheck,
  PrepReport,
  RunInput,
} from '@generated/types'

const run = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

// ---------------------------------------------------------------------------
// 00-cli-parse.ts (WP2) owns effectiveOf/packsOf/foreignPacksOf/packShortName
// and cliParse itself — none of it has landed yet. Real, spec-shaped
// implementations here (per D7/D4 in 00-overview.md) so the pure warning
// helpers below behave correctly; `cliParse` stays a bare vi.fn() the
// integration suite configures per test. TODO(WP15): unmock — delete this
// whole vi.mock once 00-cli-parse.ts exports the real thing.
// ---------------------------------------------------------------------------
const cliParseHelpers = vi.hoisted(() => {
  const effectiveOf = (
    v: Record<string, unknown>,
    g: string | undefined,
    key: string,
  ): string | undefined => {
    const own = v[key]
    if (own === undefined) return g
    return own === '' ? undefined : (own as string)
  }
  const packsOf = (
    runInput: { readonly packs: readonly { readonly name: string }[] },
    v: { readonly packs: readonly string[] },
  ): readonly { readonly name: string }[] =>
    v.packs.flatMap((name) => {
      const p = runInput.packs.find((pk) => pk.name === name)
      return p === undefined ? [] : [p]
    })
  const foreignPacksOf = (
    runInput: {
      readonly packs: readonly { readonly name: string }[]
      readonly variants: readonly { readonly name: string; readonly packs: readonly string[] }[]
    },
    v: { readonly name: string; readonly packs: readonly string[] },
  ): readonly { readonly name: string }[] => {
    const ownNames = new Set(v.packs)
    const foreignNames = new Set(
      runInput.variants
        .filter((other) => other.name !== v.name)
        .flatMap((other) => other.packs)
        .filter((n) => !ownNames.has(n)),
    )
    return runInput.packs.filter((p) => foreignNames.has(p.name))
  }
  const packShortName = (ref: string): string => {
    const prefixMatch = /^(npm:|mcp:|agent:|command:)/i.exec(ref)
    const afterPrefix = prefixMatch === null ? ref : ref.slice(prefixMatch[0].length)
    const afterMcpConfig =
      prefixMatch?.[0].toLowerCase() === 'mcp:' && afterPrefix.includes(':')
        ? afterPrefix.slice(0, afterPrefix.indexOf(':'))
        : afterPrefix
    const clean = afterMcpConfig.replace(/\.git$/, '').replace(/\/+$/, '')
    const parts = clean.split('/')
    return (parts[parts.length - 1] ?? clean).toLowerCase()
  }
  return { effectiveOf, packsOf, foreignPacksOf, packShortName }
})

const packSetupHelpers = vi.hoisted(() => {
  const derivePackSetupMode = (
    setupDeclared: boolean,
    checkVerified: boolean,
    exerciseHappened: boolean,
  ): 'exercised' | 'installed-only' | 'delivered-only' => {
    if (checkVerified && exerciseHappened) return 'exercised'
    if (setupDeclared || checkVerified || exerciseHappened) return 'installed-only'
    return 'delivered-only'
  }
  return { derivePackSetupMode }
})

vi.mock('../phases/00-cli-parse.js', () => ({
  cliParse: vi.fn(),
  effectiveOf: cliParseHelpers.effectiveOf,
  packsOf: cliParseHelpers.packsOf,
  foreignPacksOf: cliParseHelpers.foreignPacksOf,
  packShortName: cliParseHelpers.packShortName,
}))
vi.mock('../phases/01-workspace-setup.js', () => ({ workspaceSetup: vi.fn() }))
vi.mock('../phases/02-repo-clone.js', () => ({ repoClone: vi.fn() }))
vi.mock('../phases/03-pack-install.js', () => ({ packInstall: vi.fn() }))
vi.mock('../phases/04-home-isolation.js', () => ({ homeIsolation: vi.fn() }))
vi.mock('../phases/04b-pack-setup.js', () => ({
  packSetup: vi.fn(),
  derivePackSetupMode: packSetupHelpers.derivePackSetupMode,
}))
vi.mock('../phases/05-preflight.js', () => ({ preflight: vi.fn() }))
vi.mock('../phases/06-run-side.js', () => ({ runSide: vi.fn() }))
vi.mock('../phases/06-config-capture.js', () => ({ captureOpencodeConfig: vi.fn() }))
vi.mock('../phases/07-aggregate.js', () => ({ aggregate: vi.fn() }))
vi.mock('../phases/08-diff.js', () => ({ diff: vi.fn() }))
vi.mock('../phases/09-judge.js', () => ({ judge: vi.fn() }))
vi.mock('../phases/10-timeline.js', () => ({ timeline: vi.fn() }))
vi.mock('../phases/11-report-render.js', () => ({ reportRender: vi.fn() }))
vi.mock('../phases/12-review-workspace.js', () => ({ reviewWorkspace: vi.fn() }))
vi.mock('../phases/13-cleanup.js', () => ({ cleanup: vi.fn() }))
vi.mock('./summary.js', () => ({ buildReportSummary: vi.fn() }))
// The exercise mechanism (runOneVariant -> runPackExercise) shells out for
// real; stubbed so a variant with `exercise` set never spawns a process.
// `../util/git.js` stays REAL (excludeFailedExerciseArtifacts's tests below
// need genuine git behavior), so exercising tests use a real git repo as the
// variant's app dir instead of mocking git away.
vi.mock('../isolation/shell-runner.js', () => ({
  runShellInHome: vi.fn(() => Effect.succeed({ exitCode: 0, durationMs: 5, outputTail: '', timedOut: false })),
}))

import { cliParse } from '../phases/00-cli-parse.js'
import { workspaceSetup } from '../phases/01-workspace-setup.js'
import { repoClone } from '../phases/02-repo-clone.js'
import { packInstall } from '../phases/03-pack-install.js'
import { homeIsolation } from '../phases/04-home-isolation.js'
import { packSetup } from '../phases/04b-pack-setup.js'
import { preflight } from '../phases/05-preflight.js'
import { runSide } from '../phases/06-run-side.js'
import { captureOpencodeConfig } from '../phases/06-config-capture.js'
import { aggregate } from '../phases/07-aggregate.js'
import { diff } from '../phases/08-diff.js'
import { judge } from '../phases/09-judge.js'
import { timeline } from '../phases/10-timeline.js'
import { reportRender } from '../phases/11-report-render.js'
import { reviewWorkspace } from '../phases/12-review-workspace.js'
import { cleanup } from '../phases/13-cleanup.js'
import { buildReportSummary } from './summary.js'
import { makeWorkspaceTree } from '../../tests/helpers/variants.js'

/** Build a real git repo at dir with one committed file, ready for exercise output on top. */
const buildRepo = async (dir: string): Promise<void> => {
  await run(init(dir))
  await run(writeFile(path.join(dir, 'a.txt'), 'a\n'))
  await run(addAll(dir))
  await run(commit(dir, 'init'))
}

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
// checkExerciseIntegrity — review-gate regression: the artifact hash was
// computed but never asserted or compared across runs, so "exited 0, wrote
// nothing" was indistinguishable from a real exercise.
// ---------------------------------------------------------------------------

const exerciseResult = (over: Partial<PackCmdResult> = {}): PackCmdResult => ({
  variant: 'graphify',
  runIndex: 1,
  exitCode: 0,
  durationMs: '10',
  ...over,
})

describe('cli/pipeline — checkExerciseIntegrity', () => {
  it('no exercises at all (nothing declared) → quiet', () => {
    expect(checkExerciseIntegrity([])).toBeUndefined()
  })

  it('every exercise exited 0 but left no artifact → flagged as suspicious, not silent success', () => {
    const msg = checkExerciseIntegrity([
      exerciseResult({ runIndex: 1 }),
      exerciseResult({ runIndex: 2 }),
      exerciseResult({ runIndex: 3 }),
    ])
    expect(msg).toBeDefined()
    expect(msg).toContain('no-op')
    expect(msg).toContain('3')
  })

  it('same artifact hash across every run → quiet (deterministic, real output)', () => {
    const msg = checkExerciseIntegrity([
      exerciseResult({ runIndex: 1, artifactHash: 'abc' }),
      exerciseResult({ runIndex: 2, artifactHash: 'abc' }),
      exerciseResult({ runIndex: 3, artifactHash: 'abc' }),
    ])
    expect(msg).toBeUndefined()
  })

  it('artifact hash diverges across runs → flagged as possibly non-deterministic', () => {
    const msg = checkExerciseIntegrity([
      exerciseResult({ runIndex: 1, artifactHash: 'abc' }),
      exerciseResult({ runIndex: 2, artifactHash: 'def' }),
      exerciseResult({ runIndex: 3, artifactHash: 'abc' }),
    ])
    expect(msg).toBeDefined()
    expect(msg).toContain('non-deterministic')
    expect(msg).toContain('2')
  })

  it('a mix of no-artifact and matching-artifact runs is judged on the runs that did produce output', () => {
    const msg = checkExerciseIntegrity([
      exerciseResult({ runIndex: 1, artifactHash: 'abc' }),
      exerciseResult({ runIndex: 2 }), // no artifact this run
      exerciseResult({ runIndex: 3, artifactHash: 'abc' }),
    ])
    expect(msg).toBeUndefined()
  })

  it('a crashed exercise (exitCode !== 0) is never judged as a successful no-op — that failure is already surfaced elsewhere', () => {
    // No run actually exited 0, so there is nothing to judge — quiet, not a
    // false "exited 0 but left no artifact" diagnosis on a run that crashed.
    const msg = checkExerciseIntegrity([exerciseResult({ runIndex: 1, exitCode: 1 })])
    expect(msg).toBeUndefined()
  })

  it('judges only the runs that actually exited 0 when some runs crashed and others succeeded cleanly', () => {
    const msg = checkExerciseIntegrity([
      exerciseResult({ runIndex: 1, exitCode: 1 }), // crashed — excluded from judgment
      exerciseResult({ runIndex: 2, exitCode: 0 }), // exited 0, no artifact
    ])
    expect(msg).toBeDefined()
    expect(msg).toContain('no-op')
    // Judged over the 1 run that actually ran, not the 2 total exercises.
    expect(msg).toContain('1')
  })
})

// ---------------------------------------------------------------------------
// excludeFailedExerciseArtifacts
// ---------------------------------------------------------------------------

describe('cli/pipeline — excludeFailedExerciseArtifacts (failed exercise diff hygiene)', () => {
  const exerciseRecordSchema = z.object({ excludedPaths: z.array(z.string()) })

  it('excludes a failed exercise\'s untracked output and persists the run-N.exercise.json record for phase 08 to re-apply', async () => {
    const repo = makeTempDir()
    await buildRepo(repo)
    await run(writeFile(path.join(repo, 'partial-output.log'), 'half-built\n'))
    const rawDir = makeTempDir()

    await run(excludeFailedExerciseArtifacts(repo, path.join(repo, '.git'), rawDir, 3))

    const record = await run(readJson(path.join(rawDir, 'run-3.exercise.json'), exerciseRecordSchema))
    expect(record).toEqual({ excludedPaths: ['partial-output.log'] })

    // phase 08's `git add -A` (addAll) must not stage it.
    await run(addAll(repo))
    const staged = await run(lsFilesStage(repo))
    expect(staged).not.toContain('partial-output.log')
  })

  it('is a no-op (no record written) when the failed exercise left nothing untracked', async () => {
    const repo = makeTempDir()
    await buildRepo(repo)
    const rawDir = makeTempDir()

    await run(excludeFailedExerciseArtifacts(repo, path.join(repo, '.git'), rawDir, 1))

    const err = await run(readJson(path.join(rawDir, 'run-1.exercise.json'), exerciseRecordSchema).pipe(Effect.option))
    expect(err._tag).toBe('None')
  })

  it('never fails the effect even against a broken gitDir — best-effort, since the run is already contained as failed', async () => {
    const repo = makeTempDir()
    const bogusGitDir = path.join(makeTempDir(), 'nope')
    const rawDir = makeTempDir()

    // Resolves cleanly instead of throwing/failing — Effect.ignore swallows
    // the underlying GitError from a non-existent gitDir.
    await expect(run(excludeFailedExerciseArtifacts(repo, bogusGitDir, rawDir, 1))).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// redactRunInput
// ---------------------------------------------------------------------------

describe('cli/pipeline — redactRunInput', () => {
  it('strips userinfo from repoUrl', () => {
    const { runInput } = threeVariants()
    const out = redactRunInput({ ...runInput, repoUrl: 'https://user:s3cr3t@example.com/repo.git' })
    expect(out.repoUrl).toBe('https://example.com/repo.git')
    expect(out.repoUrl).not.toContain('s3cr3t')
  })

  it('strips userinfo from every registry pack ref, not just the first', () => {
    const { runInput } = threeVariants()
    const out = redactRunInput({
      ...runInput,
      packs: [
        { name: 'graphify', ref: 'https://user:token-one@github.com/org/pack-one.git' },
        { name: 'astgrep', ref: 'https://user:token-two@github.com/org/pack-two.git' },
        { name: 'third', ref: 'https://user:token-three@github.com/org/pack-three.git' },
      ],
    })
    expect(out.packs).toEqual([
      { name: 'graphify', ref: 'https://github.com/org/pack-one.git' },
      { name: 'astgrep', ref: 'https://github.com/org/pack-two.git' },
      { name: 'third', ref: 'https://github.com/org/pack-three.git' },
    ])
    const serialized = JSON.stringify(out.packs)
    expect(serialized).not.toContain('token-one')
    expect(serialized).not.toContain('token-two')
    expect(serialized).not.toContain('token-three')
  })

  it('truncates an inline mcp: pack ref to mcp:<name>, dropping the config payload', () => {
    const { runInput } = threeVariants()
    const out = redactRunInput({
      ...runInput,
      packs: [{ name: 'srv', ref: 'mcp:my-server:{"env":{"API_KEY":"leak-me"}}' }],
    })
    expect(out.packs[0]?.ref).toBe('mcp:my-server')
    expect(out.packs[0]?.ref).not.toContain('leak-me')
  })

  it('leaves an empty pack registry as an empty array', () => {
    const { runInput } = threeVariants()
    const out = redactRunInput({ ...runInput, packs: [] })
    expect(out.packs).toEqual([])
  })

  it('leaves prompt, variants and every other field untouched', () => {
    const { runInput: input } = threeVariants()
    const out = redactRunInput(input)
    expect(out.prompt).toBe(input.prompt)
    expect(out.runs).toBe(input.runs)
    expect(out.variants).toEqual(input.variants)
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
  const base = (): RunInput => threeVariants().runInput

  it('warns when protectGit is combined with isolation=home', () => {
    const msg = protectGitHomeWarning({ ...base(), protectGit: true, isolation: 'home' })
    expect(msg).toBeDefined()
    expect(msg).toContain('--protect-git')
    expect(msg).toContain('--isolation home')
  })

  it('stays undefined when protectGit is true under isolation=docker', () => {
    expect(protectGitHomeWarning({ ...base(), protectGit: true, isolation: 'docker' })).toBeUndefined()
  })

  it('stays undefined when protectGit is false, regardless of isolation', () => {
    expect(protectGitHomeWarning({ ...base(), protectGit: false, isolation: 'home' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// initPackContaminationWarnings / packExerciseWithoutCheckWarnings — the D7/
// foreign-set generalization of the v1 single-pack warnings, over
// tests/helpers/variants.ts's threeVariants() fixture (base is pure,
// graphify/astgrep each declare one pack).
// ---------------------------------------------------------------------------

describe('cli/pipeline — initPackContaminationWarnings', () => {
  it('warns once per pure variant whose init/prompt names a foreign pack', () => {
    const { runInput } = threeVariants()
    const contaminated: RunInput = {
      ...runInput,
      variants: runInput.variants.map((v) => (v.name === 'base' ? { ...v, init: 'run /graphify now' } : v)),
    }
    const warnings = initPackContaminationWarnings(contaminated)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('base')
    expect(warnings[0]).toContain('graphify')
  })

  it('stays quiet when the variant is not pure', () => {
    const { runInput } = threeVariants()
    const notPure: RunInput = {
      ...runInput,
      variants: runInput.variants.map((v) => (v.name === 'base' ? { ...v, pure: false, init: 'run /graphify now' } : v)),
    }
    expect(initPackContaminationWarnings(notPure)).toEqual([])
  })

  it('stays quiet when init/prompt text does not mention any foreign pack', () => {
    const { runInput } = threeVariants()
    const clean: RunInput = {
      ...runInput,
      variants: runInput.variants.map((v) => (v.name === 'base' ? { ...v, init: 'npm ci' } : v)),
    }
    expect(initPackContaminationWarnings(clean)).toEqual([])
  })

  it('a variant does not warn about its own declared pack (only foreign ones)', () => {
    const { runInput } = threeVariants()
    // graphify declares graphify — not pure (has packs), so no warning regardless.
    const selfMention: RunInput = {
      ...runInput,
      variants: runInput.variants.map((v) => (v.name === 'graphify' ? { ...v, init: 'run /graphify now' } : v)),
    }
    expect(initPackContaminationWarnings(selfMention)).toEqual([])
  })
})

describe('cli/pipeline — packExerciseWithoutCheckWarnings', () => {
  it('warns for a variant with exercise whose packs declare no check', () => {
    const { runInput } = threeVariants()
    const withExercise: RunInput = {
      ...runInput,
      variants: runInput.variants.map((v) => (v.name === 'graphify' ? { ...v, exercise: 'run-thing' } : v)),
    }
    const warnings = packExerciseWithoutCheckWarnings(withExercise)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('graphify')
  })

  it('stays quiet once the exercising variant\'s pack declares a check', () => {
    const { runInput } = threeVariants()
    const checked: RunInput = {
      ...runInput,
      packs: runInput.packs.map((p) => (p.name === 'graphify' ? { ...p, check: 'graphify --version' } : p)),
      variants: runInput.variants.map((v) => (v.name === 'graphify' ? { ...v, exercise: 'run-thing' } : v)),
    }
    expect(packExerciseWithoutCheckWarnings(checked)).toEqual([])
  })

  it('stays quiet when no variant declares an exercise', () => {
    const { runInput } = threeVariants()
    expect(packExerciseWithoutCheckWarnings(runInput)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolvePackVisibilityConfirmed
// ---------------------------------------------------------------------------

const preflightCheck = (over: Partial<PreflightCheck>): PreflightCheck => ({
  name: 'pack-visibility',
  variant: 'graphify',
  passed: true,
  durationMs: '0',
  ...over,
})

describe('cli/pipeline — resolvePackVisibilityConfirmed', () => {
  it('maps a real passing pack-visibility check to a confirmed PackVisibilityEntry', () => {
    const entries = resolvePackVisibilityConfirmed([
      preflightCheck({ details: 'pack-visibility [graphify/graphify]' }),
    ])
    expect(entries).toEqual([{ variant: 'graphify', pack: 'graphify', confirmed: true }])
  })

  it('produces no entry for "skipped (no pack)" — that means "not applicable", not "confirmed"', () => {
    const entries = resolvePackVisibilityConfirmed([preflightCheck({ details: 'skipped (no pack)' })])
    expect(entries).toEqual([])
  })

  it('produces no entries when there is no pack-visibility check at all (e.g. --no-preflight)', () => {
    expect(resolvePackVisibilityConfirmed([])).toEqual([])
  })

  it('ignores checks with a different name', () => {
    const entries = resolvePackVisibilityConfirmed([
      preflightCheck({ name: 'auth-ping', details: 'pack-visibility [graphify/graphify]' }),
    ])
    expect(entries).toEqual([])
  })

  it('keeps distinct entries for two different (variant, pack) pairs', () => {
    const entries = resolvePackVisibilityConfirmed([
      preflightCheck({ variant: 'graphify', details: 'pack-visibility [graphify/graphify]' }),
      preflightCheck({ variant: 'astgrep', details: 'pack-visibility [astgrep/astgrep]' }),
    ])
    expect(entries).toEqual([
      { variant: 'graphify', pack: 'graphify', confirmed: true },
      { variant: 'astgrep', pack: 'astgrep', confirmed: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// diffFailureStatus / diffFailureWarning — over DiffResult[] (one per
// variant) instead of the v1 {old,new} pair.
// ---------------------------------------------------------------------------

const makeDiffRun = (state: DiffRunState): DiffRunResult => ({
  runIndex: 1,
  fullPatch: '',
  summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
  noChanges: false,
  state,
})

const makeDiffResult = (variant: string, states: readonly DiffRunState[]): DiffResult => ({
  variant,
  runs: states.map((s) => makeDiffRun(s)),
})

describe('cli/pipeline — diffFailureStatus', () => {
  it('does not escalate when every run on every variant is ok', () => {
    const status = diffFailureStatus([
      makeDiffResult('base', ['ok', 'ok']),
      makeDiffResult('graphify', ['ok', 'ok']),
    ])
    expect(status.escalate).toBe(false)
    expect(status.failedVariants).toEqual([])
  })

  it('does not escalate when a variant has a mix of failed and ok runs (containment already handled it)', () => {
    const status = diffFailureStatus([makeDiffResult('base', ['failed', 'ok'])])
    expect(status.escalate).toBe(false)
    expect(status.perVariant[0]).toEqual({ variant: 'base', failed: 1, total: 2 })
  })

  it('escalates when every run on one variant failed, naming only that variant', () => {
    const status = diffFailureStatus([
      makeDiffResult('base', ['failed', 'failed']),
      makeDiffResult('graphify', ['ok', 'ok']),
    ])
    expect(status.escalate).toBe(true)
    expect(status.failedVariants).toEqual(['base'])
  })

  it('escalates and names every variant when all of them fully failed', () => {
    const status = diffFailureStatus([makeDiffResult('base', ['failed']), makeDiffResult('graphify', ['failed'])])
    expect(status.escalate).toBe(true)
    expect(status.failedVariants).toEqual(['base', 'graphify'])
  })

  it('does not escalate on an empty variant (0 runs is not "all failed")', () => {
    const status = diffFailureStatus([makeDiffResult('base', [])])
    expect(status.escalate).toBe(false)
  })
})

describe('cli/pipeline — diffFailureWarning', () => {
  it('returns undefined when nothing escalated', () => {
    expect(diffFailureWarning(diffFailureStatus([makeDiffResult('base', ['ok'])]))).toBeUndefined()
  })

  it('names the failed variant and the failure count when one variant fully failed', () => {
    const msg = diffFailureWarning(
      diffFailureStatus([makeDiffResult('base', ['failed', 'failed']), makeDiffResult('graphify', ['ok'])]),
    )
    expect(msg).toBeDefined()
    expect(msg).toContain('base')
    expect(msg).toContain('2/2')
    expect(msg).not.toContain('graphify')
  })

  it('names every variant when all of them fully failed', () => {
    const msg = diffFailureWarning(diffFailureStatus([makeDiffResult('base', ['failed']), makeDiffResult('graphify', ['failed'])]))
    expect(msg).toContain('base')
    expect(msg).toContain('graphify')
  })
})

// ---------------------------------------------------------------------------
// runPipeline — full orchestration with every phase module mocked (per the
// D16 vitest-scoped verification strategy: the phase files this pipeline
// imports are owned by other in-flight packages, so their real
// implementations are not exercised here — only the wiring is).
// ---------------------------------------------------------------------------

const noopReporter: ProgressReporter = {
  header: vi.fn(),
  phaseDone: vi.fn(),
  sub: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  done: vi.fn(),
}

const pipelineOptions = (): PipelineOptions => ({
  argv: [],
  cwd: '/tmp',
  reviewRun: 1,
  ide: 'code',
  ephemeral: false,
  reporter: noopReporter,
})

/** Every non-run-side phase, wired to a minimal-but-valid success result. Callers override `runSide` and any phase they care about. */
const configureBaselineMocks = (runInput: RunInput, root: string): void => {
  const variantNames = runInput.variants.map((v) => v.name)
  const treePaths = makeWorkspaceTree(root, runInput.runs, variantNames)

  vi.mocked(cliParse).mockReturnValue(
    Effect.succeed({ runInput, configSource: 'cli', flagDefaults: {}, outputPathProvided: false }),
  )
  vi.mocked(workspaceSetup).mockReturnValue(
    Effect.succeed({
      manifest: {
        schemaVersion: 2,
        runId: 'run-test',
        timestamp: '2026-01-01T00:00:00.000Z',
        repoUrl: runInput.repoUrl,
        ...(runInput.prompt === undefined ? {} : { prompt: runInput.prompt }),
        runs: runInput.runs,
        parallel: runInput.parallel,
        baseline: runInput.baseline,
        packs: runInput.packs,
        variants: runInput.variants,
        isolation: runInput.isolation,
        opencodeVersion: '0.5.0',
        flagDefaults: {},
      },
      rootPath: root,
      treePaths,
    }),
  )
  vi.mocked(repoClone).mockReturnValue(
    Effect.succeed({ sourcePath: treePaths.appsSource, copyPaths: [], cloneDurationMs: '0' }),
  )
  vi.mocked(packInstall).mockReturnValue(Effect.succeed({ deliveries: [], installLogPath: path.join(root, 'install.log') }))
  vi.mocked(homeIsolation).mockReturnValue(
    Effect.succeed({
      homeTrees: variantNames.map((name) => ({
        name,
        trees: Array.from({ length: runInput.runs }, () => ({ basePath: '/tmp/home', structure: [], copiedAuth: [] })),
      })),
      envVars: variantNames.map((name) => ({
        name,
        envs: Array.from({ length: runInput.runs }, () => ({
          HOME: '/tmp/home',
          OPENCODE_DISABLE_PROJECT_CONFIG: true,
          OPENCODE_DISABLE_DEFAULT_PLUGINS: false,
          OPENCODE_DISABLE_EXTERNAL_SKILLS: false,
          OPENCODE_PURE: false,
        })),
      })),
      generatedConfigs: variantNames.map((name) => ({ name, config: '{}' })),
      isolation: 'home',
    }),
  )
  vi.mocked(packSetup).mockReturnValue(
    Effect.succeed({
      report: {
        packs: runInput.packs.map((p) => ({
          pack: p.name,
          mode: 'delivered-only' as const,
          setupDeclared: p.setup !== undefined,
          checkDeclared: p.check !== undefined,
          exerciseDeclared: runInput.variants.some((v) => v.exercise !== undefined && v.packs.includes(p.name)),
          setups: [],
          checks: [],
        })),
        variants: runInput.variants.map((v) => ({
          variant: v.name,
          exerciseDeclared: v.exercise !== undefined,
          exercises: [],
        })),
      },
      logPath: path.join(root, 'pack-setup.log'),
    }),
  )
  vi.mocked(preflight).mockReturnValue(
    Effect.succeed({ checks: [], allPassed: true, exitCode: 0, logPath: path.join(root, 'preflight.log') }),
  )
  vi.mocked(captureOpencodeConfig).mockReturnValue(Effect.succeed({ capturedDirs: [] }))
  vi.mocked(aggregate).mockReturnValue(
    Effect.succeed({
      metrics: {
        baseline: runInput.baseline,
        variants: [],
        deltas: [],
        allFailed: false,
      },
    }),
  )
  vi.mocked(diff).mockReturnValue(
    Effect.succeed({
      diffs: variantNames.map((name): DiffResult => ({
        variant: name,
        runs: [
          {
            runIndex: 1,
            fullPatch: '',
            summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
            noChanges: true,
            state: 'ok',
          },
        ],
      })),
    }),
  )
  vi.mocked(judge).mockReturnValue(Effect.succeed({ judge: null }))
  vi.mocked(timeline).mockReturnValue(
    Effect.succeed({
      timeline: { lanes: variantNames.map((name) => ({ variant: name, events: [] })), mode: 'side-by-side' },
      jsonPath: path.join(root, 'timeline.json'),
    }),
  )
  vi.mocked(buildReportSummary).mockReturnValue({
    headlineResult: 'no significant differences',
    perVariant: variantNames.map((name) => ({ variant: name, improvements: [], regressions: [], neutral: [] })),
    failures: [],
  })
  vi.mocked(reportRender).mockReturnValue(
    Effect.succeed({
      formats: ['md'],
      paths: { md: path.join(root, 'report.md') },
      stdoutFormat: 'md',
      stdoutMd: 'report body',
    }),
  )
  vi.mocked(reviewWorkspace).mockReturnValue(
    Effect.succeed({ workspacePath: path.join(root, 'review.code-workspace'), opened: false, command: 'code' }),
  )
  vi.mocked(cleanup).mockReturnValue(Effect.succeed({ deleted: [], kept: [], gcLogPath: path.join(root, 'gc.log') }))
}

interface RunSideEvent {
  readonly variant: string
  readonly type: 'start' | 'end'
}

/** `runSide` mock that logs a start/end pair per call (after a short real delay) so concurrency is observable without a fake clock. */
const mockRunSideWithLog = (): { readonly events: RunSideEvent[] } => {
  const events: RunSideEvent[] = []
  vi.mocked(runSide).mockImplementation((input) =>
    Effect.gen(function* () {
      const variant = input.variant.name
      events.push({ variant, type: 'start' })
      yield* Effect.sleep(20)
      events.push({ variant, type: 'end' })
      return {
        variant,
        runIndex: input.runIndex,
        exportPath: '',
        eventsLogPath: '',
        successRank: 4,
        finishCause: 'stop',
        exitCode: 0,
        durationMs: '10',
        watchdogTriggered: false,
      }
    }),
  )
  return { events }
}

describe('cli/pipeline — runPipeline concurrency (parallel)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parallel: 1 runs a 3-variant run\'s variants strictly sequentially', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    const serialInput: RunInput = { ...runInput, parallel: 1 }
    configureBaselineMocks(serialInput, root)
    const { events } = mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    // 3 variants x 1 run each x (start, end) = 6 events, strictly paired:
    // no variant's "start" appears before the previous variant's "end".
    expect(events).toHaveLength(6)
    const starts = events.filter((e) => e.type === 'start').map((e) => e.variant)
    expect(starts).toEqual(['base', 'graphify', 'astgrep'])
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]?.type).toBe('start')
      expect(events[i + 1]?.type).toBe('end')
      expect(events[i]?.variant).toBe(events[i + 1]?.variant)
    }
  })

  it('parallel: 3 starts all three runOneVariant effects before any completes', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    const parallelInput: RunInput = { ...runInput, parallel: 3 }
    configureBaselineMocks(parallelInput, root)
    const { events } = mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    expect(events).toHaveLength(6)
    const firstThree = events.slice(0, 3)
    expect(firstThree.every((e) => e.type === 'start')).toBe(true)
    expect(new Set(firstThree.map((e) => e.variant)).size).toBe(3)
  })

  it('parallel: 1 keeps a variant\'s OWN runs strictly sequential too, not just the variant fan-out', async () => {
    // threeVariants() fixes runs: 1, so the two tests above cannot tell
    // { concurrency: 1 } apart from unbounded concurrency on the INNER
    // Effect.forEach over a variant's own runs (runOneVariant) — with a
    // single run there is nothing to interleave. runs: 3 forces 3 events
    // per variant, so an unbounded inner concurrency would start all 3 of a
    // variant's runs together (start, start, start, ...) and break the
    // strict pairing asserted below.
    const { runInput } = threeVariants()
    const root = makeTempDir()
    const serialInput: RunInput = { ...runInput, runs: 3, parallel: 1 }
    configureBaselineMocks(serialInput, root)
    const { events } = mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    // 3 variants x 3 runs each x (start, end) = 18 events, strictly paired
    // regardless of variant boundary.
    expect(events).toHaveLength(18)
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]?.type).toBe('start')
      expect(events[i + 1]?.type).toBe('end')
      expect(events[i]?.variant).toBe(events[i + 1]?.variant)
    }
    // The 3 variants still run in array order, one variant's 3 runs fully
    // finishing before the next variant's first run starts.
    const variantOfBlock = (blockIndex: number): string | undefined => events[blockIndex * 6]?.variant
    expect([variantOfBlock(0), variantOfBlock(1), variantOfBlock(2)]).toEqual(['base', 'graphify', 'astgrep'])
  })
})

describe('cli/pipeline — runPipeline prep.json', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes results/prep.json with per-pack checks (gate 6) and per-variant exercises', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    await run(ensureDir(root))
    await run(ensureDir(path.join(root, 'results')))

    // A real git repo backs the exercising variant's app dir — runPackExercise
    // (pipeline.ts, not mocked) shells out via the mocked shell-runner but
    // still calls the REAL git status/exclude helpers against this dir.
    const graphifyAppDir = makeTempDir()
    await buildRepo(graphifyAppDir)

    const withCheckAndExercise: RunInput = {
      ...runInput,
      parallel: 3,
      packs: runInput.packs.map((p) => (p.name === 'graphify' ? { ...p, check: 'graphify --version' } : p)),
      variants: runInput.variants.map((v) => (v.name === 'graphify' ? { ...v, exercise: 'run-graphify' } : v)),
    }
    configureBaselineMocks(withCheckAndExercise, root)
    const treePaths = makeWorkspaceTree(root, withCheckAndExercise.runs, withCheckAndExercise.variants.map((v) => v.name))
    const patchedTreePaths = {
      ...treePaths,
      variantTrees: treePaths.variantTrees.map((vt) =>
        vt.name === 'graphify' ? { ...vt, apps: [graphifyAppDir] } : vt,
      ),
    }
    vi.mocked(workspaceSetup).mockReturnValue(
      Effect.succeed({
        manifest: {
          schemaVersion: 2,
          runId: 'run-test',
          timestamp: '2026-01-01T00:00:00.000Z',
          repoUrl: withCheckAndExercise.repoUrl,
          ...(withCheckAndExercise.prompt === undefined ? {} : { prompt: withCheckAndExercise.prompt }),
          runs: withCheckAndExercise.runs,
          parallel: withCheckAndExercise.parallel,
          baseline: withCheckAndExercise.baseline,
          packs: withCheckAndExercise.packs,
          variants: withCheckAndExercise.variants,
          isolation: withCheckAndExercise.isolation,
          opencodeVersion: '0.5.0',
          flagDefaults: {},
        },
        rootPath: root,
        treePaths: patchedTreePaths,
      }),
    )
    // Gate 6 (pack-functional): graphify's check passes on the declaring
    // variant, fails (as required) on the other two.
    vi.mocked(preflight).mockReturnValue(
      Effect.succeed({
        checks: [],
        allPassed: true,
        exitCode: 0,
        logPath: path.join(root, 'preflight.log'),
        packChecks: [
          { variant: 'graphify', pack: 'graphify', runIndex: 1, exitCode: 0, durationMs: '5' },
          { variant: 'base', pack: 'graphify', runIndex: 1, exitCode: 1, durationMs: '5' },
          { variant: 'astgrep', pack: 'graphify', runIndex: 1, exitCode: 1, durationMs: '5' },
        ],
      }),
    )
    mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    const prepReportSchema = z.object({
      packs: z.array(
        z.object({
          pack: z.string(),
          mode: z.string(),
          checks: z.array(z.object({ variant: z.string(), pack: z.string().optional(), exitCode: z.number() })),
        }),
      ),
      variants: z.array(
        z.object({
          variant: z.string(),
          exercises: z.array(z.object({ variant: z.string(), exitCode: z.number() })),
        }),
      ),
    })
    const prep = (await run(
      readJson(path.join(root, 'results', 'prep.json'), prepReportSchema),
    )) as unknown as PrepReport

    const graphifyPack = prep.packs.find((p) => p.pack === 'graphify')
    expect(graphifyPack).toBeDefined()
    // All 3 gate-6 checks for the "graphify" pack landed under it, and the
    // pack's mode was recomputed as verified (the declaring variant's check
    // passed) — matches the D12 per-pack honesty rule.
    expect(graphifyPack?.checks).toHaveLength(3)
    expect(graphifyPack?.mode).not.toBe('delivered-only')

    const graphifyVariant = prep.variants.find((v) => v.variant === 'graphify')
    expect(graphifyVariant).toBeDefined()
    expect(graphifyVariant?.exercises).toHaveLength(1)
    expect(graphifyVariant?.exercises[0]?.exitCode).toBe(0)

    // base/astgrep declared no exercise — threaded through as empty, not omitted.
    const baseVariant = prep.variants.find((v) => v.variant === 'base')
    expect(baseVariant?.exercises).toEqual([])
  })

  it('does not report a pack as check-verified from checksForPack.length alone when NO variant declares it', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    await run(ensureDir(root))
    await run(ensureDir(path.join(root, 'results')))

    // "astgrep" pack gains a check, but no variant (including the one named
    // "astgrep") declares it — an unreferenced registry pack phase 00 does
    // not reject. Every gate-6 row for it is then a REQUIRED-to-fail foreign
    // result, so `checksForPack.length > 0` alone (the pre-fix bug) would
    // wrongly call it verified.
    const unreferencedCheckPack: RunInput = {
      ...runInput,
      packs: runInput.packs.map((p) => (p.name === 'astgrep' ? { ...p, check: 'astgrep --version' } : p)),
      variants: runInput.variants.map((v) => ({ ...v, packs: v.packs.filter((n) => n !== 'astgrep') })),
    }
    configureBaselineMocks(unreferencedCheckPack, root)
    vi.mocked(preflight).mockReturnValue(
      Effect.succeed({
        checks: [],
        allPassed: true,
        exitCode: 0,
        logPath: path.join(root, 'preflight.log'),
        packChecks: [
          { variant: 'base', pack: 'astgrep', runIndex: 1, exitCode: 1, durationMs: '5' },
          { variant: 'graphify', pack: 'astgrep', runIndex: 1, exitCode: 1, durationMs: '5' },
          { variant: 'astgrep', pack: 'astgrep', runIndex: 1, exitCode: 1, durationMs: '5' },
        ],
      }),
    )
    mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    const prepReportSchema = z.object({
      packs: z.array(z.object({ pack: z.string(), mode: z.string(), checks: z.array(z.unknown()) })),
      variants: z.array(z.unknown()),
    })
    const prep = (await run(
      readJson(path.join(root, 'results', 'prep.json'), prepReportSchema),
    )) as unknown as PrepReport

    const astgrepPack = prep.packs.find((p) => p.pack === 'astgrep')
    // The 3 failing foreign rows are still merged — the honest audit trail —
    // but the pack's mode must NOT read as verified from them.
    expect(astgrepPack?.checks).toHaveLength(3)
    expect(astgrepPack?.mode).toBe('delivered-only')
  })
})

describe('cli/pipeline — runPipeline data wiring (not just call order)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('feeds preflight a per-(variant, run) pathOverride — not run-1\'s PATH reused for every run', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    const twoRunInput: RunInput = { ...runInput, runs: 2, parallel: 1 }
    configureBaselineMocks(twoRunInput, root)
    // Distinct PATH per (variant, run) — a bug that reused run-1's PATH for
    // every run would make these assertions fail on run-2.
    vi.mocked(homeIsolation).mockReturnValue(
      Effect.succeed({
        homeTrees: twoRunInput.variants.map((v) => ({
          name: v.name,
          trees: [0, 1].map(() => ({ basePath: '/tmp/home', structure: [], copiedAuth: [] })),
        })),
        envVars: twoRunInput.variants.map((v) => ({
          name: v.name,
          envs: [0, 1].map((idx) => ({
            HOME: '/tmp/home',
            OPENCODE_DISABLE_PROJECT_CONFIG: true,
            OPENCODE_DISABLE_DEFAULT_PLUGINS: false,
            OPENCODE_DISABLE_EXTERNAL_SKILLS: false,
            OPENCODE_PURE: false,
            PATH: `/path/${v.name}/run-${String(idx + 1)}`,
          })),
        })),
        generatedConfigs: twoRunInput.variants.map((v) => ({ name: v.name, config: '{}' })),
        isolation: 'home',
      }),
    )
    mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    const preflightInput = vi.mocked(preflight).mock.calls[0]?.[0]
    expect(preflightInput?.homesForCheck).toHaveLength(3)
    for (const v of twoRunInput.variants) {
      const entry = preflightInput?.homesForCheck.find((h) => h.name === v.name)
      expect(entry?.homes).toHaveLength(2)
      expect(entry?.homes[0]?.pathOverride).toBe(`/path/${v.name}/run-1`)
      expect(entry?.homes[1]?.pathOverride).toBe(`/path/${v.name}/run-2`)
    }
  })

  it('feeds aggregate the packVisibility entries derived from the gate-4 checks preflight actually returned', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    configureBaselineMocks(runInput, root)
    // The default baseline mock returns checks: [] — this test is the only
    // one that exercises the gate-4-checks -> aggregate.packVisibility path
    // end to end.
    vi.mocked(preflight).mockReturnValue(
      Effect.succeed({
        checks: [
          { name: 'pack-visibility', variant: 'graphify', passed: true, durationMs: '1', details: 'pack-visibility [graphify/graphify]' },
          { name: 'pack-visibility', variant: 'astgrep', passed: true, durationMs: '1', details: 'pack-visibility [astgrep/astgrep]' },
          { name: 'pack-visibility', variant: 'base', passed: true, durationMs: '1', details: 'skipped (no pack)' },
        ],
        allPassed: true,
        exitCode: 0,
        logPath: path.join(root, 'preflight.log'),
      }),
    )
    mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    const aggregateInput = vi.mocked(aggregate).mock.calls[0]?.[0]
    expect(aggregateInput?.packVisibility).toEqual([
      { variant: 'graphify', pack: 'graphify', confirmed: true },
      { variant: 'astgrep', pack: 'astgrep', confirmed: true },
    ])
  })

  it('feeds 04b pack-setup the per-variant envVars phase 04 built, not an empty array', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    configureBaselineMocks(runInput, root)
    mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    const packSetupInput = vi.mocked(packSetup).mock.calls[0]?.[0]
    expect(packSetupInput?.envVars?.map((e) => e.name)).toEqual(['base', 'graphify', 'astgrep'])
  })

  it('feeds report-render the merged prep report and the diff-escalation-prefixed headline', async () => {
    const { runInput } = threeVariants()
    const root = makeTempDir()
    configureBaselineMocks(runInput, root)
    vi.mocked(diff).mockReturnValue(
      Effect.succeed({
        diffs: runInput.variants.map((v) => ({
          variant: v.name,
          runs: [
            {
              runIndex: 1,
              fullPatch: '',
              summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
              noChanges: false,
              state: 'failed' as const,
            },
          ],
        })),
      }),
    )
    mockRunSideWithLog()

    await run(runPipeline(pipelineOptions()))

    const reportRenderInput = vi.mocked(reportRender).mock.calls[0]?.[0]
    expect(reportRenderInput?.prep?.packs.map((p) => p.pack)).toEqual(['graphify', 'astgrep'])
    expect(reportRenderInput?.summary.headlineResult).toContain('diff unavailable')
  })
})
