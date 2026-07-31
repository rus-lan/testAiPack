/**
 * Phase 05: preflight
 *
 * Runs 6 sequential gates (opencode-launch, auth-ping, build-agent,
 * pack-visibility, foreign-pack-absent, pack-functional) to fail fast before
 * the expensive N-variant runs. `--no-preflight` skips the phase entirely.
 * A gate failure throws a PhaseError whose `context.exitCode` ∈ {2,3} matches
 * the PreflightResult contract (2 = general failure, 3 = pack invisible /
 * not functional on a declaring variant).
 *
 * The invariant enforced across gates 4-6, for every variant V with declared
 * pack set P(V): every pack in P(V) is visible in V's run-1 HOME (gate 4);
 * every pack declared by some OTHER variant is not visible in V's run-1 HOME
 * (gate 5); every pack with a `check` command exits 0 in every HOME of every
 * variant declaring it, and non-zero in every HOME of every variant that
 * does not (gate 6), unless overridden via `variant.allowPacks`.
 *
 * Exception: a pack delivered purely via `setup` (a CLI installed into
 * $HOME, no skill/agent/command/plugin files phase 03 can see) records zero
 * registration instructions by design. Gates 4/5 pass such a pack without
 * files to check rather than rejecting it, but never report it as
 * confirmed — that would only be true, and gate 6 proves it, when the pack
 * also declares `check`.
 *
 * @see docs/phases/05-preflight.ru.md
 * @see contract/phases/05-preflight.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import type {
  HomeCheckTarget,
  PackCmdResult,
  PackSpec,
  PreflightCheck,
  PreflightError,
  PreflightInput,
  PreflightResult,
  VariantConfig,
  VariantSpec,
} from '@generated/types'
import type { PackInstallOutcome, RegistrationInstruction } from './03-pack-install.js'
import { packsOf, foreignPacksOf, effectiveOf } from './00-cli-parse.js'
import { run as opencodeRun, version as opencodeVersion } from '../opencode/cli.js'
import type { DockerExec, OpencodeError } from '../opencode/cli.js'
import { dockerRun, ensureImage } from '../isolation/docker-runner.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import type { DockerError } from '../isolation/docker-runner.js'
import { runShellInHome } from '../isolation/shell-runner.js'
import { appendFile, ensureDir, exists, readFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import type { PhaseError } from '../errors.js'
import { preflightError } from '../errors.js'

/**
 * Local result extension: gate 6 (`pack-functional`) also produces the
 * `checks` half of `PrepReport` (§7.2 of the pack-setup spec) — the contract
 * `PreflightResult` only carries `PreflightCheck[]` (pass/fail + duration),
 * which cannot hold a check command's exit code/output tail.
 * `cli/pipeline.ts` merges this into the accumulating `PrepReport` alongside
 * phase 04b's `setup` and the per-run `exercises`.
 */
export interface PreflightResultExt extends PreflightResult {
  readonly packChecks?: readonly PackCmdResult[]
}

/**
 * Local input extension: phase 05 needs the phase-03 outcome (per-pack
 * instructions) to perform accurate pack-visibility (gate 4) and
 * foreign-pack-absent (gate 5) checks, and the per-variant generated configs
 * (phase 04) to run auth-ping against the same model/provider the actual
 * runs will use.
 */
