/**
 * Hand-frozen snapshot of the v1 wire schemas; never regenerated (decision D18).
 *
 * Copied by hand from the pre-change `src/generated/schemas.ts` (v0.6.5,
 * before the n-way variants contract barrier), restricted to the models the
 * legacy loader needs plus their transitive dependencies. Every exported
 * const carries a `V1` suffix so it can never be confused with (or silently
 * shadow) the regenerated v2 schemas in `src/generated/schemas.ts`.
 *
 * Do not edit to track contract changes — v1 artifacts on disk are fixed
 * forever; this file's job is to keep parsing them exactly as it always has.
 */

import { z } from 'zod'

export const sideV1Schema = z.enum(['old', 'new'])

export const recordUnknownV1Schema = z.record(z.string(), z.unknown())

export const packTypeV1Schema = z.enum(['skill', 'plugin', 'agent', 'command', 'mcp', 'all'])

export const initSideV1Schema = z.enum(['both', 'new', 'old'])

export const isolationModeV1Schema = z.enum(['home', 'docker'])

export const authWhitelistV1Schema = z.object({
  opencode: z.boolean(),
  npmrc: z.boolean(),
  anthropic: z.boolean(),
  openai: z.boolean(),
  gemini: z.boolean(),
  aws: z.boolean(),
  ssh: z.boolean(),
  git: z.boolean(),
})

export const outputFormatV1Schema = z.enum(['md', 'html', 'json', 'yaml'])

export const timelineModeV1Schema = z.enum(['side-by-side', 'tree-diff', 'merged'])

export const timeoutConfigV1Schema = z.object({
  preflightSeconds: z.number().int(),
  runSeconds: z.number().int(),
  verifySeconds: z.number().int(),
  installSeconds: z.number().int(),
  watchdogSeconds: z.number().int(),
  totalSeconds: z.number().int().optional(),
})

export const logLevelV1Schema = z.enum(['debug', 'info', 'warn', 'error'])

export const runInputV1Schema = z.object({
  repoUrl: z.string(),
  packRef: z.string().optional(),
  packType: packTypeV1Schema.optional(),
  prompt: z.string(),
  promptFiles: z.array(z.string()).optional(),
  init: z.string().optional(),
  initFiles: z.array(z.string()).optional(),
  initSide: initSideV1Schema,
  verify: z.string().optional(),
  runs: z.number().int(),
  isolation: isolationModeV1Schema,
  dockerNetwork: z.string().optional(),
  opencodeVersion: z.string().optional(),
  auth: authWhitelistV1Schema,
  pureBaseline: z.boolean(),
  judge: z.string().optional(),
  judgeFiles: z.array(z.string()).optional(),
  preflightEnabled: z.boolean(),
  preflightModel: z.string().optional(),
  model: z.string().optional(),
  formats: z.array(outputFormatV1Schema),
  outputPath: z.string(),
  diffHtml: z.boolean(),
  protectGit: z.boolean(),
  collapseRepeats: z.boolean(),
  timelineMode: timelineModeV1Schema,
  timeouts: timeoutConfigV1Schema,
  workspacePath: z.string(),
  logLevel: logLevelV1Schema,
  pricingPath: z.string().optional(),
  packSetup: z.string().optional(),
  packCheck: z.string().optional(),
  packExercise: z.string().optional(),
  allowBaselineTool: z.boolean().optional(),
  packHint: z.string().optional(),
})

export const manifestV1Schema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  repoUrl: z.string(),
  packRef: z.string().optional(),
  packType: packTypeV1Schema.optional(),
  prompt: z.string(),
  init: z.string().optional(),
  verify: z.string().optional(),
  runs: z.number().int(),
  isolation: isolationModeV1Schema,
  opencodeVersion: z.string(),
  flagDefaults: recordUnknownV1Schema,
  packSetup: z.string().optional(),
  packCheck: z.string().optional(),
  packExercise: z.string().optional(),
  packHint: z.string().optional(),
})

export const successRankV1Schema = z.number().int()

export const finishCauseV1Schema = z.enum([
  'stop',
  'tool-calls',
  'length',
  'error',
  'other',
  'unknown',
])

