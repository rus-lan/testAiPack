/**
 * Phase orchestration: wires phases 00–13 into one Effect pipeline with
 * progress reporting. Each phase runs under a timed wrapper that emits a
 * completion line; phase 06 (run-side) runs the run's variants concurrently
 * (bounded by `runInput.parallel`) with N runs sequential within each variant.
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
  DiffResult,
  DiffRunResult,
  EnvVarSet,
  HomeCheckTarget,
  JudgeResult,
  Manifest,
  MetricsReport,
  PackCmdResult,
  PreflightCheck,
  PrepReport,
  ReportRenderInput,
  ReportRenderResult,
  ReportSummary,
  RunInput,
  VariantSpec,
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
// TODO(WP15): unmock — 00-cli-parse.ts (WP2) owns cliParse + the shared
// helpers below; tests here vi.mock this whole import until WP2 lands (same
// pattern already used by 06-run-side.ts and 05-preflight.ts).
import { cliParse, effectiveOf, foreignPacksOf, packShortName, packsOf } from '../phases/00-cli-parse.js'
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
import type { PackVisibilityEntry } from '../phases/07-aggregate.js'
import { diff } from '../phases/08-diff.js'
import { judge } from '../phases/09-judge.js'
import { timeline } from '../phases/10-timeline.js'
import { reportRender } from '../phases/11-report-render.js'
import { reviewWorkspace } from '../phases/12-review-workspace.js'
import { cleanup } from '../phases/13-cleanup.js'
import { buildReportSummary } from './summary.js'
import { withLogLevel } from './progress.js'
import type { ProgressReporter } from './progress.js'

/** 14 phases: cli-parse(00) … cleanup(13). */
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
  readonly metrics: MetricsReport
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
 * D2 (`00-overview.md` §5): in v1, `--no-pure-baseline` was decorative
 * outside the parser — it never reached the env, so passing it changed
 * nothing about the run. Phase 00's legacy shim now desugars it into the
 * `old` variant's real `pure: false`, which genuinely disables that
 * variant's purity env vars — a behavior change worth telling the user
 * about, once, only on the legacy (flag-based) invocation path phase 00
 * marks via `flagDefaults.legacyShim`. Silent on v2 variant-mode configs,
 * where `pure: false` on any variant is an ordinary, intentional choice.
 */
export const legacyShimImpureBaselineWarning = (
  flagDefaults: Readonly<Record<string, unknown>>,
  runInput: RunInput,
): string | undefined => {
  if (flagDefaults['legacyShim'] !== true) return undefined
  const old = runInput.variants.find((v) => v.name === 'old')
  if (old === undefined || old.pure !== false) return undefined
  return "warning: --no-pure-baseline now genuinely disables the baseline's purity isolation (OPENCODE_PURE and friends) — in earlier versions this flag had no effect on the run itself"
}

/** Below this length a substring match is mostly noise (e.g. a pack ref like `npm:x`). */
const PACK_NAME_MIN_LENGTH = 3

/**
 * A "pure" variant (D1: `variant.pure ?? packs.length === 0`) is meant to be
 * unaware of every OTHER variant's packs — but its effective init/prompt can
 * still name a foreign pack by accident (a slash command, a tool name),
 * quietly turning "pure" into a claim the run itself falsifies. Generalizes
 * the v1 single global warning (`--pure-baseline` + `--init` mentioning
 * `--pack`) to every (pure variant, foreign pack) pair whose combined
 * effective init+prompt text mentions the pack's short name. A warning, not
 * a hard failure: dependency-setup text genuinely can share vocabulary with a
 * pack name, so this only flags the case that looks like a trigger.
 */
