/**
 * Phase 03: pack-install
 *
 * Delivers the pack under test into `workspace.pack/<name>/` (skill / agent /
 * command / all) and produces a declarative `instructions` list consumed by
 * phase 04 to physically register the pack inside each new-side HOME. This
 * phase writes ONLY under `workspace.pack/` and `workspace.results/` — it never
 * touches `home/<side>/run-N/` (that is phase 04's responsibility).
 *
 * @see docs/phases/03-pack-install.ru.md
 * @see contract/phases/03-pack-install.tsp
 */
import { Effect } from 'effect'
import { Duration } from 'effect'
import path from 'node:path'
import type { PackInstallInput, PackInstallResult, PackType } from '@generated/types'
import { detectPack } from '../pack/detector.js'
import type { PackDetectError, PackRef } from '../pack/detector.js'
import { clone } from '../util/git.js'
import type { GitError } from '../util/git.js'
import {
  appendFile,
  copyDir,
  copyFile,
  ensureDir,
  exists,
  pathKind,
  readDir,
  removeDir,
} from '../util/fs.js'
import type { FsError } from '../util/fs.js'
import { packInstallError } from '../errors.js'
import type { PhaseError } from '../errors.js'

/**
 * Declarative registration instruction produced by phase 03 and consumed by
 * phase 04. Local extension of the TypeSpec contract — kept out of `*.tsp`
 * because phase 03 only DELIVERS the pack; the physical registration mechanics
 * are an internal 03↔04 hand-off, not part of the wire contract.
 */
export type RegistrationInstruction =
  | { readonly kind: 'symlink'; readonly name: string; readonly target: string }
  | {
      readonly kind: 'file'
      readonly section: 'agents' | 'commands'
      readonly name: string
      readonly target: string
    }
  | { readonly kind: 'plugin'; readonly name: string }
  | { readonly kind: 'config'; readonly section: 'mcp'; readonly json: unknown }

/**
 * Phase 03 outcome. Extends the contract `PackInstallResult` with:
 * - `detectedType` narrowed from the codegen quirk `PackType | unknown` to the
 *   honest `PackType | null` (null only in smoke-test).
 * - `instructions` — the local extension documented above.
 *
 * A `PackInstallOutcome` is structurally a `PackInstallResult`, so any consumer
 * expecting the contract type accepts it.
 */
export interface PackInstallOutcome extends PackInstallResult {
  readonly detectedType: PackType | null
  readonly instructions: readonly RegistrationInstruction[]
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
  Effect.fail(packInstallError(message, code, { packRef, ...(context ?? {}) }))

const appendLog = (logPath: string, line: string): Effect.Effect<void, PhaseError> =>
  appendFile(logPath, line).pipe(
    Effect.mapError((e) =>
      packInstallError(`cannot write install log: ${e.path}`, 'E_INSTALL_FAILED', {
        path: e.path,
      }),
    ),
  )

const mapCloneError = (url: string) => (e: GitError): PhaseError =>
  packInstallError(`git clone failed: ${e.stderr}`, 'E_INSTALL_FAILED', {
    ref: url,
    ...(e.stderr.length > 0 ? { stderr: e.stderr } : {}),
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

const cleanDest = (dest: string): Effect.Effect<void, PhaseError> =>
  removeDir(dest).pipe(
    Effect.mapError((e: FsError) =>
      packInstallError(`cannot clean pack dest: ${e.path}`, 'E_INSTALL_FAILED', {
        path: e.path,
      }),
    ),
  )

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
  dest: string,
  seconds: number,
): Effect.Effect<void, PhaseError> =>
  Effect.gen(function* () {
    yield* cleanDest(dest)
    if (ref.source === 'git') {
      const url = ref.url ?? ''
      yield* withTimeout(
        clone(url, dest, { shallow: true }).pipe(Effect.mapError(mapCloneError(url))),
        seconds,
        url,
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

const deliverSkill = (
  ref: PackRef,
  packDir: string,
  seconds: number,
): Effect.Effect<Delivery, PhaseError> =>
  Effect.gen(function* () {
    const dest = path.join(packDir, ref.name)
    yield* deliverDir(ref, dest, seconds)
    const skillMd = path.join(dest, 'SKILL.md')
    if (!(yield* exists(skillMd))) {
      yield* failPack('E_PACK_INVALID_REF', `SKILL.md missing in pack ${ref.name}`, ref.raw, {
        expected: skillMd,
      })
    }
    return {
      packPath: dest,
      registeredIn: ['skills'],
      instructions: [{ kind: 'symlink', name: ref.name, target: dest }],
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
      yield* deliverDir(ref, dest, seconds)
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
    yield* cleanDest(dest)
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
        return [{ kind: 'symlink', name, target: skillDir }] as readonly RegistrationInstruction[]
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

const scanPlugins = (pluginsDir: string): Effect.Effect<ScanResult, PhaseError> =>
  Effect.gen(function* () {
    const entries = yield* scanDir(pluginsDir)
    const instructions = entries.map(
      (name): RegistrationInstruction => ({ kind: 'plugin', name }),
    )
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
    yield* deliverDir(ref, dest, seconds)
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
      return Effect.fail(
        packInstallError('mcp packs are not supported in MVP (v0.3)', 'E_PACK_UNKNOWN_TYPE', {
          packRef: detected.raw,
        }),
      )
  }
}

export const packInstall = (
  input: PackInstallInput,
): Effect.Effect<PackInstallOutcome, PhaseError> =>
  Effect.gen(function* () {
    const { runInput, workspace } = input
    const packRef = runInput.packRef
    const installLogPath = path.join(workspace.results, 'install.log')
    const packRoot = workspace.pack

    yield* ensureDir(workspace.results).pipe(
      Effect.mapError((e) =>
        packInstallError(`cannot create results dir: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
        }),
      ),
    )
    yield* ensureDir(packRoot).pipe(
      Effect.mapError((e) =>
        packInstallError(`cannot create pack dir: ${e.path}`, 'E_INSTALL_FAILED', {
          path: e.path,
        }),
      ),
    )

    if (packRef === undefined || packRef.trim() === '') {
      yield* appendLog(installLogPath, 'smoke-test: no pack\n')
      return {
        packPath: '',
        detectedType: null,
        installLogPath,
        registeredIn: [],
        instructions: [],
      }
    }

    const detected = yield* detectPack(packRef).pipe(
      Effect.mapError((e: PackDetectError) =>
        packInstallError(
          `invalid pack reference: ${e.reason}`,
          'E_PACK_INVALID_REF',
          { packRef, reason: e.reason },
        ),
      ),
    )
    const type: PackType = runInput.packType ?? detected.type

    const seconds = runInput.timeouts.installSeconds
    const delivery = yield* runDelivery(type, detected, packRoot, seconds)

    yield* appendLog(
      installLogPath,
      `installed ${type} ${detected.name} via ${detected.source}; sections=[${delivery.registeredIn.join(',')}]\n`,
    )

    return {
      packPath: delivery.packPath,
      detectedType: type,
      installLogPath,
      registeredIn: [...delivery.registeredIn],
      instructions: [...delivery.instructions],
    }
  })
