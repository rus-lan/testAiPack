import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile, writeJson } from '../util/fs.js'
import { toNum } from '../util/numeric.js'
import { aggregate } from './07-aggregate.js'
import type { SessionTreeLoader } from './10-timeline.js'
import type { SessionTreeNode } from '../metrics/extract.js'
import { PhaseError } from '../errors.js'
import type {
  ErrorCode,
  Manifest,
  OpencodeExport,
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
  initSide: 'both',
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  protectGit: false,
  allowBaselineTool: false,
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
    gitDirsOld: [],
    gitDirsNew: [],
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
  opts: {
    readonly finishCause?: RunSideResult['finishCause']
    readonly exitCode?: number
    readonly watchdog?: boolean
    readonly errorCode?: ErrorCode
    readonly verifyExitCode?: number
    readonly eventsLogPath?: string
  } = {},
): RunSideResultExt => ({
  side,
  runIndex,
  exportPath: '',
  eventsLogPath: opts.eventsLogPath ?? '',
  successRank,
  finishCause: opts.finishCause ?? 'stop',
  exitCode: opts.exitCode ?? 0,
  durationMs: '0',
  watchdogTriggered: opts.watchdog ?? false,
  ...(opts.errorCode === undefined ? {} : { errorCode: opts.errorCode }),
  ...(opts.verifyExitCode === undefined ? {} : { verifyExitCode: opts.verifyExitCode }),
})

const skillPart = (packName: string, status: 'completed' | 'error' = 'completed', id = 'skill') => ({
  type: 'tool',
  tool: 'skill',
  callID: `c-${id}`,
  state: { status, input: { name: packName }, time: { start: 0, end: 1 } },
  id,
})

const writeEvents = async (
  tree: WorkspaceTree,
  side: 'old' | 'new',
  runIndex: number,
  lines: readonly string[],
): Promise<string> => {
  const file = path.join(tree.raw, side, `run-${String(runIndex)}.events.ndjson`)
  await runP(writeFile(file, lines.join('\n')))
  return file
}

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
    time: { created: o.tStart ?? 0, updated: o.tEnd ?? 0 },
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

  it('maxParallelism is 1 per run (single root session, no sub-agents)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 10, tStart: 0, tEnd: 5000 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 10, tStart: 0, tEnd: 5000 }))
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

  it('aggregates a session tree: sums tokens across nodes, maxParallelism from intervals', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    const rootExp = exportJson({ id: 'root', totalTokens: 100, tStart: 0, tEnd: 1000 })
    const childExp = exportJson({ id: 'child', totalTokens: 50, tStart: 200, tEnd: 800 })
    await writeRaw(tree, 'old', 1, rootExp)
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 100, tStart: 0, tEnd: 1000 }))

    const loadTree = vi.fn(((): SessionTreeLoader => () =>
      Effect.succeed<readonly SessionTreeNode[]>([
        { sessionId: 'root', parentId: null, depth: 0, export: rootExp as OpencodeExport, children: [] },
        { sessionId: 'child', parentId: 'root', depth: 1, export: childExp as OpencodeExport, children: [] },
      ]))())

    const result = await runP(aggregate(
      {
        runInput, manifest: makeManifest(runInput), workspace: tree,
        sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
      },
      { loadTree },
    ))
    // old: root(100) + child(50) summed across the tree
    expect(result.rawAggregates.old.primary.totalTokens).toBe('150')
    // overlapping root[0,1000] & child[200,800] -> parallelism 2
    expect(result.rawAggregates.old.primary.maxParallelism).toBe(2)
    // wallClockMs = outer envelope, not the sum
    expect(result.rawAggregates.old.primary.wallClockMs).toBe('1000')
    expect(loadTree).toHaveBeenCalled()
  })

  it('no sub-agents (default) -> maxParallelism 1, tokens from root only', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({ totalTokens: 77, tStart: 0, tEnd: 3000 }))
    await writeRaw(tree, 'new', 1, exportJson({ totalTokens: 77, tStart: 0, tEnd: 3000 }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.primary.totalTokens).toBe('77')
    expect(result.rawAggregates.old.primary.maxParallelism).toBe(1)
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
      info: { role: 'assistant', time: { created: 0 }, finish },
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
      info: { role: 'assistant', time: { created: 0 } },
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

describe('aggregate — pack usage', () => {
  it('packName resolved from a skill packRef and threaded to extraction', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [{ info: { role: 'assistant', time: { created: 0 } }, parts: [skillPart('graphify')] }] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.packUse?.calls).toBe(1)
    expect(result.rawAggregates.old.packUse?.canDetect).toBe(true)
  })

  it('plugin packRef -> packUse.canDetect false, calls 0 (invisible in exports)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'npm:some-plugin' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.packUse?.canDetect).toBe(false)
    expect(result.rawAggregates.old.packUse?.calls).toBe(0)
  })

  it('no packRef -> packUse absent entirely', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.packUse).toBeUndefined()
  })

  it('packVisibilityConfirmed threads into packUse.visibilityConfirmed on new; old always false (the pack is never installed there)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
      packVisibilityConfirmed: true,
    }))
    expect(result.rawAggregates.new.packUse?.visibilityConfirmed).toBe(true)
    expect(result.rawAggregates.old.packUse?.visibilityConfirmed).toBe(false)
  })

  it('packVisibilityConfirmed omitted (e.g. --no-preflight) -> visibilityConfirmed false on both sides, the honest default', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.new.packUse?.visibilityConfirmed).toBe(false)
    expect(result.rawAggregates.old.packUse?.visibilityConfirmed).toBe(false)
  })
})

