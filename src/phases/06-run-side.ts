/**
 * Phase 06: run-side
 *
 * Executes ONE variant for ONE run index: `--init` (optional) → `--prompt` →
 * `opencode export`, with a soft hang-watchdog and a hard run timeout, then
 * optionally runs the `--verify` shell command. Crash / hang / timeout /
 * context-overflow / rate-limit / a missing or invalid export are all VALID
 * run outcomes returned with `successRank: 0` and an `errorCode`; only a
 * genuine `E_DISK_FULL` (machine-global, not this run's problem) fails the
 * phase.
 *
 * @see docs/phases/06-run-side.ru.md
 * @see contract/phases/06-run-side.tsp
 */
import { Effect, Schedule } from 'effect'
import type { Either } from 'effect'
import path from 'node:path'
import type {
  EnvVarSet,
  ErrorCode,
  FinishCause,
  RunInput,
  RunResult,
  RunSideInput,
  SuccessRank,
  VariantSpec,
} from '@generated/types'
import { opencodeExportSchema } from '@generated/schemas'
import { run as opencodeRun, exportSession, sessionIdFromEvent } from '../opencode/cli.js'
import type { DockerExec, OpencodeError, OpencodeRunOptions, OpencodeRunResult } from '../opencode/cli.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import { spawnProcess } from '../opencode/spawn.js'
import { appendFile, ensureDir, readJson, writeFile, writeJson } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import type { PhaseError } from '../errors.js'
import { runSideError } from '../errors.js'
// TODO(WP15): unmock — 00-cli-parse.ts (WP2) owns effectiveOf; tests here
// vi.mock this import until WP2 lands.
import { effectiveOf } from './00-cli-parse.js'

/** Consecutive identical tool calls above which a run with no clean finish is a doom-loop. */
export const DOOM_LOOP_THRESHOLD = 10
/** Watchdog poll interval (ms). The loop also resets on every streamed event. */
const WATCHDOG_POLL_MS = 100

/**
 * `opencode export` can return truncated JSON when invoked immediately after a
 * clean run finishes — the session store is still flushing. A fresh export
 * moments later reads back valid; bound the retry so a genuinely broken
 * export still fails fast.
 */
export const EXPORT_VALIDATION_MAX_RETRIES = 3
const EXPORT_VALIDATION_BASE_DELAY = '200 millis'
const EXPORT_VALIDATION_MAX_WAIT = '3 seconds'

const exportRetrySchedule = Schedule.exponential(EXPORT_VALIDATION_BASE_DELAY).pipe(
  Schedule.intersect(Schedule.recurs(EXPORT_VALIDATION_MAX_RETRIES)),
  Schedule.upTo(EXPORT_VALIDATION_MAX_WAIT),
)

type RunSideErrorCode =
  | 'E_RUN_TIMEOUT'
  | 'E_RUN_HANG_WATCHDOG'
  | 'E_RUN_CRASH'
  | 'E_VERIFY_TIMEOUT'
  | 'E_VERIFY_FAILED'
  | 'E_RATE_LIMIT_EXHAUSTED'
  | 'E_OOM'
  | 'E_DISK_FULL'
  | 'E_PORT_CONFLICT'
  | 'E_EXPORT_INVALID'
  | 'E_TOTAL_TIMEOUT'

/**
 * Local extension of the contract RunResult, pinned by the WP1 review-gate
 * arbitration (`04-work-packages.md` §WP6). The contract's `RunResult`
 * already carries `errorCode?: ErrorCode` (v2), so this is currently an
 * identity extension — kept as the named export WP12/WP13 are spec'd to
 * consume rather than importing `RunResult` directly, so the phase-06-local
 * name survives if the contract's field shape ever drifts from this phase's
 * needs.
 */
export type RunSideResultExt = RunResult & {
  readonly errorCode?: ErrorCode
}

/**
 * Local extension of the contract RunSideInput: the wire contract's
 * `variant: string` is replaced with the full `VariantSpec` — the run needs
 * `prompt`/`init`/`hint`/`verify`/`pure` per variant, not just its name — plus
 * `dockerImage` (resolved by phase 04) so that when
 * `runInput.isolation === 'docker'` the opencode run + export execute inside
 * the container. Cannot `extends RunSideInput` (the `variant` field's type
 * changes, not just widens) so it's built as an `Omit` + replace instead.
 */
