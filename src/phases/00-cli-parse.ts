/**
 * Phase 00: cli-parse
 *
 * @see docs/phases/00-cli-parse.ru.md
 * @see contract/phases/00-cli-parse.tsp
 * @see .research/n-way-variants/00-overview.md §4 (legacy shim)
 * @see .research/n-way-variants/02-phases.md §00 (mechanics + AC)
 */
import { Effect } from 'effect'
import path from 'node:path'
import { z } from 'zod'
import type {
  AuthWhitelist,
  CliParseInput,
  CliParseResult,
  IsolationMode,
  LogLevel,
  OutputFormat,
  PackSpec,
  PackType,
  RunInput,
  TimeoutConfig,
  TimelineMode,
  VariantSpec,
} from '@generated/types'
import {
  authWhitelistSchema,
  isolationModeSchema,
  logLevelSchema,
  outputFormatSchema,
  packSpecSchema,
  packTypeSchema,
  runInputSchema,
  timeoutConfigSchema,
  timelineModeSchema,
  variantSpecSchema,
} from '@generated/schemas'
import { detectPack, safeRefDisplay } from '../pack/detector.js'
import type { PackDetectError } from '../pack/detector.js'
import { cliParseError } from '../errors.js'
import type { PhaseError } from '../errors.js'
import { exists, readFile } from '../util/fs.js'
import { isDockerAvailable } from '../util/docker.js'
import { redactUrlCredentials } from '../util/redact.js'

export type CliParseOutput = CliParseResult & {
  readonly flagDefaults: Readonly<Record<string, unknown>>
  readonly dockerImage?: string
  readonly outputPathProvided: boolean
}

// ---------------------------------------------------------------------------
// Shared conveniences (n-way variants) — every other package imports these
// from here rather than re-implementing them.
// ---------------------------------------------------------------------------

export const VARIANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const RESERVED_VARIANT_NAMES: ReadonlySet<string> = new Set(['source'])

/**
 * Pack names become a `pack/<name>/` directory segment (03-pack-install.ts)
 * with no containment guard downstream — so, unlike variant names, this
 * allows npm-style dots/underscores (real package names use them, e.g.
 * `lodash.merge`) while still rejecting every path-unsafe shape: no `/` or
 * `\`, no leading dot (rules out `.`/`..`/hidden-file names in one stroke),
 * no empty string.
 */
const PACK_NAME_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * A short, comparable name out of a pack ref: strips the `npm:`/`mcp:`/
 * `agent:`/`command:` prefix, an `mcp:name:config` payload, a trailing
 * `.git`, and takes the last `/`-segment (handles scoped npm names, git
 * URLs, and local paths alike). Approximate on purpose — this only feeds a
 * best-effort naming heuristic (the legacy shim's pack name, and the
 * variant.packs bare-ref shorthand), not `pack/detector.ts`'s real detection.
 *
 * Unlike `ref` itself, the NAME this returns is a disclosed identifier — it
 * lands in manifest/report provenance and the judge prompt, none of which
 * redact `ref`. `https://user:token@host/...` must not leak `user:token`
 * into the name, so the ref is redacted first (harmless no-op for every
 * other ref shape — `redactUrlCredentials` only matches `http(s)/ssh/git`
 * URLs with userinfo).
 */
export const packShortName = (ref: string): string => {
  const safeRef = redactUrlCredentials(ref)
  const prefixMatch = /^(npm:|mcp:|agent:|command:)/i.exec(safeRef)
  const afterPrefix = prefixMatch === null ? safeRef : safeRef.slice(prefixMatch[0].length)
  const afterMcpConfig =
    prefixMatch?.[0].toLowerCase() === 'mcp:' && afterPrefix.includes(':')
      ? afterPrefix.slice(0, afterPrefix.indexOf(':'))
      : afterPrefix
  const clean = afterMcpConfig.replace(/\.git$/, '').replace(/\/+$/, '')
  const parts = clean.split('/')
  return (parts[parts.length - 1] ?? clean).toLowerCase()
}

type EffectiveKey = 'prompt' | 'init' | 'model' | 'hint' | 'verify'

/**
 * A variant's own field wins when set — EXCEPT an explicit `''`, which
 * disables the inherited global outright rather than falling back to it
 * (D7: `init: ""` / `hint: ""` / `verify: ""` explicitly disables).
 */
export const effectiveOf = (
  v: VariantSpec,
  g: string | undefined,
  key: EffectiveKey,
): string | undefined => {
  const own = v[key]
  if (own === undefined) return g
  if (own === '') return undefined
  return own
}

