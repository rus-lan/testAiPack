/**
 * CLI entrypoint: parses argv with clipanion and dispatches to the phase
 * pipeline. Commands: `run` (default), `review`, `report`, `compare`, `list`,
 * `gc`, `init`, `doctor`.
 *
 * The `run` command forwards its raw trailing tokens (`Option.Proxy`) to phase
 * 00 (cli-parse), which owns flag parsing for the A/B run. Clipanion's
 * Option.Proxy captures every remaining token, option-shaped or not, so the
 * four orchestrator-level flags (`--review-run`, `--ide`, `--ephemeral`,
 * `--config`) cannot be declared as regular Option.* fields alongside it —
 * `splitRunFlags` pulls them out of the raw proxy tokens by hand before the
 * remainder reaches phase 00.
 *
 * @see docs/phases/00-cli-parse.ru.md
 */
import { Cli, Command, Builtins, Option } from 'clipanion'
import type { CommandClass, Usage } from 'clipanion'
import { Effect } from 'effect'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runPipeline } from './pipeline.js'
import { executeRebuild } from './rebuild.js'
import type { RebuildFlags } from './rebuild.js'
import { createProgressReporter, stderrSink } from './progress.js'
import type { ProgressReporter } from './progress.js'
import {
  listRuns,
  findRun,
  planGc,
  executeGc as executeGcPlan,
  readReport,
  ensureWorkspace,
  resolveWorkspace,
  parseOlderThan,
} from './workspace-runs.js'
import { runDoctor, hasCriticalFailure } from './doctor.js'
import {
  executeCompare,
  isCompareFormat,
  isVariantSelector,
} from './compare.js'
import { exists, writeJson } from '../util/fs.js'
import { updateGitignore } from '../util/gitignore.js'
import { mapIdeToBinary } from '../phases/12-review-workspace.js'
import { renderMd } from '../report/md.js'
import { PhaseError } from '../errors.js'
import {
  VALUE_FLAGS,
  BOOLEAN_FLAGS,
  AUTH_KEYS,
  NO_AUTH_PREFIX,
  TIMEOUT_KEYS,
  DEFAULT_RUNS,
  DEFAULT_PARALLEL,
  DEFAULT_TIMEOUTS,
  DEFAULT_AUTH,
  DEFAULT_ISOLATION,
  DEFAULT_PURE_BASELINE,
  DEFAULT_PREFLIGHT_ENABLED,
  DEFAULT_DIFF_HTML,
  DEFAULT_PROTECT_GIT,
  DEFAULT_COLLAPSE_REPEATS,
  DEFAULT_ALLOW_BASELINE_TOOL,
  DEFAULT_TIMELINE_MODE,
  DEFAULT_INIT_SIDE,
  DEFAULT_LOG_LEVEL,
  DEFAULT_OUTPUT_PATH,
  DEFAULT_WORKSPACE_PATH,
  DEFAULT_FORMATS,
} from '../phases/00-cli-parse.js'
import type { RunBooleanKey } from '../phases/00-cli-parse.js'
import {
  packTypeSchema,
  isolationModeSchema,
  timelineModeSchema,
  logLevelSchema,
  outputFormatSchema,
} from '@generated/schemas'
import type { OutputFormat, ReportSummary, TimelineMode } from '@generated/types'
import { DEFAULT_OPENCODE_IMAGE } from '../isolation/docker-runner.js'
import pkg from '../../package.json' with { type: 'json' }

const BINARY_NAME = 'testaipack'
const BINARY_VERSION: string = pkg.version

const parseNonNegativeInt = (s: string): number | undefined => {
  if (!/^\d+$/.test(s.trim())) return undefined
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : undefined
}

const parseRunIndex = (s: string): number | undefined => {
  const n = parseNonNegativeInt(s)
  return n !== undefined && n >= 1 ? n : undefined
}

const formatPhaseError = (e: PhaseError): string =>
  `[${e.phase}] ${e.code}: ${e.message}`

