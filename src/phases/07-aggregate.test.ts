import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile, writeJson } from '../util/fs.js'
import { aggregate } from './07-aggregate.js'
import { PhaseError } from '../errors.js'
import type {
  ErrorCode,
  Manifest,
  RunInput,
  RunSideResult,
  WorkspaceTree,
} from '@generated/types'
import type { RunSideResultExt } from './06-run-side.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const makeRunInput = (over: Partial<RunInput>): RunInput => ({
  repoUrl: '',
  prompt: 'p',
  runs: 3,
  isolation: 'home',
  auth: {
    opencode: false, npmrc: false, anthropic: false, openai: false,
    gemini: false, aws: false, ssh: false, git: false,
  },
  pureBaseline: true,
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  collapseRepeats: true,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60, runSeconds: 600, verifySeconds: 300,
    installSeconds: 300, watchdogSeconds: 1200,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  ...over,
})

const makeManifest = (runInput: RunInput): Manifest => ({
  runId: 'rid',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: runInput.repoUrl,
  prompt: runInput.prompt,
  runs: runInput.runs,
  isolation: runInput.isolation,
  opencodeVersion: 'test',
  flagDefaults: {},
})

const makeWorkspace = async (runs: number): Promise<WorkspaceTree> => {
  const root = makeTempDir()
  const range = Array.from({ length: runs }, (_, i) => i + 1)
  const tree: WorkspaceTree = {
    root,
    appsSource: path.join(root, 'apps', 'source'),
    appsOld: range.map((n) => path.join(root, 'apps', 'oldVersion', `run-${String(n)}`)),
    appsNew: range.map((n) => path.join(root, 'apps', 'newVersion', `run-${String(n)}`)),
    pack: path.join(root, 'pack'),
    homeOld: [],
    homeNew: [],
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'results', 'raw'),
    diff: path.join(root, 'results', 'diff'),
  }
  await runP(ensureDir(path.join(tree.raw, 'old')))
  await runP(ensureDir(path.join(tree.raw, 'new')))
  return tree
}

const sideResult = (
  side: 'old' | 'new',
  runIndex: number,
  successRank: number,
  opts: { readonly finishCause?: RunSideResult['finishCause']; readonly exitCode?: number; readonly watchdog?: boolean; readonly errorCode?: ErrorCode } = {},
): RunSideResultExt => ({
  side,
  runIndex,
  exportPath: '',
  eventsLogPath: '',
  successRank,
  finishCause: opts.finishCause ?? 'stop',
  exitCode: opts.exitCode ?? 0,
  durationMs: '0',
  watchdogTriggered: opts.watchdog ?? false,
  ...(opts.errorCode === undefined ? {} : { errorCode: opts.errorCode }),
})

interface ExportOpts {
  readonly id?: string
  readonly totalTokens?: number
  readonly cost?: number
  readonly tStart?: number
  readonly tEnd?: number
  readonly provider?: string
  readonly model?: string
  readonly messages?: readonly Record<string, unknown>[]
  readonly summary?: { readonly additions: number; readonly deletions: number; readonly files: number }
}

const exportJson = (o: ExportOpts): Record<string, unknown> => ({
  info: {
    id: o.id ?? `sess-${Math.random().toString(36).slice(2, 8)}`,
    slug: 's',
    projectID: 'p',
    directory: '/x',
    title: 't',
    agent: 'a',
    model: { id: o.model ?? 'm', providerID: o.provider ?? 'prov' },
    version: '1',
    summary: o.summary ?? { additions: 0, deletions: 0, files: 0 },
    cost: o.cost ?? 0,
    tokens: { input: o.totalTokens ?? 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: String(o.tStart ?? 0), updated: String(o.tEnd ?? 0) },
  },
  messages: o.messages ?? [],
})

const toolPart = (name: string, status: 'completed' | 'error' = 'completed', id = name) => ({
  type: 'tool', tool: name, callID: `c-${id}`, state: { status, input: {} }, id,
})

const writeRaw = async (tree: WorkspaceTree, side: 'old' | 'new', runIndex: number, data: unknown): Promise<void> => {
  await runP(writeJson(path.join(tree.raw, side, `run-${String(runIndex)}.json`), data))
}

const PRICING_JSON = {
  version: '1',
  providers: { prov: { m: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 } } },
  fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

