/**
 * Phase 05: preflight
 *
 * Runs 5 sequential gates (opencode-launch, auth-ping, build-agent,
 * pack-visibility, baseline-identical) to fail fast before the expensive N×2
 * runs. `--no-preflight` skips the phase entirely. A gate failure throws a
 * PhaseError whose `context.exitCode` ∈ {2,3} matches the PreflightResult
 * contract (2 = general failure, 3 = pack invisible on new side).
 *
 * @see docs/phases/05-preflight.ru.md
 * @see contract/phases/05-preflight.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type { PreflightCheck, PreflightInput, PreflightResult, Side } from '@generated/types'
import type { PackInstallOutcome, RegistrationInstruction } from './03-pack-install.js'
import { run as opencodeRun, version as opencodeVersion } from '../opencode/cli.js'
import type { OpencodeError } from '../opencode/cli.js'
import { appendFile, ensureDir, exists } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import type { PhaseError } from '../errors.js'
import { preflightError } from '../errors.js'

/**
 * Local input extension: phase 05 needs the phase-03 outcome (instructions) to
 * perform accurate pack-visibility (gate 4) and baseline-leak (gate 5) checks
 * for every pack kind including 'all'. The contract `PreflightInput` carries
 * only `homePaths`; this extension adds the 03→05 hand-off.
 */
export interface PreflightInputExt extends PreflightInput {
  readonly packInstall?: PackInstallOutcome
}

/** opencode layout: skills/agents/plugins are plural, command is singular. */
const sectionDir = (section: 'agents' | 'commands'): string =>
  section === 'agents' ? 'agents' : 'command'

const AUTH_MISSING_RE = /API_KEY|credentials?\s+(not|missing|absent|are\s+not)|not authenticated|no.*provider/i

type GateName = PreflightCheck['name']

const fail = (
  code: Parameters<typeof preflightError>[1],
  check: GateName,
  side: Side,
  exitCode: 2 | 3,
  message: string,
  checks: readonly PreflightCheck[],
  context?: Record<string, unknown>,
): Effect.Effect<never, PhaseError> =>
  Effect.fail(
    preflightError(message, code, {
      check,
      side,
      exitCode,
      checks: [...checks],
      ...(context ?? {}),
    }),
  )

const ensureResultsDir = (logPath: string): Effect.Effect<void, PhaseError> =>
  ensureDir(path.dirname(logPath)).pipe(
    Effect.mapError((e: FsError) =>
      preflightError(`cannot create preflight results dir: ${e.path}`, 'E_PREFLIGHT_FAILED', {
        check: 'opencode-launch',
        side: 'old',
        exitCode: 2,
        path: e.path,
      }),
    ),
  )

const writeLog = (logPath: string, line: string): Effect.Effect<void, PhaseError> =>
  appendFile(logPath, line).pipe(
    Effect.mapError((e: FsError) =>
      preflightError(`cannot write preflight log: ${e.path}`, 'E_PREFLIGHT_FAILED', {
        check: 'opencode-launch',
        side: 'old',
        exitCode: 2,
        path: e.path,
      }),
    ),
  )

const isTimeout = (e: OpencodeError): boolean => e.timedOut
const stderrOf = (e: OpencodeError): string => e.stderr

// ---- gates -----------------------------------------------------------------

const runOpencodeLaunch = (
  homeDir: string,
  side: Side,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    yield* opencodeVersion(homeDir).pipe(
      Effect.catchAll((e) =>
        isTimeout(e)
          ? fail('E_PREFLIGHT_TIMEOUT', 'opencode-launch', side, 2, 'opencode --version timed out', checks)
          : fail(
              'E_PREFLIGHT_FAILED',
              'opencode-launch',
              side,
              2,
              `opencode --version failed: ${stderrOf(e)}`,
              checks,
              { stderr: stderrOf(e) },
            ),
      ),
    )
    return { name: 'opencode-launch', side, passed: true, durationMs: String(Date.now() - start) }
  })

const gateOpencodeLaunch = (
  homePaths: PreflightInput['homePaths'],
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const oldCheck = yield* runOpencodeLaunch(homePaths.old, 'old', checks)
    const newCheck = yield* runOpencodeLaunch(homePaths.new, 'new', checks)
    return [oldCheck, newCheck]
  })

