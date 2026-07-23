import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Effect } from 'effect'
import path from 'node:path'
import { makeTempDir } from '../../tests/setup.js'
import { ensureDir, writeFile } from '../util/fs.js'
import { cliParse } from './00-cli-parse.js'
import type { CliParseOutput } from './00-cli-parse.js'
import { PhaseError } from '../errors.js'

vi.mock('../util/docker.js', () => ({
  isDockerAvailable: vi.fn(),
  DOCKER_PROBE_TIMEOUT_MS: 3000,
}))

import { isDockerAvailable } from '../util/docker.js'

const dockerMock = vi.mocked(isDockerAvailable)

const runP = <A, E>(fa: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(fa)
const runFlip = <A, E>(fa: Effect.Effect<A, E>): Promise<E> =>
  Effect.runPromise(Effect.flip(fa))

const ensureDirP = (p: string): Promise<void> => runP(ensureDir(p))
const writeFileP = (p: string, c: string): Promise<void> => runP(writeFile(p, c))

const REPO = 'https://github.com/example/repo.git'

beforeEach(() => {
  dockerMock.mockReset()
  dockerMock.mockReturnValue(Effect.succeed(true))
})

describe('cliParse — happy path', () => {
  it('minimal run args produce defaults (runs=3, isolation=home, formats=[md], configSource=cli)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'fix bug'], cwd }))
    const ri = result.runInput
    expect(ri.repoUrl).toBe(REPO)
    expect(ri.prompt).toBe('fix bug')
    expect(ri.runs).toBe(3)
    expect(ri.isolation).toBe('home')
    expect(ri.formats).toEqual(['md'])
    expect(ri.pureBaseline).toBe(true)
    expect(ri.preflightEnabled).toBe(true)
    expect(ri.collapseRepeats).toBe(false)
    expect(ri.timelineMode).toBe('side-by-side')
    expect(ri.logLevel).toBe('info')
    expect(ri.outputPath).toBe('./results')
    expect(ri.workspacePath).toBe('./.testaipack')
    expect(ri.auth).toEqual({
      opencode: true, npmrc: true, anthropic: false, openai: false,
      gemini: false, aws: false, ssh: false, git: false,
    })
    expect(result.configSource).toBe('cli')
    expect(result.flagDefaults.dockerDowngraded).toBe(false)
  })

  it('strips a leading "run" subcommand token', async () => {
    const cwd = makeTempDir()
    const r1 = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    const r2 = await runP(cliParse({ argv: [REPO, '--prompt', 'x'], cwd }))
    expect(r1.runInput.prompt).toBe(r2.runInput.prompt)
  })
})

