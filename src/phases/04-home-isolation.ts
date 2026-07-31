/**
 * Phase 04: home-isolation
 *
 * For each `(variant, run-N)` builds an isolated fake $HOME with the opencode
 * skeleton, copies auth by whitelist, applies the variant's declared pack(s)
 * (delivered by phase 03), writes a `build` agent into every HOME, and
 * produces one `OPENCODE_CONFIG_CONTENT` payload per variant plus a
 * `VariantEnv[]` (name + one `EnvVarSet` per run — no positional indexing).
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
  VariantConfig,
  VariantEnv,
  VariantHomes,
  VariantSpec,
} from '@generated/types'
import type { PackInstallOutcome, RegistrationInstruction } from './03-pack-install.js'
import { effectiveOf, packsOf } from './00-cli-parse.js'
import { installPlugin } from '../opencode/cli.js'
import type { DockerExec, OpencodeError } from '../opencode/cli.js'
import { copyDir, copyFile, ensureDir, exists, isPathWithin, pathKind, readFile, removeDir, writeFile, writeJson } from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import { DEFAULT_OPENCODE_IMAGE, probeImagePath } from '../isolation/docker-runner.js'
import type { DockerError } from '../isolation/docker-runner.js'
import { redactConfigSecrets } from '../util/redact.js'
import type { PhaseError } from '../errors.js'
import { homeIsolationError } from '../errors.js'

/**
 * Local input extension: widens `packInstall` from the contract's
 * `PackInstallResult` to phase 03's `PackInstallOutcome` (which carries the
 * `instructions` field per delivery), and carries the optional `dockerImage`
 * override (`--docker-image`) for `--isolation=docker`. The orchestrator
 * always has the outcome from phase 03; this interface is the honest type
 * for that hand-off. `Omit` (rather than re-declaring the field on top of
 * `extends HomeIsolationInput`) is the cleaner way to narrow a member's type
 * in a derived interface — no need to keep the base member's wire type in
 * scope at all.
 */
