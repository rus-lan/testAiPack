import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { opencodeExportSchema } from '@generated/schemas'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile } from '../util/fs.js'
import {
  censusManifestFields,
  combineExitCode,
  combineWatchdog,
  parseRunLog,
  recoverManifestCensus,
  recoverRunResult,
} from './run-recovery.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)

const TEST_EXPORT_SCHEMA = z.object({ info: z.object({ version: z.string() }) })

// ---------------------------------------------------------------------------
// parseRunLog — synthetic
// ---------------------------------------------------------------------------

describe('parseRunLog', () => {
  it('happy path: full log with init, prompt, one export attempt, verify, stop', () => {
    const log = [
      '[START] variant=old runIndex=1 sessionId=abc',
      '[INIT] running --init',
      '[INIT_DONE] exitCode=0 timedOut=false watchdog=false sessionId=abc',
      '[PROMPT] running --prompt',
      '[PROMPT_DONE] exitCode=0 timedOut=false watchdog=false sessionId=abc',
      '[EXPORT] attempt 1: requesting opencode export',
      '[EXPORT] attempt 1: written to /tmp/run-1.json',
      '[VERIFY] running "npm test"',
      '[VERIFY_DONE] exitCode=0',
      '[STOP] finish=stop rank=4 durationMs=689219',
    ].join('\n')
    const p = parseRunLog(log)
    expect(p.initDone).toEqual({ exitCode: 0, watchdog: false })
    expect(p.promptDone).toEqual({ exitCode: 0, watchdog: false })
    expect(p.stopFinish).toBe('stop')
    expect(p.stopRank).toBe(4)
    expect(p.stopDurationMs).toBe('689219')
    expect(p.verifyExitCode).toBe(0)
    expect(p.verifyTimedOut).toBe(false)
    expect(p.exportAttempts).toBe(1)
  })

  // Binding rule (05-risks.md §1.3): the recovery log parser must accept
  // BOTH the old `side=` and the new `variant=` key in bracketed log lines.
  // Neither is actually consumed by anything below (the START line's fields
  // are unused) — the generic `[TAG] key=val ...` grammar this parser uses
  // is key-name-agnostic, so it already accepts both without special-casing
  // either. These two logs, differing only in that key, must parse
  // identically.
  it('accepts a legacy [START] side= line and a v2 [START] variant= line identically', () => {
    const legacy = parseRunLog(['[START] side=old runIndex=1 sessionId=abc', '[STOP] finish=stop rank=4 durationMs=100'].join('\n'))
    const v2 = parseRunLog(['[START] variant=old runIndex=1 sessionId=abc', '[STOP] finish=stop rank=4 durationMs=100'].join('\n'))
    expect(legacy).toEqual(v2)
    expect(legacy.stopFinish).toBe('stop')
    expect(legacy.stopRank).toBe(4)
  })

  it('retried export: two attempts logged, exportAttempts is the max attempt number, not the line count', () => {
    const log = [
      '[EXPORT] attempt 1: requesting opencode export',
      '[EXPORT] attempt 1: /tmp/run-1.json invalid-json: schema-mismatch',
      '[EXPORT] attempt 2: requesting opencode export',
      '[EXPORT] attempt 2: written to /tmp/run-1.json',
      '[STOP] finish=stop rank=4 durationMs=1000',
    ].join('\n')
    const p = parseRunLog(log)
    expect(p.exportAttempts).toBe(2)
  })

  it('crashed before STOP: only START/INIT_DONE present, everything past that is absent', () => {
    const log = ['[START] variant=old runIndex=1 sessionId=abc', '[INIT] running --init', '[INIT_DONE] exitCode=1 timedOut=false watchdog=false sessionId=abc'].join('\n')
    const p = parseRunLog(log)
    expect(p.initDone).toEqual({ exitCode: 1, watchdog: false })
    expect(p.promptDone).toBeUndefined()
    expect(p.stopFinish).toBeUndefined()
    expect(p.stopRank).toBeUndefined()
    expect(p.stopDurationMs).toBeUndefined()
  })

  it('empty log: everything absent, no throw', () => {
    const p = parseRunLog('')
    expect(p.initDone).toBeUndefined()
    expect(p.promptDone).toBeUndefined()
    expect(p.stopFinish).toBeUndefined()
    expect(p.exportAttempts).toBe(0)
  })

  it('malformed STOP line (non-numeric rank, unknown finish) -> those fields absent, never guessed', () => {
    const log = '[STOP] finish=maybe rank=high durationMs=soon'
    const p = parseRunLog(log)
    expect(p.stopFinish).toBeUndefined()
    expect(p.stopRank).toBeUndefined()
    expect(p.stopDurationMs).toBeUndefined()
  })

  it('truncated STOP line (missing fields) -> only the present ones are recovered', () => {
    const log = '[STOP] finish=length'
    const p = parseRunLog(log)
    expect(p.stopFinish).toBe('length')
    expect(p.stopRank).toBeUndefined()
    expect(p.stopDurationMs).toBeUndefined()
  })

  it('verify timeout: verifyExitCode stays absent, verifyTimedOut true', () => {
    const log = ['[VERIFY] running "npm test"', '[VERIFY_TIMEOUT]', '[STOP] finish=stop rank=0 durationMs=5000'].join('\n')
    const p = parseRunLog(log)
    expect(p.verifyExitCode).toBeUndefined()
    expect(p.verifyTimedOut).toBe(true)
  })

  it('garbage lines interleaved are ignored, not fatal', () => {
    const log = ['not a tagged line at all', '[STOP] finish=stop rank=4 durationMs=10', '{"stray":"json"}'].join('\n')
    const p = parseRunLog(log)
    expect(p.stopFinish).toBe('stop')
    expect(p.stopRank).toBe(4)
  })
})