export const errorCodeV1Schema = z.enum([
  'E_REPO_TIMEOUT',
  'E_REPO_CLONE_FAILED',
  'E_PACK_INVALID_REF',
  'E_PACK_UNKNOWN_TYPE',
  'E_PACK_INSTALL_TIMEOUT',
  'E_PACK_INSTALL_FAILED',
  'E_HOME_SETUP_FAILED',
  'E_PREFLIGHT_TIMEOUT',
  'E_PREFLIGHT_FAILED',
  'E_PREFLIGHT_PACK_INVISIBLE',
  'E_RUN_TIMEOUT',
  'E_RUN_HANG_WATCHDOG',
  'E_RUN_CRASH',
  'E_VERIFY_TIMEOUT',
  'E_VERIFY_FAILED',
  'E_INSTALL_TIMEOUT',
  'E_INSTALL_FAILED',
  'E_TOTAL_TIMEOUT',
  'E_OOM',
  'E_DISK_FULL',
  'E_WORKTREE_BROKEN',
  'E_PORT_CONFLICT',
  'E_DOCKER_FAILED',
  'E_EXPORT_INVALID',
  'E_CONFIG_INVALID',
  'E_AUTH_MISSING',
  'E_MODEL_UNAVAILABLE',
  'E_RATE_LIMIT_EXHAUSTED',
  'E_PACK_SETUP_FAILED',
  'E_PACK_SETUP_TIMEOUT',
  'E_PACK_CHECK_FAILED',
  'E_PACK_EXERCISE_FAILED',
  'E_PACK_EXERCISE_DIRTY',
])

export const runSideResultV1Schema = z.object({
  side: sideV1Schema,
  runIndex: z.number().int(),
  exportPath: z.string(),
  eventsLogPath: z.string(),
  successRank: successRankV1Schema,
  finishCause: finishCauseV1Schema,
  exitCode: z.number().int(),
  durationMs: z.string(),
  verifyExitCode: z.number().int().optional(),
  watchdogTriggered: z.boolean(),
  errorCode: errorCodeV1Schema.optional(),
  setupWallMs: z.string().optional(),
  initRan: z.boolean().optional(),
  initWallMs: z.string().optional(),
  promptWallMs: z.string().optional(),
})

export const primaryMetricsV1Schema = z.object({
  totalTokens: z.string(),
  wallClockMs: z.string(),
  costUsd: z.number(),
  stepCount: z.number().int(),
  toolCallCount: z.number().int(),
  successRank: successRankV1Schema,
  maxParallelism: z.number().int(),
})

export const toolStatV1Schema = z.object({
  count: z.number().int(),
  errorRate: z.number(),
  avgDurationMs: z.string(),
})

export const recordToolStatV1Schema = z.record(z.string(), toolStatV1Schema)

export const recordInt32V1Schema = z.record(z.string(), z.number().int())

export const secondaryMetricsV1Schema = z.object({
  inputTokens: z.string(),
  outputTokens: z.string(),
  reasoningTokens: z.string(),
  cacheReadTokens: z.string(),
  perTool: recordToolStatV1Schema,
  reasoningTimeMs: z.string(),
  stepLatencyP50Ms: z.string(),
  stepLatencyP95Ms: z.string(),
  toolLatencyAvgMs: z.string(),
  finishCauseDistribution: recordInt32V1Schema,
  maxConsecutiveSameTool: z.number().int(),
  invalidToolCalls: z.number().int().optional(),
  duplicateToolCalls: z.number().int().optional(),
  bashFailCount: z.number().int().optional(),
  toolErrorTexts: z.array(z.string()).optional(),
  timeToFirstToolMs: z.string().optional(),
  timeToFirstEditMs: z.string().optional(),
  maxEventGapMs: z.string().optional(),
  stallCount: z.number().int().optional(),
  stalledRunCount: z.number().int().optional(),
  firstStepInputTokens: z.string().optional(),
  lastStepInputTokens: z.string().optional(),
  textChars: z.string().optional(),
  reasoningChars: z.string().optional(),
  cacheWriteTokens: z.string().optional(),
})

export const metricDistributionV1Schema = z.object({
  median: z.number(),
  min: z.number(),
  max: z.number(),
  iqr: z.number().optional(),
  samples: z.array(z.number()),
})

