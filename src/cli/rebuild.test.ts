import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, copyDir, moveDir, writeFile, writeJson, readFile } from '../util/fs.js'
import { init, addAll, commit } from '../util/git.js'
import { buildTreePaths } from '../phases/01-workspace-setup.js'

// `judge` is rebuild's one opt-in LLM boundary (--rejudge only) — mocked here
// so a --rejudge test never spawns the real opencode binary; 09-judge.ts's
// own prompting/parsing logic is 09-judge.test.ts's concern, not this file's.
vi.mock('../phases/09-judge.js', () => ({ judge: vi.fn() }))

import { executeRebuild, injectAfterBodyTag } from './rebuild.js'
import type { RebuildFlags } from './rebuild.js'
import { judge } from '../phases/09-judge.js'
import { PhaseError } from '../errors.js'
import { reportSchema, runInputSchema } from '@generated/schemas'
import type { Manifest, RunInput, WorkspaceTree } from '@generated/types'

const judgeMock = vi.mocked(judge)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

// ---------------------------------------------------------------------------
// Fixtures — a shim-pair (variants old/new, one pack on new) v2 workspace,
// matching tests/helpers/variants.ts's shimPair() shape but with the
// per-test overrides this file's scenarios need.
// ---------------------------------------------------------------------------

const baseFlags = (workspace: string, over: Partial<RebuildFlags> = {}): RebuildFlags => ({
  runId: undefined,
  workspace,
  force: false,
  formats: [],
  judge: undefined,
  rejudge: false,
  pricingPath: undefined,
  diffHtml: undefined,
  collapseRepeats: undefined,
  timelineMode: undefined,
  ...over,
})

const makeRunInputV2 = (over: Partial<RunInput> = {}): RunInput => ({
  schemaVersion: 2,
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  parallel: 2,
  baseline: 'old',
  packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git' }],
  variants: [
    { name: 'old', packs: [], pure: true },
    { name: 'new', packs: ['graphify'], pure: false },
  ],
  isolation: 'home',
  auth: {
    opencode: false, npmrc: false, anthropic: false, openai: false, gemini: false, aws: false, ssh: false, git: false,
  },
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  protectGit: false,
  collapseRepeats: true,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60, runSeconds: 600, verifySeconds: 300, installSeconds: 300, watchdogSeconds: 1200,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  ...over,
})

const makeManifestV2 = (over: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 2,
  runId: 'run-abc-001',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  parallel: 2,
  baseline: 'old',
  packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git' }],
  variants: [
    { name: 'old', packs: [] },
    { name: 'new', packs: ['graphify'] },
  ],
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
  ...over,
})

const buildRepo = async (dir: string): Promise<void> => {
  await runP(ensureDir(dir))
  await runP(init(dir))
  await runP(writeFile(path.join(dir, 'a.txt'), 'a\n'))
  await runP(addAll(dir))
  await runP(commit(dir, 'init'))
}

const validExport = (id: string): Record<string, unknown> => ({
  info: {
    id,
    slug: 's',
    projectID: 'p',
    directory: '/app',
    title: 't',
    agent: 'build',
    model: { id: 'm1', providerID: 'anthropic' },
    version: '1.0.0',
    summary: { additions: 0, deletions: 0, files: 0 },
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 1000 },
  },
  messages: [
    {
      info: { role: 'assistant', finish: 'stop', time: { created: 0, completed: 1000 } },
      parts: [{ type: 'text', text: 'done', id: 'p1' }],
    },
  ],
})

interface RunPersistOpts {
  /** (variant, runIndex) pairs that get a real run-N.result.json. Default: all. */
  readonly withResultJson?: readonly { readonly variant: string; readonly runIndex: number }[]
  /** (variant, runIndex) pairs whose .log has no [STOP] line (forces log-recovery defaults). */
  readonly noStopLine?: readonly { readonly variant: string; readonly runIndex: number }[]
}

interface SetupOpts {
  readonly runs?: number
  readonly withRunInput?: boolean
  readonly runInputOverrides?: Partial<RunInput>
  readonly manifestOverrides?: Partial<Manifest>
  readonly runPersist?: RunPersistOpts
}

interface SetupResult {
  readonly workspace: string
  readonly runId: string
  readonly runRoot: string
  readonly tree: WorkspaceTree
}