export interface HomeIsolationInputExt extends Omit<HomeIsolationInput, 'packInstall'> {
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

/**
 * Only added when at least one registry pack declares `setup` — on EVERY
 * variant identically (D, `05-risks.md §2.6`, NORMATIVE): a HOME-installed
 * binary must be equally *reachable* everywhere and differ only in actual
 * presence, so a variant that does NOT declare the pack still resolves the
 * command as "not found" (exit 127) rather than having it hidden from PATH —
 * which is exactly what keeps gate 6's foreign-check meaningful (a foreign
 * leak is caught because the binary is genuinely absent, never because PATH
 * hides it). Do not scope this to only the declaring variants.
 */
const PACK_SETUP_SKELETON_DIRS: readonly string[] = ['.local/bin']

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

const mapFs = (e: FsError, variant: string, runIndex: number): PhaseError =>
  setupFail(`HOME setup failed: ${e.operation} ${e.path}`, { variant, runIndex, path: e.path })

const range = (n: number): readonly number[] =>
  Array.from({ length: n }, (_, i) => i)

const buildSkeleton = (
  homeDir: string,
  variant: string,
  runIndex: number,
  packSetupDeclared: boolean,
): Effect.Effect<readonly string[], PhaseError> =>
  Effect.gen(function* () {
    const dirs = packSetupDeclared ? [...SKELETON_DIRS, ...PACK_SETUP_SKELETON_DIRS] : SKELETON_DIRS
    yield* Effect.forEach(
      dirs,
      (rel) =>
        ensureDir(path.join(homeDir, rel)).pipe(Effect.mapError((e) => mapFs(e, variant, runIndex))),
      { concurrency: 1 },
    )
    yield* writeFile(
      path.join(homeDir, '.config/opencode/agents/build.md'),
      BUILD_AGENT_TEMPLATE,
    ).pipe(Effect.mapError((e) => mapFs(e, variant, runIndex)))
    return [...dirs]
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

/**
 * opencode's config `plugin` array accepts a local file spec as a plain
 * absolute path (also `file://…` or a `.`-relative path, but absolute needs
 * no resolution and works regardless of the process's cwd) — verified in the
 * opencode binary's plugin-spec resolver, which recognizes any entry that
 * `path.isAbsolute()`s, starts with `file://`, or starts with `.`. This is a
 * different path from `opencode plugin <module>`, which only ever installs
 * an npm package and never accepts a local file.
 */
const addLocalPlugin = (
  existing: Record<string, unknown>,
  absPath: string,
): Record<string, unknown> => {
  const prev = isStringArray(existing['plugin']) ? existing['plugin'] : []
  return prev.includes(absPath) ? existing : { ...existing, plugin: [...prev, absPath] }
}

/**
 * The path opencode.json's `plugin` array must reference at RUNTIME, not the
 * path our own process just wrote the file to. Under `--isolation docker`
 * opencode reads that config from inside the container, where `homeDir` is
 * mounted at `/home/opencode` — the host-absolute `dstFile` does not exist
 * there, so a plugin registered with it silently fails to load (same bug
 * class as the skill symlink, one layer down: the FILE is copied correctly,
 * only the recorded PATH is wrong). Home isolation runs the process directly
 * on the host, where `dstFile` already is the real path.
 */
const pluginConfigPath = (
  dstFile: string,
  homeDir: string,
  docker: DockerExec | undefined,
): string => {
  if (docker === undefined) return dstFile
  const rel = path.relative(homeDir, dstFile).split(path.sep).join('/')
  return path.posix.join('/home/opencode', rel)
}

const applyInstruction = (
  inst: RegistrationInstruction,
  homeDir: string,
  installSeconds: number,
  docker: DockerExec | undefined,
): Effect.Effect<void, PhaseError> => {
  switch (inst.kind) {
    case 'skill':
      return Effect.gen(function* () {
        const skillsDir = path.join(homeDir, '.config/opencode/skills')
        const destDir = path.join(skillsDir, inst.name)
        if (!isPathWithin(skillsDir, destDir)) {
          yield* Effect.fail(
            setupFail(`skill dest escapes skills dir: ${destDir}`, {
              name: inst.name,
              path: destDir,
            }),
          )
        }
        yield* removeDir(destDir).pipe(Effect.catchAll(() => Effect.void))
        // A symlink to `inst.target` (the shared pack cache under
        // workspace.pack/) would dangle under `--isolation docker`: only the
        // run HOME and the app cwd are bind-mounted into the container, so a
        // path outside both is invisible there even though it resolves fine
        // on the host. Copying the skill into the HOME tree — the same thing
        // the `file`/`plugin` instruction kinds already do — makes it
        // genuinely present inside the mount for both isolation modes.
        yield* copyDir(inst.target, destDir).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot copy skill into HOME: ${e.path}`, {
              source: inst.target,
              dest: destDir,
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
    case 'plugin': {
      const target = inst.target
      if (target === undefined) {
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
      }
      // Local plugin file: never an npm fetch. Delivered as a file and
      // registered with a local spec in the plugin's own config array —
      // `opencode plugin <module>` has no path that accepts a local file.
      return Effect.gen(function* () {
        const pluginsDir = path.join(homeDir, '.config/opencode/plugins')
        yield* ensureDir(pluginsDir).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot create plugins dir: ${e.path}`, { path: e.path }),
          ),
        )
        const dstFile = path.join(pluginsDir, path.basename(target))
        yield* copyFile(target, dstFile).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot place plugin file: ${e.path}`, {
              source: target,
              path: e.path,
            }),
          ),
        )
        const cfgPath = path.join(homeDir, '.config/opencode/opencode.json')
        const existing = yield* readOpendcodeConfig(cfgPath)
        const merged = addLocalPlugin(existing, pluginConfigPath(dstFile, homeDir, docker))
        yield* writeFile(cfgPath, `${JSON.stringify(merged, null, 2)}\n`).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot write opencode.json: ${e.path}`, { path: e.path }),
          ),
        )
      })
    }
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

/** Connectivity/model-selection fields copied as-is (no CLI override) into every variant's config. */
export interface ConnectivityExtras {
  readonly provider: Record<string, unknown> | undefined
  readonly smallModel: string | undefined
  readonly enabledProviders: readonly string[] | undefined
  readonly disabledProviders: readonly string[] | undefined
}

const buildConfigObject = (
  hasDeclaredPacks: boolean,
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
  if (hasDeclaredPacks && Object.keys(mcpServers).length > 0) {
    return { ...base, mcp: { ...mcpServers } }
  }
  return base
}

/**
 * Purity (D1): `pure ?? declaredPacks.length === 0` — an explicit
 * `variant.pure` always wins; absent, a variant with no declared pack
 * defaults pure (reproduces today's hardwired baseline behavior), a variant
 * with a declared pack defaults impure.
 */