/** Resolves `variant.packs` name references against the run's pack registry. */
export const packsOf = (runInput: RunInput, v: VariantSpec): readonly PackSpec[] => {
  const registry = new Map(runInput.packs.map((p) => [p.name, p]))
  return v.packs.flatMap((name) => {
    const p = registry.get(name)
    return p === undefined ? [] : [p]
  })
}

/** union(every OTHER variant's packs) − this variant's own packs. */
export const foreignPacksOf = (runInput: RunInput, v: VariantSpec): readonly PackSpec[] => {
  const own = new Set(v.packs)
  const foreignNames = runInput.variants
    .filter((other) => other.name !== v.name)
    .flatMap((other) => other.packs)
    .filter((name, i, all) => !own.has(name) && all.indexOf(name) === i)
  return foreignNames.flatMap((name) => {
    const p = runInput.packs.find((pp) => pp.name === name)
    return p === undefined ? [] : [p]
  })
}

/** By `runInput.baseline`. Throws if the RunInput was not validated first — every RunInput phase 00 produces satisfies this. */
export const baselineOf = (runInput: RunInput): VariantSpec => {
  const found = runInput.variants.find((v) => v.name === runInput.baseline)
  if (found === undefined) {
    throw new Error(`baselineOf: no variant named "${runInput.baseline}" (RunInput was not validated)`)
  }
  return found
}

// ---------------------------------------------------------------------------
// Defaults applied when neither the CLI nor the config file set a value.
// Named (not inlined at each `?? ...`) so the `run --help` flag table can
// read the exact value the parser uses instead of a copy that could drift.
// ---------------------------------------------------------------------------

export const DEFAULT_RUNS = 3
export const DEFAULT_PARALLEL = 2
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
export const DEFAULT_ALLOW_BASELINE_TOOL = false
export const DEFAULT_TIMELINE_MODE: TimelineMode = 'side-by-side'
export const DEFAULT_LOG_LEVEL: LogLevel = 'info'
export const DEFAULT_OUTPUT_PATH = './results'
export const DEFAULT_WORKSPACE_PATH = './.testaipack'

// `InitSide`/`initSideSchema` no longer exist on the wire (contract barrier,
// 01-contract.md §1) — `--init-side` is now a pure legacy-shim CLI concept
// that decides which of the shim's two desugared variants receive `--init`.
const legacyInitSideSchema = z.enum(['both', 'old', 'new'])
type LegacyInitSide = z.infer<typeof legacyInitSideSchema>
export const DEFAULT_INIT_SIDE: LegacyInitSide = 'both'

type TimeoutUpdate = { readonly [K in keyof TimeoutConfig]?: number | undefined }
type AuthUpdate = { readonly [K in keyof AuthWhitelist]?: boolean | undefined }

const timeoutPartialSchema = timeoutConfigSchema.partial()
const authPartialSchema = authWhitelistSchema.partial()

const configFileSchema = z
  .object({
    repoUrl: z.string().optional(),
    // --- n-way variants (v2) ---
    variants: z.array(variantSpecSchema).optional(),
    packs: z.array(packSpecSchema).optional(),
    baseline: z.string().optional(),
    parallel: z.number().int().optional(),
    hint: z.string().optional(),
    // --- legacy two-sided surface (kept indefinitely) ---
    packRef: z.string().optional(),
    packType: packTypeSchema.optional(),
    prompt: z.string().optional(),
    promptFiles: z.array(z.string()).optional(),
    init: z.string().optional(),
    initFiles: z.array(z.string()).optional(),
    initSide: legacyInitSideSchema.optional(),
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
    packSetup: z.string().optional(),
    packCheck: z.string().optional(),
    packExercise: z.string().optional(),
    allowBaselineTool: z.boolean().optional(),
    packHint: z.string().optional(),
  })
  .strict()

type ConfigFile = z.infer<typeof configFileSchema>
type ConfigPackSpec = NonNullable<ConfigFile['packs']>[number]
type ConfigVariantSpec = NonNullable<ConfigFile['variants']>[number]