const has = (list: RunPersistOpts['withResultJson'], variant: string, n: number): boolean =>
  (list ?? []).some((r) => r.variant === variant && r.runIndex === n)

const VARIANTS = ['old', 'new'] as const

const setupRun = async (opts: SetupOpts = {}): Promise<SetupResult> => {
  const runs = opts.runs ?? 1
  const workspace = makeTempDir()
  const runId = '2026-01-01_00-00-00_abcdef'
  const runRoot = path.join(workspace, runId)
  const tree = buildTreePaths(runRoot, runs, [...VARIANTS], 2)

  const oldTree = tree.variantTrees.find((vt) => vt.name === 'old')!
  const newTree = tree.variantTrees.find((vt) => vt.name === 'new')!

  for (const d of [
    tree.appsSource,
    ...oldTree.apps,
    ...newTree.apps,
    tree.pack,
    tree.config,
    path.join(tree.raw, 'old'),
    path.join(tree.raw, 'new'),
    path.join(tree.diff, 'old'),
    path.join(tree.diff, 'new'),
  ]) {
    await runP(ensureDir(d))
  }
  await buildRepo(tree.appsSource)
  for (const dir of [...oldTree.apps, ...newTree.apps]) {
    await runP(copyDir(tree.appsSource, dir))
  }

  const manifest = makeManifestV2({ runId, runs, ...opts.manifestOverrides })
  await runP(writeJson(path.join(runRoot, 'manifest.json'), manifest))

  if (opts.withRunInput) {
    const runInput = makeRunInputV2({ runs, outputPath: tree.results, ...opts.runInputOverrides })
    await runP(writeJson(path.join(runRoot, 'run-input.json'), runInput))
  }

  const persist = opts.runPersist ?? {}
  const withResultDefault =
    persist.withResultJson ??
    Array.from({ length: runs }, (_, i) => VARIANTS.map((variant) => ({ variant, runIndex: i + 1 }))).flat()

  for (const variant of VARIANTS) {
    for (let n = 1; n <= runs; n++) {
      const exportPath = path.join(tree.raw, variant, `run-${String(n)}.json`)
      const eventsLogPath = path.join(tree.raw, variant, `run-${String(n)}.events.ndjson`)
      await runP(writeJson(exportPath, validExport(`sess-${variant}-${String(n)}`)))
      await runP(writeFile(eventsLogPath, ''))
      const skipStop = has(persist.noStopLine, variant, n)
      const logText = skipStop
        ? '[START]\n[PROMPT]\n'
        : '[START]\n[PROMPT]\n[PROMPT_DONE] exitCode=0 watchdog=false\n[STOP] finish=stop rank=4 durationMs=1000\n'
      await runP(writeFile(path.join(tree.raw, variant, `run-${String(n)}.log`), logText))
      if (has(withResultDefault, variant, n)) {
        const result = {
          variant,
          runIndex: n,
          exportPath,
          eventsLogPath,
          successRank: 4,
          finishCause: 'stop',
          exitCode: 0,
          durationMs: '1000',
          watchdogTriggered: false,
        }
        await runP(writeJson(path.join(tree.raw, variant, `run-${String(n)}.result.json`), result))
      }
    }
  }

  return { workspace, runId, runRoot, tree }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rebuild — post-upgrade (run-input.json + run-N.result.json present)', () => {
  it('produces report.json/md, metrics.json, timeline.json; provenance mode is exact', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    expect(existsSync(path.join(tree.results, 'report.json'))).toBe(true)
    expect(existsSync(path.join(tree.results, 'report.md'))).toBe(true)
    expect(existsSync(path.join(tree.results, 'metrics.json'))).toBe(true)
    expect(existsSync(path.join(tree.results, 'timeline.json'))).toBe(true)

    const raw = await runP(readFile(path.join(tree.results, 'report.json')))
    const parsed: unknown = JSON.parse(raw)
    const check = reportSchema.safeParse(parsed)
    expect(check.success, check.success ? '' : JSON.stringify((check as { error?: unknown }).error)).toBe(true)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { runInputMode: string; runs: readonly { source: string }[] }
    expect(prov.runInputMode).toBe('exact')
    expect(prov.runs.every((r) => r.source === 'result-json')).toBe(true)
  })

  it('formats excluding "md" (e.g. original run used --format json) still produce a full report.md, not a truncated one', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { formats: ['json'] } })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('## Rebuild provenance')
    expect(md).toContain('## Summary')
  })

  it('report.json (and --format json stdout) discloses the rebuild via manifest.flagDefaults — not just the md/html text', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      manifest: { flagDefaults: Record<string, unknown> }
    }
    expect(report.manifest.flagDefaults['rebuilt']).toBe(true)
    expect(report.manifest.flagDefaults['rebuiltRunInputMode']).toBe('exact')
    expect(typeof report.manifest.flagDefaults['rebuiltAt']).toBe('string')
  })

  it('reuses an existing judge.json verbatim without invoking any LLM', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    await runP(
      writeJson(path.join(tree.results, 'judge.json'), {
        verdict: 'ok',
        scores: [{ variant: 'old', quality: 5 }, { variant: 'new', quality: 6 }],
        ranking: ['new', 'old'],
        explanation: 'kept as-is',
        modelUsed: 'test-model',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    )
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('kept as-is')
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { judge: { state: string } }
    expect(prov.judge.state).toBe('reused')
  })

  it('reuses a LEGACY v1 judge.json (oldQuality/newQuality) mapped to scores/ranking', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    await runP(
      writeJson(path.join(tree.results, 'judge.json'), {
        verdict: 'ok',
        oldQuality: 4,
        newQuality: 9,
        explanation: 'legacy verdict',
        modelUsed: 'test-model',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    )
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      judge?: { scores: readonly { variant: string; quality: number }[]; ranking: readonly string[] }
    }
    expect(report.judge?.scores).toEqual([{ variant: 'old', quality: 4 }, { variant: 'new', quality: 9 }])
    expect(report.judge?.ranking).toEqual(['new', 'old'])
  })

  it('judge requested but no verdict survives -> disclosure corrects the misleading "not requested" line', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).not.toContain('Judge was not requested')
    expect(md).toContain('requested judging')
    expect(md).toContain('be harsh')
  })

  it('run-input.json confirms judge was never requested -> normal "not requested" line stands', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('Judge was not requested')
  })

  it('a recorded outputPath that disagrees with the given --workspace is ignored, with a notice — never honored (workspace-escape guard)', async () => {
    const outDir = makeTempDir()
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { outputPath: outDir } })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    expect(existsSync(path.join(outDir, 'report.json'))).toBe(false)
    expect(existsSync(path.join(tree.results, 'report.json'))).toBe(true)
    const notices = errSpy.mock.calls.map((c) => String(c[0]))
    expect(notices.some((m) => m.includes('ignoring it'))).toBe(true)
    errSpy.mockRestore()
  })

  it('--format html also writes report.html with the provenance section and a corrected judge line', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    const code = await executeRebuild(baseFlags(workspace, { formats: ['md', 'html'] }))
    expect(code).toBe(0)
    expect(existsSync(path.join(tree.results, 'report.html'))).toBe(true)
    const html = await runP(readFile(path.join(tree.results, 'report.html')))
    expect(html).toContain('rebuild-provenance')
    expect(html).toContain('Rebuild provenance')
    expect(html).not.toContain('Judge was not requested.')
    expect(html).toContain('requested judging')
  })

  it('a CLI override always wins over run-input.json and is disclosed as supplied', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { collapseRepeats: false } })
    const code = await executeRebuild(baseFlags(workspace, { collapseRepeats: true }))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { fields: readonly { field: string; source: string }[] }
    const entry = prov.fields.find((f) => f.field === 'collapseRepeats')
    expect(entry?.source).toBe('supplied')
  })

  it('the disclosure lands as a proper "## Rebuild provenance" section, not a top-of-file blockquote', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('## Rebuild provenance')
    expect(md.indexOf('## Rebuild provenance')).toBeLessThan(md.indexOf('## Summary'))
  })
})