const buildEnvVars = (
  homeDir: string,
  pure: boolean,
  configContent: string,
  pathValue: string | undefined,
): EnvVarSet => ({
  HOME: homeDir,
  OPENCODE_DISABLE_PROJECT_CONFIG: true,
  OPENCODE_DISABLE_DEFAULT_PLUGINS: pure,
  OPENCODE_DISABLE_EXTERNAL_SKILLS: pure,
  OPENCODE_PURE: pure,
  OPENCODE_CONFIG_CONTENT: configContent,
  ...(pathValue === undefined ? {} : { PATH: pathValue }),
})

/**
 * `--pack-setup` PATH, identical shape on every variant (see
 * `PACK_SETUP_SKELETON_DIRS` above: only its content differs). Docker mode
 * uses the in-CONTAINER home path (`/home/opencode/...`) — the host
 * `homeDir` value would resolve to nothing once the process is actually
 * inside the container (the exact class of bug already fixed once for
 * local-plugin registration, see `pluginConfigPath` above). Home mode runs
 * directly on the host, so the real host path is correct there.
 */
const setupPathFor = (
  homeDir: string,
  isolation: IsolationMode,
  imagePath: string,
): string =>
  isolation === 'docker'
    ? `/home/opencode/.local/bin:${imagePath}`
    : `${path.join(homeDir, '.local/bin')}:${process.env['PATH'] ?? ''}`

interface VariantResult {
  readonly name: string
  readonly trees: readonly HomeTree[]
  readonly envs: readonly EnvVarSet[]
  readonly config: string
}