describe('combineExitCode', () => {
  it('init non-zero wins over a zero prompt', () => {
    expect(combineExitCode(1, 0)).toBe(1)
  })
  it('prompt non-zero wins when init is zero', () => {
    expect(combineExitCode(0, 2)) .toBe(2)
  })
  it('both zero -> last (prompt)', () => {
    expect(combineExitCode(0, 0)).toBe(0)
  })
  it('only init present -> init', () => {
    expect(combineExitCode(1, undefined)).toBe(1)
  })
  it('neither present -> undefined', () => {
    expect(combineExitCode(undefined, undefined)).toBeUndefined()
  })
})

describe('combineWatchdog', () => {
  it('either true -> true', () => {
    expect(combineWatchdog(true, false)).toBe(true)
    expect(combineWatchdog(false, true)).toBe(true)
  })
  it('both known false -> false', () => {
    expect(combineWatchdog(false, false)).toBe(false)
  })
  it('neither known -> undefined (not guessed as false)', () => {
    expect(combineWatchdog(undefined, undefined)).toBeUndefined()
  })
  it('one known false, one unknown -> false (the known one is authoritative)', () => {
    expect(combineWatchdog(false, undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// recoverRunResult — synthetic fixtures on disk
// ---------------------------------------------------------------------------

const writeRawFiles = async (
  rawDir: string,
  variant: string,
  runIndex: number,
  files: { readonly log?: string; readonly json?: string; readonly ndjson?: string },
): Promise<void> => {
  const dir = path.join(rawDir, variant)
  await runP(ensureDir(dir))
  if (files.log !== undefined) await runP(writeFile(path.join(dir, `run-${String(runIndex)}.log`), files.log))
  if (files.json !== undefined) await runP(writeFile(path.join(dir, `run-${String(runIndex)}.json`), files.json))
  if (files.ndjson !== undefined) {
    await runP(writeFile(path.join(dir, `run-${String(runIndex)}.events.ndjson`), files.ndjson))
  }
}

describe('recoverRunResult', () => {
  it('happy path: valid log + valid export + events file all present', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await writeRawFiles(rawDir, 'old', 1, {
      log: '[STOP] finish=stop rank=4 durationMs=1234\n[PROMPT_DONE] exitCode=0 timedOut=false watchdog=false sessionId=x',
      json: JSON.stringify({ info: { version: '1.18.4' } }),
      ndjson: '{"a":1}\n{"b":2}\n',
    })
    const r = await runP(recoverRunResult(rawDir, 'old', 1, TEST_EXPORT_SCHEMA))
    expect(r.variant).toBe('old')
    expect(r.successRank).toBe(4)
    expect(r.finishCause).toBe('stop')
    expect(r.durationMs).toBe('1234')
    expect(r.exitCode).toBe(0)
    expect(r.diagnostics.exportExists).toBe(true)
    expect(r.diagnostics.exportValid).toBe(true)
    expect(r.diagnostics.eventsExists).toBe(true)
    expect(r.diagnostics.eventsLineCount).toBe(2)
    expect(r.diagnostics.eventsParseableLineCount).toBe(2)
    expect(r.notRecoverable).toEqual(['errorCode'])
    expect(r.initRan).toBe(false) // no [INIT_DONE] line in this fixture
  })

  it('an arbitrary v2 variant name (not old/new) works the same', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await writeRawFiles(rawDir, 'graphify', 1, { log: '[STOP] finish=stop rank=4 durationMs=1000' })
    const r = await runP(recoverRunResult(rawDir, 'graphify', 1, TEST_EXPORT_SCHEMA))
    expect(r.variant).toBe('graphify')
    expect(r.successRank).toBe(4)
  })

  it('missing log file entirely: outcome fields absent, diagnostics say so, no throw', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await writeRawFiles(rawDir, 'old', 1, {
      json: JSON.stringify({ info: { version: '1.18.4' } }),
      ndjson: '{"a":1}\n',
    })
    const r = await runP(recoverRunResult(rawDir, 'old', 1, TEST_EXPORT_SCHEMA))
    expect(r.diagnostics.logExists).toBe(false)
    expect(r.successRank).toBeUndefined()
    expect(r.finishCause).toBeUndefined()
    expect(r.exitCode).toBeUndefined()
    expect(r.initRan).toBe(false)
  })

  it('initRan (metric-split spec §5.8): true when the .log has an [INIT_DONE] line, false when it does not', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await writeRawFiles(rawDir, 'old', 1, {
      log: '[PROMPT_DONE] exitCode=0 timedOut=false watchdog=false sessionId=x\n[STOP] finish=stop rank=4 durationMs=100',
    })
    const noInit = await runP(recoverRunResult(rawDir, 'old', 1, TEST_EXPORT_SCHEMA))
    expect(noInit.initRan).toBe(false)

    await writeRawFiles(rawDir, 'old', 2, {
      log: '[INIT_DONE] exitCode=0 timedOut=false watchdog=false sessionId=x\n[PROMPT_DONE] exitCode=0 timedOut=false watchdog=false sessionId=x\n[STOP] finish=stop rank=4 durationMs=100',
    })
    const withInit = await runP(recoverRunResult(rawDir, 'old', 2, TEST_EXPORT_SCHEMA))
    expect(withInit.initRan).toBe(true)
  })

  it('export file present but invalid against the schema -> exportValid false, log fields unaffected', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await writeRawFiles(rawDir, 'old', 1, {
      log: '[STOP] finish=stop rank=4 durationMs=1234',
      json: '{"not":"an export"}',
    })
    const r = await runP(recoverRunResult(rawDir, 'old', 1, TEST_EXPORT_SCHEMA))
    expect(r.diagnostics.exportExists).toBe(true)
    expect(r.diagnostics.exportValid).toBe(false)
    expect(r.successRank).toBe(4)
  })

  it('export file present but truncated (unparseable JSON) -> exportValid false, not a crash', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await writeRawFiles(rawDir, 'old', 1, { json: '{"info":{"version"' })
    const r = await runP(recoverRunResult(rawDir, 'old', 1, TEST_EXPORT_SCHEMA))
    expect(r.diagnostics.exportValid).toBe(false)
  })

  it('nothing on disk at all: every recoverable field absent, diagnostics all false/zero', async () => {
    const rawDir = makeTempDir('run-recovery-')
    await runP(ensureDir(path.join(rawDir, 'old')))
    const r = await runP(recoverRunResult(rawDir, 'old', 1, TEST_EXPORT_SCHEMA))
    expect(r.diagnostics.logExists).toBe(false)
    expect(r.diagnostics.exportExists).toBe(false)
    expect(r.diagnostics.eventsExists).toBe(false)
    expect(r.successRank).toBeUndefined()
    expect(r.watchdogTriggered).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// censusManifestFields / recoverManifestCensus — synthetic
// ---------------------------------------------------------------------------

describe('censusManifestFields', () => {
  const FULL_MANIFEST = {
    schemaVersion: 2,
    runId: 'x',
    timestamp: 'x',
    repoUrl: 'https://example.com/repo.git',
    packs: [{ name: 'graphify', ref: 'https://example.com/graphify.git' }],
    variants: [{ name: 'old', packs: [] }, { name: 'new', packs: ['graphify'] }],
    baseline: 'old',
    parallel: 2,
    prompt: 'do thing',
    init: '/graphify .',
    verify: 'npm test',
    runs: 5,
    isolation: 'docker',
    opencodeVersion: '1.18.3',
    flagDefaults: {},
  }

  it('fields the v2 Manifest contract declares are reported recoverable when present', () => {
    const fields = censusManifestFields(FULL_MANIFEST, true)
    const byName = new Map(fields.map((f) => [f.field, f]))
    expect(byName.get('repoUrl')?.recoverable).toBe(true)
    expect(byName.get('packs')?.recoverable).toBe(true)
    expect(byName.get('variants')?.recoverable).toBe(true)
    expect(byName.get('baseline')?.recoverable).toBe(true)
    expect(byName.get('parallel')?.recoverable).toBe(true)
    expect(byName.get('prompt')?.recoverable).toBe(true)
    expect(byName.get('init')?.recoverable).toBe(true)
    expect(byName.get('verify')?.recoverable).toBe(true)
    expect(byName.get('runs')?.recoverable).toBe(true)
    expect(byName.get('isolation')?.recoverable).toBe(true)
    expect(byName.get('opencodeVersion')?.recoverable).toBe(true)
  })

  it('fields the Manifest contract never carries are always not-recoverable, even in a full manifest', () => {
    const fields = censusManifestFields(FULL_MANIFEST, true)
    const byName = new Map(fields.map((f) => [f.field, f]))
    for (const name of ['dockerNetwork', 'auth', 'judge', 'judgeFiles', 'preflightEnabled', 'preflightModel', 'formats', 'outputPath', 'diffHtml', 'collapseRepeats', 'timelineMode', 'timeouts', 'logLevel', 'pricingPath']) {
      expect(byName.get(name)?.recoverable, `${name} should be not-recoverable`).toBe(false)
      expect(byName.get(name)?.source).toBe('not-recoverable')
    }
  })

  it('model comes from config, not manifest: recoverable only when found in config', () => {
    const withModel = censusManifestFields(FULL_MANIFEST, true)
    const withoutModel = censusManifestFields(FULL_MANIFEST, false)
    expect(withModel.find((f) => f.field === 'model')?.source).toBe('config')
    expect(withoutModel.find((f) => f.field === 'model')?.source).toBe('not-recoverable')
  })

  it('workspacePath is recoverable via external-argument, not a file read', () => {
    const fields = censusManifestFields({}, false)
    const wp = fields.find((f) => f.field === 'workspacePath')
    expect(wp?.recoverable).toBe(true)
    expect(wp?.source).toBe('external-argument')
  })

  it('optional manifest fields absent from a minimal manifest are reported not recoverable', () => {
    const minimal = { schemaVersion: 2, runId: 'x', timestamp: 'x', repoUrl: 'r', runs: 1, isolation: 'home', opencodeVersion: '1.0.0', baseline: 'old', parallel: 2, packs: [], variants: [], flagDefaults: {} }
    const fields = censusManifestFields(minimal, false)
    const byName = new Map(fields.map((f) => [f.field, f]))
    expect(byName.get('prompt')?.recoverable).toBe(false)
    expect(byName.get('init')?.recoverable).toBe(false)
    expect(byName.get('verify')?.recoverable).toBe(false)
    expect(byName.get('hint')?.recoverable).toBe(false)
  })
})

describe('recoverManifestCensus', () => {
  it('missing manifest.json -> empty manifest object, every manifest-sourced field not-recoverable, no throw', async () => {
    const runRoot = makeTempDir('run-recovery-')
    const result = await runP(recoverManifestCensus(runRoot))
    expect(result.manifest).toEqual({})
    expect(result.modelFoundInConfig).toBe(false)
    expect(result.fields.find((f) => f.field === 'repoUrl')?.recoverable).toBe(false)
    expect(result.schemaVersion).toBe(1)
  })

  it('a v2 manifest.json (schemaVersion present) passes through untouched, schemaVersion 2', async () => {
    const runRoot = makeTempDir('run-recovery-')
    await runP(ensureDir(runRoot))
    await runP(writeFile(
      path.join(runRoot, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2, runId: 'x', timestamp: 'x', repoUrl: 'r', runs: 1, isolation: 'home',
        opencodeVersion: '1.0.0', baseline: 'base', parallel: 2, packs: [], variants: [{ name: 'base', packs: [] }],
        flagDefaults: {},
      }),
    ))
    const result = await runP(recoverManifestCensus(runRoot))
    expect(result.schemaVersion).toBe(2)
    expect(result.manifest['baseline']).toBe('base')
  })

  it('a v1 manifest.json (schemaVersion absent) is mapped: packs/variants/baseline become recoverable', async () => {
    const runRoot = makeTempDir('run-recovery-')
    await runP(ensureDir(runRoot))
    await runP(writeFile(
      path.join(runRoot, 'manifest.json'),
      JSON.stringify({
        runId: 'x', timestamp: 'x', repoUrl: 'r', packRef: 'https://example.com/x.git', prompt: 'p',
        runs: 1, isolation: 'home', opencodeVersion: '1.0.0', flagDefaults: {},
      }),
    ))
    const result = await runP(recoverManifestCensus(runRoot))
    expect(result.schemaVersion).toBe(1)
    expect(result.manifest['baseline']).toBe('old')
    const byName = new Map(result.fields.map((f) => [f.field, f]))
    expect(byName.get('packs')?.recoverable).toBe(true)
    expect(byName.get('variants')?.recoverable).toBe(true)
    expect(byName.get('baseline')?.recoverable).toBe(true)
  })

  it('reads model out of any config/*.json file when manifest.json lacks it (v2 per-variant naming)', async () => {
    const runRoot = makeTempDir('run-recovery-')
    await runP(ensureDir(path.join(runRoot, 'config')))
    await runP(writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 2, repoUrl: 'r', runs: 1, isolation: 'home', opencodeVersion: '1.0.0', baseline: 'base', parallel: 2, packs: [], variants: [] })))
    await runP(writeFile(path.join(runRoot, 'config', 'graphify.json'), JSON.stringify({ model: 'ollama/qwen3.5' })))
    const result = await runP(recoverManifestCensus(runRoot))
    expect(result.modelFoundInConfig).toBe(true)
    expect(result.fields.find((f) => f.field === 'model')?.recoverable).toBe(true)
  })

  it('reads model out of the legacy config/new.json naming too', async () => {
    const runRoot = makeTempDir('run-recovery-')
    await runP(ensureDir(path.join(runRoot, 'config')))
    await runP(writeFile(path.join(runRoot, 'manifest.json'), JSON.stringify({ repoUrl: 'r', prompt: 'p', runs: 1, isolation: 'home', opencodeVersion: '1.0.0' })))
    await runP(writeFile(path.join(runRoot, 'config', 'new.json'), JSON.stringify({ model: 'ollama/qwen3.5' })))
    const result = await runP(recoverManifestCensus(runRoot))
    expect(result.modelFoundInConfig).toBe(true)
    expect(result.fields.find((f) => f.field === 'model')?.recoverable).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Real ground truth — the actual incident workspace. Lives outside the repo
// (a real testaipack run under the user's home, not a checked-in fixture),
// so the whole block skips cleanly when absent — same pattern as
// src/metrics/events-profile.test.ts's golden-values block. This workspace
// predates schemaVersion entirely (v1), which is exactly what makes it
// valuable here: recoverManifestCensus must still read it correctly through
// the compat mapping.
// ---------------------------------------------------------------------------

const REAL_ROOT = '/home/ruslan/.testaipack/2026-07-29_20-44-07_ed1eeb'
const hasRealWorkspace = existsSync(REAL_ROOT)

describe.skipIf(!hasRealWorkspace)('recoverRunResult — real incident workspace', () => {
  it('old/run-1 (the run whose .git was deleted): outcome survives untouched in the .log', async () => {
    const rawDir = path.join(REAL_ROOT, 'results', 'raw')
    const r = await runP(recoverRunResult(rawDir, 'old', 1, opencodeExportSchema))
    expect(r.successRank).toBe(4)
    expect(r.finishCause).toBe('stop')
    expect(r.durationMs).toBe('689219')
    expect(r.exitCode).toBe(0)
    expect(r.watchdogTriggered).toBe(false)
    expect(r.diagnostics.exportExists).toBe(true)
    expect(r.diagnostics.exportValid).toBe(true)
    expect(r.diagnostics.eventsExists).toBe(true)
    expect(r.diagnostics.eventsLineCount).toBeGreaterThan(0)
  })

  it('all 10 runs recover a successRank from the real logs (none crash the parser)', async () => {
    const rawDir = path.join(REAL_ROOT, 'results', 'raw')
    for (const variant of ['old', 'new'] as const) {
      for (let runIndex = 1; runIndex <= 5; runIndex++) {
        const r = await runP(recoverRunResult(rawDir, variant, runIndex, opencodeExportSchema))
        expect(r.successRank, `${variant}/run-${String(runIndex)}`).toBeDefined()
      }
    }
  })
})

describe.skipIf(!hasRealWorkspace)('recoverManifestCensus — real incident workspace', () => {
  it('reports the real manifest.json field inventory, mapped to v2 (schemaVersion 1 on disk)', async () => {
    const result = await runP(recoverManifestCensus(REAL_ROOT))
    expect(result.schemaVersion).toBe(1)
    expect(result.manifest['repoUrl']).toBe('https://github.com/tarsy-club/TarSy-Bot')
    expect(result.manifest['isolation']).toBe('docker')
    expect(result.manifest['opencodeVersion']).toBe('1.18.3')
    expect(result.manifest['baseline']).toBe('old')
    expect(result.modelFoundInConfig).toBe(true)
    const byName = new Map(result.fields.map((f) => [f.field, f]))
    expect(byName.get('model')?.source).toBe('config')
    expect(byName.get('judge')?.recoverable).toBe(false)
    expect(byName.get('diffHtml')?.recoverable).toBe(false)
    expect(byName.get('packs')?.recoverable).toBe(true)
  })

  it('cross-check: the real config/new.json actually carries the model this workspace used', () => {
    const raw = readFileSync(path.join(REAL_ROOT, 'config', 'new.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['model']).toBe('ollama/qwen3.5-9b-32k')
  })
})
