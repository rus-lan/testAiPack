/**
 * Metrics: baseline contamination — detects observable signs that the
 * BASELINE side (`old` — see 07-aggregate.ts's "the pack is only ever
 * installed on the new side" convention) acquired or used the pack under
 * test. If it did, the whole A/B comparison is silently invalid: both sides
 * end up testing "with pack", and every delta in the report compares two
 * contaminated runs instead of a baseline against a treatment.
 *
 * This is a heuristic tripwire over observable actions in artifacts already
 * captured (tool calls, bash commands, the config-capture drift snapshot) —
 * it is not proof and not exhaustive. A pack acquired through a route that
 * leaves no trace here (content copied into the repo by hand before the
 * run, a network install whose command text never mentions the pack's
 * resolved name) will not be caught. Report wording states what was
 * OBSERVED, not that the run is invalid — a human still makes that call.
 */
import type { ContaminationSignal, ExportToolPart } from '@generated/types'
import { isRecord } from '../util/types.js'
import { skipPrefix, splitSegments, tokenize } from './risky-commands.js'

/**
 * `runIndex` is absent from every signal this module produces — it names
 * which run a signal came from, and this module only ever sees one run's
 * tools/inventory at a time. The caller (`metrics/aggregate.ts`) attaches it
 * once signals are zipped against their run indexes; the `install-drift`
 * signal stays without one since it is side-level, not per-run.
 */
export type UnindexedSignal = Omit<ContaminationSignal, 'runIndex'>

const isSuccessfulSkillCall = (p: ExportToolPart, packName: string): boolean =>
  p.tool === 'skill' &&
  p.state.status === 'completed' &&
  isRecord(p.state.input) &&
  p.state.input['name'] === packName

/**
 * An unbounded substring match on the pack name is too loose: dogfooding a
 * pack against its own repo (`git add src/graphify/x.ts`) or a coincidental
 * name overlap (pack `graph`, command `npm install graphql`) both used to
 * fire the full contamination alert on an actually-clean baseline. Matching
 * requires the pack name to be a whole TOKEN (bare, `@scope/name`,
 * `name@version`, or a path ending in `/name` — the pack's own binary form
 * seen in the real incident, `$NPM_GLOBAL_PATH/graphify`), not a substring
 * inside an unrelated word or path.
 */
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3', 'bun'])
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'add'])

