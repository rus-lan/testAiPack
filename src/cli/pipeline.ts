/**
 * Phase orchestration: wires phases 00\u201313 into one Effect pipeline with
 * progress reporting. Each phase runs under a timed wrapper that emits a
 * completion line; phase 06 (run-side) runs old/new concurrently with N runs
 * sequential per side, reporting each run as an indented sub-line.
 *
 * The orchestrator points `runInput.outputPath` (and the run tree's `results`
 * + `diff`) at the report-output location: the workspace `results/` directory
 * by default, or an explicit `--output <path>` when the user supplies one.
 * Manifest and the rest of the workspace structure always stay under
 * `<workspace>/<run-id>`; only report artifacts move with `--output`.
 */
import { Effect } from 'effect'
import crypto from 'node:crypto'
import path from 'node:path'
import type {
  DiffResultOutput,
  EnvVarSet,
  JudgeResult,
  Manifest,
  MetricsDiff,
  PackCmdResult,
  PackSetupReport,
  PreflightCheck,
  ReportRenderInput,
  ReportRenderResult,
  ReportSummary,
  RunInput,
  Side,
  WorkspaceTree,
} from '@generated/types'
import { judgeResultSchema } from '@generated/schemas'
import type { PhaseError } from '../errors.js'
import { packSetupError, runSideError, serializePhaseError } from '../errors.js'
import { generateRunId } from '../util/run-id.js'
import { ensureDir, pathKind, readFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { redactUrlCredentials } from '../util/redact.js'
import { safeRefDisplay } from '../pack/detector.js'
import { appendInfoExclude, statusPorcelain } from '../util/git.js'
import type { GitError } from '../util/git.js'
import type { DockerExec } from '../opencode/cli.js'
import { runShellInHome } from '../isolation/shell-runner.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import { cliParse } from '../phases/00-cli-parse.js'
import { workspaceSetup } from '../phases/01-workspace-setup.js'
import { repoClone } from '../phases/02-repo-clone.js'
import { packInstall } from '../phases/03-pack-install.js'
import type { PackInstallOutcome } from '../phases/03-pack-install.js'
import { homeIsolation } from '../phases/04-home-isolation.js'
import { packSetup, derivePackSetupMode } from '../phases/04b-pack-setup.js'
import { preflight } from '../phases/05-preflight.js'
import { runSide } from '../phases/06-run-side.js'
import type { RunSideResultExt } from '../phases/06-run-side.js'
import { captureOpencodeConfig } from '../phases/06-config-capture.js'
import { aggregate } from '../phases/07-aggregate.js'
import { diff } from '../phases/08-diff.js'
import { judge } from '../phases/09-judge.js'
import { timeline } from '../phases/10-timeline.js'
import { reportRender } from '../phases/11-report-render.js'
import { reviewWorkspace } from '../phases/12-review-workspace.js'
import { cleanup } from '../phases/13-cleanup.js'
import { buildReportSummary } from './summary.js'
import { withLogLevel } from './progress.js'
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
  readonly diffEscalated: boolean
}

const range = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i)

/**
 * `resolveIsolation` (phase 00) falls back to `home` isolation when Docker is
 * unavailable and records `dockerDowngraded` in `flagDefaults`. That alone is
 * silent — this turns it into the stderr line the user actually sees.
 */
export const dockerDowngradeWarning = (
  flagDefaults: Readonly<Record<string, unknown>>,
): string | undefined =>
  flagDefaults['dockerDowngraded'] === true
    ? 'warning: --isolation docker requested but Docker is unavailable — falling back to --isolation home'
    : undefined

/**
 * `--protect-git` moves each run's git dir out of the mounted tree, but under
 * `--isolation home` the agent runs unsandboxed on the host and can still
 * path-walk to the relocated dir — protection is only strong under docker.
 */
export const protectGitHomeWarning = (runInput: RunInput): string | undefined =>
  runInput.protectGit && runInput.isolation === 'home'
    ? 'warning: --protect-git with --isolation home only hides .git from the workspace; a host-level agent can still reach it'
    : undefined

/**
 * A short, comparable name out of a `--pack` ref: strips the `npm:`/`mcp:`/
 * `agent:`/`command:` prefix, an `mcp:name:config` payload, a trailing
 * `.git`, and takes the last `/`-segment (handles scoped npm names, git
 * URLs, and local paths alike). Approximate on purpose — this only feeds a
 * best-effort warning heuristic, not `pack/detector.ts`'s real detection
 * (which the caller may not have run, e.g. when `--pack-type` is explicit).
 */
