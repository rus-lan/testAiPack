import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  ensureDir,
  readFile,
  readDir,
  writeFile,
} from '../src/util/fs.js'
import { makeTempDir } from './setup.js'
import { runCli } from '../src/cli/index.js'
import {
  aggregateResultSchema,
  reportSchema,
  timelineSchema,
  opencodeExportSchema,
} from '@generated/schemas'

// ---------------------------------------------------------------------------
// Mock opencode (never spawn the real binary in tests).
// ---------------------------------------------------------------------------

vi.mock('../src/opencode/cli.js', () => ({
  OpencodeError: class extends Error {
    readonly _tag = 'OpencodeError'
    readonly command: string
    readonly exitCode: number | null
    readonly stderr: string
    readonly timedOut: boolean
    constructor(args: {
      command: string
      exitCode: number | null
      stderr: string
      timedOut: boolean
    }) {
      super(`opencode ${args.command} failed`)
      this.command = args.command
      this.exitCode = args.exitCode
      this.stderr = args.stderr
      this.timedOut = args.timedOut
    }
  },
  version: vi.fn(() => Effect.succeed('1.0.0')),
  run: vi.fn(
    (opts: { onEvent?: (e: unknown) => void }) =>
      Effect.sync(() => {
        opts.onEvent?.({ type: 'step-finish', reason: 'stop', id: 'sf-1' })
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 12, timedOut: false }
      }),
  ),
  exportSession: vi.fn((_home: string, _sid: string) => Effect.succeed(buildExport('same'))),
  installPlugin: vi.fn(() => Effect.void),
  listMcp: vi.fn(() => Effect.succeed('')),
}))

vi.mock('../src/opencode/spawn.js', () => ({
  spawnProcess: vi.fn(() =>
    Effect.succeed({ stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false }),
  ),
}))

const { run: runMock, exportSession: exportMock, version: versionMock, OpencodeError } =
  await import('../src/opencode/cli.js')
const mockedRun = vi.mocked(runMock)
const mockedExport = vi.mocked(exportMock)
const mockedVersion = vi.mocked(versionMock)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const buildExport = (variant: 'same' | 'better'): string => {
  const tokens =
    variant === 'better'
      ? { input: 60, output: 30, reasoning: 5, cache: { read: 2, write: 1 } }
      : { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 3 } }
  return JSON.stringify({
    info: {
      id: 'sess-e2e',
      slug: 's',
      projectID: 'p',
      directory: '/app',
      title: 't',
      agent: 'build',
      model: { id: 'claude-test', providerID: 'anthropic' },
      version: '1.0.0',
      summary: { additions: 5, deletions: 1, files: 1 },
      cost: 0.01,
      tokens,
      time: { created: '0', updated: '2000' },
    },
    messages: [
      {
        info: { role: 'user', time: { created: '0' } },
        parts: [{ type: 'text', text: 'do the thing', id: 'p1' }],
      },
      {
        info: {
          role: 'assistant',
          finish: 'stop',
          time: { created: '0', completed: '2000' },
        },
        parts: [
          { type: 'step-start', id: 'p2' },
          {
            type: 'reasoning',
            text: 'thinking',
            time: { start: '100', end: '500' },
            id: 'p3',
          },
          {
            type: 'tool',
            tool: 'bash',
            callID: 'c1',
            state: {
              status: 'completed',
              input: {},
              time: { start: '500', end: '1500' },
            },
            id: 'p4',
          },
          {
            type: 'step-finish',
            reason: 'stop',
            tokens: {
              input: tokens.input,
              output: tokens.output,
              reasoning: tokens.reasoning,
              cache: tokens.cache,
              total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
            },
            id: 'p5',
          },
          { type: 'text', text: 'done', id: 'p6' },
        ],
      },
    ],
  })
}

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync('git', [...args], { cwd, stdio: 'pipe' })
}

const createTinyRepo = async (): Promise<string> => {
  const repo = makeTempDir()
  await runP(ensureDir(repo))
  git(repo, ['init', '--quiet'])
  git(repo, ['config', 'user.email', 't@t'])
  git(repo, ['config', 'user.name', 'testaipack'])
  await runP(writeFile(path.join(repo, 'README.md'), '# tiny repo\n'))
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-m', 'init', '--quiet'])
  return repo
}

