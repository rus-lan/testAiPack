/**
 * Phase 03: pack-install
 *
 * Delivers every pack in the run's registry (`runInput.packs`) into its own
 * `pack/<packName>/` subdirectory (skill / agent / command / all / mcp) and
 * produces a declarative `instructions` list per pack, consumed by phase 04
 * to physically register a variant's declared pack(s) inside its HOMEs. This
 * phase writes ONLY under `workspace.pack/` and `workspace.results/` — it
 * never touches `home/<variant>/run-N/` (that is phase 04's responsibility).
 * A pack shared by several variants is still delivered exactly once here
 * (D6) — variant attribution happens downstream, in phase 04/04b/05.
 *
 * @see docs/phases/03-pack-install.ru.md
 * @see contract/phases/03-pack-install.tsp
 */
import { Effect } from 'effect'
import { Duration } from 'effect'
import path from 'node:path'
import type { PackDelivery, PackInstallInput, PackSpec, PackType } from '@generated/types'
import { detectPack, safeRefDisplay } from '../pack/detector.js'
import type { PackDetectError, PackRef } from '../pack/detector.js'
import { clone } from '../util/git.js'
import type { GitError } from '../util/git.js'
import {
  appendFile,
  copyDir,
  copyFile,
  ensureDir,
  exists,
  isPathWithin,
  pathKind,
  readDir,
  readFile,
  removeDir,
  writeFile,
} from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { redactUrlCredentials } from '../util/redact.js'
import { packInstallError } from '../errors.js'
import type { PhaseError } from '../errors.js'

/**
 * Declarative registration instruction produced by phase 03 and consumed by
 * phase 04. Local extension of the TypeSpec contract — kept out of `*.tsp`
 * because phase 03 only DELIVERS the pack; the physical registration mechanics
 * are an internal 03↔04 hand-off, not part of the wire contract.
 */
export type RegistrationInstruction =
  | { readonly kind: 'skill'; readonly name: string; readonly target: string }
  | {
      readonly kind: 'file'
      readonly section: 'agents' | 'commands'
      readonly name: string
      readonly target: string
    }
  | {
      readonly kind: 'plugin'
      readonly name: string
      /**
       * Absolute path to a local plugin file (from a pack's `plugins/` dir).
       * Undefined for an `npm:`-form plugin ref, which has no local file and
       * is installed via `opencode plugin <module>` instead (phase 04).
       */
      readonly target?: string
    }
  | { readonly kind: 'config'; readonly section: 'mcp'; readonly name: string; readonly json: unknown }

/**
 * One pack's delivery. Extends the contract `PackDelivery` with `instructions`
 * — the local 03↔04 hand-off documented above. `detectedType` keeps the
 * generated `PackType | unknown` shape as-is (a pre-existing codegen quirk —
 * `unknown` absorbs the union); narrow it by hand at call sites that need the
 * concrete `PackType`, never by changing the contract.
 */
export type PackDeliveryExt = PackDelivery & {
  readonly instructions: readonly RegistrationInstruction[]
}

/**
 * Phase 03 outcome: one `PackDeliveryExt` per registry pack. A
 * `PackInstallOutcome` is structurally a `PackInstallResult`, so any consumer
 * expecting the contract type accepts it.
 */
export interface PackInstallOutcome {
  readonly deliveries: readonly PackDeliveryExt[]
  readonly installLogPath: string
}

interface Delivery {
  readonly packPath: string
  readonly registeredIn: readonly string[]
  readonly instructions: readonly RegistrationInstruction[]
}

const failPack = (
  code: Parameters<typeof packInstallError>[1],
  message: string,
  packRef: string,
  context?: Record<string, unknown>,
): Effect.Effect<never, PhaseError> =>
  Effect.fail(packInstallError(message, code, { packRef: safeRefDisplay(packRef), ...(context ?? {}) }))

