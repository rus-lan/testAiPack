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
import type { DockerExec, OpencodeError } from '../opencode/cli.js'
import { dockerRun, ensureImage } from '../isolation/docker-runner.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import type { DockerError } from '../isolation/docker-runner.js'
import { appendFile, ensureDir, exists, readFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import type { PhaseError } from '../errors.js'
import { preflightError } from '../errors.js'

/**
 * Local input extension: phase 05 needs the phase-03 outcome (instructions) to
 * perform accurate pack-visibility (gate 4) and baseline-leak (gate 5) checks
 * for every pack kind including 'all'. The contract `PreflightInput` carries
 * only `homePaths`; this extension adds the 03→05 hand-off and the docker image
 * (resolved by phase 04) used when `isolation === 'docker'`.
 */
export interface PreflightInputExt extends PreflightInput {
  readonly packInstall?: PackInstallOutcome
  readonly dockerImage?: string
  /**
   * The generated opencode configs (baseline for old, pack-augmented for new)
   * produced by phase 04. Forwarded as OPENCODE_CONFIG_CONTENT to the auth-ping
   * so it runs with the same model/provider the actual runs will use; without
   * it opencode has no model and falls back to an unauthenticated default.
   */
  readonly configs?: { readonly old: string; readonly new: string }
}

/** opencode layout: skills/agents/plugins are plural, command is singular. */
const sectionDir = (section: 'agents' | 'commands'): string =>
  section === 'agents' ? 'agents' : 'command'

/**
 * Derive the docker exec spec when the run is in docker isolation. The image
 * comes from phase 04 (which applies the `--docker-image` override or the
 * default); we fall back to the default here defensively.
 */
const dockerFromInput = (input: PreflightInputExt): DockerExec | undefined =>
  input.runInput.isolation === 'docker'
    ? {
        image: input.dockerImage ?? DEFAULT_OPENCODE_IMAGE,
        ...(input.runInput.dockerNetwork === undefined
          ? {}
          : { network: input.runInput.dockerNetwork }),
      }
    : undefined

const AUTH_MISSING_RE = /API_KEY|credentials?\s+(not|missing|absent|are\s+not)|not authenticated|no\s+provider\b/i

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
const stderrOf = (e: OpencodeError): string =>
  e.stderr || e.stdout || ''

// ---- gates -----------------------------------------------------------------

const runOpencodeLaunch = (
  homeDir: string,
  side: Side,
  docker: DockerExec | undefined,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    if (docker !== undefined) {
      yield* ensureImage(docker.image).pipe(
        Effect.catchAll((e: DockerError) =>
          fail(
            'E_PREFLIGHT_FAILED',
            'opencode-launch',
            side,
            2,
            `docker image '${docker.image}' unavailable. Build it with: bash scripts/build-docker-image.sh — or override with: --docker-image <image>. (${e.stderr.trim()})`,
            checks,
            { image: docker.image, stderr: e.stderr, ...(e.timedOut ? { timedOut: true } : {}) },
          ),
        ),
      )
    }
    yield* opencodeVersion(homeDir, docker).pipe(
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
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const docker = dockerFromInput(input)
    const oldCheck = yield* runOpencodeLaunch(input.homePaths.old, 'old', docker, checks)
    const newCheck = yield* runOpencodeLaunch(input.homePaths.new, 'new', docker, checks)
    return [oldCheck, newCheck]
  })

const runAuthPing = (
  homeDir: string,
  side: Side,
  model: string | undefined,
  configContent: string | undefined,
  timeoutMs: number,
  docker: DockerExec | undefined,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    yield* opencodeRun({
      homeDir,
      cwd: homeDir,
      agent: 'build',
      ...(model === undefined ? {} : { model }),
      ...(configContent === undefined ? {} : { configContent }),
      prompt: 'reply with the single word OK',
      timeoutMs,
      ...(docker === undefined ? {} : { docker }),
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
    const model = input.runInput.model
    const timeoutMs = input.runInput.timeouts.preflightSeconds * 1000
    const docker = dockerFromInput(input)
    const configs = input.configs
    const oldCheck = yield* runAuthPing(input.homePaths.old, 'old', model, configs?.old, timeoutMs, docker, checks)
    const newCheck = yield* runAuthPing(input.homePaths.new, 'new', model, configs?.new, timeoutMs, docker, checks)
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
    case 'skill':
      return inst.name
    case 'file':
      return inst.name
    case 'plugin':
      return inst.name
    case 'config':
      return inst.name
  }
}

/**
 * Existence check for an ABSOLUTE path, fail-closed (docker/host errors read
 * as "does not exist"). Under `--isolation docker` it runs `test -e` inside a
 * throwaway container with the run HOME mounted, instead of trusting the
 * host filesystem: a path can resolve on the host (e.g. one outside every
 * bind mount) while being unreachable inside the container the agent
 * actually runs in. `homeDir` only supplies the mount for the docker case —
 * the path checked is `absPath` verbatim, so this also works for a path that
 * came from inside a config file (e.g. a registered plugin spec) rather than
 * one we constructed ourselves.
 */
const absPathExists = (
  homeDir: string,
  absPath: string,
  docker: DockerExec | undefined,
): Effect.Effect<boolean> => {
  if (docker === undefined) return exists(absPath)
  return dockerRun({
    image: docker.image,
    cwd: homeDir,
    homeDir,
    command: ['test', '-e', absPath],
    ...(docker.network === undefined ? {} : { network: docker.network }),
  }).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false)),
  )
}

