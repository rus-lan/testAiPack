/**
 * Sibling helper of phase 06 (not a numbered pipeline phase): captures the
 * effective opencode config and the installed/used dependency picture for
 * each variant into `config/.config/opencode/<name>/`.
 *
 * Runs once after every variant's N `opencode run`s finish (the on-disk
 * `opencode.jsonc`/`package.json` only exist once opencode itself has
 * launched) and before phase 13 cleanup, whose ephemeral mode deletes
 * `home/` — captured copies under `config/` survive that.
 *
 * `OPENCODE_CONFIG_CONTENT` is one merge layer among several, not the whole
 * effective config opencode used (it is merged last, so it wins on
 * conflicts, over `home/opencode.json` → `home/opencode.jsonc`). This module
 * captures every layer side by side plus their merge order instead of
 * synthesizing a merged config testaipack does not have the logic to
 * reproduce exactly.
 *
 * These layers can carry real provider API keys and mcp server secrets in
 * plain text — that is required for the live `OPENCODE_CONFIG_CONTENT`
 * env var and the on-disk HOME merge layers opencode itself reads, but not
 * for a copy written here purely for a human to inspect. Every layer this
 * module writes goes through `redactConfigJsonText`/`redactConfigSecrets`
 * first; nothing captured here ever feeds back into a run.
 *
 * @see docs/phases/06-run-side.ru.md
 */
import { Effect } from 'effect'
import crypto from 'node:crypto'
import path from 'node:path'
import type { VariantConfig, VariantTree, WorkspaceTree } from '@generated/types'
import {
  copyFile,
  ensureDir,
  exists,
  pathKind,
  readDir,
  readFile,
  readSymlink,
  writeFile,
  writeJson,
} from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { isRecord } from '../util/types.js'
import { redactConfigJsonText } from '../util/redact.js'
import type { PhaseError } from '../errors.js'
import { homeIsolationError } from '../errors.js'

export interface ConfigCaptureInput {
  readonly workspace: WorkspaceTree
  readonly runs: number
  readonly generatedConfigs: readonly VariantConfig[]
}

export interface ConfigCaptureResult {
  readonly capturedDirs: readonly string[]
}

export interface SkillCapture {
  readonly name: string
  /** Symlink target, or `copy:<sha256>` of the entry's content when it was copied rather than symlinked. */
  readonly target: string
}

export interface PluginCapture {
  readonly files: readonly string[]
  readonly configSpecs: readonly unknown[]
}

export interface InstalledJson {
  readonly variant: string
  readonly sourceHome: string
  readonly identicalAcrossRuns: boolean
  readonly driftFiles: readonly string[]
  /** How many runs besides run-1 were actually compared; 0 means identicalAcrossRuns is vacuous (nothing to compare against), not a verified match. */
  readonly runsCompared: number
  readonly skills: readonly SkillCapture[]
  readonly agents: readonly string[]
  readonly commands: readonly string[]
  readonly plugins: PluginCapture
  readonly mcpServers: readonly string[]
  readonly npmDependencies: Record<string, string>
  readonly configMergeOrder: readonly string[]
}

export interface SkillCallRecord {
  readonly run: number
  readonly name: string
  readonly status: string
  readonly error?: string
}

export interface UsageJson {
  readonly variant: string
  readonly runs: number
  readonly toolCalls: Record<string, number>
  readonly skillCalls: readonly SkillCallRecord[]
  readonly notKnowable: readonly string[]
}

/** §1.6: only skill (and, when present, mcp) invocations leave a trace in the event stream. */
const NOT_KNOWABLE: readonly string[] = ['plugin hook execution', 'npm package usage']

/** Copied byte-for-byte from `home/<name>/run-1/.config/opencode/` when present. */
const HOME_COPY_FILES: readonly string[] = [
  'opencode.jsonc',
  'opencode.json',
  'package.json',
  'package-lock.json',
]