export const packShortName = (ref: string): string => {
  const prefixMatch = /^(npm:|mcp:|agent:|command:)/i.exec(ref)
  const afterPrefix = prefixMatch === null ? ref : ref.slice(prefixMatch[0].length)
  const afterMcpConfig =
    prefixMatch?.[0].toLowerCase() === 'mcp:' && afterPrefix.includes(':')
      ? afterPrefix.slice(0, afterPrefix.indexOf(':'))
      : afterPrefix
  const clean = afterMcpConfig.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = clean.split('/')
  return (parts[parts.length - 1] ?? clean).toLowerCase()
}

/** Below this length a substring match is mostly noise (e.g. a pack ref like `npm:x`). */
const PACK_NAME_MIN_LENGTH = 3

/**
 * `--pure-baseline`'s whole point is a baseline unaware of the pack under
 * test — but `initSide: "both"` (the default) sends `--init` to that
 * baseline too, so an init text that is really a pack TRIGGER (e.g. a slash
 * command) makes the "pure" baseline install and invoke the pack itself. A
 * warning, not a hard failure: dependency-setup init genuinely does belong
 * on both sides, so this only flags the case that looks like a trigger.
 */
export const initPackContaminationWarning = (runInput: RunInput): string | undefined => {
  if (!runInput.pureBaseline) return undefined
  if (runInput.initSide === 'new') return undefined
  if (runInput.init === undefined || runInput.init === '') return undefined
  if (runInput.packRef === undefined) return undefined
  const name = packShortName(runInput.packRef)
  if (name.length < PACK_NAME_MIN_LENGTH) return undefined
  if (!runInput.init.toLowerCase().includes(name)) return undefined
  return `warning: --init looks like it references the pack under test ("${name}") and --pure-baseline is on with --init-side ${runInput.initSide} — the baseline will receive it too, contaminating the comparison. Use --init-side new to send it to the new side only.`
}

/**
 * `--pack-exercise` runs a command per new-side run before the agent session,
 * but nothing confirms the pack is functional first unless `--pack-check` is
 * also declared — an exercise against a broken install just fails every run
 * for a reason the report can't distinguish from "the model never used it".
 * Non-fatal per the spec's open question 6: `--pack-check` stays
 * recommended, not required.
 */
export const packExerciseWithoutCheckWarning = (runInput: RunInput): string | undefined =>
  runInput.packExercise !== undefined && runInput.packCheck === undefined
    ? 'warning: --pack-exercise without --pack-check — the pack\'s "functional" claim is unverified before exercising; a broken install fails every new-side run without a clear reason'
    : undefined

/**
 * A "no pack to check" run (gate 4's early-return in 05-preflight.ts) reports
 * `passed: true, details: 'skipped (no pack)'` — that means "not applicable",
 * not "confirmed visible", and must not count as visibility confirmation.
 */
export const resolvePackVisibilityConfirmed = (checks: readonly PreflightCheck[]): boolean =>
  checks.some((c) => c.name === 'pack-visibility' && c.passed && c.details !== 'skipped (no pack)')

/**
 * Redacts the same two fields `buildManifest` already redacts
 * (`src/phases/01-workspace-setup.ts`) before the resolved `RunInput` is
 * persisted for post-mortem / rebuild: `repoUrl` and `packRef` are the only
 * fields that can carry a credential (a git URL's userinfo, or an inline
 * `mcp:<name>:<config>` ref's `env` block).
 */
export interface DiffFailureStatus {
  readonly oldFailed: number
  readonly oldTotal: number
  readonly newFailed: number
  readonly newTotal: number
  readonly oldSideFailed: boolean
  readonly newSideFailed: boolean
  readonly escalate: boolean
}

const countFailedRuns = (runs: DiffResultOutput['diff']['old']['runs']): number =>
  runs.filter((r) => r.state === 'failed').length

/**
 * A contained per-run diff failure (`state: "failed"`) is expected to happen
 * occasionally and stays quiet in the headline — that is the whole point of
 * containment (phase 08 keeps going instead of aborting). An entire side
 * failing is a different signal: the comparison has nothing to show for that
 * side, so it needs to be loud rather than read like an ordinary "N
 * improvements, M regressions" run.
 */
export const diffFailureStatus = (diff: DiffResultOutput['diff']): DiffFailureStatus => {
  const oldTotal = diff.old.runs.length
  const newTotal = diff.new.runs.length
  const oldFailed = countFailedRuns(diff.old.runs)
  const newFailed = countFailedRuns(diff.new.runs)
  const oldSideFailed = oldTotal > 0 && oldFailed === oldTotal
  const newSideFailed = newTotal > 0 && newFailed === newTotal
  return {
    oldFailed,
    oldTotal,
    newFailed,
    newTotal,
    oldSideFailed,
    newSideFailed,
    escalate: oldSideFailed || newSideFailed,
  }
}