export const initPackContaminationWarnings = (runInput: RunInput): readonly string[] =>
  runInput.variants.flatMap((v) => {
    const pure = v.pure ?? v.packs.length === 0
    if (!pure) return []
    const initText = effectiveOf(v, runInput.init, 'init') ?? ''
    const promptText = effectiveOf(v, runInput.prompt, 'prompt') ?? ''
    const combined = `${initText} ${promptText}`.toLowerCase()
    if (combined.trim() === '') return []
    return foreignPacksOf(runInput, v).flatMap((pack) => {
      const name = packShortName(pack.ref)
      if (name.length < PACK_NAME_MIN_LENGTH) return []
      if (!combined.includes(name)) return []
      return [
        `warning: variant "${v.name}" is pure but its init/prompt looks like it references the foreign pack "${name}" (declared on a different variant) — contaminating the comparison.`,
      ]
    })
  })

/**
 * `variant.exercise` runs a pack's pipeline once per run, before the agent
 * session starts, but nothing confirms the pack is functional first unless
 * at least one of the variant's own packs declares a `check` — an exercise
 * against a broken install just fails every run for a reason the report
 * can't distinguish from "the model never used it". Generalizes the v1
 * single `--pack-exercise`/`--pack-check` pair to one warning per exercising
 * variant. Non-fatal: `check` stays recommended, not required.
 */
export const packExerciseWithoutCheckWarnings = (runInput: RunInput): readonly string[] =>
  runInput.variants.flatMap((v) => {
    if (v.exercise === undefined) return []
    const hasCheck = packsOf(runInput, v).some((p) => p.check !== undefined)
    if (hasCheck) return []
    return [
      `warning: variant "${v.name}" has an exercise but none of its packs declare a check — the pack's "functional" claim is unverified before exercising; a broken install fails every run without a clear reason`,
    ]
  })

/**
 * Gate 4 (`pack-visibility`, `05-preflight.ts`) tags a passing check's
 * `details` with `pack-visibility [<variant>/<pack>]`, one check per declared
 * pack; a variant with no declared packs gets `details: 'skipped (no pack)'`
 * instead — that means "not applicable", not "confirmed visible", and must
 * never produce an entry (the regex below simply never matches it). Returns
 * one `PackVisibilityEntry` per confirmed (variant, pack) pair, the exact
 * shape phase 07's `AggregateInputExt.packVisibility` consumes.
 */
const PACK_VISIBILITY_DETAIL_RE = /^pack-visibility \[([^/\]]+)\/([^\]]+)\]/

export const resolvePackVisibilityConfirmed = (
  checks: readonly PreflightCheck[],
): readonly PackVisibilityEntry[] =>
  checks.flatMap((c) => {
    if (c.name !== 'pack-visibility') return []
    const m = PACK_VISIBILITY_DETAIL_RE.exec(c.details ?? '')
    if (m === null) return []
    const variant = m[1]
    const pack = m[2]
    if (variant === undefined || pack === undefined) return []
    return [{ variant, pack, confirmed: c.passed }]
  })

/**
 * Redacts the same field `buildManifest` already redacts
 * (`src/phases/01-workspace-setup.ts`) before the resolved `RunInput` is
 * persisted for post-mortem / rebuild: `repoUrl`, plus every registry pack's
 * `ref` (a git URL's userinfo, or an inline `mcp:<name>:<config>` ref's `env`
 * block, can carry a credential).
 */