describe('rebuild — prep (results/prep.json read-back)', () => {
  const realPrep = {
    packs: [
      {
        pack: 'graphify',
        mode: 'exercised' as const,
        setupDeclared: true,
        checkDeclared: true,
        exerciseDeclared: true,
        setups: [{ variant: 'new', pack: 'graphify', runIndex: 0, exitCode: 0, durationMs: '27738', outputTail: 'installed ok' }],
        checks: [
          { variant: 'new', pack: 'graphify', runIndex: 1, exitCode: 0, durationMs: '437' },
          { variant: 'old', pack: 'graphify', runIndex: 1, exitCode: 1, durationMs: '0' },
        ],
      },
    ],
    variants: [
      {
        variant: 'new',
        exerciseDeclared: true,
        exercises: [
          { variant: 'new', pack: 'graphify', runIndex: 1, exitCode: 1, durationMs: '0', outputTail: 'boom' },
          { variant: 'new', pack: 'graphify', runIndex: 2, exitCode: 0, durationMs: '561', artifactHash: 'abc123' },
        ],
      },
    ],
  }

  it('prep.json present -> the whole section survives with mode and per-run rows intact', async () => {
    const { workspace, tree } = await setupRun({
      runs: 2,
      withRunInput: true,
      runInputOverrides: { packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git', setup: 'npm i -g x', check: 'x --version' }], variants: [{ name: 'old', packs: [], pure: true }, { name: 'new', packs: ['graphify'], pure: false, exercise: 'x run' }] },
      manifestOverrides: { packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git', setup: 'npm i -g x', check: 'x --version' }], variants: [{ name: 'old', packs: [] }, { name: 'new', packs: ['graphify'], exercise: 'x run' }] },
    })
    await runP(writeJson(path.join(tree.results, 'prep.json'), realPrep))

    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)

    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as { prep?: typeof realPrep }
    expect(report.prep).toEqual(realPrep)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { packSetup: { state: string; note: string } }
    expect(prov.packSetup.state).toBe('reused')
  })

  it('legacy results/pack-setup.json (v1 shape) is mapped and reused', async () => {
    const { workspace, tree } = await setupRun({
      runs: 1,
      withRunInput: true,
      runInputOverrides: { packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git', setup: 'npm i -g x' }] },
      manifestOverrides: { packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git', setup: 'npm i -g x' }] },
    })
    await runP(
      writeJson(path.join(tree.results, 'pack-setup.json'), {
        mode: 'installed-only',
        setupDeclared: true,
        checkDeclared: false,
        exerciseDeclared: false,
        setup: { side: 'new', runIndex: 0, exitCode: 0, durationMs: '100' },
        checks: [],
        exercises: [],
      }),
    )
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      prep?: { packs: readonly { pack: string; setups: readonly { variant: string }[] }[] }
    }
    expect(report.prep?.packs[0]?.pack).toBe('graphify')
    expect(report.prep?.packs[0]?.setups[0]?.variant).toBe('new')
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { packSetup: { state: string; note: string } }
    expect(prov.packSetup.state).toBe('reused')
    expect(prov.packSetup.note).toContain('legacy artifact name')
  })

  it('no prep.json/pack-setup.json, and nothing declared in the manifest -> section genuinely absent', async () => {
    const { workspace, tree } = await setupRun({
      withRunInput: true,
      runInputOverrides: { packs: [], variants: [{ name: 'old', packs: [], pure: true }, { name: 'new', packs: [], pure: false }] },
      manifestOverrides: { packs: [], variants: [{ name: 'old', packs: [] }, { name: 'new', packs: [] }] },
    })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)

    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as { prep?: unknown }
    expect(report.prep).toBeUndefined()

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { packSetup: { state: string; note: string } }
    expect(prov.packSetup.state).toBe('confirmed-not-used')
  })

  it('no prep.json, but the manifest proves pack setup WAS declared -> synthesized section, mode stays conservative (never "exercised")', async () => {
    const { workspace, tree } = await setupRun({
      withRunInput: true,
      runInputOverrides: { packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git', setup: 'npm i -g x' }], variants: [{ name: 'old', packs: [], pure: true }, { name: 'new', packs: ['graphify'], pure: false, exercise: 'x run' }] },
      manifestOverrides: { packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git', setup: 'npm i -g x' }], variants: [{ name: 'old', packs: [] }, { name: 'new', packs: ['graphify'], exercise: 'x run' }] },
    })
    // prep.json / pack-setup.json deliberately NOT written.

    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)

    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      prep?: { packs: readonly { mode: string; setupDeclared: boolean; checks: unknown[] }[]; variants: readonly { exerciseDeclared: boolean; exercises: unknown[] }[] }
    }
    expect(report.prep?.packs[0]?.mode).not.toBe('exercised')
    expect(report.prep?.packs[0]?.setupDeclared).toBe(true)
    expect(report.prep?.packs[0]?.checks).toEqual([])
    expect(report.prep?.variants[0]?.exerciseDeclared).toBe(true)
    expect(report.prep?.variants[0]?.exercises).toEqual([])
    expect(reportSchema.safeParse(report).success).toBe(true)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { packSetup: { state: string; note: string } }
    expect(prov.packSetup.state).toBe('unavailable')
    expect(prov.packSetup.note).toContain('not verified evidence')
  })
})

describe('rebuild — --rejudge (the one opt-in LLM exception)', () => {
  it('without --rejudge, --judge alone never calls judge()', async () => {
    judgeMock.mockClear()
    const { workspace } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    const code = await executeRebuild(baseFlags(workspace, { judge: 'be nicer' }))
    expect(code).toBe(0)
    expect(judgeMock).not.toHaveBeenCalled()
  })

  it('--rejudge with instructions available invokes judge() exactly once and discloses "rejudged"', async () => {
    judgeMock.mockReset()
    judgeMock.mockImplementation(() =>
      Effect.succeed({
        judge: {
          verdict: 'ok',
          scores: [{ variant: 'old', quality: 4 }, { variant: 'new', quality: 9 }],
          ranking: ['new', 'old'],
          explanation: 'fresh verdict over rebuilt data',
          modelUsed: 'test-model',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    const code = await executeRebuild(baseFlags(workspace, { rejudge: true }))
    expect(code).toBe(0)
    expect(judgeMock).toHaveBeenCalledTimes(1)
    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      judge?: { verdict: string }
    }
    expect(report.judge?.verdict).toBe('ok')
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('fresh verdict over rebuilt data')
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { judge: { state: string; note: string } }
    expect(prov.judge.state).toBe('rejudged')
    expect(prov.judge.note).toContain('not the original run')
  })

  it('--rejudge uses --judge as the instructions when supplied, overriding the original', async () => {
    judgeMock.mockReset()
    judgeMock.mockImplementation((input) =>
      Effect.succeed({
        judge: {
          verdict: 'ok',
          scores: [{ variant: 'old', quality: 1 }, { variant: 'new', quality: 1 }],
          ranking: ['new', 'old'],
          explanation: `used: ${input.runInput.judge ?? 'none'}`,
          modelUsed: 'test-model',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'original text' } })
    const code = await executeRebuild(baseFlags(workspace, { rejudge: true, judge: 'fresh instructions' }))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('used: fresh instructions')
  })

  it('--rejudge with no instructions available anywhere degrades gracefully (still exit 0, no verdict)', async () => {
    judgeMock.mockClear()
    const { workspace, tree } = await setupRun({ runs: 1 })
    const code = await executeRebuild(baseFlags(workspace, { rejudge: true }))
    expect(code).toBe(0)
    expect(judgeMock).not.toHaveBeenCalled()
    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      judge?: unknown
    }
    expect(report.judge).toBeUndefined()
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('no judge instructions are available')
  })

  it('--rejudge survives a judge() failure without failing the whole rebuild', async () => {
    judgeMock.mockReset()
    judgeMock.mockImplementation(() =>
      Effect.fail(
        new PhaseError({
          code: 'E_MODEL_UNAVAILABLE',
          phase: 'judge',
          message: 'scratch dir boom',
          timestamp: new Date(),
        }),
      ),
    )
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { judge: 'be harsh' } })
    const code = await executeRebuild(baseFlags(workspace, { rejudge: true }))
    expect(code).toBe(0)
    expect(existsSync(path.join(tree.results, 'report.json'))).toBe(true)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('--rejudge failed')
  })
})

describe('rebuild — pre-upgrade (no run-input.json, best-effort)', () => {
  it('recovers what the census promises, defaults the rest, and discloses both', async () => {
    const { workspace, tree } = await setupRun({ runs: 2 })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    expect(existsSync(path.join(tree.results, 'report.json'))).toBe(true)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as {
      runInputMode: string
      fields: readonly { field: string; source: string }[]
      pricingWarning: string | undefined
    }
    expect(prov.runInputMode).toBe('recovered')
    expect(prov.fields.find((f) => f.field === 'repoUrl')?.source).toBe('recovered')
    expect(prov.fields.find((f) => f.field === 'prompt')?.source).toBe('recovered')
    expect(prov.fields.find((f) => f.field === 'packs')?.source).toBe('recovered')
    expect(prov.fields.find((f) => f.field === 'variants')?.source).toBe('recovered')
    expect(prov.fields.find((f) => f.field === 'formats')?.source).toBe('defaulted')
    expect(prov.fields.find((f) => f.field === 'pricingPath')?.source).toBe('defaulted')
    expect(prov.pricingWarning).toBeDefined()
  })

  it('never fabricates run-input.json on disk — the write stays absent', async () => {
    const { workspace, runRoot } = await setupRun({ runs: 1 })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    expect(existsSync(path.join(runRoot, 'run-input.json'))).toBe(false)
  })

  it('--pricing-path supplied on the command clears the pricing warning', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    const pricingDir = makeTempDir()
    await runP(ensureDir(pricingDir))
    const pricingPath = path.join(pricingDir, 'pricing.json')
    await runP(
      writeJson(pricingPath, {
        version: '1',
        providers: {},
        fallback: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      }),
    )
    const code = await executeRebuild(baseFlags(workspace, { pricingPath }))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { pricingWarning: string | undefined; fields: readonly { field: string; source: string }[] }
    expect(prov.pricingWarning).toBeUndefined()
    expect(prov.fields.find((f) => f.field === 'pricingPath')?.source).toBe('supplied')
  })

  it('a --pricing-path that does not exist warns loudly instead of silently mispricing', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    const pricingPath = path.join(makeTempDir(), 'does-not-exist.json')
    const code = await executeRebuild(baseFlags(workspace, { pricingPath }))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { pricingWarning: string | undefined }
    expect(prov.pricingWarning).toBeDefined()
    expect(prov.pricingWarning).toContain('could not be read')
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('could not be read')
  })

  it('prints the pricing warning to stderr so a --format json caller sees it too, not only report.md/provenance.json', async () => {
    const { workspace } = await setupRun({ runs: 1 })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await executeRebuild(baseFlags(workspace, { formats: ['json'] }))
    expect(code).toBe(0)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cost figures use the built-in pricing table'))
    errSpy.mockRestore()
  })

  it('a protected run (git dir relocated outside the work tree) is detected from disk and diffed correctly', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    const oldTree = tree.variantTrees.find((vt) => vt.name === 'old')!
    const newTree = tree.variantTrees.find((vt) => vt.name === 'new')!
    // Mirror what repoClone does under --protect-git: move .git out of the
    // work tree into gitdirs/<variant>/run-1, then edit the work tree for real.
    await runP(ensureDir(path.dirname(oldTree.gitDirs[0] ?? '')))
    await runP(ensureDir(path.dirname(newTree.gitDirs[0] ?? '')))
    await runP(moveDir(path.join(oldTree.apps[0] ?? '', '.git'), oldTree.gitDirs[0] ?? ''))
    await runP(moveDir(path.join(newTree.apps[0] ?? '', '.git'), newTree.gitDirs[0] ?? ''))
    await runP(writeFile(path.join(oldTree.apps[0] ?? '', 'a.txt'), 'a\nedited old\n'))
    await runP(writeFile(path.join(newTree.apps[0] ?? '', 'a.txt'), 'a\nedited new\n'))

    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { fields: readonly { field: string; source: string; note: string }[] }
    const entry = prov.fields.find((f) => f.field === 'protectGit')
    expect(entry?.source).toBe('recovered')
    expect(entry?.note).toContain('true')

    const patch = await runP(readFile(path.join(tree.diff, 'old', 'run-1', 'full.patch')))
    expect(patch).toContain('edited old')
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).not.toContain('E_WORKTREE_BROKEN')
  })

  it('an unprotected run is detected as such (protectGit recovered false)', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { fields: readonly { field: string; source: string; note: string }[] }
    const entry = prov.fields.find((f) => f.field === 'protectGit')
    expect(entry?.source).toBe('recovered')
    expect(entry?.note).toContain('false')
  })

  it('manifest.flagDefaults.protectGit, when present, wins over disk evidence (stronger, authoritative signal)', async () => {
    const { workspace, tree } = await setupRun({ runs: 1, manifestOverrides: { flagDefaults: { protectGit: true } } })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { fields: readonly { field: string; source: string; note: string }[] }
    const entry = prov.fields.find((f) => f.field === 'protectGit')
    expect(entry?.source).toBe('recovered')
    expect(entry?.note).toContain('manifest.flagDefaults.protectGit')
    expect(entry?.note).toContain('true')
    expect(entry?.note).not.toContain('gitdirs/old/run-1 exists')
  })

  it('no judge.json and no --judge hint -> disclosure state is unknown, not "not requested"', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).not.toContain('Judge was not requested')
    expect(md).toContain('cannot be determined')
  })

  it('a --judge hint without --rejudge is disclosed but never invokes an LLM (judge stays absent from report.json)', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    const code = await executeRebuild(baseFlags(workspace, { judge: 'score both sides' }))
    expect(code).toBe(0)
    const report = JSON.parse(await runP(readFile(path.join(tree.results, 'report.json')))) as {
      judge?: unknown
    }
    expect(report.judge).toBeUndefined()
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('score both sides')
    expect(md).toContain('no LLM was invoked')
  })
})