export interface PreflightInputExt extends PreflightInput {
  readonly packInstall: PackInstallOutcome
  readonly dockerImage?: string
  readonly configs?: readonly VariantConfig[]
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

type GateName = PreflightError['check']

const fail = (
  code: Parameters<typeof preflightError>[1],
  check: GateName,
  variant: string,
  exitCode: 2 | 3,
  message: string,
  checks: readonly PreflightCheck[],
  context?: Record<string, unknown>,
): Effect.Effect<never, PhaseError> =>
  Effect.fail(
    preflightError(message, code, {
      check,
      variant,
      exitCode,
      checks: [...checks],
      ...(context ?? {}),
    }),
  )

const ensureResultsDir = (logPath: string, variant: string): Effect.Effect<void, PhaseError> =>
  ensureDir(path.dirname(logPath)).pipe(
    Effect.mapError((e: FsError) =>
      preflightError(`cannot create preflight results dir: ${e.path}`, 'E_PREFLIGHT_FAILED', {
        check: 'opencode-launch',
        variant,
        exitCode: 2,
        path: e.path,
      }),
    ),
  )

const writeLog = (logPath: string, line: string, variant: string): Effect.Effect<void, PhaseError> =>
  appendFile(logPath, line).pipe(
    Effect.mapError((e: FsError) =>
      preflightError(`cannot write preflight log: ${e.path}`, 'E_PREFLIGHT_FAILED', {
        check: 'opencode-launch',
        variant,
        exitCode: 2,
        path: e.path,
      }),
    ),
  )

const isTimeout = (e: OpencodeError): boolean => e.timedOut
const stderrOf = (e: OpencodeError): string =>
  e.stderr || e.stdout || ''

/** Every registered HOME for one variant, run-1 first. Empty when the caller wired `homesForCheck` wrong. */
const homesForVariant = (input: PreflightInputExt, variantName: string): readonly HomeCheckTarget[] =>
  input.homesForCheck.find((v) => v.name === variantName)?.homes ?? []

/**
 * Fails loudly (infra failure, exit 2) rather than silently running zero
 * checks when a variant has no entry in `homesForCheck` — that would hide a
 * pipeline wiring bug behind a preflight that quietly does nothing for it.
 */
const requireHomes = (
  input: PreflightInputExt,
  variantName: string,
  check: GateName,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly HomeCheckTarget[], PhaseError> => {
  const homes = homesForVariant(input, variantName)
  return homes.length === 0
    ? fail(
        'E_PREFLIGHT_FAILED',
        check,
        variantName,
        2,
        `no HOME registered for variant '${variantName}' in homesForCheck`,
        checks,
      )
    : Effect.succeed(homes)
}

/** Run-1 HOME for a variant — used by gates that only probe the first HOME. */
const requireFirstHome = (
  input: PreflightInputExt,
  variantName: string,
  check: GateName,
  checks: readonly PreflightCheck[],
): Effect.Effect<HomeCheckTarget, PhaseError> =>
  requireHomes(input, variantName, check, checks).pipe(
    Effect.map((homes) => homes[0]),
    Effect.flatMap((first) =>
      first === undefined
        ? fail(
            'E_PREFLIGHT_FAILED',
            check,
            variantName,
            2,
            `no HOME registered for variant '${variantName}' in homesForCheck`,
            checks,
          )
        : Effect.succeed(first),
    ),
  )

const configFor = (input: PreflightInputExt, variantName: string): string | undefined =>
  input.configs?.find((c) => c.name === variantName)?.config

// ---- gates 1-3 (per variant, run-1 HOME) -----------------------------------

const runOpencodeLaunch = (
  homeDir: string,
  variant: string,
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
            variant,
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
          ? fail('E_PREFLIGHT_TIMEOUT', 'opencode-launch', variant, 2, 'opencode --version timed out', checks)
          : fail(
              'E_PREFLIGHT_FAILED',
              'opencode-launch',
              variant,
              2,
              `opencode --version failed: ${stderrOf(e)}`,
              checks,
              { stderr: stderrOf(e) },
            ),
      ),
    )
    return { name: 'opencode-launch', variant, passed: true, durationMs: String(Date.now() - start) }
  })

const gateOpencodeLaunch = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const docker = dockerFromInput(input)
    return yield* Effect.forEach(
      input.runInput.variants,
      (variant) =>
        Effect.gen(function* () {
          const home = yield* requireFirstHome(input, variant.name, 'opencode-launch', checks)
          return yield* runOpencodeLaunch(home.homeDir, variant.name, docker, checks)
        }),
      { concurrency: 1 },
    )
  })