const appendLog = (logPath: string, line: string): Effect.Effect<void, PhaseError> =>
  appendFile(logPath, line).pipe(
    Effect.mapError((e) =>
      packInstallError(`cannot write install log: ${e.path}`, 'E_INSTALL_FAILED', {
        path: e.path,
      }),
    ),
  )

const mapCloneError = (url: string) => (e: GitError): PhaseError =>
  packInstallError(`git clone failed: ${redactUrlCredentials(e.stderr)}`, 'E_INSTALL_FAILED', {
    ref: redactUrlCredentials(url),
    ...(e.stderr.length > 0 ? { stderr: redactUrlCredentials(e.stderr) } : {}),
  })

const mapCopyError = (src: string) => (e: FsError): PhaseError =>
  packInstallError(`copy failed: ${e.path}`, 'E_INSTALL_FAILED', {
    ref: src,
    path: e.path,
  })

const withTimeout = (
  eff: Effect.Effect<void, PhaseError>,
  seconds: number,
  onTimeoutRef: string,
  label: string,
): Effect.Effect<void, PhaseError> =>
  eff.pipe(
    Effect.timeout(Duration.seconds(seconds)),
    Effect.catchTag('TimeoutException', () =>
      Effect.fail(
        packInstallError(
          `${label} timed out after ${String(seconds)}s`,
          'E_INSTALL_TIMEOUT',
          { ref: onTimeoutRef },
        ),
      ),
    ),
  )

