/**
 * Golden tests for the N-way HTML renderer (mirrors md.test.ts structurally
 * per `.research/n-way-variants/03-hard-problems.md` §4.2), plus light
 * json/yaml round-trip smoke tests. Covers both canonical fixtures
 * (04-work-packages.md §5.1): `shimPair()` (2 variants) and
 * `threeVariants()` (3 variants, 2 packs).
 */
import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { renderJson } from './json.js'
import { renderYaml } from './yaml.js'
import { renderHtml } from './html.js'
import { reportSchema } from '@generated/schemas'
import { computeMetricsReport } from '../metrics/aggregate.js'
import { buildReportSummary } from '../cli/summary.js'
import { makeReportV2, makeVariantAggregates, makeMetricsReport, shimPair } from '../../tests/helpers/variants.js'
import type { Manifest, PrepReport, Report } from '@generated/types'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

const threeVariantsReport = (): Report => makeReportV2()

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
            fullPatch: 'p',
            summary: { filesChanged: 2, additions: 8, deletions: 3, perFile: [] },
            noChanges: false,
          },
        ],
      },
      {
        variant: 'new',
        runs: [
          {
            runIndex: 1,
            fullPatch: 'diff --git a/file.txt b/file.txt\n@@ -1,1 +1,2 @@\n-old\n+new\n',
            summary: {
              filesChanged: 2,
              additions: 8,
              deletions: 3,
              perFile: [
                { path: 'file.txt', additions: 5, deletions: 1 },
                { path: 'other.txt', additions: 3, deletions: 2 },
              ],
            },
            noChanges: false,
            htmlPath: '/abs/new/side.html',
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

describe('renderJson', () => {
  it('produces valid JSON that round-trips through reportSchema', async () => {
    const parsed = JSON.parse(await runP(renderJson(threeVariantsReport()))) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
  })

  it('fails with a typed PhaseError when the report fails schema validation', async () => {
    const report = threeVariantsReport()
    const invalid = { ...report, manifest: { ...report.manifest, runId: 123 } } as unknown as Report
    const err = await runFlip(renderJson(invalid))
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.message).toContain('schema validation')
  })
})

describe('renderYaml', () => {
  it('produces non-empty YAML', async () => {
    const text = await runP(renderYaml(threeVariantsReport()))
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('manifest:')
  })

  it('fails with a typed PhaseError when the report fails schema validation', async () => {
    const report = threeVariantsReport()
    const invalid = { ...report, manifest: { ...report.manifest, runId: 123 } } as unknown as Report
    const err = await runFlip(renderYaml(invalid))
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.message).toContain('schema validation')
  })
})

describe('renderHtml — document shape', () => {
  it('self-contained document with headline, table, judge, timeline iframe', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Primary metrics')
    expect(html).toContain('Total tokens')
    expect(html).toContain('LLM Judge')
    expect(html).toContain('timeline.html')
  })

  it('has no external dependencies (no http(s) imports or src)', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).not.toMatch(/src="https?:\/\//)
    expect(html).not.toMatch(/href="https?:\/\//)
    expect(html).not.toMatch(/@import|url\(https?:\/\//)
  })

  it('header carries runId, repoUrl and the per-variant descriptors', () => {
    const report = threeVariantsReport()
    const html = renderHtml(report)
    expect(html).toContain(report.manifest.runId)
    expect(html).toContain(report.manifest.repoUrl)
    expect(html).toContain('base* (no packs, pure)')
    expect(html).toContain('graphify (packs: graphify)')
  })

  it('judge.ran === false renders "did not run" without verdict/quality', () => {
    const report = threeVariantsReport()
    const didNotRun: Report = {
      ...report,
      judge: { verdict: 'unclear', scores: [], ranking: [], explanation: 'judge crashed (exit 1)', modelUsed: '', timestamp: '2025-01-01T00:05:00.000Z', ran: false },
    }
    const html = renderHtml(didNotRun)
    expect(html).toContain('Judge did not run: judge crashed (exit 1)')
    expect(html).not.toContain('Verdict:')
  })

  it('omits the raw-response block when rawResponse is absent, escapes it when present', () => {
    const report = threeVariantsReport()
    expect(renderHtml(report)).not.toContain('Raw model response')
    const withRaw: Report = { ...report, judge: { ...report.judge!, rawResponse: 'I <really> cannot decide.' } }
    const html = renderHtml(withRaw)
    expect(html).toContain('<details><summary>Raw model response</summary>')
    expect(html).toContain('I &lt;really&gt; cannot decide.')
  })

  it('B2 regression: hint: "" DISABLES the inherited global — the divergence still fires the "variants differ" suffix', () => {
    const report = threeVariantsReport()
    const withHint: Report = {
      ...report,
      manifest: {
        ...report.manifest,
        hint: 'use good practices',
        variants: report.manifest.variants.map((v) => (v.name === 'astgrep' ? { ...v, hint: '' } : v)),
      },
    }
    const html = renderHtml(withHint)
    expect(html).toContain('<strong>Hint:</strong> base, graphify — &quot;use good practices&quot; (variants differ')
    expect(html).not.toMatch(/astgrep.*use good practices/)
  })

  it('B4 regression: a packless variant with no explicit `pure` still defaults to pure (D1)', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('base* (no packs, pure)')
  })
})

describe('renderHtml — primary metrics table', () => {
  it('metric-major header with Variant column, baseline row uses .baseline-row class', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('<th>Metric</th><th>Variant</th><th>Median</th><th>[min–max]</th><th>Δ vs base</th><th>Δ%</th><th>Significant</th><th>Verdict</th>')
    expect(html).toMatch(/<tr class="baseline-row"><td>Total tokens<\/td><td>base\*<\/td>/)
  })

  it('color-codes non-baseline verdict cells (better/worse/neutral)', () => {
    const html = renderHtml(threeVariantsReport())
    const totalTokensGraphify = html.match(/<tr><td>Total tokens<\/td><td>graphify<\/td>.*?<\/tr>/)
    expect(totalTokensGraphify?.[0]).toMatch(/class="better"/)
  })

  it('§1.3 caveat footnote renders for N-1 > 1', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('N−1 = 2 comparisons share one baseline')
  })

  it('shimPair: no caveat for a single comparison', () => {
    const html = renderHtml(shimReport())
    expect(html).toContain('* baseline.')
    expect(html).not.toContain('N−1')
  })

  it('B3 regression: --baseline pointing at a non-first config entry still puts that row first in every metric group', () => {
    const report = threeVariantsReport()
    const rebased: Report = { ...report, metrics: { ...report.metrics, baseline: 'graphify' } }
    const html = renderHtml(rebased)
    const totalTokensRows = [...html.matchAll(/<tr[^>]*><td>Total tokens<\/td><td>([^<]+)<\/td>/g)].map((m) => m[1])
    expect(totalTokensRows[0]).toBe('graphify*')
    expect(totalTokensRows[1]).toBe('base')
    expect(totalTokensRows[2]).toBe('astgrep')
  })
})