// zod's `.optional()` infers `x?: T | undefined` (an explicit union); the
// generated `PackSpec`/`VariantSpec` declare plain optionals (`x?: T`).
// Under `exactOptionalPropertyTypes`, those are NOT the same type — a
// present-with-`undefined` key is allowed by the former, forbidden by the
// latter — so a config-parsed pack/variant needs rebuilding through the
// same conditional-spread pattern the rest of this file already uses for
// RunInput's own optional fields, not a direct pass-through.
const toPackSpec = (p: ConfigPackSpec): PackSpec => ({
  name: p.name,
  ref: p.ref,
  ...(p.type !== undefined ? { type: p.type } : {}),
  ...(p.setup !== undefined ? { setup: p.setup } : {}),
  ...(p.check !== undefined ? { check: p.check } : {}),
})

const toVariantSpec = (v: ConfigVariantSpec): VariantSpec => ({
  name: v.name,
  packs: [...v.packs],
  ...(v.prompt !== undefined ? { prompt: v.prompt } : {}),
  ...(v.init !== undefined ? { init: v.init } : {}),
  ...(v.model !== undefined ? { model: v.model } : {}),
  ...(v.hint !== undefined ? { hint: v.hint } : {}),
  ...(v.pure !== undefined ? { pure: v.pure } : {}),
  ...(v.verify !== undefined ? { verify: v.verify } : {}),
  ...(v.exercise !== undefined ? { exercise: v.exercise } : {}),
  ...(v.allowPacks !== undefined ? { allowPacks: [...v.allowPacks] } : {}),
})

interface CliRaw {
  readonly repoUrl?: string
  readonly prompts: readonly string[]
  readonly inits: readonly string[]
  readonly initSide?: LegacyInitSide
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
  readonly packSetup?: string
  readonly packCheck?: string
  readonly packExercise?: string
  readonly allowBaselineTool?: boolean
  readonly packHint?: string
  readonly hint?: string
  readonly parallel?: number
  readonly baseline?: string
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
  '--pack-setup': 'packSetup',
  '--pack-check': 'packCheck',
  '--pack-exercise': 'packExercise',
  '--pack-hint': 'packHint',
  '--hint': 'hint',
  '--parallel': 'parallel',
  '--baseline': 'baseline',
  '--timeout-preflight': 'preflightSeconds',
  '--timeout-run': 'runSeconds',
  '--timeout-verify': 'verifySeconds',
  '--timeout-install': 'installSeconds',
  '--watchdog': 'watchdogSeconds',
  '--timeout-total': 'totalSeconds',
}

export type RunBooleanKey =
  | 'pureBaseline'
  | 'preflightEnabled'
  | 'diffHtml'
  | 'protectGit'
  | 'collapseRepeats'
  | 'allowBaselineTool'

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
  '--allow-baseline-tool': { key: 'allowBaselineTool', value: true },
  '--no-allow-baseline-tool': { key: 'allowBaselineTool', value: false },
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

// Legacy variant-shaping flags/keys: forbidden together with a `variants`
// config key (00-overview.md §4, normative). `hint`/`--hint` is the new
// n-way global default and stays allowed in variant mode; `packHint`/
// `--pack-hint` is its legacy name and is treated the same as the other
// legacy pack flags here.
const LEGACY_VARIANT_SHAPING_KEYS: readonly (keyof CliRaw & keyof ConfigFile)[] = [
  'packRef',
  'packType',
  'pureBaseline',
  'initSide',
  'packSetup',
  'packCheck',
  'packExercise',
  'allowBaselineTool',
  'packHint',
]

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
    if (dest === 'parallel') {
      const n = parseIntStrict(raw)
      if (n === undefined) {
        return yield* Effect.fail(
          cliParseError(`invalid --parallel value: ${raw}`, 'E_CONFIG_INVALID', { value: raw }),
        )
      }
      return setScalar(acc, 'parallel', n)
    }
    if (dest === 'baseline') return setScalar(acc, 'baseline', raw)
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
      const v = yield* parseEnum(raw, legacyInitSideSchema, '--init-side')
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
    if (dest === 'packSetup') return setScalar(acc, 'packSetup', raw)
    if (dest === 'packCheck') return setScalar(acc, 'packCheck', raw)
    if (dest === 'packExercise') return setScalar(acc, 'packExercise', raw)
    if (dest === 'packHint') return setScalar(acc, 'packHint', raw)
    if (dest === 'hint') return setScalar(acc, 'hint', raw)
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

// ---------------------------------------------------------------------------
// n-way variants: legacy shim desugaring (00-overview.md §4)
// ---------------------------------------------------------------------------