describe('aggregate — happy path', () => {
  it('2x3 successful runs -> MetricsDiff with deltas and metrics.json written', async () => {
    const tree = await makeWorkspace(3)
    const runInput = makeRunInput({ runs: 3 })
    // old tokens 100/200/300 -> median 200; new 150/250/350 -> median 250
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 100 }))
    await writeRaw(tree, 'old', 2, exportJson({ totalTokens: 200 }))
    await writeRaw(tree, 'old', 3, exportJson({ totalTokens: 300 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 150 }))
    await writeRaw(tree, 'new', 2, exportJson({ totalTokens: 250 }))
    await writeRaw(tree, 'new', 3, exportJson({ totalTokens: 350 }))

    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [1, 2, 3].map((i) => sideResult('old', i, 4)),
        new: [1, 2, 3].map((i) => sideResult('new', i, 4)),
      },
    }))

    expect(result.metricsDiff.bothFailed).toBe(false)
    expect(result.rawAggregates.old.primary.totalTokens).toBe('200')
    expect(result.rawAggregates.new.primary.totalTokens).toBe('250')
    expect(result.metricsDiff.deltas.totalTokens.absolute).toBe(50)
    expect(result.metricsDiff.deltas.totalTokens.better).toBe('worse')
    expect(result.rawAggregates.old.stats.totalTokens.samples).toEqual([100, 200, 300])
    expect(result.rawAggregates.old.stats.totalTokens.iqr).toBeUndefined()
    expect(existsSync(path.join(tree.results, 'metrics.json'))).toBe(true)
  })

  it('maxParallelism is 1 per run (v0.1)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 10 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 10 }))
    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4)],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(result.rawAggregates.old.primary.maxParallelism).toBe(1)
    expect(result.metricsDiff.deltas.maxParallelism.better).toBe('context-dependent')
  })
})

describe('aggregate — failed runs', () => {
  it('one failed run (successRank 0) is excluded from median and recorded', async () => {
    const tree = await makeWorkspace(3)
    const runInput = makeRunInput({ runs: 3 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 100 }))
    await writeRaw(tree, 'old', 3, exportJson({ totalTokens: 300 }))
    // run-2 failed -> no raw file needed; successRank 0
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 100 }))
    await writeRaw(tree, 'new', 2, exportJson({ totalTokens: 100 }))
    await writeRaw(tree, 'new', 3, exportJson({ totalTokens: 100 }))

    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [
          sideResult('old', 1, 4),
          sideResult('old', 2, 0, { finishCause: 'error', exitCode: 1 }),
          sideResult('old', 3, 4),
        ],
        new: [1, 2, 3].map((i) => sideResult('new', i, 4)),
      },
    }))

    // median of [100,300] = 200
    expect(result.rawAggregates.old.primary.totalTokens).toBe('200')
    expect(result.rawAggregates.old.stats.totalTokens.samples).toEqual([100, 300])
    expect(result.rawAggregates.old.failedRuns).toHaveLength(1)
    expect(result.rawAggregates.old.failedRuns[0]?.runIndex).toBe(2)
    expect(result.rawAggregates.old.failedRuns[0]?.errorCode).toBe('E_RUN_CRASH')
    expect(result.rawAggregates.old.failedRuns[0]?.timestamp).toBe(makeManifest(runInput).timestamp)
  })

  it('all runs failed on both sides -> bothFailed true (no throw)', async () => {
    const tree = await makeWorkspace(2)
    const runInput = makeRunInput({ runs: 2 })
    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [
          sideResult('old', 1, 0, { finishCause: 'error', exitCode: 1 }),
          sideResult('old', 2, 0, { watchdog: true, errorCode: 'E_RUN_HANG_WATCHDOG' }),
        ],
        new: [
          sideResult('new', 1, 0, { finishCause: 'error', exitCode: 1 }),
          sideResult('new', 2, 0, { finishCause: 'error', exitCode: 1 }),
        ],
      },
    }))
    expect(result.metricsDiff.bothFailed).toBe(true)
    expect(result.rawAggregates.old.stats.totalTokens.samples).toEqual([])
    expect(result.rawAggregates.old.failedRuns[0]?.errorCode).toBe('E_RUN_CRASH')
    expect(result.rawAggregates.old.failedRuns[1]?.errorCode).toBe('E_RUN_HANG_WATCHDOG')
    expect(result.metricsDiff.deltas.totalTokens.better).toBe('neutral')
  })

  it('invalid export but successRank != 0 -> E_EXPORT_INVALID with runIndex', async () => {
    const tree = await makeWorkspace(2)
    const runInput = makeRunInput({ runs: 2 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 10 }))
    await runP(writeFile(path.join(tree.raw, 'old', 'run-2.json'), '{ "not": "an export" }'))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 10 }))
    await writeRaw(tree, 'new', 2, exportJson({ totalTokens: 10 }))

    const err = await runFlip(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4), sideResult('old', 2, 4)],
        new: [1, 2].map((i) => sideResult('new', i, 4)),
      },
    }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.context?.['runIndex']).toBe(2)
    expect(err.context?.['side']).toBe('old')
  })

  it('missing export file but successRank != 0 -> E_EXPORT_INVALID', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    // no raw/old/run-1.json written, successRank != 0
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 5 }))
    const err = await runFlip(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4)],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_EXPORT_INVALID')
  })
})

