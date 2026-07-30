import path from 'node:path'
import type {
  AggregateStats,
  DiffResult,
  JudgeResult,
  Manifest,
  MetricDelta,
  MetricsDiff,
  PrimaryDeltas,
  PrimaryMetrics,
  Report,
  ReportRenderInput,
  ReportSummary,
  RunInput,
  SecondaryMetrics,
  SideAggregates,
  Timeline,
  WorkspaceTree,
} from '@generated/types'
import { makeTempDir } from './setup.js'

export const makeRunInput = (over: Partial<RunInput> = {}): RunInput => ({
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  isolation: 'home',
  auth: {
    opencode: false,
    npmrc: false,
    anthropic: false,
    openai: false,
    gemini: false,
    aws: false,
    ssh: false,
    git: false,
  },
  pureBaseline: true,
  protectGit: false,
  initSide: 'both',
  preflightEnabled: true,
  formats: ['md'],
  outputPath: './results',
  diffHtml: false,
  collapseRepeats: true,
  timelineMode: 'side-by-side',
  timeouts: {
    preflightSeconds: 60,
    runSeconds: 600,
    verifySeconds: 300,
    installSeconds: 300,
    watchdogSeconds: 1200,
  },
  workspacePath: './.testaipack',
  logLevel: 'info',
  ...over,
})

export const makeManifest = (over: Partial<Manifest> = {}): Manifest => ({
  runId: 'run-abc-001',
  timestamp: '2025-01-01T00:00:00.000Z',
  repoUrl: 'https://example.com/repo.git',
  prompt: 'do the thing',
  runs: 1,
  isolation: 'home',
  opencodeVersion: '0.5.0',
  flagDefaults: {},
  ...over,
})

const defaultPrimary: PrimaryMetrics = {
  totalTokens: '12345',
  wallClockMs: '45000',
  costUsd: 0.045,
  stepCount: 12,
  toolCallCount: 25,
  successRank: 4,
  maxParallelism: 1,
}

const newPrimary: PrimaryMetrics = {
  totalTokens: '10987',
  wallClockMs: '52000',
  costUsd: 0.041,
  stepCount: 14,
  toolCallCount: 30,
  successRank: 4,
  maxParallelism: 1,
}

const defaultDeltas: PrimaryDeltas = {
  totalTokens: { absolute: -1358, percent: -11.0, significant: true, better: 'better' },
  wallClockMs: { absolute: 7000, percent: 15.6, significant: false, better: 'worse' },
  costUsd: { absolute: -0.004, percent: -8.9, significant: false, better: 'better' },
  stepCount: { absolute: 2, percent: 16.7, significant: false, better: 'worse' },
  toolCallCount: { absolute: 5, percent: 20.0, significant: true, better: 'worse' },
  successRank: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
  maxParallelism: { absolute: 0, percent: 0, significant: false, better: 'neutral' },
}