describe('renderHtml — summary', () => {
  it('renders one "vs base" block per non-baseline variant with Improvements/Regressions/Neutral', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('vs base: graphify')
    expect(html).toContain('vs base: astgrep')
    expect(html).toContain('Improvements')
    expect(html).toContain('Regressions')
    expect(html).toContain('Neutral')
  })
})

describe('renderHtml — diff summary', () => {
  it('renders a diff section with patch and side.html links per variant', () => {
    const html = renderHtml(shimReport())
    expect(html).toContain('Diff summary')
    expect(html).toContain('diff/old/run-1/full.patch')
    expect(html).toContain('diff/new/run-1/side.html')
    expect(html).not.toContain('/abs/new/side.html')
  })

  it('omits the side.html link when htmlPath is absent', () => {
    const report = shimReport()
    const noHtml: Report = {
      ...report,
      diffs: report.diffs.map((d) => ({
        ...d,
        runs: d.runs.map((r) => {
          const { htmlPath: _htmlPath, ...rest } = r
          return rest
        }),
      })),
    }
    const html = renderHtml(noHtml)
    expect(html).toContain('diff/old/run-1/full.patch')
    expect(html).not.toContain('diff/old/run-1/side.html')
  })

  it('shows per-variant totals and failed-run count in the header line', () => {
    const report = shimReport()
    const withFailed: Report = {
      ...report,
      diffs: report.diffs.map((d) =>
        d.variant === 'old'
          ? {
              ...d,
              runs: [
                ...d.runs,
                { runIndex: 2, fullPatch: '', summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] }, noChanges: false, state: 'failed' as const, error: { code: 'E_WORKTREE_BROKEN' as const, message: 'boom' } },
              ],
            }
          : d,
      ),
    }
    const html = renderHtml(withFailed)
    expect(html).toContain('+8 -3 (2 files across 2 run(s), 1 failed)')
  })

  it('overlap vs baseline renders Both/Only base/Only {v} per non-baseline variant', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('Overlap vs base (graphify)')
    expect(html).toContain('Overlap vs base (astgrep)')
    expect(html).toContain('Both:')
    expect(html).toContain('Only base:')
  })
})