interface LegacyDesugarParams {
  readonly packRef: string | undefined
  readonly packName: string | undefined
  readonly packType: PackType | undefined
  readonly packSetup: string | undefined
  readonly packCheck: string | undefined
  readonly packExercise: string | undefined
  readonly pureBaseline: boolean
  readonly initSide: LegacyInitSide
  readonly initText: string | undefined
  readonly allowBaselineTool: boolean
}

interface LegacyDesugarResult {
  readonly packs: readonly PackSpec[]
  readonly variants: readonly VariantSpec[]
  readonly baseline: string
}

const desugarLegacy = (p: LegacyDesugarParams): LegacyDesugarResult => {
  const packs: readonly PackSpec[] =
    p.packRef === undefined
      ? []
      : [
          {
            name: p.packName as string,
            ref: p.packRef,
            ...(p.packType !== undefined ? { type: p.packType } : {}),
            ...(p.packSetup !== undefined ? { setup: p.packSetup } : {}),
            ...(p.packCheck !== undefined ? { check: p.packCheck } : {}),
          },
        ]
  const oldGetsInit = p.initText !== undefined && (p.initSide === 'both' || p.initSide === 'old')
  const newGetsInit = p.initText !== undefined && (p.initSide === 'both' || p.initSide === 'new')
  const variants: readonly VariantSpec[] = [
    {
      name: 'old',
      packs: [],
      pure: p.pureBaseline,
      ...(oldGetsInit ? { init: p.initText } : {}),
      ...(p.allowBaselineTool && p.packName !== undefined ? { allowPacks: [p.packName] } : {}),
    },
    {
      name: 'new',
      packs: p.packName !== undefined ? [p.packName] : [],
      pure: false,
      ...(newGetsInit ? { init: p.initText } : {}),
      ...(p.packExercise !== undefined ? { exercise: p.packExercise } : {}),
    },
  ]
  return { packs, variants, baseline: 'old' }
}

interface ResolvedVariantTexts {
  readonly variants: readonly VariantSpec[]
  readonly promptFiles: readonly string[]
  readonly initFiles: readonly string[]
}

interface ResolvedVariantText {
  readonly variant: VariantSpec
  readonly promptFiles: readonly string[]
  readonly initFiles: readonly string[]
}

const resolveOneVariantText = (
  v: VariantSpec,
  cwd: string,
): Effect.Effect<ResolvedVariantText, PhaseError> =>
  Effect.gen(function* () {
    const promptResolved =
      v.prompt !== undefined ? yield* resolveTextSpecs([v.prompt], cwd, `variant "${v.name}" prompt`) : undefined
    const initResolved =
      v.init !== undefined ? yield* resolveTextSpecs([v.init], cwd, `variant "${v.name}" init`) : undefined
    const hintResolved =
      v.hint !== undefined ? yield* resolveTextSpecs([v.hint], cwd, `variant "${v.name}" hint`) : undefined
    return {
      variant: {
        ...v,
        ...(promptResolved !== undefined ? { prompt: promptResolved.text } : {}),
        ...(initResolved !== undefined ? { init: initResolved.text } : {}),
        ...(hintResolved !== undefined ? { hint: hintResolved.text } : {}),
      },
      promptFiles: promptResolved?.files ?? [],
      initFiles: initResolved?.files ?? [],
    }
  })

/** `@file` resolution for native-mode variant prompt/init/hint (02-phases.md §00 item 7). */
const resolveVariantTextFields = (
  variants: readonly VariantSpec[],
  cwd: string,
): Effect.Effect<ResolvedVariantTexts, PhaseError> =>
  Effect.gen(function* () {
    const resolved = yield* Effect.forEach(variants, (v) => resolveOneVariantText(v, cwd))
    return {
      variants: resolved.map((r) => r.variant),
      promptFiles: resolved.flatMap((r) => r.promptFiles),
      initFiles: resolved.flatMap((r) => r.initFiles),
    }
  })

interface PackResolution {
  readonly packs: readonly PackSpec[]
  readonly variants: readonly VariantSpec[]
}

interface PackNamesResolution {
  readonly packs: readonly PackSpec[]
  readonly names: readonly string[]
}