export type RunSideInputExt = Omit<RunSideInput, 'variant'> & {
  readonly variant: VariantSpec
  readonly dockerImage?: string
}

const fail = (
  message: string,
  code: RunSideErrorCode,
  variant: string,
  runIndex: number,
  context?: Record<string, unknown>,
): PhaseError =>
  runSideError(message, code, {
    variant,
    runIndex,
    ...(context === undefined ? {} : context),
  })

const failFs = (
  e: { readonly operation: string; readonly path: string },
  variant: string,
  runIndex: number,
): PhaseError =>
  fail(`filesystem error during run: ${e.operation} ${e.path}`, 'E_DISK_FULL', variant, runIndex, {
    path: e.path,
    operation: e.operation,
  })

// ---------------------------------------------------------------------------
// Pure: task prompt
// ---------------------------------------------------------------------------

/**
 * The task prompt actually sent to `--prompt`: the variant's effective prompt
 * (its own `prompt`, else the global `runInput.prompt`) with the variant's
 * effective hint appended after a blank line. Both go through `effectiveOf`
 * (D7): a variant field explicitly set to `''` disables the global instead of
 * falling back to it. Unlike the old side-blind `packHint`, this text now
 * legitimately differs across variants — the report discloses each variant's
 * hint separately (03-hard-problems.md §4).
 */
export const effectiveTaskPrompt = (runInput: RunInput, variant: VariantSpec): string => {
  const prompt = effectiveOf(variant, runInput.prompt, 'prompt') ?? ''
  const hint = effectiveOf(variant, runInput.hint, 'hint')
  return hint === undefined || hint === '' ? prompt : `${prompt}\n\n${hint}`
}

// ---------------------------------------------------------------------------
// Pure outcome analysis
// ---------------------------------------------------------------------------

const FINISH_VALUES: readonly string[] = ['stop', 'tool-calls', 'length', 'error', 'other', 'unknown']

const mapReasonToFinish = (raw: string): FinishCause | undefined => {
  const r = raw.toLowerCase()
  if (r === '') return undefined
  if (r.includes('stop') || r.includes('end_turn') || r.includes('end turn') || r.includes('end-turn')) {
    return 'stop'
  }
  if (
    r.includes('length') ||
    r.includes('max_token') ||
    r.includes('max token') ||
    r.includes('maxtokens') ||
    r.includes('context_length') ||
    r.includes('context length')
  ) {
    return 'length'
  }
  if (r.includes('tool')) return 'tool-calls'
  if (r.includes('error')) return 'error'
  return undefined
}

const asFinishCause = (s: string): FinishCause | undefined => {
  if (FINISH_VALUES.includes(s)) return s as FinishCause
  return mapReasonToFinish(s)
}

const finishFromEvent = (ev: unknown): FinishCause | undefined => {
  if (!isRecord(ev)) return undefined
  const direct = ev['finish']
  if (typeof direct === 'string') {
    const m = asFinishCause(direct)
    if (m !== undefined) return m
  }
  const info = ev['info']
  if (isRecord(info)) {
    const f = info['finish']
    if (typeof f === 'string') {
      const m = asFinishCause(f)
      if (m !== undefined) return m
    }
  }
  // opencode streams two shapes that carry a finish reason:
  //  - export part: { type: "step-finish", reason }
  //  - streamed run event: { type: "step_finish", part: { type: "step-finish", reason } }
  const part = ev['part']
  const reasonFromPart = isRecord(part) && typeof part['reason'] === 'string' ? part['reason'] : undefined
  const t = ev['type']
  if (typeof t === 'string' && (t === 'step-finish' || t === 'step_finish')) {
    const reason = typeof ev['reason'] === 'string' ? ev['reason'] : reasonFromPart
    if (typeof reason === 'string') {
      const m = mapReasonToFinish(reason)
      if (m !== undefined) return m
    }
  }
  if (reasonFromPart !== undefined && isRecord(part) && part['type'] === 'step-finish') {
    const m = mapReasonToFinish(reasonFromPart)
    if (m !== undefined) return m
  }
  return undefined
}

