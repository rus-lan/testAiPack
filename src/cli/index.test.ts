import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { Effect } from 'effect'
import pkg from '../../package.json' with { type: 'json' }
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, exists, readFile, writeJson, writeFile } from '../util/fs.js'
// tests/report-fixture.ts is v1-shaped and shared by nine test files across
// five packages with nobody owning it this wave (orchestrator ruling) — build
// what's needed from WP1's v2 fixtures (tests/helpers/variants.ts) instead,
// plus a small local builder for the one shape variants.ts doesn't export
// directly (a standalone Manifest).
import { makeMetricsReport, makeReportV2, makeWorkspaceTree } from '../../tests/helpers/variants.js'
import type { Manifest } from '@generated/types'
import { VALUE_FLAGS, BOOLEAN_FLAGS } from '../phases/00-cli-parse.js'
import type * as CompareModule from './compare.js'

const makeFakeManifest = (over: Partial<Manifest> = {}): Manifest => ({
  ...makeReportV2().manifest,
  ...over,
})

vi.mock('./pipeline.js', () => ({ runPipeline: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
// compare.ts (WP14) has landed with real `isVariantSelector`/`isCompareFormat`
// — those are pure, pinned, trivial functions, so they run for real here.
// `executeCompare` alone stays mocked: it does real report I/O, and this file
// tests CompareCommand's FLAG ROUTING, not compare.ts's own execution (that's
// compare.test.ts's job).
vi.mock('./compare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CompareModule>()
  return {
    ...actual,
    executeCompare: vi.fn(() => Promise.resolve(0)),
  }
})

import {
  runCli,
  executeInit,
  executeList,
  executeReport,
  executeReview,
  splitRunFlags,
  resolveVariantSelector,
} from './index.js'
import { runPipeline } from './pipeline.js'
import type { PipelineOutcome } from './pipeline.js'
import { spawn } from 'node:child_process'
import { executeCompare } from './compare.js'

const runPipelineMock = vi.mocked(runPipeline)
const spawnMock = vi.mocked(spawn)
const executeCompareMock = vi.mocked(executeCompare)

const captureStdout = (): { readonly text: () => string } => {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  })
  return { text: () => chunks.join('') }
}

describe('cli/index — runCli --version', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--version prints "testaipack <version>" and exits 0', async () => {
    const out = captureStdout()
    const code = await runCli(['--version'])
    expect(code).toBe(0)
    expect(out.text()).toBe(`testaipack ${pkg.version}\n`)
  })

  it('-v (single top-level arg) prints the version', async () => {
    const out = captureStdout()
    const code = await runCli(['-v'])
    expect(code).toBe(0)
    expect(out.text()).toContain(pkg.version)
  })

  it('run --version is handled early (does not reach the phase-00 proxy)', async () => {
    const out = captureStdout()
    const code = await runCli(['run', '--version'])
    expect(code).toBe(0)
    expect(out.text()).toBe(`testaipack ${pkg.version}\n`)
  })
})

