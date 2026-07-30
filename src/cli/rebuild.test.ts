import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, copyDir, moveDir, writeFile, writeJson, readFile } from '../util/fs.js'
import { init, addAll, commit } from '../util/git.js'
import { buildTreePaths } from '../phases/01-workspace-setup.js'
import { makeManifest, makeRunInput } from '../../tests/report-fixture.js'

// `judge` is rebuild's one opt-in LLM boundary (--rejudge only) — mocked here
// so a --rejudge test never spawns the real opencode binary; 09-judge.ts's
// own prompting/parsing logic is 09-judge.test.ts's concern, not this file's.
vi.mock('../phases/09-judge.js', () => ({ judge: vi.fn() }))

import { executeRebuild, injectAfterBodyTag } from './rebuild.js'
import type { RebuildFlags } from './rebuild.js'
import { judge } from '../phases/09-judge.js'
import { PhaseError } from '../errors.js'
import { reportSchema, runInputSchema } from '@generated/schemas'
import type { Manifest, RunInput, Side, WorkspaceTree } from '@generated/types'
import type { RunSideResultExt } from '../phases/06-run-side.js'

const judgeMock = vi.mocked(judge)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

// ---------------------------------------------------------------------------
// Fixtures
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
  /** (side, runIndex) pairs that get a real run-N.result.json. Default: all. */
  readonly withResultJson?: readonly { readonly side: Side; readonly runIndex: number }[]
  /** (side, runIndex) pairs whose .log has no [STOP] line (forces log-recovery defaults). */
  readonly noStopLine?: readonly { readonly side: Side; readonly runIndex: number }[]
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

const has = (list: RunPersistOpts['withResultJson'], side: Side, n: number): boolean =>
  (list ?? []).some((r) => r.side === side && r.runIndex === n)

