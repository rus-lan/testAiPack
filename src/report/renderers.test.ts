import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { renderJson } from './json.js'
import { renderYaml } from './yaml.js'
import { renderHtml } from './html.js'
import { reportSchema } from '@generated/schemas'
import { makeReport, makeDiffResult } from '../../tests/report-fixture.js'
import { makeMetricsDiff, makeSideAggregates, makeManifest } from '../../tests/report-fixture.js'
import type { JudgeResult, Report } from '@generated/types'
import { redactUrlCredentials } from '../util/redact.js'
import { safeRefDisplay } from '../pack/detector.js'

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> => Effect.runPromise(Effect.flip(fa))

describe('renderJson', () => {
  it('produces valid JSON that round-trips through reportSchema', async () => {
    const report = makeReport()
    const parsed = JSON.parse(await runP(renderJson(report))) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
  })

  it('fails with a typed PhaseError when the report fails schema validation', async () => {
    const invalid = {
      ...makeReport(),
      manifest: { ...makeReport().manifest, runId: 123 },
    } as unknown as Report
    const err = await runFlip(renderJson(invalid))
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.message).toContain('schema validation')
  })

  it('an old report.json missing PackUse.visibilityConfirmed (pre-dates the field) still passes schema validation', async () => {
    const report = makeReport({
      metricsDiff: makeMetricsDiff({
        new: makeSideAggregates('new', {
          packUse: { calls: 1, errors: 0, runsWithCall: 1, runCount: 3, canDetect: true },
        }),
      }),
    })
    const parsed = JSON.parse(await runP(renderJson(report))) as unknown
    expect(reportSchema.safeParse(parsed).success).toBe(true)
  })
})