const createSkillPack = async (): Promise<string> => {
  const skillDir = makeTempDir()
  await runP(ensureDir(skillDir))
  await runP(
    writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: a dummy skill\n---\n# my skill\n',
    ),
  )
  return skillDir
}

// ---------------------------------------------------------------------------
// HOME manipulation (phase 04 copies auth from $HOME).
// ---------------------------------------------------------------------------

const realHome = process.env['HOME']

const withFakeHome = async (fn: () => Promise<void>): Promise<void> => {
  const fakeHome = makeTempDir()
  await runP(ensureDir(path.join(fakeHome, '.opencode')))
  process.env['HOME'] = fakeHome
  try {
    await fn()
  } finally {
    process.env['HOME'] = realHome
  }
}

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const findRunDir = async (workspace: string): Promise<string> => {
  const entries = await runP(readDir(workspace))
  const dir = entries.find((e) => /^\d{4}-\d{2}-\d{2}/.test(e))
  if (dir === undefined) {
    throw new Error(`no run dir in ${workspace}: ${entries.join(', ')}`)
  }
  return path.join(workspace, dir)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: full A/B pipeline via runCli', () => {
  beforeEach(() => {
    mockedRun.mockClear()
    mockedExport.mockClear()
  })

  afterEach(() => {
    if (process.env['HOME'] !== realHome) {
      process.env['HOME'] = realHome
    }
  })

  it('runs end-to-end on a tiny repo with mock opencode (skill pack, 1 run)', async () => {
    await withFakeHome(async () => {
      const repo = await createTinyRepo()
      const skill = await createSkillPack()
      const workspace = path.join(makeTempDir(), '.testaipack')

      const code = await runCli([
        'run',
        repo,
        '--pack',
        skill,
        '--pack-type',
        'skill',
        '--prompt',
        'build the thing',
        '--runs',
        '1',
        '--no-preflight',
        '--auth',
        'opencode',
        '--workspace',
        workspace,
      ])

      expect(code).toBe(0)

      const runDir = await findRunDir(workspace)
      const results = path.join(runDir, 'results')

      // manifest
      expect(existsSync(path.join(runDir, 'manifest.json'))).toBe(true)

      // raw exports
      expect(existsSync(path.join(results, 'raw', 'old', 'run-1.json'))).toBe(true)
      expect(existsSync(path.join(results, 'raw', 'new', 'run-1.json'))).toBe(true)
      const oldExport = await runP(readFile(path.join(results, 'raw', 'old', 'run-1.json')))
      expect(opencodeExportSchema.safeParse(JSON.parse(oldExport)).success).toBe(true)

      // metrics.json
      expect(existsSync(path.join(results, 'metrics.json'))).toBe(true)
      const metricsRaw = await runP(readFile(path.join(results, 'metrics.json')))
      const metrics = aggregateResultSchema.parse(JSON.parse(metricsRaw))
      expect(metrics.metricsDiff.old.side).toBe('old')
      expect(metrics.metricsDiff.new.side).toBe('new')
      for (const key of Object.keys(metrics.metricsDiff.deltas) as readonly string[]) {
        const d = (metrics.metricsDiff.deltas as Record<string, { readonly better: string }>)[key]
        expect(d).toBeDefined()
        expect(typeof (d as { readonly better: string }).better).toBe('string')
      }

      // report.md + report.json
      expect(existsSync(path.join(results, 'report.md'))).toBe(true)
      const md = await runP(readFile(path.join(results, 'report.md')))
      expect(md).toContain('# testaipack report')
      expect(existsSync(path.join(results, 'report.json'))).toBe(true)
      const reportRaw = await runP(readFile(path.join(results, 'report.json')))
      expect(reportSchema.safeParse(JSON.parse(reportRaw)).success).toBe(true)

      // timeline.json
      expect(existsSync(path.join(results, 'timeline.json'))).toBe(true)
      const tlRaw = await runP(readFile(path.join(results, 'timeline.json')))
      expect(timelineSchema.safeParse(JSON.parse(tlRaw)).success).toBe(true)

      // diff patches
      expect(existsSync(path.join(results, 'diff', 'old', 'run-1', 'full.patch'))).toBe(true)
      expect(existsSync(path.join(results, 'diff', 'new', 'run-1', 'full.patch'))).toBe(true)

      // review.code-workspace
      expect(existsSync(path.join(results, 'review.code-workspace'))).toBe(true)

      // opencode was actually invoked (mocked): 1 run \u00d7 2 sides = 2 run calls + 2 exports
      expect(mockedRun).toHaveBeenCalledTimes(2)
      expect(mockedExport).toHaveBeenCalledTimes(2)
    })
  }, 60_000)

  it('smoke-test mode (no --pack): baseline vs baseline', async () => {
    await withFakeHome(async () => {
      const repo = await createTinyRepo()
      const workspace = path.join(makeTempDir(), '.testaipack')

      const code = await runCli([
        'run',
        repo,
        '--prompt',
        'do something',
        '--runs',
        '1',
        '--no-preflight',
        '--auth',
        'opencode',
        '--workspace',
        workspace,
      ])

      expect(code).toBe(0)
      const runDir = await findRunDir(workspace)
      expect(existsSync(path.join(runDir, 'manifest.json'))).toBe(true)
      expect(existsSync(path.join(runDir, 'results', 'report.md'))).toBe(true)
    })
  }, 60_000)

  it('missing repo + prompt fails with non-zero exit', async () => {
    const workspace = path.join(makeTempDir(), '.testaipack')
    const code = await runCli(['run', '--workspace', workspace])
    expect(code).not.toBe(0)
  }, 30_000)

  it('--output <path> redirects report artifacts out of the workspace', async () => {
    await withFakeHome(async () => {
      const repo = await createTinyRepo()
      const workspace = path.join(makeTempDir(), '.testaipack')
      const outDir = path.join(makeTempDir(), 'my-output')

      const code = await runCli([
        'run',
        repo,
        '--prompt',
        'do something',
        '--runs',
        '1',
        '--no-preflight',
        '--auth',
        'opencode',
        '--workspace',
        workspace,
        '--output',
        outDir,
      ])
      expect(code).toBe(0)

      const runDir = await findRunDir(workspace)
      const wsResults = path.join(runDir, 'results')

      // manifest + raw exports stay in the workspace tree
      expect(existsSync(path.join(runDir, 'manifest.json'))).toBe(true)
      expect(existsSync(path.join(wsResults, 'raw', 'old', 'run-1.json'))).toBe(true)
      expect(existsSync(path.join(wsResults, 'raw', 'new', 'run-1.json'))).toBe(true)

      // report artifacts land in the custom --output dir, not under workspace
      expect(existsSync(path.join(outDir, 'report.md'))).toBe(true)
      expect(existsSync(path.join(outDir, 'report.json'))).toBe(true)
      expect(existsSync(path.join(outDir, 'metrics.json'))).toBe(true)
      expect(existsSync(path.join(outDir, 'timeline.json'))).toBe(true)
      expect(existsSync(path.join(outDir, 'diff', 'old', 'run-1', 'full.patch'))).toBe(true)
      expect(existsSync(path.join(outDir, 'diff', 'new', 'run-1', 'full.patch'))).toBe(true)
      expect(existsSync(path.join(outDir, 'review.code-workspace'))).toBe(true)
      expect(existsSync(path.join(outDir, 'gc.log'))).toBe(true)

      // and NOT in the workspace results dir
      expect(existsSync(path.join(wsResults, 'report.md'))).toBe(false)
      expect(existsSync(path.join(wsResults, 'metrics.json'))).toBe(false)
    })
  }, 60_000)

  it('preflight failure (opencode launch fails) exits with code 2', async () => {
    // version() fails on every call: phase 01 probe swallows it ('unknown'),
    // phase 05 gate 1 (opencode-launch) surfaces it as exit 2.
    mockedVersion.mockImplementation(() =>
      Effect.fail(
        new OpencodeError({
          command: 'version',
          exitCode: 1,
          stderr: 'opencode not installed',
          timedOut: false,
        }),
      ),
    )
    await withFakeHome(async () => {
      const repo = await createTinyRepo()
      const workspace = path.join(makeTempDir(), '.testaipack')
      const code = await runCli([
        'run',
        repo,
        '--prompt',
        'x',
        '--runs',
        '1',
        '--auth',
        'opencode',
        '--workspace',
        workspace,
      ])
      expect(code).toBe(2)
    })
    mockedVersion.mockReset()
    mockedVersion.mockImplementation(() => Effect.succeed('1.0.0'))
  }, 60_000)
})