export const diffFailureWarning = (status: DiffFailureStatus): string | undefined => {
  if (!status.escalate) return undefined
  const parts: readonly string[] = [
    ...(status.oldSideFailed
      ? [`old side: ${String(status.oldFailed)}/${String(status.oldTotal)} run(s) failed (worktree broken)`]
      : []),
    ...(status.newSideFailed
      ? [`new side: ${String(status.newFailed)}/${String(status.newTotal)} run(s) failed (worktree broken)`]
      : []),
  ]
  return `diff unavailable — ${parts.join('; ')}. The metrics above do not include these runs' code changes.`
}

export const redactRunInput = (runInput: RunInput): RunInput => ({
  ...runInput,
  repoUrl: redactUrlCredentials(runInput.repoUrl),
  ...(runInput.packRef === undefined
    ? {}
    : { packRef: safeRefDisplay(redactUrlCredentials(runInput.packRef)) }),
})

export const warnFsFailure = (what: string, e: FsError): string =>
  `warning: failed to write ${what}: ${e.operation} on ${e.path}: ${String(e.cause)}`

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

/**
 * SHA-256 over the sorted (relative path, file content) pairs of the
 * artifacts `--pack-exercise` left behind — doubles as a determinism
 * tripwire (the report can flag cross-run divergence of a nondeterministic
 * pack pipeline). Directory entries contribute only their path (their
 * files are hashed individually when git lists them).
 */
const computeArtifactHash = (appDir: string, relPaths: readonly string[]): Effect.Effect<string> =>
  Effect.gen(function* () {
    const hash = crypto.createHash('sha256')
    for (const rel of [...relPaths].sort()) {
      hash.update(rel)
      const kind = yield* pathKind(path.join(appDir, rel))
      if (kind === 'file') {
        const content = yield* readFile(path.join(appDir, rel)).pipe(Effect.catchAll(() => Effect.succeed('')))
        hash.update(content)
      }
    }
    return hash.digest('hex')
  })

/**
 * `computeArtifactHash`'s own doc comment claims it "doubles as a
 * determinism tripwire" — nothing actually compared hashes across runs or
 * flagged a no-artifact exercise until this function. Pure so it is testable
 * without spinning up the pipeline; called once after all new-side exercises
 * complete, over their `PackCmdResult[]` (only ones that actually ran a
 * successful exercise carry a defined `artifactHash`, or `undefined` when
 * `exitCode === 0` left no untracked files at all — see `runPackExercise`).
 */
export const checkExerciseIntegrity = (exercises: readonly PackCmdResult[]): string | undefined => {
  if (exercises.length === 0) return undefined
  const withHash = exercises.flatMap((e) => (e.artifactHash === undefined ? [] : [e.artifactHash]))
  if (withHash.length === 0) {
    return `warning: --pack-exercise exited 0 but left no artifact on any of ${String(exercises.length)} run(s) — indistinguishable from a no-op; verify it actually ran the pack's pipeline`
  }
  const distinct = new Set(withHash)
  if (distinct.size > 1) {
    return `warning: --pack-exercise produced ${String(distinct.size)} distinct artifact hash(es) across ${String(withHash.length)} run(s) that left output — the pack pipeline may be non-deterministic`
  }
  return undefined
}

/** `.git` dir for one run's app tree — outside it under `--protect-git`, inside it otherwise. */
const gitDirFor = (
  protectGit: boolean,
  appDir: string,
  gitDirsForSide: readonly string[],
  idx: number,
): string => (protectGit ? (gitDirsForSide[idx] ?? path.join(appDir, '.git')) : path.join(appDir, '.git'))

type ExerciseOutcome =
  | { readonly kind: 'ok'; readonly cmdResult: PackCmdResult; readonly setupWallMs: number }
  | { readonly kind: 'failed'; readonly result: RunSideResultExt; readonly cmdResult: PackCmdResult; readonly setupWallMs: number }

/**
 * Excludes a failed exercise's own untracked output so phase 08 does not
 * stage it as if the agent (who never got to run — the session is skipped
 * on `E_PACK_EXERCISE_FAILED`) had written it. Fully best-effort, unlike the
 * success path below: this run is already contained as failed, so nothing
 * here may turn into a new pipeline failure — a miss here costs a few extra
 * untracked lines in the diff, not measurement integrity. Also persists the
 * `run-N.exercise.json` record so phase 08 can re-apply the same excludes
 * if it has to restore/replace this run's `.git` (see `reapplyExerciseExcludes`
 * in `08-diff.ts`).
 */