describe('rebuild — per-run result recovery', () => {
  it('falls back to log-recovery for a run missing its result.json, disclosed per run', async () => {
    const { workspace, tree } = await setupRun({
      runs: 2,
      withRunInput: true,
      runPersist: { withResultJson: [{ variant: 'old', runIndex: 1 }, { variant: 'new', runIndex: 1 }, { variant: 'new', runIndex: 2 }] },
    })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { runs: readonly { variant: string; runIndex: number; source: string; defaultedFields: readonly string[] }[] }
    const oldRun2 = prov.runs.find((r) => r.variant === 'old' && r.runIndex === 2)
    expect(oldRun2?.source).toBe('log-recovery')
    expect(oldRun2?.defaultedFields).toEqual([])
  })

  it('a run with no [STOP] log line defaults successRank/finishCause/etc, disclosed as defaulted', async () => {
    const { workspace, tree } = await setupRun({
      runs: 1,
      withRunInput: true,
      runPersist: { withResultJson: [], noStopLine: [{ variant: 'old', runIndex: 1 }, { variant: 'new', runIndex: 1 }] },
    })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { runs: readonly { variant: string; runIndex: number; defaultedFields: readonly string[] }[] }
    const run = prov.runs.find((r) => r.variant === 'old' && r.runIndex === 1)
    expect(run?.defaultedFields).toContain('successRank')
    expect(run?.defaultedFields).toContain('finishCause')
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('no [STOP] line found')
  })

  it('an unrecoverable-outcome run does not render identically to a genuine rank-0 failure', async () => {
    const { workspace, tree } = await setupRun({
      runs: 2,
      withRunInput: true,
      runPersist: { withResultJson: [], noStopLine: [{ variant: 'old', runIndex: 1 }] },
    })
    // run-2: a REAL rank-0 failure — a genuine [STOP] line, nothing defaulted.
    await runP(
      writeFile(
        path.join(tree.raw, 'old', 'run-2.log'),
        '[START]\n[PROMPT]\n[PROMPT_DONE] exitCode=1 watchdog=false\n[STOP] finish=error rank=0 durationMs=500\n',
      ),
    )
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    const lines = md.split('\n')
    const line1 = lines.find((l) => l.includes('run old/1 failed'))
    const line2 = lines.find((l) => l.includes('run old/2 failed'))
    expect(line1).toBeDefined()
    expect(line2).toBeDefined()
    expect(line1).toContain('outcome unrecoverable')
    expect(line2).not.toContain('outcome unrecoverable')
    expect(line1).not.toBe(line2)
  })
})