const resolveFinish = (events: readonly unknown[]): FinishCause => {
  let last: FinishCause | undefined
  for (const ev of events) {
    const f = finishFromEvent(ev)
    if (f !== undefined) last = f
  }
  return last ?? 'other'
}

export const computeMaxConsecutiveSameTool = (events: readonly unknown[]): number => {
  let max = 0
  let cur = 0
  let prev: string | undefined
  for (const ev of events) {
    if (!isRecord(ev)) continue
    // streamed run event: { type: "tool_use", part: { type: "tool", tool } }
    // export part: { type: "tool", tool }
    const part = ev['part']
    const isToolEvent =
      ev['type'] === 'tool' ||
      ev['type'] === 'tool_use' ||
      (isRecord(part) && part['type'] === 'tool')
    if (!isToolEvent) continue
    const tool =
      typeof ev['tool'] === 'string'
        ? ev['tool']
        : isRecord(part) && typeof part['tool'] === 'string'
          ? part['tool']
          : undefined
    if (typeof tool !== 'string') continue
    if (tool === prev) {
      cur += 1
      if (cur > max) max = cur
    } else {
      cur = 1
      prev = tool
      if (cur > max) max = cur
    }
  }
  return max
}

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [/\b429\b/, /rate[ _]?limit/i, /too many requests/i]

/**
 * Pulls the one string on an event that can genuinely carry a provider/error
 * message: an assistant text part, a top-level provider-error event
 * (`{type:"error", error:{name, data:{message}}}`, printed by opencode's own
 * `Z()` formatter for a `session.error`), or a failed tool call's error text
 * (`state.error`, a plain string on the `ToolStateError` variant — that
 * variant has no `output` field at all, `output` only exists on a completed
 * tool call). Everything else on an event (callIDs, session ids, token
 * counts, a successfully read file's content) is left unscanned so a stray
 * "429" there is never mistaken for a rate-limit signal.
 */
const errorTextFromEvent = (raw: unknown): string | undefined => {
  if (!isRecord(raw)) return undefined
  const part = raw['part']
  const partRecord = isRecord(part) ? part : undefined

  if (raw['type'] === 'text' || partRecord?.['type'] === 'text') {
    const direct = raw['text']
    if (typeof direct === 'string') return direct
    const nested = partRecord?.['text']
    if (typeof nested === 'string') return nested
  }

  if (raw['type'] === 'error') {
    const err = raw['error']
    if (isRecord(err)) {
      const data = err['data']
      const message = isRecord(data) ? data['message'] : undefined
      if (typeof message === 'string') return message
      const name = err['name']
      if (typeof name === 'string') return name
    }
  }

  const nestedState = partRecord === undefined ? undefined : partRecord['state']
  const state = isRecord(raw['state']) ? raw['state'] : isRecord(nestedState) ? nestedState : undefined
  if (state !== undefined && state['status'] === 'error') {
    const error = state['error']
    if (typeof error === 'string') return error
    const output = state['output']
    if (typeof output === 'string') return output
  }
  return undefined
}

export const hasRateLimitSignal = (events: readonly unknown[]): boolean => {
  for (const ev of events) {
    const text = errorTextFromEvent(ev)
    if (text === undefined) continue
    if (RATE_LIMIT_PATTERNS.some((p) => p.test(text))) return true
  }
  return false
}

export interface AnalyzeInput {
  readonly events: readonly unknown[]
  readonly exitCode: number
  readonly timedOut: boolean
  readonly watchdogTriggered: boolean
  readonly doomLoopThreshold: number
}

export interface AnalyzeOutcome {
  readonly rank: SuccessRank
  readonly finish: FinishCause
  readonly rateLimited: boolean
  readonly maxConsecutiveSameTool: number
  readonly errorCode?: ErrorCode
}