/** Resolves one variant's `packs` entries against (and possibly into) the registry-so-far. */
const resolvePackNamesForOneVariant = (
  variantName: string,
  packs: readonly PackSpec[],
  entries: readonly string[],
): Effect.Effect<PackNamesResolution, PhaseError> =>
  Effect.reduce(entries, { packs, names: [] } as PackNamesResolution, (acc, entry) =>
    Effect.gen(function* () {
      const existing = acc.packs.find((p) => p.name === entry)
      if (existing !== undefined) {
        return { packs: acc.packs, names: [...acc.names, entry] }
      }
      const name = packShortName(entry)
      const collision = acc.packs.find((p) => p.name === name)
      if (collision !== undefined && collision.ref !== entry) {
        return yield* Effect.fail(
          cliParseError(
            `variant "${variantName}"'s pack ref resolves to a name already registered with a different ref: ${name}`,
            'E_CONFIG_INVALID',
            { reason: 'pack-name-collision', variant: variantName, pack: name },
          ),
        )
      }
      const nextPacks = collision === undefined ? [...acc.packs, { name, ref: entry }] : acc.packs
      return { packs: nextPacks, names: [...acc.names, name] }
    }),
  )

/**
 * `variant.packs` entries may name a registered pack, or be a bare ref that
 * auto-registers a new pack named `packShortName(ref)` (D4). Rewrites each
 * variant's `packs` to canonical registered names, so downstream phases
 * never re-implement this shorthand.
 */
const resolvePacksForVariants = (
  initialPacks: readonly PackSpec[],
  variants: readonly VariantSpec[],
): Effect.Effect<PackResolution, PhaseError> =>
  Effect.reduce(
    variants,
    { packs: initialPacks, variants: [] } as PackResolution,
    (acc, v) =>
      Effect.gen(function* () {
        const resolved = yield* resolvePackNamesForOneVariant(v.name, acc.packs, v.packs)
        return { packs: resolved.packs, variants: [...acc.variants, { ...v, packs: [...resolved.names] }] }
      }),
  )