const runAuthPing = (
  homeDir: string,
  variant: string,
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
          return fail('E_PREFLIGHT_TIMEOUT', 'auth-ping', variant, 2, 'auth-ping timed out', checks)
        }
        if (AUTH_MISSING_RE.test(stderr)) {
          return fail('E_AUTH_MISSING', 'auth-ping', variant, 2, `no credentials: ${stderr}`, checks, { stderr })
        }
        return fail('E_PREFLIGHT_FAILED', 'auth-ping', variant, 2, `auth-ping failed: ${stderr}`, checks, { stderr })
      }),
    )
    return { name: 'auth-ping', variant, passed: true, durationMs: String(Date.now() - start) }
  })

const gateAuthPing = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const timeoutMs = input.runInput.timeouts.preflightSeconds * 1000
    const docker = dockerFromInput(input)
    return yield* Effect.forEach(
      input.runInput.variants,
      (variant) =>
        Effect.gen(function* () {
          const home = yield* requireFirstHome(input, variant.name, 'auth-ping', checks)
          // Per-variant effective model — probing the global model here while
          // a variant's own model is what phase 06 actually bakes into its
          // OPENCODE_CONFIG_CONTENT would let preflight pass while that
          // variant's real model has broken auth, deferring the failure to
          // the expensive run phase.
          const model = effectiveOf(variant, input.runInput.model, 'model')
          const configContent = configFor(input, variant.name)
          return yield* runAuthPing(home.homeDir, variant.name, model, configContent, timeoutMs, docker, checks)
        }),
      { concurrency: 1 },
    )
  })

const runBuildAgent = (
  homeDir: string,
  variant: string,
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
        variant,
        2,
        `build agent missing in variant '${variant}' HOME`,
        checks,
      )
    }
    return { name: 'build-agent', variant, passed: true, durationMs: String(Date.now() - start) }
  })

const gateBuildAgent = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    return yield* Effect.forEach(
      input.runInput.variants,
      (variant) =>
        Effect.gen(function* () {
          const home = yield* requireFirstHome(input, variant.name, 'build-agent', checks)
          return yield* runBuildAgent(home.homeDir, variant.name, checks)
        }),
      { concurrency: 1 },
    )
  })

// ---- pack instruction visibility mechanics (unchanged from v1) ------------

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
  variant: string,
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
          `cannot verify a foreign pack did not leak into variant '${variant}': ${e.stderr || (e.timedOut ? 'docker check timed out' : `docker exit ${String(e.exitCode)}`)}`,
          'E_PREFLIGHT_FAILED',
          { check: 'foreign-pack-absent', variant, exitCode: 2, path: relPath },
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

/**
 * Fail-loud coverage is NOT uniform across instruction kinds. `skill`/`file`/
 * `plugin` route through `homeSubExistsOrFail`, which turns a docker/host
 * infra error into a thrown `PhaseError` rather than a silent `false` (see
 * its doc comment above). The `config`/`mcp` branch instead calls
 * `mcpPresentIn`, which reads a missing or unparseable `opencode.json` as
 * "not present" and never fails the Effect — judged acceptable rather than a
 * second gap: an unreadable config is equally unreadable to opencode itself,
 * so there is no daylight between "we couldn't check" and "opencode can't
 * see it either" for that one kind. In host mode, `exists()` (used by both
 * paths) also folds a permission error (EACCES) into `false` rather than
 * raising it — again a real filesystem answer in host mode, not a check that
 * silently didn't run.
 */
