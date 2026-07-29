/**
 * Phase 04: home-isolation
 *
 * For each `(side, run-N)` builds an isolated fake $HOME with the opencode
 * skeleton, copies auth by whitelist, applies the pack (delivered by phase 03)
 * on the new side only, writes a `build` agent into every HOME, and produces
 * two `OPENCODE_CONFIG_CONTENT` payloads (baseline / new) plus a 2D env-var
 * matrix `[side][run]`.
 *
 * @see docs/phases/04-home-isolation.ru.md
 * @see contract/phases/04-home-isolation.tsp
 */
import { Effect } from 'effect'
import { Duration } from 'effect'
import path from 'node:path'
import os from 'node:os'
import type {
  EnvVarSet,
  HomeIsolationInput,
  HomeIsolationResult,
  HomeTree,
  IsolationMode,
  Side,
} from '@generated/types'
import type { PackInstallOutcome, RegistrationInstruction } from './03-pack-install.js'
import { installPlugin } from '../opencode/cli.js'
import type { DockerExec, OpencodeError } from '../opencode/cli.js'
import { copyDir, copyFile, ensureDir, exists, isPathWithin, pathKind, readFile, removeDir, symlink, writeFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import type { PhaseError } from '../errors.js'
import { homeIsolationError } from '../errors.js'

/**
 * Local input extension: widens `packInstall` from the contract's
 * `PackInstallResult` to phase 03's `PackInstallOutcome` (which carries the
 * `instructions` field), and carries the optional `dockerImage` override
 * (`--docker-image`) for `--isolation=docker`. The orchestrator always has the
 * outcome from phase 03; this interface is the honest type for that hand-off.
 */
export interface HomeIsolationInputExt extends HomeIsolationInput {
  readonly packInstall?: PackInstallOutcome
  readonly dockerImage?: string
}

/**
 * Local result extension: records the resolved `isolation` mode and, for docker
 * mode, the image that downstream phases (05 preflight, 06 run-side) must use.
 * The contract `HomeIsolationResult` is the wire shape; these fields are
 * in-process plumbing only.
 */
export interface HomeIsolationResultExt extends HomeIsolationResult {
  readonly isolation: IsolationMode
  readonly dockerImage?: string
}

const BUILD_AGENT_TEMPLATE = `---
name: build
description: Build agent with all tools enabled
mode: primary
---

You are a build agent with full tool access. Execute the task step by step using available tools: read, write, edit files, and run bash commands.
`

/** opencode layout: skills/agents/plugins are plural, command is singular. */
const sectionDir = (section: 'agents' | 'commands'): string =>
  section === 'agents' ? 'agents' : 'command'

const SKELETON_DIRS: readonly string[] = [
  '.config/opencode/skills',
  '.config/opencode/agents',
  '.config/opencode/plugins',
  '.config/opencode/command',
  '.opencode',
  '.cache/opencode',
  '.local/share/opencode',
]

interface AuthEntry {
  readonly flag: keyof HomeIsolationInput['runInput']['auth']
  readonly src: string
  readonly dst: string
}

const AUTH_TABLE: readonly AuthEntry[] = [
  // opencode stores provider credentials in $XDG_DATA_HOME/opencode/auth.json
  // (default ~/.local/share/opencode/auth.json). Only auth.json is needed — the
  // sibling opencode.db holds session history and can be multi-GB, so we never
  // copy the whole data dir. The dst dir is created by SKELETON_DIRS.
  { flag: 'opencode', src: '.local/share/opencode/auth.json', dst: '.local/share/opencode/auth.json' },
  { flag: 'npmrc', src: '.npmrc', dst: '.npmrc' },
  { flag: 'anthropic', src: '.config/anthropic', dst: '.config/anthropic' },
  { flag: 'openai', src: '.config/openai', dst: '.config/openai' },
  { flag: 'gemini', src: '.config/gemini', dst: '.config/gemini' },
  { flag: 'aws', src: '.aws', dst: '.aws' },
  { flag: 'ssh', src: '.ssh', dst: '.ssh' },
  { flag: 'git', src: '.gitconfig', dst: '.gitconfig' },
]

const setupFail = (message: string, context: Record<string, unknown>): PhaseError =>
  homeIsolationError(message, 'E_HOME_SETUP_FAILED', context)

const mapFs = (e: FsError, side: Side, runIndex: number): PhaseError =>
  setupFail(`HOME setup failed: ${e.operation} ${e.path}`, { side, runIndex, path: e.path })

const range = (n: number): readonly number[] =>
  Array.from({ length: n }, (_, i) => i)

const buildSkeleton = (
  homeDir: string,
  side: Side,
  runIndex: number,
): Effect.Effect<readonly string[], PhaseError> =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      SKELETON_DIRS,
      (rel) =>
        ensureDir(path.join(homeDir, rel)).pipe(Effect.mapError((e) => mapFs(e, side, runIndex))),
      { concurrency: 1 },
    )
    yield* writeFile(
      path.join(homeDir, '.config/opencode/agents/build.md'),
      BUILD_AGENT_TEMPLATE,
    ).pipe(Effect.mapError((e) => mapFs(e, side, runIndex)))
    return [...SKELETON_DIRS]
  })