/** For each PackSpec without `type`, run `detectPack(ref)` so downstream phases never re-detect. */
const detectPackTypes = (
  packs: readonly PackSpec[],
): Effect.Effect<readonly PackSpec[], PhaseError> =>
  Effect.forEach(packs, (p) =>
    Effect.gen(function* () {
      if (p.type !== undefined) return p
      const detected = yield* detectPack(p.ref).pipe(
        Effect.mapError((e: PackDetectError) =>
          cliParseError(`invalid pack reference: ${safeRefDisplay(p.ref)}`, 'E_CONFIG_INVALID', {
            pack: p.name,
            ref: safeRefDisplay(p.ref),
            reason: e.reason,
          }),
        ),
      )
      return { ...p, type: detected.type }
    }),
  )

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

    const variantMode = cfg?.variants !== undefined

    if (variantMode) {
      const offender = LEGACY_VARIANT_SHAPING_KEYS.find(
        (key) => cli[key] !== undefined || cfg[key] !== undefined,
      )
      if (offender !== undefined) {
        return yield* Effect.fail(
          cliParseError(
            `--variants (config) cannot be combined with the legacy "${offender}" flag/key`,
            'E_CONFIG_INVALID',
            { reason: 'legacy-flag-with-variants', key: offender },
          ),
        )
      }
    }

    const cliPromptSpecs = cli.prompts
    const cfgPromptSpecs: readonly string[] = [
      ...(cfg?.promptFiles ?? []),
      ...(cfg?.prompt !== undefined ? [cfg.prompt] : []),
    ]
    const promptSpecs = cliPromptSpecs.length > 0 ? cliPromptSpecs : cfgPromptSpecs
    const promptSrc: 'cli' | 'config' | 'default' =
      cliPromptSpecs.length > 0 ? 'cli' : cfgPromptSpecs.length > 0 ? 'config' : 'default'
    // Global prompt is optional in v2 (D7) — every variant needs an EFFECTIVE
    // (own or global) non-empty prompt, checked once packs/variants are built.
    const promptResolved: ResolvedText | undefined =
      promptSpecs.length > 0 ? yield* resolveTextSpecs([...promptSpecs], input.cwd, 'prompt') : undefined

    const initSpecs: readonly string[] =
      cli.inits.length > 0 ? cli.inits : cfg?.init !== undefined ? [cfg.init] : []
    const globalInitResolved: ResolvedText | undefined =
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
    const packSetupPick = pick(cli.packSetup, cfg?.packSetup)
    const packCheckPick = pick(cli.packCheck, cfg?.packCheck)
    const packExercisePick = pick(cli.packExercise, cfg?.packExercise)
    const allowBaselineToolPick = pick(cli.allowBaselineTool, cfg?.allowBaselineTool)
    // `--hint` and its legacy alias `--pack-hint` both feed one global value —
    // tracked as separate CliRaw/config fields only so the mixing guard above
    // can still tell `--pack-hint` (legacy) apart from `--hint` (always allowed).
    const hintPick = pick(cli.hint ?? cli.packHint, cfg?.hint ?? cfg?.packHint)
    const parallelPick = pick(cli.parallel, cfg?.parallel)
    const baselinePick = pick(cli.baseline, cfg?.baseline)

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

    // --pack-setup/--pack-check/--pack-exercise install/verify/run the PACK's
    // own runtime — meaningless without a pack under test. Legacy-mode-only:
    // in variant mode these keys are already rejected above.
    if (
      packRefPick.value === undefined &&
      (packSetupPick.value !== undefined || packCheckPick.value !== undefined || packExercisePick.value !== undefined)
    ) {
      return yield* Effect.fail(
        cliParseError(
          '--pack-setup/--pack-check/--pack-exercise require --pack (or packRef in config)',
          'E_CONFIG_INVALID',
          { reason: 'pack-setup-without-pack' },
        ),
      )
    }

    // ---- build packs + variants + baseline (mode-specific) ----
    interface ModeResult {
      readonly packs: readonly PackSpec[]
      readonly variants: readonly VariantSpec[]
      readonly baselineDefault: string
      readonly promptFiles: readonly string[]
      readonly initFiles: readonly string[]
    }

    const packName = packRefPick.value !== undefined ? packShortName(packRefPick.value) : undefined
    const desugared = desugarLegacy({
      packRef: packRefPick.value,
      packName,
      packType: explicitPackType.value,
      packSetup: packSetupPick.value,
      packCheck: packCheckPick.value,
      packExercise: packExercisePick.value,
      pureBaseline: pureBaselinePick.value ?? DEFAULT_PURE_BASELINE,
      initSide: initSidePick.value ?? DEFAULT_INIT_SIDE,
      initText: globalInitResolved?.text,
      allowBaselineTool: allowBaselineToolPick.value ?? DEFAULT_ALLOW_BASELINE_TOOL,
    })

    const modeResult: ModeResult = variantMode
      ? yield* resolveVariantTextFields((cfg.variants ?? []).map(toVariantSpec), input.cwd).pipe(
          Effect.map((resolvedTexts) => ({
            packs: (cfg.packs ?? []).map(toPackSpec),
            variants: resolvedTexts.variants,
            baselineDefault: resolvedTexts.variants[0]?.name ?? '',
            promptFiles: resolvedTexts.promptFiles,
            initFiles: resolvedTexts.initFiles,
          })),
        )
      : {
          packs: desugared.packs,
          variants: desugared.variants,
          baselineDefault: desugared.baseline,
          promptFiles: [],
          initFiles: [],
        }
    const { promptFiles: variantPromptFiles, initFiles: variantInitFiles } = modeResult

    if (modeResult.variants.length === 0) {
      return yield* Effect.fail(
        cliParseError('at least one variant is required', 'E_CONFIG_INVALID', { reason: 'no-variants' }),
      )
    }

    const invalidName = modeResult.variants.find((v) => !VARIANT_NAME_RE.test(v.name))
    if (invalidName !== undefined) {
      return yield* Effect.fail(
        cliParseError(`invalid variant name: ${invalidName.name}`, 'E_CONFIG_INVALID', {
          reason: 'invalid-variant-name',
          variant: invalidName.name,
        }),
      )
    }
    const reservedName = modeResult.variants.find((v) => RESERVED_VARIANT_NAMES.has(v.name))
    if (reservedName !== undefined) {
      return yield* Effect.fail(
        cliParseError(`variant name is reserved: ${reservedName.name}`, 'E_CONFIG_INVALID', {
          reason: 'reserved-variant-name',
          variant: reservedName.name,
        }),
      )
    }
    const allNames = modeResult.variants.map((v) => v.name)
    const duplicateName = allNames.find((name, i) => allNames.indexOf(name) !== i)
    if (duplicateName !== undefined) {
      return yield* Effect.fail(
        cliParseError(`duplicate variant name: ${duplicateName}`, 'E_CONFIG_INVALID', {
          reason: 'duplicate-variant-name',
          variant: duplicateName,
        }),
      )
    }

    const packResolution = yield* resolvePacksForVariants(modeResult.packs, modeResult.variants)

    // Pack names become a `pack/<name>/` path segment downstream (phase 03)
    // with no containment guard there — reject anything unsafe here, the
    // single validation point (both config-declared names and D4 bare-ref
    // auto-registered ones, which derive from packShortName and could still
    // land on `..`/`.`/`` for a pathological ref like `.../foo/..`). Runs
    // BEFORE detectPackTypes on purpose: detectPack has its own internal
    // name-safety check, but it re-derives that name from `ref` independently
    // (not from the PackSpec.name this phase actually persists) — it is not
    // a substitute for validating the name that downstream phases consume.
    const invalidPackName = packResolution.packs.find((p) => !PACK_NAME_SAFE_RE.test(p.name))
    if (invalidPackName !== undefined) {
      return yield* Effect.fail(
        cliParseError(`invalid pack name: ${invalidPackName.name}`, 'E_CONFIG_INVALID', {
          reason: 'invalid-pack-name',
          pack: invalidPackName.name,
        }),
      )
    }
    const rawPackNames = packResolution.packs.map((p) => p.name)
    const duplicatePackName = rawPackNames.find((name, i) => rawPackNames.indexOf(name) !== i)
    if (duplicatePackName !== undefined) {
      return yield* Effect.fail(
        cliParseError(`duplicate pack name in registry: ${duplicatePackName}`, 'E_CONFIG_INVALID', {
          reason: 'duplicate-pack-name',
          pack: duplicatePackName,
        }),
      )
    }

    const packs = yield* detectPackTypes(packResolution.packs)
    const variants = packResolution.variants

    const packNames = new Set(rawPackNames)
    for (const v of variants) {
      for (const name of v.allowPacks ?? []) {
        if (!packNames.has(name)) {
          return yield* Effect.fail(
            cliParseError(
              `variant "${v.name}"'s allowPacks names an unknown pack: ${name}`,
              'E_CONFIG_INVALID',
              { reason: 'unknown-pack-ref', variant: v.name, pack: name },
            ),
          )
        }
      }
    }

    // A variant naming the same pack twice (`packs: ['p1', 'p1']`) is always a
    // config mistake, not a meaningful "declare it harder" — reject rather
    // than silently de-duplicating, so the collision is visible at parse time
    // instead of surfacing later as a confusing double-apply in phase 04.
    for (const v of variants) {
      const dup = v.packs.find((name, i) => v.packs.indexOf(name) !== i)
      if (dup !== undefined) {
        return yield* Effect.fail(
          cliParseError(
            `variant "${v.name}" declares pack "${dup}" more than once`,
            'E_CONFIG_INVALID',
            { reason: 'duplicate-pack-in-variant', variant: v.name, pack: dup },
          ),
        )
      }
    }

    // `--pack-setup/--pack-check/--pack-exercise require --pack` (above) only
    // covered the legacy flags; `variant.exercise` is the native-mode
    // equivalent and was never generalized (02-phases.md §00 item 4:
    // "variant.exercise requires >=1 pack on the variant, OR any pack in the
    // run"). Unreachable for the shim (packExercisePick already requires
    // packRefPick above), so this is purely the native-mode gap — keep the
    // old message text for the (dead, but symmetric) shim branch.
    for (const v of variants) {
      if (v.exercise !== undefined && v.packs.length === 0 && packs.length === 0) {
        return yield* Effect.fail(
          cliParseError(
            variantMode
              ? `variant "${v.name}" declares exercise but no pack is declared anywhere in the run`
              : '--pack-setup/--pack-check/--pack-exercise require --pack (or packRef in config)',
            'E_CONFIG_INVALID',
            { reason: 'pack-setup-without-pack', variant: v.name },
          ),
        )
      }
    }

    const baseline = baselinePick.value ?? modeResult.baselineDefault
    if (!variants.some((v) => v.name === baseline)) {
      return yield* Effect.fail(
        cliParseError(`baseline names an unknown variant: ${baseline}`, 'E_CONFIG_INVALID', {
          reason: 'unknown-baseline',
          baseline,
        }),
      )
    }

    // Unlike prompt/init/judge, the global hint was never `@file`-resolved as
    // `--pack-hint` (v1) — kept as a raw string here for the same reason.
    // Per-variant `hint` (native mode) DOES get `@file` resolution, above.
    const globalHintValue = hintPick.value

    for (const v of variants) {
      const effective = effectiveOf(v, promptResolved?.text, 'prompt')
      if (effective === undefined || effective === '') {
        return yield* Effect.fail(
          cliParseError(`variant "${v.name}" has no effective prompt`, 'E_CONFIG_INVALID', {
            reason: 'prompt-required',
            variant: v.name,
          }),
        )
      }
    }

    const parallel = parallelPick.value ?? DEFAULT_PARALLEL
    if (parallel < 1) {
      return yield* Effect.fail(
        cliParseError('--parallel must be ≥ 1', 'E_CONFIG_INVALID', {
          reason: 'parallel-min',
          value: parallel,
        }),
      )
    }

    // `--pack-check` only ever runs inside preflight's gate 6 (05-preflight.ts)
    // — with preflight disabled a declared check is never executed, so a
    // report claiming the pack was verified functional would be confident but
    // unverified. Generalizes the old side-specific check to any pack in the
    // registry (both legacy and native mode).
    const preflightEnabledValue = preflightPick.value ?? DEFAULT_PREFLIGHT_ENABLED
    const packWithCheck = packs.find((p) => p.check !== undefined)
    if (!preflightEnabledValue && packWithCheck !== undefined) {
      return yield* Effect.fail(
        cliParseError(
          `pack "${packWithCheck.name}" declares check, but preflight is disabled (remove --no-preflight, or drop the check)`,
          'E_CONFIG_INVALID',
          { reason: 'pack-check-without-preflight', pack: packWithCheck.name },
        ),
      )
    }

    const combinedPromptFiles = [...(promptResolved?.files ?? []), ...variantPromptFiles]
    const combinedInitFiles = [...(globalInitResolved?.files ?? []), ...variantInitFiles]

    const sources: readonly ('cli' | 'config' | 'default')[] = [
      repoUrlPick.src,
      promptSrc,
      runsPick.src,
      isolationPick.src,
      packRefPick.src,
      explicitPackType.src,
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
      packSetupPick.src,
      packCheckPick.src,
      packExercisePick.src,
      allowBaselineToolPick.src,
      hintPick.src,
      parallelPick.src,
      baselinePick.src,
      ...(variantMode ? (['config'] as const) : []),
    ]
    const hasCli = sources.includes('cli')
    const hasConfig = sources.includes('config')
    const configSource: CliParseResult['configSource'] =
      hasCli && hasConfig ? 'merged' : hasConfig ? 'config' : 'cli'

    const runInput: RunInput = {
      schemaVersion: 2,
      repoUrl: repoUrlPick.value,
      runs,
      parallel,
      baseline,
      packs: [...packs],
      variants: [...variants],
      isolation,
      auth,
      preflightEnabled: preflightEnabledValue,
      formats: [...formats],
      outputPath: outputPick.value ?? DEFAULT_OUTPUT_PATH,
      diffHtml: diffHtmlPick.value ?? DEFAULT_DIFF_HTML,
      protectGit: protectGitPick.value ?? DEFAULT_PROTECT_GIT,
      collapseRepeats: collapsePick.value ?? DEFAULT_COLLAPSE_REPEATS,
      timelineMode: timelinePick.value ?? DEFAULT_TIMELINE_MODE,
      timeouts,
      workspacePath: workspacePick.value ?? DEFAULT_WORKSPACE_PATH,
      logLevel: logPick.value ?? DEFAULT_LOG_LEVEL,
      ...(promptResolved !== undefined ? { prompt: promptResolved.text } : {}),
      ...(combinedPromptFiles.length > 0 ? { promptFiles: combinedPromptFiles } : {}),
      // The legacy shim distributes `init` per-variant (via --init-side) and
      // must NOT also set the global `init` — a set global would be inherited
      // by whichever shim variant was deliberately excluded (D7 fallback).
      ...(variantMode && globalInitResolved !== undefined ? { init: globalInitResolved.text } : {}),
      ...(combinedInitFiles.length > 0 ? { initFiles: combinedInitFiles } : {}),
      ...(globalHintValue !== undefined ? { hint: globalHintValue } : {}),
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

    // `initSide` has no report section of its own in v2 — the per-variant
    // `init` fields in the manifest disclose the same fact, so it no longer
    // needs a flagDefaults echo. `legacyShim` lets the pipeline (which prints
    // the D2 --no-pure-baseline behavior-change notice) tell the two modes
    // apart without re-deriving it from the desugared shape.
    const flagDefaults: Record<string, unknown> = {
      dockerDowngraded,
      configSource,
      parallel,
      baseline,
      legacyShim: !variantMode,
    }

    return {
      runInput,
      configSource,
      flagDefaults,
      outputPathProvided: outputPick.src !== 'default',
      ...(dockerImagePick.value === undefined ? {} : { dockerImage: dockerImagePick.value }),
    }
  })
