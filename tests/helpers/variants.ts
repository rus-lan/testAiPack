// Canonical v2 fixture builders shared by every package's tests (D18 / WP1,
// see .research/n-way-variants/04-work-packages.md §5.2). Two canonical
// fixture sets: `shimPair()` (variants old/new, backward-compat with the
// legacy two-sided CLI) and `threeVariants()` (base + two pack variants,
// N-way behavior). Every builder here must produce objects that parse
// against the generated v2 zod schemas — proven by variants.test.ts.

import path from 'node:path'
import type {
  AggregateStats,
  AuthWhitelist,
  DiffResult,
  JudgeResult,
  Manifest,
  MetricDelta,
  MetricDistribution,
  MetricsReport,
  PackSpec,
  PrimaryDeltas,
  PrimaryMetrics,
  Report,
  ReportSummary,
  RunInput,
  RunResult,
  SecondaryMetrics,
  Timeline,
  TimeoutConfig,
  VariantAggregates,
  VariantDelta,
  VariantSpec,
  VariantSummary,
  VariantTree,
  WorkspaceTree,
} from '@generated/types'

const defaultAuth: AuthWhitelist = {
  opencode: false,
  npmrc: false,
  anthropic: false,
  openai: false,
  gemini: false,
  aws: false,
  ssh: false,
  git: false,
}

const defaultTimeouts: TimeoutConfig = {
  preflightSeconds: 60,
  runSeconds: 600,
  verifySeconds: 300,
  installSeconds: 300,
  watchdogSeconds: 1200,
}

const baseRunInput = (
  variants: VariantSpec[],
  packs: PackSpec[],
  baseline: string,
): RunInput => ({
  schemaVersion: 2,
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  parallel: 2,
  baseline,
  packs,
  variants,
  isolation: 'home',
  auth: defaultAuth,
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  protectGit: false,
  collapseRepeats: true,
  timelineMode: 'side-by-side',
  timeouts: defaultTimeouts,
  workspacePath: './.testaipack',
  logLevel: 'info',
})

/** Legacy old/new shim pair, one pack declared on `new` — validates backward-compat desugaring. */
export const shimPair = (): { runInput: RunInput; variants: VariantSpec[] } => {
  const packs: PackSpec[] = [{ name: 'demo-pack', ref: 'https://example.com/demo-pack.git' }]
  const variants: VariantSpec[] = [
    { name: 'old', packs: [], pure: true },
    { name: 'new', packs: ['demo-pack'], pure: false },
  ]
  return { runInput: baseRunInput(variants, packs, 'old'), variants }
}

/** base + graphify + astgrep, two packs — validates N-way behavior. */
export const threeVariants = (): { runInput: RunInput; variants: VariantSpec[] } => {
  const packs: PackSpec[] = [
    { name: 'graphify', ref: 'https://example.com/graphify.git' },
    { name: 'astgrep', ref: 'https://example.com/astgrep.git' },
  ]
  const variants: VariantSpec[] = [
    { name: 'base', packs: [], pure: true },
    { name: 'graphify', packs: ['graphify'], pure: false },
    { name: 'astgrep', packs: ['astgrep'], pure: false },
  ]
  return { runInput: baseRunInput(variants, packs, 'base'), variants }
}

const defaultSecondaryMetrics: SecondaryMetrics = {
  inputTokens: '6000',
  outputTokens: '4000',
  reasoningTokens: '1500',
  cacheReadTokens: '845',
  perTool: {
    read: { count: 12, errorRate: 0, avgDurationMs: '120' },
    write: { count: 8, errorRate: 0.125, avgDurationMs: '340' },
  },
  reasoningTimeMs: '6000',
  stepLatencyP50Ms: '2000',
  stepLatencyP95Ms: '5000',
  toolLatencyAvgMs: '200',
  finishCauseDistribution: { stop: 10, 'tool-calls': 2 },
  maxConsecutiveSameTool: 3,
}