const setupRun = async (opts: SetupOpts = {}): Promise<SetupResult> => {
  const runs = opts.runs ?? 1
  const workspace = makeTempDir()
  const runId = '2026-01-01_00-00-00_abcdef'
  const runRoot = path.join(workspace, runId)
  const tree = buildTreePaths(runRoot, runs)

  for (const d of [
    tree.appsSource,
    ...tree.appsOld,
    ...tree.appsNew,
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
  for (const dir of [...tree.appsOld, ...tree.appsNew]) {
    await runP(copyDir(tree.appsSource, dir))
  }

  const manifest = makeManifest({ runId, runs, ...opts.manifestOverrides })
  await runP(writeJson(path.join(runRoot, 'manifest.json'), manifest))

  if (opts.withRunInput) {
    const runInput = makeRunInput({ runs, outputPath: tree.results, ...opts.runInputOverrides })
    await runP(writeJson(path.join(runRoot, 'run-input.json'), runInput))
  }

  const persist = opts.runPersist ?? {}
  const withResultDefault = persist.withResultJson ?? Array.from({ length: runs }, (_, i) => [
    { side: 'old' as const, runIndex: i + 1 },
    { side: 'new' as const, runIndex: i + 1 },
  ]).flat()

  for (const side of ['old', 'new'] as const) {
    for (let n = 1; n <= runs; n++) {
      const exportPath = path.join(tree.raw, side, `run-${String(n)}.json`)
      const eventsLogPath = path.join(tree.raw, side, `run-${String(n)}.events.ndjson`)
      await runP(writeJson(exportPath, validExport(`sess-${side}-${String(n)}`)))
      await runP(writeFile(eventsLogPath, ''))
      const skipStop = has(persist.noStopLine, side, n)
      const logText = skipStop
        ? '[START]\n[PROMPT]\n'
        : '[START]\n[PROMPT]\n[PROMPT_DONE] exitCode=0 watchdog=false\n[STOP] finish=stop rank=4 durationMs=1000\n'
      await runP(writeFile(path.join(tree.raw, side, `run-${String(n)}.log`), logText))
      if (has(withResultDefault, side, n)) {
        const result: RunSideResultExt = {
          side,
          runIndex: n,
          exportPath,
          eventsLogPath,
          successRank: 4,
          finishCause: 'stop',
          exitCode: 0,
          durationMs: '1000',
          watchdogTriggered: false,
        }
        await runP(writeJson(path.join(tree.raw, side, `run-${String(n)}.result.json`), result))
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
    expect(reportSchema.safeParse(JSON.parse(raw)).success).toBe(true)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { runInputMode: string; runs: readonly { source: string }[] }
    expect(prov.runInputMode).toBe('exact')
    expect(prov.runs.every((r) => r.source === 'result-json')).toBe(true)
  })

  it('formats excluding "md" (e.g. original run used --format json) still produce a full report.md, not a truncated one', async () => {
    // reportRender always writes a full report.md regardless of `formats`
    // (its own invariant) — this pins that rebuild reads that file back
    // instead of the "only-set-when-md-requested" render.stdoutMd, which
    // used to silently overwrite it with just the provenance section.
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { formats: ['json'] } })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('## Rebuild provenance')
    expect(md).toContain('## Summary')
    expect(md).toContain('## Diff summary')
    expect(md).toContain('# testaipack report:')
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
        oldQuality: 5,
        newQuality: 6,
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

  it('custom outputPath in run-input.json is honored (report lands there, not in workspace results/)', async () => {
    const outDir = makeTempDir()
    const { workspace, tree } = await setupRun({ withRunInput: true, runInputOverrides: { outputPath: outDir } })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    expect(existsSync(path.join(outDir, 'report.json'))).toBe(true)
    expect(existsSync(path.join(tree.results, 'report.json'))).toBe(false)
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
    expect(md.startsWith('# testaipack report:')).toBe(true)
    expect(md).toContain('## Rebuild provenance')
    // the section sits between the header and Summary, not glued to either
    expect(md.indexOf('## Rebuild provenance')).toBeGreaterThan(md.indexOf('**Opencode version:**'))
    expect(md.indexOf('## Rebuild provenance')).toBeLessThan(md.indexOf('## Summary'))
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
          oldQuality: 4,
          newQuality: 9,
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
          oldQuality: 1,
          newQuality: 1,
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

  it('an exact-mode run whose recovered pricingPath is unreadable (e.g. rebuilt from a different cwd) still warns loudly', async () => {
    const bogusPricingPath = path.join(makeTempDir(), 'gone.json')
    const { workspace, tree } = await setupRun({
      withRunInput: true,
      runInputOverrides: { pricingPath: bogusPricingPath },
    })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { pricingWarning: string | undefined; fields: readonly { field: string; source: string }[] }
    // exact mode: pricingPath does not even appear in the field-provenance
    // list (it came straight from run-input.json, no override) — the old
    // logic only checked that list and would have said nothing at all here.
    expect(prov.fields.find((f) => f.field === 'pricingPath')).toBeUndefined()
    expect(prov.pricingWarning).toBeDefined()
    expect(prov.pricingWarning).toContain('could not be read')
  })

  it('a protected run (git dir relocated outside the work tree) is detected from disk and diffed correctly', async () => {
    const { workspace, tree } = await setupRun({ runs: 1 })
    // Mirror what repoClone does under --protect-git: move .git out of the
    // work tree into gitdirs/<side>/run-1, then edit the work tree for real.
    await runP(ensureDir(path.dirname(tree.gitDirsOld[0] ?? '')))
    await runP(ensureDir(path.dirname(tree.gitDirsNew[0] ?? '')))
    await runP(moveDir(path.join(tree.appsOld[0] ?? '', '.git'), tree.gitDirsOld[0] ?? ''))
    await runP(moveDir(path.join(tree.appsNew[0] ?? '', '.git'), tree.gitDirsNew[0] ?? ''))
    await runP(writeFile(path.join(tree.appsOld[0] ?? '', 'a.txt'), 'a\nedited old\n'))
    await runP(writeFile(path.join(tree.appsNew[0] ?? '', 'a.txt'), 'a\nedited new\n'))

    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)

    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { fields: readonly { field: string; source: string; note: string }[] }
    const entry = prov.fields.find((f) => f.field === 'protectGit')
    expect(entry?.source).toBe('recovered')
    expect(entry?.note).toContain('true')

    // the diff must find the real edit, not report a broken/empty worktree
    const patch = await runP(readFile(path.join(tree.diff, 'old', 'run-1', 'full.patch')))
    expect(patch).toContain('edited old')
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).not.toContain('E_WORKTREE_BROKEN')
    expect(md).toMatch(/old.*\+1 -1|1 files/)
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
    // no .git was actually relocated on disk — disk evidence alone would say
    // false — but the manifest (written by a --protect-git-aware pipeline.ts)
    // says true, and that must win.
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
      runPersist: { withResultJson: [{ side: 'old', runIndex: 1 }, { side: 'new', runIndex: 1 }, { side: 'new', runIndex: 2 }] },
    })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { runs: readonly { side: string; runIndex: number; source: string; defaultedFields: readonly string[] }[] }
    const oldRun2 = prov.runs.find((r) => r.side === 'old' && r.runIndex === 2)
    expect(oldRun2?.source).toBe('log-recovery')
    expect(oldRun2?.defaultedFields).toEqual([])
  })

  it('a run with no [STOP] log line defaults successRank/finishCause/etc, disclosed as defaulted', async () => {
    const { workspace, tree } = await setupRun({
      runs: 1,
      withRunInput: true,
      runPersist: { withResultJson: [], noStopLine: [{ side: 'old', runIndex: 1 }, { side: 'new', runIndex: 1 }] },
    })
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(0)
    const prov = JSON.parse(
      await runP(readFile(path.join(tree.results, 'rebuild-provenance.json'))),
    ) as { runs: readonly { side: string; runIndex: number; defaultedFields: readonly string[] }[] }
    const run = prov.runs.find((r) => r.side === 'old' && r.runIndex === 1)
    expect(run?.defaultedFields).toContain('successRank')
    expect(run?.defaultedFields).toContain('finishCause')
    const md = await runP(readFile(path.join(tree.results, 'report.md')))
    expect(md).toContain('no [STOP] line found')
  })

  it('an unrecoverable-outcome run does not render identically to a genuine rank-0 failure', async () => {
    const { workspace, tree } = await setupRun({
      runs: 2,
      withRunInput: true,
      runPersist: { withResultJson: [], noStopLine: [{ side: 'old', runIndex: 1 }] },
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
    // run-1's outcome could not be recovered at all — must say so, visibly
    expect(line1).toContain('outcome unrecoverable')
    // run-2 genuinely failed — must NOT carry the same disclaimer
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
    const { rm } = await import('node:fs/promises')
    await rm(tree.appsOld[0] ?? '', { recursive: true, force: true })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await executeRebuild(baseFlags(workspace))
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('old/run-1'))
    errSpy.mockRestore()
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
  it('makeRunInput fixture round-trips through runInputSchema', () => {
    const ri = makeRunInput()
    expect(runInputSchema.safeParse(ri).success).toBe(true)
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
