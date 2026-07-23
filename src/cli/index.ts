/**
 * CLI entrypoint: parses argv with clipanion and dispatches to the phase
 * pipeline. Commands: `run` (default), `review`, `report`, `list`, `gc`,
 * `init`, `doctor`.
 *
 * The `run` command forwards its raw trailing tokens (`Option.Proxy`) to phase
 * 00 (cli-parse), which owns flag parsing for the A/B run. Clipanion only
 * consumes the handful of flags that are orchestrator-level (not phase-00):
 * `--review-run`, `--ide`, `--ephemeral`, `--config`.
 *
 * @see docs/phases/00-cli-parse.ru.md
 */
import { Cli, Command, Builtins, Option } from 'clipanion'
import type { CommandClass, Usage } from 'clipanion'
import { Effect } from 'effect'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runPipeline } from './pipeline.js'
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
} from './workspace-runs.js'
import { runDoctor, hasCriticalFailure } from './doctor.js'
import { exists, writeJson } from '../util/fs.js'
import { mapIdeToBinary } from '../phases/12-review-workspace.js'
import { renderMd } from '../report/md.js'
import { PhaseError } from '../errors.js'

const BINARY_NAME = 'testaipack'

const parseRunIndex = (s: string): number => {
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
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

interface RunFlags {
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
    return 0
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
  const report = await Effect.runPromise(readReport(found.resultsDir))
  if (report === null) {
    console.error(`no report.json in ${found.resultsDir}`)
    return 1
  }
  process.stdout.write(`${renderMd(report)}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const padCol = (s: string, n: number): string =>
  s.length >= n ? s : `${s}${' '.repeat(n - s.length)}`

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
      const imp = rep === null ? '-' : String(rep.summary.improvements.length)
      const reg = rep === null ? '-' : String(rep.summary.regressions.length)
      return {
        runId: r.runId,
        timestamp: r.timestamp,
        pack: r.manifest.packRef ?? '-',
        delta: `${imp}/${reg}`,
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

const DEFAULT_CONFIG = {
  runs: 3,
  isolation: 'home',
  formats: ['md'],
  pureBaseline: true,
  preflightEnabled: true,
}

const GITIGNORE_LINE = '.testaipack/'

const updateGitignore = async (projectRoot: string): Promise<void> => {
  const giPath = path.join(projectRoot, '.gitignore')
  const { readFile, writeFile, exists: existsFn } = await import('../util/fs.js')
  const has = await Effect.runPromise(existsFn(giPath))
  if (has) {
    const content = await Effect.runPromise(readFile(giPath))
    if (content.split('\n').includes(GITIGNORE_LINE)) return
    const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n'
    await Effect.runPromise(writeFile(giPath, `${content}${sep}${GITIGNORE_LINE}\n`))
    return
  }
  await Effect.runPromise(writeFile(giPath, `${GITIGNORE_LINE}\n`))
}

export const executeInit = async (workspace: string): Promise<number> => {
  const root = await Effect.runPromise(ensureWorkspace(workspace))
  const cfgPath = path.join(root, 'config.json')
  const hasCfg = await Effect.runPromise(exists(cfgPath))
  if (!hasCfg) {
    await Effect.runPromise(writeJson(cfgPath, DEFAULT_CONFIG))
  }
  await updateGitignore(path.dirname(path.resolve(root)))
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
    'Clones the repo, installs the pack on the new side only, runs the prompt N times per side, collects metrics, and renders a comparison report. All phase-00 flags (--pack, --prompt, --runs, --workspace, ...) are forwarded to the parser. See `testaipack --help` for the full flag table.',
  examples: [
    ['Minimal run', '$0 <repo> --pack <pack-ref> --prompt "implement feature X"'],
    ['Smoke test (no pack)', '$0 <repo> --prompt "do the thing"'],
  ],
}

class RunCommand extends Command {
  static override paths = [['run'], Command.Default]
  static override usage = Command.Usage(runUsage)

  reviewRun = Option.String('--review-run', '1', {
    description: 'Which run index (1-based) to surface in `review`.',
  })
  ide = Option.String('--ide', 'vscode', {
    description: 'Editor for `review`: vscode | cursor | code-insiders.',
  })
  ephemeral = Option.Boolean('--ephemeral', false, {
    description: 'Delete apps/, home/ and pack/ after the run (keeps results/).',
  })
  configFile = Option.String('--config', {
    description: 'Path to a testaipack config.json.',
  })
  proxy = Option.Proxy({ required: 0 })

  async execute(): Promise<number> {
    return executeRun(
      this.proxy,
      {
        reviewRun: parseRunIndex(this.reviewRun),
        ide: this.ide,
        ephemeral: this.ephemeral,
        configFile: this.configFile,
      },
      process.cwd(),
    )
  }
}

class ReviewCommand extends Command {
  static override paths = [['review']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'Open a run in a multi-root VSCode workspace (old / new / pack).',
  })
  runId = Option.String({ required: false, name: 'run-id' })
  reviewRun = Option.String('--review-run', '1')
  ide = Option.String('--ide', 'vscode')
  workspace = Option.String('--workspace', '.testaipack')

  async execute(): Promise<number> {
    return executeReview({
      runId: this.runId,
      reviewRun: parseRunIndex(this.reviewRun),
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
  })
  runId = Option.String({ required: false, name: 'run-id' })
  workspace = Option.String('--workspace', '.testaipack')

  async execute(): Promise<number> {
    return executeReport(this.runId, this.workspace)
  }
}

class ListCommand extends Command {
  static override paths = [['list']]
  static override usage = Command.Usage({
    category: 'Results',
    description: 'List all runs in the workspace.',
  })
  workspace = Option.String('--workspace', '.testaipack')

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
      '`--keep-last N` keeps only the N most recent runs. `--older-than 7d` removes runs older than the duration. `--aggressive` also prunes home/ and apps/ from the surviving runs.',
  })
  keepLast = Option.String('--keep-last', { description: 'Keep only the N most recent runs.' })
  olderThan = Option.String('--older-than', { description: 'Duration, e.g. 7d / 12h.' })
  aggressive = Option.Boolean('--aggressive', false)
  workspace = Option.String('--workspace', '.testaipack')

  async execute(): Promise<number> {
    return executeGc({
      keepLast: this.keepLast === undefined ? undefined : Number.parseInt(this.keepLast, 10),
      olderThan: this.olderThan,
      aggressive: this.aggressive,
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
  workspace = Option.String('--workspace', '.testaipack')

  async execute(): Promise<number> {
    return executeInit(this.workspace)
  }
}

class DoctorCommand extends Command {
  static override paths = [['doctor']]
  static override usage = Command.Usage({
    category: 'Setup',
    description: 'Check that opencode, git, node and bun are available.',
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
  ListCommand,
  GcCommand,
  InitCommand,
  DoctorCommand,
  Builtins.HelpCommand,
]

export const buildCli = (): Cli => Cli.from(COMMANDS, { binaryName: BINARY_NAME })

export async function runCli(argv: readonly string[]): Promise<number> {
  const cli = buildCli()
  const head = argv[0]
  if (argv.length === 0 || head === 'help') {
    process.stdout.write(`${cli.usage(null)}\n`)
    return 0
  }
  if (head === 'run' && (argv.includes('-h') || argv.includes('--help'))) {
    process.stdout.write(`${cli.usage(RunCommand, { detailed: true })}\n`)
    return 0
  }
  return cli.run([...argv])
}
