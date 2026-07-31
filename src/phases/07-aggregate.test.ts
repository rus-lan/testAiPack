import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, readFile, writeFile, writeJson } from '../util/fs.js'
import { aggregate, toFailedRun, failedRunMarker } from './07-aggregate.js'
import type { AggregateInputExt, PackVisibilityEntry } from './07-aggregate.js'
import { PhaseError } from '../errors.js'
import type {
  ErrorCode,
  Manifest,
  RunInput,
  RunResult,
  VariantRunResults,
  WorkspaceTree,
} from '@generated/types'
import { makeRunResult, makeWorkspaceTree, shimPair, threeVariants } from '../../tests/helpers/variants.js'
import type * as MetricsAggregateModule from '../metrics/aggregate.js'

// Spy on WP7's real implementation (src/metrics/aggregate.ts landed
// scoped-green) instead of stubbing it — call-through, so this suite gets
// real aggregation math AND still lets the orchestration tests below inspect
// exactly what phase 07 handed to each call. Nothing here is a stand-in for
// WP7's own deep-math tests (median/IQR/packUse/contamination/phaseSplit),
// which stay in src/metrics/aggregate.test.ts — this file only verifies
// phase 07's orchestration: which raw files it reads, how it buckets failed
// runs, and what it hands to these two calls.
vi.mock('../metrics/aggregate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MetricsAggregateModule>()
  return {
    ...actual,
    buildVariantAggregates: vi.fn(actual.buildVariantAggregates),
    computeMetricsReport: vi.fn(actual.computeMetricsReport),
  }
})

import { buildVariantAggregates, computeMetricsReport } from '../metrics/aggregate.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

beforeEach(() => {
  vi.mocked(buildVariantAggregates).mockClear()
  vi.mocked(computeMetricsReport).mockClear()
})

const makeManifest = (runInput: RunInput): Manifest => ({
  schemaVersion: 2,
  runId: 'rid',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: runInput.repoUrl,
  runs: runInput.runs,
  parallel: runInput.parallel,
  baseline: runInput.baseline,
  packs: runInput.packs,
  variants: runInput.variants,
  isolation: runInput.isolation,
  opencodeVersion: 'test',
  flagDefaults: {},
  ...(runInput.prompt === undefined ? {} : { prompt: runInput.prompt }),
})

const makeWorkspace = async (runs: number, names: readonly string[]): Promise<WorkspaceTree> => {
  const root = makeTempDir()
  const tree = makeWorkspaceTree(root, runs, [...names])
  for (const name of names) {
    await runP(ensureDir(path.join(tree.raw, name)))
  }
  await runP(ensureDir(tree.results))
  return tree
}

const writeRaw = async (tree: WorkspaceTree, variant: string, runIndex: number, data: unknown): Promise<void> => {
  await runP(writeJson(path.join(tree.raw, variant, `run-${String(runIndex)}.json`), data))
}

interface ExportOpts {
  readonly id?: string
  readonly totalTokens?: number
  readonly cost?: number
  readonly messages?: readonly Record<string, unknown>[]
}