const copyOneAuth = (src: string, dst: string): Effect.Effect<boolean, FsError> =>
  Effect.gen(function* () {
    const kind = yield* pathKind(src)
    if (kind === 'missing') return false
    if (kind === 'dir') {
      yield* copyDir(src, dst)
    } else {
      yield* copyFile(src, dst)
    }
    return true
  })

const copyAuth = (
  homeDir: string,
  sourceHome: string,
  flags: HomeIsolationInput['runInput']['auth'],
): Effect.Effect<readonly string[], PhaseError> =>
  Effect.gen(function* () {
    const enabled = AUTH_TABLE.filter((entry) => flags[entry.flag])
    const marked = yield* Effect.forEach(
      enabled,
      (entry) =>
        Effect.gen(function* () {
          const src = path.join(sourceHome, entry.src)
          const dst = path.join(homeDir, entry.dst)
          const ok = yield* copyOneAuth(src, dst).pipe(
            Effect.mapError((e: FsError) =>
              homeIsolationError(`auth copy failed: ${e.path}`, 'E_HOME_SETUP_FAILED', {
                source: src,
                path: e.path,
              }),
            ),
          )
          return ok ? entry.dst : null
        }),
      { concurrency: 1 },
    )
    return marked.filter((r): r is string => r !== null)
  })

const readOpendcodeConfig = (
  cfgPath: string,
): Effect.Effect<Record<string, unknown>, PhaseError> =>
  Effect.gen(function* () {
    if (!(yield* exists(cfgPath))) return {}
    const raw = yield* readFile(cfgPath).pipe(
      Effect.mapError((e: FsError) =>
        setupFail(`cannot read opencode.json: ${e.path}`, { path: e.path }),
      ),
    )
    try {
      const obj = JSON.parse(raw) as unknown
      return isRecord(obj) ? obj : {}
    } catch {
      return {}
    }
  })

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

export interface SourceConnectivity {
  readonly model: string | undefined
  readonly provider: Record<string, unknown> | undefined
  readonly smallModel: string | undefined
  readonly enabledProviders: readonly string[] | undefined
  readonly disabledProviders: readonly string[] | undefined
}

const EMPTY_CONNECTIVITY: SourceConnectivity = {
  model: undefined,
  provider: undefined,
  smallModel: undefined,
  enabledProviders: undefined,
  disabledProviders: undefined,
}

/**
 * Read the connectivity/model-selection fields from the user's source
 * opencode.json in one pass: `model`, `small_model`, `provider`,
 * `enabled_providers`, `disabled_providers`. The isolated config is built
 * from scratch, so without these an isolated run has no way to know a custom
 * provider exists (e.g. a local model server), which model to use, or that
 * the user's real config gates providers at all — even though all of it
 * lives in the same real config file. Every field is independently optional;
 * an unexpected shape for any one field is treated the same as absent rather
 * than thrown. Returns all-undefined when the source config itself is
 * absent or unreadable.
 */