/**
 * Map a finished opencode run to its `successRank` / `finishCause`. Pure and
 * table-driven so every branch is unit-testable without spawning anything.
 *
 * Precedence (highest first): hard timeout → rate-limit → watchdog → crash
 * (non-zero exit) → finish-based (stop=4 / tool-calls=3 / length=2) →
 * doom-loop (1) → everything else (0). Only the four early-return branches
 * set `errorCode` here; the rank-0 fallback below carries none — phase 07
 * backfills `E_RUN_CRASH` for it (`errorCode ?? 'E_RUN_CRASH'`). Length (2)
 * and doom-loop (1) are valid outcomes and carry no errorCode either way.
 *
 * `finish: 'unknown'` (opencode's own catch-all when it can't classify how a
 * message ended) is deliberately not given its own case — it falls into the
 * same default branch as `'other'` and is scored identically. Neither is
 * evidence the run ended well, and testaipack has no information opencode
 * itself lacked to rank one above the other.
 */
export const analyzeOutcome = (input: AnalyzeInput): AnalyzeOutcome => {
  const maxConsecutiveSameTool = computeMaxConsecutiveSameTool(input.events)
  const rateLimited = hasRateLimitSignal(input.events)
  const finish = resolveFinish(input.events)
  const base = { rateLimited, maxConsecutiveSameTool }

  if (input.timedOut) return { rank: 0, finish: 'error', ...base, errorCode: 'E_RUN_TIMEOUT' }
  if (rateLimited) return { rank: 0, finish: 'error', ...base, errorCode: 'E_RATE_LIMIT_EXHAUSTED' }
  if (input.watchdogTriggered)
    return { rank: 0, finish: 'error', ...base, errorCode: 'E_RUN_HANG_WATCHDOG' }
  if (input.exitCode !== 0) return { rank: 0, finish: 'error', ...base, errorCode: 'E_RUN_CRASH' }
  switch (finish) {
    case 'stop':
      return { rank: 4, finish: 'stop', ...base }
    case 'tool-calls':
      return { rank: 3, finish: 'tool-calls', ...base }
    case 'length':
      return { rank: 2, finish: 'length', ...base }
    default:
      if (maxConsecutiveSameTool > input.doomLoopThreshold) {
        return { rank: 1, finish: 'tool-calls', ...base }
      }
      return { rank: 0, finish, ...base }
  }
}

// ---------------------------------------------------------------------------
// Verify command
// ---------------------------------------------------------------------------

export interface VerifyResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
}

const cleanProcessEnv = (): Record<string, string> =>
  Object.entries(process.env).reduce<Record<string, string>>(
    (acc, [k, v]) => (v === undefined ? acc : { ...acc, [k]: v }),
    {},
  )

/** Run the `--verify` shell command in the app working dir with a hard timeout. */
export const executeVerify = (
  cmd: string,
  cwd: string,
  timeoutSec: number,
  env?: Record<string, string>,
): Effect.Effect<VerifyResult> =>
  Effect.gen(function* () {
    const out = yield* spawnProcess({
      command: 'sh',
      args: ['-c', cmd],
      cwd,
      env: env ?? cleanProcessEnv(),
      ...(timeoutSec <= 0 ? {} : { timeoutMs: timeoutSec * 1000 }),
    })
    return { exitCode: out.exitCode, timedOut: out.timedOut }
  })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const buildEnvRecord = (homeEnv: EnvVarSet): Record<string, string> => ({
  OPENCODE_DISABLE_PROJECT_CONFIG: homeEnv.OPENCODE_DISABLE_PROJECT_CONFIG ? '1' : '0',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: homeEnv.OPENCODE_DISABLE_DEFAULT_PLUGINS ? '1' : '0',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: homeEnv.OPENCODE_DISABLE_EXTERNAL_SKILLS ? '1' : '0',
  OPENCODE_PURE: homeEnv.OPENCODE_PURE ? '1' : '0',
  // Set only when --pack-setup is declared (phase 04's buildEnvVars). Absent
  // otherwise — byte-for-byte today's env for a run with no new flags.
  ...(homeEnv.PATH === undefined ? {} : { PATH: homeEnv.PATH }),
})

export const makeSessionId = (runId: string, variantName: string, runIndex: number): string => {
  const rand = Math.random().toString(16).slice(2, 8).padEnd(6, '0')
  return `${runId}-${variantName}-${String(runIndex)}-${rand}`
}

const safeStringify = (e: unknown): string => {
  try {
    return JSON.stringify(e)
  } catch {
    return '{}'
  }
}

// ---------------------------------------------------------------------------
// Watchdog + single opencode run
// ---------------------------------------------------------------------------