const exportJson = (o: ExportOpts): Record<string, unknown> => ({
  info: {
    id: o.id ?? `sess-${Math.random().toString(36).slice(2, 8)}`,
    slug: 's',
    projectID: 'p',
    directory: '/x',
    title: 't',
    agent: 'a',
    model: { id: 'm', providerID: 'prov' },
    version: '1',
    summary: { additions: 0, deletions: 0, files: 0 },
    cost: o.cost ?? 0,
    tokens: { input: o.totalTokens ?? 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  },
  messages: o.messages ?? [],
})

const results = (names: readonly string[], runs: number): VariantRunResults[] =>
  names.map((name) => ({
    name,
    runs: Array.from({ length: runs }, (_, i) => makeRunResult(name, i + 1)),
  }))

const buildInput = (
  runInput: RunInput,
  workspace: WorkspaceTree,
  runResults: VariantRunResults[],
  packVisibility?: readonly PackVisibilityEntry[],
): AggregateInputExt => ({
  runInput,
  manifest: makeManifest(runInput),
  workspace,
  results: runResults,
  ...(packVisibility === undefined ? {} : { packVisibility }),
})

describe('aggregate — variant orchestration (3-way: base/graphify/astgrep)', () => {
  it('processes every variant in config order, extracting per-run metrics for each', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    await writeRaw(tree, 'base', 1, exportJson({ totalTokens: 111 }))
    await writeRaw(tree, 'graphify', 1, exportJson({ totalTokens: 222 }))
    await writeRaw(tree, 'astgrep', 1, exportJson({ totalTokens: 333 }))

    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    const calls = vi.mocked(buildVariantAggregates).mock.calls
    expect(calls.map(([input]) => input.variant)).toEqual(['base', 'graphify', 'astgrep'])
    expect(calls[0]?.[0].extracted[0]?.primary.totalTokens).toBe('111')
    expect(calls[1]?.[0].extracted[0]?.primary.totalTokens).toBe('222')
    expect(calls[2]?.[0].extracted[0]?.primary.totalTokens).toBe('333')
  })

  it('calls computeMetricsReport once with (baseline, variantAggregates[]) in config order and returns { metrics }', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    expect(computeMetricsReport).toHaveBeenCalledTimes(1)
    const [baseline, all] = vi.mocked(computeMetricsReport).mock.calls[0] ?? []
    expect(baseline).toBe('base')
    expect((all ?? []).map((v) => v.variant)).toEqual(['base', 'graphify', 'astgrep'])
    expect(result.metrics.baseline).toBe('base')
  })

  it('writes results/metrics.json containing { metrics } exactly as computeMetricsReport returned it', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    const raw = await runP(readFile(path.join(tree.results, 'metrics.json')))
    expect(JSON.parse(raw)).toEqual({ metrics: result.metrics })
  })

  it('a variant absent from `results` (no VariantRunResults entry) is treated as zero runs, not an error', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    await writeRaw(tree, 'base', 1, exportJson({ totalTokens: 1 }))
    // graphify/astgrep runs deliberately omitted from `results`.
    await runP(aggregate(buildInput(runInput, tree, [results(names, 1)[0]!])))
    const calls = vi.mocked(buildVariantAggregates).mock.calls
    const graphifyCall = calls.find(([input]) => input.variant === 'graphify')
    expect(graphifyCall?.[0].extracted).toEqual([])
  })
})

describe('aggregate — failed runs', () => {
  it('successRank 0 is bucketed as a failed run and never reaches extraction', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(2, names)
    await writeRaw(tree, 'base', 1, exportJson({ totalTokens: 1 }))
    // base/run-2 has no raw file — it is a failed run, extraction must not run for it.
    for (const name of ['graphify', 'astgrep']) {
      for (const i of [1, 2]) await writeRaw(tree, name, i, exportJson({ totalTokens: 1 }))
    }
    const runResults: VariantRunResults[] = [
      { name: 'base', runs: [makeRunResult('base', 1, { successRank: 4 }), makeRunResult('base', 2, { successRank: 0, finishCause: 'error', exitCode: 1 })] },
      { name: 'graphify', runs: [1, 2].map((i) => makeRunResult('graphify', i)) },
      { name: 'astgrep', runs: [1, 2].map((i) => makeRunResult('astgrep', i)) },
    ]

    await runP(aggregate(buildInput(runInput, tree, runResults)))

    const baseCall = vi.mocked(buildVariantAggregates).mock.calls.find(([input]) => input.variant === 'base')
    expect(baseCall?.[0].extracted).toHaveLength(1)
    expect(baseCall?.[0].failedRuns).toEqual([
      {
        variant: 'base',
        runIndex: 2,
        errorCode: 'E_RUN_CRASH',
        errorMessage: 'run base/2 failed: finishCause=error exitCode=1 watchdog=false',
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ])
  })

  it('all runs failed on every variant -> no throw, every variant gets an empty extracted list', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    const runResults: VariantRunResults[] = names.map((name) => ({
      name,
      runs: [makeRunResult(name, 1, { successRank: 0, finishCause: 'error', exitCode: 1 })],
    }))
    await runP(aggregate(buildInput(runInput, tree, runResults)))
    for (const [input] of vi.mocked(buildVariantAggregates).mock.calls) {
      expect(input.extracted).toEqual([])
      expect(input.failedRuns).toHaveLength(1)
    }
  })
})