describe('cli/index — run --help flag table', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('every VALUE_FLAGS and BOOLEAN_FLAGS key appears in the output (a future undocumented flag fails this)', async () => {
    const out = captureStdout()
    const code = await runCli(['run', '--help'])
    expect(code).toBe(0)
    const text = out.text()
    for (const flag of Object.keys(VALUE_FLAGS)) {
      expect(text).toContain(flag)
    }
    for (const flag of Object.keys(BOOLEAN_FLAGS)) {
      expect(text).toContain(flag)
    }
    // A flag can print its own name (from VALUE_FLAGS/BOOLEAN_FLAGS) with no
    // real description behind it — the check above alone would not catch
    // that. Fail on the fallback placeholder too, since a missing
    // FLAG_DESCRIPTIONS entry is the actual documentation gap.
    expect(text).not.toContain('(no description yet)')
  })

  it('lists the four orchestrator flags with their defaults', async () => {
    const out = captureStdout()
    await runCli(['run', '--help'])
    const text = out.text()
    expect(text).toContain('--review-run')
    expect(text).toContain('--ide')
    expect(text).toContain('--ephemeral')
    expect(text).toContain('--config')
    expect(text).toContain('default: 1')
    expect(text).toContain('default: vscode')
  })

  it('shows real defaults derived from the parser, not hand-copied literals', async () => {
    const out = captureStdout()
    await runCli(['run', '--help'])
    const text = out.text()
    expect(text).toContain('default: 3') // DEFAULT_RUNS
    expect(text).toContain('default: home') // DEFAULT_ISOLATION
    expect(text).toContain('default: 600') // DEFAULT_TIMEOUTS.runSeconds
    expect(text).toContain('default: — (unlimited)') // no default totalSeconds
    expect(text).toContain('skill|plugin|agent|command|mcp|all') // packTypeSchema options
    expect(text).toContain('home|docker') // isolationModeSchema options
  })

  it('no longer points at a non-existent top-level flag table', async () => {
    const out = captureStdout()
    await runCli(['run', '--help'])
    expect(out.text()).not.toContain('See `testaipack --help` for the full flag table')
  })

  it('lists the n-way variant flags (--parallel, --baseline, --hint) with real defaults', async () => {
    const out = captureStdout()
    await runCli(['run', '--help'])
    const text = out.text()
    expect(text).toContain('--parallel')
    expect(text).toContain('--baseline')
    expect(text).toContain('--hint')
    expect(text).toContain('default: 2') // DEFAULT_PARALLEL
  })
})

describe('cli/index — splitRunFlags', () => {
  it('extracts the four orchestrator flags and leaves everything else untouched, regardless of position', () => {
    const { flags, rest, error } = splitRunFlags([
      'repo.git', '--review-run', '3', '--prompt', 'x',
      '--ide', 'cursor', '--ephemeral', '--config', 'c.json',
    ])
    expect(error).toBeUndefined()
    expect(flags).toEqual({ reviewRun: 3, ide: 'cursor', ephemeral: true, configFile: 'c.json' })
    expect(rest).toEqual(['repo.git', '--prompt', 'x'])
  })

  it('supports the --flag=value inline form', () => {
    const { flags, error } = splitRunFlags(['--review-run=5', '--ide=code-insiders', '--config=c.json'])
    expect(error).toBeUndefined()
    expect(flags.reviewRun).toBe(5)
    expect(flags.ide).toBe('code-insiders')
    expect(flags.configFile).toBe('c.json')
  })

  it('--no-ephemeral turns ephemeral back off', () => {
    const { flags } = splitRunFlags(['--ephemeral', '--no-ephemeral'])
    expect(flags.ephemeral).toBe(false)
  })

  it('defaults are reviewRun=1, ide=vscode, ephemeral=false, configFile=undefined', () => {
    const { flags, rest } = splitRunFlags(['repo.git', '--prompt', 'x'])
    expect(flags).toEqual({ reviewRun: 1, ide: 'vscode', ephemeral: false, configFile: undefined })
    expect(rest).toEqual(['repo.git', '--prompt', 'x'])
  })

  it('does not swallow a dash-prefixed --prompt value meant for phase 00', () => {
    const { rest, error } = splitRunFlags(['--prompt', '-fix the regression'])
    expect(error).toBeUndefined()
    expect(rest).toEqual(['--prompt', '-fix the regression'])
  })

  it('--config with no value (next token is a known flag) errors instead of swallowing it', () => {
    const { error } = splitRunFlags(['--config', '--ide', 'cursor'])
    expect(error).toBe('--config requires a value')
  })

  it('--review-run at the end of input with no value errors', () => {
    const { error } = splitRunFlags(['repo.git', '--review-run'])
    expect(error).toBe('--review-run requires a value')
  })

  it('--review-run abc errors instead of silently defaulting to 1', () => {
    const { error } = splitRunFlags(['--review-run', 'abc'])
    expect(error).toBe('--review-run must be a positive integer, got: abc')
  })

  it('--review-run 0 errors instead of silently defaulting to 1', () => {
    const { error } = splitRunFlags(['--review-run', '0'])
    expect(error).toBe('--review-run must be a positive integer, got: 0')
  })

  it('--review-run=abc (inline form) errors the same way', () => {
    const { error } = splitRunFlags(['--review-run=abc'])
    expect(error).toBe('--review-run must be a positive integer, got: abc')
  })
})

