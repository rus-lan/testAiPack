import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import type { ExportToolPart } from '@generated/types'
import {
  findConfigDriftSignal,
  findPackActivitySignals,
  isInstallShapedCommand,
  parseInstalledInventory,
} from './baseline-contamination.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bash = (command: string, status: 'completed' | 'error' = 'completed'): ExportToolPart => ({
  type: 'tool',
  tool: 'bash',
  callID: 'c1',
  id: 'p1',
  state: { status, input: { command } },
})

const skill = (name: string, status: 'completed' | 'error' = 'completed'): ExportToolPart => ({
  type: 'tool',
  tool: 'skill',
  callID: 'c1',
  id: 'p1',
  state: { status, input: { name } },
})

// ---------------------------------------------------------------------------
// isInstallShapedCommand
// ---------------------------------------------------------------------------

describe('isInstallShapedCommand — tabular', () => {
  const CASES: readonly { readonly name: string; readonly command: string; readonly pack: string; readonly expected: boolean }[] = [
    { name: 'npm install -g', command: 'npm install -g @sentropic/graphify', pack: 'graphify', expected: true },
    { name: 'npm install --prefix', command: 'npm install --prefix ~/.npm-global --global @sentropic/graphify', pack: 'graphify', expected: true },
    { name: "pack's own install subcommand", command: '$NPM_GLOBAL_PATH/graphify install -p opencode', pack: 'graphify', expected: true },
    { name: 'pip install', command: 'pip install graphify-tools', pack: 'graphify-tools', expected: true },
    { name: 'yarn add', command: 'yarn add graphify', pack: 'graphify', expected: true },
    { name: 'npm search — not install-shaped', command: 'npm search graphify', pack: 'graphify', expected: false },
    { name: 'npm info — not install-shaped', command: 'npm info @sentropic/graphify', pack: 'graphify', expected: false },
    { name: 'which — not install-shaped', command: 'which graphify', pack: 'graphify', expected: false },
    { name: '--help — not install-shaped', command: 'graphify --help', pack: 'graphify', expected: false },
    { name: "pack's own use, not install", command: 'graphify . 2>&1', pack: 'graphify', expected: false },
    { name: 'install of something unrelated', command: 'npm install -g some-other-tool', pack: 'graphify', expected: false },
    { name: 'dogfooding: git add on a path that merely contains the pack name', command: 'git add src/graphify/x.ts', pack: 'graphify', expected: false },
    { name: 'coincidental substring: unrelated package whose name contains the pack name', command: 'npm install graphql', pack: 'graph', expected: false },
    { name: 'ordinary project dependency install does not name the pack — not flagged', command: 'npm install express', pack: 'graphify', expected: false },
  ]
  for (const c of CASES) {
    it(`${c.name} -> ${String(c.expected)}`, () => {
      expect(isInstallShapedCommand(c.command, c.pack)).toBe(c.expected)
    })
  }
})

// ---------------------------------------------------------------------------
// findPackActivitySignals
// ---------------------------------------------------------------------------

describe('findPackActivitySignals', () => {
  it('flags a successful skill call naming the pack', () => {
    const signals = findPackActivitySignals([skill('graphify')], 'graphify')
    expect(signals).toEqual([{ kind: 'skill-call', detail: 'skill tool call succeeded for "graphify"' }])
  })

  it('does not flag a FAILED skill call — that is the expected "not found" shape on a real baseline', () => {
    const signals = findPackActivitySignals([skill('graphify', 'error')], 'graphify')
    expect(signals).toEqual([])
  })

  it('does not flag a skill call for a different skill', () => {
    const signals = findPackActivitySignals([skill('customize-opencode')], 'graphify')
    expect(signals).toEqual([])
  })

  it('flags an install-shaped bash command referencing the pack', () => {
    const signals = findPackActivitySignals([bash('npm install -g @sentropic/graphify')], 'graphify')
    expect(signals).toEqual([{ kind: 'bash-install', detail: 'npm install -g @sentropic/graphify' }])
  })

  it('does not flag a plain lookup command', () => {
    const signals = findPackActivitySignals([bash('npm search graphify'), bash('which graphify')], 'graphify')
    expect(signals).toEqual([])
  })

  it('returns nothing when packName is undefined (no pack under test)', () => {
    const signals = findPackActivitySignals([bash('npm install -g @sentropic/graphify'), skill('graphify')], undefined)
    expect(signals).toEqual([])
  })

  it('collects every matching signal across many tool calls, in order', () => {
    const tools = [
      bash('which graphify'),
      bash('npm install -g @sentropic/graphify'),
      skill('graphify'),
      bash('npm install --prefix ~/.npm-global --global @sentropic/graphify'),
    ]
    const signals = findPackActivitySignals(tools, 'graphify')
    expect(signals.map((s) => s.kind)).toEqual(['bash-install', 'skill-call', 'bash-install'])
  })
})

// ---------------------------------------------------------------------------
// parseInstalledInventory / findConfigDriftSignal
// ---------------------------------------------------------------------------