describe('failedRunMarker / toFailedRun — exact wording (shared with src/cli/rebuild.ts, WP13)', () => {
  it('failedRunMarker matches the pinned "run <variant>/<n> failed: ..." shape', () => {
    expect(
      failedRunMarker('graphify', { runIndex: 3, finishCause: 'error', exitCode: 1, watchdogTriggered: false }),
    ).toBe('run graphify/3 failed: finishCause=error exitCode=1 watchdog=false')
  })

  it('toFailedRun.errorMessage is exactly failedRunMarker(r.variant, r), and errorCode defaults to E_RUN_CRASH', () => {
    const r: RunResult = makeRunResult('astgrep', 5, { successRank: 0, finishCause: 'error', exitCode: 1, watchdogTriggered: true })
    const failed = toFailedRun(r, '2025-06-01T00:00:00.000Z')
    expect(failed).toEqual({
      variant: 'astgrep',
      runIndex: 5,
      errorCode: 'E_RUN_CRASH',
      errorMessage: failedRunMarker('astgrep', r),
      timestamp: '2025-06-01T00:00:00.000Z',
    })
  })

  it('an explicit errorCode on the run result is preserved instead of the E_RUN_CRASH default', () => {
    const r: RunResult = makeRunResult('base', 1, { successRank: 0, errorCode: 'E_RUN_HANG_WATCHDOG' as ErrorCode, watchdogTriggered: true })
    expect(toFailedRun(r, 't').errorCode).toBe('E_RUN_HANG_WATCHDOG')
  })
})

describe('aggregate — export validation errors', () => {
  it('invalid export JSON, successRank != 0 -> E_EXPORT_INVALID with variant + runIndex context', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    await runP(writeFile(path.join(tree.raw, 'graphify', 'run-1.json'), '{ "not": "an export" }'))
    for (const name of ['base', 'astgrep']) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    const err = await runFlip(aggregate(buildInput(runInput, tree, results(names, 1))))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.context?.['variant']).toBe('graphify')
    expect(err.context?.['runIndex']).toBe(1)
  })

  it('missing export file, successRank != 0 -> E_EXPORT_INVALID', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of ['base', 'graphify']) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    // astgrep/run-1.json deliberately not written.
    const err = await runFlip(aggregate(buildInput(runInput, tree, results(names, 1))))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.context?.['variant']).toBe('astgrep')
  })
})

describe('aggregate — pack detection (canDetect), once per registry pack', () => {
  it('a git-url pack ref resolves as a skill -> canDetect true for every variant declaring it', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    const graphifyCall = vi.mocked(buildVariantAggregates).mock.calls.find(([input]) => input.variant === 'graphify')
    expect(graphifyCall?.[0].packs).toEqual([{ name: 'graphify', canDetect: true, visibilityConfirmed: false }])
  })

  it('a plugin pack ref (npm:) -> canDetect false (invisible in exports)', async () => {
    const { runInput: base } = threeVariants()
    const runInput: RunInput = {
      ...base,
      packs: [{ name: 'graphify', ref: 'npm:some-plugin' }],
      variants: base.variants.map((v) => (v.name === 'graphify' ? { ...v, packs: ['graphify'] } : { ...v, packs: [] })),
    }
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    const graphifyCall = vi.mocked(buildVariantAggregates).mock.calls.find(([input]) => input.variant === 'graphify')
    expect(graphifyCall?.[0].packs).toEqual([{ name: 'graphify', canDetect: false, visibilityConfirmed: false }])
  })

  it('an already-resolved PackSpec.type is honored as-is, never re-derived from the ref (cliParse "downstream phases never re-detect")', async () => {
    const { runInput: base } = threeVariants()
    // ref alone would detect as 'plugin' (npm: prefix) -> canDetect false;
    // an explicit type: 'skill' (as cliParse's detectPackTypes would have
    // resolved it) must win over that re-derivation.
    const runInput: RunInput = {
      ...base,
      packs: [{ name: 'graphify', ref: 'npm:some-plugin', type: 'skill' }],
      variants: base.variants.map((v) => (v.name === 'graphify' ? { ...v, packs: ['graphify'] } : { ...v, packs: [] })),
    }
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    const graphifyCall = vi.mocked(buildVariantAggregates).mock.calls.find(([input]) => input.variant === 'graphify')
    expect(graphifyCall?.[0].packs).toEqual([{ name: 'graphify', canDetect: true, visibilityConfirmed: false }])
  })

  it('a variant with no declared packs gets packs: []', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    const baseCall = vi.mocked(buildVariantAggregates).mock.calls.find(([input]) => input.variant === 'base')
    expect(baseCall?.[0].packs).toEqual([])
  })
})