describe('cli/index — run wiring (splitRunFlags -> executeRun -> runPipeline)', () => {
  const fakeOutcome: PipelineOutcome = {
    runId: 'run-fake',
    manifest: makeFakeManifest(),
    workspace: makeWorkspaceTree(makeTempDir(), 1, ['old', 'new']),
    rootPath: '/fake/root',
    metrics: makeMetricsReport(),
    reportPaths: {},
    reviewCommand: 'code /fake/review.code-workspace',
    summary: 'ok',
    diffEscalated: false,
  }

  beforeEach(() => {
    runPipelineMock.mockReset()
    runPipelineMock.mockReturnValue(Effect.succeed(fakeOutcome))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('binds --config/--ide/--review-run/--ephemeral regardless of order and forwards only the phase-00 tokens', async () => {
    const cfg = path.join(makeTempDir(), 'config.json')
    const code = await runCli([
      'run', 'https://example.com/repo.git',
      '--config', cfg,
      '--ide', 'cursor',
      '--prompt', 'x',
      '--review-run', '2',
      '--ephemeral',
    ])
    expect(code).toBe(0)
    expect(runPipelineMock).toHaveBeenCalledTimes(1)
    const opts = runPipelineMock.mock.calls[0]?.[0]
    expect(opts?.ephemeral).toBe(true)
    expect(opts?.ide).toBe('cursor')
    expect(opts?.reviewRun).toBe(2)
    expect(opts?.configFile).toBe(cfg)
    expect(opts?.argv).toEqual(['run', 'https://example.com/repo.git', '--prompt', 'x'])
  })

  it('defaults ephemeral=false, ide=vscode, reviewRun=1, configFile=undefined when absent', async () => {
    const code = await runCli(['run', 'https://example.com/repo.git', '--prompt', 'x'])
    expect(code).toBe(0)
    const opts = runPipelineMock.mock.calls[0]?.[0]
    expect(opts?.ephemeral).toBe(false)
    expect(opts?.ide).toBe('vscode')
    expect(opts?.reviewRun).toBe(1)
    expect(opts?.configFile).toBeUndefined()
  })

  it('works through the default (no literal "run") invocation form too', async () => {
    const code = await runCli(['https://example.com/repo.git', '--prompt', 'x', '--ephemeral'])
    expect(code).toBe(0)
    const opts = runPipelineMock.mock.calls[0]?.[0]
    expect(opts?.ephemeral).toBe(true)
    expect(opts?.argv).toEqual(['run', 'https://example.com/repo.git', '--prompt', 'x'])
  })

  it('a missing value for a known orchestrator flag exits 2 without calling runPipeline', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['run', 'https://example.com/repo.git', '--config', '--ide', 'cursor'])
    expect(code).toBe(2)
    expect(runPipelineMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith('--config requires a value')
  })

  it('a completed run with diffEscalated=true exits non-zero even though nothing threw', async () => {
    runPipelineMock.mockReturnValue(Effect.succeed({ ...fakeOutcome, diffEscalated: true }))
    const code = await runCli(['run', 'https://example.com/repo.git', '--prompt', 'x'])
    expect(code).not.toBe(0)
  })
})

describe('cli/index — resolveVariantSelector (D9 --perspective -> --variant mapping)', () => {
  it('no --perspective given → the --variant value passes through unchanged', () => {
    expect(resolveVariantSelector('best', undefined)).toBe('best')
    expect(resolveVariantSelector('graphify', undefined)).toBe('graphify')
  })

  it('new-vs-new / old-vs-old map to the new/old variant names', () => {
    expect(resolveVariantSelector('best', 'new-vs-new')).toBe('new')
    expect(resolveVariantSelector('best', 'old-vs-old')).toBe('old')
  })

  it('best / auto map to "best"', () => {
    expect(resolveVariantSelector('best', 'best')).toBe('best')
    expect(resolveVariantSelector('best', 'auto')).toBe('best')
  })
})

describe('cli/index — compare command (--variant / --variant2 / --perspective routing)', () => {
  beforeEach(() => {
    executeCompareMock.mockReset()
    executeCompareMock.mockResolvedValue(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults --variant to "best", applies it to BOTH variant1/variant2, format defaults to md', async () => {
    const code = await runCli(['compare', 'run-1', 'run-2'])
    expect(code).toBe(0)
    expect(executeCompareMock).toHaveBeenCalledTimes(1)
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string; format?: string }
    expect(opts.variant1).toBe('best')
    expect(opts.variant2).toBe('best')
    expect(opts.format).toBe('md')
  })

  it('--variant <name> is forwarded as-is to both variant1 and variant2', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--variant', 'graphify'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string }
    expect(opts.variant1).toBe('graphify')
    expect(opts.variant2).toBe('graphify')
  })

  it('--variant2 overrides run 2\'s selection independently, e.g. comparing a v1 report (old/new) against a v2 report (arbitrary names)', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--variant', 'new', '--variant2', 'b'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string }
    expect(opts.variant1).toBe('new')
    expect(opts.variant2).toBe('b')
  })

  it('--perspective new-vs-new maps to variant "new" on BOTH sides before reaching executeCompare', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--perspective', 'new-vs-new'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string }
    expect(opts.variant1).toBe('new')
    expect(opts.variant2).toBe('new')
  })

  it('--perspective old-vs-old maps to "old" on both sides', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--perspective', 'old-vs-old'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string }
    expect(opts.variant1).toBe('old')
    expect(opts.variant2).toBe('old')
  })

  it('--perspective auto maps to "best" on both sides (still accepted, D9)', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--perspective', 'auto'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string }
    expect(opts.variant1).toBe('best')
    expect(opts.variant2).toBe('best')
  })

  it('--perspective still lets --variant2 override run 2 independently', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--perspective', 'new-vs-new', '--variant2', 'b'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { variant1?: string; variant2?: string }
    expect(opts.variant1).toBe('new')
    expect(opts.variant2).toBe('b')
  })

  it('an unrecognized --perspective value errors clearly instead of falling through', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['compare', 'run-1', 'run-2', '--perspective', 'bogus'])
    expect(code).toBe(2)
    expect(executeCompareMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --perspective'))
  })

  it('an empty --variant is rejected by the real isVariantSelector (empty string) instead of calling executeCompare', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['compare', 'run-1', 'run-2', '--variant', ''])
    expect(code).toBe(2)
    expect(executeCompareMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --variant'))
  })

  it('an empty --variant2 is rejected the same way, naming --variant2 specifically', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['compare', 'run-1', 'run-2', '--variant2', ''])
    expect(code).toBe(2)
    expect(executeCompareMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --variant2'))
  })

  it('an invalid --format still errors before --variant is even validated', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['compare', 'run-1', 'run-2', '--format', 'xml'])
    expect(code).toBe(2)
    expect(executeCompareMock).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --format'))
  })

  it('--format json is forwarded', async () => {
    await runCli(['compare', 'run-1', 'run-2', '--format', 'json'])
    const opts = executeCompareMock.mock.calls[0]?.[0] as { format?: string }
    expect(opts.format).toBe('json')
  })
})

