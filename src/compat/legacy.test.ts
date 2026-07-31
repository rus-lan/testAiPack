import { describe, it, expect } from 'vitest'
import {
  judgeResultSchema,
  manifestSchema,
  prepReportSchema,
  reportSchema,
  runInputSchema,
  runResultSchema,
} from '@generated/schemas'
import {
  mapJudgeResultV1ToV2,
  mapManifestV1ToV2,
  mapPackSetupReportV1ToV2,
  mapReportV1ToV2,
  mapRunInputV1ToV2,
  mapRunResultV1ToV2,
  parseJudgeResultCompat,
  parseManifestCompat,
  parsePrepReportCompat,
  parseReportCompat,
  parseRunInputCompat,
  parseRunResultCompat,
  readInitSideDefensively,
} from './legacy.js'

// ---------------------------------------------------------------------------
// v1 fixtures — hand-built to the exact shapes frozen in v1-schemas.ts
// ---------------------------------------------------------------------------

const v1Manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: 'run-abc-001',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  packRef: 'https://example.com/graphify.git',
  packType: 'skill',
  prompt: 'do the thing',
  init: '/graphify .',
  verify: 'npm test',
  runs: 3,
  isolation: 'home',
  opencodeVersion: '1.18.3',
  flagDefaults: { initSide: 'both' },
  packHint: 'be careful',
  ...over,
})

const v1RunInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repoUrl: 'https://example.com/repo.git',
  packRef: 'https://example.com/graphify.git',
  packType: 'skill',
  prompt: 'do the thing',
  initSide: 'both',
  runs: 3,
  isolation: 'home',
  auth: {
    opencode: true, npmrc: true, anthropic: false, openai: false, gemini: false, aws: false, ssh: false, git: false,
  },
  pureBaseline: true,
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  protectGit: false,
  collapseRepeats: false,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60, runSeconds: 600, verifySeconds: 300, installSeconds: 300, watchdogSeconds: 90,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  ...over,
})

const v1RunResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  side: 'old',
  runIndex: 1,
  exportPath: '/tmp/old/run-1/export.json',
  eventsLogPath: '/tmp/old/run-1/events.log',
  successRank: 4,
  finishCause: 'stop',
  exitCode: 0,
  durationMs: '45000',
  watchdogTriggered: false,
  ...over,
})

const v1Judge = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  verdict: 'ok',
  oldQuality: 6,
  newQuality: 8,
  explanation: 'new is cleaner',
  modelUsed: 'gpt-test',
  timestamp: '2025-01-01T00:05:00.000Z',
  ...over,
})

const v1PackCmdResult = (side: 'old' | 'new', over: Record<string, unknown> = {}): Record<string, unknown> => ({
  side,
  runIndex: 1,
  exitCode: 0,
  durationMs: '500',
  ...over,
})

const v1PackSetupReport = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'exercised',
  setupDeclared: true,
  checkDeclared: true,
  exerciseDeclared: true,
  setup: v1PackCmdResult('new', { runIndex: 0 }),
  checks: [v1PackCmdResult('new'), v1PackCmdResult('old', { exitCode: 1 })],
  exercises: [v1PackCmdResult('new', { runIndex: 1 }), v1PackCmdResult('new', { runIndex: 2 })],
  ...over,
})

const primary = {
  totalTokens: '10000', wallClockMs: '40000', costUsd: 0.03, stepCount: 10, toolCallCount: 20, successRank: 4, maxParallelism: 1,
}
const secondary = {
  inputTokens: '6000', outputTokens: '4000', reasoningTokens: '0', cacheReadTokens: '0',
  perTool: {}, reasoningTimeMs: '0', stepLatencyP50Ms: '100', stepLatencyP95Ms: '200', toolLatencyAvgMs: '50',
  finishCauseDistribution: { stop: 1 }, maxConsecutiveSameTool: 1,
}
const dist = (median: number) => ({ median, min: median, max: median, samples: [median, median, median, median] })
const stats = { totalTokens: dist(10000), wallClockMs: dist(40000), costUsd: dist(0.03), stepCount: dist(10), toolCallCount: dist(20), successRank: dist(4) }