const leakedInto = (
  inst: RegistrationInstruction,
  homeDir: string,
  docker: DockerExec | undefined,
  variant: string,
): Effect.Effect<boolean, PhaseError> =>
  Effect.gen(function* () {
    if (inst.kind === 'skill') {
      return yield* homeSubExistsOrFail(homeDir, `.config/opencode/skills/${inst.name}`, docker, variant)
    }
    if (inst.kind === 'file') {
      return yield* homeSubExistsOrFail(
        homeDir,
        `.config/opencode/${sectionDir(inst.section)}/${inst.name}.md`,
        docker,
        variant,
      )
    }
    if (inst.kind === 'plugin') {
      const relDir = '.config/opencode/plugins'
      if (inst.target !== undefined) {
        return yield* homeSubExistsOrFail(homeDir, `${relDir}/${path.basename(inst.target)}`, docker, variant)
      }
      return (
        (yield* homeSubExistsOrFail(homeDir, `${relDir}/${inst.name}.js`, docker, variant)) ||
        (yield* homeSubExistsOrFail(homeDir, `${relDir}/${inst.name}`, docker, variant))
      )
    }
    return yield* mcpPresentIn(homeDir, inst.name)
  })

/** All instructions phase 03 recorded for one registry pack (empty when no delivery matches). */
const instructionsOfPack = (input: PreflightInputExt, packName: string): readonly RegistrationInstruction[] =>
  input.packInstall.deliveries.find((d) => d.pack === packName)?.instructions ?? []

// ---- gate 4: pack-visibility (per variant, per DECLARED pack) -------------

const gatePackVisibilityForPack = (
  input: PreflightInputExt,
  variant: VariantSpec,
  pack: PackSpec,
  homeDir: string,
  docker: DockerExec | undefined,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const insts = instructionsOfPack(input, pack.name)
    // An empty instruction list is NOT "nothing to check" — for a pack
    // without a `check` command this is the ONLY evidence gate 4 has of
    // presence, and phase 03 does not fail a pack whose layout it fails to
    // recognize (it just delivers zero instructions). Looping zero times and
    // returning `passed: true` would report a false confirmation downstream
    // (WP12's visibility map, phase 07's `visibilityConfirmed`) for a pack
    // that was never actually proven visible.
    //
    // A pack delivered entirely through `setup` (a CLI installed into $HOME,
    // e.g. `pipx install graphifyy`) is a legitimate exception: it has no
    // files phase 03 can recognize as a skill/agent/command/plugin, so zero
    // instructions is the expected, correct outcome, not a delivery bug —
    // failing loud here would reject every such pack unconditionally. Pass
    // instead of failing, but do NOT claim confirmation: the returned
    // `details` deliberately does not start with `pack-visibility [` (the
    // only string `resolvePackVisibilityConfirmed`, cli/pipeline.ts, reads as
    // proof), so this pack is carried downstream as "not confirmed" — the
    // honest state, with an existing rendering path
    // ("видимость не подтверждена" in report/md.ts and report/html.ts).
    // When the pack also declares `check`, gate 6 below independently proves
    // presence (exit 0 in every HOME of every declaring variant) and absence
    // elsewhere — a stronger, functional proof this gate does not duplicate.
    if (insts.length === 0) {
      if (pack.setup === undefined) {
        yield* fail(
          'E_PREFLIGHT_FAILED',
          'pack-visibility',
          variant.name,
          2,
          `no registration instructions recorded for pack '${pack.name}' — visibility cannot be proven`,
          checks,
          { pack: pack.name },
        )
      }
      const proof =
        pack.check === undefined
          ? 'no check command either — visibility is not verified by preflight at all for this pack'
          : "presence is instead proven by gate 6's check command"
      return {
        name: 'pack-visibility',
        variant: variant.name,
        passed: true,
        durationMs: String(Date.now() - start),
        details: `pack '${pack.name}' delivered via setup (no registration instructions) for variant '${variant.name}' — visibility not confirmed by gate 4; ${proof}`,
      }
    }
    for (const inst of insts) {
      const visible = yield* instructionVisible(inst, homeDir, docker)
      if (!visible) {
        yield* fail(
          'E_PREFLIGHT_PACK_INVISIBLE',
          'pack-visibility',
          variant.name,
          3,
          `pack '${pack.name}' not visible for variant '${variant.name}' (${inst.kind} ${instructionName(inst)})`,
          checks,
          { pack: pack.name, instruction: inst.kind, name: instructionName(inst) },
        )
      }
    }
    return {
      name: 'pack-visibility',
      variant: variant.name,
      passed: true,
      durationMs: String(Date.now() - start),
      details: `pack-visibility [${variant.name}/${pack.name}]`,
    }
  })