export const excludeFailedExerciseArtifacts = (
  appDir: string,
  gitDir: string,
  rawDir: string,
  runIndex: number,
): Effect.Effect<void> =>
  statusPorcelain(appDir, gitDir).pipe(
    Effect.flatMap((statuses) => {
      const untrackedPaths = statuses.filter((s) => s.code === '??').map((s) => s.path)
      if (untrackedPaths.length === 0) return Effect.void
      return appendInfoExclude(gitDir, untrackedPaths).pipe(
        Effect.flatMap(() => ensureDir(rawDir)),
        Effect.flatMap(() =>
          writeJson(path.join(rawDir, `run-${String(runIndex)}.exercise.json`), { excludedPaths: untrackedPaths }),
        ),
      )
    }),
    Effect.ignore,
  )

/**
 * Runs `--pack-exercise` once, before the agent session starts (§5.5 of the
 * pack-setup spec). A command failure/timeout CONTAINS this one run — the
 * agent session is never started, the run is synthesized as failed with
 * `E_PACK_EXERCISE_FAILED` (the exact corruption the spec exists to
 * prevent: a run where the tool never worked must never silently count as a
 * measured "after" run). A tracked-file modification aborts the whole
 * experiment (`E_PACK_EXERCISE_DIRTY`) — that kind of contamination cannot
 * be fixed by excluding a path after the fact. Untracked paths (the
 * exercise's own output) are appended to `.git/info/exclude` so `git add -A`
 * (phase 08) never stages them, and persisted to `run-N.exercise.json` so
 * phase 08 can re-apply the same excludes after a `.git` restore.
 */
const runPackExercise = (
  cmd: string,
  homeEnv: EnvVarSet,
  appDir: string,
  gitDir: string,
  rawDir: string,
  docker: DockerExec | undefined,
  timeoutMs: number,
  side: Side,
  runIndex: number,
): Effect.Effect<ExerciseOutcome, PhaseError> =>
  Effect.gen(function* () {
    const outcome = yield* runShellInHome(cmd, homeEnv.HOME, appDir, docker, timeoutMs, homeEnv.PATH)

    if (outcome.timedOut || outcome.exitCode !== 0) {
      yield* excludeFailedExerciseArtifacts(appDir, gitDir, rawDir, runIndex)
      const cmdResult: PackCmdResult = {
        side,
        runIndex,
        exitCode: outcome.exitCode,
        durationMs: String(outcome.durationMs),
        outputTail: outcome.outputTail,
      }
      const result: RunSideResultExt = {
        side,
        runIndex,
        exportPath: '',
        eventsLogPath: '',
        successRank: 0,
        finishCause: 'error',
        exitCode: outcome.exitCode,
        durationMs: String(outcome.durationMs),
        watchdogTriggered: false,
        errorCode: 'E_PACK_EXERCISE_FAILED',
      }
      return { kind: 'failed', result, cmdResult, setupWallMs: outcome.durationMs }
    }

    const statuses = yield* statusPorcelain(appDir, gitDir).pipe(
      Effect.mapError(
        (e: GitError): PhaseError =>
          packSetupError(`cannot verify --pack-exercise diff hygiene (git status failed): ${e.stderr}`, 'E_PACK_EXERCISE_FAILED', {
            side,
            runIndex,
          }),
      ),
    )
    // `??` = untracked (the exercise's own output). Any other non-blank code
    // (` M`, `M `, ` D`, `A `, `R `, ...) means an already-tracked path
    // changed — exclusion cannot fix that, so it aborts instead of being
    // contained per-run.
    const dirtyTracked = statuses.filter((s) => s.code !== '??' && s.code.trim() !== '')
    if (dirtyTracked.length > 0) {
      return yield* Effect.fail(
        packSetupError(
          `--pack-exercise modified tracked file(s): ${dirtyTracked.map((s) => s.path).join(', ')}`,
          'E_PACK_EXERCISE_DIRTY',
          { side, runIndex, paths: dirtyTracked.map((s) => s.path) },
        ),
      )
    }

    const untrackedPaths = statuses.filter((s) => s.code === '??').map((s) => s.path)
    if (untrackedPaths.length > 0) {
      yield* appendInfoExclude(gitDir, untrackedPaths).pipe(
        Effect.mapError(
          (e: FsError): PhaseError =>
            packSetupError(`cannot exclude --pack-exercise artifacts: ${e.path}`, 'E_PACK_EXERCISE_FAILED', { side, runIndex }),
        ),
      )
    }
    const artifactHash =
      untrackedPaths.length === 0 ? undefined : yield* computeArtifactHash(appDir, untrackedPaths)

    yield* ensureDir(rawDir).pipe(
      Effect.mapError(
        (e: FsError): PhaseError =>
          packSetupError(`cannot create raw dir for exercise record: ${e.path}`, 'E_PACK_EXERCISE_FAILED', { side, runIndex }),
      ),
    )
    yield* writeJson(path.join(rawDir, `run-${String(runIndex)}.exercise.json`), {
      excludedPaths: untrackedPaths,
      ...(artifactHash === undefined ? {} : { artifactHash }),
    }).pipe(Effect.catchAll(() => Effect.void))

    const cmdResult: PackCmdResult = {
      side,
      runIndex,
      exitCode: outcome.exitCode,
      durationMs: String(outcome.durationMs),
      outputTail: outcome.outputTail,
      ...(artifactHash === undefined ? {} : { artifactHash }),
    }
    return { kind: 'ok', cmdResult, setupWallMs: outcome.durationMs }
  })