const v1SideAggregates = (side: 'old' | 'new', over: Record<string, unknown> = {}): Record<string, unknown> => ({
  side,
  primary,
  secondary,
  stats,
  failedRuns: [],
  rawRunIds: [`session-${side}-1`],
  ...over,
})

const metricDelta = { absolute: -1000, percent: -10, significant: true, better: 'better' as const }
const primaryDeltas = {
  totalTokens: metricDelta, wallClockMs: metricDelta, costUsd: metricDelta, stepCount: metricDelta,
  toolCallCount: metricDelta, successRank: metricDelta, maxParallelism: metricDelta,
}

const v1TimelineEvent = (side: 'old' | 'new'): Record<string, unknown> => ({
  tStart: '0', tEnd: '1000', side, runIndex: 1, sessionId: `sess-${side}-1`, swimlaneDepth: 0, type: 'tool-call', tool: 'read',
})

const v1DiffResult = (side: 'old' | 'new'): Record<string, unknown> => ({
  side,
  runs: [{ runIndex: 1, fullPatch: 'diff --git a/x b/x\n', summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] }, noChanges: false }],
})

const v1Report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  manifest: v1Manifest(),
  metricsDiff: {
    old: v1SideAggregates('old'),
    new: v1SideAggregates('new'),
    deltas: primaryDeltas,
    bothFailed: false,
  },
  timeline: { old: [v1TimelineEvent('old')], new: [v1TimelineEvent('new')], mode: 'side-by-side' },
  diff: { old: v1DiffResult('old'), new: v1DiffResult('new') },
  judge: v1Judge(),
  summary: {
    headlineResult: 'new is faster',
    improvements: [metricDelta],
    regressions: [],
    neutral: [],
    failures: [],
  },
  packSetup: v1PackSetupReport(),
  ...over,
})

// ---------------------------------------------------------------------------
// readInitSideDefensively
// ---------------------------------------------------------------------------

describe('readInitSideDefensively', () => {
  it('reads a known value verbatim', () => {
    expect(readInitSideDefensively({ initSide: 'old' })).toBe('old')
    expect(readInitSideDefensively({ initSide: 'new' })).toBe('new')
  })
  it('defaults to both when absent, non-string, or unknown', () => {
    expect(readInitSideDefensively({})).toBe('both')
    expect(readInitSideDefensively({ initSide: 42 })).toBe('both')
    expect(readInitSideDefensively({ initSide: 'sideways' })).toBe('both')
  })
})

// ---------------------------------------------------------------------------
// mapManifestV1ToV2
// ---------------------------------------------------------------------------