export const aggregateStatsV1Schema = z.object({
  totalTokens: metricDistributionV1Schema,
  wallClockMs: metricDistributionV1Schema,
  costUsd: metricDistributionV1Schema,
  stepCount: metricDistributionV1Schema,
  toolCallCount: metricDistributionV1Schema,
  successRank: metricDistributionV1Schema,
})

export const failedRunV1Schema = z.object({
  runIndex: z.number().int(),
  errorCode: errorCodeV1Schema,
  errorMessage: z.string(),
  timestamp: z.string(),
})

export const packUseV1Schema = z.object({
  calls: z.number().int(),
  errors: z.number().int(),
  runsWithCall: z.number().int(),
  runCount: z.number().int(),
  firstCallMsMedian: z.string().optional(),
  canDetect: z.boolean(),
  visibilityConfirmed: z.boolean().optional(),
  runsWithoutCall: z.array(z.number().int()).optional(),
})

export const riskyCommandV1Schema = z.object({
  runIndex: z.number().int(),
  command: z.string(),
  completed: z.boolean(),
  exitCode: z.number().int().optional(),
})

export const verifyStatsV1Schema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  timedOut: z.number().int(),
  runCount: z.number().int(),
})

export const contaminationSignalV1Schema = z.object({
  kind: z.union([z.literal('skill-call'), z.literal('bash-install'), z.literal('install-drift')]),
  detail: z.string(),
  runIndex: z.number().int().optional(),
})

export const phaseSliceV1Schema = z.object({
  totalTokens: z.string(),
  wallClockMs: z.string(),
  costUsd: z.number(),
  stepCount: z.number().int(),
  toolCallCount: z.number().int(),
})

export const phaseSliceStatsV1Schema = z.object({
  totalTokens: metricDistributionV1Schema,
  wallClockMs: metricDistributionV1Schema,
  costUsd: metricDistributionV1Schema,
  stepCount: metricDistributionV1Schema,
  toolCallCount: metricDistributionV1Schema,
})

export const setupSegmentV1Schema = z.object({
  wallClockMs: z.string(),
})

export const sidePhaseSplitV1Schema = z.object({
  runsWithInit: z.number().int(),
  runsWithLostInit: z.number().int(),
  init: phaseSliceV1Schema.optional(),
  initStats: phaseSliceStatsV1Schema.optional(),
  task: phaseSliceV1Schema,
  taskStats: phaseSliceStatsV1Schema,
  costProrated: z.boolean().optional(),
  setup: setupSegmentV1Schema.optional(),
  setupStats: metricDistributionV1Schema.optional(),
})

export const sideAggregatesV1Schema = z.object({
  side: sideV1Schema,
  primary: primaryMetricsV1Schema,
  secondary: secondaryMetricsV1Schema,
  stats: aggregateStatsV1Schema,
  failedRuns: z.array(failedRunV1Schema),
  rawRunIds: z.array(z.string()),
  packUse: packUseV1Schema.optional(),
  riskyCommands: z.array(riskyCommandV1Schema).optional(),
  opencodeVersions: z.array(z.string()).optional(),
  verifyStats: verifyStatsV1Schema.optional(),
  contaminationSignals: z.array(contaminationSignalV1Schema).optional(),
  phaseSplit: sidePhaseSplitV1Schema.optional(),
})

export const metricDeltaV1Schema = z.object({
  absolute: z.number(),
  percent: z.number().optional(),
  significant: z.boolean(),
  better: z.union([
    z.literal('better'),
    z.literal('worse'),
    z.literal('neutral'),
    z.literal('context-dependent'),
  ]),
})

export const primaryDeltasV1Schema = z.object({
  totalTokens: metricDeltaV1Schema,
  wallClockMs: metricDeltaV1Schema,
  costUsd: metricDeltaV1Schema,
  stepCount: metricDeltaV1Schema,
  toolCallCount: metricDeltaV1Schema,
  successRank: metricDeltaV1Schema,
  maxParallelism: metricDeltaV1Schema,
})

export const phaseDeltasV1Schema = z.object({
  totalTokens: metricDeltaV1Schema,
  wallClockMs: metricDeltaV1Schema,
  costUsd: metricDeltaV1Schema,
  stepCount: metricDeltaV1Schema,
  toolCallCount: metricDeltaV1Schema,
})