// ---------------------------------------------------------------------------
// Per-variant primary-metric samples + honest median/IQR/delta math, mirrored
// from src/metrics/stats.ts, src/metrics/significance.ts and
// src/metrics/aggregate.ts (aggregatePrimary/computeDelta) so the fixture's
// aggregates and its deltas are provably consistent with each other — a
// package recomputing computeVariantDelta(base, variant) over these
// aggregates must get back these same deltas (.research/n-way-variants/
// 03-hard-problems.md §1: significant = |Δ| > 1.5×IQR(baseline)).
// ---------------------------------------------------------------------------

const sortAsc = (values: readonly number[]): number[] => [...values].sort((a, b) => a - b)

const medianOf = (values: readonly number[]): number => {
  const sorted = sortAsc(values)
  const n = sorted.length
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0)
}

const percentileOf = (values: readonly number[], p: number): number => {
  const sorted = sortAsc(values)
  const n = sorted.length
  if (n === 0) return 0
  if (n === 1) return sorted[0] ?? 0
  const rank = (p / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  const loV = sorted[lo] ?? 0
  const hiV = sorted[hi] ?? 0
  return lo === hi ? loV : loV + (hiV - loV) * (rank - lo)
}

/** Undefined below 4 samples — mirrors src/metrics/stats.ts interquartileRange. */
const iqrOf = (values: readonly number[]): number | undefined =>
  values.length < 4 ? undefined : percentileOf(values, 75) - percentileOf(values, 25)

const distOf = (samples: readonly number[]): MetricDistribution => {
  const iqr = iqrOf(samples)
  return {
    median: medianOf(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
    samples: [...samples],
    ...(iqr === undefined ? {} : { iqr }),
  }
}

interface PrimarySampleSet {
  readonly totalTokens: readonly number[]
  readonly wallClockMs: readonly number[]
  readonly costUsd: readonly number[]
  readonly stepCount: readonly number[]
  readonly toolCallCount: readonly number[]
  readonly successRank: readonly number[]
  readonly maxParallelism: number
}

// Arithmetic-progression sample sets (4 runs each) so median/IQR are exact
// and reviewable by hand: for [a, a+d, a+2d, a+3d], median = a + 1.5d and
// IQR = 1.5d, so a delta is "significant" exactly when |Δ| > 2.25d.
const baseSamples: PrimarySampleSet = {
  totalTokens: [11_800, 12_000, 12_200, 12_400], // median 12100, IQR 300
  wallClockMs: [40_000, 43_000, 46_000, 49_000], // median 44500, IQR 4500
  costUsd: [0.03, 0.033, 0.036, 0.039], // median 0.0345, IQR 0.0045
  stepCount: [9, 11, 13, 15], // median 12, IQR 3
  toolCallCount: [22, 24, 26, 28], // median 25, IQR 3
  successRank: [3, 4, 4, 4], // median 4 (mostly clean stops)
  maxParallelism: 2,
}

// totalTokens Δ = -1200 (> 2.25*300=675 -> significant, better);
// stepCount Δ = -6 (> 2.25*2=4.5 -> significant, better); rest in noise.
const graphifySamples: PrimarySampleSet = {
  totalTokens: [10_600, 10_800, 11_000, 11_200], // median 10900
  wallClockMs: [37_000, 40_000, 43_000, 46_000], // median 41500 (Δ -3000, ns)
  costUsd: [0.027, 0.03, 0.033, 0.036], // median 0.0315 (Δ -0.003, ns)
  stepCount: [3, 5, 7, 9], // median 6
  toolCallCount: [24, 26, 28, 30], // median 27 (Δ +2, ns worse)
  successRank: [4, 4, 4, 4], // median 4 (Δ 0, neutral)
  maxParallelism: 2,
}

// Every metric moves less than 2.25*d vs base -> "no significant differences",
// 3 better / 1 worse (totalTokens/wallClockMs/costUsd better, stepCount worse).
const astgrepSamples: PrimarySampleSet = {
  totalTokens: [11_600, 11_800, 12_000, 12_200], // median 11900 (Δ -200, ns better)
  wallClockMs: [38_500, 41_500, 44_500, 47_500], // median 43000 (Δ -1500, ns better)
  costUsd: [0.028, 0.031, 0.034, 0.037], // median 0.0325 (Δ -0.002, ns better)
  stepCount: [12, 14, 16, 18], // median 15 (Δ +3, ns worse)
  toolCallCount: [22, 24, 26, 28], // median 25 (Δ 0, neutral)
  successRank: [3, 4, 4, 4], // median 4 (Δ 0, neutral)
  maxParallelism: 3,
}

const primarySamplesFor = (name: string): PrimarySampleSet => {
  if (name === 'graphify') return graphifySamples
  if (name === 'astgrep') return astgrepSamples
  return baseSamples
}

const primaryFromSamples = (s: PrimarySampleSet): PrimaryMetrics => ({
  totalTokens: String(Math.round(medianOf(s.totalTokens))),
  wallClockMs: String(Math.round(medianOf(s.wallClockMs))),
  costUsd: medianOf(s.costUsd),
  stepCount: Math.round(medianOf(s.stepCount)),
  toolCallCount: Math.round(medianOf(s.toolCallCount)),
  successRank: Math.round(medianOf(s.successRank)),
  maxParallelism: s.maxParallelism,
})

const statsFromSamples = (s: PrimarySampleSet): AggregateStats => ({
  totalTokens: distOf(s.totalTokens),
  wallClockMs: distOf(s.wallClockMs),
  costUsd: distOf(s.costUsd),
  stepCount: distOf(s.stepCount),
  toolCallCount: distOf(s.toolCallCount),
  successRank: distOf(s.successRank),
})

export const makeVariantAggregates = (
  name: string,
  over: Partial<VariantAggregates> = {},
): VariantAggregates => {
  const samples = primarySamplesFor(name)
  return {
    variant: name,
    primary: primaryFromSamples(samples),
    secondary: defaultSecondaryMetrics,
    stats: statsFromSamples(samples),
    failedRuns: [],
    rawRunIds: [`session-${name}-1`],
    ...over,
  }
}

const toNum = (s: string): number => Number(s)

type DeltaDirection = 'lower-is-better' | 'higher-is-better' | 'context-dependent'

/** No meaningful percent for a 0 -> non-zero change; mirrors percentDelta in src/metrics/aggregate.ts. */
const percentDeltaOf = (oldValue: number, absolute: number): number | undefined => {
  if (oldValue === 0) return absolute === 0 ? 0 : undefined
  return (absolute / oldValue) * 100
}

/** Mirrors isSignificant in src/metrics/significance.ts. */
const isSignificantOf = (absolute: number, iqr: number | undefined): boolean =>
  iqr !== undefined && Math.abs(absolute) > 1.5 * iqr

/** Mirrors betterOf in src/metrics/aggregate.ts. */
const betterOfDelta = (absolute: number, direction: DeltaDirection): MetricDelta['better'] => {
  if (direction === 'context-dependent') return 'context-dependent'
  if (absolute === 0) return 'neutral'
  if (direction === 'lower-is-better') return absolute < 0 ? 'better' : 'worse'
  return absolute > 0 ? 'better' : 'worse'
}

const deltaOf = (
  oldValue: number,
  newValue: number,
  iqr: number | undefined,
  direction: DeltaDirection,
): MetricDelta => {
  const absolute = newValue - oldValue
  const percent = percentDeltaOf(oldValue, absolute)
  return {
    absolute,
    ...(percent === undefined ? {} : { percent }),
    significant: isSignificantOf(absolute, iqr),
    better: betterOfDelta(absolute, direction),
  }
}

/** Honest PrimaryDeltas: base vs variant, significance judged against the baseline's own IQR (D2/D8, §1.2). */
const primaryDeltasFor = (base: VariantAggregates, variant: VariantAggregates): PrimaryDeltas => ({
  totalTokens: deltaOf(
    toNum(base.primary.totalTokens),
    toNum(variant.primary.totalTokens),
    base.stats.totalTokens.iqr,
    'lower-is-better',
  ),
  wallClockMs: deltaOf(
    toNum(base.primary.wallClockMs),
    toNum(variant.primary.wallClockMs),
    base.stats.wallClockMs.iqr,
    'lower-is-better',
  ),
  costUsd: deltaOf(base.primary.costUsd, variant.primary.costUsd, base.stats.costUsd.iqr, 'lower-is-better'),
  stepCount: deltaOf(
    base.primary.stepCount,
    variant.primary.stepCount,
    base.stats.stepCount.iqr,
    'lower-is-better',
  ),
  toolCallCount: deltaOf(
    base.primary.toolCallCount,
    variant.primary.toolCallCount,
    base.stats.toolCallCount.iqr,
    'lower-is-better',
  ),
  successRank: deltaOf(
    base.primary.successRank,
    variant.primary.successRank,
    base.stats.successRank.iqr,
    'higher-is-better',
  ),
  // No IQR concept for maxParallelism (whole-run, not a splittable metric) —
  // always non-significant, same as computeDelta's hardcoded `undefined`.
  maxParallelism: deltaOf(base.primary.maxParallelism, variant.primary.maxParallelism, undefined, 'context-dependent'),
})

/**
 * Reused by buildSummary below for a simple, illustrative improvements/
 * regressions/neutral split — intentionally NOT the same numbers as
 * makeMetricsReport's honest per-variant deltas (that table is keyed by
 * (base, graphify) and (base, astgrep) separately; this one is a single
 * shared bucket for the headline text).
 */
const defaultPrimaryDeltas: PrimaryDeltas = {
  totalTokens: { absolute: -1358, percent: -11.0, significant: true, better: 'better' },
  wallClockMs: { absolute: 7000, percent: 15.6, significant: false, better: 'worse' },
  costUsd: { absolute: -0.004, percent: -8.9, significant: false, better: 'better' },
  stepCount: { absolute: 2, percent: 16.7, significant: false, better: 'worse' },
  toolCallCount: { absolute: 5, percent: 20.0, significant: true, better: 'worse' },
  successRank: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
  maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
}

/** 3 variants (base/graphify/astgrep), deltas vs base — honestly recomputed from their aggregates. */
export const makeMetricsReport = (over: Partial<MetricsReport> = {}): MetricsReport => {
  const base = makeVariantAggregates('base')
  const graphify = makeVariantAggregates('graphify')
  const astgrep = makeVariantAggregates('astgrep')
  const variants: VariantAggregates[] = [base, graphify, astgrep]
  const deltas: VariantDelta[] = [
    { variant: 'graphify', deltas: primaryDeltasFor(base, graphify), pairIncomplete: false },
    { variant: 'astgrep', deltas: primaryDeltasFor(base, astgrep), pairIncomplete: false },
  ]
  return {
    baseline: 'base',
    variants,
    deltas,
    allFailed: false,
    ...over,
  }
}

const buildManifest = (): Manifest => ({
  schemaVersion: 2,
  runId: 'run-abc-001',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  parallel: 2,
  baseline: 'base',
  packs: [
    { name: 'graphify', ref: 'https://example.com/graphify.git' },
    { name: 'astgrep', ref: 'https://example.com/astgrep.git' },
  ],
  variants: [
    { name: 'base', packs: [] },
    { name: 'graphify', packs: ['graphify'] },
    { name: 'astgrep', packs: ['astgrep'] },
  ],
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
})

const buildTimeline = (): Timeline => ({
  lanes: [
    {
      variant: 'base',
      events: [
        {
          tStart: '0',
          tEnd: '3200',
          variant: 'base',
          runIndex: 1,
          sessionId: 'session-base-1',
          swimlaneDepth: 0,
          type: 'tool-call',
          tool: 'read',
          status: 'completed',
        },
      ],
    },
    {
      variant: 'graphify',
      events: [
        {
          tStart: '0',
          tEnd: '6000',
          variant: 'graphify',
          runIndex: 1,
          sessionId: 'session-graphify-1',
          swimlaneDepth: 0,
          type: 'tool-call',
          tool: 'write',
          status: 'completed',
        },
      ],
    },
    {
      variant: 'astgrep',
      events: [
        {
          tStart: '0',
          tEnd: '4800',
          variant: 'astgrep',
          runIndex: 1,
          sessionId: 'session-astgrep-1',
          swimlaneDepth: 0,
          type: 'reasoning',
        },
      ],
    },
  ],
  mode: 'side-by-side',
})

const buildDiffResult = (variant: string): DiffResult => ({
  variant,
  runs: [
    {
      runIndex: 1,
      fullPatch: 'diff --git a/file.txt b/file.txt\n@@ -1,1 +1,2 @@\n-old\n+new\n',
      summary: {
        filesChanged: 2,
        additions: 8,
        deletions: 3,
        perFile: [
          { path: 'file.txt', additions: 5, deletions: 1 },
          { path: 'other.txt', additions: 3, deletions: 2 },
        ],
      },
      noChanges: false,
    },
  ],
})

const buildJudge = (): JudgeResult => ({
  verdict: 'ok',
  scores: [
    { variant: 'base', quality: 6 },
    { variant: 'graphify', quality: 8 },
    { variant: 'astgrep', quality: 7 },
  ],
  ranking: ['graphify', 'astgrep', 'base'],
  explanation: 'graphify produces the cleanest output of the three variants.',
  modelUsed: 'gpt-test',
  timestamp: '2025-01-01T00:05:00.000Z',
})

const buildSummary = (): ReportSummary => {
  const deltas = defaultPrimaryDeltas
  const improvements: MetricDelta[] = [deltas.totalTokens, deltas.costUsd]
  const regressions: MetricDelta[] = [deltas.wallClockMs, deltas.stepCount, deltas.toolCallCount]
  const neutral: MetricDelta[] = [deltas.successRank, deltas.maxParallelism]
  const perVariant: VariantSummary[] = [
    { variant: 'graphify', improvements, regressions, neutral },
    { variant: 'astgrep', improvements, regressions, neutral },
  ]
  return {
    headlineResult:
      'graphify improved token efficiency by 11.0% (significant) but regressed wall-clock (+15.6%, in noise).',
    perVariant,
    failures: [],
  }
}

export const makeReportV2 = (over: Partial<Report> = {}): Report => ({
  schemaVersion: 2,
  manifest: buildManifest(),
  metrics: makeMetricsReport(),
  timeline: buildTimeline(),
  diffs: [buildDiffResult('base'), buildDiffResult('graphify'), buildDiffResult('astgrep')],
  judge: buildJudge(),
  summary: buildSummary(),
  ...over,
})

export const makeRunResult = (
  variant: string,
  runIndex: number,
  over: Partial<RunResult> = {},
): RunResult => ({
  variant,
  runIndex,
  exportPath: `/tmp/${variant}/run-${String(runIndex)}/export.json`,
  eventsLogPath: `/tmp/${variant}/run-${String(runIndex)}/events.log`,
  successRank: 4,
  finishCause: 'stop',
  exitCode: 0,
  durationMs: '45000',
  watchdogTriggered: false,
  ...over,
})

export const makeWorkspaceTree = (root: string, runs: number, names: string[]): WorkspaceTree => {
  const range = Array.from({ length: runs }, (_, i) => i + 1)
  const variantTrees: VariantTree[] = names.map((name) => ({
    name,
    apps: range.map((n) => path.join(root, 'apps', name, `run-${String(n)}`)),
    homes: range.map((n) => path.join(root, 'home', name, `run-${String(n)}`)),
    gitDirs: range.map((n) => path.join(root, 'gitdirs', name, `run-${String(n)}`)),
  }))
  return {
    root,
    appsSource: path.join(root, 'apps', 'source'),
    pack: path.join(root, 'pack'),
    variantTrees,
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'results', 'raw'),
    diff: path.join(root, 'results', 'diff'),
  }
}
