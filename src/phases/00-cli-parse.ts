/**
 * Phase 00: cli-parse
 *
 * @see docs/phases/00-cli-parse.ru.md
 * @see contract/phases/00-cli-parse.tsp
 */
import { Effect } from 'effect'
import path from 'node:path'
import { z } from 'zod'
import type {
  AuthWhitelist,
  CliParseInput,
  CliParseResult,
  InitSide,
  IsolationMode,
  LogLevel,
  OutputFormat,
  PackType,
  RunInput,
  TimeoutConfig,
  TimelineMode,
} from '@generated/types'
import {
  authWhitelistSchema,
  initSideSchema,
  isolationModeSchema,
  logLevelSchema,
  outputFormatSchema,
  packTypeSchema,
  runInputSchema,
  timeoutConfigSchema,
  timelineModeSchema,
} from '@generated/schemas'
import { detectPack, safeRefDisplay } from '../pack/detector.js'
import type { PackDetectError } from '../pack/detector.js'
import { cliParseError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { exists, readFile } from '../util/fs.js'
import { isDockerAvailable } from '../util/docker.js'

export type CliParseOutput = CliParseResult & {
  readonly flagDefaults: Readonly<Record<string, unknown>>
  readonly dockerImage?: string
  readonly outputPathProvided: boolean
}

// Defaults applied when neither the CLI nor the config file set a value.
// Named (not inlined at each `?? ...`) so the `run --help` flag table can
// read the exact value the parser uses instead of a copy that could drift.
export const DEFAULT_RUNS = 3
export const DEFAULT_FORMATS: readonly OutputFormat[] = ['md']
const ALL_FORMATS: readonly OutputFormat[] = ['md', 'html', 'json', 'yaml']
export const DEFAULT_TIMEOUTS: TimeoutConfig = {
  preflightSeconds: 60,
  runSeconds: 600,
  verifySeconds: 300,
  installSeconds: 300,
  watchdogSeconds: 90,
}
export const DEFAULT_AUTH: AuthWhitelist = {
  opencode: true,
  npmrc: true,
  anthropic: false,
  openai: false,
  gemini: false,
  aws: false,
  ssh: false,
  git: false,
}
export const DEFAULT_ISOLATION: IsolationMode = 'home'
export const DEFAULT_PURE_BASELINE = true
export const DEFAULT_PREFLIGHT_ENABLED = true
export const DEFAULT_DIFF_HTML = false
export const DEFAULT_PROTECT_GIT = false
export const DEFAULT_COLLAPSE_REPEATS = false
export const DEFAULT_TIMELINE_MODE: TimelineMode = 'side-by-side'
export const DEFAULT_INIT_SIDE: InitSide = 'both'
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'
export const DEFAULT_OUTPUT_PATH = './results'
export const DEFAULT_WORKSPACE_PATH = './.testaipack'

type TimeoutUpdate = { readonly [K in keyof TimeoutConfig]?: number | undefined }
type AuthUpdate = { readonly [K in keyof AuthWhitelist]?: boolean | undefined }

const timeoutPartialSchema = timeoutConfigSchema.partial()
const authPartialSchema = authWhitelistSchema.partial()

const configFileSchema = z
  .object({
    repoUrl: z.string().optional(),
    packRef: z.string().optional(),
    packType: packTypeSchema.optional(),
    prompt: z.string().optional(),
    promptFiles: z.array(z.string()).optional(),
    init: z.string().optional(),
    initFiles: z.array(z.string()).optional(),
    initSide: initSideSchema.optional(),
    verify: z.string().optional(),
    judge: z.string().optional(),
    judgeFiles: z.array(z.string()).optional(),
    runs: z.number().int().optional(),
    isolation: isolationModeSchema.optional(),
    dockerImage: z.string().optional(),
    dockerNetwork: z.string().optional(),
    opencodeVersion: z.string().optional(),
    pureBaseline: z.boolean().optional(),
    preflightEnabled: z.boolean().optional(),
    preflightModel: z.string().optional(),
    model: z.string().optional(),
    formats: z.union([z.array(outputFormatSchema), z.literal('all')]).optional(),
    outputPath: z.string().optional(),
    diffHtml: z.boolean().optional(),
    protectGit: z.boolean().optional(),
    collapseRepeats: z.boolean().optional(),
    timelineMode: timelineModeSchema.optional(),
    timeouts: timeoutPartialSchema.optional(),
    workspacePath: z.string().optional(),
    logLevel: logLevelSchema.optional(),
    pricingPath: z.string().optional(),
    auth: authPartialSchema.optional(),
  })
  .strict()

type ConfigFile = z.infer<typeof configFileSchema>

interface CliRaw {
  readonly repoUrl?: string
  readonly prompts: readonly string[]
  readonly inits: readonly string[]
  readonly initSide?: InitSide
  readonly verifies: readonly string[]
  readonly judges: readonly string[]
  readonly runs?: number
  readonly isolation?: IsolationMode
  readonly dockerImage?: string
  readonly dockerNetwork?: string
  readonly packRef?: string
  readonly packType?: PackType
  readonly formats: readonly (OutputFormat | 'all')[]
  readonly pureBaseline?: boolean
  readonly preflightEnabled?: boolean
  readonly diffHtml?: boolean
  readonly protectGit?: boolean
  readonly collapseRepeats?: boolean
  readonly timelineMode?: TimelineMode
  readonly logLevel?: LogLevel
  readonly outputPath?: string
  readonly workspacePath?: string
  readonly opencodeVersion?: string
  readonly preflightModel?: string
  readonly model?: string
  readonly pricingPath?: string
  readonly timeouts: TimeoutUpdate
  readonly auth: AuthUpdate
}

const EMPTY_CLI: CliRaw = {
  prompts: [],
  inits: [],
  verifies: [],
  judges: [],
  formats: [],
  timeouts: {},
  auth: {},
}

// Exported so `run --help` can list every flag straight from this table —
// see cli/index.ts's help builder.
export const VALUE_FLAGS: Readonly<Record<string, string>> = {
  '--prompt': 'prompts',
  '-p': 'prompts',
  '--init': 'inits',
  '--init-side': 'initSide',
  '--verify': 'verifies',
  '--judge': 'judges',
  '--format': 'formats',
  '-f': 'formats',
  '--auth': 'auth',
  '--runs': 'runs',
  '-n': 'runs',
  '--isolation': 'isolation',
  '--docker-image': 'dockerImage',
  '--docker-network': 'dockerNetwork',
  '--pack': 'packRef',
  '--pack-type': 'packType',
  '--timeline-mode': 'timelineMode',
  '--log-level': 'logLevel',
  '--output': 'outputPath',
  '-o': 'outputPath',
  '--workspace': 'workspacePath',
  '-w': 'workspacePath',
  '--opencode-version': 'opencodeVersion',
  '--preflight-model': 'preflightModel',
  '--model': 'model',
  '--pricing-path': 'pricingPath',
  '--timeout-preflight': 'preflightSeconds',
  '--timeout-run': 'runSeconds',
  '--timeout-verify': 'verifySeconds',
  '--timeout-install': 'installSeconds',
  '--watchdog': 'watchdogSeconds',
  '--timeout-total': 'totalSeconds',
}

export type RunBooleanKey = 'pureBaseline' | 'preflightEnabled' | 'diffHtml' | 'protectGit' | 'collapseRepeats'

export const BOOLEAN_FLAGS: Readonly<
  Record<string, { readonly key: RunBooleanKey; readonly value: boolean }>
> = {
  '--pure-baseline': { key: 'pureBaseline', value: true },
  '--no-pure-baseline': { key: 'pureBaseline', value: false },
  '--preflight': { key: 'preflightEnabled', value: true },
  '--no-preflight': { key: 'preflightEnabled', value: false },
  '--diff-html': { key: 'diffHtml', value: true },
  '--no-diff-html': { key: 'diffHtml', value: false },
  '--protect-git': { key: 'protectGit', value: true },
  '--no-protect-git': { key: 'protectGit', value: false },
  '--collapse-repeats': { key: 'collapseRepeats', value: true },
  '--no-collapse-repeats': { key: 'collapseRepeats', value: false },
}

export const TIMEOUT_KEYS: ReadonlySet<string> = new Set([
  'preflightSeconds',
  'runSeconds',
  'verifySeconds',
  'installSeconds',
  'watchdogSeconds',
  'totalSeconds',
])

export const AUTH_KEYS: ReadonlySet<keyof AuthWhitelist> = new Set([
  'opencode', 'npmrc', 'anthropic', 'openai', 'gemini', 'aws', 'ssh', 'git',
])

export const NO_AUTH_PREFIX = '--no-auth-'

const parseIntStrict = (s: string): number | undefined => {
  if (!/^\s*-?\d+\s*$/.test(s)) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

const parseEnum = <T>(
  value: string,
  schema: z.ZodType<T>,
  label: string,
): Effect.Effect<T, PhaseError> =>
  Effect.gen(function* () {
    const r = schema.safeParse(value)
    if (!r.success) {
      return yield* Effect.fail(
        cliParseError(`invalid ${label}: ${value}`, 'E_CONFIG_INVALID', { label, value }),
      )
    }
    return r.data
  })

// Three accepted shapes: `provider/model`, `provider/model:tag` (ollama's own
// naming convention, e.g. `ollama/qwen3.5:9b`), and `provider:model`. A tag is
// only valid after a `/`-separated model — `provider:model:tag` is not a
// recognized shape, so it still errors.
const MODEL_REF_PATTERN =
  /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(:[a-zA-Z0-9._-]+)?$|^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/

const isValidModelRef = (m: string): boolean => MODEL_REF_PATTERN.test(m)

const setScalar = <K extends keyof CliRaw>(acc: CliRaw, key: K, value: CliRaw[K]): CliRaw => ({
  ...acc,
  [key]: value,
})

const parseValueFlag = (
  acc: CliRaw,
  dest: string,
  raw: string,
): Effect.Effect<CliRaw, PhaseError> =>
  Effect.gen(function* () {
    if (dest === 'prompts') return { ...acc, prompts: [...acc.prompts, raw] }
    if (dest === 'inits') return { ...acc, inits: [...acc.inits, raw] }
    if (dest === 'verifies') return { ...acc, verifies: [...acc.verifies, raw] }
    if (dest === 'judges') return { ...acc, judges: [...acc.judges, raw] }
    if (dest === 'auth') return yield* setAuth(acc, raw)
    if (TIMEOUT_KEYS.has(dest)) {
      const n = parseIntStrict(raw)
      if (n === undefined) {
        return yield* Effect.fail(
          cliParseError(`invalid timeout value: ${raw}`, 'E_CONFIG_INVALID', { key: dest, value: raw }),
        )
      }
      return { ...acc, timeouts: { ...acc.timeouts, [dest]: n } }
    }
    if (dest === 'runs') {
      const n = parseIntStrict(raw)
      if (n === undefined) {
        return yield* Effect.fail(
          cliParseError(`invalid --runs value: ${raw}`, 'E_CONFIG_INVALID', { value: raw }),
        )
      }
      return setScalar(acc, 'runs', n)
    }
    if (dest === 'isolation') {
      const v = yield* parseEnum(raw, isolationModeSchema, '--isolation')
      return setScalar(acc, 'isolation', v)
    }
    if (dest === 'packType') {
      const v = yield* parseEnum(raw, packTypeSchema, '--pack-type')
      return setScalar(acc, 'packType', v)
    }
    if (dest === 'timelineMode') {
      const v = yield* parseEnum(raw, timelineModeSchema, '--timeline-mode')
      return setScalar(acc, 'timelineMode', v)
    }
    if (dest === 'initSide') {
      const v = yield* parseEnum(raw, initSideSchema, '--init-side')
      return setScalar(acc, 'initSide', v)
    }
    if (dest === 'logLevel') {
      const v = yield* parseEnum(raw, logLevelSchema, '--log-level')
      return setScalar(acc, 'logLevel', v)
    }
    if (dest === 'formats') {
      if (raw === 'all') return { ...acc, formats: [...acc.formats, 'all'] }
      const v = yield* parseEnum(raw, outputFormatSchema, '--format')
      return { ...acc, formats: [...acc.formats, v] }
    }
    if (dest === 'packRef') return setScalar(acc, 'packRef', raw)
    if (dest === 'dockerImage') return setScalar(acc, 'dockerImage', raw)
    if (dest === 'dockerNetwork') return setScalar(acc, 'dockerNetwork', raw)
    if (dest === 'outputPath') return setScalar(acc, 'outputPath', raw)
    if (dest === 'workspacePath') return setScalar(acc, 'workspacePath', raw)
    if (dest === 'opencodeVersion') return setScalar(acc, 'opencodeVersion', raw)
    if (dest === 'preflightModel') return setScalar(acc, 'preflightModel', raw)
    if (dest === 'model') return setScalar(acc, 'model', raw)
    if (dest === 'pricingPath') return setScalar(acc, 'pricingPath', raw)
    return yield* Effect.fail(
      cliParseError(`unknown flag destination: ${dest}`, 'E_CONFIG_INVALID', { dest }),
    )
  })

const setAuth = (acc: CliRaw, kind: string): Effect.Effect<CliRaw, PhaseError> => {
  const k = kind as keyof AuthWhitelist
  if (!AUTH_KEYS.has(k)) {
    return Effect.fail(
      cliParseError(`unknown auth kind: ${kind}`, 'E_CONFIG_INVALID', { flag: '--auth', value: kind }),
    )
  }
  return Effect.succeed({ ...acc, auth: { ...acc.auth, [k]: true } })
}

const isKnownFlagToken = (tok: string): boolean => {
  const eq = tok.indexOf('=')
  const bare = eq >= 0 ? tok.slice(0, eq) : tok
  return VALUE_FLAGS[bare] !== undefined || BOOLEAN_FLAGS[bare] !== undefined || bare.startsWith(NO_AUTH_PREFIX)
}

const parseArgs = (args: readonly string[]): Effect.Effect<CliRaw, PhaseError> => {
  const loop = (i: number, acc: CliRaw): Effect.Effect<CliRaw, PhaseError> =>
    Effect.gen(function* () {
      if (i >= args.length) return acc
      const tok = args[i] ?? ''
      if (tok === '') return yield* loop(i + 1, acc)

      if (tok.startsWith('--') || tok.startsWith('-')) {
        if (tok.startsWith(NO_AUTH_PREFIX)) {
          const kind = tok.slice(NO_AUTH_PREFIX.length)
          const k = kind as keyof AuthWhitelist
          if (!AUTH_KEYS.has(k)) {
            return yield* Effect.fail(
              cliParseError(`unknown auth kind: ${kind}`, 'E_CONFIG_INVALID', { flag: tok }),
            )
          }
          return yield* loop(i + 1, { ...acc, auth: { ...acc.auth, [k]: false } })
        }
        const eq = tok.indexOf('=')
        if (eq >= 0) {
          const flag = tok.slice(0, eq)
          const inline = tok.slice(eq + 1)
          const dest = VALUE_FLAGS[flag]
          if (dest === undefined) {
            return yield* Effect.fail(
              cliParseError(`unknown flag: ${flag}`, 'E_CONFIG_INVALID', { flag }),
            )
          }
          const next = yield* parseValueFlag(acc, dest, inline)
          return yield* loop(i + 1, next)
        }
        const dest = VALUE_FLAGS[tok]
        if (dest !== undefined) {
          const rawNext = args[i + 1]
          if (rawNext === undefined || rawNext === '' || isKnownFlagToken(rawNext)) {
            return yield* Effect.fail(
              cliParseError(`flag ${tok} requires a value`, 'E_CONFIG_INVALID', { flag: tok }),
            )
          }
          const next = yield* parseValueFlag(acc, dest, rawNext)
          return yield* loop(i + 2, next)
        }
        const b = BOOLEAN_FLAGS[tok]
        if (b !== undefined) {
          return yield* loop(i + 1, setScalar(acc, b.key, b.value))
        }
        return yield* Effect.fail(
          cliParseError(`unknown flag: ${tok}`, 'E_CONFIG_INVALID', { flag: tok }),
        )
      }

      if (acc.repoUrl === undefined) {
        return yield* loop(i + 1, setScalar(acc, 'repoUrl', tok))
      }
      return yield* Effect.fail(
        cliParseError(`unexpected positional argument: ${tok}`, 'E_CONFIG_INVALID', { value: tok }),
      )
    })
  return loop(0, EMPTY_CLI)
}

const readConfigFile = (
  input: CliParseInput,
): Effect.Effect<ConfigFile | undefined, PhaseError> =>
  Effect.gen(function* () {
    const file = input.configFile ?? path.join(input.cwd, '.testaipack', 'config.json')
    const has = yield* exists(file)
    if (!has) return undefined
    const raw = yield* readFile(file).pipe(
      Effect.mapError((e) =>
        cliParseError(`cannot read config file: ${file}`, 'E_CONFIG_INVALID', {
          file,
          reason: 'unreadable',
          cause: String(e),
        }),
      ),
    )
    const json = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (e) =>
        cliParseError(`config file is not valid JSON: ${file}`, 'E_CONFIG_INVALID', {
          file,
          reason: 'invalid-json',
          cause: String(e),
        }),
    })
    const parsed = configFileSchema.safeParse(json)
    if (!parsed.success) {
      return yield* Effect.fail(
        cliParseError(`config file violates schema: ${file}`, 'E_CONFIG_INVALID', {
          file,
          reason: 'schema-mismatch',
          issues: parsed.error.issues,
        }),
      )
    }
    return parsed.data
  })