export const redactRunInput = (runInput: RunInput): RunInput => ({
  ...runInput,
  repoUrl: redactUrlCredentials(runInput.repoUrl),
  packs: runInput.packs.map((p) => ({
    ...p,
    ref: safeRefDisplay(redactUrlCredentials(p.ref)),
  })),
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
 * artifacts an exercise left behind — doubles as a determinism tripwire (the
 * report can flag cross-run divergence of a nondeterministic pack pipeline).
 * Directory entries contribute only their path (their files are hashed
 * individually when git lists them).
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
 * without spinning up the pipeline; called once per variant after all its
 * exercises complete, over their `PackCmdResult[]`. A crashed/timed-out
 * exercise (`exitCode !== 0`, the `ex.kind === 'failed'` branch in
 * `runOneVariant`) is filtered out FIRST — that failure is already surfaced
 * loudly via `E_PACK_EXERCISE_FAILED` and the `reporter.sub(... "exercise
 * failed" ...)` line, so judging it here too would report the opposite of
 * what happened ("exited 0 ... no-op" on a run that never exited 0 at all).
 * Only runs that genuinely exited 0 are judged on whether they left an
 * artifact (`artifactHash` defined) or a divergent one. Cross-variant
 * divergence is expected when inputs differ, so this is scoped to one
 * variant's own exercises only.
 */
export const checkExerciseIntegrity = (exercises: readonly PackCmdResult[]): string | undefined => {
  const ran = exercises.filter((e) => e.exitCode === 0)
  if (ran.length === 0) return undefined
  const withHash = ran.flatMap((e) => (e.artifactHash === undefined ? [] : [e.artifactHash]))
  if (withHash.length === 0) {
    return `warning: exercise exited 0 but left no artifact on any of ${String(ran.length)} run(s) — indistinguishable from a no-op; verify it actually ran the pack's pipeline`
  }
  const distinct = new Set(withHash)
  if (distinct.size > 1) {
    return `warning: exercise produced ${String(distinct.size)} distinct artifact hash(es) across ${String(withHash.length)} run(s) that left output — the pack pipeline may be non-deterministic`
  }
  return undefined
}

/** `.git` dir for one run's app tree — outside it under `--protect-git`, inside it otherwise. */
const gitDirFor = (
  protectGit: boolean,
  appDir: string,
  gitDirsForVariant: readonly string[],
  idx: number,
): string => (protectGit ? (gitDirsForVariant[idx] ?? path.join(appDir, '.git')) : path.join(appDir, '.git'))

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
 * Runs a variant's `exercise` once, before its agent session starts (§5.5 of
 * the pack-setup spec). A command failure/timeout CONTAINS this one run —
 * the agent session is never started, the run is synthesized as failed with
 * `E_PACK_EXERCISE_FAILED` (the exact corruption the spec exists to
 * prevent: a run where the tool never worked must never silently count as a
 * measured "after" run). A tracked-file modification aborts the whole
 * experiment (`E_PACK_EXERCISE_DIRTY`) — that kind of contamination cannot
 * be fixed by excluding a path after the fact. Untracked paths (the
 * exercise's own output) are appended to `.git/info/exclude` so `git add -A`
 * (phase 08) never stages them, and persisted to `run-N.exercise.json` so
 * phase 08 can re-apply the same excludes after a `.git` restore. The
 * `pack` field is deliberately absent on both `PackCmdResult`s produced here
 * — an exercise belongs to the variant, not any one of its packs.
 */
const runPackExercise = (
  cmd: string,
  homeEnv: EnvVarSet,
  appDir: string,
  gitDir: string,
  rawDir: string,
  docker: DockerExec | undefined,
  timeoutMs: number,
  variant: string,
  runIndex: number,
): Effect.Effect<ExerciseOutcome, PhaseError> =>
  Effect.gen(function* () {
    const outcome = yield* runShellInHome(cmd, homeEnv.HOME, appDir, docker, timeoutMs, homeEnv.PATH)

    if (outcome.timedOut || outcome.exitCode !== 0) {
      yield* excludeFailedExerciseArtifacts(appDir, gitDir, rawDir, runIndex)
      const cmdResult: PackCmdResult = {
        variant,
        runIndex,
        exitCode: outcome.exitCode,
        durationMs: String(outcome.durationMs),
        outputTail: outcome.outputTail,
      }
      const result: RunSideResultExt = {
        variant,
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
          packSetupError(`cannot verify exercise diff hygiene (git status failed): ${e.stderr}`, 'E_PACK_EXERCISE_FAILED', {
            variant,
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
          `exercise modified tracked file(s): ${dirtyTracked.map((s) => s.path).join(', ')}`,
          'E_PACK_EXERCISE_DIRTY',
          { variant, runIndex, paths: dirtyTracked.map((s) => s.path) },
        ),
      )
    }

    const untrackedPaths = statuses.filter((s) => s.code === '??').map((s) => s.path)
    if (untrackedPaths.length > 0) {
      yield* appendInfoExclude(gitDir, untrackedPaths).pipe(
        Effect.mapError(
          (e: FsError): PhaseError =>
            packSetupError(`cannot exclude exercise artifacts: ${e.path}`, 'E_PACK_EXERCISE_FAILED', { variant, runIndex }),
        ),
      )
    }
    const artifactHash =
      untrackedPaths.length === 0 ? undefined : yield* computeArtifactHash(appDir, untrackedPaths)

    yield* ensureDir(rawDir).pipe(
      Effect.mapError(
        (e: FsError): PhaseError =>
          packSetupError(`cannot create raw dir for exercise record: ${e.path}`, 'E_PACK_EXERCISE_FAILED', { variant, runIndex }),
      ),
    )
    yield* writeJson(path.join(rawDir, `run-${String(runIndex)}.exercise.json`), {
      excludedPaths: untrackedPaths,
      ...(artifactHash === undefined ? {} : { artifactHash }),
    }).pipe(Effect.catchAll(() => Effect.void))

    const cmdResult: PackCmdResult = {
      variant,
      runIndex,
      exitCode: outcome.exitCode,
      durationMs: String(outcome.durationMs),
      outputTail: outcome.outputTail,
      ...(artifactHash === undefined ? {} : { artifactHash }),
    }
    return { kind: 'ok', cmdResult, setupWallMs: outcome.durationMs }
  })

interface VariantRunOutcome {
  readonly name: string
  readonly results: readonly RunSideResultExt[]
  readonly exercises: readonly PackCmdResult[]
}

const runOneVariant = (
  v: VariantSpec,
  runInput: RunInput,
  manifest: Manifest,
  workspace: WorkspaceTree,
  envs: readonly EnvVarSet[],
  dockerImage: string | undefined,
  reporter: ProgressReporter,
): Effect.Effect<VariantRunOutcome, PhaseError> =>
  Effect.gen(function* () {
    const docker: DockerExec | undefined =
      runInput.isolation === 'docker'
        ? {
            image: dockerImage ?? DEFAULT_OPENCODE_IMAGE,
            ...(runInput.dockerNetwork === undefined ? {} : { network: runInput.dockerNetwork }),
          }
        : undefined
    const exerciseCmd = v.exercise
    const exerciseTimeoutMs = runInput.timeouts.installSeconds * 1000
    const variantTree = workspace.variantTrees.find((vt) => vt.name === v.name)
    const appList = variantTree?.apps ?? []
    const gitDirsForVariant = variantTree?.gitDirs ?? []
    const rawDir = path.join(workspace.raw, v.name)

    const outcomes = yield* Effect.forEach(
      range(runInput.runs),
      (idx) =>
        Effect.gen(function* () {
          const runIndex = idx + 1
          const homeEnv = envs[idx]
          if (homeEnv === undefined) {
            return yield* Effect.fail(
              runSideError(`missing HOME env for variant "${v.name}" run ${String(runIndex)}`, 'E_RUN_CRASH', {
                variant: v.name,
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
              variant: v,
              runIndex,
              sessionId: '',
              ...(dockerImage === undefined ? {} : { dockerImage }),
            }).pipe(
              Effect.tap((r) =>
                Effect.sync(() => {
                  reporter.sub(`${v.name}/run-${String(runIndex)}/${String(runInput.runs)}`, Number(r.durationMs))
                }),
              ),
            )

          if (exerciseCmd === undefined) {
            const result = yield* runAgent()
            return { result, exercise: undefined as PackCmdResult | undefined }
          }

          const appDir = appList[idx] ?? ''
          const gitDir = gitDirFor(runInput.protectGit, appDir, gitDirsForVariant, idx)
          const ex = yield* runPackExercise(exerciseCmd, homeEnv, appDir, gitDir, rawDir, docker, exerciseTimeoutMs, v.name, runIndex)
          if (ex.kind === 'failed') {
            reporter.sub(`${v.name}/run-${String(runIndex)}/${String(runInput.runs)} (exercise failed, agent session skipped)`, Number(ex.result.durationMs))
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
      name: v.name,
      results: outcomes.map((o) => o.result),
      exercises: outcomes.flatMap((o) => (o.exercise === undefined ? [] : [o.exercise])),
    }
  })

const detailForPack = (p: PackInstallOutcome): string => {
  if (p.deliveries.length === 0) return 'smoke-test (no pack)'
  return p.deliveries
    .map((d) => {
      const named = d.instructions.find((i) => i.kind !== 'config')
      const label = named === undefined ? d.pack : named.name
      return `${String(d.detectedType)}: ${label}`
    })
    .join(', ')
}

// ---------------------------------------------------------------------------
// diff-side escalation: over DiffResult[] (one per variant) instead of the v1
// {old,new} pair — escalates when ANY variant's diffs all failed.
// ---------------------------------------------------------------------------

export interface VariantDiffFailure {
  readonly variant: string
  readonly failed: number
  readonly total: number
}

export interface DiffFailureStatus {
  readonly perVariant: readonly VariantDiffFailure[]
  readonly failedVariants: readonly string[]
  readonly escalate: boolean
}

const countFailedRuns = (runs: readonly DiffRunResult[]): number =>
  runs.filter((r) => r.state === 'failed').length

/**
 * A contained per-run diff failure (`state: "failed"`) is expected to happen
 * occasionally and stays quiet in the headline — that is the whole point of
 * containment (phase 08 keeps going instead of aborting). An entire
 * variant's diffs failing is a different signal: the comparison has nothing
 * to show for that variant, so it needs to be loud rather than read like an
 * ordinary "N improvements, M regressions" run.
 */
export const diffFailureStatus = (diffs: readonly DiffResult[]): DiffFailureStatus => {
  const perVariant = diffs.map((d) => ({
    variant: d.variant,
    failed: countFailedRuns(d.runs),
    total: d.runs.length,
  }))
  const failedVariants = perVariant.filter((v) => v.total > 0 && v.failed === v.total).map((v) => v.variant)
  return { perVariant, failedVariants, escalate: failedVariants.length > 0 }
}

export const diffFailureWarning = (status: DiffFailureStatus): string | undefined => {
  if (!status.escalate) return undefined
  const parts = status.failedVariants.map((name) => {
    const v = status.perVariant.find((p) => p.variant === name)
    return `${name}: ${String(v?.failed ?? 0)}/${String(v?.total ?? 0)} run(s) failed (worktree broken)`
  })
  return `diff unavailable — ${parts.join('; ')}. The metrics above do not include these runs' code changes.`
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

    for (const w of initPackContaminationWarnings(baseRunInput)) reporter.log(w)
    for (const w of packExerciseWithoutCheckWarnings(baseRunInput)) reporter.log(w)

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
        (r) => `${String(r.homeTrees.reduce((n, vh) => n + vh.trees.length, 0))} HOME trees`,
      )

      // 04b pack-setup (sibling of 04, not a numbered phase — same pattern as
      // captureOpencodeConfig below): installs each pack's runtime once per
      // (declaring variant, pack) into that variant's run-1 HOME and copies it
      // over the variant's other HOMEs, before preflight. No-op (every pack's
      // mode stays "delivered-only") when no registry pack declares `setup`/
      // `check` and no variant declares `exercise`.
      //
      // Passes the full per-variant `envVars` (phase 04's output) so 04b can
      // look up any declaring variant's run-1 `EnvVarSet.PATH` itself —
      // confirmed against WP4's landed `PackSetupInputExt.envVars?: readonly
      // VariantEnv[]`.
      const start04b = Date.now()
      const packSetupOut = yield* packSetup({
        runInput,
        manifest,
        workspace: treePathsUsed,
        packInstall: pack,
        envVars: home.envVars,
        ...(home.dockerImage === undefined ? {} : { dockerImage: home.dockerImage }),
      })
      const anySetupDeclared = packSetupOut.report.packs.some((p) => p.setupDeclared)
      const anyCheckDeclared = packSetupOut.report.packs.some((p) => p.checkDeclared)
      const anyExerciseDeclared = packSetupOut.report.variants.some((v) => v.exerciseDeclared)
      // Not a final mode claim: at this point in the pipeline (before
      // preflight's check gate and before any run's exercise) nothing but
      // setup itself has actually completed — the setup phase can only
      // honestly report what IT has done so far. The final per-pack mode
      // (which can say "exercised"/"installed-only") is recomputed below from
      // what actually ran, and is what the rendered report shows.
      const pendingSteps: readonly string[] = [
        ...(anyCheckDeclared ? ['check'] : []),
        ...(anyExerciseDeclared ? ['exercise'] : []),
      ]
      const pendingNote = pendingSteps.length === 0 ? '' : ` (${pendingSteps.join('/')} pending)`
      reporter.sub(
        `pack-setup: ${anySetupDeclared ? 'setup done' : 'no setup declared'}${pendingNote}`,
        Date.now() - start04b,
      )

      // 05 preflight
      //
      // No explicit `: VariantHomesForCheck[]`/`: HomeCheckTarget[]` array
      // annotation here — `PreflightInputExt.homesForCheck` (inherited from
      // the wire contract) is a mutable `Array<VariantHomesForCheck>`, and an
      // explicit `readonly` local would no longer be assignable to it; the
      // plain inferred type from `.map()` is already the right (mutable)
      // shape without needing the annotation at all.
      const homesForCheck = runInput.variants.map((v) => {
        const homeDirs = treePathsUsed.variantTrees.find((vt) => vt.name === v.name)?.homes ?? []
        const envsForVariant = home.envVars.find((e) => e.name === v.name)?.envs ?? []
        // Gate 6 must verify EVERY HOME, not just run-1 — 04b's copy of the
        // one installed HOME over every other HOME of a variant is exactly the
        // step that can silently fail to carry a working install (see
        // `HomeCheckTarget`'s doc comment in 05-preflight.ts). Pairs each HOME
        // with its own PATH: in docker mode every HOME mounts at the same
        // in-container path so this is the same string per entry, but in host
        // mode each HOME's `.local/bin` is a different absolute path — reusing
        // run-1's PATH to check run-2's HOME would resolve run-1's binary and
        // never catch a divergence.
        const homes: readonly HomeCheckTarget[] = homeDirs.map((homeDir, idx) => {
          const env = envsForVariant[idx]
          // A missing env ENTRY (not just an absent `.PATH`, which is the
          // ordinary "no pack declares setup" case) means phase 04 never
          // produced this (variant, run) pair at all — defensive only
          // (phase 04 always emits one entry per variant per run), but
          // silently falling back to the default PATH here would let gate 6
          // resolve a same-named binary already on the host instead of
          // honestly failing to find the pack's — worth a loud warning, not
          // worth aborting the run over.
          if (env === undefined) {
            reporter.log(
              `warning: no env entry for variant "${v.name}" run ${String(idx + 1)} — gate 6 will probe its HOME with the default PATH instead of the one phase 04 built for it`,
            )
          }
          const p = env?.PATH
          return { homeDir, ...(p === undefined ? {} : { pathOverride: p }) }
        })
        return { name: v.name, homes: [...homes] }
      })
      const preflightResult = yield* timedPhase(
        5,
        'preflight',
        preflight({
          runInput,
          manifest,
          homesForCheck,
          packInstall: pack,
          configs: home.generatedConfigs,
          ...(home.dockerImage === undefined ? {} : { dockerImage: home.dockerImage }),
        }),
        reporter,
        (r) =>
          runInput.preflightEnabled
            ? `${String(r.checks.length)} checks passed`
            : 'skipped (--no-preflight)',
      )
      const packVisibility = resolvePackVisibilityConfirmed(preflightResult.checks)

      // 06 run-side (variants concurrent up to runInput.parallel, runs within
      // a variant sequential)
      reporter.sub(`run-side: ${String(runInput.runs)} run(s) per variant × ${String(runInput.variants.length)} variant(s)`)
      const start06 = Date.now()
      const variantOutcomes = yield* Effect.all(
        runInput.variants.map((v) => {
          const envs = home.envVars.find((e) => e.name === v.name)?.envs ?? []
          return runOneVariant(v, runInput, manifest, treePathsUsed, envs, home.dockerImage, reporter)
        }),
        { concurrency: runInput.parallel },
      )
      reporter.phaseDone({
        index: 6,
        total: PHASE_COUNT,
        label: 'run-side',
        durationMs: Date.now() - start06,
        detail: `${String(runInput.runs)} run(s) × ${String(runInput.variants.length)} variant(s)`,
      })
      const variantRunResults = variantOutcomes.map((o) => ({
        name: o.name,
        runs: [...o.results],
      }))

      // Merge phase 04b's per-pack setups, gate 6's per-pack checks, and the
      // per-variant exercises collected above into one PrepReport for the
      // whole experiment. Persisted as results/prep.json AND threaded into
      // Report.prep below (phase 11's reportInput) for rendering.
      //
      // Each pack's `mode` is RECOMPUTED here from what actually completed,
      // not carried over from `packSetupOut.report.packs[*].mode` (that was
      // derived at phase 04b time, before preflight's check gate or any run's
      // exercise had even started — declaration-only, necessarily premature).
      // `checksActuallyRan` requires a PASSING check from a DECLARING
      // variant, not just a non-empty `checksForPack` — gate 6 runs every
      // registry pack's check against every variant, declaring or not, and
      // a foreign variant's result is REQUIRED to be non-zero (that is the
      // gate's whole point), so `checksForPack.length > 0` alone would call
      // a pack "verified" from nothing but its own required-to-fail foreign
      // rows — exactly what happens for a registry pack no variant declares
      // (phase 00 does not reject one). An exercise only counts once at
      // least one declaring variant's attempt actually exited 0 — a pack
      // whose every declaring variant only ever failed its exercise proves
      // nothing was successfully exercised (D12). `checks` below still
      // merges every row, passing or failing, foreign or declaring — that
      // is the honest per-pack audit trail; only the mode-recompute reads it
      // selectively.
      const variantExercises = new Map<string, readonly PackCmdResult[]>(
        variantOutcomes.map((o) => [o.name, o.exercises]),
      )
      // Grouped by a plain filter (not a manually built Map) — the registry
      // is small, and this sidesteps mutating a Map/array accumulator.
      const packChecks = preflightResult.packChecks ?? []
      const finalPacks = packSetupOut.report.packs.map((p) => {
        const checksForPack = packChecks.filter((c) => c.pack === p.pack)
        const declaringVariants = runInput.variants.filter((v) => v.packs.includes(p.pack))
        const declaringNames = new Set(declaringVariants.map((v) => v.name))
        const checksActuallyRan = checksForPack.some((c) => c.exitCode === 0 && declaringNames.has(c.variant))
        const exerciseSucceeded = declaringVariants.some((v) =>
          (variantExercises.get(v.name) ?? []).some((e) => e.exitCode === 0),
        )
        return {
          ...p,
          mode: derivePackSetupMode(p.setupDeclared, checksActuallyRan, exerciseSucceeded),
          checks: [...p.checks, ...checksForPack],
        }
      })
      const finalVariants = packSetupOut.report.variants.map((v) => ({
        ...v,
        exercises: [...v.exercises, ...(variantExercises.get(v.variant) ?? [])],
      }))
      const prepReport: PrepReport = { packs: finalPacks, variants: finalVariants }

      for (const o of variantOutcomes) {
        const w = checkExerciseIntegrity(o.exercises)
        if (w !== undefined) reporter.log(`[${o.name}] ${w}`)
      }
      yield* writeJson(path.join(treePathsUsed.results, 'prep.json'), prepReport).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => {
            reporter.log(warnFsFailure('prep.json', e))
          }),
        ),
      )

      // opencode config capture (sibling of 06, not a numbered phase): best-effort,
      // must never fail an otherwise-finished run.
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
          results: variantRunResults,
          packVisibility,
        }),
        reporter,
        (r) => (r.metrics.allFailed ? 'all variants failed' : 'metrics computed'),
      )

      // 08 diff
      const diffOut = yield* timedPhase(
        8,
        'diff',
        diff({ runInput, manifest, workspace: treePathsUsed }),
        reporter,
        (r) => {
          const all = r.diffs.flatMap((d) => d.runs)
          const failed = all.filter((x) => x.state === 'failed').length
          return failed === 0
            ? `${String(all.length)} run patch(es)`
            : `${String(all.length - failed)} run patch(es), ${String(failed)} failed`
        },
      )

      const diffStatus = diffFailureStatus(diffOut.diffs)
      const diffWarning = diffFailureWarning(diffStatus)
      if (diffWarning !== undefined) reporter.log(`warning: ${diffWarning}`)

      // 09 judge (optional)
      const judgeOut = yield* timedPhase(
        9,
        'judge',
        judge({ runInput, manifest, diffs: diffOut.diffs }),
        reporter,
        (r) => (r.judge === null ? 'skipped (no --judge)' : 'verdict recorded'),
      )
      const judgeResult = resolveJudge(judgeOut.judge)

      // 10 timeline
      const tl = yield* timedPhase(
        10,
        'timeline',
        timeline({ runInput, manifest, workspace: treePathsUsed, results: variantRunResults }),
        reporter,
        (r) => `${String(r.timeline.lanes.reduce((n, l) => n + l.events.length, 0))} events`,
      )

      // summary (built from the metrics report, not a separate phase). A
      // whole-variant diff failure is folded into the headline here —
      // `buildReportSummary` only sees `agg.metrics` (phase 07, computed
      // before diff ever runs), so it has no way to know phase 08 came back
      // empty for a variant.
      const rawSummary = buildReportSummary(agg.metrics)
      const summary: ReportSummary =
        diffWarning === undefined
          ? rawSummary
          : { ...rawSummary, headlineResult: `${diffWarning} ${rawSummary.headlineResult}` }

      // 11 report-render
      const reportInput: ReportRenderInput = {
        runInput,
        manifest,
        metrics: agg.metrics,
        timeline: tl.timeline,
        diffs: diffOut.diffs,
        summary,
        ...(judgeResult === undefined ? {} : { judge: judgeResult }),
        prep: prepReport,
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

      const improvements = summary.perVariant.reduce((n, v) => n + v.improvements.length, 0)
      const regressions = summary.perVariant.reduce((n, v) => n + v.regressions.length, 0)
      reporter.done(
        `${String(improvements)} improvement(s), ${String(regressions)} regression(s). Report: ${report.paths.md ?? '<none>'}`,
      )

      return {
        runId,
        manifest,
        workspace: treePathsUsed,
        rootPath: ws.rootPath,
        metrics: agg.metrics,
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