describe('aggregate — pack visibility (per variant, per pack — no more forced-false baseline)', () => {
  it('packVisibility entries thread into packs[].visibilityConfirmed, matched by (variant, pack)', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    const packVisibility: PackVisibilityEntry[] = [
      { variant: 'graphify', pack: 'graphify', confirmed: true },
      { variant: 'astgrep', pack: 'astgrep', confirmed: false },
    ]

    await runP(aggregate(buildInput(runInput, tree, results(names, 1), packVisibility)))

    const calls = vi.mocked(buildVariantAggregates).mock.calls
    expect(calls.find(([i]) => i.variant === 'graphify')?.[0].packs).toEqual([
      { name: 'graphify', canDetect: true, visibilityConfirmed: true },
    ])
    expect(calls.find(([i]) => i.variant === 'astgrep')?.[0].packs).toEqual([
      { name: 'astgrep', canDetect: true, visibilityConfirmed: false },
    ])
  })

  it('a baseline that declares its own pack resolves visibilityConfirmed normally (v2: not forced false)', async () => {
    const { runInput: base } = threeVariants()
    const runInput: RunInput = {
      ...base,
      variants: base.variants.map((v) => (v.name === 'base' ? { ...v, packs: ['graphify'] } : v)),
    }
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    const packVisibility: PackVisibilityEntry[] = [{ variant: 'base', pack: 'graphify', confirmed: true }]

    await runP(aggregate(buildInput(runInput, tree, results(names, 1), packVisibility)))

    const baseCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'base')
    expect(baseCall?.[0].packs).toEqual([{ name: 'graphify', canDetect: true, visibilityConfirmed: true }])
  })

  it('packVisibility omitted entirely (e.g. --no-preflight) -> visibilityConfirmed false everywhere, the honest default', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    const calls = vi.mocked(buildVariantAggregates).mock.calls
    for (const [input] of calls) {
      for (const p of input.packs) expect(p.visibilityConfirmed).toBe(false)
    }
  })
})

describe('aggregate — foreign-pack sets (03-hard-problems.md §3.1: F(V) = union of others\' packs minus own)', () => {
  it('base (no packs) sees both graphify and astgrep as foreign, in declaration order (matching gate 5, not alphabetical)', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    const baseCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'base')
    expect(baseCall?.[0].foreignPacks).toEqual(['graphify', 'astgrep'])
  })

  it('graphify sees astgrep as foreign, but never its own declared pack', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    const graphifyCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'graphify')
    expect(graphifyCall?.[0].foreignPacks).toEqual(['astgrep'])
  })

  it('a pack shared by two variants is foreign to neither', async () => {
    const { runInput: base } = threeVariants()
    const runInput: RunInput = {
      ...base,
      variants: base.variants.map((v) => (v.name === 'astgrep' ? { ...v, packs: ['graphify', 'astgrep'] } : v)),
    }
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    const astgrepCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'astgrep')
    expect(astgrepCall?.[0].foreignPacks).toEqual([])
  })
})

describe('aggregate — config-drift signal, per variant (fires for every variant now, not just the old baseline)', () => {
  const writeInstalledJson = async (tree: WorkspaceTree, variant: string, data: unknown): Promise<void> => {
    const dir = path.join(tree.config, '.config', 'opencode', variant)
    await runP(ensureDir(dir))
    await runP(writeJson(path.join(dir, 'installed.json'), data))
  }

  it('drift on a non-baseline variant is read and threaded into that variant\'s input', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await writeInstalledJson(tree, 'graphify', {
      side: 'graphify', identicalAcrossRuns: false, driftFiles: ['skills'], runsCompared: 1, skills: [],
    })

    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    const graphifyCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'graphify')
    expect(graphifyCall?.[0].configDriftSignal).toEqual({
      kind: 'install-drift',
      detail: 'снятый конфиг этого варианта отличается между его собственными запусками: skills',
    })
    const baseCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'base')
    expect(baseCall?.[0].configDriftSignal).toBeUndefined()
  })

  it('missing installed.json (e.g. --no-preflight) does not fail the phase', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    expect(result.metrics).toBeDefined()
  })
})

describe('aggregate — verify stats', () => {
  it('exit 0 -> passed, non-zero -> failed, E_VERIFY_TIMEOUT -> timedOut, per variant', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(3, names)
    for (const name of names) for (const i of [1, 2, 3]) await writeRaw(tree, name, i, exportJson({ totalTokens: 1 }))
    const runResults: VariantRunResults[] = [
      {
        name: 'base',
        runs: [
          makeRunResult('base', 1, { verifyExitCode: 0 }),
          makeRunResult('base', 2, { verifyExitCode: 1 }),
          makeRunResult('base', 3, { successRank: 0, errorCode: 'E_VERIFY_TIMEOUT' }),
        ],
      },
      { name: 'graphify', runs: [1, 2, 3].map((i) => makeRunResult('graphify', i, { verifyExitCode: 0 })) },
      { name: 'astgrep', runs: [1, 2, 3].map((i) => makeRunResult('astgrep', i, { verifyExitCode: 0 })) },
    ]

    await runP(aggregate(buildInput(runInput, tree, runResults)))

    const baseCall = vi.mocked(buildVariantAggregates).mock.calls.find(([i]) => i.variant === 'base')
    expect(baseCall?.[0].verifyStats).toEqual({ passed: 1, failed: 1, timedOut: 1, runCount: 3 })
  })

  it('no run has verify data -> verifyStats absent', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))
    await runP(aggregate(buildInput(runInput, tree, results(names, 1))))
    for (const [input] of vi.mocked(buildVariantAggregates).mock.calls) {
      expect(input.verifyStats).toBeUndefined()
    }
  })
})