/** Content-compared byte-for-byte across runs. */
const DRIFT_FILES: readonly string[] = HOME_COPY_FILES

const fail = (message: string, context: Record<string, unknown>): PhaseError =>
  homeIsolationError(message, 'E_HOME_SETUP_FAILED', context)

const mapFs = (variant: string, e: FsError): PhaseError =>
  fail(`opencode config capture failed: ${e.operation} ${e.path}`, { variant, path: e.path })

const range = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i)

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

interface VariantCapture {
  readonly variant: string
  readonly homeRuns: readonly string[]
  readonly generatedConfig: string
  readonly eventsDir: string
  readonly targetDir: string
  readonly runs: number
}

// ---------------------------------------------------------------------------
// installed.json
// ---------------------------------------------------------------------------

const readOptionalFile = (variant: string, p: string): Effect.Effect<string | undefined, PhaseError> =>
  Effect.gen(function* () {
    if (!(yield* exists(p))) return undefined
    return yield* readFile(p).pipe(Effect.mapError((e) => mapFs(variant, e)))
  })

const readJsonRecord = (variant: string, p: string): Effect.Effect<Record<string, unknown>, PhaseError> =>
  Effect.gen(function* () {
    const raw = yield* readOptionalFile(variant, p)
    if (raw === undefined) return {}
    try {
      const obj = JSON.parse(raw) as unknown
      return isRecord(obj) ? obj : {}
    } catch {
      return {}
    }
  })

const readDirNames = (variant: string, dir: string): Effect.Effect<readonly string[], PhaseError> =>
  Effect.gen(function* () {
    if (!(yield* exists(dir))) return []
    return yield* readDir(dir).pipe(Effect.mapError((e) => mapFs(variant, e)))
  })

const readMdBasenames = (variant: string, dir: string): Effect.Effect<readonly string[], PhaseError> =>
  Effect.gen(function* () {
    const names = yield* readDirNames(variant, dir)
    return names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -'.md'.length))
  })

/**
 * Content identity for a skills entry that is not a symlink (phase 04 always
 * `copyDir`s a real skill pack into HOME — see `applyInstruction`'s `skill`
 * case in `04-home-isolation.ts` — so this is the common case, not a rare
 * fallback). `entryPath` itself is unusable as the fingerprint: it is the
 * absolute path inside THIS run's own home dir
 * (`.../run-N/.config/opencode/skills/<name>`), which differs between runs
 * by construction even when the copied content is byte-identical. SHA-256
 * over sorted (path-relative-to-entry, content) pairs instead: stable across
 * runs that copied the same source, still changes when the content does.
 */
const hashSkillCopy = (variant: string, entryPath: string): Effect.Effect<string, PhaseError> =>
  Effect.gen(function* () {
    const hash = crypto.createHash('sha256')
    const walk = (p: string, rel: string): Effect.Effect<void, PhaseError> =>
      Effect.gen(function* () {
        const kind = yield* pathKind(p)
        if (kind === 'file') {
          const content = yield* readFile(p).pipe(Effect.mapError((e) => mapFs(variant, e)))
          hash.update(`f:${rel}:${content}\n`)
          return
        }
        if (kind !== 'dir') return
        const names = yield* readDirNames(variant, p)
        for (const name of [...names].sort()) {
          yield* walk(path.join(p, name), rel === '' ? name : `${rel}/${name}`)
        }
      })
    yield* walk(entryPath, '')
    return `copy:${hash.digest('hex')}`
  })

const readSkills = (
  variant: string,
  skillsDir: string,
): Effect.Effect<readonly SkillCapture[], PhaseError> =>
  Effect.gen(function* () {
    const names = yield* readDirNames(variant, skillsDir)
    return yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const entryPath = path.join(skillsDir, name)
          // A real (non-symlink) skills entry fails `readlink` — that is the
          // expected fallback branch (skills copied as plain files), not an error.
          const target = yield* readSymlink(entryPath).pipe(
            Effect.catchAll(() => hashSkillCopy(variant, entryPath)),
          )
          return { name, target }
        }),
      { concurrency: 1 },
    )
  })