interface ResolvedText {
  readonly text: string
  readonly files: readonly string[]
}

const resolveTextSpecs = (
  specs: readonly string[],
  baseDir: string,
  label: string,
): Effect.Effect<ResolvedText, PhaseError> =>
  Effect.gen(function* () {
    const parts = yield* Effect.forEach(specs, (spec) =>
      Effect.gen(function* () {
        if (!spec.startsWith('@')) {
          return { text: spec, file: undefined as string | undefined }
        }
        const rel = spec.slice(1)
        const resolved = path.resolve(baseDir, rel)
        const has = yield* exists(resolved)
        if (!has) {
          return yield* Effect.fail(
            cliParseError(`${label} file not found: ${rel}`, 'E_CONFIG_INVALID', {
              label,
              path: rel,
              reason: 'file-not-found',
            }),
          )
        }
        const content = yield* readFile(resolved).pipe(
          Effect.mapError((e) =>
            cliParseError(`${label} file unreadable: ${rel}`, 'E_CONFIG_INVALID', {
              label,
              path: rel,
              cause: String(e),
            }),
          ),
        )
        return { text: content, file: resolved }
      }),
    )
    const texts = parts.map((p) => p.text)
    const files = parts.flatMap((p) => (p.file === undefined ? [] : [p.file]))
    return { text: texts.join('\n\n'), files }
  })

