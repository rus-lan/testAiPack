import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { Effect } from 'effect'
import pkg from '../../package.json' with { type: 'json' }
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, exists, readFile, writeJson, writeFile } from '../util/fs.js'
import {
  makeManifest,
  makeMetricsDiff,
  makeWorkspace,
} from '../../tests/report-fixture.js'
import { VALUE_FLAGS, BOOLEAN_FLAGS } from '../phases/00-cli-parse.js'

vi.mock('./pipeline.js', () => ({ runPipeline: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { runCli, executeInit, executeReport, executeReview, splitRunFlags } from './index.js'
import { runPipeline } from './pipeline.js'
import type { PipelineOutcome } from './pipeline.js'
import { spawn } from 'node:child_process'

const runPipelineMock = vi.mocked(runPipeline)
const spawnMock = vi.mocked(spawn)

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
    manifest: makeManifest(),
    workspace: makeWorkspace(1),
    rootPath: '/fake/root',
    metricsDiff: makeMetricsDiff(),
    reportPaths: {},
    reviewCommand: 'code /fake/review.code-workspace',
    summary: 'ok',
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
})

describe('cli/index — executeReport (typed error channel)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a corrupt report.json prints a clear error and returns 1 (not a raw FiberFailure)', async () => {
    const ws = makeTempDir()
    const dir = path.join(ws, 'run-1')
    await Effect.runPromise(ensureDir(path.join(dir, 'results')))
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), makeManifest({ runId: 'run-1' })))
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
    await Effect.runPromise(writeJson(path.join(dir, 'manifest.json'), makeManifest({ runId: 'run-1' })))
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