const readSourceConnectivity = (sourceHome: string): Effect.Effect<SourceConnectivity, PhaseError> =>
  Effect.gen(function* () {
    const cfgPath = path.join(sourceHome, '.config/opencode/opencode.json')
    if (!(yield* exists(cfgPath))) return EMPTY_CONNECTIVITY
    const raw = yield* readFile(cfgPath).pipe(Effect.catchAll(() => Effect.succeed('')))
    if (raw === '') return EMPTY_CONNECTIVITY
    try {
      const obj = JSON.parse(raw) as unknown
      if (!isRecord(obj)) return EMPTY_CONNECTIVITY
      return {
        model: typeof obj['model'] === 'string' ? obj['model'] : undefined,
        provider: isRecord(obj['provider']) ? obj['provider'] : undefined,
        smallModel: typeof obj['small_model'] === 'string' ? obj['small_model'] : undefined,
        enabledProviders: isStringArray(obj['enabled_providers']) ? obj['enabled_providers'] : undefined,
        disabledProviders: isStringArray(obj['disabled_providers']) ? obj['disabled_providers'] : undefined,
      }
    } catch {
      return EMPTY_CONNECTIVITY
    }
  })

const mergeMcpServer = (
  existing: Record<string, unknown>,
  name: string,
  json: unknown,
): Record<string, unknown> => {
  const prevMcp = isRecord(existing['mcp']) ? existing['mcp'] : {}
  return { ...existing, mcp: { ...prevMcp, [name]: json } }
}