const gatePackVisibilityForVariant = (
  input: PreflightInputExt,
  variant: VariantSpec,
  docker: DockerExec | undefined,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const declared = packsOf(input.runInput, variant)
    if (declared.length === 0) {
      return [
        {
          name: 'pack-visibility' as const,
          variant: variant.name,
          passed: true,
          durationMs: String(Date.now() - start),
          details: 'skipped (no pack)',
        },
      ]
    }
    const home = yield* requireFirstHome(input, variant.name, 'pack-visibility', checks)
    const homeDir = home.homeDir
    return yield* Effect.forEach(
      declared,
      (pack) => gatePackVisibilityForPack(input, variant, pack, homeDir, docker, checks),
      { concurrency: 1 },
    )
  })

const gatePackVisibility = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const docker = dockerFromInput(input)
    const perVariant = yield* Effect.forEach(
      input.runInput.variants,
      (variant) => gatePackVisibilityForVariant(input, variant, docker, checks),
      { concurrency: 1 },
    )
    return perVariant.flat()
  })

// ---- gate 5: foreign-pack-absent (per variant, per FOREIGN pack) ----------

const gateForeignPackAbsentForPack = (
  input: PreflightInputExt,
  variant: VariantSpec,
  pack: PackSpec,
  homeDir: string,
  docker: DockerExec | undefined,
  checks: readonly PreflightCheck[],
): Effect.Effect<PreflightCheck, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const insts = instructionsOfPack(input, pack.name)
    // Symmetric with gate 4's guard above: an empty instruction list means
    // absence was never actually checked, not that there is nothing to leak.
    //
    // Same CLI-installed exception as gate 4: a pack delivered via `setup`
    // has no files to check for a leak either, so pass instead of failing —
    // absence is proven instead by gate 6's foreign-must-fail direction when
    // the pack declares `check` (it must exit non-zero in every HOME of
    // every variant that does not declare the pack).
    if (insts.length === 0) {
      if (pack.setup === undefined) {
        yield* fail(
          'E_PREFLIGHT_FAILED',
          'foreign-pack-absent',
          variant.name,
          2,
          `no registration instructions recorded for foreign pack '${pack.name}' — absence cannot be proven`,
          checks,
          { pack: pack.name },
        )
      }
      const proof =
        pack.check === undefined
          ? 'no check command either — absence is not verified by preflight at all for this pack'
          : "absence is instead proven by gate 6's foreign-must-fail check"
      return {
        name: 'foreign-pack-absent',
        variant: variant.name,
        passed: true,
        durationMs: String(Date.now() - start),
        details: `foreign pack '${pack.name}' delivered via setup (no registration instructions) — absence not confirmed by gate 5 for variant '${variant.name}'; ${proof}`,
      }
    }
    for (const inst of insts) {
      const leaked = yield* leakedInto(inst, homeDir, docker, variant.name)
      if (leaked) {
        yield* fail(
          'E_PREFLIGHT_FAILED',
          'foreign-pack-absent',
          variant.name,
          2,
          `foreign pack '${pack.name}' leaked into variant '${variant.name}' (${inst.kind} ${instructionName(inst)})`,
          checks,
          { pack: pack.name, instruction: inst.kind, name: instructionName(inst) },
        )
      }
    }
    return {
      name: 'foreign-pack-absent',
      variant: variant.name,
      passed: true,
      durationMs: String(Date.now() - start),
      details: `foreign-pack-absent [${variant.name}/${pack.name}]`,
    }
  })