interface RunState {
  readonly events: unknown[]
  readonly lastEvent: { time: number }
}

type Winner =
  | { readonly kind: 'run'; readonly result: Either.Either<OpencodeRunResult, OpencodeError> }
  | { readonly kind: 'watchdog' }
  | { readonly kind: 'total' }

interface OnceResult {
  readonly exitCode: number
  readonly timedOut: boolean
  readonly watchdogTriggered: boolean
  readonly totalTimedOut: boolean
  readonly durationMs: number
  readonly sessionId?: string
}

const makeWatchdog = (state: RunState, watchdogMs: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (watchdogMs <= 0) return
    const poll = Math.max(1, Math.min(WATCHDOG_POLL_MS, watchdogMs))
    for (;;) {
      yield* Effect.sleep(poll)
      if (Date.now() - state.lastEvent.time >= watchdogMs) return
    }
  })

const runOnce = (
  opts: OpencodeRunOptions,
  state: RunState,
  watchdogMs: number,
  timeoutMs: number,
  totalBound: boolean,
  totalDeadline: number | undefined,
): Effect.Effect<OnceResult> =>
  Effect.gen(function* () {
    const onEvent = (ev: unknown): void => {
      state.lastEvent.time = Date.now()
      state.events.push(ev)
    }
    const runEff = opencodeRun({ ...opts, timeoutMs, onEvent }).pipe(Effect.either)
    const runTagged = runEff.pipe(
      Effect.map((result): Winner => ({ kind: 'run', result })),
    )
    const watchdogTagged = makeWatchdog(state, watchdogMs).pipe(
      Effect.map((): Winner => ({ kind: 'watchdog' })),
    )
    const winner: Winner = yield* (totalDeadline === undefined
      ? Effect.raceFirst(runTagged, watchdogTagged)
      : Effect.raceFirst(
          runTagged,
          Effect.raceFirst(
            watchdogTagged,
            Effect.sleep(Math.max(0, totalDeadline - Date.now())).pipe(
              Effect.map((): Winner => ({ kind: 'total' })),
            ),
          ),
        ))

    if (winner.kind === 'watchdog') {
      return {
        exitCode: -1,
        timedOut: false,
        watchdogTriggered: true,
        totalTimedOut: false,
        durationMs: 0,
      }
    }
    if (winner.kind === 'total') {
      return {
        exitCode: -1,
        timedOut: false,
        watchdogTriggered: false,
        totalTimedOut: true,
        durationMs: 0,
      }
    }
    const e = winner.result
    if (e._tag === 'Left') {
      const err = e.left
      if (err.timedOut) {
        return {
          exitCode: -1,
          timedOut: !totalBound,
          watchdogTriggered: false,
          totalTimedOut: totalBound,
          durationMs: 0,
        }
      }
      return {
        exitCode: err.exitCode ?? -1,
        timedOut: false,
        watchdogTriggered: false,
        totalTimedOut: false,
        durationMs: 0,
      }
    }
    return {
      exitCode: e.right.exitCode,
      timedOut: false,
      watchdogTriggered: false,
      totalTimedOut: false,
      durationMs: e.right.durationMs,
      ...(e.right.sessionId === undefined ? {} : { sessionId: e.right.sessionId }),
    }
  })

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------