/** Existence check for a path relative to a run HOME (fail-closed, see `absPathExists`). */
const homeSubExists = (
  homeDir: string,
  relPath: string,
  docker: DockerExec | undefined,
): Effect.Effect<boolean> =>
  absPathExists(homeDir, docker === undefined ? path.join(homeDir, relPath) : `/home/opencode/${relPath}`, docker)

/**
 * Fail-CLOSED is right for a positive visibility check (an error means "not
 * proven visible", which correctly fails gate 4) but wrong for a leak check:
 * `homeSubExists`' `catchAll(() => false)` would read a docker hiccup as "no
 * leak", silently passing gate 5. `test -e` exiting 1 is the ordinary "path
 * absent" result and stays safe to treat as false; any other failure (docker
 * unreachable, missing image, timeout, permission error) means the check
 * itself didn't run, and must fail loudly instead of reading as a clean bill
 * of health.
 */
const homeSubExistsOrFail = (
  homeDir: string,
  relPath: string,
  docker: DockerExec | undefined,
): Effect.Effect<boolean, PhaseError> => {
  if (docker === undefined) return exists(path.join(homeDir, relPath))
  return dockerRun({
    image: docker.image,
    cwd: homeDir,
    homeDir,
    command: ['test', '-e', `/home/opencode/${relPath}`],
    ...(docker.network === undefined ? {} : { network: docker.network }),
  }).pipe(
    Effect.map(() => true),
    Effect.catchAll((e: DockerError) => {
      if (e.exitCode === 1 && !e.timedOut) return Effect.succeed(false)
      return Effect.fail(
        preflightError(
          `cannot verify pack did not leak onto old side: ${e.stderr || (e.timedOut ? 'docker check timed out' : `docker exit ${String(e.exitCode)}`)}`,
          'E_PREFLIGHT_FAILED',
          { check: 'baseline-identical', side: 'old', exitCode: 2, path: relPath },
        ),
      )
    }),
  )
}

/**
 * The copied plugin FILE existing is not proof the plugin loads — opencode
 * reads the path from opencode.json's `plugin` array, and that registered
 * string can point somewhere that never resolves (the exact bug: a
 * host-absolute path registered while running inside a container). Reads the
 * array entry matching the delivered file's basename.
 */
const pluginEntryPath = (
  homeDir: string,
  basename: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const cfgPath = path.join(homeDir, '.config/opencode/opencode.json')
    if (!(yield* exists(cfgPath))) return undefined
    const raw = yield* readFile(cfgPath).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (raw === '') return undefined
    try {
      const obj = JSON.parse(raw) as unknown
      if (!isRecord(obj)) return undefined
      const arr = obj['plugin']
      if (!Array.isArray(arr)) return undefined
      return arr.find((p): p is string => typeof p === 'string' && p.endsWith(`/${basename}`))
    } catch {
      return undefined
    }
  })