const readNpmDependencies = (
  variant: string,
  packageJsonPath: string,
): Effect.Effect<Record<string, string>, PhaseError> =>
  Effect.gen(function* () {
    const pkg = yield* readJsonRecord(variant, packageJsonPath)
    const deps = pkg['dependencies']
    if (!isRecord(deps)) return {}
    return Object.entries(deps).reduce<Record<string, string>>(
      (acc, [k, v]) => (typeof v === 'string' ? { ...acc, [k]: v } : acc),
      {},
    )
  })

const mcpServersOf = (generatedConfig: string): readonly string[] => {
  try {
    const obj = JSON.parse(generatedConfig) as unknown
    if (!isRecord(obj)) return []
    const mcp = obj['mcp']
    return isRecord(mcp) ? Object.keys(mcp) : []
  } catch {
    return []
  }
}

const skillsFingerprint = (skills: readonly SkillCapture[]): string =>
  JSON.stringify([...skills].map((s) => `${s.name}=${s.target}`).sort())

const namesFingerprint = (names: readonly string[]): string => JSON.stringify([...names].sort())

interface Run1DirState {
  readonly skills: readonly SkillCapture[]
  readonly agents: readonly string[]
  readonly commands: readonly string[]
  readonly plugins: readonly string[]
}

interface DirDriftEntry {
  readonly label: string
  readonly base: string
  readonly read: (otherCfgDir: string) => Effect.Effect<string, PhaseError>
}

/**
 * `driftFiles` used to only ever check 4 files while `installed.json`
 * presented skills/agents/commands/plugins as if they were verified uniform
 * across runs — they were only ever read from run-1. This compares those
 * directory listings too (name+symlink-target for skills, sorted basenames
 * otherwise), so "identicalAcrossRuns" covers everything `installed.json`
 * actually asserts, not just the 4 files.
 */
const computeDrift = (
  variant: string,
  homeRuns: readonly string[],
  run1: Run1DirState,
): Effect.Effect<
  { readonly identicalAcrossRuns: boolean; readonly driftFiles: readonly string[]; readonly runsCompared: number },
  PhaseError
> =>
  Effect.gen(function* () {
    const run1Dir = path.join(homeRuns[0] ?? '', '.config/opencode')
    const otherDirs = homeRuns.slice(1).map((h) => path.join(h, '.config/opencode'))
    // Nothing to compare against: identicalAcrossRuns is vacuously true, not a
    // verified match — runsCompared: 0 tells the reader that explicitly.
    if (otherDirs.length === 0) return { identicalAcrossRuns: true, driftFiles: [], runsCompared: 0 }

    const fileDrift = yield* Effect.forEach(
      DRIFT_FILES,
      (file) =>
        Effect.gen(function* () {
          const base = yield* readOptionalFile(variant, path.join(run1Dir, file))
          const differs = yield* Effect.reduce(otherDirs, false, (acc, dir) =>
            Effect.gen(function* () {
              if (acc) return true
              const other = yield* readOptionalFile(variant, path.join(dir, file))
              return other !== base
            }),
          )
          return { label: file, differs }
        }),
      { concurrency: 1 },
    )

    const dirEntries: readonly DirDriftEntry[] = [
      {
        label: 'skills',
        base: skillsFingerprint(run1.skills),
        read: (dir) => readSkills(variant, path.join(dir, 'skills')).pipe(Effect.map(skillsFingerprint)),
      },
      {
        label: 'agents',
        base: namesFingerprint(run1.agents),
        read: (dir) => readMdBasenames(variant, path.join(dir, 'agents')).pipe(Effect.map(namesFingerprint)),
      },
      {
        label: 'command',
        base: namesFingerprint(run1.commands),
        read: (dir) => readMdBasenames(variant, path.join(dir, 'command')).pipe(Effect.map(namesFingerprint)),
      },
      {
        label: 'plugins',
        base: namesFingerprint(run1.plugins),
        read: (dir) => readDirNames(variant, path.join(dir, 'plugins')).pipe(Effect.map(namesFingerprint)),
      },
    ]
    const dirDrift = yield* Effect.forEach(
      dirEntries,
      (entry) =>
        Effect.gen(function* () {
          const differs = yield* Effect.reduce(otherDirs, false, (acc, dir) =>
            Effect.gen(function* () {
              if (acc) return true
              const otherFp = yield* entry.read(dir)
              return otherFp !== entry.base
            }),
          )
          return { label: entry.label, differs }
        }),
      { concurrency: 1 },
    )

    const driftFiles = [...fileDrift, ...dirDrift].filter((r) => r.differs).map((r) => r.label)
    return { identicalAcrossRuns: driftFiles.length === 0, driftFiles, runsCompared: otherDirs.length }
  })