const exitCodeFromError = (e: unknown): number => {
  if (e instanceof PhaseError) {
    const ctx = e.context
    const ec = ctx === undefined ? undefined : ctx['exitCode']
    return typeof ec === 'number' ? ec : 1
  }
  return 1
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface RunFlags {
  readonly reviewRun: number
  readonly ide: string
  readonly ephemeral: boolean
  readonly configFile: string | undefined
}

export const executeRun = async (
  proxy: readonly string[],
  flags: RunFlags,
  cwd: string,
  reporter?: ProgressReporter,
): Promise<number> => {
  const rep = reporter ?? createProgressReporter(stderrSink, false)
  const outcome = await Effect.runPromise(
    Effect.either(
      runPipeline({
        argv: ['run', ...proxy],
        cwd,
        ...(flags.configFile === undefined ? {} : { configFile: flags.configFile }),
        reviewRun: flags.reviewRun,
        ide: flags.ide,
        ephemeral: flags.ephemeral,
        reporter: rep,
      }),
    ),
  )
  if (outcome._tag === 'Right') {
    // The run completed and a report was written, but an entire side's diff
    // came back with no usable patches (every run's worktree was broken) —
    // the comparison has nothing to show for that side, so a CI consumer
    // needs a non-zero exit even though nothing threw.
    return outcome.right.diffEscalated ? 1 : 0
  }
  const err = outcome.left
  rep.error(formatPhaseError(err))
  return exitCodeFromError(err)
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

interface ReviewFlags {
  readonly runId: string | undefined
  readonly reviewRun: number
  readonly ide: string
  readonly workspace: string
}

export const executeReview = async (flags: ReviewFlags): Promise<number> => {
  const found = await Effect.runPromise(findRun(flags.workspace, flags.runId))
  if (found === null) {
    console.error(`no run found in ${resolveWorkspace(flags.workspace)}${flags.runId === undefined ? '' : ` matching "${flags.runId}"`}`)
    return 1
  }
  const wsFile = path.join(found.resultsDir, 'review.code-workspace')
  const has = await Effect.runPromise(exists(wsFile))
  if (!has) {
    console.error(`no review.code-workspace at ${wsFile} (run \`testaipack run\` first)`)
    return 1
  }
  const bin = mapIdeToBinary(flags.ide)
  const child = spawn(bin, [wsFile], { detached: true, stdio: 'ignore' })
  const spawned = await new Promise<boolean>((resolve) => {
    child.once('error', () => {
      resolve(false)
    })
    child.once('spawn', () => {
      resolve(true)
    })
  })
  if (!spawned) {
    console.error(`failed to open ${wsFile}: could not launch "${bin}" (is it installed and on PATH?)`)
    return 1
  }
  child.unref()
  process.stdout.write(`opened ${wsFile} in ${bin}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export const executeReport = async (
  runId: string | undefined,
  workspace: string,
): Promise<number> => {
  const found = await Effect.runPromise(findRun(workspace, runId))
  if (found === null) {
    console.error(`no run found in ${resolveWorkspace(workspace)}`)
    return 1
  }
  const outcome = await Effect.runPromise(Effect.either(readReport(found.resultsDir)))
  if (outcome._tag === 'Left') {
    console.error(`cannot read report.json in ${found.resultsDir}: ${outcome.left._tag}`)
    return 1
  }
  const report = outcome.right
  if (report === null) {
    console.error(`no report.json in ${found.resultsDir}`)
    return 1
  }
  process.stdout.write(`${renderMd(report)}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// report --rebuild
// ---------------------------------------------------------------------------

const firstInvalidFormat = (raw: readonly string[]): string | undefined =>
  raw.find((f) => !outputFormatSchema.safeParse(f).success)

const toOutputFormats = (raw: readonly string[]): readonly OutputFormat[] =>
  raw.filter((f): f is OutputFormat => outputFormatSchema.safeParse(f).success)

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const padCol = (s: string, n: number): string =>
  s.length >= n ? s : `${s}${' '.repeat(n - s.length)}`

/** Total improvements/regressions across every non-baseline variant's bucket. */
const perVariantDeltaCounts = (summary: ReportSummary): { readonly imp: number; readonly reg: number } =>
  summary.perVariant.reduce(
    (acc, v) => ({ imp: acc.imp + v.improvements.length, reg: acc.reg + v.regressions.length }),
    { imp: 0, reg: 0 },
  )

export const executeList = async (workspace: string): Promise<number> => {
  const runs = await Effect.runPromise(listRuns(workspace))
  if (runs.length === 0) {
    process.stdout.write(`No runs found in ${resolveWorkspace(workspace)}.\n`)
    return 0
  }
  const rows = await Promise.all(
    runs.map(async (r) => {
      const rep = await Effect.runPromise(readReport(r.resultsDir)).then(
        (v) => v,
        () => null,
      )
      const counts = rep === null ? undefined : perVariantDeltaCounts(rep.summary)
      const pack = r.manifest.packs.map((p) => p.name).join(',') || '-'
      return {
        runId: r.runId,
        timestamp: r.timestamp,
        pack,
        delta: counts === undefined ? '-/-' : `${String(counts.imp)}/${String(counts.reg)}`,
      }
    }),
  )
  process.stdout.write(
    `${padCol('RUN-ID', 24)}  ${padCol('TIMESTAMP', 24)}  ${padCol('PACK', 20)}  ${padCol('IMP/REG', 8)}\n`,
  )
  for (const r of rows) {
    process.stdout.write(
      `${padCol(r.runId, 24)}  ${padCol(r.timestamp, 24)}  ${padCol(r.pack, 20)}  ${padCol(r.delta, 8)}\n`,
    )
  }
  return 0
}

// ---------------------------------------------------------------------------
// gc
// ---------------------------------------------------------------------------

interface GcFlags {
  readonly keepLast: number | undefined
  readonly olderThan: string | undefined
  readonly aggressive: boolean
  readonly workspace: string
}

export const executeGc = async (flags: GcFlags): Promise<number> => {
  const plan = await Effect.runPromise(
    planGc(flags.workspace, {
      ...(flags.keepLast === undefined ? {} : { keepLast: flags.keepLast }),
      ...(flags.olderThan === undefined ? {} : { olderThan: flags.olderThan }),
      ...(flags.aggressive ? { aggressive: true } : {}),
    }),
  )
  const result = await Effect.runPromise(executeGcPlan(plan))
  process.stdout.write(`Deleted ${String(result.deleted.length)} item(s).\n`)
  for (const d of result.deleted) {
    process.stdout.write(`  ${d}\n`)
  }
  if (result.deleted.length === 0) {
    process.stdout.write('Nothing to delete.\n')
  }
  return 0
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

// `pureBaseline` deliberately absent (02-phases.md "doctor / init"): it is a
// legacy-shim-only key, and the scaffold must stay usable the moment a user
// adds a `variants` block — with `pureBaseline` present that would instantly
// fail as `legacy-flag-with-variants`.
const DEFAULT_CONFIG = {
  runs: 3,
  isolation: 'home',
  formats: ['md'],
  preflightEnabled: true,
}

export const executeInit = async (workspace: string): Promise<number> => {
  const root = await Effect.runPromise(ensureWorkspace(workspace))
  const cfgPath = path.join(root, 'config.json')
  const hasCfg = await Effect.runPromise(exists(cfgPath))
  if (!hasCfg) {
    await Effect.runPromise(writeJson(cfgPath, DEFAULT_CONFIG))
  }
  const giPath = path.join(path.dirname(path.resolve(root)), '.gitignore')
  await Effect.runPromise(updateGitignore(giPath, `${path.basename(path.resolve(root))}/`))
  process.stdout.write(`Initialized testaipack workspace at ${root}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export const executeDoctor = async (cwd: string): Promise<number> => {
  const checks = await Effect.runPromise(runDoctor(cwd))
  process.stdout.write(`${padCol('STATUS', 8)}  ${padCol('CHECK', 22)}  DETAIL\n`)
  for (const c of checks) {
    process.stdout.write(`${padCol(c.status.toUpperCase(), 8)}  ${padCol(c.name, 22)}  ${c.detail}\n`)
  }
  return hasCriticalFailure(checks) ? 1 : 0
}

// ---------------------------------------------------------------------------
// clipanion command classes
// ---------------------------------------------------------------------------

const runUsage: Usage = {
  category: 'A/B testing',
  description: 'Run an A/B comparison of an opencode pack against a baseline.',
  details:
    'Clones the repo, installs the pack on the new side only, runs the prompt N times per side, collects metrics, and renders a comparison report.\n\n' +
    'Orchestrator-level flags, parsed ahead of phase 00: `--review-run <n>` (which run index to surface in `review`, default 1), `--ide vscode|cursor|code-insiders` (default vscode), `--ephemeral` (delete apps/, home/, gitdirs/ and pack/ after the run, keeps results/), `--config <path>` (path to a testaipack config.json).\n\n' +
    'See the full flag table below.',
  examples: [
    ['Minimal run', '$0 <repo> --pack <pack-ref> --prompt "implement feature X"'],
    ['Smoke test (no pack)', '$0 <repo> --prompt "do the thing"'],
  ],
}

// ---------------------------------------------------------------------------
// run --help flag table
//
// Flag names, value types and defaults are all read from phase 00's own
// VALUE_FLAGS/BOOLEAN_FLAGS tables and default constants (plus the generated
// enum schemas), so a flag added there without a matching row here still
// shows up — it just falls back to a generic description. Only the
// human-readable description text is a literal (natural-language strings
// cannot be derived from the flag tables), keyed by the same `dest` string
// VALUE_FLAGS/BOOLEAN_FLAGS already use.
// ---------------------------------------------------------------------------

interface FlagRow {
  readonly names: string
  readonly type: string
  readonly def: string
  readonly description: string
}

const FLAG_DESCRIPTIONS: Readonly<Record<string, string>> = {
  repoUrl: 'Git repository URL to run the A/B comparison against.',
  prompts: 'Prompt for the agent on the build side. Repeatable; @file reads the file content.',
  inits: 'Optional prompt run BEFORE --prompt in the same session (environment setup).',
  parallel: 'Max variants executed concurrently. Runs within one variant always stay sequential.',
  baseline: 'Name of the baseline variant that every other variant is compared against. Defaults to the first variant (`old` in the legacy two-sided shim).',
  hint: 'Text appended to every variant\'s task prompt, identically — e.g. "If the project contains a prepared code index in .graphify/, use it to navigate the code. If it is absent, work as usual." Write it as a conditional so a variant that finds nothing spends at most a couple of tool calls confirming that. Recorded in manifest.json/report. A variant\'s own `hint` field overrides this global.',
  initSide: 'Which side(s) receive --init text. `both` (default) is right for environment prep both sides need for a fair comparison; use `new` for a pack TRIGGER (e.g. a slash command) so the baseline stays unaware of the pack under test; `old` sends it to the baseline only.',
  verifies: 'Optional shell command run after the agent finishes (e.g. "npm test").',
  judges: 'Prompt for an LLM judge that scores the semantic diff between the two sides.',
  formats: 'Report formats to write. Repeatable, e.g. --format md --format html.',
  auth: `Add <kind> to the isolation whitelist (copies credentials into the isolated HOME). Repeatable. Use ${NO_AUTH_PREFIX}<kind> to remove a kind that is on by default.`,
  runs: 'Number of runs per side (the median is used for the comparison).',
  isolation: '`docker` runs opencode in a container; falls back to `home` when the daemon is unavailable.',
  dockerImage: 'Image for --isolation=docker. Ignored in `home` mode.',
  dockerNetwork: 'Network mode for --isolation=docker containers (e.g. `host`, so a container can reach a model server bound to the host loopback, like ollama). Unset keeps Docker\'s default bridge network. Linux-specific.',
  packRef: 'The pack under test: git URL, npm package, local path, or mcp:<name>:<config>.',
  packType: 'Override the auto-detected pack type.',
  timelineMode: 'How the timeline visualizes old vs new.',
  logLevel: 'Verbosity of testaipack\'s own output (not forwarded to opencode). `info` (default) is today\'s full output; `debug` is currently identical; `warn` drops progress lines but keeps warnings and the final result; `error` prints only a fatal error, nothing on success.',
  outputPath: 'Where report artifacts (report.*, metrics.json, timeline.*, diff/, ...) are written.',
  workspacePath: 'Root of the testaipack working tree.',
  opencodeVersion: 'Skip the opencode --version auto-check and use this string as the version label in the manifest and report. Does not select, install, or pin which opencode binary runs.',
  preflightModel: 'Model for the LLM judge only. The pre-flight auth-ping and the run itself both use --model instead.',
  model: 'Model for the run itself, applied identically to both sides.',
  pricingPath: 'Custom pricing table (USD per 1M tokens). The built-in table is used otherwise.',
  packSetup: 'Shell command that installs the pack\'s runtime into $HOME. Runs once for the whole experiment, then the resulting HOME is copied to every new-side run.',
  packCheck: 'Shell command that exits 0 iff the pack\'s runtime is functional. Runs in every new HOME (must pass) and every old HOME (must fail, unless --allow-baseline-tool).',
  packExercise: 'Shell command that runs the pack\'s own pipeline, once per new-side run, before the agent session starts. Absent -> mode `installed-only` (not an error) when the pack has nothing runnable.',
  packHint: 'Deprecated alias for --hint, kept for existing scripts. Same effect: sets the global hint appended to every variant\'s task prompt.',
  preflightSeconds: 'Timeout for the pre-flight stage (seconds).',
  runSeconds: 'Timeout for a single agent run (seconds).',
  verifySeconds: 'Timeout for the --verify command (seconds).',
  installSeconds: 'Timeout for pack installation (seconds).',
  watchdogSeconds: 'A run is considered hung if there is no output for this many seconds.',
  totalSeconds: 'Overall run timeout (seconds), on top of the other timeouts.',
  pureBaseline: 'Legacy two-sided shim only. Run the old (baseline) side with --pure (no third-party plugins/skills besides the pack under test). The new side is never pure, or the pack under test would not load. --no-pure-baseline genuinely disables purity on the baseline (prints a one-line notice).',
  preflightEnabled: 'Pre-flight stage (model ping, pack check).',
  diffHtml: 'Generate an HTML side-by-side diff.',
  protectGit: 'Keeps each run\'s git dir outside the workspace so the agent cannot delete it; costs you opencode\'s snapshot/patch export parts, which need /workspace/.git (exports get poorer). Weak under --isolation home (agent can still reach it). Default: off.',
  collapseRepeats: 'Collapse consecutive identical tool-call sequences in the timeline.',
  allowBaselineTool: 'Override gate 6: do not hard-fail when --pack-check already passes on the old (baseline) side. Off by default — a baseline that already has the dependency produces a meaningless comparison.',
}

const enumChoices = (schema: { readonly options: readonly string[] }): string => schema.options.join('|')

const namesForValueDest = (dest: string): string =>
  Object.entries(VALUE_FLAGS)
    .filter(([, d]) => d === dest)
    .map(([name]) => name)
    .join(', ')

const onOffAuthKeys = (): { readonly on: readonly string[]; readonly off: readonly string[] } => {
  const entries = Object.entries(DEFAULT_AUTH)
  return {
    on: entries.filter(([, v]) => v).map(([k]) => k),
    off: entries.filter(([, v]) => !v).map(([k]) => k),
  }
}

const timeoutDefault = (dest: string): number | undefined => {
  if (dest === 'preflightSeconds') return DEFAULT_TIMEOUTS.preflightSeconds
  if (dest === 'runSeconds') return DEFAULT_TIMEOUTS.runSeconds
  if (dest === 'verifySeconds') return DEFAULT_TIMEOUTS.verifySeconds
  if (dest === 'installSeconds') return DEFAULT_TIMEOUTS.installSeconds
  if (dest === 'watchdogSeconds') return DEFAULT_TIMEOUTS.watchdogSeconds
  if (dest === 'totalSeconds') return DEFAULT_TIMEOUTS.totalSeconds
  return undefined
}

// `InitSide` no longer exists on the wire (contract barrier) — `--init-side`
// is a legacy-shim-only CLI concept, so its choices are listed by hand here
// rather than read off a generated enum schema.
const LEGACY_INIT_SIDE_CHOICES = 'both|old|new'

const valueFlagType = (dest: string): string => {
  if (dest === 'isolation') return enumChoices(isolationModeSchema)
  if (dest === 'packType') return enumChoices(packTypeSchema)
  if (dest === 'timelineMode') return enumChoices(timelineModeSchema)
  if (dest === 'initSide') return LEGACY_INIT_SIDE_CHOICES
  if (dest === 'logLevel') return enumChoices(logLevelSchema)
  if (dest === 'formats') return `${enumChoices(outputFormatSchema)} (repeatable)`
  if (dest === 'auth') return `${[...AUTH_KEYS].join('|')} (repeatable)`
  if (dest === 'runs' || dest === 'parallel' || TIMEOUT_KEYS.has(dest)) return 'int'
  return 'string'
}

const valueFlagDefault = (dest: string): string => {
  if (dest === 'runs') return String(DEFAULT_RUNS)
  if (dest === 'parallel') return String(DEFAULT_PARALLEL)
  if (dest === 'baseline') return 'first variant (`old` in the legacy shim)'
  if (dest === 'isolation') return DEFAULT_ISOLATION
  if (dest === 'packType') return 'auto (from --pack)'
  if (dest === 'timelineMode') return DEFAULT_TIMELINE_MODE
  if (dest === 'initSide') return DEFAULT_INIT_SIDE
  if (dest === 'logLevel') return DEFAULT_LOG_LEVEL
  if (dest === 'outputPath') return DEFAULT_OUTPUT_PATH
  if (dest === 'workspacePath') return DEFAULT_WORKSPACE_PATH
  if (dest === 'dockerImage') return DEFAULT_OPENCODE_IMAGE
  if (dest === 'formats') return DEFAULT_FORMATS.join(', ')
  if (dest === 'auth') {
    const { on } = onOffAuthKeys()
    return `${on.join(',')} = on; rest off`
  }
  if (TIMEOUT_KEYS.has(dest)) {
    const val = timeoutDefault(dest)
    return val === undefined ? '— (unlimited)' : String(val)
  }
  return '—'
}

const BOOLEAN_KEY_ORDER: readonly RunBooleanKey[] = [
  'pureBaseline', 'preflightEnabled', 'diffHtml', 'collapseRepeats', 'protectGit', 'allowBaselineTool',
]

const BOOLEAN_DEFAULTS: Readonly<Record<RunBooleanKey, boolean>> = {
  pureBaseline: DEFAULT_PURE_BASELINE,
  preflightEnabled: DEFAULT_PREFLIGHT_ENABLED,
  diffHtml: DEFAULT_DIFF_HTML,
  collapseRepeats: DEFAULT_COLLAPSE_REPEATS,
  protectGit: DEFAULT_PROTECT_GIT,
  allowBaselineTool: DEFAULT_ALLOW_BASELINE_TOOL,
}

const namesForBooleanKey = (key: RunBooleanKey, value: boolean): string =>
  Object.entries(BOOLEAN_FLAGS)
    .filter(([, b]) => b.key === key && b.value === value)
    .map(([name]) => name)
    .join(', ')

const ORCHESTRATOR_FLAG_ROWS: readonly FlagRow[] = [
  {
    names: '--review-run',
    type: 'int',
    def: '1',
    description: 'Which run index (1-based) to surface in `review`.',
  },
  {
    names: '--ide',
    type: 'vscode|cursor|code-insiders',
    def: 'vscode',
    description: 'Editor used by `review`.',
  },
  {
    names: '--ephemeral',
    type: 'flag',
    def: 'off',
    description: 'Delete apps/, home/, gitdirs/ and pack/ after the run (keeps results/).',
  },
  {
    names: '--config',
    type: 'string',
    def: '—',
    description: 'Path to a testaipack config.json (CLI flags still win over it).',
  },
]

const REPO_POSITIONAL_ROW: FlagRow = {
  names: '<repo>',
  type: 'string',
  def: '— (required; positional, or repoUrl in config.json)',
  description: 'Git repository URL for the A/B run.',
}

const buildValueFlagRows = (): readonly FlagRow[] =>
  [...new Set(Object.values(VALUE_FLAGS))].map((dest) => ({
    names: namesForValueDest(dest),
    type: valueFlagType(dest),
    def: valueFlagDefault(dest),
    description: FLAG_DESCRIPTIONS[dest] ?? '(no description yet)',
  }))

const buildBooleanFlagRows = (): readonly FlagRow[] =>
  BOOLEAN_KEY_ORDER.map((key) => ({
    names: `${namesForBooleanKey(key, true)}, ${namesForBooleanKey(key, false)}`,
    type: 'flag',
    def: BOOLEAN_DEFAULTS[key] ? 'on' : 'off',
    description: FLAG_DESCRIPTIONS[key] ?? '(no description yet)',
  }))

const renderFlagRow = (r: FlagRow): string =>
  `  ${r.names}\n      ${r.type}, default: ${r.def}\n      ${r.description}`

const renderRunFlagTable = (): string =>
  [
    'Orchestrator flags (parsed before phase 00, by splitRunFlags):',
    '',
    ...ORCHESTRATOR_FLAG_ROWS.map(renderFlagRow),
    '',
    'Run configuration flags (phase 00):',
    '',
    renderFlagRow(REPO_POSITIONAL_ROW),
    ...buildValueFlagRows().map(renderFlagRow),
    ...buildBooleanFlagRows().map(renderFlagRow),
  ].join('\n')

interface RunFlagState {
  readonly reviewRun: string
  readonly ide: string
  readonly ephemeral: boolean
  readonly configFile: string | undefined
  readonly rest: readonly string[]
  readonly error: string | undefined
}

const RUN_FLAG_STATE_DEFAULTS: RunFlagState = {
  reviewRun: '1',
  ide: 'vscode',
  ephemeral: false,
  configFile: undefined,
  rest: [],
  error: undefined,
}

export interface RunFlagSplit {
  readonly flags: RunFlags
  readonly rest: readonly string[]
  readonly error: string | undefined
}

const splitRunFlagsLoop = (tokens: readonly string[], i: number, acc: RunFlagState): RunFlagState => {
  if (i >= tokens.length || acc.error !== undefined) return acc
  const tok = tokens[i] ?? ''
  const eq = tok.indexOf('=')
  const name = eq >= 0 ? tok.slice(0, eq) : tok
  const inline = eq >= 0 ? tok.slice(eq + 1) : undefined

  if (name === '--ephemeral') return splitRunFlagsLoop(tokens, i + 1, { ...acc, ephemeral: true })
  if (name === '--no-ephemeral') return splitRunFlagsLoop(tokens, i + 1, { ...acc, ephemeral: false })

  if (name === '--review-run' || name === '--ide' || name === '--config') {
    const value = inline ?? tokens[i + 1]
    if (value === undefined || value.startsWith('-')) {
      return { ...acc, error: `${name} requires a value` }
    }
    const next: RunFlagState =
      name === '--review-run'
        ? { ...acc, reviewRun: value }
        : name === '--ide'
          ? { ...acc, ide: value }
          : { ...acc, configFile: value }
    return splitRunFlagsLoop(tokens, inline !== undefined ? i + 1 : i + 2, next)
  }

  return splitRunFlagsLoop(tokens, i + 1, { ...acc, rest: [...acc.rest, tok] })
}

/**
 * Pulls `--review-run`, `--ide`, `--ephemeral`/`--no-ephemeral` and `--config`
 * out of the raw `run` proxy tokens (order-independent), leaving the rest
 * (repoUrl positional + phase-00 flags) untouched for `cliParse`.
 */
export const splitRunFlags = (tokens: readonly string[]): RunFlagSplit => {
  const state = splitRunFlagsLoop(tokens, 0, RUN_FLAG_STATE_DEFAULTS)
  const baseFlags: RunFlags = {
    reviewRun: 1,
    ide: state.ide,
    ephemeral: state.ephemeral,
    configFile: state.configFile,
  }
  if (state.error !== undefined) {
    return { flags: baseFlags, rest: state.rest, error: state.error }
  }
  const reviewRun = parseRunIndex(state.reviewRun)
  if (reviewRun === undefined) {
    return {
      flags: baseFlags,
      rest: state.rest,
      error: `--review-run must be a positive integer, got: ${state.reviewRun}`,
    }
  }
  return { flags: { ...baseFlags, reviewRun }, rest: state.rest, error: undefined }
}

class RunCommand extends Command {
  static override paths = [['run'], Command.Default]
  static override usage = Command.Usage(runUsage)

  proxy = Option.Proxy({ required: 0 })

  async execute(): Promise<number> {
    const { flags, rest, error } = splitRunFlags(this.proxy)
    if (error !== undefined) {
      console.error(error)
      return 2
    }
    return executeRun(rest, flags, process.cwd())
  }
}

class ReviewCommand extends Command {
  static override paths = [['review']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'Open a run in a multi-root VSCode workspace (old / new / pack).',
  })
  runId = Option.String({ required: false, name: 'run-id' })
  reviewRun = Option.String('--review-run', '1', {
    description: 'Which run index (1-based) to open.',
  })
  ide = Option.String('--ide', 'vscode', {
    description: 'Editor: vscode | cursor | code-insiders.',
  })
  workspace = Option.String('--workspace', '.testaipack', {
    description: 'Root of the testaipack workspace.',
  })

  async execute(): Promise<number> {
    const reviewRun = parseRunIndex(this.reviewRun)
    if (reviewRun === undefined) {
      console.error(`invalid --review-run: ${this.reviewRun} (expected a positive integer)`)
      return 2
    }
    return executeReview({
      runId: this.runId,
      reviewRun,
      ide: this.ide,
      workspace: this.workspace,
    })
  }
}

class ReportCommand extends Command {
  static override paths = [['report']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'Re-print a run report as Markdown to stdout.',
    details:
      '`--rebuild` recomputes the report from artifacts already on disk (aggregate, diff, timeline, report-render) instead of re-printing `report.json` — no agent, LLM, or docker call is made by default, and an existing judge verdict is reused verbatim rather than re-requested. For a workspace that predates `run-input.json`, unrecoverable inputs are supplied via `--format`/`--judge`/`--pricing-path`/`--diff-html`/`--collapse-repeats`/`--timeline-mode`, or otherwise fall back to a default disclosed in the rebuilt report. `--rejudge` is the one opt-in exception to the no-LLM rule: it permits exactly one fresh judge call against the rebuilt diff, using `--judge` as the instructions (falling back to the original run-input.json instructions when not given); the report then states the verdict came from a re-judge, not the original run.',
  })
  runId = Option.String({ required: false, name: 'run-id' })
  workspace = Option.String('--workspace', '.testaipack', {
    description: 'Root of the testaipack workspace.',
  })
  rebuild = Option.Boolean('--rebuild', false, {
    description: 'Recompute the report from disk artifacts instead of re-printing report.json.',
  })
  force = Option.Boolean('--force', false, {
    description: '--rebuild only: overwrite an existing report.json.',
  })
  format = Option.Array('--format', [], {
    description: '--rebuild only: report format(s), used when not recoverable from run-input.json. Repeatable.',
  })
  judge = Option.String('--judge', {
    required: false,
    description:
      '--rebuild only: disclosure-only hint for whether/how judging was originally requested. Without --rejudge, rebuild never invokes an LLM and this never produces a verdict; with --rejudge, this becomes the instructions for the one permitted judge call.',
  })
  rejudge = Option.Boolean('--rejudge', false, {
    description:
      '--rebuild only: the one opt-in exception to "rebuild invokes no LLM" — permits exactly one live judge call against the rebuilt diff. Off by default.',
  })
  pricingPath = Option.String('--pricing-path', {
    required: false,
    description: '--rebuild only: pricing table, used when not recoverable from run-input.json.',
  })
  diffHtml = Option.Boolean('--diff-html', {
    required: false,
    description: '--rebuild only: generate diff/*.html, used when not recoverable from run-input.json.',
  })
  collapseRepeats = Option.Boolean('--collapse-repeats', {
    required: false,
    description: '--rebuild only: collapse repeated tool calls in the timeline, used when not recoverable.',
  })
  timelineMode = Option.String('--timeline-mode', {
    required: false,
    description: '--rebuild only: side-by-side|tree-diff|merged, used when not recoverable.',
  })

  async execute(): Promise<number> {
    if (!this.rebuild) return executeReport(this.runId, this.workspace)

    const invalidFormat = firstInvalidFormat(this.format)
    if (invalidFormat !== undefined) {
      console.error(`invalid --format: ${invalidFormat} (expected md|html|json|yaml)`)
      return 2
    }
    if (this.timelineMode !== undefined && !timelineModeSchema.safeParse(this.timelineMode).success) {
      console.error(`invalid --timeline-mode: ${this.timelineMode} (expected side-by-side|tree-diff|merged)`)
      return 2
    }

    const flags: RebuildFlags = {
      runId: this.runId,
      workspace: this.workspace,
      force: this.force,
      formats: toOutputFormats(this.format),
      judge: this.judge,
      rejudge: this.rejudge,
      pricingPath: this.pricingPath,
      diffHtml: this.diffHtml,
      collapseRepeats: this.collapseRepeats,
      timelineMode: this.timelineMode as TimelineMode | undefined,
    }
    return executeRebuild(flags)
  }
}

class ListCommand extends Command {
  static override paths = [['list']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'List all runs in the workspace.',
  })
  workspace = Option.String('--workspace', '.testaipack', {
    description: 'Root of the testaipack workspace.',
  })

  async execute(): Promise<number> {
    return executeList(this.workspace)
  }
}

class GcCommand extends Command {
  static override paths = [['gc']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'Garbage-collect old runs from the workspace.',
    details:
      '`--keep-last N` keeps only the N most recent runs. `--older-than 7d` removes runs older than the duration. `--aggressive` also prunes home/, apps/ and gitdirs/ from the surviving runs.',
  })
  keepLast = Option.String('--keep-last', { description: 'Keep only the N most recent runs.' })
  olderThan = Option.String('--older-than', { description: 'Duration, e.g. 7d / 12h.' })
  aggressive = Option.Boolean('--aggressive', false, {
    description: 'Also prune home/ and apps/ from the surviving runs.',
  })
  workspace = Option.String('--workspace', '.testaipack', {
    description: 'Root of the testaipack workspace.',
  })

  async execute(): Promise<number> {
    const keepLast =
      this.keepLast === undefined ? undefined : parseNonNegativeInt(this.keepLast)
    if (this.keepLast !== undefined && keepLast === undefined) {
      console.error(`invalid --keep-last: ${this.keepLast} (expected a non-negative integer)`)
      return 2
    }
    if (this.olderThan !== undefined && parseOlderThan(this.olderThan) === null) {
      console.error(`invalid --older-than: ${this.olderThan} (expected e.g. 7d, 12h, 30m)`)
      return 2
    }
    return executeGc({
      keepLast,
      olderThan: this.olderThan,
      aggressive: this.aggressive,
      workspace: this.workspace,
    })
  }
}

// D9: `--perspective` is kept as a hidden legacy alias for `--variant`, whose
// old 4-value enum maps onto the new name|'best' selector. Validated locally
// (not via a compare.ts export) so this table survives WP14 renaming/removing
// whatever `ComparePerspective`-shaped exports compare.ts used to have.
const LEGACY_PERSPECTIVE_TO_VARIANT: Readonly<Record<string, string>> = {
  'new-vs-new': 'new',
  'old-vs-old': 'old',
  best: 'best',
  auto: 'best',
}

export const resolveVariantSelector = (
  variantFlag: string,
  perspectiveFlag: string | undefined,
): string =>
  perspectiveFlag === undefined ? variantFlag : (LEGACY_PERSPECTIVE_TO_VARIANT[perspectiveFlag] ?? perspectiveFlag)

class CompareCommand extends Command {
  static override paths = [['compare']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'Compare two runs side by side (cross-run A/B).',
    details:
      'Compares a chosen variant of run-id-1 against a chosen variant of run-id-2 (run 1\'s selection plays the baseline role). `--variant <name>` selects a variant by name on BOTH runs; `best` (default) picks the variant with the higher median successRank. `--variant2 <name>` overrides run 2\'s selection independently — needed when the two runs use different variant name sets (e.g. comparing a v1 report, which only has old/new, against a v2 report with arbitrary names). `--perspective` is kept as a hidden legacy alias, applied symmetrically to both: `new-vs-new` -> `new`, `old-vs-old` -> `old`, `best`/`auto` -> `best`. `--format md|json` selects the output.',
    examples: [
      ['Pack then vs now', '$0 compare <run-id-1> <run-id-2> --variant new'],
      ['Cross-name compare', '$0 compare <run-id-1> <run-id-2> --variant new --variant2 b'],
      ['JSON output', '$0 compare <run-id-1> <run-id-2> --format json'],
    ],
  })

  runId1 = Option.String({ required: true, name: 'run-id-1' })
  runId2 = Option.String({ required: true, name: 'run-id-2' })
  variant = Option.String('--variant', 'best', {
    description: 'Variant name to compare on both runs, or `best` (highest median successRank).',
  })
  variant2 = Option.String('--variant2', {
    required: false,
    description: 'Override run 2\'s variant selection independently of --variant (defaults to whatever --variant/--perspective resolved to).',
  })
  perspective = Option.String('--perspective', {
    required: false,
    hidden: true,
    description: 'Deprecated alias for --variant (applied to both runs): new-vs-new|old-vs-old|best|auto.',
  })
  format = Option.String('--format', 'md', {
    description: 'md | json.',
  })
  workspace = Option.String('--workspace', '.testaipack', {
    description: 'Root of the testaipack workspace.',
  })

  async execute(): Promise<number> {
    const format = this.format
    if (!isCompareFormat(format)) {
      console.error(`invalid --format: ${format} (expected md|json)`)
      return 2
    }
    if (this.perspective !== undefined && LEGACY_PERSPECTIVE_TO_VARIANT[this.perspective] === undefined) {
      console.error(
        `invalid --perspective: ${this.perspective} (expected new-vs-new|old-vs-old|best|auto)`,
      )
      return 2
    }
    const variant1 = resolveVariantSelector(this.variant, this.perspective)
    const variant2 = this.variant2 ?? variant1
    if (!isVariantSelector(variant1)) {
      console.error(`invalid --variant: ${variant1} (expected a variant name or "best")`)
      return 2
    }
    if (!isVariantSelector(variant2)) {
      console.error(`invalid --variant2: ${variant2} (expected a variant name or "best")`)
      return 2
    }
    return executeCompare({
      runId1: this.runId1,
      runId2: this.runId2,
      variant1,
      variant2,
      format,
      workspace: this.workspace,
    })
  }
}

class InitCommand extends Command {
  static override paths = [['init']]
  static override usage = Command.Usage({
    category: 'Setup',
    description: 'Initialize the testaipack workspace (.testaipack/).',
  })
  workspace = Option.String('--workspace', '.testaipack', {
    description: 'Root of the testaipack workspace.',
  })

  async execute(): Promise<number> {
    return executeInit(this.workspace)
  }
}

class DoctorCommand extends Command {
  static override paths = [['doctor']]
  static override usage = Command.Usage({
    category: 'Setup',
    description: 'Check that opencode, git, node and docker are available (bun is optional — only needed to build from source).',
  })

  async execute(): Promise<number> {
    return executeDoctor(process.cwd())
  }
}

// ---------------------------------------------------------------------------
// entrypoint
// ---------------------------------------------------------------------------

const COMMANDS: CommandClass[] = [
  RunCommand,
  ReviewCommand,
  ReportCommand,
  CompareCommand,
  ListCommand,
  GcCommand,
  InitCommand,
  DoctorCommand,
  Builtins.HelpCommand,
]

export const buildCli = (): Cli => Cli.from(COMMANDS, { binaryName: BINARY_NAME })

export async function runCli(argv: readonly string[]): Promise<number> {
  // Handle --version early so it works for every command (including the
  // default `run` proxy, which would otherwise reject it as an unknown flag).
  if (argv.includes('--version') || (argv.length === 1 && argv[0] === '-v')) {
    process.stdout.write(`${BINARY_NAME} ${BINARY_VERSION}\n`)
    return 0
  }
  const cli = buildCli()
  const head = argv[0]
  if (argv.length === 0 || head === 'help') {
    process.stdout.write(`${cli.usage(null)}\n`)
    return 0
  }
  if (head === 'run' && (argv.includes('-h') || argv.includes('--help'))) {
    const clipanionUsage = cli.usage(RunCommand, { detailed: true })
    process.stdout.write(`${clipanionUsage}\n\n${renderRunFlagTable()}\n`)
    return 0
  }
  return cli.run([...argv])
}
