/**
 * Phase orchestration: wires phases 00\u201313 into one Effect pipeline with
 * progress reporting. Each phase runs under a timed wrapper that emits a
 * completion line; phase 06 (run-side) runs old/new concurrently with N runs
 * sequential per side, reporting each run as an indented sub-line.
 *
 * The orchestrator overrides `runInput.outputPath` to the workspace `results/`
 * directory so report files and metrics.json land together inside the run
 * tree (phase 00's CLI default of `./results` is only a fallback for the
 * no-workspace case).
 */
import { Effect } from 'effect'
import type {
  EnvVarSet,
  JudgeResult,
  Manifest,
  MetricsDiff,
  ReportRenderInput,
  ReportRenderResult,
  RunInput,
  RunSideResult,
  Side,
  WorkspaceTree,
} from '@generated/types'
import { judgeResultSchema } from '@generated/schemas'
import type { PhaseError } from '../errors.js'
import { runSideError } from '../errors.js'
import { generateRunId } from '../util/run-id.js'
import { cliParse } from '../phases/00-cli-parse.js'
import { workspaceSetup } from '../phases/01-workspace-setup.js'
import { repoClone } from '../phases/02-repo-clone.js'
import { packInstall } from '../phases/03-pack-install.js'
import type { PackInstallOutcome } from '../phases/03-pack-install.js'
import { homeIsolation } from '../phases/04-home-isolation.js'
import { preflight } from '../phases/05-preflight.js'
import { runSide } from '../phases/06-run-side.js'
import { aggregate } from '../phases/07-aggregate.js'
import { diff } from '../phases/08-diff.js'
import { judge } from '../phases/09-judge.js'
import { timeline } from '../phases/10-timeline.js'
import { reportRender } from '../phases/11-report-render.js'
import { reviewWorkspace } from '../phases/12-review-workspace.js'
import { cleanup } from '../phases/13-cleanup.js'
import { buildReportSummary } from './summary.js'
import type { ProgressReporter } from './progress.js'

/** 14 phases: cli-parse(00) \u2026 cleanup(13). */
export const PHASE_COUNT = 14

export interface PipelineOptions {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly configFile?: string
  readonly reviewRun: number
  readonly ide: string
  readonly ephemeral: boolean
  readonly reporter: ProgressReporter
}

export interface PipelineOutcome {
  readonly runId: string
  readonly manifest: Manifest
  readonly workspace: WorkspaceTree
  readonly rootPath: string
  readonly metricsDiff: MetricsDiff
  readonly reportPaths: ReportRenderResult['paths']
  readonly reviewCommand: string
  readonly summary: string
}

const range = (n: number): readonly number[] =>
  Array.from({ length: n }, (_, i) => i)

const timedPhase = <A>(
  index: number,
  label: string,
  eff: Effect.Effect<A, PhaseError>,
  reporter: ProgressReporter,
  detail?: (a: A) => string | undefined,
): Effect.Effect<A, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const result = yield* eff
    const d = detail === undefined ? undefined : detail(result)
    reporter.phaseDone({
      index,
      total: PHASE_COUNT,
      label,
      durationMs: Date.now() - start,
      ...(d === undefined ? {} : { detail: d }),
    })
    return result
  })

const resolveJudge = (raw: unknown): JudgeResult | undefined => {
  if (raw === null) return undefined
  const parsed = judgeResultSchema.safeParse(raw)
  if (!parsed.success) return undefined
  // Zod infers optionals as `T | undefined`; the generated JudgeResult uses
  // exact-optional. The data is schema-validated, so runtime-equivalent.
  return parsed.data as JudgeResult
}

const runOneSide = (
  side: Side,
  runInput: RunInput,
  manifest: Manifest,
  workspace: WorkspaceTree,
  envs: readonly EnvVarSet[],
  reporter: ProgressReporter,
): Effect.Effect<readonly RunSideResult[], PhaseError> =>
  Effect.forEach(
    range(runInput.runs),
    (idx) => {
      const runIndex = idx + 1
      const homeEnv = envs[idx]
      if (homeEnv === undefined) {
        return Effect.fail(
          runSideError(
            `missing HOME env for ${side} run ${String(runIndex)}`,
            'E_RUN_CRASH',
            { side, runIndex },
          ),
        )
      }
      return runSide({
        runInput,
        manifest,
        workspace,
        homeEnv,
        side,
        runIndex,
        sessionId: '',
      }).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            reporter.sub(
              `${side}/run-${String(runIndex)}/${String(runInput.runs)}`,
              Number(r.durationMs),
            )
          }),
        ),
      )
    },
    { concurrency: 1 },
  )

const detailForPack = (p: PackInstallOutcome): string => {
  if (p.detectedType === null) return 'smoke-test (no pack)'
  const name = p.instructions.find((i) => i.kind !== 'config')
  return `${p.detectedType}: ${name === undefined ? 'pack' : name.name}`
}