describe('cli/index — executeList (PACK column + IMP/REG per 02-phases.md "compare (and list)")', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('"No runs found" when the workspace is empty', async () => {
    const ws = makeTempDir()
    const out = captureStdout()
    const code = await executeList(ws)
    expect(code).toBe(0)
    expect(out.text()).toContain('No runs found')
  })

  it('PACK column joins every registered pack name; IMP/REG sums summary.perVariant across every variant bucket', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'run-1')
    const report = makeReportV2()
    await Effect.runPromise(ensureDir(path.join(dir, 'results')))
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), report.manifest))
    await Effect.runPromise(writeJson(path.join(dir, 'results', 'report.json'), report))

    const out = captureStdout()
    const code = await executeList(ws)
    expect(code).toBe(0)
    const text = out.text()
    // report.manifest.packs = [graphify, astgrep] (tests/helpers/variants.ts)
    expect(text).toContain('graphify,astgrep')
    // perVariant has 2 entries (graphify, astgrep), each with 2 improvements
    // + 3 regressions (tests/helpers/variants.ts buildSummary) -> 4/6 total.
    expect(text).toContain('4/6')
  })

  it('PACK column falls back to "-" for a run with an empty pack registry', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'run-1')
    await Effect.runPromise(ensureDir(path.join(dir, 'results')))
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), makeFakeManifest({ packs: [] })))

    const out = captureStdout()
    const code = await executeList(ws)
    expect(code).toBe(0)
    const [, dataLine] = out.text().split('\n')
    expect(dataLine).toMatch(/\s-\s/)
  })

  it('IMP/REG falls back to "-/-" when report.json is absent (run exists, no report yet)', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'run-1')
    await Effect.runPromise(ensureDir(path.join(dir, 'results')))
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), makeFakeManifest({ runId: 'run-1' })))

    const out = captureStdout()
    await executeList(ws)
    expect(out.text()).toContain('-/-')
  })

  it('lists multiple runs, most recent first', async () => {
    const ws = makeTempDir()
    const older = path.join(ws, 'run-older')
    const newer = path.join(ws, 'run-newer')
    await Effect.runPromise(ensureDir(path.join(older, 'results')))
    await Effect.runPromise(ensureDir(path.join(newer, 'results')))
    await Effect.runPromise(
      writeJson(
        path.join(older, 'manifest.json'),
        makeFakeManifest({ runId: 'older', timestamp: '2025-01-01T00:00:00.000Z' }),
      ),
    )
    await Effect.runPromise(
      writeJson(
        path.join(newer, 'manifest.json'),
        makeFakeManifest({ runId: 'newer', timestamp: '2025-06-01T00:00:00.000Z' }),
      ),
    )

    const out = captureStdout()
    const code = await executeList(ws)
    expect(code).toBe(0)
    const text = out.text()
    expect(text.indexOf('newer')).toBeLessThan(text.indexOf('older'))
  })
})