const runAuthPing = (
  homeDir: string,
  side: Side,
  model: string | undefined,
  timeoutMs: number,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    yield* opencodeRun({
      homeDir,
      cwd: homeDir,
      agent: 'build',
      ...(model === undefined ? {} : { model }),
      prompt: 'reply with the single word OK',
      timeoutMs,
    }).pipe(
      Effect.catchAll((e) => {
        const stderr = stderrOf(e)
        if (isTimeout(e)) {
          return fail('E_PREFLIGHT_TIMEOUT', 'auth-ping', side, 2, 'auth-ping timed out', checks)
        }
        if (AUTH_MISSING_RE.test(stderr)) {
          return fail('E_AUTH_MISSING', 'auth-ping', side, 2, `no credentials: ${stderr}`, checks, { stderr })
        }
        return fail('E_PREFLIGHT_FAILED', 'auth-ping', side, 2, `auth-ping failed: ${stderr}`, checks, { stderr })
      }),
    )
    return { name: 'auth-ping', side, passed: true, durationMs: String(Date.now() - start) }
  })

const gateAuthPing = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const model = input.runInput.preflightModel
    const timeoutMs = input.runInput.timeouts.preflightSeconds * 1000
    const oldCheck = yield* runAuthPing(input.homePaths.old, 'old', model, timeoutMs, checks)
    const newCheck = yield* runAuthPing(input.homePaths.new, 'new', model, timeoutMs, checks)
    return [oldCheck, newCheck]
  })

const runBuildAgent = (
  homeDir: string,
  side: Side,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const file = path.join(homeDir, '.config/opencode/agents/build.md')
    const ok = yield* exists(file)
    if (!ok) {
      yield* fail(
        'E_PREFLIGHT_FAILED',
        'build-agent',
        side,
        2,
        `build agent missing in ${side} HOME`,
        checks,
      )
    }
    return { name: 'build-agent', side, passed: true, durationMs: String(Date.now() - start) }
  })

const gateBuildAgent = (
  homePaths: PreflightInput['homePaths'],
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const oldCheck = yield* runBuildAgent(homePaths.old, 'old', checks)
    const newCheck = yield* runBuildAgent(homePaths.new, 'new', checks)
    return [oldCheck, newCheck]
  })

const instructionName = (inst: RegistrationInstruction): string => {
  switch (inst.kind) {
    case 'symlink':
      return inst.name
    case 'file':
      return inst.name
    case 'plugin':
      return inst.name
    case 'config':
      return inst.section
  }
}

const probeSkillName = (
  homePaths: PreflightInput['homePaths'],
  name: string,
): Effect.Effect<boolean> =>
  opencodeRun({
    homeDir: homePaths.new,
    cwd: homePaths.new,
    agent: 'build',
    prompt: 'list available skills',
    timeoutMs: 30_000,
  }).pipe(
    Effect.map((out) => out.stdout.includes(name) || out.stderr.includes(name)),
    Effect.catchAll(() => Effect.succeed(false)),
  )

const instructionVisible = (
  inst: RegistrationInstruction,
  homePaths: PreflightInput['homePaths'],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (inst.kind === 'symlink') {
      const hasMd = yield* exists(path.join(inst.target, 'SKILL.md'))
      if (!hasMd) return false
      return yield* probeSkillName(homePaths, inst.name)
    }
    if (inst.kind === 'file') {
      return yield* exists(
        path.join(homePaths.new, '.config/opencode', sectionDir(inst.section), `${inst.name}.md`),
      )
    }
    if (inst.kind === 'plugin') {
      const dir = path.join(homePaths.new, '.config/opencode/plugins')
      return (yield* exists(path.join(dir, `${inst.name}.js`))) || (yield* exists(path.join(dir, inst.name)))
    }
    return true
  })

const gatePackVisibility = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const pack = input.packInstall
    if (pack === undefined || pack.detectedType === null || pack.instructions.length === 0) {
      return [
        {
          name: 'pack-visibility',
          side: 'new',
          passed: true,
          durationMs: String(Date.now() - start),
          details: 'skipped (no pack)',
        },
      ]
    }
    for (const inst of pack.instructions) {
      const visible = yield* instructionVisible(inst, input.homePaths)
      if (!visible) {
        yield* fail(
          'E_PREFLIGHT_PACK_INVISIBLE',
          'pack-visibility',
          'new',
          3,
          `pack not visible on new side (${inst.kind} ${instructionName(inst)})`,
          checks,
          { instruction: inst.kind, name: instructionName(inst) },
        )
      }
    }
    return [
      { name: 'pack-visibility', side: 'new', passed: true, durationMs: String(Date.now() - start) },
    ]
  })