describe('cliParse — config file', () => {
  it('uses config-only values → configSource=config', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, '.testaipack'))
    await writeFileP(
      path.join(cwd, '.testaipack', 'config.json'),
      JSON.stringify({ repoUrl: REPO, prompt: 'from config', runs: 7 }),
    )
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.prompt).toBe('from config')
    expect(result.runInput.runs).toBe(7)
    expect(result.configSource).toBe('config')
  })

  it('CLI overrides config → configSource=merged', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, '.testaipack'))
    await writeFileP(
      path.join(cwd, '.testaipack', 'config.json'),
      JSON.stringify({ repoUrl: REPO, prompt: 'cfg', runs: 5 }),
    )
    const result = await runP(cliParse({ argv: ['run', '--runs', '2'], cwd }))
    expect(result.runInput.runs).toBe(2)
    expect(result.runInput.prompt).toBe('cfg')
    expect(result.configSource).toBe('merged')
  })

  it('explicit configFile path overrides the default location', async () => {
    const cwd = makeTempDir()
    await ensureDirP(cwd)
    const cfg = path.join(cwd, 'custom.json')
    await writeFileP(cfg, JSON.stringify({ repoUrl: REPO, prompt: 'custom file' }))
    const result = await runP(cliParse({ argv: ['run'], cwd, configFile: cfg }))
    expect(result.runInput.prompt).toBe('custom file')
    expect(result.configSource).toBe('config')
  })

  it('a malformed config.json → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, '.testaipack'))
    await writeFileP(path.join(cwd, '.testaipack', 'config.json'), '{ not json')
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('a config.json that violates the schema → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, '.testaipack'))
    await writeFileP(
      path.join(cwd, '.testaipack', 'config.json'),
      JSON.stringify({ runs: 'not-a-number' }),
    )
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — validation errors', () => {
  it('missing --prompt (and no config) → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('missing repoUrl → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--runs 0 → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--runs', '0'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--runs -1 → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--runs', '-1'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('--runs non-integer → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--runs', 'abc'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --isolation → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--isolation', 'foo'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --timeline-mode → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--timeline-mode', 'wat'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --log-level → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--log-level', 'loud'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('invalid --pack-type → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--pack-type', 'nope'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('unknown flag → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--bogus', 'y'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — @file prompt', () => {
  it('reads a single @file into prompt and records promptFiles', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, 'prompts'))
    await writeFileP(path.join(cwd, 'prompts', 'fix.md'), 'fix the bug')
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', '@prompts/fix.md'], cwd }))
    expect(result.runInput.prompt).toBe('fix the bug')
    expect(result.runInput.promptFiles).toEqual([path.join(cwd, 'prompts', 'fix.md')])
  })

  it('concatenates multiple @file in flag order with \\n\\n', async () => {
    const cwd = makeTempDir()
    await ensureDirP(cwd)
    await writeFileP(path.join(cwd, 'a.md'), 'AAA')
    await writeFileP(path.join(cwd, 'b.md'), 'BBB')
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', '@a.md', '--prompt', '@b.md'], cwd }),
    )
    expect(result.runInput.prompt).toBe('AAA\n\nBBB')
    expect(result.runInput.promptFiles).toEqual([path.join(cwd, 'a.md'), path.join(cwd, 'b.md')])
  })

  it('mixes literal and @file prompts', async () => {
    const cwd = makeTempDir()
    await ensureDirP(cwd)
    await writeFileP(path.join(cwd, 'a.md'), 'FILE')
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'LITERAL', '--prompt', '@a.md'], cwd }),
    )
    expect(result.runInput.prompt).toBe('LITERAL\n\nFILE')
  })

  it('a missing @file → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', '@nope.md'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — formats', () => {
  it('--format all expands to [md, html, json, yaml]', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--format', 'all'], cwd }))
    expect(result.runInput.formats.sort()).toEqual(['html', 'json', 'md', 'yaml'])
  })

  it('repeated --format accumulates', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--format', 'md', '--format', 'json'], cwd }),
    )
    expect(result.runInput.formats).toEqual(['md', 'json'])
  })

  it('invalid format value → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--format', 'pdf'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — pack', () => {
  it('absent --pack → smoke-test (packRef/packType undefined, no error)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.packRef).toBeUndefined()
    expect(result.runInput.packType).toBeUndefined()
  })

  it('--pack npm:myplugin auto-detects packType=plugin', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:myplugin'], cwd }))
    expect(result.runInput.packRef).toBe('npm:myplugin')
    expect(result.runInput.packType).toBe('plugin')
  })

  it('--pack github:owner/skill auto-detects packType=skill', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'github:owner/skill'], cwd }))
    expect(result.runInput.packType).toBe('skill')
  })

  it('--pack ./local/skill auto-detects packType=skill', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', './local/skill'], cwd }))
    expect(result.runInput.packType).toBe('skill')
  })

  it('explicit --pack-type overrides auto-detect', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:x', '--pack-type', 'all'], cwd }),
    )
    expect(result.runInput.packType).toBe('all')
  })
})

describe('cliParse — docker downgrade', () => {
  it('--isolation docker with no daemon → isolation=home, dockerDowngraded=true', async () => {
    dockerMock.mockReturnValue(Effect.succeed(false))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--isolation', 'docker'], cwd }))
    expect(result.runInput.isolation).toBe('home')
    expect(result.flagDefaults.dockerDowngraded).toBe(true)
  })

  it('--isolation docker with daemon available → stays docker', async () => {
    dockerMock.mockReturnValue(Effect.succeed(true))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--isolation', 'docker'], cwd }))
    expect(result.runInput.isolation).toBe('docker')
    expect(result.flagDefaults.dockerDowngraded).toBe(false)
  })

  it('--isolation home never probes docker', async () => {
    dockerMock.mockReturnValue(Effect.succeed(false))
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.isolation).toBe('home')
    expect(result.flagDefaults.dockerDowngraded).toBe(false)
    expect(dockerMock).not.toHaveBeenCalled()
  })
})

describe('cliParse — result shape', () => {
  it('produced RunInput round-trips through the Zod runInputSchema', async () => {
    const cwd = makeTempDir()
    const result: CliParseOutput = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--pack', 'npm:p'], cwd }),
    )
    const { runInputSchema } = await import('@generated/schemas')
    const parsed = runInputSchema.safeParse(result.runInput)
    expect(parsed.success).toBe(true)
  })
})

describe('cliParse — model availability (E_MODEL_UNAVAILABLE)', () => {
  it('bare model name without provider prefix → E_MODEL_UNAVAILABLE', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'invalidformat'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_MODEL_UNAVAILABLE')
  })

  it('provider/model form → OK', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'anthropic/glm-5.2'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('anthropic/glm-5.2')
  })

  it('provider:model form → OK', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--preflight-model', 'openai:gpt-4o'], cwd }),
    )
    expect(result.runInput.preflightModel).toBe('openai:gpt-4o')
  })

  it('no --preflight-model → OK (smoke-test, no validation)', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.preflightModel).toBeUndefined()
  })
})