describe('parseInstalledInventory', () => {
  it('parses the real shape', () => {
    const raw = JSON.stringify({
      side: 'old',
      identicalAcrossRuns: false,
      driftFiles: ['skills'],
      runsCompared: 4,
      skills: [],
    })
    expect(parseInstalledInventory(raw)).toEqual({ identicalAcrossRuns: false, driftFiles: ['skills'] })
  })

  it('returns undefined on malformed JSON instead of throwing', () => {
    expect(parseInstalledInventory('not json')).toBeUndefined()
  })

  it('returns undefined when the expected fields are missing or wrong-typed', () => {
    expect(parseInstalledInventory(JSON.stringify({ foo: 'bar' }))).toBeUndefined()
    expect(parseInstalledInventory(JSON.stringify({ identicalAcrossRuns: 'nope', driftFiles: [] }))).toBeUndefined()
  })
})

describe('findConfigDriftSignal', () => {
  it('undefined when snapshot is undefined (file missing/unparseable)', () => {
    expect(findConfigDriftSignal(undefined)).toBeUndefined()
  })

  it('undefined when identical across runs, even with a non-empty driftFiles left stale', () => {
    expect(findConfigDriftSignal({ identicalAcrossRuns: true, driftFiles: ['skills'] })).toBeUndefined()
  })

  it('undefined when driftFiles carries a label phase 06 never actually emits (defensive filtering)', () => {
    expect(findConfigDriftSignal({ identicalAcrossRuns: false, driftFiles: ['not-a-real-label'] })).toBeUndefined()
  })

  it('flags drift in a directory-listing field (skills/agents/command/plugins — singular "command")', () => {
    const signal = findConfigDriftSignal({ identicalAcrossRuns: false, driftFiles: ['skills'] })
    expect(signal).toEqual({
      kind: 'install-drift',
      detail: "captured config differs across this side's own runs in: skills",
    })
    expect(findConfigDriftSignal({ identicalAcrossRuns: false, driftFiles: ['command'] })?.detail).toContain('command')
  })

  it('flags drift in a byte-compared config file — the missed case: a plugin/mcp server registered by hand-editing opencode.json, or a dependency via package.json, produced no signal before this fix', () => {
    expect(findConfigDriftSignal({ identicalAcrossRuns: false, driftFiles: ['opencode.json'] })).toEqual({
      kind: 'install-drift',
      detail: "captured config differs across this side's own runs in: opencode.json",
    })
    expect(findConfigDriftSignal({ identicalAcrossRuns: false, driftFiles: ['package.json'] })).toEqual({
      kind: 'install-drift',
      detail: "captured config differs across this side's own runs in: package.json",
    })
  })

  it('lists every relevant drifted field, dropping only labels phase 06 cannot actually produce', () => {
    const signal = findConfigDriftSignal({
      identicalAcrossRuns: false,
      driftFiles: ['skills', 'not-a-real-label', 'plugins'],
    })
    expect(signal?.detail).toBe("captured config differs across this side's own runs in: skills, plugins")
  })
})

// ---------------------------------------------------------------------------
// Real ground truth: /home/ruslan/.testaipack/2026-07-30_06-35-30_8d2851
// old/run-2 is the proven-contaminated case (43 pack-generated files in its
// diff); old/run-1 and old/run-3 are clean baselines. See golden-values in
// the team-lead's task message for the full incident writeup.
// ---------------------------------------------------------------------------

const GOLDEN_ROOT = '/home/ruslan/.testaipack/2026-07-30_06-35-30_8d2851'
const hasGoldenWorkspace = existsSync(GOLDEN_ROOT)

interface OpencodeExportLike {
  readonly messages: readonly { readonly parts: readonly ExportToolPart[] }[]
}

const toolsOfRun = (runIndex: number): readonly ExportToolPart[] => {
  const raw = readFileSync(`${GOLDEN_ROOT}/results/raw/old/run-${String(runIndex)}.json`, 'utf8')
  const exp = JSON.parse(raw) as OpencodeExportLike
  return exp.messages.flatMap((m) => m.parts).filter((p) => (p as { type: string }).type === 'tool')
}

describe.skipIf(!hasGoldenWorkspace)('findPackActivitySignals — real incident workspace (baseline contamination)', () => {
  it('old/run-2 (contaminated) fires with the 4 real install commands', () => {
    const signals = findPackActivitySignals(toolsOfRun(2), 'graphify')
    expect(signals).toHaveLength(4)
    expect(signals.every((s) => s.kind === 'bash-install')).toBe(true)
    expect(signals.map((s) => s.detail)).toContain('npm install -g @sentropic/graphify 2>&1')
  })

  it('old/run-1 (clean) is silent', () => {
    expect(findPackActivitySignals(toolsOfRun(1), 'graphify')).toEqual([])
  })

  it('old/run-3 (clean) is silent', () => {
    expect(findPackActivitySignals(toolsOfRun(3), 'graphify')).toEqual([])
  })
})

describe.skipIf(!hasGoldenWorkspace)('findConfigDriftSignal — real captured config (config/.config/opencode/old/installed.json)', () => {
  it('fires: the real installed.json shows skills drift on the baseline side', () => {
    const raw = readFileSync(`${GOLDEN_ROOT}/config/.config/opencode/old/installed.json`, 'utf8')
    const signal = findConfigDriftSignal(parseInstalledInventory(raw))
    expect(signal).toEqual({
      kind: 'install-drift',
      detail: "captured config differs across this side's own runs in: skills",
    })
  })
})