const buildInstalled = (
  variant: string,
  sourceHome: string,
  generatedConfig: string,
  homeRuns: readonly string[],
): Effect.Effect<InstalledJson, PhaseError> =>
  Effect.gen(function* () {
    const cfgDir = path.join(sourceHome, '.config/opencode')
    const skills = yield* readSkills(variant, path.join(cfgDir, 'skills'))
    const agents = yield* readMdBasenames(variant, path.join(cfgDir, 'agents'))
    // opencode layout: command is singular, unlike the plural skills/agents/plugins.
    const commands = yield* readMdBasenames(variant, path.join(cfgDir, 'command'))
    const pluginFiles = yield* readDirNames(variant, path.join(cfgDir, 'plugins'))
    const onDiskCfg = yield* readJsonRecord(variant, path.join(cfgDir, 'opencode.json'))
    const configSpecs = isStringArray(onDiskCfg['plugin']) ? onDiskCfg['plugin'] : []
    const npmDependencies = yield* readNpmDependencies(variant, path.join(cfgDir, 'package.json'))
    const mcpServers = mcpServersOf(generatedConfig)
    const drift = yield* computeDrift(variant, homeRuns, { skills, agents, commands, plugins: pluginFiles })

    const hasHomeJson = yield* exists(path.join(cfgDir, 'opencode.json'))
    const hasHomeJsonc = yield* exists(path.join(cfgDir, 'opencode.jsonc'))
    const configMergeOrder: readonly string[] = [
      ...(hasHomeJson ? ['home/opencode.json'] : []),
      ...(hasHomeJsonc ? ['home/opencode.jsonc'] : []),
      'opencode.json',
    ]

    return {
      variant,
      sourceHome,
      identicalAcrossRuns: drift.identicalAcrossRuns,
      driftFiles: drift.driftFiles,
      runsCompared: drift.runsCompared,
      skills,
      agents,
      commands,
      plugins: { files: pluginFiles, configSpecs },
      mcpServers,
      npmDependencies,
      configMergeOrder,
    }
  })

// ---------------------------------------------------------------------------
// usage.json
// ---------------------------------------------------------------------------

interface ParsedEvents {
  readonly toolCalls: Record<string, number>
  readonly skillCalls: readonly SkillCallRecord[]
}

const toolNameOf = (ev: Record<string, unknown>): string | undefined => {
  const part = ev['part']
  const partRecord = isRecord(part) ? part : undefined
  const isToolEvent =
    ev['type'] === 'tool' || ev['type'] === 'tool_use' || (partRecord !== undefined && partRecord['type'] === 'tool')
  if (!isToolEvent) return undefined
  if (typeof ev['tool'] === 'string') return ev['tool']
  if (partRecord !== undefined && typeof partRecord['tool'] === 'string') return partRecord['tool']
  return undefined
}