const cleanDest = (
  packDir: string,
  dest: string,
  packRef: string,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    if (!isPathWithin(packDir, dest)) {
      yield* Effect.fail(
        packInstallError(`pack destination escapes pack dir: ${dest}`, 'E_PACK_INVALID_REF', {
          packRef: safeRefDisplay(packRef),
          path: dest,
        }),
      )
    }
    yield* removeDir(dest).pipe(
      Effect.mapError((e: FsError) =>
        packInstallError(`cannot clean pack dest: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
        }),
      ),
    )
  })

const scanDir = (dir: string): Effect.Effect<readonly string[], PhaseError> =>
  readDir(dir).pipe(
    Effect.mapError((e: FsError) =>
      packInstallError(`cannot read pack dir: ${e.path}`, 'E_INSTALL_FAILED', {
        path: e.path,
      }),
    ),
  )

const deliverDir = (
  ref: PackRef,
  packDir: string,
  dest: string,
  seconds: number,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    yield* cleanDest(packDir, dest, ref.raw)
    if (ref.source === 'git') {
      const url = ref.url ?? ''
      yield* withTimeout(
        clone(url, dest, { shallow: true }).pipe(Effect.mapError(mapCloneError(url))),
        seconds,
        redactUrlCredentials(url),
        'git clone',
      )
      return
    }
    const src = ref.path ?? ''
    const kind = yield* pathKind(src)
    if (kind === 'missing') {
      yield* failPack('E_PACK_INVALID_REF', `pack source not found: ${src}`, ref.raw)
    }
    if (kind === 'file') {
      yield* failPack(
        'E_PACK_INVALID_REF',
        `expected a directory for this pack type: ${src}`,
        ref.raw,
      )
    }
    yield* withTimeout(copyDir(src, dest).pipe(Effect.mapError(mapCopyError(src))), seconds, src, 'copy')
  })

/**
 * Skill markdown file names opencode accepts, in priority order. opencode's
 * loader scans for uppercase `SKILL.md`; lowercase `skill.md` is tolerated on
 * input (some repos, e.g. graphify, ship lowercase) and mirrored to uppercase
 * before registration.
 */
const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md'] as const

interface SkillRoot {
  readonly root: string
  readonly file: string
}

/**
 * Locate the skill markdown inside a freshly delivered pack. Looks at the pack
 * root first (the common case), then one directory level deep — many skill
 * repos nest the file under a top-level folder named after the skill. Prefers a
 * folder whose name matches the pack, then falls back to alphabetical order.
 */
const resolveSkillRoot = (
  dest: string,
  name: string,
): Effect.Effect<SkillRoot | null, PhaseError> =>
  Effect.gen(function* () {
    for (const fname of SKILL_FILE_NAMES) {
      const p = path.join(dest, fname)
      if (yield* exists(p)) return { root: dest, file: p }
    }
    const entries = yield* scanDir(dest)
    const ordered = [
      ...entries.filter((e) => e === name),
      ...entries.filter((e) => e !== name).sort(),
    ]
    for (const sub of ordered) {
      const subDir = path.join(dest, sub)
      const kind = yield* pathKind(subDir)
      if (kind !== 'dir') continue
      for (const fname of SKILL_FILE_NAMES) {
        const p = path.join(subDir, fname)
        if (yield* exists(p)) return { root: subDir, file: p }
      }
    }
    return null
  })

const deliverSkill = (
  ref: PackRef,
  packDir: string,
  seconds: number,
): Effect.Effect<Delivery, PhaseError> =>
  Effect.gen(function* () {
    const dest = path.join(packDir, ref.name)
    yield* deliverDir(ref, packDir, dest, seconds)
    const resolved = yield* resolveSkillRoot(dest, ref.name)
    if (resolved === null) {
      yield* failPack('E_PACK_INVALID_REF', `SKILL.md missing in pack ${ref.name}`, ref.raw, {
        expected: path.join(dest, 'SKILL.md'),
      })
    }
    const skillRoot = resolved === null ? dest : resolved.root
    const skillFile = resolved === null ? path.join(dest, 'SKILL.md') : resolved.file
    // opencode only discovers uppercase SKILL.md; mirror a lowercase skill.md.
    const upperSkill = path.join(skillRoot, 'SKILL.md')
    if (skillFile !== upperSkill) {
      const body = yield* readFile(skillFile).pipe(
        Effect.mapError((e: FsError) =>
          packInstallError(`cannot read skill file: ${e.path}`, 'E_INSTALL_FAILED', {
            path: e.path,
          }),
        ),
      )
      yield* writeFile(upperSkill, body).pipe(
        Effect.mapError((e: FsError) =>
          packInstallError(`cannot write SKILL.md: ${e.path}`, 'E_INSTALL_FAILED', {
            path: e.path,
          }),
        ),
      )
    }
    return {
      packPath: skillRoot,
      registeredIn: ['skills'],
      instructions: [{ kind: 'skill', name: ref.name, target: skillRoot }],
    }
  })

const deliverPlugin = (ref: PackRef): Effect.Effect<Delivery, PhaseError> =>
  Effect.succeed({
    packPath: '',
    registeredIn: ['plugins'],
    instructions: [{ kind: 'plugin', name: ref.name }],
  })

const deliverMd = (
  ref: PackRef,
  section: 'agents' | 'commands',
  packDir: string,
  seconds: number,
): Effect.Effect<Delivery, PhaseError> =>
  Effect.gen(function* () {
    const name = ref.name.replace(/\.md$/, '')
    if (ref.source === 'git') {
      const dest = path.join(packDir, name)
      yield* deliverDir(ref, packDir, dest, seconds)
      const mdPath = path.join(dest, `${name}.md`)
      if (!(yield* exists(mdPath))) {
        yield* failPack(
          'E_PACK_INVALID_REF',
          `${section} file ${name}.md not found in repo`,
          ref.raw,
          { expected: mdPath },
        )
      }
      return {
        packPath: dest,
        registeredIn: [section],
        instructions: [{ kind: 'file', section, name, target: mdPath }],
      }
    }
    const src = ref.path ?? ''
    const kind = yield* pathKind(src)
    if (kind === 'missing') {
      yield* failPack('E_PACK_INVALID_REF', `pack source not found: ${src}`, ref.raw)
    }
    if (kind === 'file') {
      const destFile = path.join(packDir, `${name}.md`)
      yield* copyFile(src, destFile).pipe(Effect.mapError(mapCopyError(src)))
      return {
        packPath: destFile,
        registeredIn: [section],
        instructions: [{ kind: 'file', section, name, target: destFile }],
      }
    }
    const dest = path.join(packDir, name)
    yield* cleanDest(packDir, dest, ref.raw)
    yield* withTimeout(copyDir(src, dest).pipe(Effect.mapError(mapCopyError(src))), seconds, src, 'copy')
    const mdPath = path.join(dest, `${name}.md`)
    if (!(yield* exists(mdPath))) {
      yield* failPack(
        'E_PACK_INVALID_REF',
        `${section} file ${name}.md not found in directory`,
        ref.raw,
        { expected: mdPath },
      )
    }
    return {
      packPath: dest,
      registeredIn: [section],
      instructions: [{ kind: 'file', section, name, target: mdPath }],
    }
  })

interface ScanResult {
  readonly sections: readonly string[]
  readonly instructions: readonly RegistrationInstruction[]
}

const EMPTY_SCAN: ScanResult = { sections: [], instructions: [] }

const scanSkills = (skillsDir: string): Effect.Effect<ScanResult, PhaseError> =>
  Effect.gen(function* () {
    const entries = yield* scanDir(skillsDir)
    const nested = yield* Effect.forEach(entries, (name) =>
      Effect.gen(function* () {
        const skillDir = path.join(skillsDir, name)
        const kind = yield* pathKind(skillDir)
        const hasSkill = kind === 'dir' && (yield* exists(path.join(skillDir, 'SKILL.md')))
        if (!hasSkill) return [] as readonly RegistrationInstruction[]
        return [{ kind: 'skill', name, target: skillDir }] as readonly RegistrationInstruction[]
      }),
      { concurrency: 1 },
    )
    const instructions = nested.flat()
    return {
      sections: instructions.length > 0 ? ['skills'] : [],
      instructions,
    }
  })

const scanMd = (
  dir: string,
  section: 'agents' | 'commands',
): Effect.Effect<ScanResult, PhaseError> =>
  Effect.gen(function* () {
    const entries = yield* scanDir(dir)
    const instructions = entries
      .filter((f) => f.endsWith('.md'))
      .map(
        (f): RegistrationInstruction => ({
          kind: 'file',
          section,
          name: f.slice(0, -3),
          target: path.join(dir, f),
        }),
      )
    return {
      sections: instructions.length > 0 ? [section] : [],
      instructions,
    }
  })

/** opencode loads a plugin from a single `<name>.js`-style module file (see phase 04/05). */
const PLUGIN_FILE_RE = /\.(?:m?[jt]s|cjs)$/

const scanPlugins = (pluginsDir: string): Effect.Effect<ScanResult, PhaseError> =>
  Effect.gen(function* () {
    const entries = yield* scanDir(pluginsDir)
    const nested = yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          if (!PLUGIN_FILE_RE.test(entry)) return [] as readonly RegistrationInstruction[]
          const target = path.join(pluginsDir, entry)
          const kind = yield* pathKind(target)
          if (kind !== 'file') return [] as readonly RegistrationInstruction[]
          const name = entry.replace(PLUGIN_FILE_RE, '')
          return [{ kind: 'plugin', name, target }] as readonly RegistrationInstruction[]
        }),
      { concurrency: 1 },
    )
    const instructions = nested.flat()
    return {
      sections: instructions.length > 0 ? ['plugins'] : [],
      instructions,
    }
  })

const maybeScan = (
  dir: string,
  scan: (d: string) => Effect.Effect<ScanResult, PhaseError>,
): Effect.Effect<ScanResult, PhaseError> =>
  Effect.gen(function* () {
    if (!(yield* exists(dir))) return EMPTY_SCAN
    return yield* scan(dir)
  })

const deliverAll = (
  ref: PackRef,
  packDir: string,
  seconds: number,
): Effect.Effect<Delivery, PhaseError> =>
  Effect.gen(function* () {
    const dest = path.join(packDir, ref.name)
    yield* deliverDir(ref, packDir, dest, seconds)
    const parts = yield* Effect.all([
      maybeScan(path.join(dest, 'skills'), scanSkills),
      maybeScan(path.join(dest, 'agents'), (d) => scanMd(d, 'agents')),
      maybeScan(path.join(dest, 'commands'), (d) => scanMd(d, 'commands')),
      maybeScan(path.join(dest, 'plugins'), scanPlugins),
    ])
    return {
      packPath: dest,
      registeredIn: parts.flatMap((p) => p.sections),
      instructions: parts.flatMap((p) => p.instructions),
    }
  })

const jsonParseErrorPosition = (e: unknown): number | undefined => {
  if (!(e instanceof Error)) return undefined
  const match = /position (\d+)/.exec(e.message)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * mcp configs routinely carry provider API keys/tokens in their `env` block,
 * so a parse failure must never echo the raw text. It also can't reuse
 * `JSON.parse`'s own error message verbatim: V8 quotes a snippet of the input
 * when the bad token is at the very start of the string (no valid JSON
 * recognized yet), which would leak the same secret through a different
 * door. Only the pack name, length, and a numeric position are safe to keep.
 */
const parseJsonConfig = (
  text: string,
  packName: string,
): Effect.Effect<unknown, PhaseError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (e): PhaseError => {
      const position = jsonParseErrorPosition(e)
      return packInstallError(
        `mcp config for ${packName} is not valid JSON${position === undefined ? '' : ` (near position ${String(position)})`}`,
        'E_PACK_INVALID_REF',
        { pack: packName, length: text.length, ...(position === undefined ? {} : { position }) },
      )
    },
  })

const resolveMcpConfigText = (
  ref: PackRef,
  packDir: string,
): Effect.Effect<string | undefined, PhaseError> =>
  Effect.gen(function* () {
    if (ref.config !== undefined) {
      if (ref.config.startsWith('@')) {
        const filePath = ref.config.slice(1)
        const kind = yield* pathKind(filePath)
        if (kind === 'missing') {
          yield* failPack('E_PACK_INVALID_REF', `mcp config file not found: ${filePath}`, ref.raw, {
            file: filePath,
          })
        }
        return yield* readFile(filePath).pipe(
          Effect.mapError((e: FsError) =>
            packInstallError(`cannot read mcp config file: ${e.path}`, 'E_PACK_INVALID_REF', {
              packRef: safeRefDisplay(ref.raw),
              file: e.path,
            }),
          ),
        )
      }
      return ref.config
    }
    const mcpJson = path.join(packDir, 'mcp.json')
    const configJson = path.join(packDir, 'config.json')
    if (yield* exists(mcpJson)) {
      return yield* readFile(mcpJson).pipe(
        Effect.mapError((e: FsError) =>
          packInstallError(`cannot read mcp.json: ${e.path}`, 'E_INSTALL_FAILED', { path: e.path }),
        ),
      )
    }
    if (yield* exists(configJson)) {
      return yield* readFile(configJson).pipe(
        Effect.mapError((e: FsError) =>
          packInstallError(`cannot read config.json: ${e.path}`, 'E_INSTALL_FAILED', { path: e.path }),
        ),
      )
    }
    return undefined
  })

const deliverMcp = (
  ref: PackRef,
  packRoot: string,
): Effect.Effect<Delivery, PhaseError> =>
  Effect.gen(function* () {
    const packDir = path.join(packRoot, ref.name)
    yield* ensureDir(packDir).pipe(
      Effect.mapError((e: FsError) =>
        packInstallError(`cannot create pack dir: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
        }),
      ),
    )

    const configText = yield* resolveMcpConfigText(ref, packDir)
    if (configText === undefined) {
      yield* failPack(
        'E_PACK_INVALID_REF',
        `no mcp config provided for ${ref.name} (expected mcp:<name>:<json> or mcp:<name>:@<file>)`,
        ref.raw,
      )
    }

    const resolved = configText ?? ''
    const parsed = yield* parseJsonConfig(resolved, ref.name)
    yield* writeFile(path.join(packDir, 'mcp.json'), resolved).pipe(
      Effect.mapError((e: FsError) =>
        packInstallError(`cannot persist mcp.json: ${e.path}`, 'E_INSTALL_FAILED', { path: e.path }),
      ),
    )

    return {
      packPath: packDir,
      registeredIn: ['mcp'],
      instructions: [{ kind: 'config', section: 'mcp', name: ref.name, json: parsed }],
    }
  })