const defaultSecondary: SecondaryMetrics = {
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

const statFor = (median: number): AggregateStats => ({
  totalTokens: { median, min: median, max: median, samples: [median] },
  wallClockMs: { median, min: median, max: median, samples: [median] },
  costUsd: { median, min: median, max: median, samples: [median] },
  stepCount: { median, min: median, max: median, samples: [median] },
  toolCallCount: { median, min: median, max: median, samples: [median] },
  successRank: { median, min: median, max: median, samples: [median] },
})

export const makeSideAggregates = (
  side: 'old' | 'new',
  over: Partial<SideAggregates> = {},
): SideAggregates => ({
  side,
  primary: side === 'old' ? defaultPrimary : newPrimary,
  secondary: defaultSecondary,
  stats: statFor(100),
  failedRuns: [],
  rawRunIds: [`session-${side}-1`],
  ...over,
})

export const makeMetricsDiff = (over: Partial<MetricsDiff> = {}): MetricsDiff => ({
  old: makeSideAggregates('old'),
  new: makeSideAggregates('new'),
  deltas: defaultDeltas,
  bothFailed: false,
  ...over,
})

export const makeTimeline = (over: Partial<Timeline> = {}): Timeline => ({
  old: [
    {
      tStart: '0',
      tEnd: '3200',
      side: 'old',
      runIndex: 1,
      sessionId: 'session-old-1',
      swimlaneDepth: 0,
      type: 'tool-call',
      tool: 'read',
      status: 'completed',
    },
    {
      tStart: '3200',
      tEnd: '4500',
      side: 'old',
      runIndex: 1,
      sessionId: 'session-old-1',
      swimlaneDepth: 0,
      type: 'reasoning',
    },
  ],
  new: [
    {
      tStart: '0',
      tEnd: '6000',
      side: 'new',
      runIndex: 1,
      sessionId: 'session-new-1',
      swimlaneDepth: 0,
      type: 'tool-call',
      tool: 'write',
      status: 'completed',
    },
  ],
  mode: 'side-by-side',
  ...over,
})

export const makeDiffResult = (side: 'old' | 'new', over: Partial<DiffResult> = {}): DiffResult => ({
  side,
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
  ...over,
})

export const makeJudge = (over: Partial<JudgeResult> = {}): JudgeResult => ({
  verdict: 'ok',
  oldQuality: 7,
  newQuality: 8,
  explanation: 'New side produces cleaner output.',
  modelUsed: 'gpt-test',
  timestamp: '2025-01-01T00:05:00.000Z',
  ...over,
})

export const makeSummary = (over: Partial<ReportSummary> = {}): ReportSummary => {
  const deltas = defaultDeltas
  const improvements: MetricDelta[] = [deltas.totalTokens, deltas.costUsd]
  const regressions: MetricDelta[] = [deltas.wallClockMs, deltas.stepCount, deltas.toolCallCount]
  const neutral: MetricDelta[] = [deltas.successRank, deltas.maxParallelism]
  return {
    headlineResult:
      'Pack improved token efficiency by 11.0% (significant) but regressed wall-clock (+15.6%, in noise).',
    improvements,
    regressions,
    neutral,
    failures: [],
    ...over,
  }
}

export const makeReport = (over: Partial<Report> = {}): Report => ({
  manifest: makeManifest(),
  metricsDiff: makeMetricsDiff(),
  timeline: makeTimeline(),
  diff: { old: makeDiffResult('old'), new: makeDiffResult('new') },
  summary: makeSummary(),
  ...over,
})

export interface ReportFixtureOpts {
  /** `null` omits judge; default builds one. */
  readonly judge?: JudgeResult | null
  readonly runInput?: RunInput
  readonly metricsDiff?: MetricsDiff
  readonly summary?: ReportSummary
}

export const makeReportRenderInput = (opts: ReportFixtureOpts = {}): ReportRenderInput => {
  const judge: JudgeResult | null =
    opts.judge === undefined ? makeJudge() : opts.judge
  return {
    runInput: opts.runInput ?? makeRunInput({ formats: ['md'] }),
    manifest: makeManifest(),
    metricsDiff: opts.metricsDiff ?? makeMetricsDiff(),
    timeline: makeTimeline(),
    diff: { old: makeDiffResult('old'), new: makeDiffResult('new') },
    summary: opts.summary ?? makeSummary(),
    ...(judge === null ? {} : { judge }),
  }
}

export const makeWorkspace = (runs = 1): WorkspaceTree => {
  const root = makeTempDir()
  const range = Array.from({ length: runs }, (_, i) => i + 1)
  return {
    root,
    appsSource: path.join(root, 'apps', 'source'),
    appsOld: range.map((n) => path.join(root, 'apps', 'oldVersion', `run-${String(n)}`)),
    appsNew: range.map((n) => path.join(root, 'apps', 'newVersion', `run-${String(n)}`)),
    pack: path.join(root, 'pack'),
    homeOld: range.map((n) => path.join(root, 'home', 'old', `run-${String(n)}`)),
    homeNew: range.map((n) => path.join(root, 'home', 'new', `run-${String(n)}`)),
    gitDirsOld: range.map((n) => path.join(root, 'gitdirs', 'old', `run-${String(n)}`)),
    gitDirsNew: range.map((n) => path.join(root, 'gitdirs', 'new', `run-${String(n)}`)),
    config: path.join(root, 'config'),
    results: path.join(root, 'results'),
    raw: path.join(root, 'results', 'raw'),
    diff: path.join(root, 'results', 'diff'),
  }
}