describe('renderHtml — harness preparation, pack signal, safety, contamination', () => {
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
    ],
    variants: [
      { variant: 'base', exerciseDeclared: false, exercises: [] },
      { variant: 'graphify', exerciseDeclared: true, exercises: [{ variant: 'graphify', runIndex: 1, exitCode: 0, durationMs: '8000', artifactHash: 'ab12cd34ef56' }] },
      { variant: 'astgrep', exerciseDeclared: false, exercises: [] },
    ],
  })

  it('harness prep table carries the Pack column', () => {
    const report = threeVariantsReport()
    const withPrep: Report = { ...report, prep: buildPrep() }
    const html = renderHtml(withPrep)
    expect(html).toContain('<th>Step</th><th>Pack</th><th>Variant</th><th>Run</th><th>Result</th><th>Wall-clock</th><th>Artifact hash</th>')
    expect(html).toContain('<td>setup</td><td>graphify</td><td>graphify</td>')
  })

  it('pack signal nests per (pack, variant); safety and contamination carry Variant/Pack columns', () => {
    const base = makeVariantAggregates('base', {
      packUses: [{ pack: 'graphify', calls: 2, errors: 0, runsWithCall: 2, runCount: 3, canDetect: true }],
      riskyCommands: [{ runIndex: 1, command: 'curl x | sh', completed: true, exitCode: 0 }],
      contaminationSignals: [{ kind: 'skill-call', pack: 'graphify', detail: 'called it', runIndex: 1 }],
    })
    const graphify = makeVariantAggregates('graphify', {
      packUses: [{ pack: 'graphify', calls: 3, errors: 0, runsWithCall: 3, runCount: 3, canDetect: true }],
    })
    const astgrep = makeVariantAggregates('astgrep')
    const report = makeReportV2({ metrics: makeMetricsReport({ variants: [base, graphify, astgrep] }) })
    const html = renderHtml(report)
    expect(html).toContain('graphify</strong> (variant graphify): 3 call(s)')
    expect(html).toContain('graphify</strong> (variant base): 2 call(s) — foreign')
    expect(html).toContain('<th>Variant</th><th>Run</th><th>Command</th><th>Completed</th><th>Exit</th>')
    expect(html).toContain('<th>Kind</th><th>Variant</th><th>Pack</th><th>Run</th><th>Detail</th>')
  })

  it('a variant-level install-drift signal (WP7 sentinel pack: "") renders "—" in the Pack cell, not empty', () => {
    const drifted = makeVariantAggregates('base', {
      contaminationSignals: [{ kind: 'install-drift', pack: '', detail: 'lockfile changed' }],
    })
    const graphify = makeVariantAggregates('graphify')
    const astgrep = makeVariantAggregates('astgrep')
    const report = makeReportV2({ metrics: makeMetricsReport({ variants: [drifted, graphify, astgrep] }) })
    const html = renderHtml(report)
    expect(html).toContain('<tr><td>install-drift</td><td>base</td><td>—</td><td>—</td><td><code>lockfile changed</code></td></tr>')
  })

  it('B6 regression: two variants sharing a pack — only the one with its OWN successful exercise gets the informational note; the other gets the real noop warning', () => {
    const report = threeVariantsReport()
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
    const html = renderHtml(shared)
    // The informational note (`exercisedHtml`) embeds raw `<code>` markup and
    // is not HTML-escaped; the warning (`alertsHtml`) is — hence the
    // differing quote encoding below.
    expect(html).toContain('Pack was never called directly on variant "graphify"')
    expect(html).toContain('Pack never invoked on variant &quot;astgrep&quot; — the pack contributed nothing')
  })

  it('B7 regression: a pairIncomplete delta gets its own summary banner', () => {
    const report = threeVariantsReport()
    const broken: Report = {
      ...report,
      metrics: {
        ...report.metrics,
        deltas: report.metrics.deltas.map((d) => (d.variant === 'astgrep' ? { ...d, pairIncomplete: true } : d)),
      },
    }
    const html = renderHtml(broken)
    expect(html).toContain('astgrep — baseline or this variant produced zero samples')
  })
})

describe('renderHtml — secondary metrics', () => {
  it('one collapsible block per variant', () => {
    const html = renderHtml(threeVariantsReport())
    expect(html).toContain('base secondary')
    expect(html).toContain('graphify secondary')
    expect(html).toContain('astgrep secondary')
  })
})