/** Strips a trailing `@version`, a leading `@scope/`, then any path prefix, and compares the bare name. */
const tokenNamesPack = (token: string, packName: string): boolean => {
  const noVersion = token.replace(/@[^/@]+$/, '')
  const noScope = noVersion.replace(/^@[^/]+\//, '')
  const bare = noScope.replace(/^.*\//, '')
  return bare.toLowerCase() === packName.toLowerCase()
}

/**
 * Two shapes count as "installed it": a known package manager's
 * install/add subcommand naming the pack (`npm install @scope/pack`), or
 * the pack's own binary invoked with an `install` subcommand (`pack
 * install ...`, `/path/to/pack install ...`). A plain lookup (`npm search`,
 * `which`, `--help`) matches neither — under-detection here is deliberate:
 * those commands alone do not show the pack was ACQUIRED, only searched for.
 */
const isInstallShapedSegment = (tokens: readonly string[], packName: string): boolean => {
  const cmd = skipPrefix(tokens)
  const first = cmd[0]
  if (first === undefined) return false
  if (PACKAGE_MANAGERS.has(first)) {
    return cmd.some((t) => INSTALL_SUBCOMMANDS.has(t)) && cmd.some((t) => tokenNamesPack(t, packName))
  }
  if (tokenNamesPack(first, packName)) {
    return cmd.includes('install')
  }
  return false
}

export const isInstallShapedCommand = (command: string, packName: string): boolean =>
  packName !== '' && splitSegments(command).some((seg) => isInstallShapedSegment(tokenize(seg), packName))

const DETAIL_MAX = 300

/**
 * Per-run signals from one export's tool calls: a `skill` call that
 * succeeded for the pack's resolved name (on a baseline it should fail with
 * "not found" — succeeding means the pack is actually reachable there), or
 * a bash command that looks like it installed the pack.
 */
export const findPackActivitySignals = (
  tools: readonly ExportToolPart[],
  packName: string | undefined,
): readonly UnindexedSignal[] => {
  if (packName === undefined || packName === '') return []
  return tools.flatMap((p): readonly UnindexedSignal[] => {
    if (isSuccessfulSkillCall(p, packName)) {
      return [{ kind: 'skill-call', detail: `skill tool call succeeded for "${packName}"` }]
    }
    if (p.tool === 'bash' && isRecord(p.state.input)) {
      const command = p.state.input['command']
      if (typeof command === 'string' && isInstallShapedCommand(command, packName)) {
        return [{ kind: 'bash-install', detail: command.slice(0, DETAIL_MAX) }]
      }
    }
    return []
  })
}

/**
 * Shape of `config/.config/opencode/<side>/installed.json` (phase 06) that
 * this module cares about — the file has no contract schema of its own (it
 * is a disk artifact, not part of the Report contract), so this is parsed
 * defensively rather than validated against a generated type.
 */
export interface InstalledInventorySnapshot {
  readonly identicalAcrossRuns: boolean
  readonly driftFiles: readonly string[]
}

/** `undefined` on anything that doesn't look like the expected shape — a missing/malformed file yields no signal, not a crash. */
export const parseInstalledInventory = (raw: string): InstalledInventorySnapshot | undefined => {
  try {
    const obj: unknown = JSON.parse(raw)
    if (!isRecord(obj)) return undefined
    const identical = obj['identicalAcrossRuns']
    const drift = obj['driftFiles']
    if (typeof identical !== 'boolean') return undefined
    if (!Array.isArray(drift) || !drift.every((d): d is string => typeof d === 'string')) return undefined
    return { identicalAcrossRuns: identical, driftFiles: drift }
  } catch {
    return undefined
  }
}

/**
 * The full, real `driftFiles` vocabulary phase 06 can emit (see
 * `06-config-capture.ts`'s `DRIFT_FILES` and `dirEntries`): byte-compared
 * config files (`opencode.jsonc`, `opencode.json`, `package.json`,
 * `package-lock.json`) plus directory-listing comparisons (`skills`,
 * `agents`, `command` — singular, not `commands` — `plugins`). There is no
 * `mcpServers`/`npmDependencies` label; a baseline that registers an
 * mcp server or plugin by hand-editing `opencode.json`, or a dependency via
 * `package.json`, shows up as drift in THOSE files instead. Every label
 * phase 06 can produce is evidence something changed on a side that should
 * never change mid-run, so this is an allowlist of the whole real
 * vocabulary, not a filter with something excluded.
 */
const DRIFT_INSTALL_FILES = new Set([
  'opencode.jsonc',
  'opencode.json',
  'package.json',
  'package-lock.json',
  'skills',
  'agents',
  'command',
  'plugins',
])

/**
 * On a baseline, nothing installs anything mid-run, so its captured config
 * should be identical across all its own runs. Drift in any file/listing
 * phase 06 tracks is the same "something showed up that shouldn't have"
 * shape as the incident that motivated this module — one snapshot showed
 * `skills: []` while `driftFiles: ["skills"]` meant another run's skills
 * differed. Named `install-drift`, not `config-drift`: this only fires on
 * the fields above, which do mean something was acquired/registered.
 */
export const findConfigDriftSignal = (
  snapshot: InstalledInventorySnapshot | undefined,
): UnindexedSignal | undefined => {
  if (snapshot === undefined || snapshot.identicalAcrossRuns) return undefined
  const relevant = snapshot.driftFiles.filter((f) => DRIFT_INSTALL_FILES.has(f))
  if (relevant.length === 0) return undefined
  return {
    kind: 'install-drift',
    detail: `captured config differs across this side's own runs in: ${relevant.join(', ')}`,
  }
}