const bashPart = (command: string, id = 'bash') => ({
  type: 'tool', tool: 'bash', callID: `c-${id}`, state: { status: 'completed', input: { command } }, id,
})

const writeInstalledJson = async (
  tree: WorkspaceTree,
  side: 'old' | 'new',
  data: unknown,
): Promise<void> => {
  const dir = path.join(tree.config, '.config', 'opencode', side)
  await runP(ensureDir(dir))
  await runP(writeJson(path.join(dir, 'installed.json'), data))
}

describe('aggregate — baseline contamination (end-to-end through phase 07)', () => {
  it('an install-shaped bash command on old surfaces as a contaminationSignal with the run index attached', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({
      messages: [{ info: { role: 'assistant', time: { created: 0 } }, parts: [bashPart('npm install -g @sentropic/graphify')] }],
    }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.contaminationSignals).toEqual([
      { kind: 'bash-install', detail: 'npm install -g @sentropic/graphify', runIndex: 1 },
    ])
    // the pack side is SUPPOSED to show pack activity — never surfaced there
    expect(result.rawAggregates.new.contaminationSignals).toBeUndefined()
  })

  it('a clean old side -> contaminationSignals present but empty (checked, nothing found)', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.contaminationSignals).toEqual([])
  })

  it('installed.json drift on old (skills) surfaces as an install-drift signal with no runIndex', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    await writeInstalledJson(tree, 'old', {
      side: 'old', identicalAcrossRuns: false, driftFiles: ['skills'], runsCompared: 4, skills: [],
    })
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.contaminationSignals).toEqual([
      { kind: 'install-drift', detail: "captured config differs across this side's own runs in: skills" },
    ])
  })

  it('missing installed.json (e.g. --no-preflight or older workspace) does not fail the phase', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1, packRef: 'https://github.com/Graphify-Labs/graphify' })
    await writeRaw(tree, 'old', 1, exportJson({ messages: [] }))
    await writeRaw(tree, 'new', 1, exportJson({ messages: [] }))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.contaminationSignals).toEqual([])
  })
})

describe('aggregate — verify stats (P10)', () => {
  it('exit 0 -> passed, non-zero -> failed, E_VERIFY_TIMEOUT -> timedOut', async () => {
    const tree = await makeWorkspace(3)
    const runInput = makeRunInput({ runs: 3 })
    await writeRaw(tree, 'old', 1, exportJson({}))
    await writeRaw(tree, 'old', 2, exportJson({}))
    await writeRaw(tree, 'new', 1, exportJson({}))
    await writeRaw(tree, 'new', 2, exportJson({}))
    await writeRaw(tree, 'new', 3, exportJson({}))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: {
        old: [
          sideResult('old', 1, 4, { verifyExitCode: 0 }),
          sideResult('old', 2, 4, { verifyExitCode: 1 }),
          sideResult('old', 3, 0, { errorCode: 'E_VERIFY_TIMEOUT' }),
        ],
        new: [1, 2, 3].map((i) => sideResult('new', i, 4, { verifyExitCode: 0 })),
      },
    }))
    expect(result.rawAggregates.old.verifyStats).toEqual({ passed: 1, failed: 1, timedOut: 1, runCount: 3 })
    expect(result.rawAggregates.new.verifyStats).toEqual({ passed: 3, failed: 0, timedOut: 0, runCount: 3 })
  })

  it('no run has verify data -> verifyStats absent', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({}))
    await writeRaw(tree, 'new', 1, exportJson({}))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: { old: [sideResult('old', 1, 4)], new: [sideResult('new', 1, 4)] },
    }))
    expect(result.rawAggregates.old.verifyStats).toBeUndefined()
  })
})