export const homeIsolation = (
  input: HomeIsolationInputExt,
): Effect.Effect<HomeIsolationResultExt, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const isolation = runInput.isolation
    const dockerImage =
      isolation === 'docker' ? (input.dockerImage ?? DEFAULT_OPENCODE_IMAGE) : undefined
    const dockerNetwork = isolation === 'docker' ? runInput.dockerNetwork : undefined
    const docker: DockerExec | undefined =
      dockerImage === undefined
        ? undefined
        : { image: dockerImage, ...(dockerNetwork === undefined ? {} : { network: dockerNetwork }) }
    const runs = runInput.runs
    const sourceHome = os.homedir()
    const authFlags = runInput.auth
    const installSeconds = runInput.timeouts.installSeconds
    // PATH symmetry decision (05-risks.md §2.6, NORMATIVE): a registry-wide
    // check, not per-variant — every variant gets the PATH entry as soon as
    // ANY pack in the registry declares setup, regardless of which variant(s)
    // actually declare that pack.
    const anyPackDeclaresSetup = runInput.packs.some((p) => p.setup !== undefined)
    const imagePath: string =
      anyPackDeclaresSetup && isolation === 'docker' && dockerImage !== undefined
        ? yield* probeImagePath(dockerImage, dockerNetwork).pipe(
            Effect.mapError((e: DockerError) =>
              homeIsolationError(`cannot probe image PATH for --pack-setup: ${e.stderr}`, 'E_DOCKER_FAILED', {
                image: dockerImage,
                stderr: e.stderr,
              }),
            ),
          )
        : ''
    const packOutcome = input.packInstall
    const sourceConnectivity = yield* readSourceConnectivity(sourceHome)
    const connectivityExtras: ConnectivityExtras = {
      provider: sourceConnectivity.provider,
      smallModel: sourceConnectivity.smallModel,
      enabledProviders: sourceConnectivity.enabledProviders,
      disabledProviders: sourceConnectivity.disabledProviders,
    }

    const configDir = workspace.config
    yield* ensureDir(configDir).pipe(
      Effect.mapError((e: FsError) => setupFail(`cannot create config dir: ${e.path}`, { path: e.path })),
    )

    const processVariant = (v: VariantSpec): Effect.Effect<VariantResult, PhaseError> =>
      Effect.gen(function* () {
        const declaredPacks = packsOf(runInput, v)
        // Apply EVERY declared pack's instructions/mcp — Stage 1 caps
        // declaredPacks at length <=1 (enforced in phase 00), but this loop
        // is written set-based from the start so Stage 2 (WP16) only has to
        // drop that guard and add the instruction-collision check; it must
        // never silently apply just the first pack.
        const deliveries = yield* Effect.forEach(
          declaredPacks,
          (pack) =>
            Effect.gen(function* () {
              const delivery = packOutcome?.deliveries.find((d) => d.pack === pack.name)
              // packOutcome undefined means phase 03 never ran at all (test
              // harnesses, or a run with an empty registry) — that is not a
              // mismatch. packOutcome defined but missing THIS declared
              // pack's delivery is a real bug: the variant would otherwise
              // end up impure with an empty HOME and no error.
              if (delivery === undefined && packOutcome !== undefined) {
                yield* Effect.fail(
                  homeIsolationError(
                    `declared pack has no delivery from phase 03: variant=${v.name} pack=${pack.name}`,
                    'E_PACK_INSTALL_FAILED',
                    { variant: v.name, pack: pack.name },
                  ),
                )
              }
              return delivery
            }),
          { concurrency: 1 },
        )
        const instructions: readonly RegistrationInstruction[] = deliveries.flatMap((d) =>
          d === undefined ? [] : [...d.instructions],
        )
        const mcpServers = deliveries.reduce<Record<string, unknown>>(
          (acc, d) => ({ ...acc, ...collectMcpServers(d?.instructions) }),
          {},
        )
        const pure = v.pure ?? declaredPacks.length === 0
        // An explicit variant.model of '' must disable the inherited global
        // (D7) and fall through to source connectivity — correct regardless
        // of whether effectiveOf itself already returns undefined for '' or
        // leaks the empty string back.
        const ownModel = effectiveOf(v, runInput.model, 'model')
        const model = ownModel === undefined || ownModel === '' ? sourceConnectivity.model : ownModel
        const configObj = buildConfigObject(declaredPacks.length > 0, mcpServers, model, connectivityExtras)
        const configStr = JSON.stringify(configObj, null, 2)

        // `configObj` itself stays unredacted — it feeds `configStr`, which
        // becomes OPENCODE_CONFIG_CONTENT and must carry real credentials for
        // the run to authenticate. Only this disk copy, written for a human
        // to read, is redacted.
        yield* writeJson(path.join(configDir, `${v.name}.json`), redactConfigSecrets(configObj)).pipe(
          Effect.mapError((e: FsError) =>
            setupFail(`cannot write ${v.name}.json: ${e.path}`, { path: e.path, variant: v.name }),
          ),
        )

        const vt = workspace.variantTrees.find((t) => t.name === v.name)

        const perRun = yield* Effect.forEach(
          range(runs),
          (idx) =>
            Effect.gen(function* () {
              const runIndex = idx + 1
              const homeDir = vt?.homes[idx] ?? ''
              if (homeDir === '') {
                yield* Effect.fail(
                  setupFail(`missing HOME path for variant=${v.name} run=${String(runIndex)}`, {
                    variant: v.name,
                    runIndex,
                  }),
                )
              }
              const structure = yield* buildSkeleton(homeDir, v.name, runIndex, anyPackDeclaresSetup)
              const copiedAuth = yield* copyAuth(homeDir, sourceHome, authFlags)
              if (copiedAuth.length === 0) {
                yield* Effect.fail(
                  homeIsolationError(
                    `no auth sources found for variant=${v.name} run=${String(runIndex)}`,
                    'E_AUTH_MISSING',
                    { variant: v.name, runIndex, sourceHome },
                  ),
                )
              }
              if (instructions.length > 0) {
                yield* Effect.forEach(
                  instructions,
                  (inst) => applyInstruction(inst, homeDir, installSeconds, docker),
                  { concurrency: 1 },
                )
              }
              const tree: HomeTree = {
                basePath: homeDir,
                structure: [...structure],
                copiedAuth: [...copiedAuth],
              }
              const pathValue = anyPackDeclaresSetup ? setupPathFor(homeDir, isolation, imagePath) : undefined
              return { tree, env: buildEnvVars(homeDir, pure, configStr, pathValue) }
            }),
          { concurrency: 1 },
        )

        return {
          name: v.name,
          trees: perRun.map((p) => p.tree),
          envs: perRun.map((p) => p.env),
          config: configStr,
        }
      })

    const variantResults = yield* Effect.forEach(runInput.variants, processVariant, { concurrency: 1 })

    const homeTrees: readonly VariantHomes[] = variantResults.map((r) => ({ name: r.name, trees: [...r.trees] }))
    const envVars: readonly VariantEnv[] = variantResults.map((r) => ({ name: r.name, envs: [...r.envs] }))
    const generatedConfigs: readonly VariantConfig[] = variantResults.map((r) => ({ name: r.name, config: r.config }))

    return {
      homeTrees: [...homeTrees],
      envVars: [...envVars],
      generatedConfigs: [...generatedConfigs],
      isolation,
      ...(dockerImage === undefined ? {} : { dockerImage }),
    }
  })