describe('renderYaml', () => {
  it('produces non-empty YAML', async () => {
    const text = await runP(renderYaml(makeReport()))
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('manifest:')
  })

  it('fails with a typed PhaseError when the report fails schema validation', async () => {
    const invalid = {
      ...makeReport(),
      manifest: { ...makeReport().manifest, runId: 123 },
    } as unknown as Report
    const err = await runFlip(renderYaml(invalid))
    expect(err.code).toBe('E_EXPORT_INVALID')
    expect(err.message).toContain('schema validation')
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

  it('judge.ran === false renders "did not run" without verdict/quality', () => {
    const didNotRun: JudgeResult = {
      verdict: 'unclear',
      oldQuality: 0,
      newQuality: 0,
      explanation: 'judge crashed (exit 1)',
      modelUsed: '',
      timestamp: '2025-01-01T00:05:00.000Z',
      ran: false,
    }
    const html = renderHtml(makeReport({ judge: didNotRun }))
    expect(html).toContain('Judge did not run: judge crashed (exit 1)')
    expect(html).not.toContain('Verdict:')
    expect(html).not.toContain('quality old=')
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

  it('header init-side: absent without --init; "both" called out as the contamination mechanism; "new" plain', () => {
    const withoutInit = renderHtml(makeReport())
    expect(withoutInit).not.toContain('Init side:')

    const both = renderHtml(makeReport({ manifest: makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'both' } }) }))
    expect(both).toContain('<strong>Init side:</strong> both — sent to both sides; this is how a baseline can pick up the pack under test')

    const onNew = renderHtml(makeReport({ manifest: makeManifest({ init: '/graphify .', flagDefaults: { initSide: 'new' } }) }))
    expect(onNew).toContain(
      '<strong>Init side:</strong> new — only the NEW side&#39;s metrics carry the init call&#39;s cost (tokens, steps, tool calls, wall-clock); that asymmetry is expected, not a measurement error',
    )
    expect(onNew).not.toContain('sent to both sides')

    const preDates = renderHtml(makeReport({ manifest: makeManifest({ init: '/graphify .', flagDefaults: {} }) }))
    expect(preDates).toContain('<strong>Init side:</strong> unknown (report predates --init-side)')
  })

  it('never echoes a credential when given an already-redacted manifest (the shape buildManifest produces)', () => {
    const manifest = {
      ...makeReport().manifest,
      repoUrl: redactUrlCredentials('https://user:ghp_secrettoken@github.com/org/repo.git'),
      packRef: safeRefDisplay(redactUrlCredentials('mcp:srv:{"env":{"API_KEY":"sk-fake-secret"}}')),
    }
    const html = renderHtml(makeReport({ manifest }))
    expect(html).not.toContain('ghp_secrettoken')
    expect(html).not.toContain('user:')
    expect(html).not.toContain('sk-fake-secret')
    expect(html).not.toContain('API_KEY')
  })

  it('primary table has a Significant column, like md.ts', () => {
    const html = renderHtml(makeReport())
    expect(html).toContain('<th>Significant</th>')
    const totalTokensRow = html.match(/<tr><td>Total tokens<\/td>.*?<\/tr>/s)
    // sigLabel always returns one of these four strings — this proves the
    // column is populated per row, not just present in the header.
    expect(totalTokensRow?.[0]).toMatch(/✓ significant|⚠ significant|>significant<|—/)
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
        new: makeDiffResult('new', {
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
              // The href always points at the conventional relative path
              // (see the comment in html.ts); only the presence of
              // htmlPath decides whether the link is shown at all.
              htmlPath: '/abs/new/side.html',
            },
          ],
        }),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('Diff summary')
    expect(html).toContain('diff/old/run-1/full.patch')
    expect(html).toContain('diff/new/run-1/side.html')
    expect(html).not.toContain('/abs/new/side.html')
  })

  it('omits the side.html link when htmlPath is absent (--diff-html was off)', () => {
    const report = makeReport({
      diff: {
        old: makeDiffResult('old'),
        new: makeDiffResult('new'),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('diff/old/run-1/full.patch')
    expect(html).not.toContain('diff/old/run-1/side.html')
  })

  it('diff summary shows per-side totals and failed-run count in the header line, like md.ts', () => {
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
            {
              runIndex: 2,
              fullPatch: '',
              summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
              noChanges: false,
              state: 'failed',
              error: { code: 'E_WORKTREE_BROKEN', message: 'boom' },
            },
          ],
        }),
        new: makeDiffResult('new'),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('+8 -3 (2 files across 2 run(s), 1 failed)')
  })

  it('html renderDiff: failed run row has no links and shows escaped error message', () => {
    const report = makeReport({
      diff: {
        old: makeDiffResult('old', {
          runs: [
            {
              runIndex: 1,
              fullPatch: '',
              summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
              noChanges: false,
              state: 'failed',
              error: { code: 'E_WORKTREE_BROKEN', message: 'git add -A failed <exit 128>' },
            },
          ],
        }),
        new: makeDiffResult('new'),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('diff failed')
    expect(html).toContain('git add -A failed &lt;exit 128&gt;')
    expect(html).not.toContain('diff/old/run-1/full.patch')
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

  it('primary table renders [min–max] columns and a dash for maxParallelism', () => {
    const html = renderHtml(makeReport())
    expect(html).toContain('Old [min–max]')
    expect(html).toContain('New [min–max]')
    const maxParallelismRow = html.match(/<tr><td>Max parallelism<\/td>.*?<\/tr>/s)
    expect(maxParallelismRow?.[0]).toContain('<td>—</td>')
  })

  it('header warns on version drift; silent when versions match or absent', () => {
    const drift = makeMetricsDiff({
      old: makeSideAggregates('old', { opencodeVersions: ['1.18.4'] }),
      new: makeSideAggregates('new', { opencodeVersions: ['1.18.4'] }),
    })
    const withDrift = renderHtml(makeReport({ metricsDiff: drift, manifest: { ...makeReport().manifest, opencodeVersion: '1.18.3' } }))
    expect(withDrift).toContain('version differs from manifest: manifest says 1.18.3, runs used 1.18.4')

    const noDrift = renderHtml(makeReport())
    expect(noDrift).not.toContain('version differs from manifest')
  })

  it('pack section renders counts; warns when new side calls=0 and canDetect; not-visible when canDetect false; absent when packUse absent', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        packUse: { calls: 1, errors: 1, runsWithCall: 1, runCount: 5, firstCallMsMedian: '64043', canDetect: true, visibilityConfirmed: false },
      }),
      new: makeSideAggregates('new', {
        packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: false },
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('Pack signal')
    expect(html).toContain('1 call(s), 1 error(s), 1/5 runs')
    expect(html).toContain('Pack was never invoked on the NEW side')

    const notVisible = renderHtml(
      makeReport({
        metricsDiff: makeMetricsDiff({
          old: makeSideAggregates('old', { packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 3, canDetect: false, visibilityConfirmed: false } }),
        }),
      }),
    )
    expect(notVisible).toContain('pack use is not visible for this pack type')

    const absent = renderHtml(makeReport())
    expect(absent).not.toContain('Pack signal')
  })

  it('pack section distinguishes confirmed-visible-but-unused from visibility-not-confirmed at calls=0', () => {
    const confirmed = renderHtml(
      makeReport({
        metricsDiff: makeMetricsDiff({
          new: makeSideAggregates('new', {
            packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: true },
          }),
        }),
      }),
    )
    expect(confirmed).toContain('preflight confirmed it was visible, so the model chose not to call it')
    expect(confirmed).toContain('(confirmed visible, not called)')

    const unconfirmed = renderHtml(
      makeReport({
        metricsDiff: makeMetricsDiff({
          new: makeSideAggregates('new', {
            packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true, visibilityConfirmed: false },
          }),
        }),
      }),
    )
    expect(unconfirmed).toContain('(visibility not confirmed)')
    expect(unconfirmed).not.toContain('confirmed visible, not called')
  })

  it('visibilityConfirmed entirely absent (old report.json, pre-dates the field) degrades to "not confirmed", not a crash or "undefined"', () => {
    const html = renderHtml(
      makeReport({
        metricsDiff: makeMetricsDiff({
          new: makeSideAggregates('new', {
            packUse: { calls: 0, errors: 0, runsWithCall: 0, runCount: 5, canDetect: true },
          }),
        }),
      }),
    )
    expect(html).toContain('(visibility not confirmed)')
    expect(html).not.toContain('undefined')
  })

  it('safety section lists commands escaped; absent when empty', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        riskyCommands: [{ runIndex: 1, command: 'rm -rf x <danger>', completed: true, exitCode: 0 }],
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('Safety')
    expect(html).toContain('rm -rf x &lt;danger&gt;')

    const empty = renderHtml(makeReport())
    expect(empty).not.toContain('>Safety<')
  })

  it('backticks in a risky command survive byte-identical in HTML — backtick has no special meaning in <code>, so nothing needs escaping or substituting', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        riskyCommands: [{ runIndex: 1, command: 'echo `whoami` ``` `edge`', completed: true, exitCode: 0 }],
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('<code>echo `whoami` ``` `edge`</code>')
  })

  it('baseline contamination section lists signals escaped; absent when empty; alert in Summary', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        contaminationSignals: [
          { kind: 'bash-install', detail: 'graphify install <danger>', runIndex: 2 },
          { kind: 'install-drift', detail: "captured config differs across this side's own runs in: skills" },
        ],
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('Baseline contamination')
    expect(html).toContain('graphify install &lt;danger&gt;')
    expect(html).toContain('<td>bash-install</td><td>2</td>')
    // install-drift has no runIndex — renders as an em dash, not a fabricated 0
    expect(html).toContain('<td>install-drift</td><td>—</td>')
    expect(html).toContain('Baseline contamination: the OLD side shows 2 sign(s)')

    const empty = renderHtml(makeReport())
    expect(empty).not.toContain('>Baseline contamination<')
    expect(empty).not.toContain('Baseline contamination:')
  })

  it('backticks in a contamination detail survive byte-identical in HTML', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        contaminationSignals: [{ kind: 'bash-install', detail: 'npm install `evil` ``` `edge`', runIndex: 1 }],
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('<code>npm install `evil` ``` `edge`</code>')
  })

  it('warns on the LLM Judge section when contamination is detected, without altering the verdict itself', () => {
    const ranJudge: JudgeResult = {
      verdict: 'ok',
      oldQuality: 7,
      newQuality: 8,
      explanation: 'New side produces cleaner output.',
      modelUsed: 'gpt-test',
      timestamp: '2025-01-01T00:05:00.000Z',
    }
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        contaminationSignals: [{ kind: 'skill-call', detail: 'skill tool call succeeded for "graphify"' }],
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff, judge: ranJudge }))
    const judgeIdx = html.indexOf('<h2>LLM Judge</h2>')
    const warnIdx = html.indexOf('Baseline contamination detected (1 sign(s))', judgeIdx)
    expect(warnIdx).toBeGreaterThan(judgeIdx)
    expect(html).toContain('Verdict: <strong>ok</strong>')

    const clean = renderHtml(makeReport({ judge: ranJudge }))
    expect(clean).not.toContain('Baseline contamination detected')
  })

  it('secondary renders four groups as <details>, first one open', () => {
    const html = renderHtml(makeReport())
    expect(html).toContain('<summary>Behavior</summary>')
    expect(html).toContain('<summary>Latency</summary>')
    expect(html).toContain('<summary>Tokens &amp; context</summary>')
    expect(html).toContain('<summary>Output volume</summary>')
    const behaviorIdx = html.indexOf('<summary>Behavior</summary>')
    const detailsStart = html.lastIndexOf('<details', behaviorIdx)
    expect(html.slice(detailsStart, detailsStart + 20)).toContain('open')
  })

  it('Behavior group: no <li><li> nesting; tool list is its own bullet', () => {
    const html = renderHtml(makeReport())
    expect(html).not.toContain('<li><li>')
    expect(html).toContain('Tools (top 20):<ul>')
  })

  it('unstable flag carries a max/min ratio', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        stats: {
          ...makeSideAggregates('old').stats,
          wallClockMs: { median: 168791, min: 73730, max: 723560, iqr: 602674, samples: [73730, 168791, 168791, 723560] },
        },
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('unstable: Wall-clock (ms) (9.8×)')
  })

  it('diff summary explains git-restored/git-replaced markers in one phrase, no scrolling to Safety needed', () => {
    const report = makeReport({
      diff: {
        old: makeDiffResult('old', {
          runs: [{ runIndex: 1, fullPatch: 'p', summary: { filesChanged: 1, additions: 1, deletions: 0, perFile: [] }, noChanges: false, state: 'git-restored' }],
        }),
        new: makeDiffResult('new'),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('agent deleted .git, restored from clean clone')
  })

  it('secondary lines for bash fails / invalid / duplicates / error texts; skipped when undefined', () => {
    const withData = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          bashFailCount: 5,
          invalidToolCalls: 1,
          duplicateToolCalls: 5,
          toolErrorTexts: ['broke <badly>'],
        },
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff: withData }))
    expect(html).toContain('Bash fails (exit != 0): 5 of')
    expect(html).toContain('Invalid tool calls: 1; duplicate calls: 5')
    expect(html).toContain('broke &lt;badly&gt;')

    const withoutData = renderHtml(makeReport())
    expect(withoutData).not.toContain('Bash fails')
    expect(withoutData).not.toContain('Invalid tool calls')
  })

  it('latency line renders P5 values; context line renders step tokens; volume line renders chars', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          timeToFirstToolMs: '200',
          timeToFirstEditMs: '500',
          maxEventGapMs: '252915',
          firstStepInputTokens: '5491',
          lastStepInputTokens: '18184',
          textChars: '1003',
          reasoningChars: '4107',
        },
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('First tool: +200ms; first edit: +500ms; worst stall: 252915ms (~4.2min) (max over runs)')
    expect(html).toContain('Context: first step in=5491 tok, last step in=18184 tok')
    expect(html).toContain('Output: text 1003 ch, reasoning 4107 ch')
  })

  it('large first-edit offset reads as minutes; stall count and threshold label appear beside the max', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        secondary: {
          ...makeSideAggregates('old').secondary,
          timeToFirstEditMs: '90986',
          maxEventGapMs: '252915',
          stallCount: 3,
          stalledRunCount: 2,
        },
      }),
    })
    const html = renderHtml(makeReport({ metricsDiff }))
    expect(html).toContain('First edit: +90986ms (~1.5min)')
    expect(html).toContain('worst stall: 252915ms (~4.2min) (max over runs); 3 stall(s) over 60s across 2 run(s)')
  })

  it('reasoning share appended as percent of wall-clock; skipped when wallClockMs is 0', () => {
    const withShare = renderHtml(makeReport())
    expect(withShare).toMatch(/Reasoning time: \d+ms \(\d+% of wall-clock\)/)

    const zeroWall = makeMetricsDiff({
      old: makeSideAggregates('old', { primary: { ...makeSideAggregates('old').primary, wallClockMs: '0' } }),
    })
    const html = renderHtml(makeReport({ metricsDiff: zeroWall }))
    const oldIdx = html.indexOf('OLD secondary')
    const newIdx = html.indexOf('NEW secondary')
    expect(html.slice(oldIdx, newIdx)).not.toMatch(/% of wall-clock/)
  })

  it('stability line includes verify pass rate when verifyStats present; absent otherwise', () => {
    const withVerify = makeMetricsDiff({
      old: makeSideAggregates('old', { verifyStats: { passed: 3, failed: 1, timedOut: 1, runCount: 5 } }),
    })
    const html = renderHtml(makeReport({ metricsDiff: withVerify }))
    expect(html).toContain('verify: 3/5 passed (1 failed, 1 timed out)')

    const noVerify = renderHtml(makeReport())
    expect(noVerify).not.toContain('verify:')
  })

  it('success-rate denominator counts crashed runs — uses manifest.runs, not samples.length', () => {
    const statFor = (median: number, min: number, max: number, samples: readonly number[]) => ({
      median, min, max, samples: [...samples],
    })
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        stats: {
          ...makeSideAggregates('old').stats,
          // 3 successful runs (all rank >= 3); the other 2 of 5 attempted
          // runs crashed and never produced a successRank sample at all.
          successRank: statFor(4, 3, 4, [4, 4, 3]),
        },
      }),
    })
    const manifest = makeManifest({ runs: 5 })
    const html = renderHtml(makeReport({ metricsDiff, manifest }))
    expect(html).toContain('success rate 3/5 (60%)')
    expect(html).not.toContain('success rate 3/3')
  })

  it('diff efficiency ratio scales the per-run median by the diffed-run count, not by all metric-successful runs', () => {
    const metricsDiff = makeMetricsDiff({
      old: makeSideAggregates('old', {
        primary: { ...makeSideAggregates('old').primary, totalTokens: '1000', costUsd: 2 },
      }),
    })
    const report = makeReport({
      metricsDiff,
      diff: {
        old: makeDiffResult('old', {
          runs: [
            {
              runIndex: 1,
              fullPatch: 'p',
              summary: { filesChanged: 2, additions: 50, deletions: 50, perFile: [] },
              noChanges: false,
            },
            {
              runIndex: 2,
              fullPatch: 'p',
              summary: { filesChanged: 2, additions: 50, deletions: 50, perFile: [] },
              noChanges: false,
            },
            {
              runIndex: 3,
              fullPatch: '',
              summary: { filesChanged: 0, additions: 0, deletions: 0, perFile: [] },
              noChanges: false,
              state: 'failed',
              error: { code: 'E_WORKTREE_BROKEN', message: 'boom' },
            },
          ],
        }),
        new: makeDiffResult('new'),
      },
    })
    const html = renderHtml(report)
    // 2 diffed runs (1 of 3 failed) x median 1000 tokens / 200 changed lines = 10
    // 2 diffed runs x median $2 / 4 files = 1
    expect(html).toContain('Efficiency: tokens per changed line 10, cost per file 1 (scaled from the per-run median over 2 diffed run(s))')
  })

  it('diff section shows tokens-per-line and cost-per-file; per-file overlap lists both/only-old/only-new', () => {
    const report = makeReport({
      diff: {
        old: makeDiffResult('old', {
          runs: [
            {
              runIndex: 1,
              fullPatch: 'p',
              summary: {
                filesChanged: 2,
                additions: 8,
                deletions: 3,
                perFile: [
                  { path: 'shared.ts', additions: 4, deletions: 1 },
                  { path: 'old-only.ts', additions: 4, deletions: 2 },
                ],
              },
              noChanges: false,
            },
          ],
        }),
        new: makeDiffResult('new', {
          runs: [
            {
              runIndex: 1,
              fullPatch: 'p',
              summary: {
                filesChanged: 2,
                additions: 5,
                deletions: 1,
                perFile: [
                  { path: 'shared.ts', additions: 3, deletions: 1 },
                  { path: 'new-only.ts', additions: 2, deletions: 0 },
                ],
              },
              noChanges: false,
            },
          ],
        }),
      },
    })
    const html = renderHtml(report)
    expect(html).toContain('Efficiency: tokens per changed line')
    expect(html).toContain('cost per file')
    expect(html).toContain('diffed run(s)')
    expect(html).toContain('Per-file overlap')
    expect(html).toContain('shared.ts')
    expect(html).toContain('old-only.ts')
    expect(html).toContain('new-only.ts')
  })
})