export const runPipeline = (
  opts: PipelineOptions,
): Effect.Effect<PipelineOutcome, PhaseError> =>
  Effect.gen(function* () {
    const reporter = opts.reporter

    // 00 cli-parse
    const parsed = yield* timedPhase(
      0,
      'cli-parse',
      cliParse({
        argv: [...opts.argv],
        cwd: opts.cwd,
        ...(opts.configFile === undefined ? {} : { configFile: opts.configFile }),
      }),
      reporter,
    )
    const baseRunInput = parsed.runInput

    const runId = yield* generateRunId()
    reporter.header(runId)

    // 01 workspace-setup
    const ws = yield* timedPhase(
      1,
      'workspace-setup',
      workspaceSetup({
        runInput: baseRunInput,
        runId,
        flagDefaults: {
          ...parsed.flagDefaults,
          reviewRun: opts.reviewRun,
          ide: opts.ide,
        },
      }),
      reporter,
      (r) => r.rootPath,
    )
    const { manifest, treePaths } = ws

    const runInput: RunInput = { ...baseRunInput, outputPath: treePaths.results }

    // 02 repo-clone
    yield* timedPhase(
      2,
      'repo-clone',
      repoClone({ runInput, manifest, workspace: treePaths }),
      reporter,
      () => runInput.repoUrl,
    )

    // 03 pack-install
    const pack = yield* timedPhase(
      3,
      'pack-install',
      packInstall({ runInput, manifest, workspace: treePaths }),
      reporter,
      detailForPack,
    )

    // 04 home-isolation
    const home = yield* timedPhase(
      4,
      'home-isolation',
      homeIsolation({ runInput, manifest, workspace: treePaths, packInstall: pack }),
      reporter,
      () => `${String(runInput.runs * 2)} HOME trees`,
    )

    // 05 preflight
    const homePaths = {
      old: treePaths.homeOld[0] ?? '',
      new: treePaths.homeNew[0] ?? '',
    }
    const preflightResult = yield* timedPhase(
      5,
      'preflight',
      preflight({
        runInput,
        manifest,
        homePaths,
        packInstall: pack,
      }),
      reporter,
      (r) => (runInput.preflightEnabled ? `${String(r.checks.length)} checks passed` : 'skipped (--no-preflight)'),
    )
    void preflightResult

    // 06 run-side (old || new, sequential within side)
    reporter.sub(`run-side: ${String(runInput.runs)} run(s) per side`)
    const oldEnvs = home.envVars[0] ?? []
    const newEnvs = home.envVars[1] ?? []
    const start06 = Date.now()
    const both = yield* Effect.all(
      {
        old: runOneSide('old', runInput, manifest, treePaths, oldEnvs, reporter),
        new: runOneSide('new', runInput, manifest, treePaths, newEnvs, reporter),
      },
      { concurrency: 2 },
    )
    reporter.phaseDone({
      index: 6,
      total: PHASE_COUNT,
      label: 'run-side',
      durationMs: Date.now() - start06,
      detail: `${String(runInput.runs)} run(s) \u00d7 2 sides`,
    })
    const sideResults = {
      old: [...both.old],
      new: [...both.new],
    }

    // 07 aggregate
    const agg = yield* timedPhase(
      7,
      'aggregate',
      aggregate({ runInput, manifest, workspace: treePaths, sideResults }),
      reporter,
      (r) =>
        r.metricsDiff.bothFailed ? 'both sides failed' : 'metricsDiff computed',
    )

    // 08 diff
    const diffOut = yield* timedPhase(
      8,
      'diff',
      diff({ runInput, manifest, workspace: treePaths }),
      reporter,
      (r) =>
        `${String(r.diff.old.runs.length + r.diff.new.runs.length)} run patch(es)`,
    )

    // 09 judge (optional)
    const judgeOut = yield* timedPhase(
      9,
      'judge',
      judge({ runInput, manifest, diff: diffOut.diff }),
      reporter,
      (r) => (r.judge === null ? 'skipped (no --judge)' : 'verdict recorded'),
    )
    const judgeResult = resolveJudge(judgeOut.judge)

    // 10 timeline
    const tl = yield* timedPhase(
      10,
      'timeline',
      timeline({ runInput, manifest, workspace: treePaths, sideResults }),
      reporter,
      (r) => `${String(r.timeline.old.length + r.timeline.new.length)} events`,
    )

    // summary (built from the diff, not a separate phase)
    const summary = buildReportSummary(agg.metricsDiff)

    // 11 report-render
    const reportInput: ReportRenderInput = {
      runInput,
      manifest,
      metricsDiff: agg.metricsDiff,
      timeline: tl.timeline,
      diff: diffOut.diff,
      summary,
      ...(judgeResult === undefined ? {} : { judge: judgeResult }),
    }
    const report = yield* timedPhase(
      11,
      'report-render',
      reportRender(reportInput),
      reporter,
      (r) => Object.keys(r.paths).join(', '),
    )

    // 12 review-workspace
    const review = yield* timedPhase(
      12,
      'review-workspace',
      reviewWorkspace({ runInput, manifest, workspace: treePaths }),
      reporter,
    )

    // 13 cleanup (optional)
    yield* timedPhase(
      13,
      'cleanup',
      cleanup({
        runInput,
        manifest,
        workspace: treePaths,
        ephemeral: opts.ephemeral,
      }),
      reporter,
      (r) => (r.deleted.length === 0 ? 'retained' : `deleted ${String(r.deleted.length)} dir(s)`),
    )

    const improvements = summary.improvements.length
    const regressions = summary.regressions.length
    reporter.done(
      `${String(improvements)} improvement(s), ${String(regressions)} regression(s). Report: ${report.paths.md ?? '<none>'}`,
    )

    return {
      runId,
      manifest,
      workspace: treePaths,
      rootPath: ws.rootPath,
      metricsDiff: agg.metricsDiff,
      reportPaths: report.paths,
      reviewCommand: review.command,
      summary: summary.headlineResult,
    }
  })