describe('aggregate — events profile (P5)', () => {
  it('events file read per run and profiled into the P5 secondary fields', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({}))
    await writeRaw(tree, 'new', 1, exportJson({}))
    const eventsLogPath = await writeEvents(tree, 'old', 1, [
      JSON.stringify({ type: 'text', timestamp: 1000, part: { type: 'text', text: 'hi' } }),
      JSON.stringify({ type: 'tool_use', timestamp: 1200, part: { type: 'tool', tool: 'bash' } }),
    ])
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4, { eventsLogPath })],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(result.rawAggregates.old.secondary.timeToFirstToolMs).toBe('200')
  })

  it('missing events file -> P5 fields omitted, no error', async () => {
    const tree = await makeWorkspace(1)
    const runInput = makeRunInput({ runs: 1 })
    await writeRaw(tree, 'old', 1, exportJson({}))
    await writeRaw(tree, 'new', 1, exportJson({}))
    const result = await runP(aggregate({
      runInput, manifest: makeManifest(runInput), workspace: tree,
      sideResults: {
        old: [sideResult('old', 1, 4, { eventsLogPath: path.join(tree.raw, 'old', 'missing.ndjson') })],
        new: [sideResult('new', 1, 4)],
      },
    }))
    expect(result.rawAggregates.old.secondary.timeToFirstToolMs).toBeUndefined()
    expect(result.rawAggregates.old.secondary.maxEventGapMs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real ground truth — .research/metrics-expansion/golden-values.md. Reads the
// actual raw exports + events.ndjson from the sample workspace this data was
// hand-computed from. That workspace lives outside the repo (a real testaipack
// run under the user's home, not a checked-in fixture), so this block skips
// cleanly when absent — same pattern as src/metrics/events-profile.test.ts.
// ---------------------------------------------------------------------------

const GOLDEN_ROOT = '/home/ruslan/.testaipack/2026-07-29_20-44-07_ed1eeb'
const hasGoldenWorkspace = existsSync(GOLDEN_ROOT)

describe.skipIf(!hasGoldenWorkspace)('aggregate — real ground truth (golden-values.md)', () => {
  it('side aggregates match the hand-computed golden table for both sides', async () => {
    const rawDir = path.join(GOLDEN_ROOT, 'results', 'raw')
    const tempResults = makeTempDir()
    const tree: WorkspaceTree = {
      root: GOLDEN_ROOT,
      appsSource: path.join(GOLDEN_ROOT, 'apps', 'source'),
      appsOld: [],
      appsNew: [],
      pack: path.join(GOLDEN_ROOT, 'pack'),
      homeOld: [],
      homeNew: [],
      gitDirsOld: [],
      gitDirsNew: [],
      config: path.join(GOLDEN_ROOT, 'config'),
      results: tempResults,
      raw: rawDir,
      diff: path.join(tempResults, 'diff'),
    }
    const runInput = makeRunInput({ runs: 5, packRef: 'https://github.com/Graphify-Labs/graphify' })
    const manifest = makeManifest(runInput)
    const runsFor = (side: 'old' | 'new'): RunSideResultExt[] =>
      [1, 2, 3, 4, 5].map((i) =>
        sideResult(side, i, 4, {
          eventsLogPath: path.join(rawDir, side, `run-${String(i)}.events.ndjson`),
        }),
      )
    const result = await runP(aggregate({
      runInput,
      manifest,
      workspace: tree,
      sideResults: { old: runsFor('old'), new: runsFor('new') },
    }))

    const old = result.rawAggregates.old
    const nw = result.rawAggregates.new

    // packUse
    expect(old.packUse).toEqual({ calls: 1, errors: 1, runsWithCall: 1, runCount: 5, firstCallMsMedian: '64043', canDetect: true, visibilityConfirmed: false, runsWithoutCall: [1, 2, 3, 4] })
    expect(nw.packUse).toEqual({ calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: false, runsWithoutCall: [1, 2, 3, 4, 5] })

    // riskyCommands
    expect(old.riskyCommands).toEqual([
      { runIndex: 1, command: 'rm -rf /workspace/.git && echo "Removed git repo" && ls -la /workspace/', completed: true, exitCode: 0 },
    ])
    expect(nw.riskyCommands).toEqual([])

    // wave-1 counters
    expect(old.secondary.bashFailCount).toBe(5)
    expect(nw.secondary.bashFailCount).toBe(0)
    expect(old.secondary.invalidToolCalls).toBe(1)
    expect(nw.secondary.invalidToolCalls).toBe(0)
    expect(old.secondary.duplicateToolCalls).toBe(5)
    expect(nw.secondary.duplicateToolCalls).toBe(1)

    // P5 latency — both sides in this golden workspace ran --init (2 user
    // messages per export), so timeToFirstToolMs/timeToFirstEditMs are now
    // scoped to the task phase (metric-split spec §5.3): measured from the
    // first post-boundary event, not from the very start of the stream.
    // Golden-values.md pins the pre-split (whole-stream) numbers; these are
    // the corrected task-phase ones. old/run-5's task phase never calls a
    // tool at all (only step-start/text/step-finish after its boundary), so
    // it contributes no data point to either median — 4 of 5 runs, not 5.
    expect(old.secondary.timeToFirstToolMs).toBe('2066') // median of [996, 1754, 2377, 3487]
    expect(nw.secondary.timeToFirstToolMs).toBe('1936') // median of [1835, 1899, 1936, 2096, 2267]
    expect(old.secondary.timeToFirstEditMs).toBe('46282') // median of [20136, 44651, 47912, 111362]
    expect(nw.secondary.timeToFirstEditMs).toBe('63367') // median of [24040, 44224, 82510, 136248] (new/run-2 has no edit)
    expect(old.secondary.maxEventGapMs).toBe('252915')
    expect(nw.secondary.maxEventGapMs).toBe('240663')
    // stall count (>60s threshold): golden per-run maxGap table has exactly
    // one run over 60s on each side (old/run-1 252915ms, new/run-2 240663ms)
    expect(old.secondary.stalledRunCount).toBe(1)
    expect(nw.secondary.stalledRunCount).toBe(1)
    expect(old.secondary.stallCount).toBeGreaterThanOrEqual(1)
    expect(nw.secondary.stallCount).toBeGreaterThanOrEqual(1)

    // P11 context growth
    expect(old.secondary.firstStepInputTokens).toBe('5491')
    expect(nw.secondary.firstStepInputTokens).toBe('5491')
    expect(old.secondary.lastStepInputTokens).toBe('18184')
    expect(nw.secondary.lastStepInputTokens).toBe('12485') // fallback rule, not the literal-last 10905

    // P12 output volume
    expect(old.secondary.textChars).toBe('1003')
    expect(nw.secondary.textChars).toBe('972')
    expect(old.secondary.reasoningChars).toBe('4107')
    // golden-values.md says 3364 (Python len(), counts Unicode codepoints);
    // new/run-4's reasoning text ends in a literal emoji (U+1F389 🎉), which
    // JS .length counts as a 2-unit UTF-16 surrogate pair — 3365 is correct
    // for this codebase (every other char count here is plain .length, no
    // codepoint-aware counting exists anywhere else in the repo).
    expect(nw.secondary.reasoningChars).toBe('3365')

    // cache write + versions + verify
    expect(old.secondary.cacheWriteTokens).toBe('0')
    expect(nw.secondary.cacheWriteTokens).toBe('0')
    expect(old.opencodeVersions).toEqual(['1.18.4'])
    expect(nw.opencodeVersions).toEqual(['1.18.4'])
    expect(old.verifyStats).toBeUndefined()
    expect(nw.verifyStats).toBeUndefined()

    // existing field, newly rendered
    expect(old.secondary.maxConsecutiveSameTool).toBe(4)
    expect(nw.secondary.maxConsecutiveSameTool).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Real ground truth — .research/metric-split/spec.md evidence workspace
// (10x2 runs, graphify pack, `--init-side new`). Read-only; skips cleanly
// when the workspace isn't present on this machine. Expected numbers are
// independently computed straight from the raw exports (median over the 10
// per-run init/task slices — same conservation source verified per-run in
// src/metrics/extract.test.ts), not copied from the spec's own worked
// example.
// ---------------------------------------------------------------------------

const B348A2_ROOT = '/home/ruslan/.testaipack/2026-07-30_09-25-09_b348a2'
const hasB348A2 = existsSync(B348A2_ROOT)

describe.skipIf(!hasB348A2)('aggregate — phase split real ground truth (b348a2, --init-side new)', () => {
  it('new side: runsWithInit=10, init/task medians match independently computed values; old side: no init at all', async () => {
    const rawDir = path.join(B348A2_ROOT, 'results', 'raw')
    const tempResults = makeTempDir()
    const tree: WorkspaceTree = {
      root: B348A2_ROOT,
      appsSource: path.join(B348A2_ROOT, 'apps', 'source'),
      appsOld: [],
      appsNew: [],
      pack: path.join(B348A2_ROOT, 'pack'),
      homeOld: [],
      homeNew: [],
      gitDirsOld: [],
      gitDirsNew: [],
      config: path.join(B348A2_ROOT, 'config'),
      results: tempResults,
      raw: rawDir,
      diff: path.join(tempResults, 'diff'),
    }
    const runInput = makeRunInput({ runs: 10, packRef: 'https://github.com/Graphify-Labs/graphify' })
    const manifest = makeManifest(runInput)
    const runsFor = (side: 'old' | 'new'): RunSideResultExt[] =>
      Array.from({ length: 10 }, (_, i) => i + 1).map((i) =>
        sideResult(side, i, 4, { eventsLogPath: path.join(rawDir, side, `run-${String(i)}.events.ndjson`) }),
      )
    const result = await runP(
      aggregate({ runInput, manifest, workspace: tree, sideResults: { old: runsFor('old'), new: runsFor('new') } }),
    )

    const old = result.rawAggregates.old
    const nw = result.rawAggregates.new

    // old side never ran --init in this workspace (--init-side new) — no
    // boundary in any of its 10 exports, so phaseSplit.init is absent and
    // task equals the whole run (same values the primary table already
    // shows for old, per §1's motivating report.md excerpt: 147474 total).
    expect(old.phaseSplit).toBeDefined()
    expect(old.phaseSplit?.runsWithInit).toBe(0)
    expect(old.phaseSplit?.runsWithLostInit).toBe(0)
    expect(old.phaseSplit?.init).toBeUndefined()
    expect(old.phaseSplit?.task).toEqual({
      totalTokens: '147474',
      wallClockMs: '229696',
      costUsd: 0,
      stepCount: 13,
      toolCallCount: 14,
    })

    // new side ran --init on all 10 runs — every export carries a boundary.
    expect(nw.phaseSplit).toBeDefined()
    expect(nw.phaseSplit?.runsWithInit).toBe(10)
    expect(nw.phaseSplit?.runsWithLostInit).toBe(0)
    expect(nw.phaseSplit?.init).toEqual({
      totalTokens: '455398',
      wallClockMs: '199658',
      costUsd: 0,
      stepCount: 24,
      toolCallCount: 30,
    })
    expect(nw.phaseSplit?.task).toEqual({
      totalTokens: '301566',
      wallClockMs: '143660',
      costUsd: 0,
      stepCount: 11,
      toolCallCount: 11,
    })
    // Neither side's per-message/session costs are populated in this
    // workspace and no pricing table was supplied — 0, not prorated.
    expect(old.phaseSplit?.costProrated).toBeUndefined()
    expect(nw.phaseSplit?.costProrated).toBeUndefined()

    // taskDeltas: present because both sides carry phaseSplit — the
    // like-for-like basis even though init is one-sided here.
    expect(result.metricsDiff.taskDeltas).toBeDefined()
    expect(result.metricsDiff.taskDeltas?.totalTokens.absolute).toBe(301566 - 147474)
    // initDeltas: absent — init is one-sided (old has runsWithInit === 0).
    expect(result.metricsDiff.initDeltas).toBeUndefined()

    // Whole-run ("total") deltas are unaffected by the split — still the
    // +341% swing from §1 of the spec (147474 -> 650322-ish scale); the
    // point of the split is that the TASK basis tells a different, calmer
    // story (above), not that the old total-table numbers change.
    expect(toNum(old.primary.totalTokens)).toBe(147474)
  })
})