const skillStateOf = (ev: Record<string, unknown>): Record<string, unknown> | undefined => {
  const part = ev['part']
  const partRecord = isRecord(part) ? part : undefined
  const direct = ev['state']
  if (isRecord(direct)) return direct
  const nested = partRecord?.['state']
  return isRecord(nested) ? nested : undefined
}

const skillCallFrom = (ev: Record<string, unknown>, runIndex: number): SkillCallRecord | undefined => {
  const state = skillStateOf(ev)
  if (state === undefined) return undefined
  const input = state['input']
  const name = isRecord(input) && typeof input['name'] === 'string' ? input['name'] : undefined
  if (name === undefined) return undefined
  const status = typeof state['status'] === 'string' ? state['status'] : 'unknown'
  const error = typeof state['error'] === 'string' ? state['error'] : undefined
  return { run: runIndex, name, status, ...(error === undefined ? {} : { error }) }
}

interface LineEvent {
  readonly tool: string
  readonly skillCall: SkillCallRecord | undefined
}

const tryParseJsonRecord = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(line) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const parseLine = (line: string, runIndex: number): LineEvent | undefined => {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const parsed = tryParseJsonRecord(trimmed)
  if (parsed === undefined) return undefined
  const tool = toolNameOf(parsed)
  if (tool === undefined) return undefined
  return { tool, skillCall: tool === 'skill' ? skillCallFrom(parsed, runIndex) : undefined }
}

const parseEventsFile = (raw: string, runIndex: number): ParsedEvents => {
  const events = raw
    .split('\n')
    .map((line) => parseLine(line, runIndex))
    .filter((e): e is LineEvent => e !== undefined)
  const toolCalls = events.reduce<Record<string, number>>(
    (acc, e) => ({ ...acc, [e.tool]: (acc[e.tool] ?? 0) + 1 }),
    {},
  )
  const skillCalls = events.reduce<readonly SkillCallRecord[]>(
    (acc, e) => (e.skillCall === undefined ? acc : [...acc, e.skillCall]),
    [],
  )
  return { toolCalls, skillCalls }
}

const mergeCounts = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
  Object.entries(b).reduce<Record<string, number>>((acc, [k, v]) => ({ ...acc, [k]: (acc[k] ?? 0) + v }), {
    ...a,
  })

const buildUsage = (variant: string, eventsDir: string, runs: number): Effect.Effect<UsageJson, PhaseError> =>
  Effect.gen(function* () {
    const perRun = yield* Effect.forEach(
      range(runs),
      (idx) =>
        Effect.gen(function* () {
          const runIndex = idx + 1
          const p = path.join(eventsDir, `run-${String(runIndex)}.events.ndjson`)
          // A missing/unreadable events file contributes nothing — it is not a
          // capture failure, it just means that run never produced a stream.
          const raw = (yield* exists(p)) ? yield* readFile(p).pipe(Effect.catchAll(() => Effect.succeed(''))) : ''
          return parseEventsFile(raw, runIndex)
        }),
      { concurrency: 1 },
    )
    const toolCalls = perRun.reduce<Record<string, number>>((acc, r) => mergeCounts(acc, r.toolCalls), {})
    const skillCalls = perRun.flatMap((r) => r.skillCalls)
    return { variant, runs, toolCalls, skillCalls, notKnowable: [...NOT_KNOWABLE] }
  })

// ---------------------------------------------------------------------------
// home/ byte copies + top-level opencode.json + orchestration
// ---------------------------------------------------------------------------

/**
 * `home/opencode.json` is the one file in `HOME_COPY_FILES` that can carry a
 * live credential (phase 04 merges mcp server `env` blocks into it) — it is
 * read+redacted+written instead of byte-copied. The original file at
 * `home/<name>/run-N/.config/opencode/opencode.json` is untouched; opencode
 * itself reads that one, every run, and needs the real value.
 */