describe('mapManifestV1ToV2', () => {
  it('produces a v2 manifest that parses against manifestSchema', () => {
    const v1 = manifestOf(v1Manifest())
    const v2 = mapManifestV1ToV2(v1)
    expect(manifestSchema.safeParse(v2).success).toBe(true)
  })

  it('schemaVersion 2 and migratedFromV1 disclosure', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest()))
    expect(v2.schemaVersion).toBe(2)
    expect(v2.flagDefaults['migratedFromV1']).toBe(true)
    expect(v2.flagDefaults['initSide']).toBe('both') // original flagDefaults carried over
  })

  it('synthesizes old/new variants, baseline old, parallel 2, pack registered on new only', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest()))
    expect(v2.baseline).toBe('old')
    expect(v2.parallel).toBe(2)
    expect(v2.variants.map((v) => v.name)).toEqual(['old', 'new'])
    expect(v2.variants[0]?.packs).toEqual([])
    expect(v2.variants[1]?.packs).toEqual(['graphify'])
    expect(v2.packs).toEqual([{ name: 'graphify', ref: 'https://example.com/graphify.git', type: 'skill' }])
  })

  it('packRef absent -> no packs, both variants pack-free', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest({ packRef: undefined, packType: undefined })))
    expect(v2.packs).toEqual([])
    expect(v2.variants[0]?.packs).toEqual([])
    expect(v2.variants[1]?.packs).toEqual([])
  })

  it('initSide old -> init lands only on the old variant', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest({ flagDefaults: { initSide: 'old' } })))
    expect(v2.variants[0]?.init).toBe('/graphify .')
    expect(v2.variants[1]?.init).toBeUndefined()
  })

  it('initSide new -> init lands only on the new variant', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest({ flagDefaults: { initSide: 'new' } })))
    expect(v2.variants[0]?.init).toBeUndefined()
    expect(v2.variants[1]?.init).toBe('/graphify .')
  })

  it('initSide absent from flagDefaults -> defaults both, init lands on both variants', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest({ flagDefaults: {} })))
    expect(v2.variants[0]?.init).toBe('/graphify .')
    expect(v2.variants[1]?.init).toBe('/graphify .')
  })

  it('packHint -> top-level hint; packExercise -> variants[new].exercise', () => {
    const v2 = mapManifestV1ToV2(manifestOf(v1Manifest({ packExercise: 'graphify run' })))
    expect(v2.hint).toBe('be careful')
    expect(v2.variants[1]?.exercise).toBe('graphify run')
    expect(v2.variants[0]?.exercise).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mapRunInputV1ToV2
// ---------------------------------------------------------------------------

describe('mapRunInputV1ToV2', () => {
  it('produces a v2 RunInput that parses against runInputSchema', () => {
    const v2 = mapRunInputV1ToV2(runInputOf(v1RunInput()))
    expect(runInputSchema.safeParse(v2).success).toBe(true)
  })

  it('pureBaseline -> variants[old].pure; allowBaselineTool -> variants[old].allowPacks', () => {
    const v2 = mapRunInputV1ToV2(
      runInputOf(v1RunInput({ pureBaseline: false, allowBaselineTool: true })),
    )
    expect(v2.variants[0]?.pure).toBe(false)
    expect(v2.variants[0]?.allowPacks).toEqual(['graphify'])
    expect(v2.variants[1]?.pure).toBe(false)
  })

  it('allowBaselineTool true but no pack declared -> no allowPacks (nothing to allow)', () => {
    const v2 = mapRunInputV1ToV2(
      runInputOf(v1RunInput({ packRef: undefined, packType: undefined, allowBaselineTool: true })),
    )
    expect(v2.variants[0]?.allowPacks).toBeUndefined()
  })

  it('drops the nine removed v1-only members and copies globals verbatim', () => {
    const v2 = mapRunInputV1ToV2(
      runInputOf(v1RunInput({ verify: 'npm test', model: 'anthropic/claude', judge: 'be harsh' })),
    )
    expect(v2.verify).toBe('npm test')
    expect(v2.model).toBe('anthropic/claude')
    expect(v2.judge).toBe('be harsh')
    expect((v2 as unknown as Record<string, unknown>)['packRef']).toBeUndefined()
    expect((v2 as unknown as Record<string, unknown>)['initSide']).toBeUndefined()
    expect((v2 as unknown as Record<string, unknown>)['pureBaseline']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// mapRunResultV1ToV2
// ---------------------------------------------------------------------------

describe('mapRunResultV1ToV2', () => {
  it('side -> variant, everything else verbatim, parses against runResultSchema', () => {
    const v1 = runResultOf(v1RunResult({ side: 'new', errorCode: 'E_RUN_CRASH' }))
    const v2 = mapRunResultV1ToV2(v1)
    expect(v2.variant).toBe('new')
    expect((v2 as unknown as Record<string, unknown>)['side']).toBeUndefined()
    expect(v2.successRank).toBe(4)
    expect(v2.errorCode).toBe('E_RUN_CRASH')
    expect(runResultSchema.safeParse(v2).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mapJudgeResultV1ToV2 — tie rule
// ---------------------------------------------------------------------------

describe('mapJudgeResultV1ToV2', () => {
  it('new strictly better -> ranking [new, old]', () => {
    const v2 = mapJudgeResultV1ToV2(judgeOf(v1Judge({ oldQuality: 4, newQuality: 8 })))
    expect(v2.ranking).toEqual(['new', 'old'])
    expect(v2.scores).toEqual([{ variant: 'old', quality: 4 }, { variant: 'new', quality: 8 }])
  })
  it('old strictly better -> ranking [old, new]', () => {
    const v2 = mapJudgeResultV1ToV2(judgeOf(v1Judge({ oldQuality: 8, newQuality: 4 })))
    expect(v2.ranking).toEqual(['old', 'new'])
  })
  it('tie -> ranking [new, old] (matches selectSide tie rule)', () => {
    const v2 = mapJudgeResultV1ToV2(judgeOf(v1Judge({ oldQuality: 5, newQuality: 5 })))
    expect(v2.ranking).toEqual(['new', 'old'])
  })
  it('parses against judgeResultSchema', () => {
    const v2 = mapJudgeResultV1ToV2(judgeOf(v1Judge()))
    expect(judgeResultSchema.safeParse(v2).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mapPackSetupReportV1ToV2
// ---------------------------------------------------------------------------

describe('mapPackSetupReportV1ToV2', () => {
  it('produces a v2 PrepReport that parses against prepReportSchema', () => {
    const v2 = mapPackSetupReportV1ToV2(packSetupOf(v1PackSetupReport()), 'graphify')
    expect(prepReportSchema.safeParse(v2).success).toBe(true)
  })
  it('setup/checks stamped with pack + variant from side; variants section is new-only', () => {
    const v2 = mapPackSetupReportV1ToV2(packSetupOf(v1PackSetupReport()), 'graphify')
    const pack = v2.packs[0]
    expect(pack?.pack).toBe('graphify')
    expect(pack?.setups).toEqual([{ variant: 'new', pack: 'graphify', runIndex: 0, exitCode: 0, durationMs: '500' }])
    expect(pack?.checks.map((c) => c.variant)).toEqual(['new', 'old'])
    expect(pack?.checks.every((c) => c.pack === 'graphify')).toBe(true)
    expect(v2.variants).toEqual([
      {
        variant: 'new',
        exerciseDeclared: true,
        exercises: [
          { variant: 'new', pack: 'graphify', runIndex: 1, exitCode: 0, durationMs: '500' },
          { variant: 'new', pack: 'graphify', runIndex: 2, exitCode: 0, durationMs: '500' },
        ],
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// mapReportV1ToV2 — full round trip
// ---------------------------------------------------------------------------

describe('mapReportV1ToV2', () => {
  it('produces a v2 Report that parses against reportSchema', () => {
    const v2 = mapReportV1ToV2(reportOf(v1Report()))
    const check = reportSchema.safeParse(v2)
    expect(check.success, check.success ? '' : JSON.stringify((check as { error?: unknown }).error)).toBe(true)
  })

  it('metrics.variants carries variant + baseline old; deltas has one entry for new', () => {
    const v2 = mapReportV1ToV2(reportOf(v1Report()))
    expect(v2.metrics.baseline).toBe('old')
    expect(v2.metrics.variants.map((v) => v.variant)).toEqual(['old', 'new'])
    expect(v2.metrics.deltas).toHaveLength(1)
    expect(v2.metrics.deltas[0]?.variant).toBe('new')
    expect(v2.metrics.allFailed).toBe(false)
  })

  it('timeline.lanes and diffs carry variant, side dropped', () => {
    const v2 = mapReportV1ToV2(reportOf(v1Report()))
    expect(v2.timeline.lanes.map((l) => l.variant)).toEqual(['old', 'new'])
    expect(v2.timeline.lanes[0]?.events[0]?.variant).toBe('old')
    expect(v2.diffs.map((d) => d.variant)).toEqual(['old', 'new'])
  })

  it('judge mapped with scores + ranking', () => {
    const v2 = mapReportV1ToV2(reportOf(v1Report()))
    expect(v2.judge?.scores).toEqual([{ variant: 'old', quality: 6 }, { variant: 'new', quality: 8 }])
    expect(v2.judge?.ranking).toEqual(['new', 'old'])
  })

  it('summary.perVariant has one new entry; failures stamped by membership, not position', () => {
    const oldFailure = { runIndex: 2, errorCode: 'E_RUN_CRASH' as const, errorMessage: 'boom', timestamp: '2025-01-01T00:01:00.000Z' }
    const newFailure = { runIndex: 1, errorCode: 'E_VERIFY_FAILED' as const, errorMessage: 'verify failed', timestamp: '2025-01-01T00:02:00.000Z' }
    const v1 = v1Report({
      metricsDiff: {
        old: v1SideAggregates('old', { failedRuns: [oldFailure] }),
        new: v1SideAggregates('new', { failedRuns: [newFailure] }),
        deltas: primaryDeltas,
        bothFailed: false,
      },
      summary: {
        headlineResult: 'mixed',
        improvements: [],
        regressions: [],
        neutral: [],
        // Concatenation order per src/cli/summary.ts: old then new.
        failures: [oldFailure, newFailure],
      },
    })
    const v2 = mapReportV1ToV2(reportOf(v1))
    expect(v2.summary.perVariant).toEqual([{ variant: 'new', improvements: [], regressions: [], neutral: [] }])
    expect(v2.summary.failures).toEqual([
      { ...oldFailure, variant: 'old' },
      { ...newFailure, variant: 'new' },
    ])
  })

  it('failures at the SAME runIndex on both sides are still attributed correctly by membership', () => {
    const oldFailure = { runIndex: 1, errorCode: 'E_RUN_CRASH' as const, errorMessage: 'old boom', timestamp: '2025-01-01T00:01:00.000Z' }
    const newFailure = { runIndex: 1, errorCode: 'E_RUN_CRASH' as const, errorMessage: 'new boom', timestamp: '2025-01-01T00:02:00.000Z' }
    const v1 = v1Report({
      metricsDiff: {
        old: v1SideAggregates('old', { failedRuns: [oldFailure] }),
        new: v1SideAggregates('new', { failedRuns: [newFailure] }),
        deltas: primaryDeltas,
        bothFailed: false,
      },
      summary: {
        headlineResult: 'mixed',
        improvements: [],
        regressions: [],
        neutral: [],
        failures: [oldFailure, newFailure],
      },
    })
    const v2 = mapReportV1ToV2(reportOf(v1))
    expect(v2.summary.failures.find((f) => f.errorMessage === 'old boom')?.variant).toBe('old')
    expect(v2.summary.failures.find((f) => f.errorMessage === 'new boom')?.variant).toBe('new')
  })

  it('the ORDINARY correlated-failure case (same runIndex, same errorCode, same manifest timestamp — v1 stamps every failedRun with manifest.timestamp, never a per-failure one) is still attributed correctly, disambiguated by errorMessage alone', () => {
    const sharedTimestamp = '2025-01-01T00:00:00.000Z'
    const oldFailure = { runIndex: 2, errorCode: 'E_RUN_TIMEOUT' as const, errorMessage: 'run old/2 failed: finishCause=error exitCode=-1 watchdog=true', timestamp: sharedTimestamp }
    const newFailure = { runIndex: 2, errorCode: 'E_RUN_TIMEOUT' as const, errorMessage: 'run new/2 failed: finishCause=error exitCode=-1 watchdog=true', timestamp: sharedTimestamp }
    const v1 = v1Report({
      metricsDiff: {
        old: v1SideAggregates('old', { failedRuns: [oldFailure] }),
        new: v1SideAggregates('new', { failedRuns: [newFailure] }),
        deltas: primaryDeltas,
        bothFailed: false,
      },
      summary: {
        headlineResult: 'both timed out',
        improvements: [],
        regressions: [],
        neutral: [],
        failures: [oldFailure, newFailure],
      },
    })
    const v2 = mapReportV1ToV2(reportOf(v1))
    expect(v2.summary.failures).toHaveLength(2)
    expect(v2.summary.failures.find((f) => f.errorMessage === oldFailure.errorMessage)?.variant).toBe('old')
    expect(v2.summary.failures.find((f) => f.errorMessage === newFailure.errorMessage)?.variant).toBe('new')
  })

  it('pairIncomplete true when either side has zero samples', () => {
    const emptyStats = { ...stats, totalTokens: { ...dist(0), samples: [] } }
    const v1 = v1Report({
      metricsDiff: {
        old: v1SideAggregates('old', { stats: emptyStats }),
        new: v1SideAggregates('new'),
        deltas: primaryDeltas,
        bothFailed: false,
      },
    })
    const v2 = mapReportV1ToV2(reportOf(v1))
    expect(v2.metrics.deltas[0]?.pairIncomplete).toBe(true)
  })

  it('prep mapped from packSetup when both packSetup and a pack are present', () => {
    const v2 = mapReportV1ToV2(reportOf(v1Report()))
    expect(v2.prep?.packs[0]?.pack).toBe('graphify')
  })

  it('no packRef -> no prep section even if packSetup somehow present', () => {
    const v2 = mapReportV1ToV2(
      reportOf(v1Report({ manifest: v1Manifest({ packRef: undefined, packType: undefined }) })),
    )
    expect(v2.prep).toBeUndefined()
  })

  it('install-drift contamination signals map to pack: "" (variant-level, never a real pack name); pack-activity signals keep the real pack name', () => {
    const driftSignal = { kind: 'install-drift' as const, detail: 'config drifted' }
    const activitySignal = { kind: 'skill-call' as const, detail: 'called graphify', runIndex: 1 }
    const v1 = v1Report({
      metricsDiff: {
        old: v1SideAggregates('old', { contaminationSignals: [driftSignal] }),
        new: v1SideAggregates('new', { contaminationSignals: [driftSignal, activitySignal] }),
        deltas: primaryDeltas,
        bothFailed: false,
      },
    })
    const v2 = mapReportV1ToV2(reportOf(v1))
    const oldSignals = v2.metrics.variants.find((v) => v.variant === 'old')?.contaminationSignals
    const newSignals = v2.metrics.variants.find((v) => v.variant === 'new')?.contaminationSignals
    expect(oldSignals).toEqual([{ kind: 'install-drift', detail: 'config drifted', pack: '' }])
    expect(newSignals).toEqual([
      { kind: 'install-drift', detail: 'config drifted', pack: '' },
      { kind: 'skill-call', detail: 'called graphify', runIndex: 1, pack: 'graphify' },
    ])
  })

  it('install-drift still maps to pack: "" even when there is no pack at all (packRef absent)', () => {
    const driftSignal = { kind: 'install-drift' as const, detail: 'config drifted' }
    const v1 = v1Report({
      manifest: v1Manifest({ packRef: undefined, packType: undefined }),
      metricsDiff: {
        old: v1SideAggregates('old', { contaminationSignals: [driftSignal] }),
        new: v1SideAggregates('new'),
        deltas: primaryDeltas,
        bothFailed: false,
      },
    })
    const v2 = mapReportV1ToV2(reportOf(v1))
    const oldSignals = v2.metrics.variants.find((v) => v.variant === 'old')?.contaminationSignals
    expect(oldSignals).toEqual([{ kind: 'install-drift', detail: 'config drifted', pack: '' }])
  })
})

// ---------------------------------------------------------------------------
// parse*Compat — v2 passthrough, v1 fallback + mapping, garbage -> undefined
// ---------------------------------------------------------------------------

describe('parseManifestCompat', () => {
  it('a v2 manifest passes through unchanged, schemaVersion 2', () => {
    const v2raw = mapManifestV1ToV2(manifestOf(v1Manifest()))
    const result = parseManifestCompat(v2raw)
    expect(result?.schemaVersion).toBe(2)
    expect(result?.manifest.runId).toBe('run-abc-001')
  })
  it('a v1 manifest is mapped, schemaVersion 1', () => {
    const result = parseManifestCompat(v1Manifest())
    expect(result?.schemaVersion).toBe(1)
    expect(result?.manifest.schemaVersion).toBe(2)
    expect(result?.manifest.baseline).toBe('old')
  })
  it('garbage input -> undefined', () => {
    expect(parseManifestCompat({ nonsense: true })).toBeUndefined()
    expect(parseManifestCompat(null)).toBeUndefined()
  })

  it('a BROKEN v2 manifest (schemaVersion present, one field corrupted) returns undefined — it must never be silently misdetected and remapped as v1', () => {
    const v2raw = mapManifestV1ToV2(manifestOf(v1Manifest())) as unknown as Record<string, unknown>
    const variants = v2raw['variants'] as readonly Record<string, unknown>[]
    // Corrupt variants[1] by dropping its required `packs` field entirely —
    // a v2 parse failure that has nothing to do with v1/v2 versioning.
    const { packs: _droppedPacks, ...brokenVariant } = variants[1] as { packs: unknown; [k: string]: unknown }
    const broken = { ...v2raw, variants: [variants[0], brokenVariant] }
    expect(manifestSchema.safeParse(broken).success).toBe(false) // sanity: this really is a broken v2 doc
    const result = parseManifestCompat(broken)
    expect(result).toBeUndefined()
  })
})

describe('parseRunInputCompat', () => {
  it('v2 passthrough and v1 fallback', () => {
    const v2 = parseRunInputCompat(mapRunInputV1ToV2(runInputOf(v1RunInput())))
    expect(v2?.schemaVersion).toBe(2)
    const v1 = parseRunInputCompat(v1RunInput())
    expect(v1?.schemaVersion).toBe(1)
    expect(v1?.runInput.variants.map((v) => v.name)).toEqual(['old', 'new'])
  })

  it('a BROKEN v2 RunInput (schemaVersion present, auth dropped) returns undefined, never a v1 remap', () => {
    const v2raw = mapRunInputV1ToV2(runInputOf(v1RunInput())) as unknown as Record<string, unknown>
    const { auth: _droppedAuth, ...broken } = v2raw as { auth: unknown; [k: string]: unknown }
    expect(runInputSchema.safeParse(broken).success).toBe(false)
    expect(parseRunInputCompat(broken)).toBeUndefined()
  })
})

describe('parseReportCompat', () => {
  it('v2 passthrough and v1 fallback', () => {
    const v2 = parseReportCompat(mapReportV1ToV2(reportOf(v1Report())))
    expect(v2?.schemaVersion).toBe(2)
    const v1 = parseReportCompat(v1Report())
    expect(v1?.schemaVersion).toBe(1)
    expect(v1?.report.schemaVersion).toBe(2)
  })

  it('a BROKEN v2 report (schemaVersion present, manifest dropped) returns undefined, never a v1 remap', () => {
    const v2raw = mapReportV1ToV2(reportOf(v1Report())) as unknown as Record<string, unknown>
    const { manifest: _droppedManifest, ...broken } = v2raw as { manifest: unknown; [k: string]: unknown }
    expect(reportSchema.safeParse(broken).success).toBe(false)
    expect(parseReportCompat(broken)).toBeUndefined()
  })
})

describe('parseRunResultCompat', () => {
  it('v2 passthrough and v1 fallback', () => {
    const v2 = parseRunResultCompat(mapRunResultV1ToV2(runResultOf(v1RunResult())))
    expect(v2?.variant).toBe('old')
    const v1 = parseRunResultCompat(v1RunResult({ side: 'new' }))
    expect(v1?.variant).toBe('new')
  })

  it('a BROKEN v2 RunResult (variant present, runIndex dropped) returns undefined, never a v1 remap', () => {
    const v2raw = mapRunResultV1ToV2(runResultOf(v1RunResult())) as unknown as Record<string, unknown>
    const { runIndex: _droppedRunIndex, ...broken } = v2raw as { runIndex: unknown; [k: string]: unknown }
    expect(runResultSchema.safeParse(broken).success).toBe(false)
    expect(parseRunResultCompat(broken)).toBeUndefined()
  })
})

describe('parseJudgeResultCompat', () => {
  it('v2 passthrough and v1 fallback', () => {
    const v2 = parseJudgeResultCompat(mapJudgeResultV1ToV2(judgeOf(v1Judge())))
    expect(v2?.scores.length).toBe(2)
    const v1 = parseJudgeResultCompat(v1Judge())
    expect(v1?.scores).toEqual([{ variant: 'old', quality: 6 }, { variant: 'new', quality: 8 }])
  })

  it('a BROKEN v2 JudgeResult (scores present, ranking dropped) returns undefined, never a v1 remap', () => {
    const v2raw = mapJudgeResultV1ToV2(judgeOf(v1Judge())) as unknown as Record<string, unknown>
    const { ranking: _droppedRanking, ...broken } = v2raw as { ranking: unknown; [k: string]: unknown }
    expect(judgeResultSchema.safeParse(broken).success).toBe(false)
    expect(parseJudgeResultCompat(broken)).toBeUndefined()
  })
})

describe('parsePrepReportCompat', () => {
  it('v2 passthrough and v1 fallback (needs a pack name)', () => {
    const v2 = parsePrepReportCompat(mapPackSetupReportV1ToV2(packSetupOf(v1PackSetupReport()), 'graphify'), undefined)
    expect(v2?.packs[0]?.pack).toBe('graphify')
    const v1 = parsePrepReportCompat(v1PackSetupReport(), 'graphify')
    expect(v1?.packs[0]?.pack).toBe('graphify')
  })
  it('v1 fallback with no pack name available -> undefined', () => {
    expect(parsePrepReportCompat(v1PackSetupReport(), undefined)).toBeUndefined()
  })

  it('a BROKEN v2 PrepReport (packs present, variants dropped) returns undefined, never a v1 remap even when a pack name is available', () => {
    const v2raw = mapPackSetupReportV1ToV2(packSetupOf(v1PackSetupReport()), 'graphify') as unknown as Record<string, unknown>
    const { variants: _droppedVariants, ...broken } = v2raw as { variants: unknown; [k: string]: unknown }
    expect(prepReportSchema.safeParse(broken).success).toBe(false)
    expect(parsePrepReportCompat(broken, 'graphify')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Type-cast helpers — the v1 fixtures above are hand-built plain objects
// (mirroring the real on-disk shape); these just narrow them to the mapper
// functions' parameter types without re-validating (the parse*Compat tests
// above already prove the schemas accept these shapes).
// ---------------------------------------------------------------------------

function manifestOf(x: Record<string, unknown>): Parameters<typeof mapManifestV1ToV2>[0] {
  return x as unknown as Parameters<typeof mapManifestV1ToV2>[0]
}
function runInputOf(x: Record<string, unknown>): Parameters<typeof mapRunInputV1ToV2>[0] {
  return x as unknown as Parameters<typeof mapRunInputV1ToV2>[0]
}
function runResultOf(x: Record<string, unknown>): Parameters<typeof mapRunResultV1ToV2>[0] {
  return x as unknown as Parameters<typeof mapRunResultV1ToV2>[0]
}
function judgeOf(x: Record<string, unknown>): Parameters<typeof mapJudgeResultV1ToV2>[0] {
  return x as unknown as Parameters<typeof mapJudgeResultV1ToV2>[0]
}
function packSetupOf(x: Record<string, unknown>): Parameters<typeof mapPackSetupReportV1ToV2>[0] {
  return x as unknown as Parameters<typeof mapPackSetupReportV1ToV2>[0]
}
function reportOf(x: Record<string, unknown>): Parameters<typeof mapReportV1ToV2>[0] {
  return x as unknown as Parameters<typeof mapReportV1ToV2>[0]
}