describe('aggregate — shimPair backward-compat smoke (variants old/new)', () => {
  it('a 2-variant shim run still processes both variants against the "old" baseline', async () => {
    const { runInput } = shimPair()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    expect(vi.mocked(buildVariantAggregates).mock.calls.map(([i]) => i.variant)).toEqual(['old', 'new'])
    expect(result.metrics.baseline).toBe('old')
  })
})

// ---------------------------------------------------------------------------
// End-to-end against WP7's real buildVariantAggregates/computeMetricsReport
// (call-through spy, see the vi.mock block above) — covers the Phase 07 AC
// in 02-phases.md §07 that only makes sense with real math underneath.
// ---------------------------------------------------------------------------

const bashPart = (command: string, id = 'bash') => ({
  type: 'tool', tool: 'bash', callID: `c-${id}`, state: { status: 'completed', input: { command } }, id,
})

describe('aggregate — real end-to-end (3 variants, config order, contamination)', () => {
  it('metrics.variants is in config order and metrics.deltas has one entry per non-baseline variant', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    for (const name of names) await writeRaw(tree, name, 1, exportJson({ totalTokens: 1 }))

    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    expect(result.metrics.variants.map((v) => v.variant)).toEqual(['base', 'graphify', 'astgrep'])
    expect(result.metrics.deltas.map((d) => d.variant)).toEqual(['graphify', 'astgrep'])
  })

  it("an install-shaped bash command for a FOREIGN pack surfaces as a contaminationSignal naming that pack; a variant's own declared pack never contaminates itself", async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(1, names)
    // base declares no packs, so graphify is foreign to it.
    await writeRaw(tree, 'base', 1, exportJson({
      messages: [{ info: { role: 'assistant', time: { created: 0 } }, parts: [bashPart('npm install -g graphify')] }],
    }))
    // graphify declares its own pack, so the same shaped command there is NOT contamination.
    await writeRaw(tree, 'graphify', 1, exportJson({
      messages: [{ info: { role: 'assistant', time: { created: 0 } }, parts: [bashPart('npm install -g graphify')] }],
    }))
    await writeRaw(tree, 'astgrep', 1, exportJson({ totalTokens: 1 }))

    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 1))))

    const base = result.metrics.variants.find((v) => v.variant === 'base')
    const graphify = result.metrics.variants.find((v) => v.variant === 'graphify')
    expect(base?.contaminationSignals).toEqual([
      { kind: 'bash-install', detail: 'npm install -g graphify', pack: 'graphify', runIndex: 1 },
    ])
    expect(graphify?.contaminationSignals).toEqual([])
  })

  it('aggregates a real number across runs: median + IQR of totalTokens over 4 known samples', async () => {
    const { runInput } = threeVariants()
    const names = runInput.variants.map((v) => v.name)
    const tree = await makeWorkspace(4, names)
    // Arithmetic progression [100,200,300,400]: median (200+300)/2=250,
    // IQR = p75-p25 = 325-175 = 150 (linear-interpolation percentile, same
    // formula as src/metrics/stats.ts — reviewed independently here).
    for (const [i, tokens] of [100, 200, 300, 400].entries()) {
      await writeRaw(tree, 'base', i + 1, exportJson({ totalTokens: tokens }))
    }
    for (const name of ['graphify', 'astgrep']) {
      for (const i of [1, 2, 3, 4]) await writeRaw(tree, name, i, exportJson({ totalTokens: 1 }))
    }

    const result = await runP(aggregate(buildInput(runInput, tree, results(names, 4))))

    const base = result.metrics.variants.find((v) => v.variant === 'base')
    expect(base?.primary.totalTokens).toBe('250')
    expect(base?.stats.totalTokens.iqr).toBe(150)
    expect(base?.stats.totalTokens.samples).toEqual([100, 200, 300, 400])
  })
})