const pick = <T>(
  cliV: T | undefined,
  cfgV: T | undefined,
): { readonly value: T | undefined; readonly src: 'cli' | 'config' | 'default' } =>
  cliV !== undefined
    ? { value: cliV, src: 'cli' }
    : cfgV !== undefined
      ? { value: cfgV, src: 'config' }
      : { value: undefined, src: 'default' }

const normalizeConfigFormats = (
  f: ConfigFile['formats'],
): readonly (OutputFormat | 'all')[] | undefined => {
  if (f === undefined) return undefined
  if (f === 'all') return ['all']
  return f
}

const resolveFormats = (
  cliFormats: readonly (OutputFormat | 'all')[],
  cfgFormats: readonly (OutputFormat | 'all')[] | undefined,
): readonly OutputFormat[] => {
  const combined = [...cliFormats, ...(cfgFormats ?? [])]
  if (combined.includes('all')) return ALL_FORMATS
  const deduped = combined.filter(
    (f, i): f is OutputFormat => f !== 'all' && combined.indexOf(f) === i,
  )
  return deduped.length === 0 ? DEFAULT_FORMATS : deduped
}

const mergeTimeouts = (cliT: TimeoutUpdate, cfgT: TimeoutUpdate | undefined): TimeoutConfig => ({
  preflightSeconds: cliT.preflightSeconds ?? cfgT?.preflightSeconds ?? DEFAULT_TIMEOUTS.preflightSeconds,
  runSeconds: cliT.runSeconds ?? cfgT?.runSeconds ?? DEFAULT_TIMEOUTS.runSeconds,
  verifySeconds: cliT.verifySeconds ?? cfgT?.verifySeconds ?? DEFAULT_TIMEOUTS.verifySeconds,
  installSeconds: cliT.installSeconds ?? cfgT?.installSeconds ?? DEFAULT_TIMEOUTS.installSeconds,
  watchdogSeconds: cliT.watchdogSeconds ?? cfgT?.watchdogSeconds ?? DEFAULT_TIMEOUTS.watchdogSeconds,
  ...(cliT.totalSeconds !== undefined
    ? { totalSeconds: cliT.totalSeconds }
    : cfgT?.totalSeconds !== undefined
      ? { totalSeconds: cfgT.totalSeconds }
      : {}),
})