describe('cli/index — gc flag validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--keep-last abc errors clearly instead of silently keeping everything', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['gc', '--keep-last', 'abc', '--workspace', makeTempDir()])
    expect(code).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --keep-last'))
  })

  it('--older-than garbage errors clearly instead of silently no-op-ing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['gc', '--older-than', 'garbage', '--workspace', makeTempDir()])
    expect(code).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --older-than'))
  })

  it('a valid --keep-last still runs gc normally', async () => {
    const ws = makeTempDir()
    const out = captureStdout()
    const code = await runCli(['gc', '--keep-last', '0', '--workspace', ws])
    expect(code).toBe(0)
    expect(out.text()).toContain('Nothing to delete')
  })
})

describe('cli/index — review flag validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('--review-run abc errors clearly instead of silently defaulting to run 1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['review', '--review-run', 'abc', '--workspace', makeTempDir()])
    expect(code).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --review-run'))
  })

  it('--review-run 0 errors clearly instead of silently defaulting to run 1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['review', '--review-run', '0', '--workspace', makeTempDir()])
    expect(code).toBe(2)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('invalid --review-run'))
  })
})

describe('cli/index — executeInit (.gitignore entry)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes the workspace dir\'s own name to .gitignore, not a hardcoded ".testaipack/"', async () => {
    const projectRoot = makeTempDir()
    const workspace = path.join(projectRoot, 'custom-ws')
    const code = await executeInit(workspace)
    expect(code).toBe(0)
    const giPath = path.join(projectRoot, '.gitignore')
    expect(await Effect.runPromise(exists(giPath))).toBe(true)
    const content = await Effect.runPromise(readFile(giPath))
    expect(content).toContain('custom-ws/')
    expect(content).not.toContain('.testaipack/')
  })

  it('still writes ".testaipack/" when the workspace dir is actually named that', async () => {
    const projectRoot = makeTempDir()
    const workspace = path.join(projectRoot, '.testaipack')
    const code = await executeInit(workspace)
    expect(code).toBe(0)
    const content = await Effect.runPromise(
      readFile(path.join(projectRoot, '.gitignore')),
    )
    expect(content).toContain('.testaipack/')
  })

  // N2: the scaffold must stay usable the moment a user adds a `variants`
  // block — `pureBaseline` (legacy-shim-only) in the template would make
  // that instantly fail as legacy-flag-with-variants (02-phases.md "init").
  it('the generated config.json does not contain the legacy-only pureBaseline key', async () => {
    const workspace = path.join(makeTempDir(), 'ws')
    const code = await executeInit(workspace)
    expect(code).toBe(0)
    const raw = await Effect.runPromise(readFile(path.join(workspace, 'config.json')))
    const config = JSON.parse(raw) as Record<string, unknown>
    expect(config['pureBaseline']).toBeUndefined()
  })

  it('adding a variants block on top of the generated scaffold parses cleanly (no legacy-flag-with-variants)', async () => {
    const workspace = path.join(makeTempDir(), 'ws')
    await executeInit(workspace)
    const cfgPath = path.join(workspace, 'config.json')
    const raw = await Effect.runPromise(readFile(cfgPath))
    const scaffold = JSON.parse(raw) as Record<string, unknown>
    await Effect.runPromise(
      writeJson(cfgPath, {
        ...scaffold,
        repoUrl: 'https://example.com/repo.git',
        prompt: 'x',
        variants: [{ name: 'a', packs: [] }],
      }),
    )
    const { cliParse } = await import('../phases/00-cli-parse.js')
    const result = await Effect.runPromise(cliParse({ argv: ['run'], cwd: workspace, configFile: cfgPath }))
    expect(result.runInput.variants.map((v) => v.name)).toEqual(['a'])
  })
})