const gateForeignPackAbsentForVariant = (
  input: PreflightInputExt,
  variant: VariantSpec,
  docker: DockerExec | undefined,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const foreign = foreignPacksOf(input.runInput, variant)
    if (foreign.length === 0) {
      return [
        {
          name: 'foreign-pack-absent' as const,
          variant: variant.name,
          passed: true,
          durationMs: String(Date.now() - start),
          details: 'skipped (no foreign pack)',
        },
      ]
    }
    const home = yield* requireFirstHome(input, variant.name, 'foreign-pack-absent', checks)
    const homeDir = home.homeDir
    return yield* Effect.forEach(
      foreign,
      (pack) => gateForeignPackAbsentForPack(input, variant, pack, homeDir, docker, checks),
      { concurrency: 1 },
    )
  })

const gateForeignPackAbsent = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<readonly PreflightCheck[], PhaseError> =>
  Effect.gen(function* () {
    const docker = dockerFromInput(input)
    const perVariant = yield* Effect.forEach(
      input.runInput.variants,
      (variant) => gateForeignPackAbsentForVariant(input, variant, docker, checks),
      { concurrency: 1 },
    )
    return perVariant.flat()
  })

/**
 * Gate 6: for every registry pack with a `check` command, that command must
 * exit 0 in EVERY HOME of every variant declaring the pack (it is genuinely
 * functional there, not just delivered — gate 4 only proves the files exist)
 * and must exit NON-ZERO in EVERY HOME of every variant that does NOT
 * declare it (otherwise the comparison against that variant is meaningless —
 * `variant.allowPacks` overrides this one assertion, nothing else). Checking
 * only each variant's run-1 HOME would prove nothing about the rest: 04b
 * builds every other HOME by copying the ONE home it installed into, and
 * nothing upstream of this gate proves that copy actually carried a working
 * install to every run (see the `copyDir`/`verbatimSymlinks` fix in
 * `util/fs.ts` for one concrete way it silently didn't).
 *
 * "Non-zero" on a non-declaring variant means exactly that — ANY non-zero
 * exit is the invariant holding, not just exit 1. A shell reports a missing
 * command as exit 127 (`sh: 1: graphify: not found`), not 1; treating
 * anything other than {0,1} as an infra fault would make the expected,
 * required outcome on a real run abort the whole experiment (`graphify: not
 * found` on a non-declaring variant is success, not an error). The only
 * reliable "the check itself did not run" signal available at this layer is
 * `outcome.timedOut` — `runShellInHome` already folds a docker-level failure
 * into the same `ShellOutcome` shape a normal command completion uses, so a
 * non-zero `exitCode` cannot be told apart from "the container ran and its
 * command exited N" by inspecting the code alone; a timeout is unambiguous
 * regardless of variant and fails loudly, same fail-loud-on-infra-error
 * principle `homeSubExistsOrFail` already applies to gate 5's leak check.
 *
 * Runs `{pack-with-check} × {variant} × {HOME}` sequentially at every level
 * (`concurrency: 1` throughout) — preflight is cheap relative to the runs it
 * gates; parallelizing here risks docker daemon contention for zero benefit.
 */
type PackWithCheck = PackSpec & { readonly check: string }
const hasCheck = (p: PackSpec): p is PackWithCheck => p.check !== undefined