const mcpPresentIn = (
  homeDir: string,
  name: string,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const cfgPath = path.join(homeDir, '.config/opencode/opencode.json')
    if (!(yield* exists(cfgPath))) return false
    const raw = yield* readFile(cfgPath).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (raw === '') return false
    try {
      const obj = JSON.parse(raw) as unknown
      return isRecord(obj) && isRecord(obj['mcp']) && Object.prototype.hasOwnProperty.call(obj['mcp'], name)
    } catch {
      return false
    }
  })

const instructionVisible = (
  inst: RegistrationInstruction,
  homeDir: string,
  docker: DockerExec | undefined,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (inst.kind === 'skill') {
      // A skill is registered by copying it under
      // .config/opencode/skills/<name>/SKILL.md (see phase 04). The
      // deterministic visibility signal is a readable SKILL.md at that path.
      // We deliberately do NOT probe the LLM with "list available skills":
      // opencode only surfaces built-in skills that way, so the probe would
      // always fail for user packs.
      return yield* homeSubExists(homeDir, `.config/opencode/skills/${inst.name}/SKILL.md`, docker)
    }
    if (inst.kind === 'file') {
      return yield* homeSubExists(
        homeDir,
        `.config/opencode/${sectionDir(inst.section)}/${inst.name}.md`,
        docker,
      )
    }
    if (inst.kind === 'plugin') {
      const relDir = '.config/opencode/plugins'
      if (inst.target !== undefined) {
        const basename = path.basename(inst.target)
        const fileCopied = yield* homeSubExists(homeDir, `${relDir}/${basename}`, docker)
        if (!fileCopied) return false
        const registered = yield* pluginEntryPath(homeDir, basename)
        if (registered === undefined) return false
        return yield* absPathExists(homeDir, registered, docker)
      }
      return (
        (yield* homeSubExists(homeDir, `${relDir}/${inst.name}.js`, docker)) ||
        (yield* homeSubExists(homeDir, `${relDir}/${inst.name}`, docker))
      )
    }
    return yield* mcpPresentIn(homeDir, inst.name)
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
    const docker = dockerFromInput(input)
    for (const inst of pack.instructions) {
      const visible = yield* instructionVisible(inst, input.homePaths.new, docker)
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
  homeDir: string,
  docker: DockerExec | undefined,
): Effect.Effect<boolean, PhaseError> =>
  Effect.gen(function* () {
    if (inst.kind === 'skill') {
      return yield* homeSubExistsOrFail(homeDir, `.config/opencode/skills/${inst.name}`, docker)
    }
    if (inst.kind === 'file') {
      return yield* homeSubExistsOrFail(
        homeDir,
        `.config/opencode/${sectionDir(inst.section)}/${inst.name}.md`,
        docker,
      )
    }
    if (inst.kind === 'plugin') {
      const relDir = '.config/opencode/plugins'
      if (inst.target !== undefined) {
        return yield* homeSubExistsOrFail(homeDir, `${relDir}/${path.basename(inst.target)}`, docker)
      }
      return (
        (yield* homeSubExistsOrFail(homeDir, `${relDir}/${inst.name}.js`, docker)) ||
        (yield* homeSubExistsOrFail(homeDir, `${relDir}/${inst.name}`, docker))
      )
    }
    return yield* mcpPresentIn(homeDir, inst.name)
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
    const model = input.runInput.model
    const timeoutMs = input.runInput.timeouts.preflightSeconds * 1000
    const docker = dockerFromInput(input)
    yield* runOpencodeLaunch(input.homePaths.old, 'old', docker, checks)
    yield* runAuthPing(input.homePaths.old, 'old', model, input.configs?.old, timeoutMs, docker, checks)
    yield* runBuildAgent(input.homePaths.old, 'old', checks)
    // Pack-leak assertion: no pack files may have landed on the old side.
    const pack = input.packInstall
    if (pack !== undefined && pack.detectedType !== null) {
      for (const inst of pack.instructions) {
        const leaked = yield* leakedOntoOld(inst, input.homePaths.old, docker)
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
    const logPath = path.join(input.runInput.outputPath, 'preflight.log')
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
      { name: 'opencode-launch', run: (c) => gateOpencodeLaunch(input, c) },
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
