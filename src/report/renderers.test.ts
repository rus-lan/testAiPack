import { describe, it, expect } from 'vitest'
import { renderJson } from './json.js'
import { renderYaml } from './yaml.js'
import { renderHtml } from './html.js'
import { reportSchema } from '@generated/schemas'
import { makeReport, makeDiffResult } from '../../tests/report-fixture.js'
import { makeMetricsDiff, makeSideAggregates } from '../../tests/report-fixture.js'
import type { Report } from '@generated/types'

describe('renderJson', () => {
  it('produces valid JSON that round-trips through reportSchema', () => {
    const report = makeReport()
    const parsed = JSON.parse(renderJson(report)) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
  })

  it('throws when the report fails schema validation', () => {
    const invalid = {
      ...makeReport(),
      manifest: { ...makeReport().manifest, runId: 123 },
    } as unknown as Report
    expect(() => renderJson(invalid)).toThrow(/schema validation/)
  })
})

describe('renderYaml', () => {
  it('produces non-empty YAML', () => {
    const text = renderYaml(makeReport())
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('manifest:')
  })

  it('throws when the report fails schema validation', () => {
    const invalid = {
      ...makeReport(),
      manifest: { ...makeReport().manifest, runId: 123 },
    } as unknown as Report
    expect(() => renderYaml(invalid)).toThrow(/schema validation/)
  })
})

describe('renderHtml', () => {
  it('renders a self-contained HTML document with the headline and table', () => {
    const html = renderHtml(makeReport())
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Primary metrics')
    expect(html).toContain('Total tokens')
    expect(html).toContain('LLM Judge')
    expect(html).toContain('timeline.html')
  })

  it('has no external dependencies (no http(s) imports or src)', () => {
    const html = renderHtml(makeReport())
    expect(html).not.toMatch(/src="https?:\/\//)
    expect(html).not.toMatch(/href="https?:\/\//)
    expect(html).not.toMatch(/@import|url\(https?:\/\//)
  })

  it('header carries runId, repoUrl and packRef', () => {
    const html = renderHtml(makeReport())
    expect(html).toContain('run-abc-001')
    expect(html).toContain('https://example.com/repo.git')
  })

  it('color-codes the verdict cells (better/worse/neutral)', () => {
    const html = renderHtml(makeReport())
    const totalTokensRow = html.match(/<tr><td>Total tokens<\/td>.*?<\/tr>/s)
    const wallClockRow = html.match(/<tr><td>Wall-clock \(ms\)<\/td>.*?<\/tr>/s)
    const successRankRow = html.match(/<tr><td>Success rank<\/td>.*?<\/tr>/s)
    expect(totalTokensRow?.[0]).toMatch(/class="better"/)
    expect(wallClockRow?.[0]).toMatch(/class="worse"/)
    expect(successRankRow?.[0]).toMatch(/class="neutral"/)
  })

  it('renders Improvements, Regressions and Neutral bucket lists', () => {
    const html = renderHtml(makeReport())
    expect(html).toContain('Improvements')
    expect(html).toContain('Regressions')
    expect(html).toContain('Neutral')
    expect(html).toContain('Total tokens')
  })

  it('renders a diff section with patch and side.html links', () => {
    const report = makeReport({
      diff: {
        old: makeDiffResult('old', {
          runs: [
            {
              runIndex: 1,
              fullPatch: 'p',
              summary: { filesChanged: 2, additions: 8, deletions: 3, perFile: [] },
              noChanges: false,
            },
          ],
        }),
        new: makeDiffResult('new'),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('Diff summary')
    expect(html).toContain('diff/old/run-1/full.patch')
    expect(html).toContain('diff/new/run-1/side.html')
  })

  it('shows a Failed runs section when failures exist', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        failedRuns: [
          {
            runIndex: 1,
            errorCode: 'E_RUN_CRASH',
            errorMessage: 'boom',
            timestamp: '2025-01-01T00:02:00.000Z',
          },
        ],
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('Failed runs')
  })

  it('emits the both-failed warning', () => {
    const html = renderHtml(
      makeReport({ metricsDiff: { ...makeMetricsDiff(), bothFailed: true } }),
    )
    expect(html).toContain('Both sides failed')
  })

  it('shows the unclear judge note', () => {
    const html = renderHtml(
      makeReport({
        judge: {
          verdict: 'unclear',
          oldQuality: 5,
          newQuality: 5,
          explanation: 'x',
          modelUsed: 'm',
          timestamp: '2025-01-01T00:05:00.000Z',
        },
      }),
    )
    expect(html).toContain('(unclear)')
  })

  it('omits judge and shows not-requested when judge absent', () => {
    const { judge: _drop, ...withoutJudge } = makeReport()
    const html = renderHtml(withoutJudge)
    expect(html).toContain('Judge was not requested')
  })
})
