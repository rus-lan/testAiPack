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
  Side,
} from '@generated/types'
import type { PackInstallOutcome, RegistrationInstruction } from './03-pack-install.js'
import { installPlugin } from '../opencode/cli.js'
import type { OpencodeError } from '../opencode/cli.js'
import { copyDir, copyFile, ensureDir, pathKind, removeDir, symlink, writeFile } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import type { PhaseError } from '../errors.js'
import { homeIsolationError } from '../errors.js'

/**
 * Local input extension: widens `packInstall` from the contract's
 * `PackInstallResult` to phase 03's `PackInstallOutcome` (which carries the
 * `instructions` field). The orchestrator always has the outcome from phase 03;
 * this interface is the honest type for that hand-off.
 */
export interface HomeIsolationInputExt extends HomeIsolationInput {
  readonly packInstall?: PackInstallOutcome
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
  { flag: 'opencode', src: '.opencode', dst: '.opencode' },
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

const applyInstruction = (
  inst: RegistrationInstruction,
  homeDir: string,
  installSeconds: number,
): Effect.Effect<void, PhaseError> => {
  switch (inst.kind) {
    case 'symlink':
      return Effect.gen(function* () {
        const linkPath = path.join(homeDir, '.config/opencode/skills', inst.name)
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
      return installPlugin(homeDir, inst.name).pipe(
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
      return Effect.fail(
        setupFail('mcp config instructions are not supported in MVP (v0.3)', {
          section: inst.section,
        }),
      )
  }
}

interface PackInfo {
  readonly type: PackInstallOutcome['detectedType']
  readonly name: string
  readonly registeredIn: readonly string[]
}

const packInfoFrom = (outcome: PackInstallOutcome): PackInfo => {
  const head = outcome.instructions.find((i) => i.kind !== 'config')
  return {
    type: outcome.detectedType,
    name: head === undefined ? 'pack' : head.name,
    registeredIn: outcome.registeredIn,
  }
}

const buildConfig = (side: Side, pack: PackInfo | undefined): string => {
  const base: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      build: {
        mode: 'primary',
        description: 'Build agent',
      },
    },
  }
  const withPack =
    side === 'new' && pack !== undefined && pack.type !== null
      ? {
          ...base,
          testaipack: {
            packName: pack.name,
            packType: pack.type,
            registeredIn: [...pack.registeredIn],
          },
        }
      : base
  return JSON.stringify(withPack, null, 2)
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
): Effect.Effect<HomeIsolationResult, PhaseError> =>
  Effect.gen(function* () {
    if (input.runInput.isolation === 'docker') {
      yield* Effect.fail(
        homeIsolationError(
          'docker isolation is not supported in MVP (v0.3)',
          'E_DOCKER_FAILED',
          { isolation: 'docker' },
        ),
      )
    }
    const runs = input.runInput.runs
    const sourceHome = os.homedir()
    const authFlags = input.runInput.auth
    const installSeconds = input.runInput.timeouts.installSeconds
    const packOutcome = input.packInstall
    const packInfo = packOutcome === undefined ? undefined : packInfoFrom(packOutcome)
    const baselineCfg = buildConfig('old', packInfo)
    const newCfg = buildConfig('new', packInfo)

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
                  (inst) => applyInstruction(inst, homeDir, installSeconds),
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
    }
  })