describe('aggregate — cost source', () => {
  it('pricing.json present and info.cost = 0 -> cost computed from pricing table', async () => {
    const tree = await makeWorkspace(1)
    const pricingPath = path.join(tree.root, 'pricing.json')
    await runP(writeJson(pricingPath, PRICING_JSON))
    const runInput = makeRunInput({ runs: 1, pricingPath })
    // 1M input tokens @ 1/M = 1.0 USD; info.cost = 0 so pricing path is taken
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 1000000, cost: 0 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 1000000, cost: 0 }))
    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4)],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(result.rawAggregates.old.primary.costUsd).toBeCloseTo(1.0, 6)
  })

  it('no pricing path -> falls back to info.cost', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 0, cost: 0.0123 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 0, cost: 0.0123 }))
    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4)],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(result.rawAggregates.old.primary.costUsd).toBeCloseTo(0.0123, 5)
  })

  it('pricing path points to missing file -> falls back to info.cost', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, pricingPath: path.join(tree.root, 'nope.json') })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 0, cost: 0.05 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 0, cost: 0.05 }))
    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4)],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(result.rawAggregates.old.primary.costUsd).toBeCloseTo(0.05, 5)
  })
})

describe('aggregate — secondary aggregation', () => {
  it('finishCauseDistribution and perTool aggregate across runs', async () => {
    const tree = await makeWorkspace(2)
    const runInput = makeRunInput({ runs: 2 })
    const msg = (toolName: string, status: 'completed' | 'error', finish: string, id: string): Record<string, unknown> => ({
      info: { role: 'assistant', time: { created: '0' }, finish },
      parts: [toolPart(toolName, status, id)],
    })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [msg('bash', 'completed', 'stop', 'a')] }))
    await writeRaw(tree, 'old', 2, exportJson({ messages: [msg('bash', 'error', 'error', 'b')] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 2, exportJson({ messages: [] }))

    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: {
        old: [1, 2].map((i) => sideResult('old', i, 4)),
        new: [1, 2].map((i) => sideResult('new', i, 4)),
      },
    }))
    const old = result.rawAggregates.old
    // bash: 2 calls, 1 error -> errorRate 0.5
    expect(old.secondary.perTool['bash']?.count).toBe(2)
    expect(old.secondary.perTool['bash']?.errorRate).toBeCloseTo(0.5, 3)
    expect(old.secondary.finishCauseDistribution['stop']).toBe(1)
    expect(old.secondary.finishCauseDistribution['error']).toBe(1)
  })

  it('maxConsecutiveSameTool: 5 identical bash -> 5', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    const msg: Record<string, unknown> = {
      info: { role: 'assistant', time: { created: '0' } },
      parts: [1, 2, 3, 4, 5].map((i) => toolPart('bash', 'completed', `b${String(i)}`)),
    }
    await writeRaw(tree, 'old', 1, exportJson({ messages: [msg] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.secondary.maxConsecutiveSameTool).toBe(5)
  })

  it('metrics.json content validates against the aggregateResult shape', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 10 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 20 }))
    await runP(aggregate({
      runInput,
      manifest: makeManifest(runInput),
      workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    const raw = await runP(readFile(path.join(tree.results, 'metrics.json')))
    const parsed: unknown = JSON.parse(raw)
    expect(parsed).toHaveProperty('metricsDiff')
    expect(parsed).toHaveProperty('rawAggregates')
  })
})