const runPackCheckOnce = (
  pack: PackWithCheck,
  variant: VariantSpec,
  declared: boolean,
  home: HomeCheckTarget,
  runIndex: number,
  docker: DockerExec | undefined,
  timeoutMs: number,
  checks: readonly PreflightCheck[],
): Effect.Effect<{ readonly check: PreflightCheck; readonly cmdResult: PackCmdResult }, PhaseError> =>
  Effect.gen(function* () {
    const start = Date.now()
    const outcome = yield* runShellInHome(pack.check, home.homeDir, home.homeDir, docker, timeoutMs, home.pathOverride)
    const cmdResult: PackCmdResult = {
      variant: variant.name,
      pack: pack.name,
      runIndex,
      exitCode: outcome.exitCode,
      durationMs: String(outcome.durationMs),
      outputTail: outcome.outputTail,
    }
    if (outcome.timedOut) {
      yield* fail(
        'E_PACK_CHECK_FAILED',
        'pack-functional',
        variant.name,
        2,
        `pack check for '${pack.name}' could not run on variant '${variant.name}' (home ${String(runIndex)}): timed out`,
        checks,
        { pack: pack.name, variant: variant.name, runIndex, timedOut: true, processExitCode: outcome.exitCode },
      )
    }
    const toolPresent = outcome.exitCode === 0
    const allowed = variant.allowPacks?.includes(pack.name) ?? false
    if (declared && !toolPresent) {
      yield* fail(
        'E_PACK_CHECK_FAILED',
        'pack-functional',
        variant.name,
        3,
        `pack check for '${pack.name}' failed on variant '${variant.name}' (home ${String(runIndex)}) — the pack was delivered but is not functional in this HOME`,
        checks,
        { pack: pack.name, variant: variant.name, runIndex, reason: 'declared-not-functional' },
      )
    }
    if (!declared && toolPresent && !allowed) {
      yield* fail(
        'E_PACK_CHECK_FAILED',
        'pack-functional',
        variant.name,
        3,
        `pack check for '${pack.name}' unexpectedly passed on variant '${variant.name}' (home ${String(runIndex)}) — this variant does not declare the pack, so the comparison would be meaningless. Add '${pack.name}' to variant.allowPacks to override.`,
        checks,
        { pack: pack.name, variant: variant.name, runIndex, reason: 'foreign-tool-present' },
      )
    }
    const overridden = !declared && toolPresent && allowed
    return {
      check: {
        name: 'pack-functional',
        variant: variant.name,
        passed: true,
        durationMs: String(Date.now() - start),
        ...(overridden
          ? {
              details: `foreign pack '${pack.name}' present on variant '${variant.name}' (home ${String(runIndex)}) — allowed via allowPacks; comparison validity is reduced`,
            }
          : {}),
      },
      cmdResult,
    }
  })

const summarizeVariantPack = (
  variant: string,
  pack: string,
  results: readonly { readonly check: PreflightCheck; readonly cmdResult: PackCmdResult }[],
): PreflightCheck => {
  const totalMs = results.reduce((sum, r) => sum + Number(r.check.durationMs), 0)
  const overriddenCount = results.filter((r) => r.check.details !== undefined).length
  const overrideNote = overriddenCount === 0 ? '' : ` (${String(overriddenCount)} allowed via allowPacks)`
  return {
    name: 'pack-functional',
    variant,
    passed: true,
    durationMs: String(totalMs),
    details: `pack-functional [${pack} @ ${variant}] ${String(results.length)}/${String(results.length)} HOME(s) verified${overrideNote}`,
  }
}

interface PackFunctionalOutcome {
  readonly checks: readonly PreflightCheck[]
  readonly packChecks: readonly PackCmdResult[]
}

const gatePackFunctionalForVariant = (
  input: PreflightInputExt,
  variant: VariantSpec,
  packsWithCheck: readonly PackWithCheck[],
  docker: DockerExec | undefined,
  timeoutMs: number,
  checks: readonly PreflightCheck[],
): Effect.Effect<PackFunctionalOutcome, PhaseError> =>
  Effect.gen(function* () {
    const homes = yield* requireHomes(input, variant.name, 'pack-functional', checks)
    const declaredNames = new Set(packsOf(input.runInput, variant).map((p) => p.name))
    const perPack = yield* Effect.forEach(
      packsWithCheck,
      (pack) =>
        Effect.gen(function* () {
          const declared = declaredNames.has(pack.name)
          const results = yield* Effect.forEach(
            homes,
            (h, idx) => runPackCheckOnce(pack, variant, declared, h, idx + 1, docker, timeoutMs, checks),
            { concurrency: 1 },
          )
          return {
            check: summarizeVariantPack(variant.name, pack.name, results),
            cmdResults: results.map((r) => r.cmdResult),
          }
        }),
      { concurrency: 1 },
    )
    return {
      checks: perPack.map((p) => p.check),
      packChecks: perPack.flatMap((p) => p.cmdResults),
    }
  })