const leakedOntoOld = (
  inst: RegistrationInstruction,
  homePaths: PreflightInput['homePaths'],
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (inst.kind === 'symlink') {
      return yield* exists(path.join(homePaths.old, '.config/opencode/skills', inst.name))
    }
    if (inst.kind === 'file') {
      return yield* exists(
        path.join(homePaths.old, '.config/opencode', sectionDir(inst.section), `${inst.name}.md`),
      )
    }
    if (inst.kind === 'plugin') {
      return yield* exists(path.join(homePaths.old, '.config/opencode/plugins', inst.name))
    }
    return false
  })

const gateBaselineIdentical = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    // Re-verify gates 1–3 for side=old (idempotent: they already ran and passed
    // in gates 1–3; the spec requires gate 5 to repeat them as a baseline
    // sanity check before the pack-leak assertion).
    const model = input.runInput.preflightModel
    const timeoutMs = input.runInput.timeouts.preflightSeconds * 1000
    yield* runOpencodeLaunch(input.homePaths.old, 'old', checks)
    yield* runAuthPing(input.homePaths.old, 'old', model, timeoutMs, checks)
    yield* runBuildAgent(input.homePaths.old, 'old', checks)
    // Pack-leak assertion: no pack files/symlinks may have landed on the old side.
    const pack = input.packInstall
    if (pack !== undefined && pack.detectedType !== null) {
      for (const inst of pack.instructions) {
        const leaked = yield* leakedOntoOld(inst, input.homePaths)
        if (leaked) {
          yield* fail(
            'E_PREFLIGHT_FAILED',
            'baseline-identical',
            'old',
            2,
            `pack leaked onto old side (${inst.kind} ${instructionName(inst)})`,
            checks,
            { instruction: inst.kind, name: instructionName(inst) },
          )
        }
      }
    }
    return [
      { name: 'baseline-identical', side: 'old', passed: true, durationMs: String(Date.now() - start) },
    ]
  })

const formatLine = (c: PreflightCheck): string => {
  const status = c.passed ? 'PASSED' : 'FAILED'
  const details = c.details === undefined ? '' : ` ${c.details}`
  return `[CHECK] ${c.name} [${c.side}] ${status} (${c.durationMs}ms)${details}\n`
}

export const preflight = (input: PreflightInputExt): Effect.Effect<PreflightResult, PhaseError> =>
  Effect.gen(function* () {
    const logPath = path.join(
      input.runInput.workspacePath,
      input.manifest.runId,
      'results',
      'preflight.log',
    )
    yield* ensureResultsDir(logPath)

    if (!input.runInput.preflightEnabled) {
      yield* writeLog(logPath, 'preflight skipped (--no-preflight)\n')
      return { checks: [], allPassed: true, exitCode: 0, logPath }
    }

    interface Gate {
      readonly name: GateName
      readonly run: (checks: readonly PreflightCheck[]) => Effect.Effect<readonly PreflightCheck[], PhaseError>
    }

    const gates: readonly Gate[] = [
      { name: 'opencode-launch', run: (c) => gateOpencodeLaunch(input.homePaths, c) },
      { name: 'auth-ping', run: (c) => gateAuthPing(input, c) },
      { name: 'build-agent', run: (c) => gateBuildAgent(input.homePaths, c) },
      { name: 'pack-visibility', run: (c) => gatePackVisibility(input, c) },
      { name: 'baseline-identical', run: (c) => gateBaselineIdentical(input, c) },
    ]

    const finalChecks = yield* Effect.reduce(
      gates,
      [] as readonly PreflightCheck[],
      (acc, gate) =>
        Effect.gen(function* () {
          const produced = yield* gate.run(acc)
          for (const check of produced) {
            yield* writeLog(logPath, formatLine(check))
          }
          return [...acc, ...produced]
        }),
    )

    return { checks: [...finalChecks], allPassed: true, exitCode: 0, logPath }
  })