const runDelivery = (
  type: PackType,
  detected: PackRef,
  packRoot: string,
  seconds: number,
): Effect.Effect<Delivery, PhaseError> => {
  switch (type) {
    case 'skill':
      return deliverSkill(detected, packRoot, seconds)
    case 'plugin':
      return deliverPlugin(detected)
    case 'agent':
      return deliverMd(detected, 'agents', packRoot, seconds)
    case 'command':
      return deliverMd(detected, 'commands', packRoot, seconds)
    case 'all':
      return deliverAll(detected, packRoot, seconds)
    case 'mcp':
      return deliverMcp(detected, packRoot)
  }
}

const withPackContext = <A>(
  eff: Effect.Effect<A, PhaseError>,
  packName: string,
): Effect.Effect<A, PhaseError> =>
  eff.pipe(
    Effect.mapError((e) =>
      packInstallError(e.message, e.code, { ...(e.context ?? {}), pack: packName }),
    ),
  )

const deliverPack = (
  pack: PackSpec,
  packRootBase: string,
  seconds: number,
  installLogPath: string,
): Effect.Effect<PackDeliveryExt, PhaseError> =>
  Effect.gen(function* () {
    const packDir = path.join(packRootBase, pack.name)
    yield* ensureDir(packDir).pipe(
      Effect.mapError((e) =>
        packInstallError(`cannot create pack dir: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
          pack: pack.name,
        }),
      ),
    )

    const detected = yield* detectPack(pack.ref).pipe(
      Effect.mapError((e: PackDetectError) =>
        packInstallError(`invalid pack reference: ${e.reason}`, 'E_PACK_INVALID_REF', {
          packRef: safeRefDisplay(pack.ref),
          reason: e.reason,
          pack: pack.name,
        }),
      ),
    )
    const type: PackType = pack.type ?? detected.type

    const delivery = yield* withPackContext(runDelivery(type, detected, packDir, seconds), pack.name)

    yield* appendLog(
      installLogPath,
      `[${pack.name}] installed ${type} ${detected.name} via ${detected.source}; sections=[${delivery.registeredIn.join(',')}]\n`,
    )

    return {
      pack: pack.name,
      packPath: delivery.packPath,
      detectedType: type,
      registeredIn: [...delivery.registeredIn],
      instructions: [...delivery.instructions],
    }
  })

export const packInstall = (
  input: PackInstallInput,
): Effect.Effect<PackInstallOutcome, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const installLogPath = path.join(workspace.results, 'install.log')

    yield* ensureDir(workspace.results).pipe(
      Effect.mapError((e) =>
        packInstallError(`cannot create results dir: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
        }),
      ),
    )
    yield* ensureDir(workspace.pack).pipe(
      Effect.mapError((e) =>
        packInstallError(`cannot create pack dir: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
        }),
      ),
    )

    if (runInput.packs.length === 0) {
      yield* appendLog(installLogPath, 'smoke-test: no pack\n')
      return { deliveries: [], installLogPath }
    }

    const seconds = runInput.timeouts.installSeconds
    const deliveries = yield* Effect.forEach(
      runInput.packs,
      (pack) => deliverPack(pack, workspace.pack, seconds, installLogPath),
      { concurrency: 1 },
    )

    return { deliveries: [...deliveries], installLogPath }
  })