describe('rebuild — refusals', () => {
  it('refuses when no run is found', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const workspace = makeTempDir()
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no run found'))
    errSpy.mockRestore()
  })

  it('refuses when report.json already exists; --force overwrites', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true })
    const first = await executeRebuild(baseFlags(workspace))
    expect(first).toBe(0)
    expect(existsSync(path.join(tree.results, 'report.json'))).toBe(true)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const second = await executeRebuild(baseFlags(workspace))
    expect(second).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('pass --force'))
    errSpy.mockRestore()

    const third = await executeRebuild(baseFlags(workspace, { force: true }))
    expect(third).toBe(0)
  })

  it('refuses with a clear message when an app worktree dir is gone (--ephemeral or gc)', async () => {
    const { workspace, tree } = await setupRun({ withRunInput: true, runs: 1 })
    const oldTree = tree.variantTrees.find((vt) => vt.name === 'old')!
    const { rm } = await import('node:fs/promises')
    await rm(oldTree.apps[0] ?? '', { recursive: true, force: true })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('old/run-1'))
    errSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// v1 compat — the checked-in mini v1 workspace fixture
// (tests/fixtures/v1-workspace/**). Real pre-n-way-variants layout: no
// run-input.json (exercises the recovered path), manifest.json without
// schemaVersion, raw/old + raw/new, apps/oldVersion + apps/newVersion (real
// tiny git worktrees).
// ---------------------------------------------------------------------------

const V1_FIXTURE_ROOT = path.resolve(import.meta.dirname, '../../tests/fixtures/v1-workspace')

describe('rebuild — v1 workspace fixture (report --rebuild on a pre-n-way-variants run)', () => {
  it('rebuilds successfully; report.json is v2 (schemaVersion 2); provenance discloses migratedFromV1', async () => {
    const parentDir = makeTempDir()
    const runDir = path.join(parentDir, 'v1-run')
    await runP(copyDir(V1_FIXTURE_ROOT, runDir))

    const code = await executeRebuild(baseFlags(parentDir))
    expect(code).toBe(0)

    const raw = await runP(readFile(path.join(runDir, 'results', 'report.json')))
    const parsed: unknown = JSON.parse(raw)
    const check = reportSchema.safeParse(parsed)
    expect(check.success, check.success ? '' : JSON.stringify((check as { error?: unknown }).error)).toBe(true)
    const report = parsed as {
      schemaVersion: number
      manifest: { flagDefaults: Record<string, unknown>; baseline: string; variants: readonly { name: string }[] }
      metrics: { baseline: string; variants: readonly { variant: string }[] }
    }
    expect(report.schemaVersion).toBe(2)
    expect(report.manifest.flagDefaults['migratedFromV1']).toBe(true)
    expect(report.manifest.baseline).toBe('old')
    expect(report.manifest.variants.map((v) => v.name)).toEqual(['old', 'new'])
    expect(report.metrics.baseline).toBe('old')
    expect(report.metrics.variants.map((v) => v.variant)).toEqual(['old', 'new'])

    const prov = JSON.parse(
      await runP(readFile(path.join(runDir, 'results', 'rebuild-provenance.json'))),
    ) as { runInputMode: string }
    expect(prov.runInputMode).toBe('recovered')
  })
})

describe('rebuild — zero agent/LLM/docker invocations (source-level guard)', () => {
  it('rebuild.ts imports no opencode/* or isolation/* module', async () => {
    const src = await runP(readFile(path.resolve(import.meta.dirname, 'rebuild.ts')))
    expect(src).not.toMatch(/from ['"].*\/opencode\//)
    expect(src).not.toMatch(/from ['"].*\/isolation\//)
  })
})

describe('buildTreePaths / runInputSchema sanity used by fixtures', () => {
  it('makeRunInputV2 fixture round-trips through runInputSchema', () => {
    const ri = makeRunInputV2()
    expect(runInputSchema.safeParse(ri).success).toBe(true)
  })

  it('v1 layout: buildTreePaths(root, 2, [old,new], 1) reproduces the legacy apps/oldVersion + apps/newVersion shape', () => {
    const tree = buildTreePaths('/tmp/root', 2, ['old', 'new'], 1)
    const old = tree.variantTrees.find((vt) => vt.name === 'old')
    expect(old?.apps).toEqual(['/tmp/root/apps/oldVersion/run-1', '/tmp/root/apps/oldVersion/run-2'])
    expect(old?.homes).toEqual(['/tmp/root/home/old/run-1', '/tmp/root/home/old/run-2'])
  })
})

describe('injectAfterBodyTag', () => {
  it('injects right after a bare <body>', () => {
    expect(injectAfterBodyTag('<html><body>X</body></html>', '<Y/>')).toBe(
      '<html><body><Y/>X</body></html>',
    )
  })

  it('injects right after a <body> carrying attributes, unlike a literal string match', () => {
    expect(injectAfterBodyTag('<html><body class="report" lang="en">X</body></html>', '<Y/>')).toBe(
      '<html><body class="report" lang="en"><Y/>X</body></html>',
    )
  })

  it('warns and returns the input unchanged when no <body> tag is found at all', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const html = '<html><main>no body tag here</main></html>'
    expect(injectAfterBodyTag(html, '<Y/>')).toBe(html)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no <body> tag found'))
    errSpy.mockRestore()
  })
})