const applyInstruction = (
  inst: RegistrationInstruction,
  homeDir: string,
  installSeconds: number,
  docker: DockerExec | undefined,
): Effect.Effect<void, PhaseError> => {
  switch (inst.kind) {
    case 'symlink':
      return Effect.gen(function* () {
        const skillsDir = path.join(homeDir, '.config/opencode/skills')
        const linkPath = path.join(skillsDir, inst.name)
        if (!isPathWithin(skillsDir, linkPath)) {
          yield* Effect.fail(
            setupFail(`skill link escapes skills dir: ${linkPath}`, {
              name: inst.name,
              path: linkPath,
            }),
          )
        }
        yield* removeDir(linkPath).pipe(Effect.catchAll(() => Effect.void))
        yield* symlink(inst.target, linkPath).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot create skill symlink: ${e.path}`, {
              target: inst.target,
              link: linkPath,
            }),
          ),
        )
      })
    case 'file':
      return Effect.gen(function* () {
        const dstDir = path.join(homeDir, '.config/opencode', sectionDir(inst.section))
        yield* ensureDir(dstDir).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot create ${inst.section} dir: ${e.path}`, { path: e.path }),
          ),
        )
        const dstFile = path.join(dstDir, `${inst.name}.md`)
        yield* copyFile(inst.target, dstFile).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot place ${inst.section} file: ${e.path}`, {
              source: inst.target,
              path: e.path,
            }),
          ),
        )
      })
    case 'plugin':
      return installPlugin(homeDir, inst.name, ...(docker === undefined ? [] : [docker])).pipe(
        Effect.mapError((e: OpencodeError) =>
          homeIsolationError(`opencode plugin failed: ${e.stderr}`, 'E_PACK_INSTALL_FAILED', {
            module: inst.name,
            exitCode: e.exitCode,
          }),
        ),
        Effect.timeout(Duration.seconds(installSeconds)),
        Effect.catchTag('TimeoutException', () =>
          Effect.fail(
            homeIsolationError(
              `opencode plugin timed out after ${String(installSeconds)}s`,
              'E_PACK_INSTALL_TIMEOUT',
              { module: inst.name },
            ),
          ),
        ),
      )
    case 'config':
      return Effect.gen(function* () {
        const cfgPath = path.join(homeDir, '.config/opencode/opencode.json')
        const existing = yield* readOpendcodeConfig(cfgPath)
        const merged = mergeMcpServer(existing, inst.name, inst.json)
        yield* ensureDir(path.dirname(cfgPath)).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot create opencode config dir: ${e.path}`, { path: e.path }),
          ),
        )
        yield* writeFile(cfgPath, `${JSON.stringify(merged, null, 2)}\n`).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot write opencode.json: ${e.path}`, { path: e.path, server: inst.name }),
          ),
        )
      })
  }
}

interface PackInfo {
  readonly type: PackInstallOutcome['detectedType']
  readonly name: string
  readonly registeredIn: readonly string[]
}

const packInfoFrom = (outcome: PackInstallOutcome): PackInfo => {
  const head = outcome.instructions.find((i) => i.kind !== 'config')
  const configHead = outcome.instructions.find(
    (i): i is Extract<RegistrationInstruction, { readonly kind: 'config' }> => i.kind === 'config',
  )
  return {
    type: outcome.detectedType,
    name: head === undefined ? (configHead === undefined ? 'pack' : configHead.name) : head.name,
    registeredIn: outcome.registeredIn,
  }
}

const collectMcpServers = (
  instructions: readonly RegistrationInstruction[] | undefined,
): Record<string, unknown> => {
  if (instructions === undefined) return {}
  return instructions.reduce<Record<string, unknown>>(
    (acc, inst) =>
      inst.kind === 'config' ? { ...acc, [inst.name]: inst.json } : acc,
    {},
  )
}

/** Connectivity/model-selection fields copied as-is (no CLI override) into both sides' configs. */
export interface ConnectivityExtras {
  readonly provider: Record<string, unknown> | undefined
  readonly smallModel: string | undefined
  readonly enabledProviders: readonly string[] | undefined
  readonly disabledProviders: readonly string[] | undefined
}

const buildConfigObject = (
  side: Side,
  pack: PackInfo | undefined,
  mcpServers: Record<string, unknown>,
  model: string | undefined,
  extras: ConnectivityExtras,
): Record<string, unknown> => {
  const base: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    ...(model === undefined ? {} : { model }),
    ...(extras.provider === undefined ? {} : { provider: extras.provider }),
    ...(extras.smallModel === undefined ? {} : { small_model: extras.smallModel }),
    ...(extras.enabledProviders === undefined ? {} : { enabled_providers: [...extras.enabledProviders] }),
    ...(extras.disabledProviders === undefined ? {} : { disabled_providers: [...extras.disabledProviders] }),
    agent: {
      build: {
        mode: 'primary',
        description: 'Build agent',
      },
    },
  }
  if (side === 'new' && pack !== undefined && pack.type !== null) {
    return Object.keys(mcpServers).length > 0
      ? { ...base, mcp: { ...mcpServers } }
      : base
  }
  return base
}

const buildEnvVars = (
  homeDir: string,
  side: Side,
  baselineCfg: string,
  newCfg: string,
): EnvVarSet => ({
  HOME: homeDir,
  OPENCODE_DISABLE_PROJECT_CONFIG: true,
  OPENCODE_DISABLE_DEFAULT_PLUGINS: side === 'old',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: side === 'old',
  OPENCODE_PURE: side === 'old',
  OPENCODE_CONFIG_CONTENT: side === 'old' ? baselineCfg : newCfg,
})

interface SideResult {
  readonly trees: readonly HomeTree[]
  readonly envs: readonly EnvVarSet[]
}

export const homeIsolation = (
  input: HomeIsolationInputExt,
): Effect.Effect<HomeIsolationResultExt, PhaseError> =>
  Effect.gen(function* () {
    const isolation = input.runInput.isolation
    const dockerImage =
      isolation === 'docker' ? (input.dockerImage ?? DEFAULT_OPENCODE_IMAGE) : undefined
    const docker: DockerExec | undefined = dockerImage === undefined ? undefined : { image: dockerImage }
    const runs = input.runInput.runs
    const sourceHome = os.homedir()
    const authFlags = input.runInput.auth
    const installSeconds = input.runInput.timeouts.installSeconds
    const packOutcome = input.packInstall
    const packInfo = packOutcome === undefined ? undefined : packInfoFrom(packOutcome)
    const mcpServers = collectMcpServers(packOutcome?.instructions)
    const sourceConnectivity = yield* readSourceConnectivity(sourceHome)
    const runModel = input.runInput.model ?? sourceConnectivity.model
    const connectivityExtras: ConnectivityExtras = {
      provider: sourceConnectivity.provider,
      smallModel: sourceConnectivity.smallModel,
      enabledProviders: sourceConnectivity.enabledProviders,
      disabledProviders: sourceConnectivity.disabledProviders,
    }
    const baselineObj = buildConfigObject('old', packInfo, mcpServers, runModel, connectivityExtras)
    const newObj = buildConfigObject('new', packInfo, mcpServers, runModel, connectivityExtras)
    const baselineCfg = JSON.stringify(baselineObj, null, 2)
    const newCfg = JSON.stringify(newObj, null, 2)

    const configDir = input.workspace.config
    yield* ensureDir(configDir).pipe(
      Effect.mapError((e: FsError) => setupFail(`cannot create config dir: ${e.path}`, { path: e.path })),
    )
    yield* writeJson(path.join(configDir, 'baseline.json'), baselineObj).pipe(
      Effect.mapError((e: FsError) => setupFail(`cannot write baseline.json: ${e.path}`, { path: e.path })),
    )
    yield* writeJson(path.join(configDir, 'new.json'), newObj).pipe(
      Effect.mapError((e: FsError) => setupFail(`cannot write new.json: ${e.path}`, { path: e.path })),
    )

    const processSide = (side: Side): Effect.Effect<SideResult, PhaseError> =>
      Effect.gen(function* () {
        const homeList = side === 'old' ? input.workspace.homeOld : input.workspace.homeNew
        const perRun = yield* Effect.forEach(
          range(runs),
          (idx) =>
            Effect.gen(function* () {
              const runIndex = idx + 1
              const homeDir = homeList[idx] ?? ''
              if (homeDir === '') {
                yield* Effect.fail(
                  setupFail(`missing HOME path for side=${side} run=${String(runIndex)}`, {
                    side,
                    runIndex,
                  }),
                )
              }
              const structure = yield* buildSkeleton(homeDir, side, runIndex)
              const copiedAuth = yield* copyAuth(homeDir, sourceHome, authFlags)
              if (copiedAuth.length === 0) {
                yield* Effect.fail(
                  homeIsolationError(
                    `no auth sources found for side=${side} run=${String(runIndex)}`,
                    'E_AUTH_MISSING',
                    { side, runIndex, sourceHome },
                  ),
                )
              }
              if (side === 'new' && packOutcome !== undefined) {
                yield* Effect.forEach(
                  packOutcome.instructions,
                  (inst) => applyInstruction(inst, homeDir, installSeconds, docker),
                  { concurrency: 1 },
                )
              }
              const tree: HomeTree = {
                basePath: homeDir,
                structure: [...structure],
                copiedAuth: [...copiedAuth],
              }
              return { tree, env: buildEnvVars(homeDir, side, baselineCfg, newCfg) }
            }),
          { concurrency: 1 },
        )
        return {
          trees: perRun.map((p) => p.tree),
          envs: perRun.map((p) => p.env),
        }
      })

    const oldSide = yield* processSide('old')
    const newSide = yield* processSide('new')

    return {
      homeTrees: {
        old: [...oldSide.trees],
        new: [...newSide.trees],
      },
      envVars: [[...oldSide.envs], [...newSide.envs]],
      generatedConfigs: { baseline: baselineCfg, new: newCfg },
      isolation,
      ...(dockerImage === undefined ? {} : { dockerImage }),
    }
  })