describe('cliParse — watchdog flag', () => {
  it('default watchdog timeout is 90s', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.timeouts.watchdogSeconds).toBe(90)
  })

  it('--watchdog sets the watchdog timeout', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--watchdog', '120'], cwd }),
    )
    expect(result.runInput.timeouts.watchdogSeconds).toBe(120)
  })

  it('--timeout-watchdog is no longer a known flag → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--timeout-watchdog', '120'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — flags surface', () => {
  it('accepts the full set of value/boolean flags and reflects them on RunInput', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: [
          'run', REPO, '--prompt', 'x',
          '--output', '/tmp/out', '--workspace', '/tmp/ws',
          '--opencode-version', '2.0.0', '--preflight-model', 'anthropic/glm-5.2',
          '--pricing-path', '/p.json', '--timeout-install', '42',
          '--auth', 'anthropic', '--auth', 'ssh',
          '--init', 'do setup', '--verify', 'check it', '--judge', 'decide',
          '--timeline-mode', 'tree-diff', '--log-level', 'debug',
          '--no-pure-baseline', '--no-preflight', '--diff-html', '--no-collapse-repeats',
        ],
        cwd,
      }),
    )
    const ri = result.runInput
    expect(ri.outputPath).toBe('/tmp/out')
    expect(ri.workspacePath).toBe('/tmp/ws')
    expect(ri.opencodeVersion).toBe('2.0.0')
    expect(ri.preflightModel).toBe('anthropic/glm-5.2')
    expect(ri.pricingPath).toBe('/p.json')
    expect(ri.timeouts.installSeconds).toBe(42)
    expect(ri.auth.anthropic).toBe(true)
    expect(ri.auth.ssh).toBe(true)
    expect(ri.init).toBe('do setup')
    expect(ri.initFiles).toEqual([])
    expect(ri.verify).toBe('check it')
    expect(ri.judge).toBe('decide')
    expect(ri.timelineMode).toBe('tree-diff')
    expect(ri.logLevel).toBe('debug')
    expect(ri.pureBaseline).toBe(false)
    expect(ri.preflightEnabled).toBe(false)
    expect(ri.diffHtml).toBe(true)
    expect(ri.collapseRepeats).toBe(false)
  })

  it('supports the --flag=value inline form', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt=x', '--runs=5'], cwd }))
    expect(result.runInput.prompt).toBe('x')
    expect(result.runInput.runs).toBe(5)
  })

  it('rejects a second positional argument', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, 'extra', '--prompt', 'x'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })

  it('rejects a value flag with no value', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(cliParse({ argv: ['run', REPO, '--prompt'], cwd }))
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})

describe('cliParse — auth whitelist', () => {
  it('default (no auth flags) → opencode=true, npmrc=true, rest false', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x'], cwd }))
    expect(result.runInput.auth).toEqual({
      opencode: true, npmrc: true, anthropic: false, openai: false,
      gemini: false, aws: false, ssh: false, git: false,
    })
  })

  it('--no-auth-opencode disables only opencode (npmrc stays default-on)', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-auth-opencode'], cwd }),
    )
    expect(result.runInput.auth.opencode).toBe(false)
    expect(result.runInput.auth.npmrc).toBe(true)
  })

  it('--no-auth-npmrc disables only npmrc', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-auth-npmrc'], cwd }),
    )
    expect(result.runInput.auth.npmrc).toBe(false)
    expect(result.runInput.auth.opencode).toBe(true)
  })

  it('--auth aws enables aws alongside the defaults', async () => {
    const cwd = makeTempDir()
    const result = await runP(cliParse({ argv: ['run', REPO, '--prompt', 'x', '--auth', 'aws'], cwd }))
    expect(result.runInput.auth.aws).toBe(true)
    expect(result.runInput.auth.opencode).toBe(true)
    expect(result.runInput.auth.npmrc).toBe(true)
  })

  it('combines --auth aws with --no-auth-opencode', async () => {
    const cwd = makeTempDir()
    const result = await runP(
      cliParse({
        argv: ['run', REPO, '--prompt', 'x', '--auth', 'aws', '--no-auth-opencode'],
        cwd,
      }),
    )
    expect(result.runInput.auth.aws).toBe(true)
    expect(result.runInput.auth.opencode).toBe(false)
    expect(result.runInput.auth.npmrc).toBe(true)
  })

  it('config-file auth overrides defaults', async () => {
    const cwd = makeTempDir()
    await ensureDirP(path.join(cwd, '.testaipack'))
    await writeFileP(
      path.join(cwd, '.testaipack', 'config.json'),
      JSON.stringify({ repoUrl: REPO, prompt: 'x', auth: { opencode: false, aws: true } }),
    )
    const result = await runP(cliParse({ argv: ['run'], cwd }))
    expect(result.runInput.auth.opencode).toBe(false)
    expect(result.runInput.auth.npmrc).toBe(true)
    expect(result.runInput.auth.aws).toBe(true)
  })

  it('--no-auth-bogus → E_CONFIG_INVALID', async () => {
    const cwd = makeTempDir()
    const err = await runFlip(
      cliParse({ argv: ['run', REPO, '--prompt', 'x', '--no-auth-bogus'], cwd }),
    )
    expect(err).toBeInstanceOf(PhaseError)
    expect(err.code).toBe('E_CONFIG_INVALID')
  })
})