const gatePackFunctional = (
  input: PreflightInputExt,
  checks: readonly PreflightCheck[],
): Effect.Effect<PackFunctionalOutcome, PhaseError> =>
  Effect.gen(function* () {
    const packsWithCheck = input.runInput.packs.filter(hasCheck)
    if (packsWithCheck.length === 0) {
      return {
        checks: input.runInput.variants.map((v) => ({
          name: 'pack-functional' as const,
          variant: v.name,
          passed: true,
          durationMs: '0',
          details: 'skipped (no check)',
        })),
        packChecks: [],
      }
    }
    const docker = dockerFromInput(input)
    const timeoutMs = input.runInput.timeouts.installSeconds * 1000
    const perVariant = yield* Effect.forEach(
      input.runInput.variants,
      (variant) => gatePackFunctionalForVariant(input, variant, packsWithCheck, docker, timeoutMs, checks),
      { concurrency: 1 },
    )
    return {
      checks: perVariant.flatMap((v) => v.checks),
      packChecks: perVariant.flatMap((v) => v.packChecks),
    }
  })

const formatLine = (c: PreflightCheck): string => {
  const status = c.passed ? 'PASSED' : 'FAILED'
  const details = c.details === undefined ? '' : ` ${c.details}`
  return `[CHECK] ${c.name} [${c.variant}] ${status} (${c.durationMs}ms)${details}\n`
}

export const preflight = (input: PreflightInputExt): Effect.Effect<PreflightResultExt, PhaseError> =>
  Effect.gen(function* () {
    const logPath = path.join(input.runInput.outputPath, 'preflight.log')
    const firstVariant = input.runInput.variants[0]?.name ?? ''
    yield* ensureResultsDir(logPath, firstVariant)

    if (!input.runInput.preflightEnabled) {
      yield* writeLog(logPath, 'preflight skipped (--no-preflight)\n', firstVariant)
      return { checks: [], allPassed: true, exitCode: 0, logPath }
    }

    interface Gate {
      readonly name: GateName
      readonly run: (checks: readonly PreflightCheck[]) => Effect.Effect<PackFunctionalOutcome, PhaseError>
    }

    const noPackChecks = (
      eff: Effect.Effect<readonly PreflightCheck[], PhaseError>,
    ): Effect.Effect<PackFunctionalOutcome, PhaseError> =>
      eff.pipe(Effect.map((checks) => ({ checks, packChecks: [] as readonly PackCmdResult[] })))

    const gates: readonly Gate[] = [
      { name: 'opencode-launch', run: (c) => noPackChecks(gateOpencodeLaunch(input, c)) },
      { name: 'auth-ping', run: (c) => noPackChecks(gateAuthPing(input, c)) },
      { name: 'build-agent', run: (c) => noPackChecks(gateBuildAgent(input, c)) },
      { name: 'pack-visibility', run: (c) => noPackChecks(gatePackVisibility(input, c)) },
      { name: 'foreign-pack-absent', run: (c) => noPackChecks(gateForeignPackAbsent(input, c)) },
      { name: 'pack-functional', run: (c) => gatePackFunctional(input, c) },
    ]

    const finalOutcome = yield* Effect.reduce(
      gates,
      { checks: [] as readonly PreflightCheck[], packChecks: [] as readonly PackCmdResult[] },
      (acc, gate) =>
        Effect.gen(function* () {
          const produced = yield* gate.run(acc.checks)
          for (const check of produced.checks) {
            yield* writeLog(logPath, formatLine(check), check.variant)
          }
          return {
            checks: [...acc.checks, ...produced.checks],
            packChecks: [...acc.packChecks, ...produced.packChecks],
          }
        }),
    )

    return {
      checks: [...finalOutcome.checks],
      allPassed: true,
      exitCode: 0,
      logPath,
      ...(finalOutcome.packChecks.length === 0 ? {} : { packChecks: [...finalOutcome.packChecks] }),
    }
  })