export const metricsDiffV1Schema = z.object({
  old: sideAggregatesV1Schema,
  new: sideAggregatesV1Schema,
  deltas: primaryDeltasV1Schema,
  bothFailed: z.boolean(),
  taskDeltas: phaseDeltasV1Schema.optional(),
  initDeltas: phaseDeltasV1Schema.optional(),
})

export const fileChangeV1Schema = z.object({
  path: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
})

export const diffSummaryV1Schema = z.object({
  filesChanged: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
  perFile: z.array(fileChangeV1Schema),
})

export const diffRunStateV1Schema = z.enum(['ok', 'git-restored', 'git-replaced', 'failed'])

export const diffRunErrorV1Schema = z.object({
  code: z.literal('E_WORKTREE_BROKEN'),
  message: z.string(),
})

export const diffRunResultV1Schema = z.object({
  runIndex: z.number().int(),
  fullPatch: z.string(),
  summary: diffSummaryV1Schema,
  htmlPath: z.string().optional(),
  noChanges: z.boolean(),
  state: diffRunStateV1Schema.optional(),
  error: diffRunErrorV1Schema.optional(),
})

export const diffResultV1Schema = z.object({
  side: sideV1Schema,
  runs: z.array(diffRunResultV1Schema),
})

export const judgeVerdictV1Schema = z.enum(['ok', 'fail', 'unclear'])

export const judgeResultV1Schema = z.object({
  verdict: judgeVerdictV1Schema,
  oldQuality: z.number().int(),
  newQuality: z.number().int(),
  explanation: z.string(),
  rawResponse: z.string().optional(),
  modelUsed: z.string(),
  timestamp: z.string(),
  ran: z.boolean().optional(),
})

export const packCmdResultV1Schema = z.object({
  side: sideV1Schema,
  runIndex: z.number().int(),
  exitCode: z.number().int(),
  durationMs: z.string(),
  outputTail: z.string().optional(),
  artifactHash: z.string().optional(),
})

export const packSetupModeV1Schema = z.enum(['exercised', 'installed-only', 'delivered-only'])

export const packSetupReportV1Schema = z.object({
  mode: packSetupModeV1Schema,
  setupDeclared: z.boolean(),
  checkDeclared: z.boolean(),
  exerciseDeclared: z.boolean(),
  undeclaredDepWarning: z.string().optional(),
  setup: packCmdResultV1Schema.optional(),
  checks: z.array(packCmdResultV1Schema),
  exercises: z.array(packCmdResultV1Schema),
})

export const timelineEventTypeV1Schema = z.enum([
  'reasoning',
  'tool-call',
  'tool-result',
  'step-finish',
  'text',
])

export const timelineEventV1Schema = z.object({
  tStart: z.string(),
  tEnd: z.string(),
  side: sideV1Schema,
  runIndex: z.number().int(),
  sessionId: z.string(),
  parentSessionId: z.string().optional(),
  swimlaneDepth: z.number().int(),
  type: timelineEventTypeV1Schema,
  tool: z.string().optional(),
  tokens: z.number().int().optional(),
  status: z
    .union([z.literal('pending'), z.literal('running'), z.literal('completed'), z.literal('error')])
    .optional(),
})

export const timelineV1Schema = z.object({
  old: z.array(timelineEventV1Schema),
  new: z.array(timelineEventV1Schema),
  mode: timelineModeV1Schema,
})

export const reportSummaryV1Schema = z.object({
  headlineResult: z.string(),
  improvements: z.array(metricDeltaV1Schema),
  regressions: z.array(metricDeltaV1Schema),
  neutral: z.array(metricDeltaV1Schema),
  failures: z.array(failedRunV1Schema),
  basis: z.union([z.literal('task'), z.literal('total')]).optional(),
})

export const reportV1Schema = z.object({
  manifest: manifestV1Schema,
  metricsDiff: metricsDiffV1Schema,
  timeline: timelineV1Schema,
  diff: z.object({
    old: diffResultV1Schema,
    new: diffResultV1Schema,
  }),
  judge: judgeResultV1Schema.optional(),
  summary: reportSummaryV1Schema,
  packSetup: packSetupReportV1Schema.optional(),
})