describe('cli/index — executeReport (typed error channel)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a corrupt report.json prints a clear error and returns 1 (not a raw FiberFailure)', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'run-1')
    await Effect.runPromise(ensureDir(path.join(dir, 'results')))
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), makeFakeManifest({ runId: 'run-1' })))
    await Effect.runPromise(writeFile(path.join(dir, 'results', 'report.json'), '{ not json'))

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await executeReport(undefined, ws)
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cannot read report.json'))
  })
})

class FakeChild extends EventEmitter {
  unref(): this {
    return this
  }
}

describe('cli/index — executeReview (spawn error handling)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const seedReviewWorkspace = async (ws: string): Promise<void> => {
    const dir = path.join(ws, 'run-1')
    await Effect.runPromise(ensureDir(path.join(dir, 'results')))
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), makeFakeManifest({ runId: 'run-1' })))
    await Effect.runPromise(writeFile(path.join(dir, 'results', 'review.code-workspace'), '{}'))
  }

  it('a missing IDE binary (ENOENT) reports a clear error instead of an uncaught exception', async () => {
    const ws = makeTempDir()
    await seedReviewWorkspace(ws)
    const fakeChild = new FakeChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        fakeChild.emit('error', new Error('spawn code ENOENT'))
      })
      return fakeChild as unknown as ChildProcess
    })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await executeReview({ runId: undefined, reviewRun: 1, ide: 'vscode', workspace: ws })
    expect(code).toBe(1)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('failed to open'))
  })

  it('a successful spawn prints the "opened" line only after spawn confirms', async () => {
    const ws = makeTempDir()
    await seedReviewWorkspace(ws)
    const fakeChild = new FakeChild()
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        fakeChild.emit('spawn')
      })
      return fakeChild as unknown as ChildProcess
    })

    const out = captureStdout()
    const code = await executeReview({ runId: undefined, reviewRun: 1, ide: 'vscode', workspace: ws })
    expect(code).toBe(0)
    expect(out.text()).toContain('opened')
  })
})