interface BadTimeout {
  readonly key: string
  readonly value: number
}

const firstNonPositiveTimeout = (timeouts: TimeoutConfig): BadTimeout | undefined => {
  const entries = Object.entries(timeouts) as readonly (readonly [string, number])[]
  const bad = entries.find(([, value]) => value <= 0)
  return bad === undefined ? undefined : { key: bad[0], value: bad[1] }
}

const mergeAuth = (cliA: AuthUpdate, cfgA: AuthUpdate | undefined): AuthWhitelist => ({
  opencode: cliA.opencode ?? cfgA?.opencode ?? DEFAULT_AUTH.opencode,
  npmrc: cliA.npmrc ?? cfgA?.npmrc ?? DEFAULT_AUTH.npmrc,
  anthropic: cliA.anthropic ?? cfgA?.anthropic ?? DEFAULT_AUTH.anthropic,
  openai: cliA.openai ?? cfgA?.openai ?? DEFAULT_AUTH.openai,
  gemini: cliA.gemini ?? cfgA?.gemini ?? DEFAULT_AUTH.gemini,
  aws: cliA.aws ?? cfgA?.aws ?? DEFAULT_AUTH.aws,
  ssh: cliA.ssh ?? cfgA?.ssh ?? DEFAULT_AUTH.ssh,
  git: cliA.git ?? cfgA?.git ?? DEFAULT_AUTH.git,
})