const copyHomeFiles = (
  variant: string,
  sourceHome: string,
  targetDir: string,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    const cfgDir = path.join(sourceHome, '.config/opencode')
    const homeDir = path.join(targetDir, 'home')
    yield* ensureDir(homeDir).pipe(Effect.mapError((e) => mapFs(variant, e)))
    yield* Effect.forEach(
      HOME_COPY_FILES,
      (file) =>
        Effect.gen(function* () {
          const src = path.join(cfgDir, file)
          if (!(yield* exists(src))) return
          const dst = path.join(homeDir, file)
          if (file === 'opencode.json') {
            const raw = yield* readFile(src).pipe(Effect.mapError((e) => mapFs(variant, e)))
            yield* writeFile(dst, redactConfigJsonText(raw)).pipe(Effect.mapError((e) => mapFs(variant, e)))
            return
          }
          yield* copyFile(src, dst).pipe(Effect.mapError((e) => mapFs(variant, e)))
        }),
      { concurrency: 1 },
    )
  })

const captureVariant = (c: VariantCapture): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    const sourceHome = c.homeRuns[0] ?? ''
    yield* ensureDir(c.targetDir).pipe(Effect.mapError((e) => mapFs(c.variant, e)))
    // Same content opencode received as OPENCODE_CONFIG_CONTENT, minus
    // credential values (redactConfigJsonText keeps the key names) — this
    // copy is for a human to read, never fed back into a run.
    yield* writeFile(path.join(c.targetDir, 'opencode.json'), redactConfigJsonText(c.generatedConfig)).pipe(
      Effect.mapError((e) => mapFs(c.variant, e)),
    )
    yield* copyHomeFiles(c.variant, sourceHome, c.targetDir)
    const installed = yield* buildInstalled(c.variant, sourceHome, c.generatedConfig, c.homeRuns)
    yield* writeJson(path.join(c.targetDir, 'installed.json'), installed).pipe(
      Effect.mapError((e) => mapFs(c.variant, e)),
    )
    const usage = yield* buildUsage(c.variant, c.eventsDir, c.runs)
    yield* writeJson(path.join(c.targetDir, 'usage.json'), usage).pipe(
      Effect.mapError((e) => mapFs(c.variant, e)),
    )
  })

/**
 * A variant with no matching entry in `generatedConfigs` means phase 04 and
 * phase 06 disagree about which variants exist — a fail-loud phase-04/06
 * mismatch, not "this variant has no config". Substituting `''` here would
 * make `installed.json` assert `mcpServers: []` as a verified fact about a
 * config that was never actually read; this module exists to be trustworthy
 * evidence, so a missing entry aborts the capture instead.
 */
const buildCapture = (
  vt: VariantTree,
  generatedConfigs: readonly VariantConfig[],
  captureRoot: string,
  rawDir: string,
  runs: number,
): Effect.Effect<VariantCapture, PhaseError> =>
  Effect.gen(function* () {
    const generated = generatedConfigs.find((g) => g.name === vt.name)
    if (generated === undefined) {
      yield* Effect.fail(
        fail(`no generated config for variant: ${vt.name}`, { variant: vt.name }),
      )
    }
    return {
      variant: vt.name,
      homeRuns: vt.homes,
      generatedConfig: generated?.config ?? '',
      eventsDir: path.join(rawDir, vt.name),
      targetDir: path.join(captureRoot, vt.name),
      runs,
    }
  })

export const captureOpencodeConfig = (
  input: ConfigCaptureInput,
): Effect.Effect<ConfigCaptureResult, PhaseError> =>
  Effect.gen(function* () {
    const captureRoot = path.join(input.workspace.config, '.config', 'opencode')
    const captures = yield* Effect.forEach(
      input.workspace.variantTrees,
      (vt) => buildCapture(vt, input.generatedConfigs, captureRoot, input.workspace.raw, input.runs),
      { concurrency: 1 },
    )
    yield* Effect.forEach(captures, captureVariant, { concurrency: 1 })
    return { capturedDirs: captures.map((c) => c.targetDir) }
  })