interface SideRunOutcome {
  readonly results: readonly RunSideResultExt[]
  readonly exercises: readonly PackCmdResult[]
}

const runOneSide = (
  side: Side,
  runInput: RunInput,
  manifest: Manifest,
  workspace: WorkspaceTree,
  envs: readonly EnvVarSet[],
  dockerImage: string | undefined,
  reporter: ProgressReporter,
): Effect.Effect<SideRunOutcome, PhaseError> =>
  Effect.gen(function* () {
    const docker: DockerExec | undefined =
      runInput.isolation === 'docker'
        ? {
            image: dockerImage ?? DEFAULT_OPENCODE_IMAGE,
            ...(runInput.dockerNetwork === undefined ? {} : { network: runInput.dockerNetwork }),
          }
        : undefined
    // The old side never exercises — it is deliberately never given the
    // pack, files, runtime, or trigger (§8 of the pack-setup spec).
    const exerciseCmd = side === 'new' ? runInput.packExercise : undefined
    const exerciseTimeoutMs = runInput.timeouts.installSeconds * 1000
    const appList = side === 'old' ? workspace.appsOld : workspace.appsNew
    const gitDirsForSide = side === 'old' ? workspace.gitDirsOld : workspace.gitDirsNew
    const rawDir = path.join(workspace.raw, side)

    const outcomes = yield* Effect.forEach(
      range(runInput.runs),
      (idx) =>
        Effect.gen(function* () {
          const runIndex = idx + 1
          const homeEnv = envs[idx]
          if (homeEnv === undefined) {
            return yield* Effect.fail(
              runSideError(`missing HOME env for ${side} run ${String(runIndex)}`, 'E_RUN_CRASH', {
                side,
                runIndex,
              }),
            )
          }

          const runAgent = (): Effect.Effect<RunSideResultExt, PhaseError> =>
            runSide({
              runInput,
              manifest,
              workspace,
              homeEnv,
              side,
              runIndex,
              sessionId: '',
              ...(dockerImage === undefined ? {} : { dockerImage }),
            }).pipe(
              Effect.tap((r) =>
                Effect.sync(() => {
                  reporter.sub(`${side}/run-${String(runIndex)}/${String(runInput.runs)}`, Number(r.durationMs))
                }),
              ),
            )

          if (exerciseCmd === undefined) {
            const result = yield* runAgent()
            return { result, exercise: undefined as PackCmdResult | undefined }
          }

          const appDir = appList[idx] ?? ''
          const gitDir = gitDirFor(runInput.protectGit, appDir, gitDirsForSide, idx)
          const ex = yield* runPackExercise(exerciseCmd, homeEnv, appDir, gitDir, rawDir, docker, exerciseTimeoutMs, side, runIndex)
          if (ex.kind === 'failed') {
            reporter.sub(`${side}/run-${String(runIndex)}/${String(runInput.runs)} (exercise failed, agent session skipped)`, Number(ex.result.durationMs))
            // The exercise DID run and DID take time even though it failed —
            // 07-aggregate.ts records setupWallMs for every attempted run,
            // successful and failed alike (see its doc comment); dropping it
            // here would silently exclude failed-exercise runs from that median.
            const patchedFailed: RunSideResultExt = { ...ex.result, setupWallMs: String(ex.setupWallMs) }
            return { result: patchedFailed, exercise: ex.cmdResult }
          }
          const runResult = yield* runAgent()
          const patched: RunSideResultExt = { ...runResult, setupWallMs: String(ex.setupWallMs) }
          return { result: patched, exercise: ex.cmdResult }
        }),
      { concurrency: 1 },
    )
    return {
      results: outcomes.map((o) => o.result),
      exercises: outcomes.flatMap((o) => (o.exercise === undefined ? [] : [o.exercise])),
    }
  })

const detailForPack = (p: PackInstallOutcome): string => {
  if (p.detectedType === null) return 'smoke-test (no pack)'
  const name = p.instructions.find((i) => i.kind !== 'config')
  return `${p.detectedType}: ${name === undefined ? 'pack' : name.name}`
}