interface IsolationResult {
  readonly isolation: IsolationMode
  readonly dockerDowngraded: boolean
}

const resolveIsolation = (requested: IsolationMode): Effect.Effect<IsolationResult, PhaseError> =>
  Effect.gen(function* () {
    if (requested !== 'docker') {
      return { isolation: requested, dockerDowngraded: false }
    }
    const up = yield* isDockerAvailable()
    return up
      ? { isolation: requested, dockerDowngraded: false }
      : { isolation: 'home', dockerDowngraded: true }
  })

export const cliParse = (input: CliParseInput): Effect.Effect<CliParseOutput, PhaseError> =>
  Effect.gen(function* () {
    const head = input.argv[0]
    const rest = head === 'run' ? input.argv.slice(1) : input.argv.slice()
    const cli = yield* parseArgs(rest)
    const cfg = yield* readConfigFile(input)

    const repoUrlPick = pick(cli.repoUrl, cfg?.repoUrl)
    if (repoUrlPick.value === undefined) {
      return yield* Effect.fail(
        cliParseError('repoUrl is required (positional or config)', 'E_CONFIG_INVALID', {
          reason: 'repoUrl-required',
        }),
      )
    }

    const cliPromptSpecs = cli.prompts
    const cfgPromptSpecs: readonly string[] = [
      ...(cfg?.promptFiles ?? []),
      ...(cfg?.prompt !== undefined ? [cfg.prompt] : []),
    ]
    const promptSpecs = cliPromptSpecs.length > 0 ? cliPromptSpecs : cfgPromptSpecs
    const promptSrc: 'cli' | 'config' | 'default' =
      cliPromptSpecs.length > 0 ? 'cli' : cfgPromptSpecs.length > 0 ? 'config' : 'default'
    if (promptSpecs.length === 0) {
      return yield* Effect.fail(
        cliParseError('--prompt is required for the run subcommand', 'E_CONFIG_INVALID', {
          reason: 'prompt-required',
        }),
      )
    }
    const promptResolved = yield* resolveTextSpecs([...promptSpecs], input.cwd, 'prompt')

    const initSpecs: readonly string[] =
      cli.inits.length > 0 ? cli.inits : cfg?.init !== undefined ? [cfg.init] : []
    const initResolved: ResolvedText | undefined =
      initSpecs.length > 0 ? yield* resolveTextSpecs([...initSpecs], input.cwd, 'init') : undefined

    const initSidePick = pick(cli.initSide, cfg?.initSide)

    const verifySpecs: readonly string[] =
      cli.verifies.length > 0 ? cli.verifies : cfg?.verify !== undefined ? [cfg.verify] : []
    const verifyResolved: ResolvedText | undefined =
      verifySpecs.length > 0 ? yield* resolveTextSpecs([...verifySpecs], input.cwd, 'verify') : undefined

    const judgeSpecs: readonly string[] =
      cli.judges.length > 0 ? cli.judges : cfg?.judge !== undefined ? [cfg.judge] : []
    const judgeResolved: ResolvedText | undefined =
      judgeSpecs.length > 0 ? yield* resolveTextSpecs([...judgeSpecs], input.cwd, 'judge') : undefined

    const runsPick = pick(cli.runs, cfg?.runs)
    if (runsPick.value !== undefined && runsPick.value < 1) {
      return yield* Effect.fail(
        cliParseError('--runs must be ≥ 1', 'E_CONFIG_INVALID', {
          reason: 'runs-min',
          value: runsPick.value,
        }),
      )
    }
    const runs = runsPick.value ?? DEFAULT_RUNS

    const isolationPick = pick(cli.isolation, cfg?.isolation)
    const requestedIsolation: IsolationMode = isolationPick.value ?? DEFAULT_ISOLATION

    const isolationResolved = yield* resolveIsolation(requestedIsolation)
    const { isolation, dockerDowngraded } = isolationResolved

    const dockerImagePick = pick(cli.dockerImage, cfg?.dockerImage)
    const dockerNetworkPick = pick(cli.dockerNetwork, cfg?.dockerNetwork)

    const packRefPick = pick(cli.packRef, cfg?.packRef)
    const explicitPackType = pick(cli.packType, cfg?.packType)
    const packTypeResolved = yield* Effect.gen(function* () {
      if (explicitPackType.value !== undefined) {
        return { value: explicitPackType.value, src: explicitPackType.src }
      }
      if (packRefPick.value === undefined) {
        return { value: undefined as PackType | undefined, src: 'default' as const }
      }
      const ref = packRefPick.value
      const detected = yield* detectPack(ref).pipe(
        Effect.mapError((e: PackDetectError) =>
          cliParseError(`invalid --pack reference: ${safeRefDisplay(ref)}`, 'E_CONFIG_INVALID', {
            packRef: safeRefDisplay(ref),
            reason: e.reason,
          }),
        ),
      )
      return { value: detected.type, src: packRefPick.src }
    })
    const { value: packTypeValue, src: packTypeSrc } = packTypeResolved

    const formats = resolveFormats(cli.formats, normalizeConfigFormats(cfg?.formats))

    const pureBaselinePick = pick(cli.pureBaseline, cfg?.pureBaseline)
    const preflightPick = pick(cli.preflightEnabled, cfg?.preflightEnabled)
    const diffHtmlPick = pick(cli.diffHtml, cfg?.diffHtml)
    const protectGitPick = pick(cli.protectGit, cfg?.protectGit)
    const collapsePick = pick(cli.collapseRepeats, cfg?.collapseRepeats)
    const timelinePick = pick(cli.timelineMode, cfg?.timelineMode)
    const logPick = pick(cli.logLevel, cfg?.logLevel)
    const outputPick = pick(cli.outputPath, cfg?.outputPath)
    const workspacePick = pick(cli.workspacePath, cfg?.workspacePath)
    const opencodeVersionPick = pick(cli.opencodeVersion, cfg?.opencodeVersion)
    const preflightModelPick = pick(cli.preflightModel, cfg?.preflightModel)
    const modelPick = pick(cli.model, cfg?.model)
    const pricingPick = pick(cli.pricingPath, cfg?.pricingPath)

    const timeouts = mergeTimeouts(cli.timeouts, cfg?.timeouts)
    const badTimeout = firstNonPositiveTimeout(timeouts)
    if (badTimeout !== undefined) {
      return yield* Effect.fail(
        cliParseError(
          `timeout must be positive: ${badTimeout.key}=${String(badTimeout.value)}`,
          'E_CONFIG_INVALID',
          { key: badTimeout.key, value: badTimeout.value },
        ),
      )
    }
    const auth = mergeAuth(cli.auth, cfg?.auth)

    const preflightModelValue = preflightModelPick.value
    if (preflightModelValue !== undefined && !isValidModelRef(preflightModelValue)) {
      return yield* Effect.fail(
        cliParseError(
          `model unavailable: ${preflightModelValue}`,
          'E_MODEL_UNAVAILABLE',
          { model: preflightModelValue, reason: 'unknown-model' },
        ),
      )
    }

    const modelValue = modelPick.value
    if (modelValue !== undefined && !isValidModelRef(modelValue)) {
      return yield* Effect.fail(
        cliParseError(
          `model unavailable: ${modelValue}`,
          'E_MODEL_UNAVAILABLE',
          { model: modelValue, reason: 'unknown-model' },
        ),
      )
    }

    const sources: readonly ('cli' | 'config' | 'default')[] = [
      repoUrlPick.src,
      promptSrc,
      runsPick.src,
      isolationPick.src,
      packRefPick.src,
      packTypeSrc,
      pureBaselinePick.src,
      preflightPick.src,
      diffHtmlPick.src,
      protectGitPick.src,
      collapsePick.src,
      timelinePick.src,
      initSidePick.src,
      logPick.src,
      outputPick.src,
      workspacePick.src,
      opencodeVersionPick.src,
      preflightModelPick.src,
      modelPick.src,
      pricingPick.src,
      dockerNetworkPick.src,
    ]
    const hasCli = sources.includes('cli')
    const hasConfig = sources.includes('config')
    const configSource: CliParseResult['configSource'] =
      hasCli && hasConfig ? 'merged' : hasConfig ? 'config' : 'cli'

    const runInput: RunInput = {
      repoUrl: repoUrlPick.value,
      prompt: promptResolved.text,
      runs,
      isolation,
      auth,
      pureBaseline: pureBaselinePick.value ?? DEFAULT_PURE_BASELINE,
      preflightEnabled: preflightPick.value ?? DEFAULT_PREFLIGHT_ENABLED,
      formats: [...formats],
      outputPath: outputPick.value ?? DEFAULT_OUTPUT_PATH,
      diffHtml: diffHtmlPick.value ?? DEFAULT_DIFF_HTML,
      protectGit: protectGitPick.value ?? DEFAULT_PROTECT_GIT,
      collapseRepeats: collapsePick.value ?? DEFAULT_COLLAPSE_REPEATS,
      timelineMode: timelinePick.value ?? DEFAULT_TIMELINE_MODE,
      initSide: initSidePick.value ?? DEFAULT_INIT_SIDE,
      timeouts,
      workspacePath: workspacePick.value ?? DEFAULT_WORKSPACE_PATH,
      logLevel: logPick.value ?? DEFAULT_LOG_LEVEL,
      ...(packRefPick.value !== undefined ? { packRef: packRefPick.value } : {}),
      ...(packTypeValue !== undefined ? { packType: packTypeValue } : {}),
      ...(promptResolved.files.length > 0 ? { promptFiles: [...promptResolved.files] } : {}),
      ...(initResolved !== undefined
        ? { init: initResolved.text, initFiles: [...initResolved.files] }
        : {}),
      ...(verifyResolved !== undefined ? { verify: verifyResolved.text } : {}),
      ...(judgeResolved !== undefined
        ? { judge: judgeResolved.text, judgeFiles: [...judgeResolved.files] }
        : {}),
      ...(opencodeVersionPick.value !== undefined ? { opencodeVersion: opencodeVersionPick.value } : {}),
      ...(preflightModelPick.value !== undefined ? { preflightModel: preflightModelPick.value } : {}),
      ...(modelPick.value !== undefined ? { model: modelPick.value } : {}),
      ...(pricingPick.value !== undefined ? { pricingPath: pricingPick.value } : {}),
      ...(dockerNetworkPick.value !== undefined ? { dockerNetwork: dockerNetworkPick.value } : {}),
    }

    const zodResult = runInputSchema.safeParse(runInput)
    if (!zodResult.success) {
      return yield* Effect.fail(
        cliParseError('resolved RunInput failed schema validation', 'E_CONFIG_INVALID', {
          issues: zodResult.error.issues,
        }),
      )
    }

    // `initSide` has no dedicated report section (see 06-run-side.ru.md) — the
    // open `flagDefaults` record is how a run's report/manifest discloses which
    // side(s) actually got `--init`, the same channel `dockerDowngraded` uses.
    const flagDefaults: Record<string, unknown> = {
      dockerDowngraded,
      configSource,
      initSide: runInput.initSide,
    }

    return {
      runInput,
      configSource,
      flagDefaults,
      outputPathProvided: outputPick.src !== 'default',
      ...(dockerImagePick.value === undefined ? {} : { dockerImage: dockerImagePick.value }),
    }
  })