export const runSide = (
  input: RunSideInputExt,
): Effect.Effect<RunSideResultExt, PhaseError> =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const { runInput, manifest, workspace, homeEnv, variant, runIndex } = input
    const sessionId =
      input.sessionId === '' ? makeSessionId(manifest.runId, variant.name, runIndex) : input.sessionId

    const docker: DockerExec | undefined =
      runInput.isolation === 'docker'
        ? {
            image: input.dockerImage ?? DEFAULT_OPENCODE_IMAGE,
            ...(runInput.dockerNetwork === undefined ? {} : { network: runInput.dockerNetwork }),
          }
        : undefined

    const variantRawDir = path.join(workspace.raw, variant.name)
    yield* ensureDir(variantRawDir).pipe(Effect.mapError((e) => failFs(e, variant.name, runIndex)))

    const eventsLogPath = path.join(variantRawDir, `run-${String(runIndex)}.events.ndjson`)
    const exportPath = path.join(variantRawDir, `run-${String(runIndex)}.json`)
    const logPath = path.join(variantRawDir, `run-${String(runIndex)}.log`)

    const log = (line: string): Effect.Effect<void> =>
      appendFile(logPath, `${line}\n`).pipe(Effect.catchAll(() => Effect.void))

    yield* log(`[START] variant=${variant.name} runIndex=${String(runIndex)} sessionId=${sessionId}`)

    const variantTree = workspace.variantTrees.find((vt) => vt.name === variant.name)
    const appCwd: string = variantTree?.apps[runIndex - 1] ?? ''
    if (appCwd === '') {
      yield* Effect.fail(fail('missing app working dir for run', 'E_RUN_CRASH', variant.name, runIndex))
    }

    // Phase 00 is supposed to guarantee every variant an effective non-empty
    // prompt (`effectiveOf(v, prompt, 'prompt')`); if that invariant is ever
    // violated this must fail loud instead of silently launching opencode
    // with an empty --prompt, the same way a missing app dir does above.
    const effectivePromptText = effectiveOf(variant, runInput.prompt, 'prompt')
    if (effectivePromptText === undefined || effectivePromptText === '') {
      yield* Effect.fail(fail('missing effective prompt for variant', 'E_RUN_CRASH', variant.name, runIndex))
    }

    const envRecord = buildEnvRecord(homeEnv)
    const timeouts = runInput.timeouts
    const runMs = timeouts.runSeconds * 1000
    const watchdogMs = timeouts.watchdogSeconds * 1000
    const totalDeadline =
      timeouts.totalSeconds !== undefined ? startedAt + timeouts.totalSeconds * 1000 : undefined

    const budget = (): { readonly timeoutMs: number; readonly totalBound: boolean } => {
      if (totalDeadline !== undefined) {
        const remaining = totalDeadline - Date.now()
        if (remaining <= 0) return { timeoutMs: 0, totalBound: true }
        if (remaining < runMs) return { timeoutMs: remaining, totalBound: true }
      }
      return { timeoutMs: runMs, totalBound: false }
    }

    // opencode assigns the session id when it CREATES a session; `--session` is
    // only valid to CONTINUE an existing one (else "Session not found"). So a
    // new run passes no session, we capture the real id from the event stream,
    // and only the prompt-after-init continuation passes --session <realId>.
    const baseOpts = (
      prompt: string,
      continueSession: boolean,
      sessionToContinue: string | undefined,
    ): OpencodeRunOptions => ({
      homeDir: homeEnv.HOME,
      cwd: appCwd,
      ...(homeEnv.OPENCODE_CONFIG_CONTENT === undefined
        ? {}
        : { configContent: homeEnv.OPENCODE_CONFIG_CONTENT }),
      agent: 'build',
      prompt,
      ...(continueSession && sessionToContinue !== undefined
        ? { session: sessionToContinue, continueSession: true }
        : {}),
      auto: true,
      ...(homeEnv.OPENCODE_PURE ? { pure: true } : {}),
      env: envRecord,
      ...(docker === undefined ? {} : { docker }),
    })

    const state: RunState = { events: [], lastEvent: { time: startedAt } }
    const runResults: OnceResult[] = []
    let realSessionId: string | undefined

    // Every variant carries its own effective init (D7: an explicit '' on the
    // variant disables the global init instead of falling back to it) — there
    // is no more side-targeting knob (the old `--init-side` routed one shared
    // init string to a chosen side; each variant now simply has, or lacks, its
    // own effective init text).
    const effectiveInit = effectiveOf(variant, runInput.init, 'init')
    const hasInit = effectiveInit !== undefined && effectiveInit !== ''
    // Harness wall-clock around each invocation, for the metric-split spec's
    // per-phase timing — NOT `OnceResult.durationMs` (that field is 0 on the
    // watchdog/timeout/error branches, see `runOnce` above; a harness-side
    // `Date.now()` pair around the call stays meaningful on every branch).
    let initWallMs: number | undefined
    if (hasInit) {
      yield* log('[INIT] running --init')
      state.lastEvent.time = Date.now()
      const b = budget()
      const initStart = Date.now()
      const r = yield* runOnce(
        baseOpts(effectiveInit ?? '', false, undefined),
        state,
        watchdogMs,
        b.timeoutMs,
        b.totalBound,
        totalDeadline,
      )
      initWallMs = Date.now() - initStart
      runResults.push(r)
      realSessionId = r.sessionId
      yield* log(
        `[INIT_DONE] exitCode=${String(r.exitCode)} timedOut=${String(r.timedOut)} watchdog=${String(r.watchdogTriggered)} sessionId=${realSessionId ?? 'n/a'}`,
      )
    }

    yield* log('[PROMPT] running --prompt')
    state.lastEvent.time = Date.now()
    const bp = budget()
    const promptStart = Date.now()
    const pr = yield* runOnce(
      baseOpts(effectiveTaskPrompt(runInput, variant), hasInit, realSessionId),
      state,
      watchdogMs,
      bp.timeoutMs,
      bp.totalBound,
      totalDeadline,
    )
    const promptWallMs = Date.now() - promptStart
    runResults.push(pr)
    if (pr.sessionId !== undefined) realSessionId = pr.sessionId
    yield* log(
      `[PROMPT_DONE] exitCode=${String(pr.exitCode)} timedOut=${String(pr.timedOut)} watchdog=${String(pr.watchdogTriggered)} sessionId=${realSessionId ?? 'n/a'}`,
    )

    const lastResult = runResults[runResults.length - 1]
    const firstFailedResult = runResults.find((r) => r.exitCode !== 0)
    const combinedExit =
      firstFailedResult !== undefined
        ? firstFailedResult.exitCode
        : lastResult === undefined
          ? 0
          : lastResult.exitCode
    const anyTimedOut = runResults.some((r) => r.timedOut)
    const anyWatchdog = runResults.some((r) => r.watchdogTriggered)
    const anyTotal = runResults.some((r) => r.totalTimedOut)

    if (realSessionId === undefined) {
      for (let i = state.events.length - 1; i >= 0; i--) {
        const id = sessionIdFromEvent(state.events[i])
        if (id !== undefined) {
          realSessionId = id
          break
        }
      }
    }

    const ndjson =
      state.events.length === 0
        ? ''
        : `${state.events.map((e) => safeStringify(e)).join('\n')}\n`
    yield* writeFile(eventsLogPath, ndjson).pipe(Effect.mapError((e) => failFs(e, variant.name, runIndex)))

    const exportTimeoutMs = runMs
    const exportSessionId = realSessionId ?? sessionId

    let exportAttempt = 0
    const exportOnce: Effect.Effect<void, PhaseError> = Effect.gen(function* () {
      exportAttempt += 1
      yield* log(`[EXPORT] attempt ${String(exportAttempt)}: requesting opencode export`)
      const exportStr: string = yield* exportSession(homeEnv.HOME, exportSessionId, docker).pipe(
        Effect.mapError((err: OpencodeError) =>
          fail('opencode export produced no data', 'E_RUN_CRASH', variant.name, runIndex, {
            sessionId: exportSessionId,
            exitCode: err.exitCode,
            stderr: err.stderr,
            stdout: err.stdout,
          }),
        ),
        Effect.timeout(exportTimeoutMs),
        Effect.catchTag('TimeoutException', () =>
          Effect.fail(
            fail('opencode export timed out', 'E_RUN_TIMEOUT', variant.name, runIndex, {
              sessionId: exportSessionId,
              timeoutMs: exportTimeoutMs,
            }),
          ),
        ),
      )
      yield* writeFile(exportPath, exportStr).pipe(Effect.mapError((e) => failFs(e, variant.name, runIndex)))
      yield* log(`[EXPORT] attempt ${String(exportAttempt)}: written to ${exportPath}`)

      yield* readJson(exportPath, opencodeExportSchema).pipe(
        Effect.mapError((e) => {
          const tag = (e as { readonly _tag?: string })._tag
          const detail =
            tag === 'ParseError'
              ? (e as { readonly reason: string }).reason
              : `fs:${(e as { readonly operation: string }).operation}`
          return fail(`export.json invalid: ${detail}`, 'E_EXPORT_INVALID', variant.name, runIndex, {
            path: exportPath,
            attempt: exportAttempt,
          })
        }),
        Effect.tapError((e) => log(`[EXPORT] attempt ${String(exportAttempt)}: ${e.message}`)),
      )
    })

    const exportOutcome = yield* exportOnce.pipe(
      Effect.retry({
        schedule: exportRetrySchedule,
        while: (e: PhaseError) => e.code === 'E_EXPORT_INVALID',
      }),
      Effect.either,
    )
    // A per-run export failure degrades the run to rank 0 instead of failing the
    // whole phase — one broken export must not interrupt another variant's
    // in-flight runs. E_DISK_FULL is machine-global, so it still aborts.
    const exportFailed =
      exportOutcome._tag === 'Left' && exportOutcome.left.code !== 'E_DISK_FULL'
        ? exportOutcome.left
        : undefined
    if (exportOutcome._tag === 'Left' && exportFailed === undefined) {
      return yield* Effect.fail(exportOutcome.left)
    }
    if (exportFailed !== undefined) {
      yield* log(`[EXPORT_FAILED] code=${exportFailed.code} message=${exportFailed.message}`)
    }

    const outcome = analyzeOutcome({
      events: state.events,
      exitCode: combinedExit,
      timedOut: anyTimedOut || anyTotal,
      watchdogTriggered: anyWatchdog,
      doomLoopThreshold: DOOM_LOOP_THRESHOLD,
    })

    let rank = outcome.rank
    let errorCode = outcome.errorCode
    let finish = outcome.finish
    let verifyExitCode: number | undefined
    const effectiveVerify = effectiveOf(variant, runInput.verify, 'verify')
    const hasVerify =
      exportFailed === undefined && effectiveVerify !== undefined && effectiveVerify !== ''
    if (hasVerify) {
      yield* log(`[VERIFY] running "${effectiveVerify ?? ''}"`)
      const vres = yield* executeVerify(effectiveVerify ?? '', appCwd, timeouts.verifySeconds, {
        ...envRecord,
        HOME: homeEnv.HOME,
      })
      if (vres.timedOut) {
        verifyExitCode = undefined
        rank = 0
        errorCode = 'E_VERIFY_TIMEOUT'
        yield* log('[VERIFY_TIMEOUT]')
      } else {
        verifyExitCode = vres.exitCode ?? -1
        if (verifyExitCode !== 0) {
          rank = Math.max(0, rank - 1)
          if (errorCode === undefined) {
            errorCode = 'E_VERIFY_FAILED'
          }
        }
        yield* log(`[VERIFY_DONE] exitCode=${String(verifyExitCode)}`)
      }
    }

    if (exportFailed !== undefined) {
      rank = 0
      errorCode = exportFailed.code
      // The agent's own finish cause (e.g. "stop") is no longer the honest
      // summary of this run once the export step is why it counts as failed —
      // a `[STOP] finish=stop rank=0` line reads as "finished cleanly, rank
      // separately zeroed" with no clue why. `errorCode` says why here (it
      // survives in run-N.result.json), but a log-based recovery (no
      // result.json) cannot read `errorCode` at all (never recoverable, see
      // `src/recovery/run-recovery.ts`) — only `finish`, so it must already
      // read as a failure on its own.
      finish = 'error'
    }

    const durationMs = Date.now() - startedAt
    yield* log(
      `[STOP] finish=${finish} rank=${String(rank)} durationMs=${String(durationMs)}`,
    )

    const result: RunSideResultExt = {
      variant: variant.name,
      runIndex,
      exportPath,
      eventsLogPath,
      successRank: rank,
      finishCause: finish,
      exitCode: combinedExit,
      durationMs: String(durationMs),
      watchdogTriggered: anyWatchdog,
      ...(verifyExitCode === undefined ? {} : { verifyExitCode }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(hasInit && initWallMs !== undefined ? { initRan: true, initWallMs: String(initWallMs) } : {}),
      promptWallMs: String(promptWallMs),
    }

    const resultPath = path.join(variantRawDir, `run-${String(runIndex)}.result.json`)
    yield* writeJson(resultPath, result).pipe(
      Effect.catchAll((e) => log(`[RESULT_WRITE_FAILED] ${e.operation} on ${e.path}: ${String(e.cause)}`)),
    )

    return result
  })