export const runPipeline = (opts: PipelineOptions): Effect.Effect<PipelineOutcome, PhaseError> =>
  Effect.gen(function* () {
    const rawReporter = opts.reporter

    // 00 cli-parse — runs before the log level itself is known, so this one
    // call always uses the unfiltered reporter (only matters at a stricter
    // level than the default `info`, and it is a single progress line).
    const parsed = yield* timedPhase(
      0,
      'cli-parse',
      cliParse({
        argv: [...opts.argv],
        cwd: opts.cwd,
        ...(opts.configFile === undefined ? {} : { configFile: opts.configFile }),
      }),
      rawReporter,
    )
    const baseRunInput = parsed.runInput
    const reporter = withLogLevel(rawReporter, baseRunInput.logLevel)

    const dockerWarning = dockerDowngradeWarning(parsed.flagDefaults)
    if (dockerWarning !== undefined) reporter.log(dockerWarning)

    const protectGitWarning = protectGitHomeWarning(baseRunInput)
    if (protectGitWarning !== undefined) reporter.log(protectGitWarning)

    const initContaminationWarning = initPackContaminationWarning(baseRunInput)
    if (initContaminationWarning !== undefined) reporter.log(initContaminationWarning)

    const packExerciseWarning = packExerciseWithoutCheckWarning(baseRunInput)
    if (packExerciseWarning !== undefined) reporter.log(packExerciseWarning)

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
          protectGit: baseRunInput.protectGit,
        },
        ...(parsed.dockerImage === undefined ? {} : { dockerImage: parsed.dockerImage }),
      }),
      reporter,
      (r) => r.rootPath,
    )
    const { manifest, treePaths } = ws

    // Everything below this point has a run root to write into (`ws.rootPath`,
    // where manifest.json already lives), so a fatal error from here on is
    // captured to `error.json` before it propagates — the pipeline can die at
    // any later phase and still leave a readable record of why, next to
    // whatever partial results already made it to disk.
    return yield* Effect.gen(function* () {
      // --output: when the user gave an explicit output dir (cli or config),
      // report artifacts (report.*, metrics.json, timeline.*, diff/, judge.json,
      // review.code-workspace, preflight.log, install.log, gc.log) land there.
      // Manifest + workspace structure (apps, home, raw, pack, config) stay under
      // <workspace>/<run-id>. Without --output the run tree's results/ is used.
      const customOutput = parsed.outputPathProvided
        ? path.resolve(opts.cwd, baseRunInput.outputPath)
        : undefined
      const resultsDir = customOutput ?? treePaths.results
      const runInput: RunInput = { ...baseRunInput, outputPath: resultsDir }
      const treePathsUsed: WorkspaceTree = customOutput
        ? { ...treePaths, results: customOutput, diff: path.join(customOutput, 'diff') }
        : treePaths

      // run-input.json: the resolved RunInput next to manifest.json, so a
      // post-mortem or a future `report --rebuild` can recover the exact input
      // without re-parsing CLI/config. Redacted, best-effort, never fails the run.
      yield* writeJson(path.join(ws.rootPath, 'run-input.json'), redactRunInput(runInput)).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            reporter.log(warnFsFailure('run-input.json', e))
          }),
        ),
      )

      // 02 repo-clone
      yield* timedPhase(
        2,
        'repo-clone',
        repoClone({ runInput, manifest, workspace: treePathsUsed }),
        reporter,
        () => runInput.repoUrl,
      )

      // 03 pack-install
      const pack = yield* timedPhase(
        3,
        'pack-install',
        packInstall({ runInput, manifest, workspace: treePathsUsed }),
        reporter,
        detailForPack,
      )

      // 04 home-isolation
      const home = yield* timedPhase(
        4,
        'home-isolation',
        homeIsolation({
          runInput,
          manifest,
          workspace: treePathsUsed,
          packInstall: pack,
          ...(parsed.dockerImage === undefined ? {} : { dockerImage: parsed.dockerImage }),
        }),
        reporter,
        () => `${String(runInput.runs * 2)} HOME trees`,
      )

      // 04b pack-setup (sibling of 04, not a numbered phase — same pattern as
      // captureOpencodeConfig below): installs the pack runtime once into
      // homeNew[0] and copies that HOME to every other new-side run, before
      // preflight. No-op (mode "delivered-only") when --pack-setup/
      // --pack-check/--pack-exercise are all absent.
      const newHomePath = home.envVars[1]?.[0]?.PATH
      const start04b = Date.now()
      const packSetupOut = yield* packSetup({
        runInput,
        manifest,
        workspace: treePathsUsed,
        packInstall: pack,
        ...(home.dockerImage === undefined ? {} : { dockerImage: home.dockerImage }),
        ...(newHomePath === undefined ? {} : { newHomePath }),
      })
      // Not a final mode claim: at this point in the pipeline (before
      // preflight's check gate and before any run's exercise) nothing but
      // setup itself has actually completed — the setup phase can only
      // honestly report what IT has done so far. The final mode (which can
      // say "exercised"/"installed-only") is computed once at the end, from
      // what actually ran, and is what the rendered report shows.
      const pendingSteps: readonly string[] = [
        ...(packSetupOut.report.checkDeclared ? ['check'] : []),
        ...(packSetupOut.report.exerciseDeclared ? ['exercise'] : []),
      ]
      const pendingNote = pendingSteps.length === 0 ? '' : ` (${pendingSteps.join('/')} pending)`
      reporter.sub(
        `pack-setup: ${packSetupOut.report.setupDeclared ? 'setup done' : 'no setup declared'}${pendingNote}`,
        Date.now() - start04b,
      )

      // 05 preflight
      const homePaths = {
        old: treePaths.homeOld[0] ?? '',
        new: treePaths.homeNew[0] ?? '',
      }
      const oldHomePath = home.envVars[0]?.[0]?.PATH
      // Gate 6 must verify EVERY HOME, not just index 0 — 04b's copy of the
      // one installed HOME over every other new HOME is exactly the step
      // that can silently fail to carry a working install (see
      // `HomeCheckTarget`'s doc comment in 05-preflight.ts). Pairs each HOME
      // with its own PATH: in docker mode every HOME mounts at the same
      // in-container path so this is the same string per entry, but in host
      // mode each HOME's `.local/bin` is a different absolute path — reusing
      // run-1's PATH to check run-2's HOME would resolve run-1's binary and
      // never catch a divergence.
      const homesForCheck = {
        old: treePaths.homeOld.map((homeDir, idx) => ({
          homeDir,
          pathOverride: home.envVars[0]?.[idx]?.PATH,
        })),
        new: treePaths.homeNew.map((homeDir, idx) => ({
          homeDir,
          pathOverride: home.envVars[1]?.[idx]?.PATH,
        })),
      }
      const preflightResult = yield* timedPhase(
        5,
        'preflight',
        preflight({
          runInput,
          manifest,
          homePaths,
          packInstall: pack,
          configs: { old: home.generatedConfigs.baseline, new: home.generatedConfigs.new },
          homesForCheck,
          ...(home.dockerImage === undefined ? {} : { dockerImage: home.dockerImage }),
          ...(oldHomePath === undefined && newHomePath === undefined
            ? {}
            : {
                homePathEnv: {
                  ...(oldHomePath === undefined ? {} : { old: oldHomePath }),
                  ...(newHomePath === undefined ? {} : { new: newHomePath }),
                },
              }),
        }),
        reporter,
        (r) =>
          runInput.preflightEnabled
            ? `${String(r.checks.length)} checks passed`
            : 'skipped (--no-preflight)',
      )
      const packVisibilityConfirmed = resolvePackVisibilityConfirmed(preflightResult.checks)

      // 06 run-side (old || new, sequential within side)
      reporter.sub(`run-side: ${String(runInput.runs)} run(s) per side`)
      const oldEnvs = home.envVars[0] ?? []
      const newEnvs = home.envVars[1] ?? []
      const start06 = Date.now()
      const both = yield* Effect.all(
        {
          old: runOneSide(
            'old',
            runInput,
            manifest,
            treePathsUsed,
            oldEnvs,
            home.dockerImage,
            reporter,
          ),
          new: runOneSide(
            'new',
            runInput,
            manifest,
            treePathsUsed,
            newEnvs,
            home.dockerImage,
            reporter,
          ),
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
        old: [...both.old.results],
        new: [...both.new.results],
      }

      // Merge phase 04b's setup, gate 6's checks, and the per-run exercises
      // collected above into one PackSetupReport for the whole experiment.
      // Persisted directly (results/pack-setup.json) AND threaded into
      // Report.packSetup below (phase 11's reportInput) for rendering.
      //
      // `mode` is RECOMPUTED here from what actually completed, not carried
      // over from `packSetupOut.report.mode` (that was derived at phase 04b
      // time, before preflight's check gate or any run's exercise had even
      // started — declaration-only, necessarily premature). A non-empty
      // `preflightResult.packChecks` is proof gate 6 ran to completion
      // without aborting the pipeline (a failing check on either side would
      // already have failed the whole run before this point), so it counts
      // as verified; an exercise only counts once at least one attempt
      // actually exited 0 — a run that only ever failed its exercise proves
      // nothing was successfully exercised.
      const checksActuallyRan = (preflightResult.packChecks ?? []).length > 0
      const exerciseActuallySucceeded = both.new.exercises.some((e) => e.exitCode === 0)
      const finalMode = derivePackSetupMode(
        packSetupOut.report.setupDeclared,
        checksActuallyRan,
        exerciseActuallySucceeded,
      )
      const packSetupReport: PackSetupReport = {
        ...packSetupOut.report,
        mode: finalMode,
        checks: [...packSetupOut.report.checks, ...(preflightResult.packChecks ?? [])],
        exercises: [...packSetupOut.report.exercises, ...both.new.exercises],
      }
      const exerciseIntegrityWarning = checkExerciseIntegrity(packSetupReport.exercises)
      if (exerciseIntegrityWarning !== undefined) reporter.log(exerciseIntegrityWarning)
      yield* writeJson(path.join(treePathsUsed.results, 'pack-setup.json'), packSetupReport).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            reporter.log(warnFsFailure('pack-setup.json', e))
          }),
        ),
      )

      // opencode config capture (sibling of 06, not a numbered phase): best-effort,
      // must never fail an otherwise-finished N×2 run.
      yield* captureOpencodeConfig({
        workspace: treePathsUsed,
        runs: runInput.runs,
        generatedConfigs: home.generatedConfigs,
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            reporter.log(`warning: opencode config capture failed: ${e.message}`)
          }),
        ),
      )

      // 07 aggregate
      const agg = yield* timedPhase(
        7,
        'aggregate',
        aggregate({
          runInput,
          manifest,
          workspace: treePathsUsed,
          sideResults,
          packVisibilityConfirmed,
        }),
        reporter,
        (r) => (r.metricsDiff.bothFailed ? 'both sides failed' : 'metricsDiff computed'),
      )

      // 08 diff
      const diffOut = yield* timedPhase(
        8,
        'diff',
        diff({ runInput, manifest, workspace: treePathsUsed }),
        reporter,
        (r) => {
          const all = [...r.diff.old.runs, ...r.diff.new.runs]
          const failed = all.filter((x) => x.state === 'failed').length
          return failed === 0
            ? `${String(all.length)} run patch(es)`
            : `${String(all.length - failed)} run patch(es), ${String(failed)} failed`
        },
      )

      const diffStatus = diffFailureStatus(diffOut.diff)
      const diffWarning = diffFailureWarning(diffStatus)
      if (diffWarning !== undefined) reporter.log(`warning: ${diffWarning}`)

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
        timeline({ runInput, manifest, workspace: treePathsUsed, sideResults }),
        reporter,
        (r) => `${String(r.timeline.old.length + r.timeline.new.length)} events`,
      )

      // summary (built from the diff, not a separate phase). A whole-side
      // diff failure is folded into the headline here — `buildReportSummary`
      // only sees `agg.metricsDiff` (phase 07, computed before diff ever
      // runs), so it has no way to know phase 08 came back empty for a side.
      const rawSummary = buildReportSummary(agg.metricsDiff)
      const summary: ReportSummary =
        diffWarning === undefined
          ? rawSummary
          : { ...rawSummary, headlineResult: `${diffWarning} ${rawSummary.headlineResult}` }

      // 11 report-render
      const reportInput: ReportRenderInput = {
        runInput,
        manifest,
        metricsDiff: agg.metricsDiff,
        timeline: tl.timeline,
        diff: diffOut.diff,
        summary,
        ...(judgeResult === undefined ? {} : { judge: judgeResult }),
        packSetup: packSetupReport,
      }
      const report = yield* timedPhase(
        11,
        'report-render',
        reportRender(reportInput),
        reporter,
        (r) => Object.keys(r.paths).join(', '),
      )
      // Spec invariant: the report is always printed to stdout, in whichever
      // format the user actually requested (md by default, or when both were
      // requested; json only when the user asked for json without md).
      if (report.stdoutMd !== undefined) {
        const stdoutMd = report.stdoutMd
        yield* Effect.sync(() => process.stdout.write(`${stdoutMd}\n`))
      } else if (report.stdoutJson !== undefined) {
        const stdoutJson = report.stdoutJson
        yield* Effect.sync(() => process.stdout.write(stdoutJson))
      }

      // 12 review-workspace
      const review = yield* timedPhase(
        12,
        'review-workspace',
        reviewWorkspace({ runInput, manifest, workspace: treePathsUsed }),
        reporter,
      )

      // 13 cleanup (optional)
      yield* timedPhase(
        13,
        'cleanup',
        cleanup({
          runInput,
          manifest,
          workspace: treePathsUsed,
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
        workspace: treePathsUsed,
        rootPath: ws.rootPath,
        metricsDiff: agg.metricsDiff,
        reportPaths: report.paths,
        reviewCommand: review.command,
        summary: summary.headlineResult,
        diffEscalated: diffStatus.escalate,
      }
    }).pipe(
      Effect.tapError((e) =>
        writeJson(path.join(ws.rootPath, 'error.json'), serializePhaseError(e)).pipe(Effect.ignore),
      ),
    )
  })
